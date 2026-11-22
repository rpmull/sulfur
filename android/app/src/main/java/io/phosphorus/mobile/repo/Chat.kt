package io.phosphorus.mobile.repo

import kotlinx.serialization.decodeFromString
import android.content.Context
import io.phosphorus.mobile.net.ChannelMeta
import io.phosphorus.mobile.net.ChatFile
import io.phosphorus.mobile.net.ChatMsg
import io.phosphorus.mobile.net.ChatPerson
import io.phosphorus.mobile.net.Link
import io.phosphorus.mobile.net.LiveSocket
import io.phosphorus.mobile.net.PhosClient
import io.phosphorus.mobile.net.PhosJson
import io.phosphorus.mobile.net.str
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody

/** A chat line after its marks (reactions, edits, deletes) are folded in. */
data class Line(
    val id: String,
    val conv: String,
    val name: String,
    val color: String?,
    val text: String,
    val at: Long,
    val kind: String,
    val re: String?,
    val files: List<ChatFile>,
    val reactions: Map<String, List<String>>,
    val edited: Boolean,
    val mine: Boolean,
    val pending: Boolean = false,
)

data class Conversation(
    val id: String,
    val title: String,
    val kind: Kind,
    val last: Line?,
    val unread: Int,
    val topic: String? = null,
) {
    enum class Kind { Mesh, Channel, Direct }
}

/**
 * The mesh chat over its socket (`/api/app/chat/ws`). The server sends the whole visible log
 * on join (at most 1000 lines, marks included), then every new line; read markers are ours.
 */
class Chat(private val client: PhosClient, private val scope: CoroutineScope, context: Context) {
    private val readPrefs = context.getSharedPreferences("chat_read_" + client.domain, Context.MODE_PRIVATE)

    private val raw = mutableListOf<ChatMsg>()
    private val retracted = mutableSetOf<String>()
    private val pending = mutableListOf<Line>()

    private val _me = MutableStateFlow("")
    val me: StateFlow<String> = _me.asStateFlow()

    private val _lines = MutableStateFlow<List<Line>>(emptyList())
    val lines: StateFlow<List<Line>> = _lines.asStateFlow()

    private val _channels = MutableStateFlow<Map<String, ChannelMeta>>(emptyMap())
    val channels: StateFlow<Map<String, ChannelMeta>> = _channels.asStateFlow()

    private val _people = MutableStateFlow<List<ChatPerson>>(emptyList())
    val people: StateFlow<List<ChatPerson>> = _people.asStateFlow()

    private val _convs = MutableStateFlow<List<Conversation>>(emptyList())
    val conversations: StateFlow<List<Conversation>> = _convs.asStateFlow()

    private val _system = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val system: SharedFlow<String> = _system.asSharedFlow()

    /** New lines from others, for notifications while the app is in the background. */
    private val _incoming = MutableSharedFlow<Line>(extraBufferCapacity = 32)
    val incoming: SharedFlow<Line> = _incoming.asSharedFlow()

    private val readAt = MutableStateFlow<Map<String, Long>>(emptyMap())
    private var joined = false

    private val socket = LiveSocket(client, scope, { "/api/app/chat/ws" }, onOpen = { s ->
        s.send("""{"type":"join"}""")
    }, heartbeat = 25_000)

    val link: StateFlow<Link> get() = socket.link

    fun start() {
        if (joined) return
        joined = true
        readAt.value = readPrefs.all.mapNotNull { (k, v) -> (v as? Long)?.let { k to it } }.toMap()
        socket.start()
        scope.launch { socket.frames.collect(::onFrame) }
    }

    fun poke() = socket.poke()
    fun stop() { socket.close(); joined = false }

    private fun onFrame(text: String) {
        val obj = runCatching { PhosJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when (obj.str("type")) {
            "history" -> {
                _me.value = obj.str("me") ?: _me.value
                val msgs = obj["messages"]?.let {
                    runCatching { PhosJson.decodeFromJsonElement(ListSerializer(ChatMsg.serializer()), it) }.getOrNull()
                } ?: emptyList()
                _channels.value = obj["channels"]?.let {
                    runCatching { PhosJson.decodeFromJsonElement(MapSerializer(String.serializer(), ChannelMeta.serializer()), it) }.getOrNull()
                } ?: emptyMap()
                synchronized(raw) { raw.clear(); raw += msgs; retracted.clear() }
                rebuild()
            }
            "message" -> {
                val m = runCatching { PhosJson.decodeFromJsonElement(ChatMsg.serializer(), obj) }.getOrNull() ?: return
                synchronized(raw) {
                    raw += m
                    if (raw.size > 2000) raw.subList(0, raw.size - 2000).clear()
                    // The server echoes our own line; drop the optimistic copy it replaces.
                    if (m.name == _me.value) pending.removeAll { it.text == m.text && it.conv == convOf(m) }
                }
                rebuild()
                if (m.name != _me.value && (m.kind.isNullOrEmpty() || m.kind == "dm" || m.kind == "model")) {
                    _lines.value.lastOrNull { it.id == idOf(m) }?.let { _incoming.tryEmit(it) }
                }
            }
            "retract" -> {
                val id = "${obj.str("host")}:${obj.str("seq")}"
                synchronized(raw) { retracted += id }
                rebuild()
            }
            "presence" -> _people.value = obj["people"]?.let {
                runCatching { PhosJson.decodeFromJsonElement(ListSerializer(ChatPerson.serializer()), it) }.getOrNull()
            } ?: _people.value
            "channel" -> {
                val ch = obj.str("ch") ?: return
                val meta = obj["meta"]?.let { runCatching { PhosJson.decodeFromJsonElement(ChannelMeta.serializer(), it) }.getOrNull() }
                if (meta != null) _channels.value = _channels.value + (ch to meta)
                rebuild()
            }
            "close" -> {
                val ch = obj.str("ch") ?: return
                synchronized(raw) { raw.removeAll { it.ch == ch && it.dm == null } }
                _channels.value[ch]?.let { _channels.value = _channels.value + (ch to it.copy(closedAt = System.currentTimeMillis())) }
                rebuild()
            }
            "clear" -> {
                synchronized(raw) { raw.removeAll { it.ch == null && it.dm == null } }
                rebuild()
            }
            "system" -> obj.str("text")?.let { _system.tryEmit(it) }
        }
    }

    private fun seqOf(m: ChatMsg): String = (m.seq as? JsonPrimitive)?.contentOrNull ?: m.seq?.toString().orEmpty()
    private fun idOf(m: ChatMsg) = "${m.host}:${seqOf(m)}"

    /** The conversation a line belongs to, as the web client files it (lines.ts). */
    private fun convOf(m: ChatMsg): String = when {
        m.dm != null -> "dm:" + (if (m.name == _me.value) m.dm else m.name)
        m.ch != null -> "ch:" + m.ch
        else -> "mesh"
    }

    private fun rebuild() {
        val me = _me.value
        val snapshot = synchronized(raw) { raw.toList() }
        val byId = LinkedHashMap<String, ChatMsg>()
        val reacts = HashMap<String, HashMap<Pair<String, String>, Pair<Long, Boolean>>>()
        val edits = HashMap<String, Pair<Long, String>>()
        val deleted = HashSet<String>()
        for (m in snapshot) {
            val id = idOf(m)
            if (id in retracted) continue
            when (m.kind) {
                "react" -> {
                    val ref = m.ref ?: continue
                    val em = m.em ?: emojiOf(m.emoji) ?: continue
                    val map = reacts.getOrPut(ref) { HashMap() }
                    val key = m.name to em
                    val prev = map[key]
                    if (prev == null || prev.first <= m.timestamp) map[key] = m.timestamp to (m.on != false)
                }
                "edit" -> {
                    val ref = m.ref ?: continue
                    val prev = edits[ref]
                    if (byId[ref]?.name == m.name && (prev == null || prev.first <= m.timestamp)) edits[ref] = m.timestamp to m.text
                }
                "delete" -> { val ref = m.ref ?: continue; if (byId[ref]?.name == m.name) deleted += ref }
                else -> byId[id] = m
            }
        }
        val out = ArrayList<Line>(byId.size + pending.size)
        for ((id, m) in byId) {
            if (id in deleted) continue
            val r = reacts[id]?.entries?.filter { it.value.second }?.groupBy({ it.key.second }, { it.key.first }) ?: emptyMap()
            val edit = edits[id]
            out += Line(
                id = id, conv = convOf(m), name = m.name, color = m.color,
                text = edit?.second ?: m.text, at = m.timestamp, kind = m.kind ?: "",
                re = m.re, files = m.files, reactions = r, edited = edit != null, mine = m.name == me,
            )
        }
        out += synchronized(raw) { pending.toList() }
        out.sortBy { it.at }
        _lines.value = out
        rebuildConvs(out)
    }

    private fun rebuildConvs(lines: List<Line>) {
        val me = _me.value
        val read = readAt.value
        val grouped = lines.groupBy { it.conv }
        val ids = LinkedHashSet<String>()
        ids += "mesh"
        _channels.value.filter { (_, m) -> m.created > (m.closedAt ?: 0) }.keys.forEach { ids += "ch:$it" }
        grouped.keys.forEach { ids += it }
        _convs.value = ids.map { id ->
            val ls = grouped[id].orEmpty()
            val visible = ls.filter { it.kind != "topic" }
            val unread = visible.count { !it.mine && it.at > (read[id] ?: 0) }
            when {
                id == "mesh" -> Conversation(id, "mesh", Conversation.Kind.Mesh, visible.lastOrNull(), unread)
                id.startsWith("ch:") -> Conversation(
                    id, id.removePrefix("ch:"), Conversation.Kind.Channel, visible.lastOrNull(), unread,
                    topic = _channels.value[id.removePrefix("ch:")]?.topic,
                )
                else -> Conversation(id, id.removePrefix("dm:"), Conversation.Kind.Direct, visible.lastOrNull(), unread)
            }
        }.filter { it.id != "dm:$me" || it.last != null }
            .sortedWith(compareBy<Conversation> { it.kind != Conversation.Kind.Mesh }.thenByDescending { it.last?.at ?: 0 })
    }

    fun markRead(conv: String) {
        val last = _lines.value.lastOrNull { it.conv == conv }?.at ?: System.currentTimeMillis()
        if ((readAt.value[conv] ?: 0) >= last) return
        readAt.value = readAt.value + (conv to last)
        readPrefs.edit().putLong(conv, last).apply()
        rebuildConvs(_lines.value)
    }

    // ---- sending ----

    fun send(conv: String, text: String, files: List<ChatFile> = emptyList(), re: String? = null) {
        val body = text.take(2000)
        if (body.isBlank() && files.isEmpty()) return
        val frame = buildJsonObject {
            when {
                conv.startsWith("dm:") -> { put("type", "dm"); put("to", conv.removePrefix("dm:")) }
                conv.startsWith("ch:") -> { put("type", "message"); put("ch", conv.removePrefix("ch:")) }
                else -> put("type", "message")
            }
            put("text", body)
            if (files.isNotEmpty()) put("files", JsonArray(files.map { PhosJson.encodeToJsonElement(it) }))
            if (re != null) put("re", re)
        }
        synchronized(raw) {
            pending += Line(
                id = "pending:" + System.nanoTime(), conv = conv, name = _me.value, color = null, text = body,
                at = System.currentTimeMillis(), kind = "", re = re, files = files, reactions = emptyMap(),
                edited = false, mine = true, pending = true,
            )
        }
        socket.send(frame.toString())
        rebuild()
    }

    fun react(ref: String, emoji: String, on: Boolean) =
        socket.send(buildJsonObject { put("type", "react"); put("ref", ref); put("em", emoji); put("on", on) }.toString())

    fun edit(ref: String, text: String) =
        socket.send(buildJsonObject { put("type", "edit"); put("ref", ref); put("text", text.take(2000)) }.toString())

    fun delete(ref: String) = socket.send(buildJsonObject { put("type", "delete"); put("ref", ref) }.toString())

    fun typing(conv: String) = socket.send(buildJsonObject { put("type", "typing"); put("conv", conv) }.toString())

    /** Creates (or reopens) a channel by setting its topic. */
    fun createChannel(name: String, topic: String) =
        socket.send(buildJsonObject { put("type", "topic"); put("ch", name); put("text", topic) }.toString())

    suspend fun upload(name: String, mime: String, bytes: ByteArray): ChatFile {
        val path = "/api/app/chat/upload?name=" + java.net.URLEncoder.encode(name, "UTF-8") +
            "&type=" + java.net.URLEncoder.encode(mime, "UTF-8")
        return PhosJson.decodeFromString(client.post(path, bytes.toRequestBody(mime.toMediaTypeOrNull())))
    }

    fun mediaUrl(f: ChatFile, download: Boolean = false) =
        client.url("/api/app/chat/media/${f.host}/${f.id}" + if (download) "?dl" else "").toString()

    fun typingIn(conv: String): List<String> {
        val me = _me.value
        return _people.value.filter { p ->
            p.name != me && p.typing != null && (p.typing == conv || (conv == "dm:${p.name}" && p.typing == "dm:$me"))
        }.map { it.name }
    }

    companion object {
        private val legacy = mapOf("+1" to "👍", "✓" to "✅", "✗" to "❌", "?" to "❓", "!" to "❗", "♡" to "❤️")
        fun emojiOf(code: String?) = code?.let { legacy[it] ?: it }

        val Quick = listOf("👍", "❤️", "😂", "🎉", "👀", "🙏")

        fun nameColor(hex: String?): Long? = hex?.removePrefix("#")?.takeIf { it.length == 6 }?.toLongOrNull(16)?.let { 0xFF000000 or it }
    }
}

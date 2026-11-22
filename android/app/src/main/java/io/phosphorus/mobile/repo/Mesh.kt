package io.phosphorus.mobile.repo

import kotlinx.serialization.decodeFromString
import io.phosphorus.mobile.net.Link
import io.phosphorus.mobile.net.LiveSocket
import io.phosphorus.mobile.net.Me
import io.phosphorus.mobile.net.MeshState
import io.phosphorus.mobile.net.PhosClient
import io.phosphorus.mobile.net.PhosException
import io.phosphorus.mobile.net.PhosJson
import io.phosphorus.mobile.net.StatsSample
import io.phosphorus.mobile.net.UiAction
import io.phosphorus.mobile.net.UiFrame
import io.phosphorus.mobile.net.str
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** A host the app can work on, merged from the mesh state's tailnet and hosts maps. */
data class Host(
    val name: String,
    val online: Boolean,
    val self: Boolean,
    val os: String?,
    val platform: String?,
    val version: String?,
    val distro: String?,
    val arch: String?,
    val model: String?,
    val ip: String?,
    val phosphorus: Boolean,
)

/** Sign-in, the mesh's live state and its hosts' live stats. */
class Mesh(private val client: PhosClient, private val scope: CoroutineScope) {

    private val _me = MutableStateFlow<Me?>(null)
    val me: StateFlow<Me?> = _me.asStateFlow()

    private val _state = MutableStateFlow<MeshState?>(null)
    val state: StateFlow<MeshState?> = _state.asStateFlow()

    private val _hosts = MutableStateFlow<List<Host>>(emptyList())
    val hosts: StateFlow<List<Host>> = _hosts.asStateFlow()

    private val _stats = MutableStateFlow<Map<String, StatsSample>>(emptyMap())
    val stats: StateFlow<Map<String, StatsSample>> = _stats.asStateFlow()

    /** Per host, the last 120 seconds of CPU and memory percent, newest last. */
    private val _history = MutableStateFlow<Map<String, History>>(emptyMap())
    val history: StateFlow<Map<String, History>> = _history.asStateFlow()

    private val _notices = MutableSharedFlow<UiAction>(extraBufferCapacity = 32)
    val notices: SharedFlow<UiAction> = _notices.asSharedFlow()

    /** Set when the server stops accepting our session: the app goes back to sign-in. */
    private val _signedOut = MutableStateFlow(false)
    val signedOut: StateFlow<Boolean> = _signedOut.asStateFlow()

    private var lastNotice = 0L
    private val seenNotices = ArrayDeque<Long>()

    private val stateSocket = LiveSocket(client, scope, { "/api/state" }, onOpen = { s ->
        if (lastNotice > 0) s.send("""{"type":"ui-since","at":$lastNotice}""")
    })

    private val statsSocket = LiveSocket(client, scope, { "/api/stats" }, ping = null)

    val link: StateFlow<Link> get() = stateSocket.link

    // ---- sign-in ----

    /** The signed-in user, or null when the session is gone. Other failures throw. */
    suspend fun loadMe(): Me? = try {
        PhosJson.decodeFromString<Me>(client.get("/api/me")).also { _me.value = it }
    } catch (e: PhosException) {
        if (e.status == 401) null else throw e
    }

    /** Whether the server is a Phosphorus desktop at all, and whether it still needs its first admin. */
    suspend fun probe(): Probe {
        val (status, body) = client.raw("/api/me")
        val obj = runCatching { PhosJson.parseToJsonElement(body).jsonObject }.getOrNull()
        return when {
            status == 200 && obj?.containsKey("user") == true -> Probe(reachable = true, signedIn = true)
            status == 401 && obj != null -> Probe(reachable = true, signedIn = false, setup = obj.str("setup") == "true")
            else -> throw PhosException(status, "This doesn't look like a Phosphorus desktop (HTTP $status).")
        }
    }

    suspend fun login(user: String, pass: String): Me {
        val body = buildJsonObject { put("user", user.trim().lowercase()); put("pass", pass) }
        val me = PhosJson.decodeFromString<Me>(client.post("/api/login", body.toString()))
        _me.value = me
        _signedOut.value = false
        return me
    }

    suspend fun logout() {
        runCatching { client.post("/api/logout", "{}") }
        stop()
        client.session.clear()
        _me.value = null
    }

    suspend fun changePassword(old: String, new: String) {
        val body = buildJsonObject { put("old", old); put("pass", new) }
        client.post("/api/me/password", body.toString())
    }

    suspend fun setPref(key: String, value: String) {
        val body = buildJsonObject { put("prefs", buildJsonObject { put(key, value) }) }
        client.post("/api/me/prefs", body.toString())
        _me.value = _me.value?.let { it.copy(prefs = it.prefs + (key to value)) }
    }

    suspend fun users(): List<io.phosphorus.mobile.net.MeshUser> =
        PhosJson.decodeFromString<io.phosphorus.mobile.net.MeshUsers>(client.get("/api/users")).users

    fun avatarUrl(name: String) = client.url("/api/avatar/$name").toString()

    // ---- live ----

    fun start() {
        stateSocket.start()
        statsSocket.start()
        scope.launch { stateSocket.frames.collect { onStateFrame(it) } }
        scope.launch { statsSocket.frames.collect { onStatsFrame(it) } }
        scope.launch { stateSocket.unauthorized.collect { if (it) _signedOut.value = true } }
        scope.launch {
            // A first paint before the socket's first frame.
            runCatching { _state.value ?: setState(PhosJson.decodeFromString(client.get("/api/state"))) }
        }
    }

    fun poke() { stateSocket.poke(); statsSocket.poke() }

    fun stop() { stateSocket.close(); statsSocket.close() }

    private fun onStateFrame(text: String) {
        val obj = runCatching { PhosJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when (obj.str("type")) {
            null -> runCatching { setState(PhosJson.decodeFromJsonElement(MeshState.serializer(), obj)) }
            "phosphorus-ui" -> {
                val f = runCatching { PhosJson.decodeFromJsonElement(UiFrame.serializer(), obj) }.getOrNull() ?: return
                if (f.at > lastNotice) lastNotice = f.at
                if (f.at in seenNotices) return
                seenNotices.addLast(f.at); if (seenNotices.size > 128) seenNotices.removeFirst()
                f.action?.takeIf { it.kind == "notify" }?.let { _notices.tryEmit(it) }
            }
            "pong" -> obj.str("at")?.toLongOrNull()?.let { if (it > lastNotice && lastNotice > 0) lastNotice = it }
            "account" -> scope.launch { runCatching { loadMe() } }
        }
    }

    private fun setState(s: MeshState) {
        _state.value = s
        val selfName = s.self.host
        val names = LinkedHashSet<String>()
        if (selfName.isNotEmpty()) names += selfName
        s.tailnet.filter { it.phosphorus || it.phosphorusSeen }.forEach { names += it.name }
        s.hosts.keys.forEach { names += it }
        _hosts.value = names.map { n ->
            val t = s.tailnet.firstOrNull { it.name == n }
            val h = s.hosts[n]
            Host(
                name = n,
                online = n == selfName || t?.phosphorus == true,
                self = n == selfName,
                os = t?.os,
                platform = h?.platform ?: (if (n == selfName) s.self.platform else null),
                version = h?.version ?: t?.version,
                distro = h?.distro,
                arch = h?.arch,
                model = h?.model,
                ip = h?.net?.ip ?: h?.publicIPv4,
                phosphorus = t?.phosphorus == true || n == selfName || h != null,
            )
        }.sortedWith(compareByDescending<Host> { it.self }.thenByDescending { it.online }.thenBy { it.name })
    }

    private fun onStatsFrame(text: String) {
        val s = runCatching { PhosJson.decodeFromString<StatsSample>(text) }.getOrNull() ?: return
        // The trend comes only when it changes: keep the last one.
        val prev = _stats.value[s.host]
        val merged = if (s.trend == null && prev?.trend != null) s.copy(trend = prev.trend) else s
        _stats.value = _stats.value + (s.host to merged)
        val memPct = if (s.mem.total > 0) s.mem.used / s.mem.total * 100 else 0.0
        val h = (_history.value[s.host] ?: History()).push(s.cpu.total, memPct)
        _history.value = _history.value + (s.host to h)
    }
}

data class Probe(val reachable: Boolean, val signedIn: Boolean, val setup: Boolean = false)

data class History(val cpu: List<Double> = emptyList(), val mem: List<Double> = emptyList()) {
    fun push(c: Double, m: Double) = History((cpu + c).takeLast(120), (mem + m).takeLast(120))
}

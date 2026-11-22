package io.phosphorus.mobile.repo

import io.phosphorus.mobile.net.PhosClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.security.SecureRandom

/**
 * One terminal on a host, kept alive across screens. Phosphorus keeps a shell for ten
 * minutes without a driver and replays output after `since`, so a dropped socket
 * reconnects with the same sid and resumes where it left off.
 */
class TermSession(
    private val client: PhosClient,
    private val scope: CoroutineScope,
    val host: String,
    /** "shell" for a login shell on [host], "psh" for the Phos shell. */
    val kind: String,
    private val login: Pair<String, String>?,
    private val run: String?,
) {
    enum class Status { Connecting, Live, Reconnecting, Ended }

    val sid: String = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    val createdAt = System.currentTimeMillis()

    private val _status = MutableStateFlow(Status.Connecting)
    val status: StateFlow<Status> = _status.asStateFlow()

    private val _title = MutableStateFlow(if (kind == "psh") "phos" else host)
    val title: StateFlow<String> = _title.asStateFlow()

    /** What the session has drawn, so a recreated view can be repainted. Capped at 256 KiB. */
    private val replay = java.io.ByteArrayOutputStream()
    private val replayCap = 256 * 1024
    private var got = 0L
    private var cols = 80
    private var rows = 24
    private var ws: WebSocket? = null
    private var opened = false
    private var closedByUs = false
    private var backoff = 1_000L
    @Volatile var sink: ((ByteArray) -> Unit)? = null

    fun setTitle(t: String) { if (t.isNotBlank()) _title.value = t }

    fun start() { connect(resume = false) }

    private fun connect(resume: Boolean) {
        val path = buildString {
            append(if (kind == "psh") "/api/psh" else "/api/term/$host")
            append("?sid=").append(sid).append("&since=").append(got)
            if (resume) append("&resume=1")
            else if (login != null && kind != "psh") append("&auto=1")
        }
        _status.value = if (resume) Status.Reconnecting else Status.Connecting
        ws = client.socket(path, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                backoff = 1_000L
                _status.value = Status.Live
                webSocket.send(resizeFrame())
                if (kind != "psh") webSocket.send("""{"type":"share","on":false}""")
                if (!opened && login != null && kind != "psh") {
                    webSocket.send(buildJsonObject {
                        put("type", "login"); put("user", login.first); put("pass", login.second); put("run", run ?: "")
                    }.toString())
                }
                opened = true
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val b = bytes.toByteArray()
                got += b.size
                synchronized(replay) {
                    replay.write(b)
                    if (replay.size() > replayCap) {
                        val all = replay.toByteArray()
                        replay.reset()
                        replay.write(all, all.size - replayCap / 2, replayCap / 2)
                    }
                    sink?.invoke(b)
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) { /* role frames only */ }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                ended(code)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = ended(code)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = ended(response?.code ?: -1)
        })
    }

    private fun ended(code: Int) {
        if (_status.value == Status.Ended) return
        ws = null
        // 4000: the shell exited; 4001: another device took this session; 4xx on upgrade: refused.
        if (closedByUs || code == 4000 || code == 4001 || code in 400..499 || !opened) {
            if (_status.value != Status.Ended) {
                _status.value = Status.Ended
                val why = when (code) {
                    4001 -> "taken by another window"
                    401, 403 -> "refused, sign in again"
                    404 -> "unknown host"
                    503 -> "too many terminals on this host"
                    else -> "session ended"
                }
                if (!closedByUs) {
                    val note = "\r\n\u001b[2m[$why]\u001b[0m\r\n".toByteArray()
                    synchronized(replay) { replay.write(note); sink?.invoke(note) }
                }
            }
            return
        }
        _status.value = Status.Reconnecting
        scope.launch {
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(10_000)
            if (_status.value == Status.Reconnecting) connect(resume = true)
        }
    }

    /** Reconnect at once, when the app comes back to the front with a dropped socket. */
    fun poke() {
        if (_status.value == Status.Reconnecting && ws == null) { backoff = 1_000L; connect(resume = true) }
    }

    /** Hands everything drawn so far to a new view and streams the rest to [to], with no gap between. */
    fun attach(to: (ByteArray) -> Unit): ByteArray = synchronized(replay) {
        sink = to
        replay.toByteArray()
    }

    fun detach(from: (ByteArray) -> Unit) = synchronized(replay) { if (sink === from) sink = null }

    fun input(text: String) {
        ws?.send(text.toByteArray(Charsets.UTF_8).toByteString())
    }

    fun resize(c: Int, r: Int) {
        if (c < 1 || r < 1 || (c == cols && r == rows)) return
        cols = c; rows = r
        ws?.send(resizeFrame())
    }

    private fun resizeFrame() = """{"type":"resize","cols":$cols,"rows":$rows}"""

    fun close() {
        closedByUs = true
        ws?.send("""{"type":"close"}""")
        ws?.close(1000, null)
        _status.value = Status.Ended
    }
}

/** The open terminals, kept for the life of the app process. */
class Terminals(private val client: PhosClient, private val scope: CoroutineScope) {
    private val _sessions = MutableStateFlow<List<TermSession>>(emptyList())
    val sessions: StateFlow<List<TermSession>> = _sessions.asStateFlow()

    fun open(host: String, kind: String, login: Pair<String, String>?, run: String? = null): TermSession {
        val s = TermSession(client, scope, host, kind, login, run)
        _sessions.value = _sessions.value + s
        s.start()
        return s
    }

    fun close(s: TermSession) {
        s.close()
        _sessions.value = _sessions.value - s
    }

    fun poke() = _sessions.value.forEach { it.poke() }

    fun closeAll() { _sessions.value.forEach { it.close() }; _sessions.value = emptyList() }
}

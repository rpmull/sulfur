package io.phosphorus.mobile.net

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

enum class Link { Connecting, Open, Down }

/**
 * A JSON socket that keeps itself open: it reconnects with backoff (300 ms growing to 5 s,
 * as the desktop's sync does) until [close]. Text frames come out of [frames].
 * A 401/403 on the upgrade stops it and raises [unauthorized].
 */
class LiveSocket(
    private val client: PhosClient,
    private val scope: CoroutineScope,
    private val path: () -> String,
    private val onOpen: (LiveSocket) -> Unit = {},
    private val heartbeat: Long = 15_000,
    private val ping: String? = """{"type":"ping"}""",
) {
    private val _frames = MutableSharedFlow<String>(extraBufferCapacity = 256)
    val frames: SharedFlow<String> = _frames.asSharedFlow()

    private val _link = MutableStateFlow(Link.Connecting)
    val link: StateFlow<Link> = _link.asStateFlow()

    private val _unauthorized = MutableStateFlow(false)
    val unauthorized: StateFlow<Boolean> = _unauthorized.asStateFlow()

    @Volatile private var ws: WebSocket? = null
    @Volatile private var closed = false
    private var loop: Job? = null
    private var wake = MutableStateFlow(0)

    fun start() {
        if (loop != null) return
        loop = scope.launch {
            var backoff = 300L
            while (isActive && !closed) {
                _link.value = Link.Connecting
                val done = kotlinx.coroutines.CompletableDeferred<Int>()
                val sock = client.socket(path(), object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        _link.value = Link.Open
                        backoff = 300L
                        onOpen(this@LiveSocket)
                    }
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        _frames.tryEmit(text)
                    }
                    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                        _frames.tryEmit(bytes.utf8())
                    }
                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(1000, null)
                        done.complete(code)
                    }
                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        done.complete(code)
                    }
                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        val code = response?.code ?: 0
                        if (code == 401 || code == 403) _unauthorized.value = true
                        done.complete(code)
                    }
                })
                ws = sock
                val pinger = if (ping != null) launch {
                    while (isActive) {
                        delay(heartbeat)
                        sock.send(ping)
                    }
                } else null
                val code = done.await()
                pinger?.cancel()
                ws = null
                _link.value = Link.Down
                if (closed || _unauthorized.value || code == 4401) break
                // Sleep for the backoff, or less if someone pokes us (app back in front).
                val before = wake.value
                var waited = 0L
                while (waited < backoff && wake.value == before && !closed) {
                    delay(100); waited += 100
                }
                backoff = (backoff * 3 / 2).coerceAtMost(5_000)
            }
        }
    }

    /** Reconnect now rather than at the end of the backoff. */
    fun poke() { wake.value++ }

    fun send(text: String): Boolean = ws?.send(text) ?: false

    fun close() {
        closed = true
        ws?.close(1000, null)
        loop?.cancel()
        loop = null
        _link.value = Link.Down
    }
}

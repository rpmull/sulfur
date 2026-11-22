package io.phosphorus.mobile.data

import android.content.Context
import coil.ImageLoader
import coil.disk.DiskCache
import coil.memory.MemoryCache
import io.phosphorus.mobile.net.PhosClient
import io.phosphorus.mobile.repo.Chat
import io.phosphorus.mobile.repo.Drive
import io.phosphorus.mobile.repo.Git
import io.phosphorus.mobile.repo.Mesh
import io.phosphorus.mobile.repo.Terminals
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Everything that belongs to one Phosphorus server; dropped and rebuilt when the server changes. */
class ServerSession(context: Context, val base: HttpUrl, session: SessionStore) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val client = PhosClient(base, session)
    val mesh = Mesh(client, scope)
    val drive = Drive(client)
    val git = Git(client)
    val chat = Chat(client, scope, context)
    val terminals = Terminals(client, scope)

    /** Coil over the same OkHttp client, so images carry the session cookie. */
    val images: ImageLoader = ImageLoader.Builder(context)
        .okHttpClient(client.http)
        .memoryCache { MemoryCache.Builder(context).maxSizePercent(0.2).build() }
        .diskCache { DiskCache.Builder().directory(context.cacheDir.resolve("images")).maxSizeBytes(128L * 1024 * 1024).build() }
        .crossfade(true)
        .build()

    @Volatile private var live = false

    fun startLive() {
        if (live) return
        live = true
        mesh.start()
        chat.start()
    }

    /** The app came back to the front: reconnect anything that dropped without waiting out backoffs. */
    fun poke() {
        mesh.poke(); chat.poke(); terminals.poke()
    }

    fun close() {
        live = false
        mesh.stop(); chat.stop(); terminals.closeAll()
        scope.cancel()
    }
}

class AppGraph(private val context: Context) {
    val prefs = Prefs(context)
    val sessionStore = SessionStore(context)
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _server = MutableStateFlow<ServerSession?>(null)
    val server: StateFlow<ServerSession?> = _server.asStateFlow()

    fun open(base: HttpUrl): ServerSession {
        _server.value?.let { if (it.base == base) return it; it.close() }
        return ServerSession(context, base, sessionStore).also { _server.value = it }
    }

    /** A new session for the same server, after a sign-out: the old one's sockets and scope are gone. */
    fun fresh(base: HttpUrl): ServerSession {
        _server.value?.close()
        return ServerSession(context, base, sessionStore).also { _server.value = it }
    }

    suspend fun restore(): ServerSession? {
        val url = prefs.current().server?.toHttpUrlOrNull() ?: return null
        return open(url)
    }

    /** Forget the server entirely (sign out and choose another). */
    suspend fun forget() {
        _server.value?.let { runCatching { it.mesh.logout() }; it.close() }
        _server.value = null
        sessionStore.clear()
        prefs.setServer(null)
    }
}

package io.phosphorus.mobile.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import io.phosphorus.mobile.Launch
import io.phosphorus.mobile.LinkService
import io.phosphorus.mobile.Notifier
import io.phosphorus.mobile.data.AppGraph
import io.phosphorus.mobile.data.AppPrefs
import io.phosphorus.mobile.data.ServerSession
import io.phosphorus.mobile.ui.onboarding.ConnectScreen
import io.phosphorus.mobile.ui.onboarding.LoginScreen
import io.phosphorus.mobile.ui.shell.MainShell
import io.phosphorus.mobile.ui.theme.Phos
import io.phosphorus.mobile.ui.theme.PhosphorusTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.launch

val LocalServer = staticCompositionLocalOf<ServerSession?> { null }
val LocalGraph = staticCompositionLocalOf<AppGraph> { error("no graph") }

/** The server for screens inside the signed-in shell, where there always is one. */
val server: ServerSession
    @Composable get() = LocalServer.current ?: error("no server")

private sealed interface Phase {
    data object Starting : Phase
    data object Connect : Phase
    data class Login(val server: ServerSession, val setup: Boolean) : Phase
    data class Main(val server: ServerSession) : Phase
}

/** Offline with a saved session: open anyway, the sockets reconnect when they can. */
private fun offline(graph: AppGraph, s: ServerSession): Phase =
    if (graph.sessionStore.has("phosphorus-user")) Phase.Main(s) else Phase.Login(s, setup = false)

@Composable
fun AppRoot(graph: AppGraph, launch: MutableStateFlow<Launch?>, onReady: () -> Unit) {
    val prefs by graph.prefs.flow.collectAsState(initial = AppPrefs())
    var phase by remember { mutableStateOf<Phase>(Phase.Starting) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    val askNotify = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}

    LaunchedEffect(Unit) {
        val s = graph.restore()
        phase = when {
            s == null -> Phase.Connect
            else -> try {
                // A slow or unreachable mesh shouldn't hold the splash: treat it as offline.
                val me = withTimeoutOrNull(4_000) { s.mesh.loadMe() ?: false }
                when (me) {
                    false -> Phase.Login(s, setup = false)
                    null -> offline(graph, s)
                    else -> Phase.Main(s)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                offline(graph, s)
            }
        }
        onReady()
    }

    // Signed in: go live, watch for the session ending, and keep notices flowing.
    val main = phase as? Phase.Main
    LaunchedEffect(main?.server) {
        val s = main?.server ?: return@LaunchedEffect
        s.startLive()
        Notifier.watch(s, graph.prefs)
        if (Build.VERSION.SDK_INT >= 33) askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        s.mesh.signedOut.collect { out ->
            if (out) {
                graph.sessionStore.clear()
                phase = Phase.Login(graph.fresh(s.base), setup = false)
            }
        }
    }
    LaunchedEffect(main?.server, prefs.stayConnected) {
        val s = main?.server
        if (s != null && prefs.stayConnected) LinkService.start(context, s.base.host) else LinkService.stop(context)
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { (phase as? Phase.Main)?.server?.poke() }

    PhosphorusTheme(prefs.theme) {
        CompositionLocalProvider(LocalGraph provides graph, LocalServer provides (main?.server ?: (phase as? Phase.Login)?.server)) {
            Box(Modifier.fillMaxSize().background(Phos.colors.desk)) {
                AnimatedContent(
                    targetState = phase,
                    contentKey = { it::class },
                    transitionSpec = { fadeIn() togetherWith fadeOut() },
                    label = "phase",
                ) { p ->
                    when (p) {
                        Phase.Starting -> Box(Modifier.fillMaxSize())
                        Phase.Connect -> ConnectScreen(
                            initial = prefs.server,
                            onConnected = { s, signedIn, setup ->
                                scope.launch {
                                    graph.prefs.setServer(s.base.toString())
                                    phase = if (signedIn) Phase.Main(s) else Phase.Login(s, setup)
                                }
                            },
                        )
                        is Phase.Login -> LoginScreen(
                            server = p.server,
                            setup = p.setup,
                            onSignedIn = { phase = Phase.Main(p.server) },
                            onChangeServer = {
                                scope.launch { graph.forget(); phase = Phase.Connect }
                            },
                        )
                        is Phase.Main -> CompositionLocalProvider(LocalServer provides p.server) {
                            MainShell(
                                launch = launch,
                                onSignOut = {
                                    scope.launch {
                                        LinkService.stop(context)
                                        p.server.mesh.logout()
                                        phase = Phase.Login(graph.fresh(p.server.base), setup = false)
                                    }
                                },
                                onChangeServer = {
                                    scope.launch { LinkService.stop(context); graph.forget(); phase = Phase.Connect }
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

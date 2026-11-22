package io.phosphorus.mobile

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.content.IntentCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import io.phosphorus.mobile.ui.AppRoot
import kotlinx.coroutines.flow.MutableStateFlow

/** Where a notification or a share asked the app to go. */
data class Launch(val view: String? = null, val conv: String? = null, val shared: Uri? = null, val at: Long = System.nanoTime())

class MainActivity : ComponentActivity() {
    private val launch = MutableStateFlow<Launch?>(null)
    private var ready = false

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        splash.setKeepOnScreenCondition { !ready }
        enableEdgeToEdge()
        handle(intent)
        val graph = (application as PhosApp).graph
        setContent {
            AppRoot(graph = graph, launch = launch, onReady = { ready = true })
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        intent ?: return
        val shared = if (intent.action == Intent.ACTION_SEND) {
            IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
        } else null
        val view = intent.getStringExtra(EXTRA_VIEW)
        if (shared != null || view != null) {
            launch.value = Launch(view = if (shared != null) "files" else view, conv = intent.getStringExtra(EXTRA_CONV), shared = shared)
        }
    }

    companion object {
        const val EXTRA_VIEW = "view"
        const val EXTRA_CONV = "conv"
    }
}


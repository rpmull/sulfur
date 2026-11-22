package io.phosphorus.mobile.ui.terminal

import kotlinx.serialization.decodeFromString
import android.annotation.SuppressLint
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import io.phosphorus.mobile.repo.TermSession
import io.phosphorus.mobile.ui.theme.PhosColors
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream

/** xterm's colours from the Phosphorus palette. */
fun xtermTheme(c: PhosColors): String = buildJsonObject {
    put("background", hex(if (c.isDark) c.desk else c.bg))
    put("foreground", hex(c.fg))
    put("cursor", hex(c.accent))
    put("cursorAccent", hex(if (c.isDark) c.desk else c.bg))
    put("selectionBackground", hex(c.accent) + "55")
    put("black", if (c.isDark) "#2a2d31" else "#1f2225")
    put("red", hex(c.red)); put("green", hex(c.green)); put("yellow", hex(c.amber))
    put("blue", hex(c.blue)); put("magenta", hex(c.purple)); put("cyan", hex(c.teal))
    put("white", if (c.isDark) "#d4d8dd" else "#9aa0a6")
    put("brightBlack", hex(c.dim))
    put("brightRed", hex(c.red)); put("brightGreen", hex(c.green)); put("brightYellow", hex(c.orange))
    put("brightBlue", hex(c.blue)); put("brightMagenta", hex(c.purple)); put("brightCyan", hex(c.teal))
    put("brightWhite", if (c.isDark) "#ffffff" else "#52565a")
}.toString()

private fun hex(c: androidx.compose.ui.graphics.Color): String {
    val argb = (c.value shr 32).toInt()
    return "#%06x".format(argb and 0xFFFFFF)
}

/** Lets the key bar drive the page: modifiers and focus. */
class TerminalHandle {
    internal var web: WebView? = null
    fun mods(ctrl: Boolean, alt: Boolean) = web?.evaluateJavascript("phosMods($ctrl,$alt)", null)
    fun focus() = web?.evaluateJavascript("phosFocus()", null)
    fun font(size: Float) = web?.evaluateJavascript("phosFont(${size.toInt()})", null)
    fun paste(text: String) = web?.evaluateJavascript("phosPaste(${quote(text)})", null)
    fun selection(cb: (String) -> Unit) = web?.evaluateJavascript("phosSelection()") { v ->
        cb(runCatching { kotlinx.serialization.json.Json.decodeFromString<String>(v) }.getOrDefault(""))
    }
    private fun quote(s: String) = kotlinx.serialization.json.JsonPrimitive(s).toString()
}

/**
 * The page's side of the terminal: the WebView draws with xterm, this bridge carries its
 * keystrokes and size to the [TermSession] and output back, batched per frame.
 */
class TerminalBridge(
    private val session: TermSession,
    private val fontSize: () -> Float,
    private val theme: () -> String,
    private val onFont: (Float) -> Unit,
    private val onModsUsed: () -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    @Volatile var web: WebView? = null
    private val pending = ByteArrayOutputStream()
    private var scheduled = false

    private val flush = Runnable {
        val bytes = synchronized(pending) { scheduled = false; pending.toByteArray().also { pending.reset() } }
        if (bytes.isNotEmpty()) write(bytes)
    }

    private fun write(bytes: ByteArray) {
        // Chunks keep each evaluateJavascript call small.
        var i = 0
        while (i < bytes.size) {
            val end = minOf(bytes.size, i + 64 * 1024)
            val b64 = Base64.encodeToString(bytes, i, end - i, Base64.NO_WRAP)
            web?.evaluateJavascript("phosWrite('$b64')", null)
            i = end
        }
    }

    fun output(bytes: ByteArray) {
        synchronized(pending) {
            pending.write(bytes)
            if (!scheduled) { scheduled = true; main.postDelayed(flush, 12) }
        }
    }

    @JavascriptInterface fun options(): String =
        """{"fontSize":${fontSize().toInt()},"theme":${theme()}}"""

    private val sink: (ByteArray) -> Unit = ::output

    @JavascriptInterface fun ready(cols: Int, rows: Int) {
        main.post {
            session.resize(cols, rows)
            // Through the batch, so the replay lands before anything newer.
            val replay = session.attach(sink)
            if (replay.isNotEmpty()) output(replay)
        }
    }

    fun detach() = session.detach(sink)

    @JavascriptInterface fun input(data: String) = session.input(data)
    @JavascriptInterface fun resize(cols: Int, rows: Int) = session.resize(cols, rows)
    @JavascriptInterface fun title(t: String) = session.setTitle(t)
    @JavascriptInterface fun bell() {}
    @JavascriptInterface fun fontSize(size: Int) { main.post { onFont(size.toFloat()) } }
    @JavascriptInterface fun modsUsed() { main.post { onModsUsed() } }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TerminalView(
    session: TermSession,
    colors: PhosColors,
    fontSize: Float,
    handle: TerminalHandle,
    onFont: (Float) -> Unit,
    onModsUsed: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val theme = remember(colors) { xtermTheme(colors) }
    val bridge = remember(session) {
        TerminalBridge(session, { fontSize }, { theme }, onFont, onModsUsed)
    }
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            WebView(ctx).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                setBackgroundColor((colors.desk.value shr 32).toInt())
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.cacheMode = WebSettings.LOAD_NO_CACHE
                settings.textZoom = 100
                isVerticalScrollBarEnabled = false
                overScrollMode = WebView.OVER_SCROLL_NEVER
                webChromeClient = WebChromeClient()
                // Only the bundled page; nothing it shows can navigate the view elsewhere.
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest) = true
                }
                addJavascriptInterface(bridge, "Phos")
                bridge.web = this
                handle.web = this
                loadUrl("file:///android_asset/terminal/index.html")
            }
        },
        update = { web ->
            web.evaluateJavascript("window.phosTheme && phosTheme(${kotlinx.serialization.json.JsonPrimitive(theme)})", null)
        },
    )
    DisposableEffect(session) {
        onDispose {
            bridge.detach()
            bridge.web?.let { w -> w.removeJavascriptInterface("Phos"); w.destroy() }
            bridge.web = null
            handle.web = null
        }
    }
}

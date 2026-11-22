package io.phosphorus.mobile.ui.files

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import coil.compose.SubcomposeAsyncImage
import io.phosphorus.mobile.net.At
import io.phosphorus.mobile.repo.Downloads
import io.phosphorus.mobile.ui.common.CodeView
import io.phosphorus.mobile.ui.common.Empty
import io.phosphorus.mobile.ui.common.ErrorState
import io.phosphorus.mobile.ui.common.Format
import io.phosphorus.mobile.ui.common.Loading
import io.phosphorus.mobile.ui.common.Markdown
import io.phosphorus.mobile.ui.common.Screen
import io.phosphorus.mobile.ui.common.rememberLoad
import io.phosphorus.mobile.ui.server
import io.phosphorus.mobile.ui.theme.Phos
import kotlinx.coroutines.launch

@Composable
fun FilePreviewScreen(nav: NavController, host: String, share: String, path: String) {
    val s = server
    val at = At(host, share, path)
    val name = path.substringAfterLast('/')
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    var rendered by remember { mutableStateOf(true) }
    val markdown = name.endsWith(".md", true) || name.endsWith(".markdown", true)

    fun open(share: Boolean) {
        scope.launch {
            try {
                snack.showSnackbar("Fetching $name…", withDismissAction = false, duration = androidx.compose.material3.SnackbarDuration.Short)
            } catch (_: Exception) {}
        }
        scope.launch {
            runCatching { Downloads.toCache(context, s.client, s.drive.fileUrl(at, inline = false), name) }
                .onSuccess { uri -> if (share) Downloads.share(context, uri, name) else Downloads.openWith(context, uri, name) }
                .onFailure { snack.showSnackbar(it.message ?: "Couldn't fetch the file") }
        }
    }

    Screen(
        title = name,
        subtitle = "$host · ${path.substringBeforeLast('/', "").ifEmpty { "/" }}",
        nav = nav,
        snackbar = snack,
        actions = {
            if (markdown) IconButton(onClick = { rendered = !rendered }) {
                Icon(if (rendered) Icons.Outlined.Code else Icons.Outlined.Visibility, if (rendered) "Show source" else "Show rendered")
            }
            IconButton(onClick = { open(share = true) }) { Icon(Icons.Outlined.Share, "Share") }
            IconButton(onClick = {
                val ok = Downloads.toDownloads(context, s.client, s.drive.fileUrl(at, inline = false), name)
                scope.launch { snack.showSnackbar(if (ok) "Downloading $name" else "Couldn't start the download") }
            }) { Icon(Icons.Outlined.Download, "Download") }
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            if (isImage(name)) {
                ZoomableImage(s.drive.fileUrl(at))
                return@Box
            }
            val read = rememberLoad(at) { s.drive.read(at) }
            val r = read.value
            when {
                r == null && read.error != null -> ErrorState(read.error!!, read::reload)
                r == null -> Loading()
                r.text != null && markdown && rendered -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
                    Markdown(r.text)
                    Spacer(Modifier.height(40.dp))
                }
                r.text != null -> CodeView(r.text, Modifier.fillMaxSize())
                else -> {
                    val (icon, _) = fileIcon(name, false)
                    Empty(
                        icon,
                        name,
                        listOfNotNull(Format.bytes(r.size), if (r.tooBig) "too large to preview" else "no preview here").joinToString(" · "),
                    ) {
                        FilledTonalButton(onClick = { open(share = false) }) {
                            Icon(Icons.Outlined.OpenInNew, null)
                            Text("  Open in another app")
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ZoomableImage(url: String) {
    val s = server
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    Box(
        Modifier.fillMaxSize().background(Phos.colors.desk)
            .pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 6f)
                    offset = if (scale == 1f) Offset.Zero else offset + pan
                }
            }
            .pointerInput(Unit) {
                detectTapGestures(onDoubleTap = { if (scale > 1f) { scale = 1f; offset = Offset.Zero } else scale = 2.5f })
            },
        contentAlignment = Alignment.Center,
    ) {
        SubcomposeAsyncImage(
            model = url,
            imageLoader = s.images,
            contentDescription = null,
            contentScale = ContentScale.Fit,
            loading = { Loading() },
            error = { Text("Couldn't load the image", color = Phos.colors.muted) },
            modifier = Modifier.fillMaxSize().graphicsLayer {
                scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y
            },
        )
    }
}


package io.phosphorus.mobile.ui.common

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.SubcomposeAsyncImage
import io.phosphorus.mobile.net.PhosException
import io.phosphorus.mobile.ui.LocalServer
import io.phosphorus.mobile.ui.theme.Phos
import kotlin.math.absoluteValue

/** A person's picture from the mesh, falling back to their initial on a colour of their own. */
@Composable
fun Avatar(name: String, url: String?, size: Dp = 36.dp, color: Color? = null) {
    val server = LocalServer.current
    val fallback = @Composable {
        val hue = color ?: personColor(name)
        Box(
            Modifier.size(size).clip(CircleShape).background(hue.copy(alpha = 0.22f)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                name.take(1).uppercase(),
                color = hue,
                fontWeight = FontWeight.SemiBold,
                fontSize = (size.value * 0.42f).sp,
            )
        }
    }
    if (url == null || server == null) { fallback(); return }
    SubcomposeAsyncImage(
        model = url,
        imageLoader = server.images,
        contentDescription = name,
        contentScale = ContentScale.Crop,
        modifier = Modifier.size(size).clip(CircleShape),
        loading = { fallback() },
        error = { fallback() },
    )
}

private val personHues = listOf(
    Color(0xFFAB93ED), Color(0xFF64A9F3), Color(0xFF03BDB6), Color(0xFF62BB78),
    Color(0xFFCF9A35), Color(0xFFEB827B), Color(0xFFE58B55),
)

fun personColor(name: String): Color = personHues[name.hashCode().absoluteValue % personHues.size]

fun hexColor(hex: String?): Color? =
    hex?.removePrefix("#")?.takeIf { it.length == 6 }?.toLongOrNull(16)?.let { Color(0xFF000000 or it) }

@Composable
fun StatusDot(online: Boolean, size: Dp = 9.dp) {
    val c = if (online) Phos.colors.online else Phos.colors.dim
    Box(
        Modifier.size(size).clip(CircleShape).background(c)
            .then(if (online) Modifier.border(2.dp, c.copy(alpha = 0.25f), CircleShape) else Modifier),
    )
}

@Composable
fun Pill(text: String, color: Color = Phos.colors.accent, modifier: Modifier = Modifier) {
    Box(
        modifier.clip(RoundedCornerShape(50)).background(color.copy(alpha = 0.16f)).padding(horizontal = 8.dp, vertical = 2.dp),
    ) {
        Text(text, color = color, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

@Composable
fun Card(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    padding: PaddingValues = PaddingValues(16.dp),
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.large,
        color = Phos.colors.card,
        border = androidx.compose.foundation.BorderStroke(1.dp, Phos.colors.border),
        onClick = onClick ?: {},
        enabled = onClick != null,
    ) {
        Box(Modifier.padding(padding)) { content() }
    }
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, trailing: @Composable (() -> Unit)? = null) {
    Row(
        modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 20.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text.uppercase(),
            style = MaterialTheme.typography.labelMedium,
            color = Phos.colors.dim,
            letterSpacing = 1.sp,
            modifier = Modifier.weight(1f),
        )
        trailing?.invoke()
    }
}

@Composable
fun Loading(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(strokeWidth = 3.dp, color = Phos.colors.accent)
    }
}

@Composable
fun Empty(icon: ImageVector, title: String, body: String? = null, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Column(
        modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(72.dp).clip(CircleShape).background(Phos.colors.accent.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center,
        ) { Icon(icon, null, tint = Phos.colors.accent, modifier = Modifier.size(34.dp)) }
        Spacer(Modifier.height(16.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        if (body != null) {
            Spacer(Modifier.height(6.dp))
            Text(body, style = MaterialTheme.typography.bodyMedium, color = Phos.colors.muted, textAlign = TextAlign.Center)
        }
        if (action != null) { Spacer(Modifier.height(20.dp)); action() }
    }
}

@Composable
fun ErrorState(error: Throwable, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    val offline = (error as? PhosException)?.status == 0
    Empty(
        icon = if (offline) Icons.Outlined.CloudOff else Icons.Outlined.ErrorOutline,
        title = if (offline) "Can't reach your mesh" else "Something went wrong",
        body = error.message,
        modifier = modifier,
    ) { OutlinedButton(onClick = onRetry) { Text("Try again") } }
}

/** A thin line of recent values, filled beneath. Values are 0..[max]. */
@Composable
fun Sparkline(
    values: List<Double>,
    color: Color,
    modifier: Modifier = Modifier,
    max: Double = 100.0,
    fill: Boolean = true,
    capacity: Int = values.size,
) {
    Canvas(modifier) {
        if (values.size < 2) return@Canvas
        val n = maxOf(capacity, values.size)
        val stepX = size.width / (n - 1).coerceAtLeast(1)
        val offset = (n - values.size) * stepX
        val top = maxOf(max, values.maxOrNull() ?: 0.0).coerceAtLeast(1e-9)
        fun y(v: Double) = size.height - (v / top).toFloat().coerceIn(0f, 1f) * (size.height - 2f) - 1f
        val line = Path().apply {
            values.forEachIndexed { i, v -> if (i == 0) moveTo(offset, y(v)) else lineTo(offset + i * stepX, y(v)) }
        }
        if (fill) {
            val area = Path().apply {
                addPath(line)
                lineTo(offset + (values.size - 1) * stepX, size.height)
                lineTo(offset, size.height)
                close()
            }
            drawPath(area, Brush.verticalGradient(listOf(color.copy(alpha = 0.28f), color.copy(alpha = 0f))))
        }
        drawPath(line, color, style = Stroke(width = 1.6.dp.toPx(), cap = StrokeCap.Round))
    }
}

/** A ring gauge with its value in the middle. */
@Composable
fun Ring(
    fraction: Float,
    color: Color,
    label: String,
    caption: String,
    modifier: Modifier = Modifier,
    size: Dp = 92.dp,
) {
    val f by animateFloatAsState(fraction.coerceIn(0f, 1f), tween(600), label = "ring")
    val track = Phos.colors.border
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(size), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                val w = 8.dp.toPx()
                val inset = w / 2
                val arc = Size(this.size.width - w, this.size.height - w)
                drawArc(track, 135f, 270f, false, Offset(inset, inset), arc, style = Stroke(w, cap = StrokeCap.Round))
                if (f > 0.001f) drawArc(
                    Brush.sweepGradient(listOf(color.copy(alpha = 0.6f), color, color.copy(alpha = 0.6f))),
                    135f, 270f * f, false, Offset(inset, inset), arc, style = Stroke(w, cap = StrokeCap.Round),
                )
            }
            Text(label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        }
        Text(caption, style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted)
    }
}

@Composable
fun Meter(fraction: Float, color: Color, modifier: Modifier = Modifier) {
    val f by animateFloatAsState(fraction.coerceIn(0f, 1f), tween(500), label = "meter")
    LinearProgressIndicator(
        progress = { f },
        modifier = modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)),
        color = color,
        trackColor = Phos.colors.border,
        strokeCap = StrokeCap.Round,
        drawStopIndicator = {},
    )
}

/** Picks a colour by how loaded something is. */
@Composable
fun loadColor(pct: Double): Color = when {
    pct >= 90 -> Phos.colors.red
    pct >= 70 -> Phos.colors.amber
    else -> Phos.colors.green
}

@Composable
fun KeyValue(key: String, value: String, modifier: Modifier = Modifier, mono: Boolean = false) {
    Row(modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(key, color = Phos.colors.muted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(120.dp))
        Text(
            value,
            style = if (mono) io.phosphorus.mobile.ui.theme.MonoSmall else MaterialTheme.typography.bodyMedium,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
            textAlign = TextAlign.End,
        )
    }
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, busy: Boolean = false) {
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        modifier = modifier.fillMaxWidth().height(52.dp),
        shape = MaterialTheme.shapes.medium,
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
        else Text(text, fontWeight = FontWeight.SemiBold)
    }
}

fun Modifier.clickableRow(onClick: () -> Unit) = this.clickable(onClick = onClick)

package io.phosphorus.mobile.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

/** Phosphorus's palette, from web/theme/theme.json: six hues on cool neutrals, purple the accent. */
@Immutable
data class PhosColors(
    val desk: Color,
    val bg: Color,
    val card: Color,
    val border: Color,
    val edge: Color,
    val fg: Color,
    val muted: Color,
    val dim: Color,
    val purple: Color,
    val blue: Color,
    val teal: Color,
    val green: Color,
    val amber: Color,
    val red: Color,
    val orange: Color,
    val isDark: Boolean,
) {
    val accent get() = purple
    val online get() = green
    val offline get() = red
    val warning get() = amber
    /** The mark's own gradient, orange to violet. */
    val brand get() = Brush.linearGradient(listOf(Color(0xFFF0883E), Color(0xFFA371F7)))
}

val DarkPhos = PhosColors(
    desk = Color(0xFF121416), bg = Color(0xFF1C1E21), card = Color(0xFF242729),
    border = Color(0xFF303336), edge = Color(0xFF6E7276), fg = Color(0xFFE4E8ED),
    muted = Color(0xFFAEB1B6), dim = Color(0xFF95999D), purple = Color(0xFFAB93ED),
    blue = Color(0xFF64A9F3), teal = Color(0xFF03BDB6), green = Color(0xFF62BB78),
    amber = Color(0xFFCF9A35), red = Color(0xFFEB827B), orange = Color(0xFFE58B55), isDark = true,
)

val BlackPhos = DarkPhos.copy(
    desk = Color.Black, bg = Color.Black, card = Color(0xFF101213),
    border = Color(0xFF232528), edge = Color(0xFF606368),
)

val LightPhos = PhosColors(
    desk = Color(0xFFE6E8EA), bg = Color(0xFFFFFFFF), card = Color(0xFFF9FAFB),
    border = Color(0xFFE2E5E9), edge = Color(0xFF898C91), fg = Color(0xFF1F2225),
    muted = Color(0xFF52565A), dim = Color(0xFF64676B), purple = Color(0xFF6A4FA9),
    blue = Color(0xFF1364B0), teal = Color(0xFF02736E), green = Color(0xFF057836),
    amber = Color(0xFF815B04), red = Color(0xFFA43B38), orange = Color(0xFF9C4700), isDark = false,
)

enum class ThemeMode { System, Light, Dark, Black }

val LocalPhos = staticCompositionLocalOf { DarkPhos }

private fun PhosColors.scheme(): ColorScheme = if (isDark) darkColorScheme(
    primary = purple, onPrimary = Color(0xFF1B1430),
    primaryContainer = purple.copy(alpha = 0.22f).compositeOver(card), onPrimaryContainer = fg,
    secondary = blue, onSecondary = Color(0xFF0B1A2A),
    secondaryContainer = blue.copy(alpha = 0.18f).compositeOver(card), onSecondaryContainer = fg,
    tertiary = teal, onTertiary = Color.Black,
    background = desk, onBackground = fg,
    surface = bg, onSurface = fg,
    surfaceVariant = card, onSurfaceVariant = muted,
    surfaceContainerLowest = desk, surfaceContainerLow = bg, surfaceContainer = bg,
    surfaceContainerHigh = card, surfaceContainerHighest = border,
    outline = edge, outlineVariant = border,
    error = red, onError = Color.Black,
    errorContainer = red.copy(alpha = 0.2f).compositeOver(card), onErrorContainer = fg,
    inverseSurface = fg, inverseOnSurface = bg, inversePrimary = Color(0xFF6A4FA9),
    scrim = Color.Black,
) else lightColorScheme(
    primary = purple, onPrimary = Color.White,
    primaryContainer = purple.copy(alpha = 0.12f).compositeOver(bg), onPrimaryContainer = fg,
    secondary = blue, onSecondary = Color.White,
    secondaryContainer = blue.copy(alpha = 0.12f).compositeOver(bg), onSecondaryContainer = fg,
    tertiary = teal, onTertiary = Color.White,
    background = desk, onBackground = fg,
    surface = bg, onSurface = fg,
    surfaceVariant = card, onSurfaceVariant = muted,
    surfaceContainerLowest = bg, surfaceContainerLow = card, surfaceContainer = card,
    surfaceContainerHigh = desk, surfaceContainerHighest = border,
    outline = edge, outlineVariant = border,
    error = red, onError = Color.White,
    errorContainer = red.copy(alpha = 0.12f).compositeOver(bg), onErrorContainer = fg,
    inverseSurface = fg, inverseOnSurface = bg, inversePrimary = Color(0xFFAB93ED),
    scrim = Color.Black,
)

private fun Color.compositeOver(under: Color): Color {
    val a = alpha
    return Color(
        red = red * a + under.red * (1 - a),
        green = green * a + under.green * (1 - a),
        blue = blue * a + under.blue * (1 - a),
        alpha = 1f,
    )
}

val Mono = FontFamily.Monospace

private val PhosType = Typography().let { t ->
    t.copy(
        headlineLarge = t.headlineLarge.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.5).sp),
        headlineMedium = t.headlineMedium.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.25).sp),
        headlineSmall = t.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
        titleLarge = t.titleLarge.copy(fontWeight = FontWeight.SemiBold),
        titleMedium = t.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        labelSmall = t.labelSmall.copy(letterSpacing = 0.4.sp),
    )
}

val MonoSmall = TextStyle(fontFamily = Mono, fontSize = 12.sp, lineHeight = 17.sp)

private val PhosShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(24.dp),
)

@Composable
fun PhosphorusTheme(mode: ThemeMode = ThemeMode.System, content: @Composable () -> Unit) {
    val systemDark = isSystemInDarkTheme()
    val colors = when (mode) {
        ThemeMode.System -> if (systemDark) DarkPhos else LightPhos
        ThemeMode.Light -> LightPhos
        ThemeMode.Dark -> DarkPhos
        ThemeMode.Black -> BlackPhos
    }
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !colors.isDark
                isAppearanceLightNavigationBars = !colors.isDark
            }
        }
    }
    CompositionLocalProvider(LocalPhos provides colors) {
        MaterialTheme(
            colorScheme = colors.scheme(),
            typography = PhosType,
            shapes = PhosShapes,
            content = content,
        )
    }
}

object Phos {
    val colors: PhosColors
        @Composable get() = LocalPhos.current
}

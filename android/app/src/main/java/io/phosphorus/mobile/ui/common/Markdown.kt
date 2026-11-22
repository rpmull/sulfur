package io.phosphorus.mobile.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.phosphorus.mobile.ui.theme.Mono
import io.phosphorus.mobile.ui.theme.MonoSmall
import io.phosphorus.mobile.ui.theme.Phos
import io.phosphorus.mobile.ui.theme.PhosColors

/**
 * A small Markdown renderer for chat lines, READMEs, issues and comments: headings, lists,
 * quotes, fenced code, rules, and inline bold, italics, code, strikethrough and links.
 * Phosphorus sends source text, never HTML; raw HTML is shown as text.
 */
@Composable
fun Markdown(text: String, modifier: Modifier = Modifier, style: TextStyle = MaterialTheme.typography.bodyMedium, color: Color = Color.Unspecified) {
    val colors = Phos.colors
    val blocks = remember(text) { parseBlocks(text) }
    Column(modifier) {
        blocks.forEachIndexed { i, b ->
            if (i > 0) Spacer(Modifier.height(if (b is Block.Heading) 12.dp else 6.dp))
            when (b) {
                is Block.Heading -> Text(
                    inline(b.text, colors),
                    style = when (b.level) {
                        1 -> MaterialTheme.typography.headlineSmall
                        2 -> MaterialTheme.typography.titleLarge
                        else -> MaterialTheme.typography.titleMedium
                    },
                    color = color,
                )
                is Block.Para -> Text(inline(b.text, colors), style = style, color = color)
                is Block.Quote -> Row(Modifier.padding(vertical = 2.dp)) {
                    Box(Modifier.width(3.dp).height(20.dp).background(colors.edge, RoundedCornerShape(2.dp)))
                    Spacer(Modifier.width(10.dp))
                    Text(inline(b.text, colors), style = style, color = colors.muted)
                }
                is Block.Item -> Row(Modifier.padding(start = (b.depth * 16).dp)) {
                    Text(
                        b.marker, style = style,
                        color = if (b.checked != null) colors.accent else colors.muted,
                        modifier = Modifier.width(if (b.marker.length > 2) 28.dp else 18.dp),
                    )
                    Text(inline(b.text, colors), style = style, color = color, modifier = Modifier.weight(1f))
                }
                is Block.Code -> SelectionContainer {
                    Box(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(colors.desk)
                            .horizontalScroll(rememberScrollState()).padding(12.dp),
                    ) { Text(b.text, style = MonoSmall, color = colors.fg) }
                }
                Block.Rule -> HorizontalDivider(Modifier.padding(vertical = 6.dp), color = colors.border)
            }
        }
    }
}

private sealed interface Block {
    data class Heading(val level: Int, val text: String) : Block
    data class Para(val text: String) : Block
    data class Quote(val text: String) : Block
    data class Item(val marker: String, val text: String, val depth: Int, val checked: Boolean?) : Block
    data class Code(val lang: String, val text: String) : Block
    data object Rule : Block
}

private val listRe = Regex("""^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]]\s+)?(.*)$""")

private fun parseBlocks(src: String): List<Block> {
    val out = mutableListOf<Block>()
    val lines = src.replace("\r\n", "\n").split('\n')
    val para = StringBuilder()
    fun flush() {
        if (para.isNotBlank()) out += Block.Para(para.toString().trim())
        para.clear()
    }
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        val t = line.trimStart()
        when {
            t.startsWith("```") || t.startsWith("~~~") -> {
                flush()
                val fence = t.take(3)
                val lang = t.drop(3).trim()
                val code = StringBuilder()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith(fence)) {
                    if (code.isNotEmpty()) code.append('\n')
                    code.append(lines[i]); i++
                }
                out += Block.Code(lang, code.toString())
            }
            t.startsWith("#") && t.trimStart('#').startsWith(" ") -> {
                flush()
                out += Block.Heading(t.takeWhile { it == '#' }.length.coerceAtMost(6), t.trimStart('#').trim().trimEnd('#').trim())
            }
            t.matches(Regex("^([-*_])(\\s*\\1){2,}\\s*$")) -> { flush(); out += Block.Rule }
            t.startsWith(">") -> {
                flush()
                val q = StringBuilder(t.removePrefix(">").trim())
                while (i + 1 < lines.size && lines[i + 1].trimStart().startsWith(">")) {
                    i++; q.append(' ').append(lines[i].trimStart().removePrefix(">").trim())
                }
                out += Block.Quote(q.toString())
            }
            listRe.matches(line) -> {
                flush()
                val m = listRe.find(line)!!
                val indent = m.groupValues[1].replace("\t", "    ").length / 2
                val box = m.groupValues[3]
                val checked = if (box.isEmpty()) null else box.contains('x', ignoreCase = true)
                val raw = m.groupValues[2]
                val marker = when {
                    checked == true -> "☑"
                    checked == false -> "☐"
                    raw[0].isDigit() -> raw
                    else -> "•"
                }
                out += Block.Item(marker, m.groupValues[4], indent.coerceAtMost(4), checked)
            }
            t.isEmpty() -> flush()
            else -> {
                if (para.isNotEmpty()) para.append(if (line.endsWith("  ")) "\n" else " ")
                para.append(t)
            }
        }
        i++
    }
    flush()
    return out
}

private val linkRe = Regex("""\[([^\]]+)]\(([^)\s]+)(?:\s+"[^"]*")?\)""")
private val autoRe = Regex("""https?://[^\s<>()]+[^\s<>().,;:!?'"]""")

/** Inline Markdown to styled text. Links are only http, https and mailto, as on the desktop. */
fun inline(src: String, colors: PhosColors): AnnotatedString = buildAnnotatedString {
    var i = 0
    val linkStyle = TextLinkStyles(SpanStyle(color = colors.blue, textDecoration = TextDecoration.Underline))
    fun safe(url: String) = url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:")
    while (i < src.length) {
        val c = src[i]
        val rest = src.substring(i)
        when {
            c == '\\' && i + 1 < src.length -> { append(src[i + 1]); i += 2 }
            c == '`' -> {
                val end = src.indexOf('`', i + 1)
                if (end > i) {
                    withStyle(SpanStyle(fontFamily = Mono, background = colors.border.copy(alpha = 0.6f), color = colors.fg)) {
                        append(" ").append(src.substring(i + 1, end)).append(" ")
                    }
                    i = end + 1
                } else { append(c); i++ }
            }
            c == '[' && linkRe.find(src, i)?.range?.first == i -> {
                val m = linkRe.find(src, i)!!
                val url = m.groupValues[2]
                if (safe(url)) withLink(LinkAnnotation.Url(url, linkStyle)) { append(m.groupValues[1]) }
                else append(m.groupValues[1])
                i = m.range.last + 1
            }
            c == 'h' && (i == 0 || !src[i - 1].isLetterOrDigit()) && autoRe.find(src, i)?.range?.first == i -> {
                val m = autoRe.find(src, i)!!
                withLink(LinkAnnotation.Url(m.value, linkStyle)) { append(m.value) }
                i = m.range.last + 1
            }
            rest.startsWith("**") || rest.startsWith("__") -> {
                val mark = rest.take(2)
                val end = src.indexOf(mark, i + 2)
                if (end > i + 2) {
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(inline(src.substring(i + 2, end), colors)) }
                    i = end + 2
                } else { append(mark); i += 2 }
            }
            rest.startsWith("~~") -> {
                val end = src.indexOf("~~", i + 2)
                if (end > i + 2) {
                    withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(inline(src.substring(i + 2, end), colors)) }
                    i = end + 2
                } else { append("~~"); i += 2 }
            }
            (c == '*' || c == '_') && i + 1 < src.length && !src[i + 1].isWhitespace() &&
                (i == 0 || !src[i - 1].isLetterOrDigit()) -> {
                val end = src.indexOf(c, i + 1)
                if (end > i + 1 && !src[end - 1].isWhitespace()) {
                    withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(inline(src.substring(i + 1, end), colors)) }
                    i = end + 1
                } else { append(c); i++ }
            }
            c == '@' && (i == 0 || src[i - 1].isWhitespace()) -> {
                val name = Regex("^@[a-z0-9][a-z0-9_-]*").find(rest)?.value
                if (name != null) {
                    withStyle(SpanStyle(color = colors.accent, fontWeight = FontWeight.SemiBold)) { append(name) }
                    i += name.length
                } else { append(c); i++ }
            }
            else -> { append(c); i++ }
        }
    }
}

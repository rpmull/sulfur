package io.phosphorus.mobile.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import io.phosphorus.mobile.ui.theme.MonoSmall
import io.phosphorus.mobile.ui.theme.Phos

/** Source text with line numbers, scrolling sideways as one block so columns line up. */
@Composable
fun CodeView(text: String, modifier: Modifier = Modifier) {
    val lines = remember(text) { text.replace("\r\n", "\n").split('\n').map { it.replace("\t", "    ").ifEmpty { " " } } }
    val gutter = remember(lines.size) { lines.size.toString().length }
    val h = rememberScrollState()
    // Every row as wide as the longest, so the shared sideways scroll has one extent.
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val width = remember(lines, measurer) {
        val longest = lines.maxByOrNull { it.length } ?: " "
        with(density) { measurer.measure(longest, MonoSmall, softWrap = false).size.width.toDp() } + 16.dp
    }
    LazyColumn(modifier.fillMaxWidth().background(Phos.colors.bg)) {
        itemsIndexed(lines) { i, line ->
            Row {
                Text(
                    (i + 1).toString().padStart(gutter),
                    style = MonoSmall, color = Phos.colors.dim, textAlign = TextAlign.End,
                    modifier = Modifier.padding(start = 8.dp, end = 10.dp),
                )
                Box(Modifier.horizontalScroll(h)) {
                    Text(line, style = MonoSmall, softWrap = false, modifier = Modifier.width(width).padding(end = 16.dp))
                }
            }
        }
    }
}

data class DiffFile(val name: String, val lines: List<String>, val add: Int, val del: Int)

fun parseDiff(diff: String): List<DiffFile> {
    val files = mutableListOf<DiffFile>()
    var name: String? = null
    var cur = mutableListOf<String>()
    var add = 0; var del = 0
    fun flush() {
        name?.let { files += DiffFile(it, cur, add, del) }
        cur = mutableListOf(); add = 0; del = 0
    }
    for (l in diff.replace("\r\n", "\n").split('\n')) {
        when {
            l.startsWith("diff --git ") -> { flush(); name = l.substringAfter(" b/", l.removePrefix("diff --git ")) }
            l.startsWith("index ") || l.startsWith("--- ") || l.startsWith("+++ ") ||
                l.startsWith("new file mode") || l.startsWith("deleted file mode") || l.startsWith("similarity index") -> {}
            name == null -> { name = "changes"; cur += l }
            else -> {
                if (l.startsWith("+")) add++ else if (l.startsWith("-")) del++
                cur += l
            }
        }
    }
    flush()
    return files.filter { it.lines.any { l -> l.isNotEmpty() } || it.add + it.del > 0 }
}

/** Unified diff lines for a [LazyColumn], one file after another, coloured by kind. */
fun LazyListScope.diffItems(files: List<DiffFile>, header: @Composable (DiffFile) -> Unit) {
    files.forEach { f ->
        item(key = "h:" + f.name) { header(f) }
        item(key = "b:" + f.name) { DiffBlock(f) }
    }
}

@Composable
fun DiffBlock(f: DiffFile) {
    val c = Phos.colors
    val h = rememberScrollState()
    SelectionContainer {
        BoxWithConstraints(Modifier.fillMaxWidth().background(c.bg)) {
            val min = maxWidth
            Column(Modifier.horizontalScroll(h).width(IntrinsicSize.Max).widthIn(min = min)) {
                f.lines.forEach { l ->
                    val (bg, fg) = when {
                        l.startsWith("@@") -> c.blue.copy(alpha = 0.10f) to c.blue
                        l.startsWith("+") -> c.green.copy(alpha = 0.13f) to c.fg
                        l.startsWith("-") -> c.red.copy(alpha = 0.13f) to c.fg
                        else -> Color.Transparent to c.muted
                    }
                    Text(
                        l.replace("\t", "    ").ifEmpty { " " },
                        style = MonoSmall,
                        color = fg,
                        softWrap = false,
                        fontWeight = if (l.startsWith("@@")) FontWeight.Medium else null,
                        modifier = Modifier.fillMaxWidth().background(bg).padding(horizontal = 10.dp, vertical = 1.dp),
                    )
                }
            }
        }
    }
}

@Composable
fun DiffStat(add: Int, del: Int) {
    Row {
        Text("+$add", color = Phos.colors.green, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        Text("  −$del", color = Phos.colors.red, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
    }
}

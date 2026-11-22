package io.phosphorus.mobile.ui.git

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.CallMerge
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Replay
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Checkbox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import coil.compose.AsyncImage
import io.phosphorus.mobile.net.JobRow
import io.phosphorus.mobile.net.Note
import io.phosphorus.mobile.net.PhosJson
import io.phosphorus.mobile.net.Step
import io.phosphorus.mobile.ui.common.Avatar
import io.phosphorus.mobile.ui.common.Card
import io.phosphorus.mobile.ui.common.CodeView
import io.phosphorus.mobile.ui.common.DiffBlock
import io.phosphorus.mobile.ui.common.DiffStat
import io.phosphorus.mobile.ui.common.Empty
import io.phosphorus.mobile.ui.common.ErrorState
import io.phosphorus.mobile.ui.common.Format
import io.phosphorus.mobile.ui.common.Loading
import io.phosphorus.mobile.ui.common.Markdown
import io.phosphorus.mobile.ui.common.Pill
import io.phosphorus.mobile.ui.common.Screen
import io.phosphorus.mobile.ui.common.SectionLabel
import io.phosphorus.mobile.ui.common.hexColor
import io.phosphorus.mobile.ui.common.parseDiff
import io.phosphorus.mobile.ui.common.rememberLoad
import io.phosphorus.mobile.ui.server
import io.phosphorus.mobile.ui.theme.MonoSmall
import io.phosphorus.mobile.ui.theme.Phos
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray

@Composable
fun BlobScreen(nav: NavController, full: String, ref: String, path: String) {
    val s = server
    val blob = rememberLoad(full, ref, path) { s.git.blob(full, ref, path) }
    var rendered by remember { mutableStateOf(true) }
    val b = blob.value
    Screen(
        title = path.substringAfterLast('/'),
        subtitle = "$full · $ref",
        nav = nav,
        actions = {
            if (b?.markdown == true) IconButton(onClick = { rendered = !rendered }) {
                Icon(if (rendered) Icons.Outlined.Code else Icons.Outlined.Visibility, "Toggle rendering")
            }
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when {
                b == null && blob.error != null -> ErrorState(blob.error!!, blob::reload)
                b == null -> Loading()
                b.media == "image" || b.media == "svg" -> AsyncImage(
                    model = s.git.rawUrl(full, ref, path), imageLoader = s.images, contentDescription = null,
                    contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize().padding(16.dp),
                )
                b.text != null && b.markdown && rendered -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
                    Markdown(b.text); Spacer(Modifier.height(40.dp))
                }
                b.text != null -> CodeView(b.text, Modifier.fillMaxSize())
                else -> Empty(Icons.Outlined.Code, "No preview", "${Format.bytes(b.size)} · ${b.type}")
            }
        }
    }
}

@Composable
fun CommitScreen(nav: NavController, full: String, sha: String) {
    val s = server
    val detail = rememberLoad(full, sha) { s.git.commit(full, sha) }
    val d = detail.value
    Screen(title = d?.commit?.subject ?: sha.take(7), subtitle = "$full · ${sha.take(7)}", nav = nav) { pad ->
        when {
            d == null && detail.error != null -> ErrorState(detail.error!!, detail::reload, Modifier.padding(pad))
            d == null -> Loading(Modifier.padding(pad))
            else -> {
                val files = remember(d.diff) { parseDiff(d.diff) }
                val expanded = remember { mutableStateOf(setOf<String>()) }
                LazyColumn(contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = pad.calculateTopPadding() + 8.dp, bottom = pad.calculateBottomPadding() + 32.dp)) {
                    item {
                        Card {
                            Column {
                                Text(d.commit.subject, style = MaterialTheme.typography.titleMedium)
                                d.commit.body?.takeIf { it.isNotBlank() }?.let {
                                    Spacer(Modifier.height(8.dp)); Text(it.trim(), style = MaterialTheme.typography.bodyMedium, color = Phos.colors.muted)
                                }
                                Spacer(Modifier.height(12.dp))
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Avatar(d.commit.author, d.commit.person?.let { s.git.avatarUrl(it) }, 28.dp)
                                    Spacer(Modifier.width(10.dp))
                                    Column(Modifier.weight(1f)) {
                                        Text(d.commit.author, style = MaterialTheme.typography.labelLarge)
                                        Text(Format.dateTime(d.commit.at), style = MaterialTheme.typography.labelMedium, color = Phos.colors.dim)
                                    }
                                    DiffStat(files.sumOf { it.add }, files.sumOf { it.del })
                                }
                                Spacer(Modifier.height(8.dp))
                                SelectionContainer { Text(d.commit.sha, style = MonoSmall, color = Phos.colors.dim) }
                            }
                        }
                    }
                    item { SectionLabel("${files.size} file${if (files.size == 1) "" else "s"} changed") }
                    files.forEach { f ->
                        val open = f.name in expanded.value || files.size <= 3
                        item(key = "h:" + f.name) {
                            Row(
                                Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 10.dp, topEnd = 10.dp, bottomStart = if (open) 0.dp else 10.dp, bottomEnd = if (open) 0.dp else 10.dp))
                                    .background(Phos.colors.card)
                                    .clickable { expanded.value = if (f.name in expanded.value) expanded.value - f.name else expanded.value + f.name }
                                    .padding(horizontal = 12.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, tint = Phos.colors.muted, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.width(8.dp))
                                Text(f.name, style = MonoSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                DiffStat(f.add, f.del)
                            }
                        }
                        if (open) item(key = "b:" + f.name) { DiffBlock(f) }
                        item(key = "s:" + f.name) { Spacer(Modifier.height(10.dp)) }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ThreadScreen(nav: NavController, full: String, kind: String, n: Int) {
    val s = server
    val thread = rememberLoad(full, kind, n) { s.git.thread(full, kind, n) }
    val t = thread.value
    var draft by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var showDiff by remember { mutableStateOf(false) }
    var merging by remember { mutableStateOf(false) }
    val snack = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    fun send(state: String? = null) {
        sending = true
        scope.launch {
            runCatching { s.git.comment(full, n, draft.trim(), state) }
                .onSuccess { draft = ""; thread.reload() }
                .onFailure { snack.showSnackbar(it.message ?: "Couldn't post") }
            sending = false
        }
    }

    Screen(
        title = t?.title ?: "#$n",
        subtitle = "$full · #$n",
        nav = nav,
        snackbar = snack,
        bottomBar = {
            if (t != null && t.can.comment) Row(
                Modifier.fillMaxWidth().background(Phos.colors.bg).navigationBarsPadding().imePadding().padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    placeholder = { Text("Leave a comment") },
                    maxLines = 6,
                    shape = RoundedCornerShape(20.dp),
                    colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = Phos.colors.card, focusedContainerColor = Phos.colors.card, unfocusedBorderColor = Phos.colors.border),
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                IconButton(onClick = { send() }, enabled = draft.isNotBlank() && !sending) {
                    Icon(Icons.AutoMirrored.Outlined.Send, "Comment", tint = if (draft.isNotBlank()) Phos.colors.accent else Phos.colors.dim)
                }
            }
        },
    ) { pad ->
        when {
            t == null && thread.error != null -> ErrorState(thread.error!!, thread::reload, Modifier.padding(pad))
            t == null -> Loading(Modifier.padding(pad))
            else -> {
                val diff = rememberLoad(full, n, showDiff) { if (showDiff && t.pull) parseDiff(s.git.pullDiff(full, n)) else emptyList() }
                LazyColumn(
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = pad.calculateTopPadding() + 8.dp, bottom = pad.calculateBottomPadding() + 24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item {
                        Column {
                            Text(t.title, style = MaterialTheme.typography.headlineSmall)
                            Spacer(Modifier.height(10.dp))
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Pill(if (t.merged) "merged" else t.state, stateColor(t.state, t.merged))
                                Text("${t.author} opened ${Format.agoLong(t.created)}", style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted)
                                t.labels.forEach { Pill(it.name, hexColor(it.color) ?: Phos.colors.blue) }
                            }
                        }
                    }
                    t.pr?.let { pr ->
                        item {
                            Card {
                                Column {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Icon(Icons.Outlined.CallMerge, null, tint = Phos.colors.purple, modifier = Modifier.size(18.dp))
                                        Spacer(Modifier.width(8.dp))
                                        Text(pr.head, style = MonoSmall, color = Phos.colors.accent)
                                        Text("  →  ", style = MonoSmall, color = Phos.colors.dim)
                                        Text(pr.base, style = MonoSmall, color = Phos.colors.accent)
                                    }
                                    Spacer(Modifier.height(8.dp))
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text("${pr.commits} commits · ${pr.files} files  ", style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted)
                                        DiffStat(pr.add, pr.del)
                                    }
                                    if (pr.checks.isNotEmpty()) {
                                        Spacer(Modifier.height(10.dp))
                                        pr.checks.forEach { c ->
                                            Row(Modifier.padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                                                RunStatus(c.status, 16.dp); Spacer(Modifier.width(8.dp))
                                                Text(c.name, style = MaterialTheme.typography.bodySmall)
                                            }
                                        }
                                    }
                                    Spacer(Modifier.height(12.dp))
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        FilledTonalButton(onClick = { showDiff = !showDiff }) { Text(if (showDiff) "Hide changes" else "Files changed") }
                                        if (pr.can_merge && t.state == "open" && !t.merged) FilledTonalButton(onClick = { merging = true }) {
                                            Icon(Icons.Outlined.CallMerge, null, Modifier.size(16.dp)); Text("  Merge")
                                        }
                                    }
                                }
                            }
                        }
                        if (showDiff) {
                            val files = diff.value
                            if (files == null) item { Loading(Modifier.height(120.dp)) }
                            else files.forEach { f ->
                                item(key = "d:" + f.name) {
                                    Column(Modifier.clip(RoundedCornerShape(10.dp))) {
                                        Row(Modifier.fillMaxWidth().background(Phos.colors.card).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                                            Text(f.name, style = MonoSmall, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                            DiffStat(f.add, f.del)
                                        }
                                        DiffBlock(f)
                                    }
                                }
                            }
                        }
                    }
                    item { NoteCard(t.author, t.person, t.created, t.body.ifBlank { "_No description._" }) }
                    itemsIndexed(t.notes, key = { i, note -> if (note.id != 0L) "n${note.id}" else "e$i" }) { _, note -> NoteItem(note) }
                    if (t.can.comment) item {
                        Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                            TextButton(onClick = { send(if (t.state == "open") "closed" else "open") }, enabled = !sending) {
                                Text(
                                    when {
                                        t.state == "open" && draft.isNotBlank() -> "Comment and close"
                                        t.state == "open" -> "Close"
                                        draft.isNotBlank() -> "Comment and reopen"
                                        else -> "Reopen"
                                    },
                                    color = if (t.state == "open") Phos.colors.red else Phos.colors.green,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (merging) {
        var deleteBranch by remember { mutableStateOf(true) }
        AlertDialog(
            onDismissRequest = { merging = false },
            containerColor = Phos.colors.bg,
            title = { Text("Merge pull request #$n?") },
            text = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = deleteBranch, onCheckedChange = { deleteBranch = it })
                    Text("Delete the branch afterwards")
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    merging = false
                    scope.launch {
                        runCatching { s.git.merge(full, n, deleteBranch) }
                            .onSuccess { thread.reload(); snack.showSnackbar("Merged") }
                            .onFailure { snack.showSnackbar(it.message ?: "Couldn't merge") }
                    }
                }) { Text("Merge") }
            },
            dismissButton = { TextButton(onClick = { merging = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun NoteCard(author: String, person: String?, at: Long, body: String) {
    val s = server
    Card {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(author, person?.let { s.git.avatarUrl(it) }, 28.dp)
                Spacer(Modifier.width(10.dp))
                Text(author, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.width(6.dp))
                Text(Format.agoLong(at), style = MaterialTheme.typography.labelMedium, color = Phos.colors.dim)
            }
            Spacer(Modifier.height(10.dp))
            SelectionContainer { Markdown(body) }
        }
    }
}

@Composable
private fun NoteItem(n: Note) {
    if (n.kind == "comment" || n.kind.startsWith("review")) {
        NoteCard(n.author, n.person, n.at, (if (n.kind == "review-approve") "✅ **Approved**\n\n" else if (n.kind == "review-reject") "❌ **Changes requested**\n\n" else "") + (n.body ?: ""))
        return
    }
    val text = when (n.kind) {
        "close" -> "closed this"
        "reopen" -> "reopened this"
        "merge" -> "merged this"
        "push" -> "pushed commits"
        "rename" -> "changed the title"
        "archive" -> "archived this"
        else -> n.kind
    }
    Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(RoundedCornerShape(4.dp)).background(Phos.colors.edge))
        Spacer(Modifier.width(10.dp))
        Text("${n.author} $text · ${Format.agoLong(n.at)}", style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted)
    }
}

@Composable
fun RunScreen(nav: NavController, full: String, id: Long) {
    val s = server
    var job by remember { mutableStateOf<Long?>(null) }
    val run = rememberLoad(full, id, job) { s.git.run(full, id, job) }
    val r = run.value
    val live = r?.run?.status == "running" || r?.run?.status == "queued"
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    LaunchedEffect(live, run.loading) { if (live && !run.loading) { delay(3_000); run.reload() } }
    LaunchedEffect(r?.jobs) { if (job == null) r?.jobs?.let { js -> (js.firstOrNull { it.status == "failure" } ?: js.firstOrNull())?.let { job = it.id } } }

    Screen(
        title = r?.run?.title ?: r?.run?.name ?: "Run",
        subtitle = "$full · #${r?.run?.number ?: ""}",
        nav = nav,
        snackbar = snack,
        actions = {
            if (r?.can_write == true) {
                if (live) IconButton(onClick = { scope.launch { runCatching { s.git.cancel(full, id) }.onFailure { snack.showSnackbar(it.message ?: "") }; run.reload() } }) {
                    Icon(Icons.Outlined.StopCircle, "Cancel")
                } else IconButton(onClick = { scope.launch { runCatching { s.git.rerun(full, id) }.onFailure { snack.showSnackbar(it.message ?: "") }; run.reload() } }) {
                    Icon(Icons.Outlined.Replay, "Run again")
                }
            }
        },
    ) { pad ->
        when {
            r == null && run.error != null -> ErrorState(run.error!!, run::reload, Modifier.padding(pad))
            r == null -> Loading(Modifier.padding(pad))
            else -> LazyColumn(
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = pad.calculateTopPadding() + 8.dp, bottom = pad.calculateBottomPadding() + 32.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item {
                    Card {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RunStatus(r.run.status, 28.dp)
                            Spacer(Modifier.width(12.dp))
                            Column {
                                Text(r.run.status.replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.titleMedium)
                                Text(
                                    listOfNotNull(r.run.event, r.run.ref?.removePrefix("refs/heads/"), r.run.sha?.take(7), Format.duration(r.run.started, r.run.finished).ifEmpty { null }).joinToString(" · "),
                                    style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted,
                                )
                            }
                        }
                    }
                }
                item { SectionLabel("Jobs") }
                item {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        r.jobs.forEach { j -> JobChip(j, selected = j.id == job) { job = j.id } }
                    }
                }
                val steps = r.job?.steps?.let { el -> runCatching { PhosJson.decodeFromJsonElement(ListSerializer(Step.serializer()), el as JsonArray) }.getOrNull() }.orEmpty()
                if (steps.isEmpty() && r.job != null) item { Text("No steps yet", color = Phos.colors.dim, style = MaterialTheme.typography.bodySmall) }
                items(steps, key = { it.idx }) { st -> StepCard(st) }
            }
        }
    }
}

@Composable
private fun JobChip(j: JobRow, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.clip(RoundedCornerShape(50)).background(if (selected) Phos.colors.accent.copy(alpha = 0.18f) else Phos.colors.card)
            .clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RunStatus(j.status, 16.dp)
        Spacer(Modifier.width(6.dp))
        Text(j.name, style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
private fun StepCard(st: Step) {
    var open by remember(st.idx) { mutableStateOf(st.status == "failure" || st.status == "running") }
    Card(padding = PaddingValues(0.dp)) {
        Column {
            Row(Modifier.fillMaxWidth().clickable { open = !open }.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                RunStatus(st.status, 18.dp)
                Spacer(Modifier.width(10.dp))
                Text(st.name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, tint = Phos.colors.muted)
            }
            AnimatedVisibility(open && !st.log.isNullOrEmpty()) {
                SelectionContainer {
                    Box(Modifier.fillMaxWidth().background(Phos.colors.desk).horizontalScroll(rememberScrollState()).padding(12.dp)) {
                        Text(st.log.orEmpty().takeLast(60_000), style = MonoSmall, softWrap = false)
                    }
                }
            }
        }
    }
}


package io.phosphorus.mobile.ui.git

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.FolderSpecial
import androidx.compose.material.icons.outlined.HourglassTop
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import io.phosphorus.mobile.net.Commit
import io.phosphorus.mobile.net.RepoDetail
import io.phosphorus.mobile.net.RunRow
import io.phosphorus.mobile.net.ThreadRow
import io.phosphorus.mobile.ui.common.Avatar
import io.phosphorus.mobile.ui.common.Card
import io.phosphorus.mobile.ui.common.Empty
import io.phosphorus.mobile.ui.common.ErrorState
import io.phosphorus.mobile.ui.common.Format
import io.phosphorus.mobile.ui.common.Loading
import io.phosphorus.mobile.ui.common.Markdown
import io.phosphorus.mobile.ui.common.Pill
import io.phosphorus.mobile.ui.common.Screen
import io.phosphorus.mobile.ui.common.rememberLoad
import io.phosphorus.mobile.ui.server
import io.phosphorus.mobile.ui.shell.Routes
import io.phosphorus.mobile.ui.theme.MonoSmall
import io.phosphorus.mobile.ui.theme.Phos
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RepoScreen(nav: NavController, full: String) {
    val s = server
    val detail = rememberLoad(full) { s.git.repo(full) }
    val d = detail.value
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var ref by rememberSaveable { mutableStateOf<String?>(null) }
    var newIssue by remember { mutableStateOf(false) }

    Screen(
        title = full.substringAfter('/'),
        subtitle = full.substringBefore('/'),
        nav = nav,
        fab = {
            if (d != null && tab == 2 && d.has_issues) FloatingActionButton(
                onClick = { newIssue = true }, containerColor = Phos.colors.accent, contentColor = MaterialTheme.colorScheme.onPrimary,
            ) { Icon(Icons.Outlined.Add, "New issue") }
        },
    ) { pad ->
        when {
            d == null && detail.error != null -> ErrorState(detail.error!!, detail::reload, Modifier.padding(pad))
            d == null -> Loading(Modifier.padding(pad))
            else -> {
                val branch = ref ?: d.default_branch
                val tabs = buildList {
                    add("Code"); add("Commits")
                    if (d.has_issues) add("Issues")
                    if (d.has_pulls) add("Pull requests")
                    if (d.has_actions) add("Actions")
                }
                Column(Modifier.fillMaxSize().padding(top = pad.calculateTopPadding())) {
                    PrimaryScrollableTabRow(
                        selectedTabIndex = tab.coerceAtMost(tabs.lastIndex),
                        containerColor = Phos.colors.desk,
                        edgePadding = 8.dp,
                        divider = { HorizontalDivider(color = Phos.colors.border) },
                    ) {
                        tabs.forEachIndexed { i, t ->
                            val count = when (t) { "Issues" -> d.open_issues; "Pull requests" -> d.open_pulls; else -> 0 }
                            Tab(selected = tab == i, onClick = { tab = i }, text = {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(t)
                                    if (count > 0) { Spacer(Modifier.width(6.dp)); Pill(count.toString(), Phos.colors.muted) }
                                }
                            })
                        }
                    }
                    val bottom = pad.calculateBottomPadding() + 88.dp
                    when (tabs.getOrNull(tab)) {
                        "Code" -> CodeTab(nav, full, d, branch, bottom, onRef = { ref = it })
                        "Commits" -> CommitsTab(nav, full, branch, bottom)
                        "Issues" -> ThreadsTab(nav, full, "issues", bottom)
                        "Pull requests" -> ThreadsTab(nav, full, "pulls", bottom)
                        "Actions" -> ActionsTab(nav, full, bottom)
                    }
                }
            }
        }
    }
    if (newIssue) NewIssueDialog(full, onDismiss = { newIssue = false }) { n ->
        newIssue = false
        nav.navigate(Routes.thread(full, "issues", n))
    }
}

@Composable
private fun CodeTab(nav: NavController, full: String, d: RepoDetail, ref: String, bottom: androidx.compose.ui.unit.Dp, onRef: (String) -> Unit) {
    val s = server
    val path = remember(full) { mutableStateListOf<String>() }
    val dir = path.joinToString("/")
    BackHandler(enabled = path.isNotEmpty()) { path.removeAt(path.lastIndex) }
    val tree = rememberLoad(full, ref, dir) { s.git.tree(full, ref, dir) }
    val t = tree.value
    var branchMenu by remember { mutableStateOf(false) }
    val branches = rememberLoad(full, "branches") { s.git.branches(full) }
    val clip = LocalClipboardManager.current

    LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = bottom), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (dir.isEmpty()) item {
            Card {
                Column {
                    d.description?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium); Spacer(Modifier.height(10.dp)) }
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Stat(Icons.Outlined.Star, d.stars.toString(), "stars")
                        Stat(Icons.Outlined.AccountTree, d.branches.toString(), "branches")
                        Stat(Icons.Outlined.Schedule, d.tags.toString(), "tags")
                    }
                    if (d.languages.isNotEmpty()) { Spacer(Modifier.height(12.dp)); LanguageBar(d) }
                    d.clone_url?.let { url ->
                        Spacer(Modifier.height(12.dp))
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Phos.colors.desk)
                                .clickable { clip.setText(AnnotatedString(url)) }.padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(url, style = MonoSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Icon(Icons.Outlined.ContentCopy, "Copy clone URL", tint = Phos.colors.muted, modifier = Modifier.size(16.dp))
                        }
                    }
                }
            }
        }
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box {
                    FilterChip(
                        selected = true,
                        onClick = { branchMenu = true },
                        label = { Text(ref, maxLines = 1) },
                        leadingIcon = { Icon(Icons.Outlined.AccountTree, null, Modifier.size(16.dp)) },
                        trailingIcon = { Icon(Icons.Outlined.ExpandMore, null, Modifier.size(16.dp)) },
                        colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Phos.colors.card),
                    )
                    DropdownMenu(expanded = branchMenu, onDismissRequest = { branchMenu = false }) {
                        branches.value.orEmpty().forEach { b ->
                            DropdownMenuItem(
                                text = { Text(b.name + if (b.default) "  (default)" else "") },
                                onClick = { branchMenu = false; path.clear(); onRef(b.name) },
                            )
                        }
                    }
                }
                Spacer(Modifier.width(8.dp))
                if (dir.isNotEmpty()) Text("/ $dir", style = MonoSmall, color = Phos.colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        when {
            t == null && tree.error != null -> item { ErrorState(tree.error!!, tree::reload, Modifier.height(260.dp)) }
            t == null -> item { Loading(Modifier.height(160.dp)) }
            t.empty -> item { Empty(Icons.Outlined.FolderSpecial, "This repository is empty", "Push to it, and its files appear here.", Modifier.height(260.dp)) }
            else -> {
                t.last?.let { c -> item { LastCommit(c) { nav.navigate(Routes.commit(full, c.sha)) } } }
                item {
                    Card(padding = PaddingValues(vertical = 4.dp)) {
                        Column {
                            if (dir.isNotEmpty()) TreeRow(Icons.Outlined.Folder, "..", Phos.colors.muted) { path.removeAt(path.lastIndex) }
                            t.entries.sortedWith(compareBy<io.phosphorus.mobile.net.TreeEntry> { it.type != "tree" }.thenBy { it.name.lowercase() }).forEach { e ->
                                when (e.type) {
                                    "tree" -> TreeRow(Icons.Outlined.Folder, e.name, Phos.colors.blue) { path.add(e.name) }
                                    "commit" -> TreeRow(Icons.Outlined.FolderSpecial, e.name + " (submodule)", Phos.colors.dim) {}
                                    else -> TreeRow(Icons.AutoMirrored.Outlined.InsertDriveFile, e.name, Phos.colors.muted) {
                                        nav.navigate(Routes.blob(full, ref, e.path))
                                    }
                                }
                            }
                        }
                    }
                }
                t.readme?.let { r ->
                    item {
                        Card {
                            Column {
                                Text(r.path.substringAfterLast('/'), style = MaterialTheme.typography.labelLarge, color = Phos.colors.muted)
                                HorizontalDivider(Modifier.padding(vertical = 10.dp), color = Phos.colors.border)
                                if (r.markdown) Markdown(r.text) else Text(r.text, style = MonoSmall)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Stat(icon: ImageVector, value: String, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = Phos.colors.muted, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(4.dp))
        Text(value, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        Text(" $label", style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted)
    }
}

private val langColors = listOf(
    Color(0xFFAB93ED), Color(0xFF64A9F3), Color(0xFF03BDB6), Color(0xFF62BB78), Color(0xFFCF9A35), Color(0xFFEB827B), Color(0xFFE58B55),
)

@Composable
private fun LanguageBar(d: RepoDetail) {
    val langs = d.languages.mapNotNull { pair ->
        val name = runCatching { (pair[0] as kotlinx.serialization.json.JsonPrimitive).content }.getOrNull() ?: return@mapNotNull null
        val bytes = runCatching { (pair[1] as kotlinx.serialization.json.JsonPrimitive).content.toDouble() }.getOrNull() ?: 0.0
        name to bytes
    }
    val total = langs.sumOf { it.second }.coerceAtLeast(1.0)
    Column {
        Row(Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp))) {
            langs.forEachIndexed { i, (_, b) ->
                Box(Modifier.weight((b / total).toFloat().coerceAtLeast(0.005f)).fillMaxSize().background(langColors[i % langColors.size]))
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(
            langs.take(4).joinToString("  ·  ") { (n, b) -> "$n ${"%.0f".format(b / total * 100)}%" },
            style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted,
        )
    }
}

@Composable
private fun LastCommit(c: Commit, onClick: () -> Unit) {
    val s = server
    Card(onClick = onClick, padding = PaddingValues(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(c.author, c.person?.let { s.git.avatarUrl(it) }, 28.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(c.subject, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${c.author} · ${Format.agoLong(c.at)}", style = MaterialTheme.typography.labelMedium, color = Phos.colors.dim)
            }
            Text(c.sha.take(7), style = MonoSmall, color = Phos.colors.accent)
        }
    }
}

@Composable
private fun TreeRow(icon: ImageVector, name: String, tint: Color, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(14.dp))
        Text(name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun CommitsTab(nav: NavController, full: String, ref: String, bottom: androidx.compose.ui.unit.Dp) {
    val s = server
    val commits = remember(full, ref) { mutableStateListOf<Commit>() }
    var page by remember(full, ref) { mutableIntStateOf(1) }
    var more by remember(full, ref) { mutableStateOf(true) }
    var loading by remember(full, ref) { mutableStateOf(true) }
    var error by remember(full, ref) { mutableStateOf<Throwable?>(null) }
    var retry by remember(full, ref) { mutableIntStateOf(0) }
    LaunchedEffect(full, ref, page, retry) {
        loading = true
        try {
            val p = s.git.commits(full, ref, page)
            commits += p.commits
            more = p.more
            error = null
        } catch (e: Exception) {
            error = e
        } finally { loading = false }
    }
    if (commits.isEmpty() && error != null) { ErrorState(error!!, { retry++ }); return }
    if (commits.isEmpty() && loading) { Loading(); return }
    val grouped = commits.groupBy { Format.day(it.at) }
    LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = bottom)) {
        grouped.forEach { (day, list) ->
            item(key = "d:$day") {
                Text(day, style = MaterialTheme.typography.labelLarge, color = Phos.colors.muted, modifier = Modifier.padding(top = 14.dp, bottom = 6.dp, start = 4.dp))
            }
            item(key = "c:$day") {
                Card(padding = PaddingValues(vertical = 4.dp)) {
                    Column {
                        list.forEachIndexed { i, c ->
                            if (i > 0) HorizontalDivider(color = Phos.colors.border)
                            CommitRow(c) { nav.navigate(Routes.commit(full, c.sha)) }
                        }
                    }
                }
            }
        }
        if (more) item {
            LaunchedEffect(commits.size) { if (!loading) page++ }
            Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
        }
    }
}

@Composable
fun CommitRow(c: Commit, onClick: () -> Unit) {
    val s = server
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Avatar(c.author, c.person?.let { s.git.avatarUrl(it) }, 30.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(c.subject, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text("${c.author} · ${Format.time(c.at)}", style = MaterialTheme.typography.labelMedium, color = Phos.colors.dim)
        }
        Spacer(Modifier.width(8.dp))
        Text(c.sha.take(7), style = MonoSmall, color = Phos.colors.accent)
    }
}

@Composable
private fun ThreadsTab(nav: NavController, full: String, kind: String, bottom: androidx.compose.ui.unit.Dp) {
    val s = server
    var state by rememberSaveable(kind) { mutableStateOf("open") }
    val items = remember(full, kind, state) { mutableStateListOf<ThreadRow>() }
    var page by remember(full, kind, state) { mutableIntStateOf(1) }
    var more by remember(full, kind, state) { mutableStateOf(false) }
    var counts by remember(full, kind) { mutableStateOf(0 to 0) }
    var loading by remember(full, kind, state) { mutableStateOf(true) }
    var error by remember(full, kind, state) { mutableStateOf<Throwable?>(null) }
    var retry by remember(full, kind, state) { mutableIntStateOf(0) }
    LaunchedEffect(full, kind, state, page, retry) {
        loading = true
        try {
            val p = s.git.threads(full, kind, state, page)
            items += p.items; more = p.more; counts = p.open to p.closed; error = null
        } catch (e: Exception) { error = e } finally { loading = false }
    }
    LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = bottom), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("open" to counts.first, "closed" to counts.second).forEach { (st, n) ->
                    FilterChip(
                        selected = state == st,
                        onClick = { state = st },
                        label = { Text("${st.replaceFirstChar { it.uppercase() }} $n") },
                        leadingIcon = { Icon(if (st == "open") Icons.Outlined.RemoveCircleOutline else Icons.Outlined.CheckCircle, null, Modifier.size(16.dp)) },
                        colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Phos.colors.accent.copy(alpha = 0.18f)),
                    )
                }
            }
        }
        when {
            items.isEmpty() && error != null -> item { ErrorState(error!!, { retry++ }, Modifier.height(260.dp)) }
            items.isEmpty() && loading -> item { Loading(Modifier.height(160.dp)) }
            items.isEmpty() -> item {
                Empty(Icons.Outlined.CheckCircle, if (kind == "issues") "No $state issues" else "No $state pull requests", modifier = Modifier.height(260.dp))
            }
            else -> {
                items(items, key = { it.index }) { t -> ThreadCard(t) { nav.navigate(Routes.thread(full, kind, t.index)) } }
                if (more) item {
                    LaunchedEffect(items.size) { if (!loading) page++ }
                    Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
                }
            }
        }
    }
}

@Composable
fun RunStatus(status: String, size: androidx.compose.ui.unit.Dp = 20.dp) {
    val (icon, tint) = when (status) {
        "success" -> Icons.Outlined.CheckCircle to Phos.colors.green
        "failure" -> Icons.Outlined.Cancel to Phos.colors.red
        "cancelled", "skipped" -> Icons.Outlined.RemoveCircleOutline to Phos.colors.dim
        "running" -> null to Phos.colors.amber
        else -> Icons.Outlined.HourglassTop to Phos.colors.blue
    }
    if (icon == null) CircularProgressIndicator(Modifier.size(size), strokeWidth = 2.dp, color = tint)
    else Icon(icon, status, tint = tint, modifier = Modifier.size(size))
}

@Composable
private fun ActionsTab(nav: NavController, full: String, bottom: androidx.compose.ui.unit.Dp) {
    val s = server
    var tick by remember { mutableIntStateOf(0) }
    val runs = rememberLoad(full, tick) { s.git.runs(full, 1) }
    val live = runs.value?.runs?.any { it.status == "running" || it.status == "queued" } == true
    LaunchedEffect(live, tick) { if (live) { kotlinx.coroutines.delay(5_000); tick++ } }
    val list = runs.value?.runs
    when {
        list == null && runs.error != null -> ErrorState(runs.error!!, runs::reload)
        list == null -> Loading()
        list.isEmpty() -> Empty(Icons.Outlined.Schedule, "No runs yet", "Workflows in .forgejo/workflows run here on each push.")
        else -> LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = bottom), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(list, key = { it.id }) { r -> RunCard(r) { nav.navigate(Routes.run(full, r.id)) } }
        }
    }
}

@Composable
private fun RunCard(r: RunRow, onClick: () -> Unit) {
    Card(onClick = onClick) {
        Row(verticalAlignment = Alignment.Top) {
            Box(Modifier.padding(top = 2.dp)) { RunStatus(r.status) }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(r.title ?: r.name ?: "Run #${r.number}", style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(
                    listOfNotNull(r.workflow ?: r.name, "#${r.number}", r.ref?.removePrefix("refs/heads/"), r.actor).joinToString(" · "),
                    style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(
                    Format.agoLong(r.created) + (Format.duration(r.started, r.finished).takeIf { it.isNotEmpty() }?.let { " · $it" } ?: ""),
                    style = MaterialTheme.typography.labelMedium, color = Phos.colors.dim,
                )
            }
        }
    }
}

@Composable
private fun NewIssueDialog(full: String, onDismiss: () -> Unit, onCreated: (Int) -> Unit) {
    val s = server
    var title by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Phos.colors.bg,
        title = { Text("New issue") },
        text = {
            Column {
                OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(value = body, onValueChange = { body = it }, label = { Text("Description (Markdown)") }, minLines = 4, maxLines = 10, modifier = Modifier.fillMaxWidth())
                error?.let { Text(it, color = Phos.colors.red, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp)) }
            }
        },
        confirmButton = {
            TextButton(enabled = title.isNotBlank() && !busy, onClick = {
                busy = true
                scope.launch {
                    runCatching { s.git.createIssue(full, title.trim(), body) }
                        .onSuccess(onCreated)
                        .onFailure { error = it.message; busy = false }
                }
            }) { Text("Create") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}


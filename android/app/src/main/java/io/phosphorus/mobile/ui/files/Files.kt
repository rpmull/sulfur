package io.phosphorus.mobile.ui.files

import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.Audiotrack
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.DriveFileRenameOutline
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.FolderShared
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material.icons.outlined.StarOutline
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Upload
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import coil.compose.AsyncImage
import io.phosphorus.mobile.net.At
import io.phosphorus.mobile.net.DriveEntry
import io.phosphorus.mobile.net.DriveItem
import io.phosphorus.mobile.net.DriveMe
import io.phosphorus.mobile.repo.Downloads
import io.phosphorus.mobile.repo.Drive
import io.phosphorus.mobile.ui.common.Card
import io.phosphorus.mobile.ui.common.Empty
import io.phosphorus.mobile.ui.common.ErrorState
import io.phosphorus.mobile.ui.common.Format
import io.phosphorus.mobile.ui.common.Loading
import io.phosphorus.mobile.ui.common.Screen
import io.phosphorus.mobile.ui.common.SectionLabel
import io.phosphorus.mobile.ui.common.StatusDot
import io.phosphorus.mobile.ui.common.rememberLoad
import io.phosphorus.mobile.ui.server
import io.phosphorus.mobile.ui.shell.Routes
import io.phosphorus.mobile.ui.terminal.openTerminal
import io.phosphorus.mobile.ui.theme.Phos
import kotlinx.coroutines.launch

/** Where the browser is: the places overview, a folder, or one of Drive's lists. */
private sealed interface Loc {
    data object Places : Loc
    data class Folder(val at: At, val title: String) : Loc
    data class List(val kind: String) : Loc // recent, starred, shared
    data class Search(val q: String) : Loc
}

fun fileIcon(name: String, dir: Boolean): Pair<ImageVector, Color?> {
    if (dir) return Icons.Outlined.Folder to null
    return when (name.substringAfterLast('.', "").lowercase()) {
        "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "bmp", "svg" -> Icons.Outlined.Image to Color(0xFF62BB78)
        "mp4", "mkv", "mov", "webm", "avi" -> Icons.Outlined.Movie to Color(0xFFEB827B)
        "mp3", "flac", "wav", "ogg", "m4a", "opus" -> Icons.Outlined.Audiotrack to Color(0xFFE58B55)
        "pdf" -> Icons.Outlined.PictureAsPdf to Color(0xFFEB827B)
        "zip", "tar", "gz", "tgz", "xz", "7z", "rar", "zst", "deb", "rpm" -> Icons.Outlined.Archive to Color(0xFFCF9A35)
        "md", "txt", "doc", "docx", "odt", "rtf" -> Icons.Outlined.Description to Color(0xFF64A9F3)
        "kt", "kts", "java", "rs", "go", "py", "js", "ts", "tsx", "jsx", "c", "h", "cpp", "hpp", "cs", "rb", "php",
        "sh", "bash", "zsh", "json", "yaml", "yml", "toml", "xml", "html", "css", "sql", "lua", "swift", "zig", "bi" ->
            Icons.Outlined.Code to Color(0xFFAB93ED)
        else -> Icons.AutoMirrored.Outlined.InsertDriveFile to null
    }
}

fun isImage(name: String) = name.substringAfterLast('.', "").lowercase() in setOf("png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "heic")

@Composable
fun FilesScreen(
    nav: NavController,
    startHost: String?,
    startShare: String?,
    startPath: String?,
    shared: Uri?,
    onSharedDone: () -> Unit,
) {
    val s = server
    val drive = s.drive
    val stack = remember { mutableStateListOf<Loc>(Loc.Places) }
    val snack = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var refresh by remember { mutableStateOf(0) }
    var newFolder by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf<Pair<At, String>?>(null) }
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    val uploads = remember { mutableStateListOf<Upload>() }
    val meDrive = rememberLoad(s) { drive.me() }

    LaunchedEffect(startHost, startShare, startPath) {
        if (startHost != null) {
            if (startShare.isNullOrEmpty()) stack.add(Loc.Folder(At(startHost, "", ""), startHost))
            else stack.add(Loc.Folder(At(startHost, startShare, startPath.orEmpty()), startPath?.substringAfterLast('/')?.ifEmpty { null } ?: startHost))
        }
    }

    val loc = stack.last()
    BackHandler(enabled = stack.size > 1 || searching) {
        if (searching) { searching = false; query = "" } else stack.removeAt(stack.lastIndex)
    }

    fun go(l: Loc) { stack.add(l) }
    val folder = (loc as? Loc.Folder)?.takeIf { it.at.share.isNotEmpty() }

    fun upload(uris: List<Uri>, into: At) {
        uris.forEach { uri ->
            val (name, size) = queryName(context, uri)
            val up = Upload(name)
            uploads += up
            scope.launch {
                try {
                    drive.upload(context.contentResolver, uri, At(into.host, into.share, Drive.join(into.path, name)), size) { done, total ->
                        up.progress = if (total > 0) done.toFloat() / total else 1f
                    }
                    snack.showSnackbar("Uploaded $name")
                } catch (e: Exception) {
                    snack.showSnackbar("Couldn't upload $name: ${e.message}")
                } finally {
                    uploads.remove(up)
                    refresh++
                }
            }
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        folder?.let { upload(uris, it.at) }
    }

    val title = when (loc) {
        Loc.Places -> "Files"
        is Loc.Folder -> loc.title
        is Loc.List -> when (loc.kind) { "recent" -> "Recent"; "starred" -> "Starred"; else -> "Shared with me" }
        is Loc.Search -> "“${loc.q}”"
    }
    val subtitle = (loc as? Loc.Folder)?.at?.let { at ->
        if (at.share.isEmpty()) "Shares" else listOf(at.host, at.path.ifEmpty { "/" }).joinToString(" · ")
    }

    Screen(
        title = title,
        subtitle = subtitle,
        nav = nav,
        large = loc == Loc.Places,
        back = false,
        account = true,
        snackbar = snack,
        actions = {
            if (stack.size > 1) IconButton(onClick = { stack.removeAt(stack.lastIndex) }) {
                Icon(Icons.Outlined.ArrowUpward, "Up a folder")
            }
            IconButton(onClick = { searching = !searching }) { Icon(Icons.Outlined.Search, "Search") }
        },
        fab = {
            if (folder != null) {
                var open by remember { mutableStateOf(false) }
                Box {
                    FloatingActionButton(onClick = { open = true }, containerColor = Phos.colors.accent, contentColor = MaterialTheme.colorScheme.onPrimary) {
                        Icon(Icons.Outlined.Add, "Add")
                    }
                    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                        DropdownMenuItem(text = { Text("Upload files") }, leadingIcon = { Icon(Icons.Outlined.Upload, null) }, onClick = { open = false; picker.launch("*/*") })
                        DropdownMenuItem(text = { Text("New folder") }, leadingIcon = { Icon(Icons.Outlined.CreateNewFolder, null) }, onClick = { open = false; newFolder = true })
                    }
                }
            }
        },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(top = pad.calculateTopPadding())) {
            AnimatedVisibility(searching) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text("Search your home") },
                    leadingIcon = { Icon(Icons.Outlined.Search, null) },
                    trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Outlined.Close, "Clear") } },
                    singleLine = true,
                    keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = {
                        if (query.isNotBlank()) { go(Loc.Search(query.trim())); searching = false }
                    }),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search),
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
            if (shared != null) {
                SharedBanner(
                    canDrop = folder != null,
                    onUpload = { folder?.let { upload(listOf(shared), it.at) }; onSharedDone() },
                    onCancel = onSharedDone,
                )
            }
            uploads.forEach { u ->
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                    Text("Uploading ${u.name}", style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted)
                    LinearProgressIndicator(progress = { u.progress }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp), color = Phos.colors.accent)
                }
            }
            if (loc is Loc.Folder) Breadcrumbs(stack) { i -> while (stack.size > i + 1) stack.removeAt(stack.lastIndex) }
            Box(Modifier.weight(1f)) {
                val bottom = PaddingValues(bottom = pad.calculateBottomPadding() + 96.dp)
                when (loc) {
                    Loc.Places -> PlacesView(meDrive.value, bottom, onOpen = ::go)
                    is Loc.Folder -> if (loc.at.share.isEmpty()) HostShares(loc.at.host, bottom, onOpen = ::go)
                    else FolderView(
                        loc.at, refresh, bottom,
                        onOpenDir = { e -> go(Loc.Folder(At(loc.at.host, loc.at.share, Drive.join(loc.at.path, e.name)), e.name)) },
                        onOpenFile = { e -> nav.navigate(Routes.file(loc.at.host, loc.at.share, Drive.join(loc.at.path, e.name))) },
                        onAction = { action, e ->
                            val at = At(loc.at.host, loc.at.share, Drive.join(loc.at.path, e.name))
                            when (action) {
                                "rename" -> renaming = at to e.name
                                "star" -> scope.launch {
                                    runCatching { drive.star(at, !e.starred, e.dir) }.onFailure { snack.showSnackbar(it.message ?: "Failed") }
                                    refresh++
                                }
                                "trash" -> scope.launch {
                                    runCatching { drive.trash(listOf(at)) }
                                        .onSuccess { snack.showSnackbar("Moved ${e.name} to the trash") }
                                        .onFailure { snack.showSnackbar(it.message ?: "Failed") }
                                    refresh++
                                }
                                "download" -> {
                                    Downloads.toDownloads(context, s.client, drive.fileUrl(at, inline = false), e.name)
                                    scope.launch { snack.showSnackbar("Downloading ${e.name}") }
                                }
                                "terminal" -> {
                                    val dir = if (e.dir) at else At(at.host, at.share, Drive.parent(at.path))
                                    openTerminal(nav, s, dir.host, s.mesh.me.value)
                                }
                            }
                        },
                    )
                    is Loc.List -> ItemList(loc.kind, bottom, onOpen = { item -> openItem(item, nav, ::go) })
                    is Loc.Search -> ItemList("search:" + loc.q, bottom, onOpen = { item -> openItem(item, nav, ::go) })
                }
            }
        }
    }

    if (newFolder && folder != null) {
        NameDialog("New folder", "", "Create", onDismiss = { newFolder = false }) { name ->
            newFolder = false
            scope.launch {
                runCatching { drive.mkdir(At(folder.at.host, folder.at.share, Drive.join(folder.at.path, name))) }
                    .onFailure { snack.showSnackbar(it.message ?: "Failed") }
                refresh++
            }
        }
    }
    renaming?.let { (at, name) ->
        NameDialog("Rename", name, "Rename", onDismiss = { renaming = null }) { newName ->
            renaming = null
            scope.launch {
                runCatching { drive.rename(at, newName) }.onFailure { snack.showSnackbar(it.message ?: "Failed") }
                refresh++
            }
        }
    }
}

private fun openItem(item: DriveItem, nav: NavController, go: (Loc) -> Unit) {
    if (item.dir) go(Loc.Folder(At(item.host, item.share, item.path), item.name))
    else nav.navigate(Routes.file(item.host, item.share, item.path))
}

private class Upload(val name: String) {
    var progress by mutableStateOf(0f)
}

private fun queryName(context: android.content.Context, uri: Uri): Pair<String, Long> {
    var name = uri.lastPathSegment?.substringAfterLast('/') ?: "upload"
    var size = 0L
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
            c.getString(0)?.let { name = it }
            if (!c.isNull(1)) size = c.getLong(1)
        }
    }
    if (size <= 0) size = context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length }?.takeIf { it > 0 } ?: 0
    return name to size
}

@Composable
private fun SharedBanner(canDrop: Boolean, onUpload: () -> Unit, onCancel: () -> Unit) {
    Card(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
        Column {
            Text("A file was shared to Phosphorus", style = MaterialTheme.typography.titleSmall)
            Text(
                if (canDrop) "Upload it to this folder?" else "Open the folder to put it in, then upload.",
                style = MaterialTheme.typography.bodySmall, color = Phos.colors.muted,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onCancel) { Text("Cancel") }
                TextButton(onClick = onUpload, enabled = canDrop) { Text("Upload here") }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Breadcrumbs(stack: List<Loc>, onPick: (Int) -> Unit) {
    val crumbs = stack.mapIndexedNotNull { i, l ->
        when (l) {
            Loc.Places -> i to "Files"
            is Loc.Folder -> i to l.title
            is Loc.List -> i to l.kind.replaceFirstChar { it.uppercase() }
            is Loc.Search -> i to "Search"
        }
    }
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        crumbs.forEachIndexed { n, (i, label) ->
            if (n > 0) Icon(Icons.Outlined.ChevronRight, null, tint = Phos.colors.dim, modifier = Modifier.size(16.dp))
            val last = n == crumbs.lastIndex
            Text(
                label,
                style = MaterialTheme.typography.labelLarge,
                color = if (last) Phos.colors.fg else Phos.colors.muted,
                modifier = Modifier.clip(RoundedCornerShape(6.dp))
                    .then(if (!last) Modifier.combinedClickable(onClick = { onPick(i) }) else Modifier)
                    .padding(horizontal = 6.dp, vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun PlaceRow(icon: ImageVector, tint: Color, title: String, subtitle: String?, trailing: @Composable (() -> Unit)? = null, onClick: () -> Unit) {
    Card(onClick = onClick, padding = PaddingValues(horizontal = 16.dp, vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(tint.copy(alpha = 0.14f)), contentAlignment = Alignment.Center) {
                Icon(icon, null, tint = tint)
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = Phos.colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            trailing?.invoke()
        }
    }
}

@Composable
private fun PlacesView(me: DriveMe?, pad: PaddingValues, onOpen: (Loc) -> Unit) {
    val s = server
    val places = rememberLoad(s) { s.drive.places() }
    LazyColumn(
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = pad.calculateBottomPadding()),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.horizontalScroll(rememberScrollState())) {
                QuickChip(Icons.Outlined.AccessTime, "Recent") { onOpen(Loc.List("recent")) }
                QuickChip(Icons.Outlined.Star, "Starred") { onOpen(Loc.List("starred")) }
                QuickChip(Icons.Outlined.FolderShared, "Shared with me") { onOpen(Loc.List("shared")) }
            }
        }
        if (me != null) {
            item { SectionLabel("Home") }
            item {
                PlaceRow(Icons.Outlined.Home, Phos.colors.accent, "My files", "Synced across every machine") {
                    onOpen(Loc.Folder(At(me.host, "home", me.user), "My files"))
                }
            }
            item {
                PlaceRow(Icons.Outlined.Groups, Phos.colors.teal, "Everyone", "Shared with the whole mesh") {
                    onOpen(Loc.Folder(At(me.host, "home", "shared"), "Everyone"))
                }
            }
        }
        item { SectionLabel("Machines") }
        val p = places.value
        when {
            p == null && places.error != null -> item { ErrorState(places.error!!, places::reload, Modifier.height(240.dp)) }
            p == null -> item { Loading(Modifier.height(120.dp)) }
            else -> items(p.hosts, key = { it.host }) { h ->
                val shares = h.shares.size + if (h.login) 1 else 0
                PlaceRow(
                    Icons.Outlined.Storage,
                    if (h.up) Phos.colors.blue else Phos.colors.dim,
                    h.host,
                    if (h.up) "$shares place${if (shares == 1) "" else "s"}" else "Offline",
                    trailing = { StatusDot(h.up) },
                ) { onOpen(Loc.Folder(At(h.host, "", ""), h.host)) }
            }
        }
    }
}

@Composable
private fun QuickChip(icon: ImageVector, label: String, onClick: () -> Unit) {
    AssistChip(
        onClick = onClick,
        label = { Text(label) },
        leadingIcon = { Icon(icon, null, Modifier.size(18.dp)) },
        colors = AssistChipDefaults.assistChipColors(containerColor = Phos.colors.card, leadingIconContentColor = Phos.colors.accent),
        border = AssistChipDefaults.assistChipBorder(enabled = true, borderColor = Phos.colors.border),
        shape = RoundedCornerShape(50),
    )
}

@Composable
private fun HostShares(host: String, pad: PaddingValues, onOpen: (Loc) -> Unit) {
    val s = server
    val places = rememberLoad(s, host) { s.drive.places() }
    val h = places.value?.hosts?.firstOrNull { it.host == host }
    when {
        places.value == null && places.error != null -> ErrorState(places.error!!, places::reload)
        places.value == null -> Loading()
        h == null || (h.shares.isEmpty() && !h.login) -> Empty(Icons.Outlined.Storage, "Nothing shared on $host", "Add a share for it in the desktop's Settings › Files, or save a login for it to reach the whole disk.")
        else -> LazyColumn(
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = pad.calculateBottomPadding()),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(h.shares, key = { it.id }) { sh ->
                PlaceRow(Icons.Outlined.Folder, Phos.colors.blue, sh.label.substringAfterLast('/').ifEmpty { sh.label }, sh.label + permsLabel(sh.perms)) {
                    onOpen(Loc.Folder(At(host, sh.id, ""), sh.label.substringAfterLast('/').ifEmpty { sh.label }))
                }
            }
            if (h.login) item {
                PlaceRow(Icons.Outlined.Storage, Phos.colors.orange, "Whole disk", "Everything your login on $host can reach") {
                    onOpen(Loc.Folder(At(host, "fs", ""), "$host disk"))
                }
            }
        }
    }
}

private fun permsLabel(p: String?) = when {
    p == null -> ""
    !p.contains('w') -> " · read only"
    else -> ""
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FolderView(
    at: At,
    refresh: Int,
    pad: PaddingValues,
    onOpenDir: (DriveEntry) -> Unit,
    onOpenFile: (DriveEntry) -> Unit,
    onAction: (String, DriveEntry) -> Unit,
) {
    val s = server
    val listing = rememberLoad(at, refresh) { s.drive.list(at) }
    val l = listing.value
    when {
        l == null && listing.error != null -> ErrorState(listing.error!!, listing::reload)
        l == null -> Loading()
        l.entries.isEmpty() -> Empty(Icons.Outlined.Folder, "This folder is empty", "Upload files with the + button.")
        else -> LazyColumn(contentPadding = PaddingValues(bottom = pad.calculateBottomPadding())) {
            items(l.entries.sortedWith(compareByDescending<DriveEntry> { it.dir }.thenBy { it.name.lowercase() }), key = { it.name }) { e ->
                EntryRow(at, e, onClick = { if (e.dir) onOpenDir(e) else onOpenFile(e) }, onAction = { onAction(it, e) })
            }
            if (l.truncated) item {
                Text("Showing the first ${l.entries.size} items", style = MaterialTheme.typography.labelMedium, color = Phos.colors.dim, modifier = Modifier.padding(16.dp))
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun EntryRow(at: At, e: DriveEntry, onClick: () -> Unit, onAction: (String) -> Unit) {
    val s = server
    var menu by remember { mutableStateOf(false) }
    val (icon, tint) = fileIcon(e.name, e.dir)
    Row(
        Modifier.fillMaxWidth().combinedClickable(onClick = onClick, onLongClick = { menu = true }).padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).background((tint ?: Phos.colors.accent).copy(alpha = 0.12f)), contentAlignment = Alignment.Center) {
            if (!e.dir && isImage(e.name) && (e.size ?: 0) < 8_000_000) {
                AsyncImage(
                    model = s.drive.fileUrl(At(at.host, at.share, Drive.join(at.path, e.name))),
                    imageLoader = s.images,
                    contentDescription = null,
                    contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                    modifier = Modifier.size(44.dp),
                )
            } else Icon(icon, null, tint = tint ?: Phos.colors.accent)
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(e.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (e.starred) { Spacer(Modifier.width(6.dp)); Icon(Icons.Outlined.Star, null, tint = Phos.colors.amber, modifier = Modifier.size(14.dp)) }
            }
            val meta = listOfNotNull(
                if (e.dir) (if (e.empty) "Empty" else null) else Format.bytes(e.size),
                e.mtime?.let { Format.day(it) },
            ).joinToString(" · ")
            if (meta.isNotEmpty()) Text(meta, style = MaterialTheme.typography.bodySmall, color = Phos.colors.muted)
        }
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "Actions", tint = Phos.colors.muted) }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (!e.dir) DropdownMenuItem(text = { Text("Download") }, leadingIcon = { Icon(Icons.Outlined.Download, null) }, onClick = { menu = false; onAction("download") })
                DropdownMenuItem(text = { Text("Rename") }, leadingIcon = { Icon(Icons.Outlined.DriveFileRenameOutline, null) }, onClick = { menu = false; onAction("rename") })
                DropdownMenuItem(
                    text = { Text(if (e.starred) "Unstar" else "Star") },
                    leadingIcon = { Icon(if (e.starred) Icons.Outlined.StarOutline else Icons.Outlined.Star, null) },
                    onClick = { menu = false; onAction("star") },
                )
                if (at.share != "home") DropdownMenuItem(text = { Text("Terminal on ${at.host}") }, leadingIcon = { Icon(Icons.Outlined.Terminal, null) }, onClick = { menu = false; onAction("terminal") })
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text("Move to trash", color = Phos.colors.red) },
                    leadingIcon = { Icon(Icons.Outlined.Delete, null, tint = Phos.colors.red) },
                    onClick = { menu = false; onAction("trash") },
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ItemList(kind: String, pad: PaddingValues, onOpen: (DriveItem) -> Unit) {
    val s = server
    val items = rememberLoad(kind) {
        when {
            kind == "recent" -> s.drive.recent()
            kind == "starred" -> s.drive.starred()
            kind == "shared" -> s.drive.shared()
            else -> s.drive.search(kind.removePrefix("search:"))
        }.items
    }
    val list = items.value
    when {
        list == null && items.error != null -> ErrorState(items.error!!, items::reload)
        list == null -> Loading()
        list.isEmpty() -> Empty(
            if (kind.startsWith("search:")) Icons.Outlined.Search else Icons.Outlined.Folder,
            if (kind.startsWith("search:")) "No matches" else "Nothing here yet",
            if (kind.startsWith("search:")) "Search looks through your home, Everyone, and what's shared with you." else null,
        )
        else -> LazyColumn(contentPadding = PaddingValues(bottom = pad.calculateBottomPadding())) {
            items(list, key = { it.host + it.share + it.path }) { item ->
                val (icon, tint) = fileIcon(item.name, item.dir)
                Row(
                    Modifier.fillMaxWidth().combinedClickable(onClick = { onOpen(item) }).padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background((tint ?: Phos.colors.accent).copy(alpha = 0.12f)), contentAlignment = Alignment.Center) {
                        Icon(icon, null, tint = tint ?: Phos.colors.accent)
                    }
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(item.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            listOfNotNull(item.owner?.let { "from $it" }, Drive.parent(item.path).ifEmpty { null }, item.mtime?.let { Format.day(it) }).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall, color = Phos.colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun NameDialog(title: String, initial: String, confirm: String, onDismiss: () -> Unit, onDone: (String) -> Unit) {
    var name by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(value = name, onValueChange = { name = it }, singleLine = true, modifier = Modifier.fillMaxWidth())
        },
        confirmButton = {
            TextButton(onClick = { if (name.isNotBlank() && !name.contains('/')) onDone(name.trim()) }, enabled = name.isNotBlank() && !name.contains('/')) { Text(confirm) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = Phos.colors.bg,
    )
}


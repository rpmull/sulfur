package io.phosphorus.mobile.ui.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Reply
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import coil.compose.AsyncImage
import io.phosphorus.mobile.Notifier
import io.phosphorus.mobile.net.ChatFile
import io.phosphorus.mobile.repo.Chat
import io.phosphorus.mobile.repo.Downloads
import io.phosphorus.mobile.repo.Line
import io.phosphorus.mobile.ui.common.Avatar
import io.phosphorus.mobile.ui.common.Format
import io.phosphorus.mobile.ui.common.Markdown
import io.phosphorus.mobile.ui.common.Screen
import io.phosphorus.mobile.ui.common.hexColor
import io.phosphorus.mobile.ui.common.personColor
import io.phosphorus.mobile.ui.server
import io.phosphorus.mobile.ui.theme.Phos
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private sealed interface Row0 {
    data class Day(val label: String) : Row0
    data class Msg(val line: Line, val first: Boolean, val last: Boolean) : Row0
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun ConversationScreen(nav: NavController, conv: String) {
    val s = server
    val chat = s.chat
    val all by chat.lines.collectAsState()
    val people by chat.people.collectAsState()
    val channels by chat.channels.collectAsState()
    val me by chat.me.collectAsState()
    val lines = remember(all, conv) { all.filter { it.conv == conv && it.kind != "topic" } }
    val byId = remember(all) { all.associateBy { it.id } }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    val list = rememberLazyListState()

    var draft by rememberSaveable(conv) { mutableStateOf("") }
    var replyTo by remember { mutableStateOf<Line?>(null) }
    var editing by remember { mutableStateOf<Line?>(null) }
    var actions by remember { mutableStateOf<Line?>(null) }
    val attachments = remember { mutableStateListOf<ChatFile>() }
    var uploading by remember { mutableStateOf(0) }
    var lastTyping by remember { mutableLongStateOf(0L) }

    val title = when {
        conv.startsWith("dm:") -> conv.removePrefix("dm:")
        conv.startsWith("ch:") -> "#" + conv.removePrefix("ch:")
        else -> "#mesh"
    }
    val typing = remember(people, conv, me) { chat.typingIn(conv) }
    val subtitle = when {
        typing.isNotEmpty() -> typing.joinToString(", ") + if (typing.size == 1) " is typing…" else " are typing…"
        conv.startsWith("dm:") -> if (people.any { it.name == conv.removePrefix("dm:") }) "online" else "offline"
        conv.startsWith("ch:") -> channels[conv.removePrefix("ch:")]?.topic
        else -> "Everyone on the mesh"
    }

    DisposableEffect(conv) {
        Notifier.openConversation = conv
        onDispose { if (Notifier.openConversation == conv) Notifier.openConversation = null }
    }
    LaunchedEffect(lines.size) {
        chat.markRead(conv)
        if (list.firstVisibleItemIndex <= 2) list.animateScrollToItem(0)
    }

    val rows = remember(lines) {
        val out = ArrayList<Row0>()
        var prevDay: String? = null
        lines.forEachIndexed { i, l ->
            val day = Format.day(l.at)
            if (day != prevDay) { out += Row0.Day(day); prevDay = day }
            val prev = lines.getOrNull(i - 1)
            val next = lines.getOrNull(i + 1)
            val first = prev == null || prev.name != l.name || l.at - prev.at > 5 * 60_000 || Format.day(prev.at) != day
            val last = next == null || next.name != l.name || next.at - l.at > 5 * 60_000 || Format.day(next.at) != day
            out += Row0.Msg(l, first, last)
        }
        out.reversed()
    }

    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        uris.forEach { uri ->
            uploading++
            scope.launch {
                try {
                    val (name, bytes) = withContext(Dispatchers.IO) {
                        var n = "file"
                        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0)?.let { n = it } }
                        n to (context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: ByteArray(0))
                    }
                    if (bytes.size > 25 * 1024 * 1024) throw IllegalStateException("$name is over 25 MB")
                    val mime = context.contentResolver.getType(uri) ?: Downloads.mime(name)
                    attachments += chat.upload(name, mime, bytes)
                } catch (e: Exception) {
                    snack.showSnackbar("Couldn't attach: ${e.message}")
                } finally { uploading-- }
            }
        }
    }

    fun send() {
        val text = draft.trim()
        val e = editing
        if (e != null) {
            if (text.isNotEmpty()) chat.edit(e.id, text)
            editing = null; draft = ""
            return
        }
        if (text.isEmpty() && attachments.isEmpty()) return
        chat.send(conv, text, attachments.toList(), replyTo?.id)
        draft = ""; attachments.clear(); replyTo = null
        chat.typing("")
        lastTyping = 0
        scope.launch { list.animateScrollToItem(0) }
    }

    Screen(title = title, subtitle = subtitle, nav = nav, snackbar = snack) { pad ->
        Column(Modifier.fillMaxSize().padding(top = pad.calculateTopPadding()).imePadding()) {
            Box(Modifier.weight(1f)) {
                LazyColumn(
                    state = list,
                    reverseLayout = true,
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(rows, key = { r -> if (r is Row0.Msg) r.line.id else "day:" + (r as Row0.Day).label }) { r ->
                        when (r) {
                            is Row0.Day -> DayDivider(r.label)
                            is Row0.Msg -> MessageRow(
                                r.line, r.first, r.last,
                                showName = !conv.startsWith("dm:"),
                                reply = r.line.re?.let { byId[it] },
                                me = me,
                                onLong = { actions = r.line },
                                onReact = { em -> chat.react(r.line.id, em, r.line.reactions[em]?.contains(me) != true) },
                                onFile = { f -> openFile(context, s, chat, f, scope, snack) },
                            )
                        }
                    }
                    if (rows.isEmpty()) item {
                        Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                            Text("No messages yet. Say hello!", color = Phos.colors.muted)
                        }
                    }
                }
                val away by remember { derivedStateOf { list.firstVisibleItemIndex > 4 } }
                JumpToLatest(away, Modifier.align(Alignment.BottomEnd).padding(16.dp)) { scope.launch { list.animateScrollToItem(0) } }
            }
            Composer(
                draft = draft,
                onDraft = {
                    draft = it
                    val now = System.currentTimeMillis()
                    if (it.isNotEmpty() && now - lastTyping > 5_000) { chat.typing(conv); lastTyping = now }
                },
                replyTo = replyTo,
                editing = editing,
                attachments = attachments,
                uploading = uploading,
                onCancel = { replyTo = null; if (editing != null) { editing = null; draft = "" } },
                onRemove = { attachments.remove(it) },
                onAttach = { pick.launch("*/*") },
                onSend = ::send,
            )
        }
    }

    actions?.let { line ->
        ModalBottomSheet(onDismissRequest = { actions = null }, containerColor = Phos.colors.bg) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                Chat.Quick.forEach { em ->
                    val mine = line.reactions[em]?.contains(me) == true
                    Box(
                        Modifier.size(48.dp).clip(CircleShape).background(if (mine) Phos.colors.accent.copy(alpha = 0.25f) else Phos.colors.card)
                            .clickable { chat.react(line.id, em, !mine); actions = null },
                        contentAlignment = Alignment.Center,
                    ) { Text(em, style = MaterialTheme.typography.titleLarge) }
                }
            }
            Spacer(Modifier.height(8.dp))
            val itemColors = ListItemDefaults.colors(containerColor = Phos.colors.bg)
            ListItem(
                headlineContent = { Text("Reply") }, leadingContent = { Icon(Icons.AutoMirrored.Outlined.Reply, null) }, colors = itemColors,
                modifier = Modifier.clickable { replyTo = line; editing = null; actions = null },
            )
            ListItem(
                headlineContent = { Text("Copy text") }, leadingContent = { Icon(Icons.Outlined.ContentCopy, null) }, colors = itemColors,
                modifier = Modifier.clickable {
                    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("message", line.text))
                    actions = null
                },
            )
            if (line.mine && !line.pending) {
                ListItem(
                    headlineContent = { Text("Edit") }, leadingContent = { Icon(Icons.Outlined.Edit, null) }, colors = itemColors,
                    modifier = Modifier.clickable { editing = line; replyTo = null; draft = line.text; actions = null },
                )
                ListItem(
                    headlineContent = { Text("Delete", color = Phos.colors.red) }, leadingContent = { Icon(Icons.Outlined.Delete, null, tint = Phos.colors.red) }, colors = itemColors,
                    modifier = Modifier.clickable { chat.delete(line.id); actions = null },
                )
            }
            Spacer(Modifier.navigationBarsPadding().height(12.dp))
        }
    }
}

/** Outside any layout scope, so AnimatedVisibility resolves to the plain one. */
@Composable
private fun JumpToLatest(visible: Boolean, modifier: Modifier, onClick: () -> Unit) {
    AnimatedVisibility(visible, modifier) {
        SmallFloatingActionButton(onClick = onClick, containerColor = Phos.colors.card) {
            Icon(Icons.Outlined.KeyboardArrowDown, "Latest")
        }
    }
}

private fun openFile(
    context: Context,
    s: io.phosphorus.mobile.data.ServerSession,
    chat: Chat,
    f: ChatFile,
    scope: kotlinx.coroutines.CoroutineScope,
    snack: SnackbarHostState,
) {
    scope.launch {
        runCatching { Downloads.toCache(context, s.client, chat.mediaUrl(f, download = true), f.name) }
            .onSuccess { Downloads.openWith(context, it, f.name) }
            .onFailure { snack.showSnackbar("Couldn't open ${f.name}: ${it.message}") }
    }
}

@Composable
private fun DayDivider(label: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = Phos.colors.border)
        Text(label, style = MaterialTheme.typography.labelSmall, color = Phos.colors.dim, modifier = Modifier.padding(horizontal = 12.dp))
        HorizontalDivider(Modifier.weight(1f), color = Phos.colors.border)
    }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
private fun MessageRow(
    l: Line,
    first: Boolean,
    last: Boolean,
    showName: Boolean,
    reply: Line?,
    me: String,
    onLong: () -> Unit,
    onReact: (String) -> Unit,
    onFile: (ChatFile) -> Unit,
) {
    val s = server
    val c = Phos.colors
    val nameColor = hexColor(l.color) ?: personColor(l.name)
    val bubble = if (l.mine) c.accent.copy(alpha = if (c.isDark) 0.24f else 0.14f) else c.card
    val r = 18.dp
    val small = 6.dp
    val shape = if (l.mine) RoundedCornerShape(r, if (first) r else small, if (last) small else small, r)
    else RoundedCornerShape(if (first) r else small, r, r, if (last) small else small)
    Row(
        Modifier.fillMaxWidth().padding(top = if (first) 10.dp else 2.dp),
        horizontalArrangement = if (l.mine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        if (!l.mine) {
            if (last) Avatar(l.name, s.mesh.avatarUrl(l.name), 30.dp, nameColor) else Spacer(Modifier.width(30.dp))
            Spacer(Modifier.width(8.dp))
        }
        Column(horizontalAlignment = if (l.mine) Alignment.End else Alignment.Start, modifier = Modifier.widthIn(max = 320.dp)) {
            if (first && showName && !l.mine) Text(
                l.name, style = MaterialTheme.typography.labelMedium, color = nameColor, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(start = 12.dp, bottom = 3.dp),
            )
            Column(
                Modifier.clip(shape).background(bubble).combinedClickable(onClick = {}, onLongClick = onLong)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                if (reply != null) {
                    Row(Modifier.padding(bottom = 6.dp).clip(RoundedCornerShape(8.dp)).background(c.desk.copy(alpha = 0.6f)).padding(8.dp)) {
                        Box(Modifier.width(3.dp).height(30.dp).clip(RoundedCornerShape(2.dp)).background(hexColor(reply.color) ?: personColor(reply.name)))
                        Spacer(Modifier.width(8.dp))
                        Column {
                            Text(reply.name, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = hexColor(reply.color) ?: personColor(reply.name))
                            Text(reply.text.replace('\n', ' '), style = MaterialTheme.typography.bodySmall, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                l.files.forEach { f ->
                    if (f.type.startsWith("image/")) {
                        AsyncImage(
                            model = s.chat.mediaUrl(f), imageLoader = s.images, contentDescription = f.name,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.padding(bottom = 6.dp).widthIn(max = 280.dp).heightIn(max = 280.dp).clip(RoundedCornerShape(12.dp)).clickable { onFile(f) },
                        )
                    } else {
                        Row(
                            Modifier.padding(bottom = 6.dp).clip(RoundedCornerShape(10.dp)).background(c.desk.copy(alpha = 0.6f)).clickable { onFile(f) }.padding(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.AutoMirrored.Outlined.InsertDriveFile, null, tint = c.accent, modifier = Modifier.size(22.dp))
                            Spacer(Modifier.width(8.dp))
                            Column {
                                Text(f.name, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(Format.bytes(f.size), style = MaterialTheme.typography.labelSmall, color = c.dim)
                            }
                        }
                    }
                }
                if (l.text.isNotBlank()) Markdown(l.text, style = MaterialTheme.typography.bodyMedium)
                Row(Modifier.align(Alignment.End).padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (l.edited) Text("edited · ", style = MaterialTheme.typography.labelSmall, color = c.dim)
                    Text(if (l.pending) "sending…" else Format.time(l.at), style = MaterialTheme.typography.labelSmall, color = c.dim)
                }
            }
            if (l.reactions.isNotEmpty()) {
                FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    l.reactions.forEach { (em, who) ->
                        val mine = me in who
                        Row(
                            Modifier.clip(RoundedCornerShape(50))
                                .background(if (mine) c.accent.copy(alpha = 0.22f) else c.card)
                                .clickable { onReact(em) }.padding(horizontal = 8.dp, vertical = 3.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(em, style = MaterialTheme.typography.labelLarge)
                            if (who.size > 1) Text(" ${who.size}", style = MaterialTheme.typography.labelMedium, color = c.muted)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Composer(
    draft: String,
    onDraft: (String) -> Unit,
    replyTo: Line?,
    editing: Line?,
    attachments: List<ChatFile>,
    uploading: Int,
    onCancel: () -> Unit,
    onRemove: (ChatFile) -> Unit,
    onAttach: () -> Unit,
    onSend: () -> Unit,
) {
    val c = Phos.colors
    Column(Modifier.fillMaxWidth().background(c.bg).navigationBarsPadding()) {
        HorizontalDivider(color = c.border)
        val banner = editing?.let { "Editing" to it } ?: replyTo?.let { "Replying to ${it.name}" to it }
        if (banner != null) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(if (editing != null) Icons.Outlined.Edit else Icons.AutoMirrored.Outlined.Reply, null, tint = c.accent, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(banner.first, style = MaterialTheme.typography.labelMedium, color = c.accent)
                    Text(banner.second.text.replace('\n', ' '), style = MaterialTheme.typography.bodySmall, color = c.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                IconButton(onClick = onCancel) { Icon(Icons.Outlined.Close, "Cancel") }
            }
        }
        if (attachments.isNotEmpty() || uploading > 0) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                attachments.forEach { f ->
                    Row(
                        Modifier.clip(RoundedCornerShape(50)).background(c.card).padding(start = 10.dp, end = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(f.name, style = MaterialTheme.typography.labelMedium, maxLines = 1, modifier = Modifier.widthIn(max = 160.dp), overflow = TextOverflow.Ellipsis)
                        IconButton(onClick = { onRemove(f) }, modifier = Modifier.size(28.dp)) { Icon(Icons.Outlined.Close, "Remove", Modifier.size(14.dp)) }
                    }
                }
                if (uploading > 0) Text("Uploading $uploading…", style = MaterialTheme.typography.labelMedium, color = c.muted, modifier = Modifier.padding(6.dp))
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp), verticalAlignment = Alignment.Bottom) {
            IconButton(onClick = onAttach, enabled = editing == null) { Icon(Icons.Outlined.AttachFile, "Attach", tint = c.muted) }
            TextField(
                value = draft,
                onValueChange = onDraft,
                placeholder = { Text("Message") },
                maxLines = 6,
                shape = RoundedCornerShape(22.dp),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = c.card, unfocusedContainerColor = c.card,
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                ),
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(6.dp))
            val can = draft.isNotBlank() || attachments.isNotEmpty()
            Box(
                Modifier.padding(bottom = 4.dp).size(48.dp).clip(CircleShape).background(if (can) c.accent else c.card)
                    .clickable(enabled = can, onClick = onSend),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (editing != null) Icons.Outlined.Edit else Icons.AutoMirrored.Outlined.Send, "Send",
                    tint = if (can) MaterialTheme.colorScheme.onPrimary else c.dim, modifier = Modifier.size(20.dp),
                )
            }
        }
    }
}

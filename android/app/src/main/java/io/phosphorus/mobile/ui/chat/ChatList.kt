package io.phosphorus.mobile.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import io.phosphorus.mobile.net.Link
import io.phosphorus.mobile.repo.Conversation
import io.phosphorus.mobile.ui.common.Avatar
import io.phosphorus.mobile.ui.common.Card
import io.phosphorus.mobile.ui.common.Empty
import io.phosphorus.mobile.ui.common.Format
import io.phosphorus.mobile.ui.common.Loading
import io.phosphorus.mobile.ui.common.Screen
import io.phosphorus.mobile.ui.common.SectionLabel
import io.phosphorus.mobile.ui.common.hexColor
import io.phosphorus.mobile.ui.common.personColor
import io.phosphorus.mobile.ui.server
import io.phosphorus.mobile.ui.shell.Routes
import io.phosphorus.mobile.ui.theme.Phos

@Composable
fun ChatListScreen(nav: NavController) {
    val s = server
    val convs by s.chat.conversations.collectAsState()
    val people by s.chat.people.collectAsState()
    val me by s.chat.me.collectAsState()
    val link by s.chat.link.collectAsState()
    var newChannel by remember { mutableStateOf(false) }

    Screen(
        title = "Chat",
        subtitle = if (link == Link.Open) "${people.size} online" else "connecting…",
        nav = nav,
        large = true,
        fab = {
            FloatingActionButton(onClick = { newChannel = true }, containerColor = Phos.colors.accent, contentColor = MaterialTheme.colorScheme.onPrimary) {
                Icon(Icons.Outlined.Add, "New channel")
            }
        },
    ) { pad ->
        if (me.isEmpty() && convs.size <= 1 && link != Link.Open) { Loading(); return@Screen }
        LazyColumn(contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = pad.calculateTopPadding(), bottom = pad.calculateBottomPadding() + 96.dp)) {
            val others = people.filter { it.name != me }.distinctBy { it.name }
            if (others.isNotEmpty()) {
                item { SectionLabel("Online now") }
                item {
                    Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 4.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        others.forEach { p ->
                            Column(
                                Modifier.clip(RoundedCornerShape(12.dp)).clickable { nav.navigate(Routes.conv("dm:" + p.name)) }.padding(4.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Box {
                                    Avatar(p.name, s.mesh.avatarUrl(p.name), 52.dp, hexColor(p.color))
                                    Box(
                                        Modifier.align(Alignment.BottomEnd).size(14.dp).clip(CircleShape).background(Phos.colors.desk).padding(2.dp)
                                            .clip(CircleShape).background(Phos.colors.online),
                                    )
                                }
                                Spacer(Modifier.height(6.dp))
                                Text(p.name, style = MaterialTheme.typography.labelMedium, maxLines = 1, modifier = Modifier.widthIn(max = 64.dp), overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }
            val channels = convs.filter { it.kind != Conversation.Kind.Direct }
            val dms = convs.filter { it.kind == Conversation.Kind.Direct }
            item { SectionLabel("Channels") }
            items(channels, key = { it.id }) { c -> ConvRow(c, me) { nav.navigate(Routes.conv(c.id)) } }
            if (dms.isNotEmpty()) {
                item { SectionLabel("Direct messages") }
                items(dms, key = { it.id }) { c -> ConvRow(c, me) { nav.navigate(Routes.conv(c.id)) } }
            }
            if (convs.isEmpty()) item { Empty(Icons.Outlined.ChatBubbleOutline, "No messages yet", "Say hello in #mesh.") }
        }
    }

    if (newChannel) {
        var name by remember { mutableStateOf("") }
        var topic by remember { mutableStateOf("") }
        val valid = Regex("^[a-z0-9-]{1,24}$").matches(name) && name != "mesh"
        AlertDialog(
            onDismissRequest = { newChannel = false },
            containerColor = Phos.colors.bg,
            title = { Text("New channel") },
            text = {
                Column {
                    OutlinedTextField(
                        value = name, onValueChange = { name = it.lowercase().replace(' ', '-').take(24) },
                        label = { Text("Name") }, prefix = { Text("#") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(value = topic, onValueChange = { topic = it }, label = { Text("Topic") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = {
                TextButton(enabled = valid, onClick = {
                    s.chat.createChannel(name, topic.ifBlank { name })
                    newChannel = false
                    nav.navigate(Routes.conv("ch:$name"))
                }) { Text("Create") }
            },
            dismissButton = { TextButton(onClick = { newChannel = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun ConvRow(c: Conversation, me: String, onClick: () -> Unit) {
    val s = server
    Card(onClick = onClick, padding = PaddingValues(horizontal = 14.dp, vertical = 12.dp), modifier = Modifier.padding(vertical = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            when (c.kind) {
                Conversation.Kind.Direct -> Avatar(c.title, s.mesh.avatarUrl(c.title), 44.dp)
                else -> Box(
                    Modifier.size(44.dp).clip(RoundedCornerShape(12.dp)).background(personColor(c.title).copy(alpha = 0.16f)),
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Outlined.Tag, null, tint = personColor(c.title)) }
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (c.kind == Conversation.Kind.Direct) c.title else "#" + c.title,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = if (c.unread > 0) FontWeight.Bold else FontWeight.SemiBold,
                        modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    c.last?.let { Text(Format.ago(it.at), style = MaterialTheme.typography.labelSmall, color = if (c.unread > 0) Phos.colors.accent else Phos.colors.dim) }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val preview = c.last?.let { l ->
                        val who = if (l.mine) "You" else if (c.kind == Conversation.Kind.Direct) null else l.name
                        val body = l.text.ifBlank { l.files.firstOrNull()?.let { "📎 " + it.name } ?: "" }.replace('\n', ' ')
                        listOfNotNull(who, body).joinToString(": ")
                    } ?: c.topic ?: "No messages yet"
                    Text(
                        preview, style = MaterialTheme.typography.bodySmall,
                        color = if (c.unread > 0) Phos.colors.fg else Phos.colors.muted,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                    if (c.unread > 0) {
                        Spacer(Modifier.width(8.dp))
                        Box(
                            Modifier.clip(RoundedCornerShape(50)).background(Phos.colors.accent).padding(horizontal = 7.dp, vertical = 1.dp),
                        ) { Text(if (c.unread > 99) "99+" else c.unread.toString(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.Bold) }
                    }
                }
            }
        }
    }
}

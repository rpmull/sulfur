package io.phosphorus.mobile.ui.terminal

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Keyboard
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.TextDecrease
import androidx.compose.material.icons.outlined.TextIncrease
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import io.phosphorus.mobile.data.AppPrefs
import io.phosphorus.mobile.data.ServerSession
import io.phosphorus.mobile.net.Me
import io.phosphorus.mobile.repo.Host
import io.phosphorus.mobile.repo.TermSession
import io.phosphorus.mobile.ui.LocalGraph
import io.phosphorus.mobile.ui.common.Card
import io.phosphorus.mobile.ui.common.Empty
import io.phosphorus.mobile.ui.common.Format
import io.phosphorus.mobile.ui.common.Pill
import io.phosphorus.mobile.ui.common.Screen
import io.phosphorus.mobile.ui.common.SectionLabel
import io.phosphorus.mobile.ui.common.StatusDot
import io.phosphorus.mobile.ui.devices.hostIcon
import io.phosphorus.mobile.ui.devices.platformLabel
import io.phosphorus.mobile.ui.server
import io.phosphorus.mobile.ui.shell.Routes
import io.phosphorus.mobile.ui.theme.Mono
import io.phosphorus.mobile.ui.theme.MonoSmall
import io.phosphorus.mobile.ui.theme.Phos
import kotlinx.coroutines.launch

/** Opens a shell on [host] with the login saved in the person's vault, if any, and shows it. */
fun openTerminal(nav: NavController, server: ServerSession, host: String, me: Me?, run: String? = null, psh: Boolean = false) {
    val login = me?.vault?.hosts?.get(host)?.takeIf { it.user.isNotEmpty() }?.let { it.user to it.pass }
    val s = server.terminals.open(host, if (psh) "psh" else "shell", login, run)
    nav.navigate(Routes.term(s.sid))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalsScreen(nav: NavController) {
    val s = server
    val sessions by s.terminals.sessions.collectAsState()
    val hosts by s.mesh.hosts.collectAsState()
    val me by s.mesh.me.collectAsState()
    var picking by remember { mutableStateOf(false) }

    Screen(
        title = "Terminal",
        subtitle = if (sessions.isEmpty()) "Pick a machine to open a shell" else "${sessions.size} open",
        nav = nav,
        large = true,
        fab = {
            if (sessions.isNotEmpty()) ExtendedFloatingActionButton(
                onClick = { picking = true },
                icon = { Icon(Icons.Outlined.Add, null) },
                text = { Text("New") },
                containerColor = Phos.colors.accent,
                contentColor = MaterialTheme.colorScheme.onPrimary,
            )
        },
    ) { pad ->
        LazyColumn(
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = pad.calculateTopPadding() + 4.dp, bottom = pad.calculateBottomPadding() + 96.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (sessions.isNotEmpty()) {
                item { SectionLabel("Open") }
                items(sessions, key = { it.sid }) { t -> SessionCard(t, onOpen = { nav.navigate(Routes.term(t.sid)) }, onClose = { s.terminals.close(t) }) }
                item { SectionLabel("Machines") }
            }
            items(hosts.filter { it.phosphorus }, key = { "h:" + it.name }) { h ->
                HostRow(h, saved = me?.vault?.hosts?.containsKey(h.name) == true) { openTerminal(nav, s, h.name, me) }
            }
            item {
                Card(onClick = { openTerminal(nav, s, s.mesh.state.value?.self?.host ?: "", me, psh = true) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(Phos.colors.orange.copy(alpha = 0.15f)),
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.Outlined.AutoAwesome, null, tint = Phos.colors.orange) }
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text("Phos shell", style = MaterialTheme.typography.titleSmall)
                            Text("The mesh's own shell: every host's files and services in one place", style = MaterialTheme.typography.bodySmall, color = Phos.colors.muted)
                        }
                    }
                }
            }
        }
    }

    if (picking) {
        ModalBottomSheet(onDismissRequest = { picking = false }, containerColor = Phos.colors.bg) {
            Text("Open a terminal on", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(hosts.filter { it.phosphorus && it.online }) { h ->
                    HostRow(h, saved = me?.vault?.hosts?.containsKey(h.name) == true) { picking = false; openTerminal(nav, s, h.name, me) }
                }
            }
            Spacer(Modifier.navigationBarsPadding())
        }
    }
}

@Composable
private fun HostRow(h: Host, saved: Boolean, onClick: () -> Unit) {
    Card(onClick = if (h.online) onClick else null) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(Phos.colors.accent.copy(alpha = if (h.online) 0.14f else 0.05f)),
                contentAlignment = Alignment.Center,
            ) { Icon(hostIcon(h), null, tint = if (h.online) Phos.colors.accent else Phos.colors.dim) }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(h.name, style = MaterialTheme.typography.titleSmall)
                    Spacer(Modifier.width(8.dp))
                    StatusDot(h.online, 8.dp)
                }
                Text(
                    platformLabel(h) + if (!saved && h.online) " · asks for a login" else "",
                    style = MaterialTheme.typography.bodySmall, color = Phos.colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(Icons.Outlined.Terminal, null, tint = if (h.online) Phos.colors.muted else Phos.colors.border)
        }
    }
}

@Composable
private fun SessionCard(t: TermSession, onOpen: () -> Unit, onClose: () -> Unit) {
    val status by t.status.collectAsState()
    val title by t.title.collectAsState()
    val (label, color) = when (status) {
        TermSession.Status.Live -> "live" to Phos.colors.green
        TermSession.Status.Connecting -> "connecting" to Phos.colors.blue
        TermSession.Status.Reconnecting -> "reconnecting" to Phos.colors.amber
        TermSession.Status.Ended -> "ended" to Phos.colors.dim
    }
    Card(onClick = onOpen, padding = PaddingValues(start = 16.dp, top = 12.dp, bottom = 12.dp, end = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(Color(0xFF121416)),
                contentAlignment = Alignment.Center,
            ) { Text(">_", fontFamily = Mono, color = Phos.colors.green, fontWeight = FontWeight.Bold) }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (t.kind == "psh") "phos shell" else t.host, style = MaterialTheme.typography.bodySmall, color = Phos.colors.muted)
                    Spacer(Modifier.width(8.dp))
                    Pill(label, color)
                    Spacer(Modifier.width(8.dp))
                    Text(Format.ago(t.createdAt), style = MaterialTheme.typography.labelSmall, color = Phos.colors.dim)
                }
            }
            IconButton(onClick = onClose) { Icon(Icons.Outlined.Close, "Close") }
        }
    }
}

private data class Key(val label: String, val send: String? = null, val mod: String? = null)

private val keys = listOf(
    Key("esc", "\u001b"), Key("tab", "\t"), Key("ctrl", mod = "ctrl"), Key("alt", mod = "alt"),
    Key("←", "\u001b[D"), Key("↑", "\u001b[A"), Key("↓", "\u001b[B"), Key("→", "\u001b[C"),
    Key("^C", "\u0003"), Key("^D", "\u0004"), Key("^Z", "\u001a"), Key("^L", "\u000c"), Key("^R", "\u0012"),
    Key("|", "|"), Key("~", "~"), Key("/", "/"), Key("-", "-"), Key("_", "_"), Key("*", "*"),
    Key("home", "\u001b[H"), Key("end", "\u001b[F"), Key("pgup", "\u001b[5~"), Key("pgdn", "\u001b[6~"),
)

@Composable
fun TerminalScreen(nav: NavController, sid: String) {
    val s = server
    val graph = LocalGraph.current
    val sessions by s.terminals.sessions.collectAsState()
    val session = sessions.firstOrNull { it.sid == sid }
    val prefs by graph.prefs.flow.collectAsState(initial = AppPrefs())
    val scope = rememberCoroutineScope()
    val handle = remember { TerminalHandle() }
    val context = LocalContext.current
    val keyboard = LocalSoftwareKeyboardController.current
    var ctrl by remember { mutableStateOf(false) }
    var alt by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var font by remember(prefs.termFontSize) { mutableStateOf(prefs.termFontSize) }

    if (session == null) {
        Screen(title = "Terminal", nav = nav) {
            Empty(Icons.Outlined.Terminal, "This terminal is closed", "It ended, or the app restarted since it was opened.")
        }
        return
    }
    val status by session.status.collectAsState()
    val title by session.title.collectAsState()

    LaunchedEffect(ctrl, alt) { handle.mods(ctrl, alt) }

    fun setFont(f: Float) {
        font = f.coerceIn(7f, 28f)
        handle.font(font)
        scope.launch { graph.prefs.setTermFont(font) }
    }

    Screen(
        title = title,
        subtitle = (if (session.kind == "psh") "phos shell" else session.host) + when (status) {
            TermSession.Status.Live -> ""
            TermSession.Status.Connecting -> " · connecting…"
            TermSession.Status.Reconnecting -> " · reconnecting…"
            TermSession.Status.Ended -> " · ended"
        },
        nav = nav,
        actions = {
            IconButton(onClick = { handle.focus(); keyboard?.show() }) { Icon(Icons.Outlined.Keyboard, "Keyboard") }
            IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "More") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(
                    text = { Text("Paste") }, leadingIcon = { Icon(Icons.Outlined.ContentPaste, null) },
                    onClick = {
                        menu = false
                        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        cm.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString()?.let { handle.paste(it) }
                    },
                )
                DropdownMenuItem(
                    text = { Text("Copy selection") }, leadingIcon = { Icon(Icons.Outlined.ContentCopy, null) },
                    onClick = {
                        menu = false
                        handle.selection { sel ->
                            if (sel.isNotEmpty()) {
                                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                cm.setPrimaryClip(ClipData.newPlainText("terminal", sel))
                            }
                        }
                    },
                )
                DropdownMenuItem(text = { Text("Larger text") }, leadingIcon = { Icon(Icons.Outlined.TextIncrease, null) }, onClick = { setFont(font + 1) })
                DropdownMenuItem(text = { Text("Smaller text") }, leadingIcon = { Icon(Icons.Outlined.TextDecrease, null) }, onClick = { setFont(font - 1) })
                DropdownMenuItem(
                    text = { Text("Close terminal", color = Phos.colors.red) },
                    leadingIcon = { Icon(Icons.Outlined.Close, null, tint = Phos.colors.red) },
                    onClick = { menu = false; s.terminals.close(session); nav.popBackStack() },
                )
            }
        },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(top = pad.calculateTopPadding()).imePadding().navigationBarsPadding()) {
            TerminalView(
                session = session,
                colors = Phos.colors,
                fontSize = font,
                handle = handle,
                onFont = { f -> font = f; scope.launch { graph.prefs.setTermFont(f) } },
                onModsUsed = { ctrl = false; alt = false },
                modifier = Modifier.weight(1f).fillMaxWidth(),
            )
            KeyBar(ctrl, alt, onKey = { k ->
                when (k.mod) {
                    "ctrl" -> ctrl = !ctrl
                    "alt" -> alt = !alt
                    else -> {
                        var out = k.send ?: return@KeyBar
                        if (alt) out = "\u001b" + out
                        if (ctrl && out.length == 1) {
                            val c = out.uppercase()[0].code
                            if (c in 64..95) out = (c - 64).toChar().toString()
                        }
                        ctrl = false; alt = false
                        session.input(out)
                    }
                }
            })
        }
    }
}

@Composable
private fun KeyBar(ctrl: Boolean, alt: Boolean, onKey: (Key) -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(Phos.colors.bg).horizontalScroll(rememberScrollState()).padding(horizontal = 6.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        keys.forEach { k ->
            val on = (k.mod == "ctrl" && ctrl) || (k.mod == "alt" && alt)
            Box(
                Modifier.height(38.dp).clip(RoundedCornerShape(8.dp))
                    .background(if (on) Phos.colors.accent else Phos.colors.card)
                    .clickable { onKey(k) }
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    k.label,
                    style = MonoSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = if (on) MaterialTheme.colorScheme.onPrimary else Phos.colors.fg,
                )
            }
        }
    }
}

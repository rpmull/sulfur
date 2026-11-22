package io.phosphorus.mobile.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.OpenInBrowser
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.outlined.SystemUpdate
import androidx.compose.material.icons.outlined.TextFields
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import io.phosphorus.mobile.BuildConfig
import io.phosphorus.mobile.data.AppPrefs
import io.phosphorus.mobile.ui.LocalGraph
import io.phosphorus.mobile.ui.common.Avatar
import io.phosphorus.mobile.ui.common.Card
import io.phosphorus.mobile.ui.common.Pill
import io.phosphorus.mobile.ui.common.Screen
import io.phosphorus.mobile.ui.common.SectionLabel
import io.phosphorus.mobile.ui.common.rememberLoad
import io.phosphorus.mobile.ui.server
import io.phosphorus.mobile.ui.theme.Phos
import io.phosphorus.mobile.ui.theme.ThemeMode
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(nav: NavController, onSignOut: () -> Unit, onChangeServer: () -> Unit) {
    val s = server
    val graph = LocalGraph.current
    val prefs by graph.prefs.flow.collectAsState(initial = AppPrefs())
    val me by s.mesh.me.collectAsState()
    val state by s.mesh.state.collectAsState()
    val hosts by s.mesh.hosts.collectAsState()
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    val uri = LocalUriHandler.current
    var password by remember { mutableStateOf(false) }
    var confirmOut by remember { mutableStateOf(false) }
    val admin = me?.admin == true
    val users = rememberLoad(admin) { if (admin) s.mesh.users() else emptyList() }

    Screen(title = "Settings", nav = nav, snackbar = snack) { pad ->
        LazyColumn(
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = pad.calculateTopPadding() + 8.dp, bottom = pad.calculateBottomPadding() + 32.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                Card {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val name = me?.user ?: "…"
                        Avatar(name, me?.user?.let { s.mesh.avatarUrl(it) }, 60.dp)
                        Spacer(Modifier.width(16.dp))
                        Column(Modifier.weight(1f)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(name, style = MaterialTheme.typography.titleLarge)
                                if (admin) { Spacer(Modifier.width(8.dp)); Pill("admin", Phos.colors.accent) }
                            }
                            Text(state?.domain ?: s.base.host, style = MaterialTheme.typography.bodyMedium, color = Phos.colors.muted)
                        }
                    }
                }
            }

            item { SectionLabel("Appearance") }
            item {
                Card {
                    Column {
                        RowLabel(Icons.Outlined.Palette, "Theme", "Black saves power on OLED screens")
                        Spacer(Modifier.height(12.dp))
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                            ThemeMode.entries.forEachIndexed { i, m ->
                                SegmentedButton(
                                    selected = prefs.theme == m,
                                    onClick = { scope.launch { graph.prefs.setTheme(m) } },
                                    shape = SegmentedButtonDefaults.itemShape(i, ThemeMode.entries.size),
                                    colors = SegmentedButtonDefaults.colors(activeContainerColor = Phos.colors.accent.copy(alpha = 0.2f)),
                                    icon = {},
                                ) { Text(m.name) }
                            }
                        }
                        HorizontalDivider(Modifier.padding(vertical = 14.dp), color = Phos.colors.border)
                        RowLabel(Icons.Outlined.TextFields, "Terminal text", "${prefs.termFontSize.toInt()} pt · pinch in a terminal to change it there")
                        Slider(
                            value = prefs.termFontSize,
                            onValueChange = { v -> scope.launch { graph.prefs.setTermFont(v.toInt().toFloat()) } },
                            valueRange = 8f..24f,
                            steps = 15,
                            colors = SliderDefaults.colors(thumbColor = Phos.colors.accent, activeTrackColor = Phos.colors.accent),
                        )
                    }
                }
            }

            item { SectionLabel("Notifications") }
            item {
                Card {
                    Column {
                        ToggleRow(Icons.Outlined.Notifications, "Chat and mesh notices", "When the app isn't on screen", prefs.notify) {
                            scope.launch { graph.prefs.setNotify(it) }
                        }
                        HorizontalDivider(Modifier.padding(vertical = 12.dp), color = Phos.colors.border)
                        ToggleRow(
                            Icons.Outlined.Wifi, "Stay connected",
                            "Keeps chat and terminals live in the background, with an ongoing notification. Uses more battery.",
                            prefs.stayConnected,
                        ) { scope.launch { graph.prefs.setStayConnected(it) } }
                    }
                }
            }

            item { SectionLabel("Account") }
            item {
                Card(padding = PaddingValues(vertical = 4.dp)) {
                    Column {
                        ActionRow(Icons.Outlined.Lock, "Change password", "Signs out your other devices") { password = true }
                        ActionRow(Icons.Outlined.OpenInBrowser, "Open the desktop", "Everything else, in the browser") { uri.openUri(s.base.toString()) }
                    }
                }
            }

            item { SectionLabel("Mesh") }
            item {
                Card {
                    Column {
                        val self = state?.self
                        RowLabel(Icons.Outlined.Dns, state?.domain ?: s.base.host, listOfNotNull(self?.host?.let { "served by $it" }, self?.version?.let { "Phosphorus $it" }).joinToString(" · "))
                        Spacer(Modifier.height(8.dp))
                        Text("${hosts.count { it.online }} of ${hosts.size} hosts online", style = MaterialTheme.typography.bodySmall, color = Phos.colors.muted)
                        val latest = state?.update?.latest
                        if (latest != null && self?.version != null && latest.trimStart('v') != self.version.trimStart('v')) {
                            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = Phos.colors.border)
                            RowLabel(Icons.Outlined.SystemUpdate, "Update available: $latest", if (admin) "Start it from the desktop's Settings › Updates" else "An admin can install it")
                        }
                    }
                }
            }

            if (admin) {
                val list = users.value
                if (!list.isNullOrEmpty()) {
                    item { SectionLabel("People") }
                    item {
                        Card(padding = PaddingValues(vertical = 4.dp)) {
                            Column {
                                list.forEach { u ->
                                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                        Avatar(u.name, s.mesh.avatarUrl(u.name), 32.dp)
                                        Spacer(Modifier.width(12.dp))
                                        Text(u.name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                                        if (u.admin) Pill("admin", Phos.colors.accent)
                                    }
                                }
                            }
                        }
                    }
                }
            }

            item { SectionLabel("Session") }
            item {
                Card(padding = PaddingValues(vertical = 4.dp)) {
                    Column {
                        ActionRow(Icons.Outlined.SwapHoriz, "Use a different mesh", null, onClick = onChangeServer)
                        ActionRow(Icons.AutoMirrored.Outlined.Logout, "Sign out", null, danger = true) { confirmOut = true }
                    }
                }
            }
            item {
                Text(
                    "Phosphorus for Android ${BuildConfig.VERSION_NAME}",
                    style = MaterialTheme.typography.labelMedium, color = Phos.colors.dim,
                    modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
    }

    if (password) PasswordDialog(onDismiss = { password = false }) { old, new, done ->
        scope.launch {
            runCatching { s.mesh.changePassword(old, new) }
                .onSuccess { password = false; snack.showSnackbar("Password changed") }
                .onFailure { done(it.message ?: "Couldn't change the password") }
        }
    }
    if (confirmOut) AlertDialog(
        onDismissRequest = { confirmOut = false },
        containerColor = Phos.colors.bg,
        title = { Text("Sign out?") },
        text = { Text("Open terminals on this phone are closed.") },
        confirmButton = { TextButton(onClick = { confirmOut = false; onSignOut() }) { Text("Sign out", color = Phos.colors.red) } },
        dismissButton = { TextButton(onClick = { confirmOut = false }) { Text("Cancel") } },
    )
}

@Composable
private fun RowLabel(icon: ImageVector, title: String, subtitle: String?) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = Phos.colors.accent, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(14.dp))
        Column {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            if (!subtitle.isNullOrEmpty()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = Phos.colors.muted)
        }
    }
}

@Composable
private fun ToggleRow(icon: ImageVector, title: String, subtitle: String, on: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable { onChange(!on) }, verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = Phos.colors.accent, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = Phos.colors.muted)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = on, onCheckedChange = onChange, colors = SwitchDefaults.colors(checkedTrackColor = Phos.colors.accent))
    }
}

@Composable
private fun ActionRow(icon: ImageVector, title: String, subtitle: String?, danger: Boolean = false, onClick: () -> Unit) {
    val tint = if (danger) Phos.colors.red else Phos.colors.accent
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(14.dp))
        Column {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = if (danger) Phos.colors.red else Phos.colors.fg)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = Phos.colors.muted)
        }
    }
}

@Composable
private fun PasswordDialog(onDismiss: () -> Unit, onSubmit: (String, String, (String) -> Unit) -> Unit) {
    var old by remember { mutableStateOf("") }
    var new by remember { mutableStateOf("") }
    var again by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val valid = old.isNotEmpty() && new.length in 4..256 && new == again
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Phos.colors.bg,
        title = { Text("Change password") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(old, { old = it }, label = { Text("Current password") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
                OutlinedTextField(new, { new = it }, label = { Text("New password") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
                OutlinedTextField(
                    again, { again = it }, label = { Text("New password again") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), isError = again.isNotEmpty() && again != new,
                )
                error?.let { Text(it, color = Phos.colors.red, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = { TextButton(enabled = valid, onClick = { error = null; onSubmit(old, new) { error = it } }) { Text("Change") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

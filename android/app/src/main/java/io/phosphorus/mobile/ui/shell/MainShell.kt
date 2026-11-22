package io.phosphorus.mobile.ui.shell

import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import io.phosphorus.mobile.Launch
import io.phosphorus.mobile.ui.chat.ChatListScreen
import io.phosphorus.mobile.ui.chat.ConversationScreen
import io.phosphorus.mobile.ui.devices.DeviceScreen
import io.phosphorus.mobile.ui.devices.DevicesScreen
import io.phosphorus.mobile.ui.files.FilePreviewScreen
import io.phosphorus.mobile.ui.files.FilesScreen
import io.phosphorus.mobile.ui.git.BlobScreen
import io.phosphorus.mobile.ui.git.CommitScreen
import io.phosphorus.mobile.ui.git.RepoScreen
import io.phosphorus.mobile.ui.git.ReposScreen
import io.phosphorus.mobile.ui.git.RunScreen
import io.phosphorus.mobile.ui.git.ThreadScreen
import io.phosphorus.mobile.ui.server
import io.phosphorus.mobile.ui.settings.SettingsScreen
import io.phosphorus.mobile.ui.terminal.TerminalScreen
import io.phosphorus.mobile.ui.terminal.TerminalsScreen
import io.phosphorus.mobile.ui.theme.Phos
import kotlinx.coroutines.flow.MutableStateFlow

private data class Tab(val route: String, val label: String, val icon: ImageVector, val selected: ImageVector)

private val tabs = listOf(
    Tab("devices", "Devices", Icons.Outlined.Dns, Icons.Filled.Dns),
    Tab("terminals", "Terminal", Icons.Outlined.Terminal, Icons.Filled.Terminal),
    Tab("files", "Files", Icons.Outlined.Folder, Icons.Filled.Folder),
    Tab("git", "Git", Icons.Outlined.AccountTree, Icons.Filled.AccountTree),
    Tab("chat", "Chat", Icons.Outlined.ChatBubbleOutline, Icons.Filled.ChatBubble),
)

/** Route helpers: arguments are URL-encoded so paths and names with slashes survive. */
object Routes {
    fun enc(s: String): String = Uri.encode(s)
    fun device(host: String) = "device/${enc(host)}"
    fun term(sid: String) = "term/$sid"
    fun file(host: String, share: String, path: String) = "file?host=${enc(host)}&share=${enc(share)}&path=${enc(path)}"
    fun files(host: String, share: String, path: String = "") = "files?host=${enc(host)}&share=${enc(share)}&path=${enc(path)}"
    fun repo(full: String) = "repo/${enc(full)}"
    fun blob(full: String, ref: String, path: String) = "blob/${enc(full)}?ref=${enc(ref)}&path=${enc(path)}"
    fun commit(full: String, sha: String) = "commit/${enc(full)}/$sha"
    fun thread(full: String, kind: String, n: Int) = "thread/${enc(full)}/$kind/$n"
    fun run(full: String, id: Long) = "run/${enc(full)}/$id"
    fun conv(id: String) = "conv/${enc(id)}"
    const val SETTINGS = "settings"
}

private fun NavBackStackEntry.arg(name: String): String = arguments?.getString(name).orEmpty()

@Composable
fun MainShell(launch: MutableStateFlow<Launch?>, onSignOut: () -> Unit, onChangeServer: () -> Unit) {
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val topLevel = tabs.any { it.route == route?.substringBefore('?') }
    val wide = LocalConfiguration.current.screenWidthDp >= 600
    val convs by server.chat.conversations.collectAsState()
    val unread = convs.sumOf { it.unread }
    var shared by remember { mutableStateOf<Uri?>(null) }

    val pending by launch.collectAsState()
    LaunchedEffect(pending) {
        val l = pending ?: return@LaunchedEffect
        launch.value = null
        when (l.view) {
            "chat" -> {
                select(nav, "chat")
                if (l.conv != null) nav.navigate(Routes.conv(l.conv))
            }
            "files" -> { shared = l.shared; select(nav, "files") }
            "terminal" -> select(nav, "terminals")
            "apps", "status" -> select(nav, "devices")
        }
    }

    val content: @Composable (Modifier) -> Unit = { m ->
        NavHost(
            navController = nav,
            startDestination = "devices",
            modifier = m,
            enterTransition = { fadeIn(tween(180)) + slideInHorizontally(tween(220)) { it / 12 } },
            exitTransition = { fadeOut(tween(120)) },
            popEnterTransition = { fadeIn(tween(180)) },
            popExitTransition = { fadeOut(tween(120)) + slideOutHorizontally(tween(220)) { it / 12 } },
        ) {
            composable("devices", enterTransition = { EnterTransition.None }, exitTransition = { ExitTransition.None }) {
                DevicesScreen(nav)
            }
            composable("device/{host}") { DeviceScreen(nav, it.arg("host")) }
            composable("terminals", enterTransition = { EnterTransition.None }, exitTransition = { ExitTransition.None }) {
                TerminalsScreen(nav)
            }
            composable("term/{sid}") { TerminalScreen(nav, it.arg("sid")) }
            composable(
                "files?host={host}&share={share}&path={path}",
                arguments = listOf(
                    navArgument("host") { type = NavType.StringType; nullable = true },
                    navArgument("share") { type = NavType.StringType; nullable = true },
                    navArgument("path") { type = NavType.StringType; nullable = true },
                ),
                enterTransition = { EnterTransition.None }, exitTransition = { ExitTransition.None },
            ) {
                FilesScreen(
                    nav,
                    startHost = it.arguments?.getString("host"),
                    startShare = it.arguments?.getString("share"),
                    startPath = it.arguments?.getString("path"),
                    shared = shared,
                    onSharedDone = { shared = null },
                )
            }
            composable("file?host={host}&share={share}&path={path}") {
                FilePreviewScreen(nav, it.arg("host"), it.arg("share"), it.arg("path"))
            }
            composable("git", enterTransition = { EnterTransition.None }, exitTransition = { ExitTransition.None }) { ReposScreen(nav) }
            composable("repo/{full}") { RepoScreen(nav, it.arg("full")) }
            composable("blob/{full}?ref={ref}&path={path}") { BlobScreen(nav, it.arg("full"), it.arg("ref"), it.arg("path")) }
            composable("commit/{full}/{sha}") { CommitScreen(nav, it.arg("full"), it.arg("sha")) }
            composable("thread/{full}/{kind}/{n}") {
                ThreadScreen(nav, it.arg("full"), it.arg("kind"), it.arg("n").toIntOrNull() ?: 0)
            }
            composable("run/{full}/{id}") { RunScreen(nav, it.arg("full"), it.arg("id").toLongOrNull() ?: 0) }
            composable("chat", enterTransition = { EnterTransition.None }, exitTransition = { ExitTransition.None }) { ChatListScreen(nav) }
            composable("conv/{id}") { ConversationScreen(nav, it.arg("id")) }
            composable(
                Routes.SETTINGS,
                enterTransition = { slideInVertically(tween(260)) { it / 8 } + fadeIn(tween(200)) },
                popExitTransition = { slideOutVertically(tween(220)) { it / 8 } + fadeOut(tween(160)) },
            ) { SettingsScreen(nav, onSignOut = onSignOut, onChangeServer = onChangeServer) }
        }
    }

    if (wide) {
        Row(Modifier.fillMaxSize()) {
            NavigationRail(
                containerColor = Phos.colors.bg,
                modifier = Modifier.fillMaxHeight().statusBarsPadding(),
            ) {
                tabs.forEach { t ->
                    val sel = route?.substringBefore('?') == t.route
                    NavigationRailItem(
                        selected = sel,
                        onClick = { select(nav, t.route) },
                        icon = { TabIcon(t, sel, if (t.route == "chat") unread else 0) },
                        label = { Text(t.label) },
                        colors = NavigationRailItemDefaults.colors(indicatorColor = Phos.colors.accent.copy(alpha = 0.18f)),
                    )
                }
            }
            VerticalDivider(color = Phos.colors.border)
            content(Modifier.weight(1f).fillMaxHeight())
        }
    } else {
        Column(Modifier.fillMaxSize()) {
            val barShown = topLevel || route == null
            content(
                Modifier.weight(1f).fillMaxWidth()
                    .then(if (barShown) Modifier.consumeWindowInsets(WindowInsets.navigationBars) else Modifier),
            )
            AnimatedVisibility(
                visible = barShown,
                enter = slideInVertically { it } + fadeIn(),
                exit = slideOutVertically { it } + fadeOut(),
            ) {
                NavigationBar(containerColor = Phos.colors.bg, tonalElevation = 0.dp) {
                    tabs.forEach { t ->
                        val sel = route?.substringBefore('?') == t.route
                        NavigationBarItem(
                            selected = sel,
                            onClick = { select(nav, t.route) },
                            icon = { TabIcon(t, sel, if (t.route == "chat") unread else 0) },
                            label = { Text(t.label, fontWeight = if (sel) FontWeight.SemiBold else null) },
                            colors = NavigationBarItemDefaults.colors(
                                indicatorColor = Phos.colors.accent.copy(alpha = 0.18f),
                                selectedIconColor = Phos.colors.accent,
                                selectedTextColor = Phos.colors.fg,
                            ),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TabIcon(t: Tab, selected: Boolean, badge: Int) {
    BadgedBox(badge = {
        if (badge > 0) Badge(containerColor = Phos.colors.accent) { Text(if (badge > 99) "99+" else badge.toString()) }
    }) {
        Icon(if (selected) t.selected else t.icon, contentDescription = t.label)
    }
}

/** Switches tabs the way bottom navigation should: one copy of each, state kept. */
fun select(nav: NavHostController, route: String) {
    nav.navigate(route) {
        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}

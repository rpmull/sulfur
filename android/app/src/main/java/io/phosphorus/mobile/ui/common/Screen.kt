package io.phosphorus.mobile.ui.common

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import io.phosphorus.mobile.net.Link
import io.phosphorus.mobile.ui.LocalServer
import io.phosphorus.mobile.ui.shell.Routes
import io.phosphorus.mobile.ui.theme.Phos

/**
 * The frame of every screen: a collapsing large title for the top-level tabs, a compact bar
 * with back for the rest, the account button leading to Settings, and an offline strip.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Screen(
    title: String,
    nav: NavController,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    large: Boolean = false,
    back: Boolean = !large,
    account: Boolean = large,
    snackbar: SnackbarHostState? = null,
    actions: @Composable RowScope.() -> Unit = {},
    fab: @Composable () -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    val server = LocalServer.current
    val behavior = if (large) TopAppBarDefaults.exitUntilCollapsedScrollBehavior() else TopAppBarDefaults.pinnedScrollBehavior()
    val colors = TopAppBarDefaults.topAppBarColors(
        containerColor = Phos.colors.desk,
        scrolledContainerColor = Phos.colors.bg,
    )
    val nav0 = @Composable {
        if (back) IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
    }
    val acts: @Composable RowScope.() -> Unit = {
        actions()
        if (account && server != null) {
            val me by server.mesh.me.collectAsState()
            val name = me?.user ?: ""
            IconButton(onClick = { nav.navigate(Routes.SETTINGS) }) {
                Avatar(name.ifEmpty { "?" }, if (name.isNotEmpty()) server.mesh.avatarUrl(name) else null, size = 30.dp)
            }
        }
    }
    Scaffold(
        modifier = modifier.fillMaxSize().nestedScroll(behavior.nestedScrollConnection),
        containerColor = Phos.colors.desk,
        topBar = {
            Column {
                if (large) LargeTopAppBar(
                    title = {
                        Column {
                            Text(title, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (subtitle != null && behavior.state.collapsedFraction < 0.5f) Text(
                                subtitle, style = MaterialTheme.typography.bodyMedium, color = Phos.colors.muted, maxLines = 1,
                            )
                        }
                    },
                    navigationIcon = nav0, actions = acts, colors = colors, scrollBehavior = behavior,
                ) else TopAppBar(
                    title = {
                        Column {
                            Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (subtitle != null) Text(
                                subtitle, style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    },
                    navigationIcon = nav0, actions = acts, colors = colors, scrollBehavior = behavior,
                )
                if (server != null) OfflineStrip()
            }
        },
        snackbarHost = { if (snackbar != null) SnackbarHost(snackbar) },
        floatingActionButton = fab,
        bottomBar = bottomBar,
        contentWindowInsets = WindowInsets.navigationBars.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal),
        content = content,
    )
}

@Composable
private fun OfflineStrip() {
    val server = LocalServer.current ?: return
    val link by server.mesh.link.collectAsState()
    // Only after a first connection drops: a cold start shows its own loading.
    val seen = remember { booleanArrayOf(false) }
    if (link == Link.Open) seen[0] = true
    if (link == Link.Open || !seen[0]) return
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.CloudOff, null, tint = Phos.colors.amber, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text("Reconnecting to ${server.base.host}…", style = MaterialTheme.typography.labelMedium, color = Phos.colors.amber)
    }
}

@Composable
fun CenterBox(modifier: Modifier = Modifier, content: @Composable () -> Unit) =
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }

package io.phosphorus.mobile.ui.git

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import io.phosphorus.mobile.net.RepoRow
import io.phosphorus.mobile.net.ThreadRow
import io.phosphorus.mobile.ui.common.Card
import io.phosphorus.mobile.ui.common.Empty
import io.phosphorus.mobile.ui.common.ErrorState
import io.phosphorus.mobile.ui.common.Format
import io.phosphorus.mobile.ui.common.Loading
import io.phosphorus.mobile.ui.common.Pill
import io.phosphorus.mobile.ui.common.Screen
import io.phosphorus.mobile.ui.common.hexColor
import io.phosphorus.mobile.ui.common.personColor
import io.phosphorus.mobile.ui.common.rememberLoad
import io.phosphorus.mobile.ui.server
import io.phosphorus.mobile.ui.shell.Routes
import io.phosphorus.mobile.ui.theme.Phos
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReposScreen(nav: NavController) {
    val s = server
    var tab by rememberSaveable { mutableStateOf(0) }
    var query by rememberSaveable { mutableStateOf("") }
    Screen(title = "Git", subtitle = "git.${s.base.host}", nav = nav, large = true) { pad ->
        Column(Modifier.fillMaxSize().padding(top = pad.calculateTopPadding())) {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                listOf("Repositories", "Issues", "Pull requests").forEachIndexed { i, label ->
                    SegmentedButton(
                        selected = tab == i,
                        onClick = { tab = i },
                        shape = SegmentedButtonDefaults.itemShape(i, 3),
                        colors = SegmentedButtonDefaults.colors(activeContainerColor = Phos.colors.accent.copy(alpha = 0.18f)),
                        icon = {},
                    ) { Text(label, maxLines = 1) }
                }
            }
            val bottom = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = pad.calculateBottomPadding() + 24.dp)
            when (tab) {
                0 -> {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        placeholder = { Text("Find a repository") },
                        leadingIcon = { Icon(Icons.Outlined.Search, null) },
                        trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Outlined.Close, "Clear") } },
                        singleLine = true,
                        shape = RoundedCornerShape(50),
                        colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = Phos.colors.card, focusedContainerColor = Phos.colors.card, unfocusedBorderColor = Phos.colors.border),
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                    val repos = rememberLoad(query) {
                        if (query.isNotEmpty()) delay(250)
                        s.git.repos(query)
                    }
                    val list = repos.value
                    when {
                        list == null && repos.error != null -> ErrorState(repos.error!!, repos::reload)
                        list == null -> Loading()
                        list.isEmpty() -> Empty(Icons.Outlined.AccountTree, if (query.isEmpty()) "No repositories yet" else "No matches")
                        else -> LazyColumn(contentPadding = bottom, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            items(list, key = { it.full }) { r -> RepoCard(r) { nav.navigate(Routes.repo(r.full)) } }
                        }
                    }
                }
                else -> {
                    val kind = if (tab == 1) "issues" else "pulls"
                    val threads = rememberLoad(kind) { s.git.myThreads(kind) }
                    val list = threads.value?.items
                    when {
                        list == null && threads.error != null -> ErrorState(threads.error!!, threads::reload)
                        list == null -> Loading()
                        list.isEmpty() -> Empty(Icons.Outlined.AccountTree, "Nothing open for you", "Issues and pull requests you opened, are assigned or mentioned in show here.")
                        else -> LazyColumn(contentPadding = bottom, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            items(list, key = { "${it.repo}#${it.index}" }) { t ->
                                ThreadCard(t, showRepo = true) { t.repo?.let { r -> nav.navigate(Routes.thread(r, kind, t.index)) } }
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RepoCard(r: RepoRow, onClick: () -> Unit) {
    Card(onClick = onClick) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(36.dp).clip(RoundedCornerShape(9.dp)).background(personColor(r.name).copy(alpha = 0.18f)),
                    contentAlignment = Alignment.Center,
                ) { Text(r.name.take(1).uppercase(), color = personColor(r.name), fontWeight = FontWeight.Bold) }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(r.owner, style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted)
                    Text(r.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (r.private) Icon(Icons.Outlined.Lock, "Private", tint = Phos.colors.dim, modifier = Modifier.size(16.dp))
                if (r.archived) { Spacer(Modifier.width(6.dp)); Icon(Icons.Outlined.Archive, "Archived", tint = Phos.colors.dim, modifier = Modifier.size(16.dp)) }
            }
            r.description?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, style = MaterialTheme.typography.bodyMedium, color = Phos.colors.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (r.topics.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    r.topics.take(5).forEach { Pill(it, Phos.colors.blue) }
                }
            }
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (r.stars > 0) {
                    Icon(Icons.Outlined.Star, null, tint = Phos.colors.amber, modifier = Modifier.size(14.dp))
                    Text(" ${r.stars}   ", style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted)
                }
                if (r.updated > 0) Text("Updated ${Format.agoLong(r.updated)}", style = MaterialTheme.typography.labelMedium, color = Phos.colors.dim)
            }
        }
    }
}

@Composable
fun stateColor(state: String, merged: Boolean): Color = when {
    merged -> Phos.colors.purple
    state == "open" -> Phos.colors.green
    state == "closed" -> Phos.colors.red
    else -> Phos.colors.dim
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ThreadCard(t: ThreadRow, showRepo: Boolean = false, onClick: () -> Unit) {
    Card(onClick = onClick) {
        Row {
            Box(Modifier.padding(top = 4.dp).size(10.dp).clip(RoundedCornerShape(5.dp)).background(stateColor(t.state, t.merged)))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                if (showRepo && t.repo != null) Text(t.repo, style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted)
                Text(t.title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (t.labels.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        t.labels.forEach { Pill(it.name, hexColor(it.color) ?: Phos.colors.blue) }
                    }
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    "#${t.index} · ${t.author} · ${Format.agoLong(t.created)}" + if (t.comments > 0) " · ${t.comments} comment${if (t.comments == 1) "" else "s"}" else "",
                    style = MaterialTheme.typography.labelMedium, color = Phos.colors.dim,
                )
            }
        }
    }
}

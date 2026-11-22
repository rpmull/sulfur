package io.phosphorus.mobile.ui.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.material.icons.outlined.DeveloperBoard
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.LaptopMac
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Router
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import io.phosphorus.mobile.net.StatsSample
import io.phosphorus.mobile.repo.History
import io.phosphorus.mobile.repo.Host
import io.phosphorus.mobile.ui.common.Card
import io.phosphorus.mobile.ui.common.Empty
import io.phosphorus.mobile.ui.common.Format
import io.phosphorus.mobile.ui.common.KeyValue
import io.phosphorus.mobile.ui.common.Loading
import io.phosphorus.mobile.ui.common.Meter
import io.phosphorus.mobile.ui.common.Pill
import io.phosphorus.mobile.ui.common.Ring
import io.phosphorus.mobile.ui.common.Screen
import io.phosphorus.mobile.ui.common.SectionLabel
import io.phosphorus.mobile.ui.common.Sparkline
import io.phosphorus.mobile.ui.common.StatusDot
import io.phosphorus.mobile.ui.common.loadColor
import io.phosphorus.mobile.ui.server
import io.phosphorus.mobile.ui.shell.Routes
import io.phosphorus.mobile.ui.terminal.openTerminal
import io.phosphorus.mobile.ui.theme.MonoSmall
import io.phosphorus.mobile.ui.theme.Phos
import kotlinx.coroutines.delay

fun hostIcon(h: Host): ImageVector {
    val p = (h.platform ?: h.os ?: "").lowercase()
    val m = (h.model ?: "").lowercase()
    return when {
        "raspberry" in m || h.arch?.startsWith("arm") == true || h.arch == "aarch64" && "pi" in h.name -> Icons.Outlined.DeveloperBoard
        "darwin" in p || "mac" in p -> Icons.Outlined.LaptopMac
        "windows" in p || "win32" in p -> Icons.Outlined.DesktopWindows
        !h.phosphorus -> Icons.Outlined.Router
        "linux" in p -> Icons.Outlined.Dns
        else -> Icons.Outlined.Computer
    }
}

fun platformLabel(h: Host): String = listOfNotNull(
    h.distro ?: h.platform?.replaceFirstChar { it.uppercase() } ?: h.os,
    h.arch,
).joinToString(" · ").ifEmpty { "Device" }

/** A ticking clock, so "stale" states update without new frames. */
@Composable
private fun now(): Long = produceState(System.currentTimeMillis()) {
    while (true) { delay(1000); value = System.currentTimeMillis() }
}.value

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DevicesScreen(nav: NavController) {
    val s = server
    val hosts by s.mesh.hosts.collectAsState()
    val stats by s.mesh.stats.collectAsState()
    val history by s.mesh.history.collectAsState()
    val state by s.mesh.state.collectAsState()
    val t = now()
    val online = hosts.count { it.online }
    val wide = LocalConfiguration.current.screenWidthDp >= 700

    Screen(
        title = "Devices",
        subtitle = (state?.domain ?: s.base.host) + if (hosts.isNotEmpty()) " · $online of ${hosts.size} online" else "",
        nav = nav,
        large = true,
    ) { pad ->
        if (state == null && hosts.isEmpty()) { Loading(); return@Screen }
        if (hosts.isEmpty()) {
            Empty(Icons.Outlined.Dns, "No devices yet", "Hosts appear here as they join your mesh.")
            return@Screen
        }
        LazyVerticalGrid(
            columns = if (wide) GridCells.Adaptive(340.dp) else GridCells.Fixed(1),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = pad.calculateTopPadding() + 4.dp, bottom = pad.calculateBottomPadding() + 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) { MeshSummary(hosts, stats, t) }
            items(hosts, key = { it.name }) { h ->
                val st = stats[h.name]?.takeIf { t - it.at < 6_000 || h.online }
                HostCard(h, st, history[h.name], t) { nav.navigate(Routes.device(h.name)) }
            }
        }
    }
}

@Composable
private fun MeshSummary(hosts: List<Host>, stats: Map<String, StatsSample>, now: Long) {
    val live = stats.values.filter { now - it.at < 6_000 }
    val cpu = if (live.isEmpty()) 0.0 else live.sumOf { it.cpu.total } / live.size
    val memUsed = live.sumOf { it.mem.used }
    val memTotal = live.sumOf { it.mem.total }
    val diskUsed = live.sumOf { it.disk.used }
    val diskTotal = live.sumOf { it.disk.total }
    val rx = live.sumOf { s -> s.net.sumOf { it.rx } }
    val tx = live.sumOf { s -> s.net.sumOf { it.tx } }
    Card(padding = PaddingValues(0.dp)) {
        Box(
            Modifier.fillMaxWidth().background(
                androidx.compose.ui.graphics.Brush.linearGradient(
                    listOf(Phos.colors.accent.copy(alpha = 0.18f), Phos.colors.blue.copy(alpha = 0.06f), Color.Transparent),
                ),
            ).padding(18.dp),
        ) {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Your mesh", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    Pill("${hosts.count { it.online }} online", Phos.colors.green)
                }
                Spacer(Modifier.height(16.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceAround) {
                    Ring((cpu / 100).toFloat(), loadColor(cpu), Format.pct(cpu), "CPU avg", size = 78.dp)
                    val mp = if (memTotal > 0) memUsed / memTotal * 100 else 0.0
                    Ring((mp / 100).toFloat(), Phos.colors.blue, Format.pct(mp), "Memory", size = 78.dp)
                    val dp = if (diskTotal > 0) diskUsed / diskTotal * 100 else 0.0
                    Ring((dp / 100).toFloat(), Phos.colors.teal, Format.pct(dp), "Storage", size = 78.dp)
                }
                Spacer(Modifier.height(14.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("${Format.bytes(memUsed)} of ${Format.bytes(memTotal)} RAM", style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted)
                    Text("↓ ${Format.rate(rx)}  ↑ ${Format.rate(tx)}", style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted)
                }
            }
        }
    }
}

@Composable
private fun HostCard(h: Host, st: StatsSample?, hist: History?, now: Long, onClick: () -> Unit) {
    val live = st != null && now - st.at < 6_000
    Card(onClick = onClick) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(44.dp).clip(RoundedCornerShape(12.dp))
                        .background((if (h.online) Phos.colors.accent else Phos.colors.dim).copy(alpha = 0.14f)),
                    contentAlignment = Alignment.Center,
                ) { Icon(hostIcon(h), null, tint = if (h.online) Phos.colors.accent else Phos.colors.dim) }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(h.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        Spacer(Modifier.width(8.dp))
                        StatusDot(h.online)
                        if (h.self) { Spacer(Modifier.width(8.dp)); Pill("serving", Phos.colors.blue) }
                    }
                    Text(
                        platformLabel(h) + (st?.uptime?.let { " · up " + Format.uptime(it) } ?: ""),
                        style = MaterialTheme.typography.bodySmall, color = Phos.colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (live && st != null) {
                Spacer(Modifier.height(14.dp))
                val memPct = if (st.mem.total > 0) st.mem.used / st.mem.total * 100 else 0.0
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    MiniStat("CPU", st.cpu.total, hist?.cpu.orEmpty(), loadColor(st.cpu.total), Modifier.weight(1f))
                    MiniStat("Memory", memPct, hist?.mem.orEmpty(), Phos.colors.blue, Modifier.weight(1f))
                }
            } else if (!h.online) {
                Spacer(Modifier.height(10.dp))
                Text(if (h.phosphorus) "Offline" else "On the mesh, without Phosphorus", style = MaterialTheme.typography.labelMedium, color = Phos.colors.dim)
            }
        }
    }
}

@Composable
private fun MiniStat(label: String, pct: Double, hist: List<Double>, color: Color, modifier: Modifier) {
    Column(modifier) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted, modifier = Modifier.weight(1f))
            Text(Format.pct(pct), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.height(6.dp))
        Sparkline(hist, color, Modifier.fillMaxWidth().height(28.dp), capacity = 60)
        Spacer(Modifier.height(4.dp))
        Meter((pct / 100).toFloat(), color)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DeviceScreen(nav: NavController, name: String) {
    val s = server
    val hosts by s.mesh.hosts.collectAsState()
    val stats by s.mesh.stats.collectAsState()
    val history by s.mesh.history.collectAsState()
    val me by s.mesh.me.collectAsState()
    val h = hosts.firstOrNull { it.name == name }
    val st = stats[name]
    val hist = history[name]
    val t = now()
    val live = st != null && t - st.at < 6_000

    Screen(title = name, subtitle = h?.let { platformLabel(it) }, nav = nav) { pad ->
        if (h == null) { Loading(); return@Screen }
        LazyColumn(
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = pad.calculateTopPadding() + 8.dp, bottom = pad.calculateBottomPadding() + 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Card {
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                Modifier.size(56.dp).clip(RoundedCornerShape(16.dp)).background(Phos.colors.accent.copy(alpha = 0.14f)),
                                contentAlignment = Alignment.Center,
                            ) { Icon(hostIcon(h), null, tint = Phos.colors.accent, modifier = Modifier.size(30.dp)) }
                            Spacer(Modifier.width(14.dp))
                            Column(Modifier.weight(1f)) {
                                Text(h.name, style = MaterialTheme.typography.titleLarge)
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    StatusDot(h.online)
                                    Spacer(Modifier.width(6.dp))
                                    Text(
                                        if (h.online) (st?.uptime?.let { "Up " + Format.uptime(it) } ?: "Online") else "Offline",
                                        style = MaterialTheme.typography.bodyMedium, color = Phos.colors.muted,
                                    )
                                }
                            }
                        }
                        if (h.online && h.phosphorus) {
                            Spacer(Modifier.height(16.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                FilledTonalButton(
                                    onClick = { openTerminal(nav, s, h.name, me) },
                                    modifier = Modifier.weight(1f),
                                ) { Icon(Icons.Outlined.Terminal, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Terminal") }
                                FilledTonalButton(
                                    onClick = { nav.navigate(Routes.files(h.name, "")) },
                                    modifier = Modifier.weight(1f),
                                ) { Icon(Icons.Outlined.Folder, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Files") }
                            }
                        }
                    }
                }
            }
            if (live && st != null) {
                item {
                    Card {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceAround) {
                            val mp = if (st.mem.total > 0) st.mem.used / st.mem.total * 100 else 0.0
                            val dp = if (st.disk.total > 0) st.disk.used / st.disk.total * 100 else 0.0
                            Ring((st.cpu.total / 100).toFloat(), loadColor(st.cpu.total), Format.pct(st.cpu.total), "CPU")
                            Ring((mp / 100).toFloat(), Phos.colors.blue, Format.pct(mp), "Memory")
                            Ring((dp / 100).toFloat(), Phos.colors.teal, Format.pct(dp), "Disk")
                        }
                    }
                }
                item { SectionLabel("Processor") }
                item {
                    Card {
                        Column {
                            st.cpu.model?.let { Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 2) }
                            val load = st.cpu.load.filterNotNull()
                            if (load.isNotEmpty()) Text(
                                "Load " + load.joinToString("  ") { "%.2f".format(it) },
                                style = MonoSmall, color = Phos.colors.muted, modifier = Modifier.padding(top = 4.dp),
                            )
                            Spacer(Modifier.height(12.dp))
                            Sparkline(hist?.cpu.orEmpty(), loadColor(st.cpu.total), Modifier.fillMaxWidth().height(64.dp), capacity = 120)
                            Text("Last 2 minutes", style = MaterialTheme.typography.labelSmall, color = Phos.colors.dim)
                            if (st.cpu.cores.isNotEmpty()) {
                                Spacer(Modifier.height(14.dp))
                                CoreBars(st.cpu.cores)
                            }
                        }
                    }
                }
                item { SectionLabel("Memory") }
                item {
                    Card {
                        Column {
                            val mp = if (st.mem.total > 0) st.mem.used / st.mem.total else 0.0
                            Row {
                                Text("${Format.bytes(st.mem.used)} used", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                                Text("of ${Format.bytes(st.mem.total)}", style = MaterialTheme.typography.bodyMedium, color = Phos.colors.muted)
                            }
                            Spacer(Modifier.height(8.dp))
                            Meter(mp.toFloat(), Phos.colors.blue)
                            Spacer(Modifier.height(10.dp))
                            Sparkline(hist?.mem.orEmpty(), Phos.colors.blue, Modifier.fillMaxWidth().height(48.dp), capacity = 120)
                            KeyValue("Available", Format.bytes(st.mem.avail))
                            KeyValue("Cached", Format.bytes(st.mem.cached))
                            if (st.mem.swapTotal > 0) KeyValue("Swap", "${Format.bytes(st.mem.swapUsed)} of ${Format.bytes(st.mem.swapTotal)}")
                        }
                    }
                }
                item { SectionLabel("Storage and network") }
                item {
                    Card {
                        Column {
                            val dp = if (st.disk.total > 0) st.disk.used / st.disk.total else 0.0
                            Row {
                                Text("${Format.bytes(st.disk.used)} used", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                                Text("of ${Format.bytes(st.disk.total)}", style = MaterialTheme.typography.bodyMedium, color = Phos.colors.muted)
                            }
                            Spacer(Modifier.height(8.dp))
                            Meter(dp.toFloat(), Phos.colors.teal)
                            st.io?.let { KeyValue("Disk I/O", "read ${Format.rate(it.r)} · write ${Format.rate(it.w)}") }
                            st.net.filter { it.rx > 0 || it.tx > 0 || st.net.size <= 3 }.forEach {
                                KeyValue(it.name, "↓ ${Format.rate(it.rx)}  ↑ ${Format.rate(it.tx)}", mono = true)
                            }
                            st.netDay?.let { KeyValue("Today", "↓ ${Format.bytes(it.rx)}  ↑ ${Format.bytes(it.tx)}") }
                        }
                    }
                }
                if (st.gpus.isNotEmpty()) {
                    item { SectionLabel("Graphics") }
                    items(st.gpus) { g ->
                        Card {
                            Column {
                                Text(g.name, style = MaterialTheme.typography.titleSmall)
                                g.util?.let {
                                    Spacer(Modifier.height(8.dp)); Meter((it / 100).toFloat(), Phos.colors.orange)
                                    KeyValue("Utilisation", Format.pct(it))
                                }
                                if (g.memTotal != null) KeyValue("Memory", "${Format.bytes(g.memUsed)} of ${Format.bytes(g.memTotal)}")
                                g.temp?.let { KeyValue("Temperature", "%.0f °C".format(it)) }
                            }
                        }
                    }
                }
                st.trend?.takeIf { it.cpu.size > 1 }?.let { tr ->
                    item { SectionLabel("Last 24 hours") }
                    item {
                        Card {
                            Column {
                                TrendRow("CPU", tr.cpu.map { it ?: 0.0 }, loadColor(tr.cpu.lastOrNull() ?: 0.0))
                                Spacer(Modifier.height(12.dp))
                                TrendRow("Memory", tr.mem.map { it ?: 0.0 }, Phos.colors.blue)
                                if (tr.rx.isNotEmpty()) {
                                    Spacer(Modifier.height(12.dp))
                                    val rx = tr.rx.map { it ?: 0.0 }
                                    TrendRow("Network in", rx, Phos.colors.teal, max = rx.maxOrNull() ?: 1.0, label = Format.bytes(rx.sum()))
                                }
                            }
                        }
                    }
                }
                st.procs?.takeIf { it.top.isNotEmpty() }?.let { p ->
                    item { SectionLabel("Top processes", trailing = { Text("${p.count} running", style = MaterialTheme.typography.labelMedium, color = Phos.colors.dim) }) }
                    item {
                        Card(padding = PaddingValues(vertical = 6.dp)) {
                            Column {
                                p.top.take(10).forEach { pr ->
                                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                        Column(Modifier.weight(1f)) {
                                            Text(pr.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                            Text("pid ${pr.pid}", style = MonoSmall, color = Phos.colors.dim)
                                        }
                                        Text("%.1f%%".format(pr.cpu), style = MonoSmall, color = loadColor(pr.cpu), modifier = Modifier.width(64.dp))
                                        Text(Format.bytes(pr.mem), style = MonoSmall, color = Phos.colors.muted, modifier = Modifier.width(76.dp))
                                    }
                                }
                            }
                        }
                    }
                }
            }
            item { SectionLabel("About") }
            item {
                Card {
                    Column {
                        h.version?.let { KeyValue("Phosphorus", it) }
                        KeyValue("Platform", platformLabel(h))
                        h.model?.let { KeyValue("Model", it) }
                        h.ip?.let { KeyValue("Address", it, mono = true) }
                        st?.cpu?.cores?.size?.takeIf { it > 0 }?.let { KeyValue("Cores", it.toString()) }
                        if (st != null) KeyValue("Last report", Format.agoLong(st.at))
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CoreBars(cores: List<Double>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        cores.forEach { c ->
            Box(Modifier.size(width = 14.dp, height = 30.dp).clip(RoundedCornerShape(3.dp)).background(Phos.colors.border)) {
                Box(
                    Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                        .height((30 * (c / 100).coerceIn(0.03, 1.0)).dp)
                        .background(loadColor(c)),
                )
            }
        }
    }
}

@Composable
private fun TrendRow(name: String, values: List<Double>, color: Color, max: Double = 100.0, label: String? = null) {
    Column {
        Row {
            Text(name, style = MaterialTheme.typography.labelMedium, color = Phos.colors.muted, modifier = Modifier.weight(1f))
            Text(label ?: ("peak " + Format.pct(values.maxOrNull() ?: 0.0)), style = MaterialTheme.typography.labelMedium, color = Phos.colors.dim)
        }
        Spacer(Modifier.height(4.dp))
        Sparkline(values, color, Modifier.fillMaxWidth().height(40.dp), max = max)
    }
}

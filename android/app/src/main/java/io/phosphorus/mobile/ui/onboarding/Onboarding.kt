package io.phosphorus.mobile.ui.onboarding

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.phosphorus.mobile.R
import io.phosphorus.mobile.data.ServerSession
import io.phosphorus.mobile.net.PhosClient
import io.phosphorus.mobile.net.PhosException
import io.phosphorus.mobile.ui.LocalGraph
import io.phosphorus.mobile.ui.common.PrimaryButton
import io.phosphorus.mobile.ui.theme.Phos
import kotlinx.coroutines.launch

/** The glowing mark at the top of the sign-in screens. */
@Composable
fun BrandMark(size: androidx.compose.ui.unit.Dp = 120.dp) {
    val pulse = rememberInfiniteTransition(label = "glow")
    val glow by pulse.animateFloat(0.35f, 0.7f, infiniteRepeatable(tween(2600, easing = LinearEasing), RepeatMode.Reverse), label = "glow")
    Box(contentAlignment = Alignment.Center) {
        Box(
            Modifier.size(size * 0.8f).alpha(glow).blur(40.dp).clip(androidx.compose.foundation.shape.CircleShape)
                .background(Brush.linearGradient(listOf(Color(0xFFF0883E), Color(0xFFA371F7)))),
        )
        Image(painterResource(R.drawable.ic_logo), contentDescription = null, modifier = Modifier.size(size))
    }
}

@Composable
private fun OnboardingFrame(content: @Composable () -> Unit) {
    Box(
        Modifier.fillMaxSize().background(
            Brush.verticalGradient(listOf(Phos.colors.accent.copy(alpha = 0.10f), Phos.colors.desk, Phos.colors.desk)),
        ).systemBarsPadding().imePadding(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier.widthIn(max = 440.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) { content() }
    }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedContainerColor = Phos.colors.card,
    unfocusedContainerColor = Phos.colors.card,
    unfocusedBorderColor = Phos.colors.border,
)

@Composable
fun ConnectScreen(initial: String?, onConnected: (ServerSession, Boolean, Boolean) -> Unit) {
    val graph = LocalGraph.current
    var address by remember { mutableStateOf(initial?.removePrefix("https://")?.trimEnd('/') ?: "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val url = PhosClient.normalize(address)
    val insecure = url?.isHttps == false

    fun go() {
        val u = url ?: run { error = "Enter your mesh's domain, like example.com"; return }
        busy = true; error = null
        scope.launch {
            val s = graph.open(u)
            try {
                val probe = s.mesh.probe()
                if (probe.signedIn) s.mesh.loadMe()
                onConnected(s, probe.signedIn, probe.setup)
            } catch (e: PhosException) {
                error = if (e.status == 0) "Can't reach ${u.host}. Check the domain and your connection.\n${e.message}" else e.message
            } finally {
                busy = false
            }
        }
    }

    OnboardingFrame {
        BrandMark()
        Spacer(Modifier.height(20.dp))
        Text("Phosphorus", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text(
            "Your terminals, files, git and chat, from every machine on your mesh.",
            style = MaterialTheme.typography.bodyLarge,
            color = Phos.colors.muted,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(36.dp))
        OutlinedTextField(
            value = address,
            onValueChange = { address = it.trim(); error = null },
            label = { Text("Your mesh's domain") },
            placeholder = { Text("example.com") },
            leadingIcon = { Icon(Icons.Outlined.Dns, null) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
            keyboardActions = KeyboardActions(onGo = { go() }),
            isError = error != null,
            shape = MaterialTheme.shapes.medium,
            colors = fieldColors(),
            modifier = Modifier.fillMaxWidth(),
        )
        AnimatedVisibility(insecure) {
            Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.WarningAmber, null, tint = Phos.colors.amber, modifier = Modifier.size(18.dp))
                Spacer(Modifier.size(8.dp))
                Text(
                    "Plain http: your password and session travel unencrypted. Use only on a network you trust.",
                    style = MaterialTheme.typography.bodySmall, color = Phos.colors.amber,
                )
            }
        }
        AnimatedVisibility(error != null) {
            Text(error.orEmpty(), color = Phos.colors.red, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth().padding(top = 10.dp))
        }
        Spacer(Modifier.height(20.dp))
        PrimaryButton("Continue", onClick = ::go, enabled = address.isNotBlank(), busy = busy)
        Spacer(Modifier.height(20.dp))
        Text(
            "This is the domain set in Settings › Domain on your Phosphorus desktop.",
            style = MaterialTheme.typography.bodySmall,
            color = Phos.colors.dim,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
fun LoginScreen(server: ServerSession, setup: Boolean, onSignedIn: () -> Unit, onChangeServer: () -> Unit) {
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var show by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val passFocus = remember { FocusRequester() }
    val uri = LocalUriHandler.current

    fun go() {
        if (user.isBlank() || pass.isEmpty()) return
        busy = true; error = null
        scope.launch {
            try {
                server.mesh.login(user, pass)
                onSignedIn()
            } catch (e: PhosException) {
                error = if (e.status == 0) "Can't reach ${server.base.host}" else e.message
            } finally {
                busy = false
            }
        }
    }

    OnboardingFrame {
        BrandMark(96.dp)
        Spacer(Modifier.height(16.dp))
        Text("Sign in", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text(server.base.host, style = MaterialTheme.typography.bodyLarge, color = Phos.colors.accent)
        Spacer(Modifier.height(32.dp))
        if (setup) {
            Text(
                "This mesh has no admin yet. Finish setting it up in a browser first, then sign in here.",
                style = MaterialTheme.typography.bodyMedium, color = Phos.colors.muted, textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(16.dp))
            PrimaryButton("Open setup in the browser", onClick = { uri.openUri(server.base.toString()) })
            Spacer(Modifier.height(24.dp))
        }
        OutlinedTextField(
            value = user,
            onValueChange = { user = it; error = null },
            label = { Text("User") },
            leadingIcon = { Icon(Icons.Outlined.Person, null) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Next, autoCorrectEnabled = false),
            keyboardActions = KeyboardActions(onNext = { passFocus.requestFocus() }),
            shape = MaterialTheme.shapes.medium,
            colors = fieldColors(),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = pass,
            onValueChange = { pass = it; error = null },
            label = { Text("Password") },
            leadingIcon = { Icon(Icons.Outlined.Lock, null) },
            trailingIcon = {
                IconButton(onClick = { show = !show }) {
                    Icon(if (show) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (show) "Hide password" else "Show password")
                }
            },
            visualTransformation = if (show) VisualTransformation.None else PasswordVisualTransformation(),
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { go() }),
            isError = error != null,
            shape = MaterialTheme.shapes.medium,
            colors = fieldColors(),
            modifier = Modifier.fillMaxWidth().focusRequester(passFocus),
        )
        AnimatedVisibility(error != null) {
            Text(error.orEmpty(), color = Phos.colors.red, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth().padding(top = 10.dp))
        }
        Spacer(Modifier.height(24.dp))
        PrimaryButton("Sign in", onClick = ::go, enabled = user.isNotBlank() && pass.isNotEmpty(), busy = busy)
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.Center, modifier = Modifier.fillMaxWidth()) {
            TextButton(onClick = onChangeServer) { Text("Use a different mesh") }
        }
    }
}

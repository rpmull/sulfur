package io.phosphorus.mobile.ui.common

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException

/** Data a screen fetches once and can refresh, keeping what it showed while refreshing. */
@Stable
class Load<T>(private val trigger: MutableState<Int>) {
    var value by mutableStateOf<T?>(null)
        internal set
    var error by mutableStateOf<Throwable?>(null)
        internal set
    var loading by mutableStateOf(true)
        internal set

    fun reload() { trigger.value++ }
}

@Composable
fun <T> rememberLoad(vararg keys: Any?, fetch: suspend () -> T): Load<T> {
    val trigger = remember(*keys) { mutableStateOf(0) }
    val load = remember(*keys) { Load<T>(trigger) }
    LaunchedEffect(load, trigger.value) {
        load.loading = true
        try {
            load.value = fetch()
            load.error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            load.error = e
        } finally {
            load.loading = false
        }
    }
    return load
}


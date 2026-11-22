package io.phosphorus.mobile.net

import kotlinx.serialization.decodeFromString
import io.phosphorus.mobile.data.SessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

val PhosJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    isLenient = true
    encodeDefaults = true
}

/** A failed call: [status] 0 for no answer at all (offline, DNS, TLS). */
class PhosException(val status: Int, message: String, val body: String? = null) : IOException(message) {
    val unauthorized get() = status == 401
}

/**
 * One client per server. Phosphorus authenticates every API with its `phosphorus-user`
 * session cookie (domain-wide, so git.<domain> and chat.<domain> share it) and checks Origin,
 * not CSRF tokens: OkHttp sends no Origin, which the server accepts.
 */
class PhosClient(val base: HttpUrl, val session: SessionStore) {

    val http: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(session)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    val domain: String get() = base.host

    fun url(path: String): HttpUrl {
        val p = path.removePrefix("/")
        return (base.toString().trimEnd('/') + "/" + p).toHttpUrlOrNull()
            ?: throw PhosException(0, "bad path $path")
    }

    fun ws(path: String): String = url(path).toString().replaceFirst("http", "ws")

    suspend fun get(path: String): String = call(Request.Builder().url(url(path)).get().build())

    suspend fun getBytes(path: String): ByteArray = withContext(Dispatchers.IO) {
        execute(Request.Builder().url(url(path)).get().build()).use { r ->
            if (!r.isSuccessful) throw error(r)
            r.body?.bytes() ?: ByteArray(0)
        }
    }

    suspend fun post(path: String, json: String = "{}"): String =
        call(Request.Builder().url(url(path)).post(json.toRequestBody(JSON)).build())

    suspend fun post(path: String, body: RequestBody): String =
        call(Request.Builder().url(url(path)).post(body).build())

    suspend fun put(path: String, body: RequestBody): String =
        call(Request.Builder().url(url(path)).put(body).build())

    suspend fun delete(path: String): String =
        call(Request.Builder().url(url(path)).delete().build())

    suspend inline fun <reified T> getJson(path: String): T = PhosJson.decodeFromString(get(path))

    suspend inline fun <reified T> postJson(path: String, body: JsonElement): T =
        PhosJson.decodeFromString(post(path, body.toString()))

    /** Status and body, without treating an error status as a failure. */
    suspend fun raw(path: String): Pair<Int, String> = withContext(Dispatchers.IO) {
        execute(Request.Builder().url(url(path)).get().build()).use { r -> r.code to (r.body?.string().orEmpty()) }
    }

    suspend fun call(req: Request): String = withContext(Dispatchers.IO) {
        execute(req).use { r ->
            val text = r.body?.string().orEmpty()
            if (!r.isSuccessful) throw error(r, text)
            text
        }
    }

    private suspend fun execute(req: Request): Response = suspendCancellableCoroutine { cont ->
        val call = http.newCall(req)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                cont.resumeWithException(PhosException(0, e.message ?: "can't reach ${req.url.host}"))
            }
            override fun onResponse(call: Call, response: Response) {
                cont.resume(response) { _, r, _ -> r.close() }
            }
        })
    }

    fun socket(path: String, listener: WebSocketListener): WebSocket =
        http.newWebSocket(Request.Builder().url(ws(path)).build(), listener)

    private fun error(r: Response, text: String = runCatching { r.body?.string() }.getOrNull().orEmpty()): PhosException {
        val msg = runCatching {
            PhosJson.parseToJsonElement(text).jsonObject["error"]?.jsonPrimitive?.contentOrNull
        }.getOrNull() ?: text.take(200).ifBlank { "HTTP ${r.code}" }
        return PhosException(r.code, msg, text)
    }

    companion object {
        val JSON = "application/json".toMediaType()

        /**
         * Turns what someone types ("philab.io", "https://philab.io/", "10.0.0.5:8443") into the
         * desktop's origin. https unless http is typed; any path is dropped.
         */
        fun normalize(input: String): HttpUrl? {
            var s = input.trim().trimEnd('/')
            if (s.isEmpty()) return null
            if (!s.contains("://")) s = "https://$s"
            val u = s.toHttpUrlOrNull() ?: return null
            if (u.host.isBlank()) return null
            return u.newBuilder().encodedPath("/").query(null).fragment(null).build()
        }
    }
}

fun JsonObject.str(key: String): String? = this[key]?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }

package ai.namastex.automagik

import android.app.Activity
import android.app.Instrumentation
import android.app.Instrumentation.ActivityResult
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.Intents.intended
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.anyIntent
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.FixMethodOrder
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest
import java.util.UUID
import java.util.regex.Pattern

/** APK-local provider: the app reads these bytes through ContentResolver, as it does a picker result. */
class FixtureDocumentProvider : ContentProvider() {
    override fun onCreate() = true
    override fun getType(uri: Uri): String? = when (uri.getQueryParameter("mime")) {
        "txt" -> "text/plain"
        "pdf" -> "application/pdf"
        "html" -> "text/html"
        else -> null
    }
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?,
                       selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val columns = (projection?.toList() ?: listOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).toTypedArray()
        return MatrixCursor(columns).apply {
            addRow(columns.map { column -> when (column) {
                OpenableColumns.DISPLAY_NAME -> uri.getQueryParameter("name")
                OpenableColumns.SIZE -> File(requireNotNull(context).applicationContext.filesDir, requireNotNull(uri.lastPathSegment)).length()
                else -> null
            } }.toTypedArray())
        }
    }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(File(requireNotNull(context).applicationContext.filesDir, requireNotNull(uri.lastPathSegment)), ParcelFileDescriptor.MODE_READ_ONLY)
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}

/** E1-E6 run against installed Pocket, the real chat UI, D4c bridge and D4b socket. */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class AttachDocumentDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val app = ApplicationProvider.getApplicationContext<PocketApplication>()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val testContext get() = instrumentation.context
    private val vm get() = app.vm
    private val ref = TerminalRef("verify", "dsh:b-aaaaaaaaaa")
    private val created = mutableListOf<File>()
    private val media = mutableListOf<Uri>()
    private var port = 47110

    @Before fun setUp() {
        port = 47110
        control("reset")
        Intents.init()
        compose.runOnIdle {
            vm.closeChat()
            vm.chatOpenerAttach = { _, scope, manage, attachments, lost ->
                withContext(Dispatchers.IO) {
                    val socket = Socket().apply { connect(InetSocketAddress("10.0.2.2", this@AttachDocumentDeviceTest.port), 10_000) }
                    try { PocketLinkChat(ChatClient.start(CoreClient(socket.getInputStream(), socket.getOutputStream(), socket, scope, lost), manage, attachments, true)) }
                    catch (error: Exception) { socket.close(); throw error }
                }
            }
        }
        compose.setContent { ChatPane(vm, ref, null, {}) }
        awaitUi("document-capable chat to show Add images or files") {
            docs()
        }
        awaitUi("document-capable peer and live chat watch") {
            val state = vm.attachments.state.value
            (state.peer as? Attach.Peer.Offered)?.offer?.documents != null &&
                state.watchGen != 0L && vm.attachments.live(state.watchGen)
        }
    }

    @After fun tearDown() {
        compose.runOnIdle { vm.closeChat(); vm.chatOpenerAttach = null }
        Intents.release()
        created.forEach { it.delete() }
        media.forEach { app.contentResolver.delete(it, null, null) }
    }

    private fun control(cmd: String, expected: JSONArray? = null, fields: JSONObject? = null): JSONObject = Socket().use { socket ->
        socket.connect(InetSocketAddress("10.0.2.2", 47115), 10_000)
        socket.soTimeout = 10_000
        val request = JSONObject().put("cmd", cmd)
        if (expected != null) request.put("expected", expected)
        if (fields != null) fields.keys().forEach { key -> request.put(key, fields.get(key)) }
        socket.getOutputStream().write((request.toString() + "\n").toByteArray())
        JSONObject(socket.getInputStream().bufferedReader().readLine() ?: error("control closed"))
    }
    private fun counts() = control("counts")
    private fun committed() = counts().getJSONObject("committed").getJSONArray("a")
    private fun sent(id: String) = instrumentation.sendStatus(0, Bundle().apply {
        putString(Instrumentation.REPORT_KEY_STREAMRESULT, "ASSERT:$id PASS\n")
    })
    private fun notice(part: String) = compose.onAllNodesWithText(part, substring = true).fetchSemanticsNodes().isNotEmpty()
    private fun docs() = compose.onAllNodesWithContentDescription("Add images or files").fetchSemanticsNodes().isNotEmpty()
    private fun imageButton() = compose.onAllNodesWithContentDescription("Add images").fetchSemanticsNodes().isNotEmpty()
    private fun safe(value: String) = value
        .replace(Regex("rfc0033-[A-Za-z0-9._-]+|notes-café\\.txt|fixture-[A-Za-z0-9._-]+|Fixture caption|Fixture Bot"), "<fixture>")
        .replace(Regex("Line with café|picker round trip|retry café|not a PDF|<p>markup</p>|withdraw"), "<fixture-content>")
        .replace(Regex("content://[^\\s|]+"), "<content-uri>")
    private fun observedUi(): String {
        val visible = SemanticsMatcher.keyIsDefined(SemanticsProperties.Text) or
            SemanticsMatcher.keyIsDefined(SemanticsProperties.ContentDescription)
        return compose.onAllNodes(visible).fetchSemanticsNodes().flatMap { node ->
            node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text } +
                node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty()
        }.distinct().take(30).joinToString(" | ") { safe(it) }.ifBlank { "<no text>" }
    }
    private fun observed(): String {
        val state = vm.attachments.state.value
        val chat = vm.chat.value
        val peer = state.peer
        return "peer=${peer.javaClass.simpleName}, offer.documents null=" +
            "${(peer as? Attach.Peer.Offered)?.offer?.documents == null}, " +
            "watchGen=${state.watchGen}, live=${vm.attachments.live(state.watchGen)}, " +
            "chat.connected=${chat?.connected}, chat.error=${chat?.error?.let(::safe)}, " +
            "draft=${state.draft.size}, pendingPick=${state.pendingPick != null}, " +
            "waiting=${state.waiting != null}, preparing=${state.preparing}, UI=${observedUi()}"
    }
    private fun awaitUi(expected: String, timeout: Long = 30_000, condition: () -> Boolean) {
        try { compose.waitUntil(timeout, condition) }
        catch (error: ComposeTimeoutException) {
            throw AssertionError("Expected $expected within ${timeout}ms; observed ${observed()}", error)
        }
    }
    private fun fixture(name: String, mime: String, bytes: ByteArray): Uri {
        val id = UUID.randomUUID().toString()
        val file = File(app.filesDir, id)
        file.writeBytes(bytes)
        created += file
        return Uri.parse("content://ai.namastex.automagik.test.documents/$id").buildUpon()
            .appendQueryParameter("name", name).appendQueryParameter("mime", mime).build()
    }
    private fun pick(kind: AttachmentKind, vararg uris: Uri) {
        val before = vm.attachments.state.value.draft.size
        val token = vm.attachments.pick(kind)?.token ?: error("pick unavailable")
        deliverAttachPick(vm.attachments, kind, token, uris.toList())
        awaitUi("draft size ${before + uris.size}") { vm.attachments.state.value.draft.size == before + uris.size }
    }
    private fun image(): Uri {
        val bitmap = Bitmap.createBitmap(64, 48, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(24, 80, 160)) }
        val uri = app.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "rfc0033-doc-image.png")
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        })!!
        app.contentResolver.openOutputStream(uri)!!.use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        bitmap.recycle()
        media += uri
        return uri
    }
    private fun send(caption: String? = null) {
        if (caption != null) compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput(caption)
        compose.onNodeWithContentDescription("Send message").performClick()
    }
    private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun expected(vararg files: Triple<ByteArray, String, Int>): JSONArray = JSONArray().apply {
        files.forEach { (bytes, name, size) -> put(JSONObject().put("digest", digest(bytes)).put("name", name).put("size", size)) }
    }
    private fun types(row: JSONObject): List<String> {
        val array = row.getJSONArray("contentTypes")
        return (0 until array.length()).map(array::getString)
    }
    private fun awaitOne(before: Int) = awaitUi("one committed message and Sent", 90_000) {
        committed().length() == before + 1 && notice("Sent")
    }

    @Test fun a_E1_mixedImageTxtPdfCaptionAndStoredBytes() {
        assertTrue(docs())
        val txt = "\uFEFFLine with café\n".toByteArray(Charsets.UTF_8)
        val pdf = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n".toByteArray(Charsets.US_ASCII)
        val txtUri = fixture("folder\\notes-café.txt", "txt", txt)
        val pdfUri = fixture("rfc0033-doc-report.pdf", "pdf", pdf)
        val before = committed().length()
        val ingressBefore = counts().getJSONObject("ingress")
        val readBefore = ingressBefore.getInt("attachmentRead")
        pick(AttachmentKind.IMAGE, image())
        pick(AttachmentKind.DOCUMENT, txtUri, pdfUri)
        send("rfc0033-doc-caption")
        awaitOne(before)
        val after = counts()
        assertEquals(ingressBefore.getInt("image") + 1, after.getJSONObject("ingress").getInt("image"))
        assertEquals(ingressBefore.getInt("document") + 2, after.getJSONObject("ingress").getInt("document"))
        val row = committed().getJSONObject(before)
        assertEquals(listOf("text", "image", "file", "file"), types(row))
        assertTrue(control("verifyRow", fields = JSONObject().put("text", "rfc0033-doc-caption")
            .put("types", JSONArray(listOf("text", "image", "file", "file")))
            .put("files", JSONArray().put(JSONObject().put("name", "notes-café.txt").put("size", txt.size))
                .put(JSONObject().put("name", "rfc0033-doc-report.pdf").put("size", pdf.size)))).getBoolean("ok"))
        assertEquals(listOf("text", "file", "file", "file"), types(after.getJSONArray("prompts").getJSONObject(after.getJSONArray("prompts").length() - 1)))
        assertTrue(control("verifyFiles", expected(Triple(txt, "notes-café.txt", txt.size), Triple(pdf, "rfc0033-doc-report.pdf", pdf.size))).getBoolean("ok"))
        awaitUi("both files to appear on the computer") {
            notice("File · notes-café.txt · ${txt.size} B · on the computer") &&
                notice("File · rfc0033-doc-report.pdf · ${pdf.size} B · on the computer")
        }
        assertEquals(readBefore, counts().getJSONObject("ingress").getInt("attachmentRead"))
        sent("E1")
    }

    @Test fun b_E2_localRefusalsNeverReachBridgeIngress() {
        assertTrue(docs())
        val bad = listOf(
            fixture("rfc0033-doc-nul.txt", "txt", byteArrayOf(65, 0, 66)),
            fixture("rfc0033-doc-bad.pdf", "pdf", "not a PDF".toByteArray()),
            fixture("rfc0033-doc-html.txt", "html", "<p>markup</p>".toByteArray())
        )
        val before = counts().getJSONObject("ingress").getInt("document")
        bad.forEachIndexed { index, uri ->
            val token = vm.attachments.pick(AttachmentKind.DOCUMENT)?.token ?: error("pick unavailable")
            deliverAttachPick(vm.attachments, AttachmentKind.DOCUMENT, token, listOf(uri))
            awaitUi("invalid document pick to finish and show a refusal") {
                val state = vm.attachments.state.value
                state.pendingPick == null && state.waiting == null && state.preparing == 0 &&
                    notice(if (index == 2) "Pick a TXT or PDF" else "valid TXT/PDF")
            }
            assertEquals(before, counts().getJSONObject("ingress").getInt("document"))
            assertTrue(vm.attachments.state.value.draft.isEmpty())
        }
        sent("E2")
    }

    @Test fun c_E3_documentRetryAfterLostSendAckCommitsOnce() {
        val bytes = "retry café\n".toByteArray(Charsets.UTF_8)
        val before = committed().length()
        val beginsBefore = counts().getJSONArray("uploadBegins").length()
        control("dropAfterAccept")
        pick(AttachmentKind.DOCUMENT, fixture("rfc0033-doc-retry.txt", "txt", bytes))
        send()
        awaitUi("Maybe not sent after the lost acknowledgement", 90_000) { notice("Maybe not sent") }
        compose.onNodeWithText("Reconnect").performClick()
        awaitUi("Retry after reconnect") { notice("Retry") }
        compose.onNodeWithText("Retry").performClick()
        awaitOne(before)
        val after = counts()
        val prompts = after.getJSONArray("prompts")
        val first = prompts.getJSONObject(prompts.length() - 2)
        val second = prompts.getJSONObject(prompts.length() - 1)
        assertEquals(first.getString("requestId"), second.getString("requestId"))
        assertTrue(second.getBoolean("repeatsContent"))
        assertEquals(first.getString("requestId"), committed().getJSONObject(before).getString("id"))
        assertEquals(before + 1, committed().length())
        assertEquals(beginsBefore + 1, after.getJSONArray("uploadBegins").length())
        sent("E3")
    }

    @Test fun d_E4_imagesOnlyPeerOpensPhotoPickerDirectly() {
        port = 47114
        compose.runOnIdle { vm.reconnectChat() }
        awaitUi("images-only peer and live chat watch") {
            val state = vm.attachments.state.value
            imageButton() && vm.attachments.live(state.watchGen)
        }
        assertFalse(docs())
        val before = committed().length()
        val imageBefore = counts().getJSONObject("ingress").getInt("image")
        val photo = image()
        intending(anyIntent()).respondWith(ActivityResult(Activity.RESULT_OK, Intent().setData(photo)))
        compose.onNodeWithContentDescription("Add images").performClick()
        intended(anyIntent())
        awaitUi("one selected attachment in the draft") { vm.attachments.state.value.draft.size == 1 }
        assertTrue(compose.onAllNodesWithContentDescription("Selected image").fetchSemanticsNodes().isNotEmpty())
        send()
        awaitOne(before)
        assertEquals(listOf("image"), types(committed().getJSONObject(before)))
        assertEquals(imageBefore + 1, counts().getJSONObject("ingress").getInt("image"))
        sent("E4")
    }

    @Test fun z_E5_fileRefusalWithdrawsFilesButKeepsImages() {
        assertTrue(docs())
        val before = committed().length()
        val ingressBefore = counts().getJSONObject("ingress")
        control("refuseFiles")
        pick(AttachmentKind.DOCUMENT, fixture("rfc0033-doc-withdraw.txt", "txt", "withdraw\n".toByteArray()))
        send()
        awaitUi("file refusal and images-only button", 90_000) { notice("computer doesn't take files") && imageButton() }
        assertFalse(docs())
        val photo = image()
        intending(anyIntent()).respondWith(ActivityResult(Activity.RESULT_OK, Intent().setData(photo)))
        compose.onNodeWithContentDescription("Add images").performClick()
        intended(anyIntent())
        awaitUi("one selected attachment in the draft") { vm.attachments.state.value.draft.size == 1 }
        send()
        awaitOne(before)
        assertEquals(listOf("image"), types(committed().getJSONObject(before)))
        assertEquals(ingressBefore.getInt("image") + 1, counts().getJSONObject("ingress").getInt("image"))
        assertEquals(ingressBefore.getInt("document") + 1, counts().getJSONObject("ingress").getInt("document"))
        sent("E5")
    }

    @Test fun f_E6_realDocumentsUiRoundTrip() {
        if (Build.VERSION.SDK_INT < 29) {
            instrumentation.sendStatus(0, Bundle().apply { putString(Instrumentation.REPORT_KEY_STREAMRESULT, "ASSERT:E6 NOT AUTOMATED DocumentsUI fixture publishing needs API 29\n") })
            return
        }
        val name = "rfc0033-doc-picker-${UUID.randomUUID()}.txt"
        val uri = runCatching {
            app.contentResolver.insert(Uri.parse("content://media/external/downloads"), ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, "text/plain")
                put("relative_path", "Download/")
            })
        }.getOrNull()
        if (uri == null) {
            instrumentation.sendStatus(0, Bundle().apply { putString(Instrumentation.REPORT_KEY_STREAMRESULT, "ASSERT:E6 NOT AUTOMATED Downloads insertion unavailable\n") })
            return
        }
        media += uri
        val published = runCatching { app.contentResolver.openOutputStream(uri)!!.use { it.write("picker round trip\n".toByteArray()) } }.isSuccess
        if (!published) {
            instrumentation.sendStatus(0, Bundle().apply { putString(Instrumentation.REPORT_KEY_STREAMRESULT, "ASSERT:E6 NOT AUTOMATED Downloads stream unavailable\n") })
            return
        }
        compose.onNodeWithContentDescription("Add images or files").performClick()
        compose.onNodeWithText("Files").performClick()
        intended(hasAction(Intent.ACTION_OPEN_DOCUMENT))
        val device = UiDevice.getInstance(instrumentation)
        val picker = By.pkg(Pattern.compile(".*documentsui.*"))
        val found = device.wait(Until.hasObject(picker), 20_000)
        var tile = if (found) device.wait(Until.findObject(By.text(name)), 10_000) else null
        if (found && tile == null) {
            device.findObject(By.text("Downloads"))?.click()
            tile = device.wait(Until.findObject(By.text(name)), 10_000)
        }
        if (tile == null) {
            device.pressBack()
            instrumentation.sendStatus(0, Bundle().apply { putString(Instrumentation.REPORT_KEY_STREAMRESULT, "ASSERT:E6 NOT AUTOMATED DocumentsUI did not expose the Downloads fixture\n") })
            return
        }
        val before = committed().length()
        tile.click()
        awaitUi("DocumentsUI selection to return one file") { vm.attachments.state.value.draft.size == 1 }
        send()
        awaitOne(before)
        assertEquals(listOf("file"), types(committed().getJSONObject(before)))
        sent("E6")
    }
}

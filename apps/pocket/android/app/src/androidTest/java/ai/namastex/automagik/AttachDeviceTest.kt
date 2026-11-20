package ai.namastex.automagik

import android.app.Activity
import android.app.Instrumentation
import android.app.Instrumentation.ActivityResult
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
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
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.anyIntent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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

/** Disposable UI acceptance. Every send goes through ChatPane and the real PocketViewModel. */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class AttachDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val app = ApplicationProvider.getApplicationContext<PocketApplication>()
    private lateinit var vm: PocketViewModel
    private val ref = TerminalRef("verify", "dsh:b-aaaaaaaaaa")
    private val pictures = mutableListOf<Uri>()
    private var port = 47114

    @Before fun setUp() {
        vm = app.vm
        port = 47114
        control("reset")
        Intents.init()
        compose.runOnIdle {
            vm.closeChat()
            vm.chatOpenerAttach = { _, scope, manage, attachments, lost ->
                withContext(Dispatchers.IO) {
                    val socket = open(port)
                    try {
                        PocketLinkChat(ChatClient.start(CoreClient(socket.getInputStream(), socket.getOutputStream(), socket, scope, lost), manage, attachments))
                    } catch (error: Exception) { socket.close(); throw error }
                }
            }
        }
    }

    @After fun tearDown() {
        compose.runOnIdle { vm.closeChat(); vm.chatOpenerAttach = null }
        Intents.release()
        pictures.forEach { app.contentResolver.delete(it, null, null) }
        pictures.clear()
    }

    private fun open(which: Int, readTimeout: Int = 0) = Socket().apply {
        connect(InetSocketAddress("10.0.2.2", which), 10_000)
        soTimeout = readTimeout
    }
    private fun control(command: String, extra: String = "", delayMs: Int? = null): JSONObject = open(47115, 10_000).use { socket ->
        val request = JSONObject().put("cmd", command)
        if (extra.isNotEmpty()) request.put("upload", extra)
        if (delayMs != null) request.put("ms", delayMs)
        socket.getOutputStream().write((request.toString() + "\n").toByteArray())
        JSONObject(socket.getInputStream().bufferedReader().readLine() ?: error("control closed"))
    }
    private fun counts() = control("counts")
    private fun messages(snapshot: JSONObject, session: String) = snapshot.getJSONObject("committed").getJSONArray(session)
    private fun prompts(snapshot: JSONObject) = snapshot.getJSONArray("prompts")
    private fun count(snapshot: JSONObject, key: String) = snapshot.getJSONArray(key).length()
    private fun case(id: String) {
        InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
            putString(Instrumentation.REPORT_KEY_STREAMRESULT, "ASSERT:$id PASS\n")
        })
    }
    private fun await(timeout: Long = 30_000, condition: () -> Boolean) = compose.waitUntil(timeout, condition)
    private fun text(value: String) = compose.onAllNodesWithText(value, substring = true).fetchSemanticsNodes().isNotEmpty()
    private fun label(value: String) = compose.onAllNodesWithText(value).fetchSemanticsNodes().isNotEmpty()
    private fun observedUi(): String {
        val textOrDescription = SemanticsMatcher.keyIsDefined(SemanticsProperties.Text) or
            SemanticsMatcher.keyIsDefined(SemanticsProperties.ContentDescription)
        return compose.onAllNodes(textOrDescription).fetchSemanticsNodes().flatMap { node ->
            node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text } +
                node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty()
        }.distinct().take(30).joinToString(" | ") {
            it.replace(Regex("rfc0033-[A-Za-z0-9._-]+|fixture-[A-Za-z0-9._-]+|Fixture caption|Fixture Bot"), "<fixture>")
        }.ifBlank { "<no text>" }
    }
    private fun observed(): String {
        val state = vm.attachments.state.value
        val peer = state.peer
        val chat = vm.chat.value
        return "peer=${peer.javaClass.simpleName}, offer.documents null=" +
            "${(peer as? Attach.Peer.Offered)?.offer?.documents == null}, " +
            "watchGen=${state.watchGen}, live=${vm.attachments.live(state.watchGen)}, " +
            "chat.connected=${chat?.connected}, chat.error=${chat?.error?.replace(Regex("rfc0033-[A-Za-z0-9._-]+|fixture-[A-Za-z0-9._-]+"), "<fixture>")}, UI=${observedUi()}"
    }
    private fun awaitUi(expected: String, timeout: Long = 30_000, condition: () -> Boolean) {
        try {
            await(timeout, condition)
        } catch (error: ComposeTimeoutException) {
            throw AssertionError("Expected $expected within ${timeout}ms. Observed ${observed()}", error)
        }
    }
    private fun assertUi(expected: String, condition: Boolean) {
        if (!condition) throw AssertionError("Expected $expected. Observed ${observed()}")
    }
    private fun reconnect(case: String) {
        awaitUi("$case to show Reconnect after the TCP drop") { label("Reconnect") }
        compose.onNodeWithText("Reconnect").performClick()
    }
    private fun show() {
        compose.setContent { ChatPane(vm, ref, null, {}) }
        awaitUi("images-only chat to show Add images") {
            compose.onAllNodesWithContentDescription("Add images").fetchSemanticsNodes().isNotEmpty()
        }
    }
    private fun fixture(noisy: Boolean = false): Uri {
        val bitmap = Bitmap.createBitmap(if (noisy) 1024 else 64, if (noisy) 1024 else 48, Bitmap.Config.ARGB_8888)
        for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
            val shade = if (noisy) ((x * 1103515245L + y * 12345L) ushr 13).toInt() else x * 3 + y
            bitmap.setPixel(x, y, Color.rgb(shade and 255, shade ushr 8 and 255, shade ushr 16 and 255))
        }
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "rfc0033-fixture-${System.nanoTime()}.png")
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        }
        val uri = app.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
        app.contentResolver.openOutputStream(uri)!!.use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        bitmap.recycle()
        pictures += uri
        return uri
    }
    private fun add(vararg uris: Uri) {
        val answer = Intent()
        if (uris.size == 1) answer.data = uris[0]
        else answer.clipData = ClipData.newUri(app.contentResolver, "synthetic images", uris[0]).also { clip ->
            uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
        }
        intending(anyIntent()).respondWith(ActivityResult(Activity.RESULT_OK, answer))
        compose.onNodeWithContentDescription("Add images").performClick()
        awaitUi("selected image count ${uris.size}") { compose.onAllNodesWithContentDescription("Selected image").fetchSemanticsNodes().size >= uris.size }
    }
    private fun send(caption: String? = null) {
        if (caption != null) compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput(caption)
        compose.onNodeWithContentDescription("Send message").performClick()
    }
    private fun deltas(before: JSONObject, after: JSONObject, session: String) =
        messages(after, session).length() - messages(before, session).length()
    private fun content(array: org.json.JSONArray, index: Int): List<String> {
        val items = array.getJSONObject(index).getJSONArray("contentTypes")
        return (0 until items.length()).map { items.getString(it) }
    }
    private fun noStoredImage() {
        val roots = listOf(app.filesDir, app.noBackupFilesDir, app.cacheDir)
        val magic = listOf(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47), byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte()))
        val stored = roots.flatMap { root -> root.walkTopDown().filter { it.isFile }.toList() }.any { file ->
            val head = runCatching { file.inputStream().use { it.readNBytes(4) } }.getOrNull() ?: return@any false
            magic.any { signature -> head.take(signature.size) == signature.toList() }
        }
        assertFalse("image bytes entered private app storage", stored)
    }

    @Test fun a_D1_twoImagesWithCaptionProgressAndOneRichRow() {
        control("slowChunks"); show(); val before = counts()
        add(fixture(), fixture()); send("fixture-caption-d1")
        awaitUi("Uploading notice") { text("Uploading") }
        awaitUi("upload progress above zero") { vm.attachments.state.value.messages.any { it.phase == Phase.UPLOADING && it.progress > 0f } }
        awaitUi("one committed message in Session a and Sent", 90_000) { deltas(before, counts(), "a") == 1 && text("Sent") }
        val after = counts()
        assertEquals(1, prompts(after).length() - prompts(before).length())
        assertEquals(listOf("text", "file", "file"), content(prompts(after), prompts(after).length() - 1))
        assertEquals(listOf("text", "image", "image"), content(messages(after, "a"), messages(after, "a").length() - 1))
        awaitUi("two image receipts") { compose.onAllNodesWithText("Image ·", substring = true).fetchSemanticsNodes().size >= 2 }
        assertTrue(vm.chat.value!!.rows.any { it.blocks?.count { block -> block is Attach.Block.Image } == 2 })
        noStoredImage(); case("D1")
    }

    @Test fun b_D2_imageOnlyNoEmptyTextBubble() {
        show(); val before = counts(); add(fixture()); send()
        awaitUi("one committed message in Session a and Sent", 90_000) { deltas(before, counts(), "a") == 1 && text("Sent") }
        val after = counts()
        assertEquals(listOf("file"), content(prompts(after), prompts(after).length() - 1))
        assertEquals(listOf("image"), content(messages(after, "a"), messages(after, "a").length() - 1))
        awaitUi("image-only chat row") { vm.chat.value?.rows?.any { row -> row.text.isBlank() && row.blocks?.any { it is Attach.Block.Image } == true } == true }
        assertTrue(vm.chat.value!!.rows.any { it.text.isBlank() && it.blocks?.count { block -> block is Attach.Block.Image } == 1 })
        assertTrue(compose.onAllNodesWithText("Image ·", substring = true).fetchSemanticsNodes().isNotEmpty())
        noStoredImage(); case("D2")
    }

    @Test fun c_D3_and_D3b_thumbnailsLoadOnlyOnTapIncludingGif() {
        show()
        val before = count(counts(), "reads")
        val seeded = control("seed")
        assertUi("D3/D3b seed to succeed (harness: ${seeded.optString("error", "no error reported")})", seeded.optBoolean("ok"))
        fun showButton(size: String) = hasText("Show") and hasAnyAncestor(
            hasTestTag("chat-attachment-row") and hasAnyDescendant(hasText("Image · $size"))
        )
        val still = showButton("32 × 24")
        val gif = showButton("1 × 1")
        awaitUi("D3/D3b to show a Show button for each of the three desktop fixtures") {
            listOf(still, showButton("40 × 30"), gif).all { compose.onAllNodes(it).fetchSemanticsNodes().size == 1 }
        }
        val beforeTap = count(counts(), "reads") - before
        assertUi("D3 to have zero reads before Show, observed $beforeTap", beforeTap == 0)
        compose.onNode(still).performClick()
        awaitUi("D3 to record exactly one read after tapping Show for the 32 × 24 fixture") {
            count(counts(), "reads") == before + 1
        }
        val firstRead = counts().getJSONArray("reads").getJSONObject(before)
        val width = firstRead.optInt("width")
        val height = firstRead.optInt("height")
        assertUi("D3 thumbnail dimensions between 1 and 512 px, observed ${width} × $height", width in 1..512 && height in 1..512)
        awaitUi("D3 to display the 32 × 24 fixture thumbnail") {
            compose.onAllNodesWithContentDescription("Image from the chat, 32 × 24").fetchSemanticsNodes().isNotEmpty()
        }
        case("D3")
        compose.onNode(gif).performClick()
        awaitUi("D3b to record exactly one more read after tapping Show for the 1 × 1 GIF") {
            count(counts(), "reads") == before + 2
        }
        val gifType = counts().getJSONArray("reads").getJSONObject(before + 1).optString("mediaType")
        assertUi("D3b to read image/gif, observed $gifType", gifType == "image/gif")
        awaitUi("D3b to display the GIF and keep the first thumbnail visible") {
            compose.onAllNodesWithContentDescription("Image from the chat, 1 × 1").fetchSemanticsNodes().isNotEmpty() &&
                compose.onAllNodesWithContentDescription("Image from the chat", substring = true).fetchSemanticsNodes().size >= 2
        }
        case("D3b")
    }

    @Test fun d_D4_cancelAfterFirstAdmissionForwardsCancelAndInsertsNothing() {
        control("slowChunks"); show(); val before = counts(); add(fixture(), fixture(true)); send()
        awaitUi("one held upload after the disconnect", 90_000) { counts().getJSONArray("held").length() > before.getJSONArray("held").length() }
        awaitUi("two upload begin requests") { count(counts(), "uploadBegins") >= count(before, "uploadBegins") + 2 }
        val first = counts().getJSONArray("admitted").getString(count(before, "admitted"))
        compose.onNodeWithText("Cancel").performClick()
        awaitUi("upload cancel forwarded to DSH") { count(counts(), "forwardedCancel") > count(before, "forwardedCancel") }
        awaitUi("no sending messages and two draft images") { vm.attachments.state.value.messages.isEmpty() && vm.attachments.state.value.draft.size == 2 }
        val after = counts()
        assertEquals(1, after.getInt("watches"))
        val uploads = after.getJSONArray("uploadBegins")
        for (i in count(before, "uploadBegins") until uploads.length())
            assertFalse(control("probe", uploads.getString(i)).getBoolean("present"))
        assertTrue(after.getJSONArray("forwardedCancel").toString().contains(first))
        assertEquals(0, after.getLong("outstanding"))
        Thread.sleep(20_000)
        assertEquals(0, deltas(before, counts(), "a")); case("D4")
    }

    @Test fun e_D5_lostReplyRetryDedupesAtSessionEvent() {
        show(); val before = counts(); control("dropAfterAccept"); add(fixture()); send("fixture-caption-d5")
        awaitUi("D5 to show Maybe not sent after acceptance without a reply", 90_000) { label("Maybe not sent") }
        reconnect("D5")
        awaitUi("D5 to offer Retry after reconnecting to the same Session") { label("Retry") }
        compose.onNodeWithText("Retry").performClick()
        awaitUi("D5 to show Sent and have exactly one committed message in Session a", 90_000) {
            deltas(before, counts(), "a") == 1 && label("Sent")
        }
        val after = counts(); val prompts = prompts(after)
        assertEquals("D5 prompt count", 2, prompts.length() - prompts(before).length())
        val first = prompts.getJSONObject(prompts.length() - 2); val second = prompts.getJSONObject(prompts.length() - 1)
        assertUi("D5 to retry in Session a with the same request ID and content",
            first.getString("session") == "a" && second.getString("session") == "a" &&
                first.getString("requestId") == second.getString("requestId") && second.getBoolean("repeatsContent"))
        val event = messages(after, "a").getJSONObject(messages(after, "a").length() - 1)
        assertUi("D5's committed event to carry the prompt's request ID", first.getString("requestId") == event.getString("id"))
        assertEquals("D5 acceptance hook count", 1, after.getInt("hookFired") - before.getInt("hookFired"))
        assertEquals("D5 repeat:true reply count", 1, count(after, "repeatReplies") - count(before, "repeatReplies"))
        val rowId = event.getString("rowId")
        awaitUi("D5 to show the committed chat row") { vm.chat.value?.rows?.any { it.id == rowId } == true }
        assertEquals("D5 copies of the committed chat row", 1, vm.chat.value!!.rows.count { it.id == rowId })
        case("D5")
    }

    @Test fun f_D6a_moveAfterLostReplyOffersSendAgainOnlyForNewSession() {
        show(); val before = counts(); control("dropAfterAccept"); add(fixture()); send()
        awaitUi("Maybe not sent", 90_000) { text("Maybe not sent") }
        control("move")
        compose.runOnIdle { vm.reconnectChat() }
        awaitUi("Retry", 90_000) { text("Retry") }
        compose.onNodeWithText("Retry").performClick()
        awaitUi("moved Bot notice and Send as new", 90_000) { text("this Bot started a new chat on the computer") && text("Send as new") }
        assertEquals(0, deltas(before, counts(), "b"))
        compose.onAllNodesWithText("Send as new").onFirst().performClick()
        if (text("Send as a new message?")) compose.onNodeWithText("Send").performClick()
        awaitUi("one committed message in Session b", 90_000) { deltas(before, counts(), "b") == 1 }
        assertEquals(1, deltas(before, counts(), "a")); case("D6a")
    }

    @Test fun g_D6b_moveBeforeFirstSendHasNoPromptUntilSendAgain() {
        control("slowChunks", delayMs = 10_000)
        show(); val before = counts(); add(fixture(true)); send()
        awaitUi("D6b to show Uploading with a chunk acknowledgement still delayed") {
            text("Uploading") && counts().getInt("pendingChunkAcks") > 0
        }
        val moved = control("dropMove")
        assertUi("D6b to drop the TCP connection mid-chunk and move the Bot (harness: ${moved.optString("error", "no error reported")})",
            moved.optBoolean("ok"))
        reconnect("D6b")
        awaitUi("D6b to offer Send again after reconnecting to the moved Bot", 90_000) { label("Send again") }
        assertUi("D6b to explain that the Bot's chat changed", text("this Bot's chat changed on the computer"))
        assertUi("D6b to hide Retry after the move", !label("Retry"))
        assertEquals("D6b prompts immediately after reconnect", 0, prompts(counts()).length() - prompts(before).length())
        Thread.sleep(20_000)
        val afterWait = counts()
        assertEquals("D6b prompts in either Session before Send again", 0, prompts(afterWait).length() - prompts(before).length())
        assertEquals("D6b committed messages in Session a before Send again", 0, deltas(before, afterWait, "a"))
        assertEquals("D6b committed messages in Session b before Send again", 0, deltas(before, afterWait, "b"))
        compose.onNodeWithText("Send again").performClick()
        awaitUi("D6b to commit one message in Session b after tapping Send again", 90_000) {
            deltas(before, counts(), "b") == 1
        }
        val afterSend = counts()
        assertEquals("D6b committed messages in Session a after Send again", 0, deltas(before, afterSend, "a"))
        assertEquals("D6b committed messages in Session b after Send again", 1, deltas(before, afterSend, "b"))
        val sentPrompts = prompts(afterSend)
        assertEquals("D6b prompts after Send again", 1, sentPrompts.length() - prompts(before).length())
        assertEquals("D6b prompt Session after Send again", "b", sentPrompts.getJSONObject(sentPrompts.length() - 1).getString("session"))
        case("D6b")
    }

    @Test fun h_D7_oldLinkNamesPocketLinkAndTextStillWorks() {
        port = 47111; show(); compose.onNodeWithContentDescription("Add images").performClick()
        awaitUi("newer Pocket Link notice") { text("newer Pocket Link") }
        val before = counts(); send("fixture-legacy-text")
        awaitUi("one committed message in Session a") { deltas(before, counts(), "a") == 1 }; case("D7")
    }

    @Test fun i_D8_unavailableAppNamesAutomagik() {
        port = 47112; show(); compose.onNodeWithContentDescription("Add images").performClick()
        awaitUi("newer Automagik app notice") { text("newer Automagik app") }; case("D8")
    }

    @Test fun j_D9_reconnectRenegotiatesWithoutRetargeting() {
        port = 47112; show(); compose.onNodeWithContentDescription("Add images").performClick()
        awaitUi("newer Automagik app notice") { text("newer Automagik app") }
        port = 47114; control("drop")
        awaitUi("attachment offer or Reconnect", 90_000) { vm.attachments.state.value.peer is Attach.Peer.Offered || text("Reconnect") }
        if (text("Reconnect")) compose.onNodeWithText("Reconnect").performClick()
        awaitUi("attachment offer", 90_000) { vm.attachments.state.value.peer is Attach.Peer.Offered }
        assertEquals(ref.address, vm.chat.value?.terminal)
        add(fixture()); assertTrue(vm.attachments.state.value.draft.isNotEmpty())
        port = 47111; control("drop")
        awaitUi("Reconnect", 90_000) { text("Reconnect") }
        compose.onNodeWithText("Reconnect").performClick()
        awaitUi("missing attachment offer", 90_000) { vm.attachments.state.value.peer is Attach.Peer.Missing }
        assertEquals(ref.address, vm.chat.value?.terminal)
        compose.onNodeWithContentDescription("Add images").performClick()
        awaitUi("newer Pocket Link notice") { text("newer Pocket Link") }; case("D9")
    }

    @Test fun k_D12_noSocketHelloIsNone() {
        val socket = open(47113, 10_000)
        val scope = kotlinx.coroutines.CoroutineScope(Dispatchers.IO)
        val client = kotlinx.coroutines.runBlocking { ChatClient.start(CoreClient(socket.getInputStream(), socket.getOutputStream(), socket, scope) {}, emptyList(), true) }
        assertTrue(client.attach is Attach.Peer.None)
        client.close(); case("D12")
    }
}

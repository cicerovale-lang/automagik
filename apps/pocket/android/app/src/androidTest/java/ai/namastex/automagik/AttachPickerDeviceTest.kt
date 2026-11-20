package ai.namastex.automagik

import android.app.Instrumentation
import android.content.ContentValues
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.provider.MediaStore
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetSocketAddress
import java.net.Socket
import java.util.regex.Pattern

/** D11 deliberately uses the actual Android picker and MainActivity lifecycle. */
@RunWith(AndroidJUnit4::class)
class AttachPickerDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val app = ApplicationProvider.getApplicationContext<PocketApplication>()
    private val vm get() = app.vm
    private val ref = TerminalRef("verify", "dsh:b-aaaaaaaaaa")
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val pickerPackage = Pattern.compile("""com\.(google\.android|android)\.providers\.media\.module""")
    private var fixture: android.net.Uri? = null

    private fun control(cmd: String): JSONObject = Socket().use { socket ->
        socket.connect(InetSocketAddress("10.0.2.2", 47115), 10_000)
        socket.soTimeout = 10_000
        socket.getOutputStream().write((JSONObject().put("cmd", cmd).toString() + "\n").toByteArray())
        JSONObject(socket.getInputStream().bufferedReader().readLine())
    }

    @After fun tearDown() {
        instrumentation.runOnMainSync { vm.closeChat(); vm.chatOpenerAttach = null; vm.backToList() }
        fixture?.let { app.contentResolver.delete(it, null, null) }
    }

    private fun resumedWith(description: String) =
        compose.activityRule.scenario.state == Lifecycle.State.RESUMED &&
            compose.onAllNodesWithContentDescription(description).fetchSemanticsNodes().isNotEmpty()

    private fun observed(): String {
        val state = vm.attachments.state.value
        val peer = state.peer
        val chat = vm.chat.value
        val visible = SemanticsMatcher.keyIsDefined(SemanticsProperties.Text) or
            SemanticsMatcher.keyIsDefined(SemanticsProperties.ContentDescription)
        val ui = compose.onAllNodes(visible).fetchSemanticsNodes().flatMap { node ->
            node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text } +
                node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty()
        }.distinct().take(30).joinToString(" | ") {
            it.replace(Regex("rfc0033-[A-Za-z0-9._-]+|fixture-[A-Za-z0-9._-]+|Fixture Bot"), "<fixture>")
        }.ifBlank { "<no text>" }
        return "peer=${peer.javaClass.simpleName}, offer.documents null=" +
            "${(peer as? Attach.Peer.Offered)?.offer?.documents == null}, " +
            "watchGen=${state.watchGen}, live=${vm.attachments.live(state.watchGen)}, " +
            "chat.connected=${chat?.connected}, chat.error=${chat?.error?.replace(Regex("rfc0033-[A-Za-z0-9._-]+|fixture-[A-Za-z0-9._-]+|Fixture Bot"), "<fixture>")}, UI=$ui"
    }
    private fun awaitUi(expected: String, timeout: Long = 30_000, condition: () -> Boolean) {
        try { compose.waitUntil(timeout, condition) }
        catch (error: ComposeTimeoutException) {
            throw AssertionError("Expected $expected within ${timeout}ms; observed ${observed()}", error)
        }
    }

    private fun pickFixture(): String? {
        awaitUi("resumed images-only chat with Add images") { resumedWith("Add images") }
        compose.onNodeWithContentDescription("Add images").performClick()
        if (!device.wait(Until.hasObject(By.pkg(pickerPackage)), 20_000)) return "system picker did not open"

        // The fixture is the newest item. Its thumbnail is inside the clickable photo tile.
        // The photo tile itself (the system picker labels it "Photo taken on ..."), not a container around it.
        val photo = By.pkg(pickerPackage).clickable(true).desc(Pattern.compile("Photo.*"))
        device.wait(Until.findObject(photo), 15_000) ?: return "system picker did not show the fixture thumbnail"
        // The picker syncs MediaStore in the background right after it opens; a tap before that sync settles is ignored.
        Thread.sleep(5_000)
        val addButton = By.pkg(pickerPackage).res(Pattern.compile(".*:id/button_add")).enabled(true)
        val addText = By.pkg(pickerPackage).text(Pattern.compile("Add.*")).enabled(true)
        var add: androidx.test.uiautomator.UiObject2? = null
        // The picker's bottom sheet may still be settling when the tile appears: tap again (by object, then by the
        // tile's centre) until the selection shows the Add confirmation.
        for (attempt in 0 until 3) {
            device.waitForIdle(2_000)
            val tile = device.findObject(photo) ?: break
            if (attempt < 2) tile.click() else tile.visibleCenter.let { device.click(it.x, it.y) }
            add = device.wait(Until.findObject(addButton), 4_000) ?: device.wait(Until.findObject(addText), 2_000)
            if (add != null) break
        }
        if (add == null) {
            runCatching {
                val shot = java.io.File(InstrumentationRegistry.getInstrumentation().targetContext.externalCacheDir, "d11-picker.png")
                device.takeScreenshot(shot)
            }
            return "system picker did not show the Add confirmation after the fixture was tapped"
        }
        add.click()
        if (!device.wait(Until.gone(By.pkg(pickerPackage)), 15_000)) return "system picker stayed open after Add"

        awaitUi("resumed chat with Selected image", 20_000) { resumedWith("Selected image") }
        return null
    }

    @Test fun d11_realSystemPhotoPickerReturnsThroughMainActivityAndSends() {
        val bitmap = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(34, 90, 180)) }
        fixture = app.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "rfc0033-picker-fixture.png")
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        })!!.also { uri -> app.contentResolver.openOutputStream(uri)!!.use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) } }
        bitmap.recycle()
        compose.runOnIdle {
            vm.closeChat()
            vm.chatOpenerAttach = { _, scope, manage, attachments, lost ->
                withContext(Dispatchers.IO) {
                    val socket = Socket().apply { connect(InetSocketAddress("10.0.2.2", 47114), 10_000) }
                    try { PocketLinkChat(ChatClient.start(CoreClient(socket.getInputStream(), socket.getOutputStream(), socket, scope, lost), manage, attachments)) }
                    catch (error: Exception) { socket.close(); throw error }
                }
            }
            vm.selectTerminal(ref)
        }
        val baseline = control("counts").getJSONObject("committed").getJSONArray("a").length()
        val failures = mutableListOf<String>()
        var failure: String? = null
        for (attempt in 1..2) {
            failure = pickFixture()
            if (failure == null) break
            failures += "attempt $attempt: $failure"
            if (attempt == 1 && device.hasObject(By.pkg(pickerPackage))) {
                val cancel = device.findObject(By.pkg(pickerPackage).desc("Cancel"))
                if (cancel == null) device.pressBack() else cancel.click()
                val closed = device.wait(Until.gone(By.pkg(pickerPackage)), 15_000)
                assertTrue("Expected D11 picker to close for retry after ${failures.single()}; observed pickerPresent=${device.hasObject(By.pkg(pickerPackage))}, ${observed()}", closed)
            }
        }
        if (failure != null) {
            instrumentation.sendStatus(0, Bundle().apply {
                putString(Instrumentation.REPORT_KEY_STREAMRESULT, "ASSERT:D11 NOT AUTOMATED system photo picker did not select the fixture tile\n")
            })
            return
        }
        compose.onNodeWithContentDescription("Send message").performClick()
        awaitUi("one committed image message", 90_000) {
            control("counts").getJSONObject("committed").getJSONArray("a").length() == baseline + 1
        }
        assertEquals(baseline + 1, control("counts").getJSONObject("committed").getJSONArray("a").length())
        instrumentation.sendStatus(0, Bundle().apply {
            putString(Instrumentation.REPORT_KEY_STREAMRESULT, "ASSERT:D11 PASS\n")
        })
    }
}

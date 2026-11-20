package ai.namastex.automagik

import android.app.Instrumentation
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetSocketAddress
import java.net.Socket

/** Copied only into the pre-D3 app checkout; this class compiles against its old API. */
@RunWith(AndroidJUnit4::class)
class LegacyPhoneDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val vm = ApplicationProvider.getApplicationContext<PocketApplication>().vm
    private val ref = TerminalRef("verify", "dsh:b-aaaaaaaaaa")

    private fun control(cmd: String): JSONObject = Socket().use { socket ->
        socket.connect(InetSocketAddress("10.0.2.2", 47115), 10_000)
        socket.soTimeout = 10_000
        socket.getOutputStream().write((JSONObject().put("cmd", cmd).toString() + "\n").toByteArray())
        JSONObject(socket.getInputStream().bufferedReader().readLine())
    }
    @After fun tearDown() { compose.runOnIdle { vm.closeChat(); vm.chatOpenerManage = null } }

    @Test fun d10_oldPocketSeesOnlyCaptionedLegacyRowAndCanTextSend() {
        control("reset")
        compose.runOnIdle {
            vm.closeChat()
            vm.chatOpenerManage = { _, scope, manage, lost -> withContext(Dispatchers.IO) {
                val socket = Socket().apply { connect(InetSocketAddress("10.0.2.2", 47110), 10_000) }
                try { PocketLinkChat(ChatClient.start(CoreClient(socket.getInputStream(), socket.getOutputStream(), socket, scope, lost), manage)) }
                catch (error: Exception) { socket.close(); throw error }
            } }
        }
        compose.setContent { ChatPane(vm, ref, null, {}) }
        compose.waitUntil(30_000) { vm.chat.value?.connected == true }
        val seeded = control("seed")
        val captioned = seeded.getString("captioned")
        val imageOnly = seeded.getString("imageOnly")
        compose.waitUntil(30_000) { vm.chat.value?.rows?.any { it.id == captioned } == true }
        val rows = vm.chat.value!!.rows
        assertEquals("Fixture caption", rows.single { it.id == captioned }.text)
        assertFalse(rows.any { it.id == imageOnly })
        val before = control("counts").getJSONObject("committed").getJSONArray("a").length()
        compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput("fixture-legacy-send")
        compose.onNodeWithContentDescription("Send message").performClick()
        compose.waitUntil(30_000) { control("counts").getJSONObject("committed").getJSONArray("a").length() == before + 1 }
        assertTrue(vm.chat.value!!.rows.any { it.id == captioned })
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
            putString(Instrumentation.REPORT_KEY_STREAMRESULT, "ASSERT:D10 PASS\n")
        })
    }
}

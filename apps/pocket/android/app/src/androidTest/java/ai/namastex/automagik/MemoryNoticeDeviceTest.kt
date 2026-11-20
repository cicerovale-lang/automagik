package ai.namastex.automagik

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetSocketAddress
import java.net.Socket

/** Disposable stage-6 check: the installed app's real ChatPane, D1's real host and bridge, a held memory write. */
@RunWith(AndroidJUnit4::class)
class MemoryNoticeDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val ref = TerminalRef("verify", "dsh:b-aaaaaaaaaa")
    private val notice = "A change you sent earlier may have been saved: check Memory on the computer."
    private lateinit var vm: PocketViewModel

    @Before fun setUp() {
        vm = ApplicationProvider.getApplicationContext<PocketApplication>().vm
        compose.runOnIdle {
            vm.closeChat()
            vm.chatOpenerManage = { _, scope, manage, lost ->
                withContext(Dispatchers.IO) {
                    val socket = openSocket(47100)
                    try { PocketLinkChat(ChatClient.start(CoreClient(socket.getInputStream(), socket.getOutputStream(), socket, scope, lost), manage)) }
                    catch (error: Exception) { socket.close(); throw error }
                }
            }
        }
    }

    @After fun tearDown() { compose.runOnIdle { vm.closeMemory(); vm.closeChat(); vm.chatOpenerManage = null } }

    private fun openSocket(at: Int): Socket { val address = InetSocketAddress("10.0.2.2", at); return Socket().apply { connect(address, 10_000) } }
    private fun control(command: String): String = openSocket(47102).use { socket ->
        socket.soTimeout = 10_000
        socket.getOutputStream().write((command + "\n").toByteArray(Charsets.UTF_8))
        socket.getInputStream().bufferedReader().readLine() ?: error("No control answer")
    }
    private fun waitText(text: String) = compose.waitUntil(20_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    @Test fun closingAHeldAddShowsTheNoticeOnReopenOnce() {
        compose.setContent { ChatPane(vm, ref, null, {}) }
        compose.waitUntil(20_000) { compose.onAllNodes(hasContentDescription("Bot memory")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Bot memory").performClick()
        waitText("Seeded fixture note")
        assertEquals(0, compose.onAllNodesWithText(notice).fetchSemanticsNodes().size)
        val seen = control("seen-writes").toInt()
        assertEquals("ok", control("hold-writes on"))
        try {
            compose.onNode(hasSetTextAction() and hasText("New entry")).performTextInput("Device fixture draft")
            compose.onNodeWithText("Add").performClick()
            compose.waitUntil(20_000) { control("seen-writes").toInt() > seen }
            compose.runOnIdle { assertEquals(ChatMemory.Op.ADD, vm.memory.value?.op) }
            compose.onNodeWithText("Close").performClick()
            compose.waitUntil(20_000) { compose.runOnIdle { vm.memory.value == null } }
        } finally { assertEquals("ok", control("release-writes")) }
        compose.onNodeWithContentDescription("Bot memory").performClick()
        waitText(notice)
        waitText("Seeded fixture note")
        compose.onNodeWithText("Close").performClick()
        compose.waitUntil(20_000) { compose.runOnIdle { vm.memory.value == null } }
        compose.onNodeWithContentDescription("Bot memory").performClick()
        waitText("Seeded fixture note")
        assertEquals(0, compose.onAllNodesWithText(notice).fetchSemanticsNodes().size)
    }
}

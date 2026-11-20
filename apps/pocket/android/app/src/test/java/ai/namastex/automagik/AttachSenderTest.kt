package ai.namastex.automagik

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

internal fun attachRefusal(reason: String, code: String? = null) = JSONObject().put("state", "refused")
    .put("ok", false).put("reason", reason).put("code", code).put("message", "remote diagnostic")

internal fun attachSuccess(id: String) = JSONObject().put("ok", true).put("state", "sent").put("id", id)

internal open class AttachTestLink(
    override val attach: Attach.Peer = Attach.Peer.Offered(testOffer()),
    override val dshWrite: Boolean = true
) : ChatLink {
    data class Call(val kind: String, val id: String, val offset: Int = 0, val data: ByteArray? = null,
                    val caption: String = "", val uploads: List<String> = emptyList())
    val calls = CopyOnWriteArrayList<Call>()
    val subscribed = CompletableDeferred<Unit>()
    val closed = CompletableDeferred<Unit>()
    @Volatile private var onEvent: ((JSONObject) -> Unit)? = null
    @Volatile private var onClosed: ((String) -> Unit)? = null
    private val images = ConcurrentHashMap<String, Pair<String, Int>>()
    var begin: suspend (String) -> JSONObject = { open(it) }
    var chunk: suspend (String, Int, ByteArray) -> JSONObject = { _, offset, data -> JSONObject().put("ok", true).put("received", offset + data.size) }
    var finish: suspend (String) -> JSONObject = { admit(it) }
    var sendImage: suspend (String) -> JSONObject = { attachSuccess(it) }
    var readImage: suspend () -> JSONObject = { attachRefusal("not-found") }

    fun open(id: String) = JSONObject().put("ok", true).put("state", "open").put("upload", id).put("chunkBytes", Attach.CHUNK_BYTES)
    fun admit(id: String): JSONObject {
        val (type, size) = images.getValue(id)
        return JSONObject().put("ok", true).put("state", "admitted").put("upload", id)
            .put("image", JSONObject().put("mediaType", type).put("width", 1).put("height", 1).put("bytes", size).put("stored", size))
    }

    override suspend fun attachBegin(terminal: String, upload: String, mediaType: String, bytes: Int): JSONObject {
        calls += Call("begin", upload); images[upload] = mediaType to bytes
        return begin(upload)
    }
    override suspend fun attachChunk(terminal: String, upload: String, offset: Int, data: ByteArray): JSONObject {
        calls += Call("chunk", upload, offset, data)
        return chunk(upload, offset, data)
    }
    override suspend fun attachFinish(terminal: String, upload: String): JSONObject {
        calls += Call("finish", upload)
        return finish(upload)
    }
    override suspend fun attachCancel(terminal: String, upload: String): JSONObject {
        calls += Call("cancel", upload)
        return JSONObject().put("ok", true)
    }
    override suspend fun sendUploads(terminal: String, id: String, text: String, uploads: List<String>): JSONObject {
        calls += Call("send", id, caption = text, uploads = uploads)
        return sendImage(id)
    }
    override suspend fun attachmentRead(terminal: String, row: String, block: Int): JSONObject {
        calls += Call("read", row, block)
        return readImage()
    }
    override suspend fun list() = listOf(Chat.Terminal("t1", "", "", "", "", ""))
    override suspend fun subscribe(terminal: String, after: String?, event: (JSONObject) -> Unit, closed: (String) -> Unit): Int {
        onEvent = event
        onClosed = closed
        subscribed.complete(Unit)
        return 1
    }
    fun event(e: JSONObject) = checkNotNull(onEvent)(e)
    fun end(reason: String) = checkNotNull(onClosed)(reason)
    override suspend fun backfill(terminal: String, before: String, limit: Int) = JSONArray()
    override suspend fun send(terminal: String, text: String, id: String): JSONObject {
        calls += Call("text", id, caption = text)
        return attachSuccess(id)
    }
    override suspend fun sendHeld(terminal: String, id: String) = JSONObject()
    override suspend fun cancelHeld(terminal: String, id: String) = JSONObject()
    override suspend fun answer(terminal: String, row: String, choice: String, text: String?) = JSONObject()
    override suspend fun interrupt(terminal: String) = JSONObject()
    override fun close() { closed.complete(Unit) }
}

private fun prepared(key: String, n: Int) = Prepared(key, "content://pictures/$key", Attach.PNG,
    ByteArray(n) { (it % 251).toByte() }, 1, 1)

@OptIn(ExperimentalCoroutinesApi::class)
class AttachSenderTest {
    private class Run(val link: AttachTestLink = AttachTestLink(), images: List<Prepared> = listOf(prepared("1", 2))) {
        val attempt = Attempt(1)
        var message = ImageMessage("message", "caption ", images, "session", 1)
        val sender = AttachSender(link, "dsh:bot", testOffer(), attempt, { true }) { message = it(message) }
        suspend fun start() = sender.upload(message)
        fun kinds() = link.calls.map { it.kind }
    }

    @Test fun chunksAdvanceOnlyAfterCreditAndFinishWaitsForTheLastChunk() = runTest {
        val raw = prepared("1", Attach.CHUNK_BYTES * 2 + 13)
        val r = Run(images = listOf(raw))
        val ack = List(3) { CompletableDeferred<Unit>() }
        r.link.chunk = { _, offset, data ->
            ack[offset / Attach.CHUNK_BYTES].await()
            JSONObject().put("ok", true).put("received", offset + data.size)
        }
        val work = launch { r.start() }
        for (i in ack.indices) {
            runCurrent()
            assertEquals(listOf("begin") + List(i + 1) { "chunk" }, r.kinds())
            ack[i].complete(Unit)
        }
        work.join()
        val chunks = r.link.calls.filter { it.kind == "chunk" }
        assertEquals(listOf(0, 24576, 49152), chunks.map { it.offset })
        assertEquals(listOf(24576, 24576, 13), chunks.map { it.data!!.size })
        val roundTrip = chunks.flatMap {
            java.util.Base64.getDecoder().decode(Attach.chunkParams("dsh:bot", it.id, it.offset, it.data!!).getString("data")).toList()
        }.toByteArray()
        assertArrayEquals(raw.bytes, roundTrip)
        assertEquals(listOf("begin", "chunk", "chunk", "chunk", "finish", "send"), r.kinds())
        assertEquals(Phase.SENT, r.message.phase)
        assertTrue(r.message.images.isEmpty())
    }

    @Test fun malformedCreditsBeginEchoAndUnknownOrTimedOutFinishNeverSend() = runTest {
        for (bad in listOf("begin", "chunk", "finish", "timeout")) {
            val r = Run()
            when (bad) {
                "begin" -> r.link.begin = { r.link.open(it).put("chunkBytes", 24577) }
                "chunk" -> r.link.chunk = { _, _, _ -> JSONObject().put("ok", true).put("received", 1) }
                "finish" -> r.link.finish = { JSONObject().put("ok", false).put("state", "unknown") }
                else -> r.link.finish = { withTimeout(5) { delay(10); JSONObject() } }
            }
            r.start()
            assertEquals(Phase.STOPPED, r.message.phase)
            assertEquals("cancel", r.kinds().last())
            assertFalse("send" in r.kinds())
        }
    }

    @Test fun busyBeginUsesFreshIdsAndBusyChunkRepeatsTheSameBytesWithinDeadlines() = runTest {
        val begin = Run()
        begin.link.begin = { attachRefusal("busy") }
        val start = testScheduler.currentTime
        begin.start()
        val starts = begin.link.calls.filter { it.kind == "begin" }.map { it.id }
        assertTrue(starts.size > 1)
        assertEquals(starts, starts.distinct())
        assertEquals(starts, begin.link.calls.filter { it.kind == "cancel" }.map { it.id })
        assertEquals(30_000L, testScheduler.currentTime - start)
        assertEquals(Phase.STOPPED, begin.message.phase)
        assertEquals("busy", begin.message.reason)

        val chunk = Run()
        chunk.link.chunk = { _, _, _ -> attachRefusal("busy") }
        val now = testScheduler.currentTime
        chunk.start()
        val repeated = chunk.link.calls.filter { it.kind == "chunk" }
        assertTrue(repeated.size > 1)
        assertTrue(repeated.all { it.offset == 0 && it.data!!.contentEquals(byteArrayOf(0, 1)) && it.id == repeated.first().id })
        assertEquals(25_000L, testScheduler.currentTime - now)
        assertEquals("cancel", chunk.kinds().last())
        assertEquals("busy", chunk.message.reason)
    }

    @Test fun secondFinishFailureCleansBothIdsBeforeStoppedAndBeforeRetry() = runTest {
        val failed = Run(images = listOf(prepared("1", 2), prepared("2", 3)))
        val link = failed.link
        link.finish = {
            if (link.calls.count { call -> call.kind == "finish" } == 1) link.admit(it) else attachRefusal("rejected", "timeout")
        }
        failed.start()
        val ids = link.calls.filter { it.kind == "begin" }.map { it.id }
        assertEquals(ids, link.calls.takeLast(2).filter { it.kind == "cancel" }.map { it.id })
        assertEquals(Phase.STOPPED, failed.message.phase)
        link.finish = { link.admit(it) }
        val retry = Run(link)
        retry.start()
        assertEquals(listOf("cancel", "cancel", "begin"), link.calls.map { it.kind }.subList(6, 9))
        assertFalse(link.calls[8].id in ids)
    }

    @Test fun cancelWhileOpeningWaitsForItsReplyAndCancelDuringBusyBackoffStartsNoNewBegin() = runTest {
        val blocked = Run()
        val reply = CompletableDeferred<Unit>()
        blocked.link.begin = { reply.await(); blocked.link.open(it) }
        val sender = launch { blocked.start() }
        runCurrent()
        assertTrue(blocked.attempt.cancel())
        val clean = launch { blocked.sender.cleanup() }
        runCurrent()
        assertEquals(listOf("begin"), blocked.kinds())
        reply.complete(Unit)
        sender.join(); clean.join()
        assertEquals(listOf("begin", "cancel"), blocked.kinds())

        val busy = Run()
        busy.link.begin = { attachRefusal("busy") }
        val backingOff = launch { busy.start() }
        advanceTimeBy(100)
        assertTrue(busy.attempt.cancel())
        busy.sender.cleanup()
        backingOff.join()
        assertEquals(listOf("begin", "cancel"), busy.kinds())
    }

    @Test fun sendRequiresMatchingIdAndKnownStateAndKeepsUncertaintyAcrossRefusals() {
        val m = Run().message
        assertEquals(Phase.SENT, AttachSender.outcome(m, attachSuccess(m.id)).phase)
        assertEquals(Phase.QUEUED, AttachSender.outcome(m, attachSuccess(m.id).put("state", "queued")).phase)
        for (reply in listOf(JSONObject().put("id", m.id), attachSuccess("other"),
            attachSuccess(m.id).apply { remove("id") }, attachRefusal("expired").put("id", "other"))) {
            val outcome = AttachSender.outcome(m, reply)
            assertEquals(Phase.MAYBE, outcome.phase)
            assertTrue(outcome.uncertain)
        }
        val reasons = listOf("busy", "rate", "unavailable", "expired", "session-changed", "changed", "too-large", "unsupported",
            "quota", "invalid", "rejected", "not-shown", "not-watching", "revoked", "read-only", "failed", "other", "offline")
        for (reason in reasons) {
            val successUnknown = AttachSender.outcome(m.copy(uncertain = true), attachRefusal(reason))
            assertEquals(Phase.MAYBE, successUnknown.phase)
            assertTrue(successUnknown.uncertain)
            val retryable = reason in setOf("busy", "rate", "unavailable", "offline")
            assertEquals(if (retryable) AttachAction.RETRY else AttachAction.SEND_AGAIN, successUnknown.action)
            val refused = AttachSender.outcome(m, attachRefusal(reason))
            assertEquals(if (reason == "offline") Phase.MAYBE else Phase.REFUSED, refused.phase)
            assertEquals(when {
                retryable -> AttachAction.RETRY
                reason in setOf("expired", "session-changed") -> AttachAction.SEND_AGAIN
                else -> AttachAction.NONE
            }, refused.action)
            assertFalse(Attach.words(reason).contains("remote diagnostic"))
        }
        assertEquals(AttachAction.SEND_AGAIN, AttachSender.outcome(m, attachRefusal("rejected", "timeout")).action)
        assertEquals("this Bot's model can't read images", Attach.words("rejected", "MODEL_DOES_NOT_SUPPORT_IMAGES"))
        assertEquals("the computer couldn't read this image", Attach.words("rejected", "INVALID_IMAGE"))
        assertEquals("too large for the computer", Attach.words("rejected", "IMAGE_TOO_MANY_PIXELS"))
    }
}

internal fun testDocumentOffer(cap: Int = 8_388_608) = testOffer().copy(documents = testDocuments(cap))

internal fun fakeDocument(bytes: ByteArray = "notes".toByteArray(), name: String? = "sample.TxT") =
    Prepared("document", "", Attach.TXT, bytes, 0, 0, kind = AttachmentKind.DOCUMENT, name = name)

internal fun fileAdmitted(upload: String, mediaType: String, bytes: Int, name: String): JSONObject =
    JSONObject().put("ok", true).put("state", "admitted").put("upload", upload)
        .put("file", JSONObject().put("mediaType", mediaType).put("bytes", bytes).put("name", name))

internal open class DocumentTestLink(offer: Attach.Offer = testDocumentOffer()) : AttachTestLink(Attach.Peer.Offered(offer)) {
    data class DocumentBegin(val upload: String, val type: String, val length: Int, val name: String?)
    val documentBegins = CopyOnWriteArrayList<DocumentBegin>()

    init { finish = { admitItem(it) } }

    override suspend fun attachBegin(terminal: String, upload: String, mediaType: String, bytes: Int, name: String?): JSONObject {
        if (mediaType in Attach.documentTypes) documentBegins += DocumentBegin(upload, mediaType, bytes, name)
        return super.attachBegin(terminal, upload, mediaType, bytes)
    }

    fun admitItem(upload: String): JSONObject {
        val document = documentBegins.find { it.upload == upload } ?: return admit(upload)
        val leaf = if (document.type == Attach.PDF) "sample.pdf" else "sample.txt"
        return fileAdmitted(upload, document.type, document.length, leaf)
    }
}

class AttachDocumentSenderTest {
    private val image = prepared("1", 6)
    private val document = fakeDocument()

    @Test fun finishAcceptsOneMatchingArmAndNormalizedImages() {
        val offer = testDocumentOffer()
        val upload = "upload"
        fun file() = fileAdmitted(upload, Attach.TXT, document.bytes.size, "sample.txt")
        fun imageReply() = JSONObject().put("ok", true).put("state", "admitted").put("upload", upload)
            .put("image", JSONObject().put("mediaType", Attach.WEBP).put("width", 1).put("height", 1)
                .put("bytes", image.bytes.size).put("stored", 4))

        assertTrue(Attach.admitted(file(), upload, document, offer))
        assertTrue(Attach.admitted(imageReply(), upload, image, offer))
        assertFalse(Attach.admitted(file(), upload, image, offer))
        assertFalse(Attach.admitted(imageReply(), upload, document, offer))
        val invalid = listOf(
            file().put("image", imageReply().getJSONObject("image")), file().put("image", JSONObject.NULL),
            file().put("file", JSONObject.NULL), file().put("upload", "other"),
            file().put("state", "open"), file().put("ok", false)
        )
        for (reply in invalid) assertFalse(Attach.admitted(reply, upload, document, offer))
        assertFalse(Attach.admitted(imageReply().put("file", JSONObject.NULL), upload, image, offer))
        for ((key, bad) in listOf("mediaType" to Attach.PDF, "bytes" to 6, "name" to 123, "name" to JSONObject.NULL)) {
            val reply = file()
            reply.getJSONObject("file").put(key, bad)
            assertFalse(Attach.admitted(reply, upload, document, offer))
        }
    }

    @Test fun finishRejectsPathsControlCharactersBadUtf16AndNoncanonicalExtensions() {
        val offer = testDocumentOffer()
        val names = listOf("", "sample.PDF", "sample.TXT", "sample.txt.bak", "a".repeat(125) + ".txt",
            "folder/sample.txt", "folder\\sample.txt", "sample\u202E.txt", "sample\u0085.txt",
            "sample\uDB40\uDC01.txt", "\uD800.txt", "\uDC00.txt")
        for (name in names) assertFalse(Attach.admitted(fileAdmitted("u", Attach.TXT, 5, name), "u", document, offer))
        for (name in listOf("a".repeat(124) + ".txt", "\u05e9\u05dc\u05d5\u05dd.txt")) {
            assertTrue(Attach.admitted(fileAdmitted("u", Attach.TXT, 5, name), "u", document, offer))
        }
    }

    private suspend fun upload(link: DocumentTestLink): ImageMessage {
        var message = ImageMessage("message", "caption", listOf(image, document), "session", 1)
        AttachSender(link, "dsh:bot", testDocumentOffer(), Attempt(1), { true }) { message = it(message) }.upload(message)
        return message
    }

    @Test fun mixedUploadsKeepTheirOrderAndUnsupportedUsesTheFailedItemKind() = runTest {
        val accepted = DocumentTestLink()
        val message = upload(accepted)
        val ordered = accepted.calls.filter { it.kind == "begin" }.map { it.id }
        assertEquals(ordered, accepted.calls.last().uploads)
        assertEquals(ordered[1], accepted.documentBegins.single().upload)
        assertEquals(Phase.SENT, message.phase)
        assertEquals("1 image, 1 file", attachmentCount(message.imageCount, message.fileCount))

        for ((failedPosition, words) in listOf(1 to "the computer couldn't read this image", 2 to "the computer couldn't take this file")) {
            val link = DocumentTestLink()
            link.begin = {
                if (link.calls.count { call -> call.kind == "begin" } == failedPosition) attachRefusal("unsupported")
                else link.open(it)
            }
            val failed = upload(link)
            assertEquals(Phase.STOPPED, failed.phase)
            assertEquals("attach", failed.failedOperation)
            assertEquals(if (failedPosition == 1) AttachmentKind.IMAGE else AttachmentKind.DOCUMENT, failed.failedKind)
            assertEquals(words, Attach.words(failed))
            assertEquals("", failed.marker)
            assertTrue(link.calls.none { it.kind == "send" })
        }
    }

    @Test fun documentRefusalsUseAllowlistedWordsAndDistinguishNameFromCaption() = runTest {
        val cases = listOf(
            Triple("rejected", "timeout", "the computer took too long to take the file"),
            Triple("rejected", null, "the computer refused this file"),
            Triple("unavailable", null, "the computer couldn't take this file right now"),
            Triple("expired", "FILE_NOT_STAGED", "the files expired on the computer"),
            Triple("quota", null, "the computer takes no more attachments now (daily limit or low disk); try later"),
            Triple("unsupported", Attach.FILES_UNSUPPORTED, "the computer doesn't take files"),
            Triple("unsupported", "SUBAGENT_FILE_UNSUPPORTED", "this Bot can't take files now")
        )
        for ((reason, code, words) in cases) {
            val link = DocumentTestLink()
            link.finish = {
                if (link.documentBegins.any { doc -> doc.upload == it }) attachRefusal(reason, code)
                else link.admitItem(it)
            }
            val failed = upload(link)
            assertEquals(words, Attach.words(failed))
            assertEquals("", failed.marker)
        }

        val name = DocumentTestLink()
        name.begin = {
            if (name.documentBegins.any { doc -> doc.upload == it }) attachRefusal("invalid").put("message", "sign-in-code")
            else name.open(it)
        }
        val named = upload(name)
        assertEquals("sign-in-code", named.marker)
        assertEquals("the file name looks like a sign-in code; rename the file", Attach.words(named))

        val send = DocumentTestLink().apply { sendImage = { attachRefusal("invalid").put("message", "sign-in-code") } }
        val caption = upload(send)
        assertEquals("send", caption.failedOperation)
        assertEquals("sign-in-code", caption.marker)
        assertEquals("the message looks like a sign-in code; edit it", Attach.words(caption))

        val model = upload(DocumentTestLink().apply { sendImage = { attachRefusal("rejected", "MODEL_DOES_NOT_SUPPORT_IMAGES") } })
        assertEquals(AttachmentKind.IMAGE, model.failedKind)
        assertEquals("this Bot's model can't read images", Attach.words(model))
        assertEquals("", model.marker)
    }
}

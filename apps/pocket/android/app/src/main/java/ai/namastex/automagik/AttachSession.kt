package ai.namastex.automagik

import android.graphics.Bitmap
import android.net.Uri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.consumeEach
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

internal data class Pick(
    val token: String, val ref: TerminalRef, val draftEpoch: Long, val slots: Int, val kind: AttachmentKind
)
internal data class Waiting(val token: String, val ref: TerminalRef, val uris: List<Uri>)

internal data class AttachState(
    val peer: Attach.Peer = Attach.Peer.NotAsked, val watchGen: Long = 0,
    val draft: List<Prepared> = emptyList(), val preparing: Int = 0, val pendingPick: Pick? = null,
    val waiting: Waiting? = null, val messages: List<ImageMessage> = emptyList(),
    val shown: Map<String, Bitmap> = emptyMap(), val loading: String? = null
) {
    val heldBytes get() = draft.sumOf { it.heldBytes } + messages.sumOf { it.heldBytes }
    companion object { val EMPTY = AttachState() }
}

internal sealed interface Submit {
    data object Accepted : Submit
    data class Refused(val notice: String) : Submit
    data object Text : Submit
}

/** One in-memory attachment session per open chat, independent of the text reducers. */
internal class AttachSession(
    private val scope: CoroutineScope,
    private val chat: () -> Chat.State?,
    private val ref: () -> TerminalRef?,
    private val demo: () -> Boolean,
    private val link: () -> ChatLink?,
    private val notice: (String) -> Unit,
    internal var prepare: suspend (Uri, Attach.Offer) -> Prepared,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val preparation: CoroutineDispatcher = Dispatchers.Default.limitedParallelism(1),
    internal var prepareDocument: suspend (Uri, Attach.DocumentOffer, () -> Boolean) -> Prepared = { _, _, _ ->
        throw AttachDocument.Refusal(AttachDocument.PICK_FILE)
    }
) {
    internal data class Watch(val token: Long, val gen: Int, val ready: Boolean = false, val session: String? = null)
    private data class Transfer(val attempt: Attempt, val sender: AttachSender)
    private data class Target(val watch: Watch, val offer: Attach.Offer, val link: ChatLink, val terminal: String)

    private val lock = Any()
    private val preparationSlot = Mutex()
    private val _state = MutableStateFlow(AttachState.EMPTY)
    val state = _state.asStateFlow()
    private val tokens = AtomicLong()
    @Volatile private var watch: Watch? = null
    private var linkGen: Int? = null
    private var withdrawnGen: Int? = null
    private var closedGen = Int.MIN_VALUE
    private var draftEpoch = 0L
    private var pendingToken: String? = null
    private var pickTimeout: Job? = null
    private var prepareJob: Job? = null
    private var readJob: Job? = null
    private var lastCleanup: Job? = null
    private val transfers = mutableMapOf<String, Transfer>()
    private val pickReady = Channel<Unit>(Channel.CONFLATED)
    private var waitingPick: Pick? = null

    init {
        scope.launch(io) {
            pickReady.consumeEach { synchronized(lock) { startWaiting() } }
        }
    }

    private inline fun update(change: (AttachState) -> AttachState) { _state.value = change(_state.value) }

    fun linkOpened(gen: Int, peer: Attach.Peer): Unit = synchronized(lock) {
        if (gen <= closedGen || gen < (linkGen ?: gen)) return@synchronized
        linkGen = gen
        update { it.copy(peer = if (withdrawnGen == gen) Attach.withoutDocuments(peer) else peer) }
        pickReady.trySend(Unit)
        Unit
    }

    fun linkClosed(gen: Int) = synchronized(lock) {
        closedGen = maxOf(closedGen, gen)
        if (linkGen != gen) return@synchronized
        linkGen = null
        clearWatch()
        update { it.copy(peer = Attach.Peer.NotAsked) }
    }

    fun watchStarted(gen: Int): Long = synchronized(lock) {
        val token = tokens.incrementAndGet()
        if (linkGen == gen) {
            clearWatch()
            watch = Watch(token, gen)
            update { it.copy(watchGen = token) }
        }
        token
    }

    fun event(token: Long, event: JSONObject): Unit = synchronized(lock) {
        val current = watch?.takeIf { it.token == token } ?: return@synchronized
        when (event.optString("type")) {
            "snapshot" -> {
                val session = eventSession(event)
                watch = current.copy(ready = true, session = session)
                update { s -> s.copy(messages = s.messages.map { m ->
                    if ((m.watchToken != token || current.ready) && (m.anchor == null || m.anchor != session)) m.copy(continuity = false) else m
                }) }
                pickReady.trySend(Unit)
                refreshDraft()
            }
            "rows" -> if (current.session == null) watch = current.copy(session = eventSession(event))
            "gone" -> {
                clearWatch()
                if (event.optString("reason") in setOf("moved", "ended")) {
                    update { s -> s.copy(messages = s.messages.map { it.copy(continuity = false) }) }
                }
            }
        }
        Unit
    }

    private fun eventSession(event: JSONObject): String? {
        val rows = event.optJSONArray("rows") ?: return null
        return (0 until rows.length()).mapNotNull { index ->
            rows.optJSONObject(index)?.optString("id")?.let(Attach::sessionOf)
        }.distinct().singleOrNull()
    }

    fun watchEnded(token: Long) = synchronized(lock) {
        if (watch?.token != token) return@synchronized
        clearWatch()
    }

    internal fun live(token: Long) = watch?.let { it.token == token && it.ready } == true
    internal fun watchReady() = watch?.ready == true

    private fun clearWatch() {
        watch = null
        readJob?.cancel()
        readJob = null
        update { it.copy(shown = emptyMap(), loading = null) }
    }

    fun closed(keep: Boolean, gen: Int? = null) = synchronized(lock) {
        (gen ?: linkGen)?.let(::linkClosed)
        clearWatch()
        if (keep) {
            update { s -> s.copy(messages = s.messages.filter { it.active || it.images.isNotEmpty() || it.action != AttachAction.NONE }) }
        } else {
            draftEpoch++
            clearPick()
            prepareJob?.cancel()
            prepareJob = null
            for (transfer in transfers.values) cancelTransfer(transfer)
            transfers.clear()
            _state.value = AttachState.EMPTY
        }
    }

    fun pick(): Int? = pick(AttachmentKind.IMAGE)?.slots

    fun pick(kind: AttachmentKind): Pick? = synchronized(lock) {
        if (demo()) return@synchronized tell(ChatDemo.SAMPLE_ONLY)
        val s = _state.value
        val offer = (s.peer as? Attach.Peer.Offered)?.offer ?: return@synchronized tell(Attach.partWords(s.peer))
        if (s.messages.any { it.active }) return@synchronized tell(WAIT_SENDING)
        if (s.pendingPick != null || s.waiting != null || s.preparing > 0) return@synchronized tell(WAIT_PREPARING)
        if (!watchReady() || chat()?.let(ChatActions::canSend) != true) return@synchronized tell(WAIT_CONNECTED)
        if (kind == AttachmentKind.DOCUMENT && offer.documents == null) return@synchronized tell(PICK_AGAIN)
        val openRef = ref() ?: return@synchronized null
        val slots = offer.files - s.draft.size
        if (slots <= 0) return@synchronized tell(slotWords(kind, offer.files))
        val pick = Pick(UUID.randomUUID().toString(), openRef, draftEpoch, slots, kind)
        pendingToken = pick.token
        update { it.copy(pendingPick = pick) }
        pick
    }

    private fun tell(words: String): Nothing? { notice(words); return null }

    fun pickDiscarded(kind: AttachmentKind, token: String?, hasResult: Boolean) = synchronized(lock) {
        val pending = _state.value.pendingPick
        if (pending?.matches(kind, token) == true) clearPick()
        if (pendingToken == null && hasResult) notice(PICK_AGAIN)
    }

    private fun clearPick() {
        pendingToken = null
        waitingPick = null
        pickTimeout?.cancel()
        pickTimeout = null
        update { it.copy(pendingPick = null, waiting = null) }
    }

    fun picked(uris: List<Uri>) = synchronized(lock) {
        picked(AttachmentKind.IMAGE, _state.value.pendingPick?.token, uris)
    }

    fun picked(kind: AttachmentKind, token: String?, uris: List<Uri>): Unit = synchronized(lock) {
        val pick = _state.value.pendingPick
        if (pick == null || !pick.matches(kind, token)) {
            if (pendingToken == null && uris.isNotEmpty()) notice(PICK_AGAIN)
            return@synchronized
        }
        if (!matches(pick)) {
            clearPick()
            if (uris.isNotEmpty()) notice(PICK_AGAIN)
            return@synchronized
        }
        if (uris.isEmpty()) { clearPick(); return@synchronized }
        if (uris.size > pick.slots) notice("Added the first ${pick.slots} (up to ${_state.value.draft.size + pick.slots} per message).")
        waitingPick = pick
        update { it.copy(pendingPick = null, waiting = Waiting(pick.token, pick.ref, uris.take(pick.slots))) }
        pickTimeout = scope.launch {
            delay(20_000)
            synchronized(lock) {
                if (_state.value.waiting?.token == pick.token) {
                    clearPick()
                    notice(PICK_AGAIN)
                }
            }
        }
        pickReady.trySend(Unit)
        Unit
    }

    private fun startWaiting() {
        val waiting = _state.value.waiting ?: return
        val pick = waitingPick?.takeIf { it.token == waiting.token } ?: return
        val peer = _state.value.peer
        val locked = AppLock.locked()
        if (!matches(pick) || locked || (peer !is Attach.Peer.Offered && peer != Attach.Peer.NotAsked)) {
            clearPick()
            notice(if (pick.kind == AttachmentKind.IMAGE && matchesRefAndEpoch(pick) && !locked)
                Attach.partWords(peer) else PICK_AGAIN)
            return
        }
        val readingWatch = watch?.takeIf { it.ready } ?: return
        if (peer !is Attach.Peer.Offered) return
        val offer = peer.offer
        if (pick.kind == AttachmentKind.DOCUMENT && offer.documents == null) {
            clearPick()
            notice(PICK_AGAIN)
            return
        }
        val slots = (offer.files - _state.value.draft.size).coerceAtLeast(0)
        val uris = waiting.uris.take(slots)
        if (uris.isEmpty()) {
            clearPick()
            notice(slotWords(pick.kind, offer.files))
            return
        }
        if (uris.size < waiting.uris.size) notice("Added the first ${uris.size} (up to ${offer.files} per message).")
        waitingPick = null
        pickTimeout?.cancel()
        pickTimeout = null
        update { it.copy(waiting = null, preparing = uris.size) }
        prepareJob = scope.launch(preparation) {
            preparationSlot.withLock {
                for (uri in uris) {
                    val hasRoom = synchronized(lock) {
                        if (!canRead(pick, readingWatch, offer)) {
                            warnStalePick(pick)
                            return@synchronized null
                        }
                        pick.kind == AttachmentKind.IMAGE || reserveDocument(requireNotNull(offer.documents))
                    } ?: break
                    val result = if (hasRoom) prepareOne(uri, offer, pick.kind) {
                        synchronized(lock) { canRead(pick, readingWatch, offer) }
                    } else Preparation(words = OVER_BUDGET)
                    val published = synchronized(lock) {
                        if (!canRead(pick, readingWatch, offer)) {
                            result.image?.preview?.recycle()
                            warnStalePick(pick)
                            false
                        } else {
                            result.words?.let(notice)
                            result.image?.let(::addDraft)
                            update { it.copy(preparing = it.preparing - 1) }
                            true
                        }
                    }
                    if (!published) break
                }
            }
            synchronized(lock) {
                if (pendingToken == pick.token) {
                    pendingToken = null
                    update { it.copy(preparing = 0) }
                    refreshDraft()
                }
            }
        }
    }

    private fun Pick.matches(kind: AttachmentKind, token: String?) = this.kind == kind && this.token == token

    private fun warnStalePick(pick: Pick) {
        if (pendingToken == pick.token || (pick.kind == AttachmentKind.DOCUMENT && pendingToken == null && watchReady()))
            notice(PICK_AGAIN)
    }

    private fun canRead(pick: Pick, readingWatch: Watch, offer: Attach.Offer): Boolean {
        if (AppLock.locked() || !matches(pick) || linkGen != readingWatch.gen || !live(readingWatch.token)) return false
        val current = (_state.value.peer as? Attach.Peer.Offered)?.offer ?: return false
        return pick.kind == AttachmentKind.IMAGE || current.documents == offer.documents
    }

    private fun reserveDocument(offer: Attach.DocumentOffer): Boolean {
        val extra = offer.fileBytes.toLong() + 1
        makeRoom(extra)
        return _state.value.heldBytes + extra <= Attach.HELD_BYTES
    }

    private fun matchesRefAndEpoch(pick: Pick) = pick.ref == ref() && pick.draftEpoch == draftEpoch
    private fun matches(pick: Pick) = pendingToken == pick.token && matchesRefAndEpoch(pick)

    fun removeDraft(key: String) = synchronized(lock) {
        val s = _state.value
        if (s.draft.none { it.key == key }) return@synchronized
        draftEpoch++
        update { it.copy(draft = it.draft.filterNot { image -> image.key == key }) }
    }

    private fun addDraft(image: Prepared) {
        makeRoom(image.heldBytes)
        if (_state.value.heldBytes + image.heldBytes <= Attach.HELD_BYTES) update { it.copy(draft = it.draft + image) }
        else {
            image.preview?.recycle()
            notice(OVER_BUDGET)
        }
    }

    private fun makeRoom(extra: Long, except: String? = null) {
        var over = _state.value.heldBytes + extra - Attach.HELD_BYTES
        if (over <= 0) return
        update { s -> s.copy(messages = s.messages.map { m ->
            if (over > 0 && m.id != except && !m.active && (m.phase == Phase.MAYBE || m.action == AttachAction.RETRY)) {
                over -= m.heldBytes
                m.copy(images = emptyList())
            } else m
        }) }
    }

    fun submit(caption: String): Submit = synchronized(lock) {
        val s = _state.value
        if (s.draft.isEmpty() && s.preparing == 0 && s.pendingPick == null && s.waiting == null) return@synchronized Submit.Text
        if (watchReady() && documentDoesNotFit(s.draft, (s.peer as? Attach.Peer.Offered)?.offer))
            return@synchronized refuse(AttachDocument.DOES_NOT_FIT)
        val target = target { return@synchronized refuse(it) }
        if (s.preparing > 0 || s.pendingPick != null || s.waiting != null) return@synchronized refuse(WAIT_PREPARING)
        if (s.messages.any { it.active }) return@synchronized refuse(WAIT_SENDING)
        if (s.messages.count { it.images.isNotEmpty() } >= Attach.HELD_MESSAGES)
            return@synchronized refuse("Remove a picture message above first.")
        if (!fits(s.draft, target.offer)) return@synchronized refuse(limitWords(target.offer, s.draft))
        if (caption.length > CAPTION_BYTES || caption.toByteArray(Charsets.UTF_8).size > CAPTION_BYTES)
            return@synchronized refuse("The caption is too long (max 32 KB).")
        draftEpoch++
        start(newMessage(caption, s.draft, target.watch), target, moveDraft = true)
        Submit.Accepted
    }

    private fun refuse(words: String): Submit.Refused { notice(words); return Submit.Refused(words) }

    private inline fun target(refuse: (String) -> Nothing): Target {
        val s = chat()
        val offered = _state.value.peer
        val current = watch?.takeIf { it.ready }
        if (s == null || !ChatActions.canSend(s)) refuse(s?.let(ChatActions::whyNoSend) ?: WAIT_CONNECTED)
        val offer = (offered as? Attach.Peer.Offered)?.offer ?: refuse(Attach.partWords(offered))
        if (current == null) refuse(WAIT_CONNECTED)
        val connection = link() ?: refuse(WAIT_CONNECTED)
        if (!Attach.usable(offered, connection.dshWrite, s.terminal, true)) refuse(WAIT_CONNECTED)
        return Target(current, offer, connection, s.terminal)
    }

    private fun newMessage(caption: String, images: List<Prepared>, current: Watch) =
        ImageMessage(UUID.randomUUID().toString(), caption, images, current.session, current.token)

    private fun start(message: ImageMessage, target: Target, replace: String = message.id, moveDraft: Boolean = false) {
        val attempt = Attempt(target.watch.token, message.phase)
        val sender = AttachSender(target.link, target.terminal, target.offer, attempt, ::live,
            withdrawDocuments = { withdrawDocuments(target) }) { change ->
            synchronized(lock) {
                if (transfers[message.id]?.attempt === attempt)
                    update { s -> s.copy(messages = s.messages.map { if (it.id == message.id) change(it) else it }) }
            }
        }
        transfers[message.id] = Transfer(attempt, sender)
        update { s ->
            val messages = if (s.messages.any { it.id == replace })
                s.messages.map { if (it.id == replace) message else it } else s.messages + message
            s.copy(draft = if (moveDraft) emptyList() else s.draft, messages = messages)
        }
        val prior = lastCleanup
        scope.launch(io) {
            try {
                prior?.join()
                if (message.phase == Phase.SENDING) sender.send(message)
                else if (message.fileCount == 0 || !stopIfDocumentsLost(message, target.watch, attempt)) sender.upload(message)
            } finally {
                synchronized(lock) {
                    if (transfers[message.id]?.attempt === attempt) transfers.remove(message.id)
                }
            }
        }
    }

    private fun stopIfDocumentsLost(message: ImageMessage, targetWatch: Watch, attempt: Attempt): Boolean = synchronized(lock) {
        // A prior attempt can withdraw the grant while this one waits for its cleanup.
        val offer = (_state.value.peer as? Attach.Peer.Offered)?.offer
        if (!live(targetWatch.token) || !documentDoesNotFit(message.images, offer)) return@synchronized false
        if (transfers[message.id]?.attempt === attempt && attempt.phase.compareAndSet(Phase.UPLOADING, Phase.STOPPED)) {
            update { s -> s.copy(messages = s.messages.map {
                if (it.id == message.id) it.copy(phase = Phase.STOPPED, reason = "unsupported", failedOperation = "attach",
                    failedKind = AttachmentKind.DOCUMENT, action = AttachAction.RETRY) else it
            }) }
            notice(AttachDocument.DOES_NOT_FIT)
        }
        true
    }

    private fun withdrawDocuments(target: Target) = synchronized(lock) {
        if (linkGen == target.watch.gen && live(target.watch.token) && link() === target.link) {
            withdrawnGen = target.watch.gen
            update { it.copy(peer = Attach.withoutDocuments(it.peer)) }
        }
    }

    fun cancel(id: String, restore: Boolean): Boolean = synchronized(lock) {
        val transfer = transfers[id] ?: return@synchronized false
        val message = _state.value.messages.find { it.id == id } ?: return@synchronized false
        if (!cancelTransfer(transfer)) return@synchronized false
        val restoreDraft = restore && _state.value.draft.isEmpty()
        update { s ->
            if (restoreDraft) {
                s.copy(draft = message.images, messages = s.messages.filterNot { it.id == id })
            } else s.copy(messages = s.messages.map {
                if (it.id == id) it.copy(phase = Phase.CANCELLED, action = AttachAction.SEND_AGAIN) else it
            })
        }
        if (restoreDraft) draftEpoch++
        restoreDraft
    }

    private fun cancelTransfer(transfer: Transfer): Boolean {
        if (!transfer.attempt.cancel()) return false
        val prior = lastCleanup
        lastCleanup = scope.launch(io) {
            prior?.join()
            transfer.sender.cleanup()
        }
        return true
    }

    fun removeMessage(id: String) = synchronized(lock) {
        val message = _state.value.messages.find { it.id == id && !it.active } ?: return@synchronized
        if (message.images.isEmpty() && message.action == AttachAction.NONE) return@synchronized
        update { it.copy(messages = it.messages.filterNot { m -> m.id == id }) }
    }

    private fun continuous(m: ImageMessage, current: Watch?) = m.continuity && current?.ready == true &&
        (current.token == m.watchToken || (m.anchor != null && current.session == m.anchor))

    fun action(m: ImageMessage, s: AttachState): AttachAction {
        if (m.phase != Phase.STOPPED) return m.action
        val offer = (s.peer as? Attach.Peer.Offered)?.offer
        return if (continuous(m, watch) && (offer == null || fits(m.images, offer))) AttachAction.RETRY
            else AttachAction.SEND_AGAIN
    }

    fun stoppedAfterMove(m: ImageMessage) = watchReady() && !continuous(m, watch)

    fun retry(id: String, confirmed: Boolean = false, restoreCaption: (String) -> Unit = {}) = synchronized(lock) {
        val m = _state.value.messages.find { it.id == id && !it.active } ?: return@synchronized
        val action = action(m, _state.value)
        if (action == AttachAction.NONE) return@synchronized
        val replay = action == AttachAction.RETRY && m.sendWritten
        if (!replay && watchReady() && documentDoesNotFit(m.images, (_state.value.peer as? Attach.Peer.Offered)?.offer)) {
            notice(AttachDocument.DOES_NOT_FIT)
            return@synchronized
        }
        val target = target { notice(it); return@synchronized }
        if (_state.value.messages.any { it.active }) { notice(WAIT_SENDING); return@synchronized }
        if (_state.value.preparing > 0) { notice(WAIT_PREPARING); return@synchronized }
        if (replay) {
            start(m.copy(phase = Phase.SENDING, action = AttachAction.NONE), target)
            return@synchronized
        }
        if (m.uncertain && !confirmed) return@synchronized
        if (m.images.isEmpty()) {
            if (_state.value.draft.isEmpty()) restoreCaption(m.caption)
            notice(PICK_AGAIN)
            return@synchronized
        }
        if (action == AttachAction.RETRY) {
            start(m.copy(phase = Phase.UPLOADING, progress = 0f, done = 0, reason = "", code = "",
                marker = "", failedOperation = "", failedKind = null,
                uploads = emptyList(), action = AttachAction.NONE), target)
        } else if (fits(m.images, target.offer)) {
            start(newMessage(m.caption, m.images, target.watch), target, m.id)
        } else if (m.images.size > target.offer.files || m.images.all { it.fits(target.offer) }) {
            notice(limitWords(target.offer, m.images))
        } else {
            val capturedRef = ref()
            reprepare(m.images, target.offer) { images ->
                if (ref() != capturedRef || !live(target.watch.token) || chat()?.let(ChatActions::canSend) != true ||
                    _state.value.messages.none { it.id == id } || _state.value.messages.any { it.active }) return@reprepare false
                val effective = (_state.value.peer as? Attach.Peer.Offered)?.offer
                if (documentDoesNotFit(images, effective)) { notice(AttachDocument.DOES_NOT_FIT); return@reprepare false }
                if (!fits(images, target.offer)) { notice(limitWords(target.offer, m.images)); return@reprepare false }
                makeRoom(images.sumOf { it.heldBytes } - m.heldBytes, m.id)
                if (_state.value.heldBytes - m.heldBytes + images.sumOf { it.heldBytes } > Attach.HELD_BYTES) {
                    notice(OVER_BUDGET)
                    return@reprepare false
                }
                start(newMessage(m.caption, images, target.watch), target, m.id)
                true
            }
        }
    }

    private fun refreshDraft() {
        val s = _state.value
        val current = watch?.takeIf { it.ready } ?: return
        val offer = (s.peer as? Attach.Peer.Offered)?.offer
        if (s.preparing > 0 || s.pendingPick != null || s.waiting != null) return
        if (documentDoesNotFit(s.draft, offer)) notice(AttachDocument.DOES_NOT_FIT)
        if (offer == null || s.draft.none { it.kind == AttachmentKind.IMAGE && !it.fits(offer) }) return
        val epoch = draftEpoch
        val capturedRef = ref()
        reprepare(s.draft, offer) { images ->
            if (draftEpoch != epoch || ref() != capturedRef || !live(current.token)) return@reprepare false
            val replaced = images.sumOf { it.heldBytes } - s.draft.sumOf { it.heldBytes }
            makeRoom(replaced)
            if (_state.value.heldBytes + replaced > Attach.HELD_BYTES) {
                notice(OVER_BUDGET)
                return@reprepare false
            }
            update { it.copy(draft = images) }
            true
        }
    }

    private fun reprepare(original: List<Prepared>, offer: Attach.Offer, publish: (List<Prepared>) -> Boolean) {
        val token = UUID.randomUUID().toString()
        val preparingOn = watch?.token
        pendingToken = token
        update { it.copy(preparing = original.count { it.kind == AttachmentKind.IMAGE && !it.fits(offer) }) }
        prepareJob = scope.launch(preparation) {
            val replacements = mutableListOf<Prepared>()
            var kept = false
            try {
                preparationSlot.withLock {
                    val images = original.map { image ->
                        if (image.kind == AttachmentKind.DOCUMENT || image.fits(offer)) image else {
                            val result = prepareOne(Uri.parse(image.uri), offer)
                            result.image?.also { replacements += it } ?: run {
                                synchronized(lock) { if (pendingToken == token) notice(result.words ?: PICK_AGAIN) }
                                return@launch
                            }
                        }
                    }
                    synchronized(lock) { if (pendingToken == token) kept = publish(images) }
                }
            } finally {
                if (!kept) replacements.forEach { it.preview?.recycle() }
                synchronized(lock) {
                    if (pendingToken == token) {
                        pendingToken = null
                        update { it.copy(preparing = 0) }
                        if (watch?.token != preparingOn) refreshDraft()
                    }
                }
            }
        }
    }

    private data class Preparation(val image: Prepared? = null, val words: String? = null)

    private suspend fun prepareOne(
        uri: Uri, offer: Attach.Offer, kind: AttachmentKind = AttachmentKind.IMAGE, stillAllowed: () -> Boolean = { true }
    ): Preparation = try {
        Preparation(image = when (kind) {
            AttachmentKind.IMAGE -> prepare(uri, offer)
            AttachmentKind.DOCUMENT -> prepareDocument(uri, requireNotNull(offer.documents), stillAllowed)
        })
    } catch (e: CancellationException) {
        throw e
    } catch (e: AttachImage.Refusal) {
        Preparation(words = e.words)
    } catch (e: AttachDocument.Refusal) {
        Preparation(words = e.words)
    } catch (_: Exception) {
        Preparation(words = if (kind == AttachmentKind.IMAGE) "Couldn't prepare this picture." else "Couldn't prepare this file.")
    }

    fun show(row: Chat.Row, block: Attach.Block.Image) = synchronized(lock) {
        val s = _state.value
        val chat = chat() ?: return@synchronized
        val current = watch?.takeIf { it.ready } ?: return@synchronized
        val offer = (s.peer as? Attach.Peer.Offered)?.offer ?: run { notice(Attach.partWords(s.peer)); return@synchronized }
        val connection = link() ?: return@synchronized
        if (!Attach.usable(s.peer, connection.dshWrite, chat.terminal, true) || !ChatActions.canSend(chat)) return@synchronized
        val key = thumbKey(row.id, block.block)
        if (s.loading != null || key in s.shown || chat.rows.none { it.id == row.id && it.blocks?.contains(block) == true }) return@synchronized
        if (Attach.sessionOf(row.id) == null) { notice(Attach.readWords("invalid")); return@synchronized }
        update { it.copy(loading = key) }
        readJob = scope.launch(io) {
            var words = ""
            val bitmap = try {
                val reply = if (live(current.token)) connection.attachmentRead(chat.terminal, Attach.canonicalRow(row.id), block.block)
                    else return@launch
                words = Attach.readWords(if (reply.opt("ok") == false) reply.optString("reason") else "")
                AttachImage.thumbnail(reply, offer.thumbnail)
            } catch (_: TimeoutCancellationException) {
                words = Attach.readWords("offline")
                null
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                words = Attach.readWords("failed")
                null
            } catch (_: OutOfMemoryError) {
                words = Attach.readWords("invalid")
                null
            }
            synchronized(lock) {
                if (!live(current.token)) bitmap?.recycle()
                else {
                    if (bitmap == null) notice(words)
                    update { st ->
                        val shown = if (bitmap == null) st.shown else
                            (st.shown + (key to bitmap)).toList().takeLast(8).toMap()
                        st.copy(loading = null, shown = shown)
                    }
                }
            }
        }
    }

    companion object {
        private const val CAPTION_BYTES = 32_768
        private const val WAIT_SENDING = "Wait for the images above to finish sending."
        private const val WAIT_PREPARING = "Wait for the pictures to get ready."
        private const val WAIT_CONNECTED = "Wait for the chat to connect."
        private const val PICK_AGAIN = "Pick the images again."
        private const val OVER_BUDGET = "Too many pictures waiting on the phone. Send or remove some first."

        fun thumbKey(row: String, block: Int) = "$row#$block"

        private fun fits(images: List<Prepared>, offer: Attach.Offer) = images.size in 1..offer.files &&
            images.all { it.fits(offer) } && images.sumOf { it.bytes.size.toLong() } <= offer.messageBytes

        private fun documentDoesNotFit(items: List<Prepared>, offer: Attach.Offer?) =
            items.any { it.kind == AttachmentKind.DOCUMENT && (offer == null || !it.fits(offer)) }

        private fun slotWords(kind: AttachmentKind, files: Int) =
            if (kind == AttachmentKind.IMAGE) "Up to $files images per message." else "Up to $files attachments per message."

        private fun limitWords(offer: Attach.Offer, items: List<Prepared>): String {
            fun size(bytes: Int) = when {
                bytes % 1_048_576 == 0 -> "${bytes / 1_048_576} MB"
                bytes % 1024 == 0 -> "${bytes / 1024} KB"
                else -> "$bytes bytes"
            }
            if (items.any { it.kind == AttachmentKind.DOCUMENT })
                return "Up to ${offer.files} attachments, ${size(offer.messageBytes)} in all."
            return "Up to ${offer.files} images, ${size(offer.fileBytes)} each, ${size(offer.messageBytes)} in all."
        }
    }
}

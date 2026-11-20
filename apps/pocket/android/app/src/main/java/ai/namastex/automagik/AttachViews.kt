package ai.namastex.automagik

import android.content.ActivityNotFoundException
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt

/** All four launchers stay registered while the chat reconnects after a picker returns. */
@Composable
internal fun rememberAttachPicker(session: AttachSession): (Pick) -> Unit {
    val photo = rememberAttachLauncher(session, AttachmentKind.IMAGE, remember { PickVisualMedia() }) { listOfNotNull(it) }
    val photos = rememberAttachLauncher(session, AttachmentKind.IMAGE, remember { PickMultipleVisualMedia(4) }) { it }
    val file = rememberAttachLauncher(session, AttachmentKind.DOCUMENT, remember { OpenAttachDocument() }) { listOfNotNull(it) }
    val files = rememberAttachLauncher(session, AttachmentKind.DOCUMENT, remember { OpenAttachDocuments() }) { it }
    return { pick ->
        when (pick.kind) {
            AttachmentKind.IMAGE -> (if (pick.slots == 1) photo else photos)(pick, PickVisualMediaRequest(PickVisualMedia.ImageOnly))
            AttachmentKind.DOCUMENT -> (if (pick.slots == 1) file else files)(pick, arrayOf("*/*"))
        }
    }
}

private class AttachLauncher {
    var launchedToken: String? = null
}

@Composable
private fun <I, O> rememberAttachLauncher(
    session: AttachSession, kind: AttachmentKind, contract: ActivityResultContract<I, O>, uris: (O) -> List<Uri>
): (Pick, I) -> Unit {
    val launch = remember { AttachLauncher() }
    val launcher = rememberLauncherForActivityResult(contract) { result ->
        val token = launch.launchedToken
        launch.launchedToken = null
        deliverAttachPick(session, kind, token, uris(result))
    }
    return { pick, input ->
        // An outstanding result belongs to its original pick even if the chat has since changed.
        if (launch.launchedToken != null) session.pickDiscarded(kind, pick.token, true)
        else {
            launch.launchedToken = pick.token
            try {
                launcher.launch(input)
            } catch (_: ActivityNotFoundException) {
                launch.launchedToken = null
                session.pickDiscarded(kind, pick.token, true)
            } catch (_: SecurityException) {
                launch.launchedToken = null
                session.pickDiscarded(kind, pick.token, true)
            }
        }
    }
}

internal fun deliverAttachPick(session: AttachSession, uris: List<Uri>) =
    deliverAttachPick(session, AttachmentKind.IMAGE, session.state.value.pendingPick?.token, uris)

internal fun deliverAttachPick(session: AttachSession, kind: AttachmentKind, token: String?, uris: List<Uri>) {
    if (AppLock.locked()) session.pickDiscarded(kind, token, uris.isNotEmpty()) else session.picked(kind, token, uris)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AttachButton(s: Chat.State, att: AttachState, picker: (Pick) -> Unit, session: AttachSession) {
    if (!s.dsh || !ChatActions.canSend(s)) return
    val documents = (att.peer as? Attach.Peer.Offered)?.offer?.documents != null && session.live(att.watchGen)
    var sheet by remember(att.watchGen, documents) { mutableStateOf(false) }
    IconButton(onClick = {
        if (documents) sheet = true else session.pick(AttachmentKind.IMAGE)?.let(picker)
    }, modifier = Modifier.size(48.dp)) {
        Icon(Icons.Outlined.Add, if (documents) "Add images or files" else "Add images",
            tint = if (att.peer is Attach.Peer.Offered) Accent else Muted)
    }
    if (sheet) {
        ModalBottomSheet(onDismissRequest = { sheet = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = Raised, contentColor = Ink) {
            Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 28.dp)) {
                for ((label, kind) in listOf("Photos" to AttachmentKind.IMAGE, "Files" to AttachmentKind.DOCUMENT)) {
                    TextButton(onClick = {
                        sheet = false
                        session.pick(kind)?.let(picker)
                    }, modifier = Modifier.fillMaxWidth()) {
                        Text(label, color = Ink)
                    }
                }
            }
        }
    }
}

@Composable
internal fun AttachTray(att: AttachState, session: AttachSession) {
    if (att.draft.isEmpty() && att.preparing == 0) return
    val files = att.draft.filter { it.kind == AttachmentKind.DOCUMENT }
    Column(Modifier.padding(horizontal = 12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            for (image in att.draft) key(image.key) {
                Surface(color = Surface, shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, Border),
                    modifier = Modifier.size(64.dp)) {
                    Box {
                        image.preview?.let {
                            Image(remember(it) { it.asImageBitmap() }, "Selected image", Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                        }
                        val remove = if (image.kind == AttachmentKind.DOCUMENT) {
                            Column(Modifier.align(Alignment.BottomCenter).padding(bottom = 4.dp),
                                horizontalAlignment = Alignment.CenterHorizontally) {
                                val style = LocalTextStyle.current.copy(textDirection = TextDirection.Content)
                                Text(AttachDocument.trayLabel(image.name), color = Ink, fontSize = 12.sp, lineHeight = 13.sp, style = style)
                                Text(fileSize(image.bytes.size.toLong()), color = Muted, fontSize = 11.sp, lineHeight = 13.sp, style = style)
                            }
                            "Remove file ${files.indexOf(image) + 1} of ${files.size}"
                        } else "Remove image"
                        IconButton(onClick = { session.removeDraft(image.key) }, modifier = Modifier.align(Alignment.TopEnd).size(48.dp)) {
                            Surface(color = Raised, shape = RoundedCornerShape(12.dp)) {
                                Icon(Icons.Outlined.Close, remove, Modifier.size(16.dp), tint = Ink)
                            }
                        }
                    }
                }
            }
            if (att.preparing > 0) AttachSpinner()
        }
        if (att.draft.isNotEmpty()) {
            val slots = (att.peer as? Attach.Peer.Offered)?.offer?.files ?: 4
            val count = if (files.isEmpty()) "${att.draft.size} of $slots"
                else attachmentCount(att.draft.size - files.size, files.size)
            Text("$count · ${fileSize(att.draft.sumOf { it.bytes.size.toLong() })}", color = Muted, fontSize = 12.sp)
        }
    }
}

@Composable
internal fun UploadMessageView(
    m: ImageMessage, s: Chat.State, att: AttachState, session: AttachSession,
    onCancel: () -> Unit, restoreCaption: (String) -> Unit = {}
) {
    var confirm by remember(m.id) { mutableStateOf(false) }
    val action = session.action(m, att)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Surface(color = Accent.copy(alpha = .08f), shape = RoundedCornerShape(12.dp),
            border = BorderStroke(1.dp, Accent.copy(alpha = .3f)), modifier = Modifier.widthIn(max = 560.dp)) {
            Column(Modifier.padding(10.dp, 8.dp)) {
                if (m.caption.isNotBlank()) Text(ChatText.clean(m.caption), fontSize = 14.sp, lineHeight = 20.sp, color = Ink)
                Text(attachmentCount(m.imageCount, m.fileCount), fontSize = 12.sp, color = Muted)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (m.phase == Phase.UPLOADING) AttachSpinner()
                    Text(uploadLine(m, session), fontSize = 11.sp,
                        color = if (m.phase in setOf(Phase.MAYBE, Phase.REFUSED, Phase.STOPPED)) Blocked else Muted)
                }
                val removable = !m.active && (m.images.isNotEmpty() || action != AttachAction.NONE)
                if (m.phase == Phase.UPLOADING || removable || (action != AttachAction.NONE && ChatActions.canSend(s))) Row {
                    if (m.phase == Phase.UPLOADING) TextButton(onClick = onCancel) { Text("Cancel", fontSize = 12.sp) }
                    if (action != AttachAction.NONE && ChatActions.canSend(s)) {
                        val sendAsNew = action == AttachAction.SEND_AGAIN && m.uncertain && att.peer is Attach.Peer.Offered
                        TextButton(onClick = {
                            if (sendAsNew) confirm = true else session.retry(m.id, restoreCaption = restoreCaption)
                        }) {
                            Text(when {
                                action == AttachAction.RETRY -> "Retry"
                                m.uncertain -> "Send as new"
                                else -> "Send again"
                            }, fontSize = 12.sp)
                        }
                    }
                    if (removable) TextButton(onClick = { session.removeMessage(m.id) }) { Text("Remove", fontSize = 12.sp) }
                }
            }
        }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false },
        title = { Text("Send as a new message?") },
        text = {
            val items = if (m.fileCount == 0) "pictures" else "attachments"
            Text("The first one may already have reached the Bot. This sends the $items again as another message.")
        },
        confirmButton = { TextButton(onClick = {
            confirm = false
            session.retry(m.id, confirmed = true, restoreCaption = restoreCaption)
        }) { Text("Send") } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } })
}

internal fun attachmentCount(images: Int, files: Int): String = listOfNotNull(
    if (images == 0) null else if (images == 1) "1 image" else "$images images",
    if (files == 0) null else if (files == 1) "1 file" else "$files files"
).joinToString(", ")

internal fun uploadLine(m: ImageMessage, session: AttachSession) = when (m.phase) {
    Phase.UPLOADING -> "Uploading ${minOf(m.done + 1, m.count)} of ${m.count} · ${(m.progress * 100).roundToInt()}%"
    Phase.SENDING -> "Sending…"
    Phase.SENT -> "Sent"
    Phase.QUEUED -> "Queued: the agent reads it after this turn"
    Phase.CANCELLED -> "Cancelled: not sent"
    Phase.STOPPED -> if (session.stoppedAfterMove(m)) "Not sent: this Bot's chat changed on the computer."
        else "Not sent: the upload stopped (${Attach.words(m)})."
    Phase.MAYBE -> if (m.reason.isBlank()) "Maybe not sent"
        else "Maybe not sent. The retry was refused: ${Attach.words(m)}."
    Phase.REFUSED -> when {
        m.reason == "changed" -> "Not sent: this Retry didn't match the first message, which may already have reached the Bot."
        m.action == AttachAction.RETRY -> "Not sent (${Attach.words(m)})"
        else -> "Not sent: ${Attach.words(m)}"
    }
}

@Composable
internal fun AttachBlocks(row: Chat.Row, s: Chat.State, att: AttachState, session: AttachSession, openLink: (String, Boolean) -> Unit) {
    val blocks = remember(row.blocks) { Attach.renderable(row.blocks.orEmpty()) }
    if (blocks.isEmpty() && row.text.isNotBlank()) ChatTextView(row.text, openLink)
    for (block in blocks) when (block) {
        is Attach.Block.Text -> ChatTextView(block.text, openLink)
        is Attach.Block.Image -> {
            val key = AttachSession.thumbKey(row.id, block.block)
            val shown = att.shown[key]
            val size = "${block.width} × ${block.height}"
            Row(Modifier.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Image · $size", color = Muted, fontSize = 12.sp)
                if (att.loading == key) AttachSpinner()
                else if (shown == null) TextButton(enabled = att.loading == null && s.connected && !s.gone && !s.offline,
                    onClick = { session.show(row, block) }) { Text("Show", fontSize = 12.sp) }
            }
            if (shown != null) Image(remember(shown) { shown.asImageBitmap() }, "Image from the chat, $size",
                Modifier.sizeIn(maxWidth = 240.dp, maxHeight = 240.dp).clip(RoundedCornerShape(8.dp)),
                contentScale = ContentScale.Fit)
        }
        is Attach.Block.File -> Text(listOfNotNull("File", block.name, fileSize(block.bytes), "on the computer").joinToString(" · "),
            color = Muted, fontSize = 12.sp)
        is Attach.Block.More -> Text("+${block.count} more on the computer", color = Muted, fontSize = 12.sp)
    }
}

@Composable
private fun AttachSpinner() {
    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
}

private fun fileSize(bytes: Long): String {
    val (unit, label) = when {
        bytes >= 1_048_576 -> 1_048_576 to "MB"
        bytes >= 1024 -> 1024 to "KB"
        else -> return "$bytes B"
    }
    val tenths = (bytes * 10 + unit / 2) / unit
    return if (tenths % 10 == 0L) "${tenths / 10} $label" else "${tenths / 10}.${tenths % 10} $label"
}

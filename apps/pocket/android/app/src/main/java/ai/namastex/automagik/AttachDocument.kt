package ai.namastex.automagik

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.result.contract.ActivityResultContracts.OpenDocument
import androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.util.Locale
import java.util.UUID

internal class OpenAttachDocument : OpenDocument() {
    override fun createIntent(context: Context, input: Array<String>): Intent =
        super.createIntent(context, input).addCategory(Intent.CATEGORY_OPENABLE)
}

internal class OpenAttachDocuments : OpenMultipleDocuments() {
    override fun createIntent(context: Context, input: Array<String>): Intent =
        super.createIntent(context, input).addCategory(Intent.CATEGORY_OPENABLE)
}

internal class AttachDocument(
    private val query: (Uri) -> Cursor?,
    private val getType: (Uri) -> String?,
    private val open: (Uri) -> InputStream?
) {
    constructor(resolver: ContentResolver) : this(
        { uri -> resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null) },
        resolver::getType, resolver::openInputStream
    )
    class Refusal(val words: String) : IOException(words)

    fun prepare(uri: Uri, offer: Attach.DocumentOffer, stillAllowed: () -> Boolean = { true }): Prepared = try {
        if (!stillAllowed()) throw Refusal(PICK_FILE)
        var displayName: String? = null
        var size: Long? = null
        query(uri)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameColumn >= 0 && !cursor.isNull(nameColumn)) displayName = cursor.getString(nameColumn)
                if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn)
            }
        }

        val base = displayBase(displayName)
        if (base != null && !wellFormed(base)) throw Refusal(BAD_NAME)
        val type = Attach.documentType(getType(uri), base, offer) ?: throw Refusal(UNSUPPORTED_TYPE)
        val name = base?.let { cutName(it, 1024) }
        if (size?.let { it > offer.fileBytes } == true) throw Refusal(tooLarge(offer.fileBytes))
        if (!stillAllowed()) throw Refusal(PICK_FILE)
        val bytes = (open(uri) ?: throw Refusal(PICK_FILE)).use { read(it, offer.fileBytes) }
        if (bytes.isEmpty()) throw Refusal("This file is empty.")
        if (!(if (type == Attach.PDF) isPdf(bytes) else isText(bytes))) throw Refusal(INVALID_CONTENT)

        Prepared(UUID.randomUUID().toString(), "", type, bytes, 0, 0, kind = AttachmentKind.DOCUMENT, name = name)
    } catch (e: Refusal) {
        throw e
    } catch (_: IOException) {
        throw Refusal(PICK_FILE)
    } catch (_: SecurityException) {
        throw Refusal(PICK_FILE)
    } catch (_: IllegalArgumentException) {
        throw Refusal(PICK_FILE)
    } catch (_: OutOfMemoryError) {
        throw Refusal("Couldn't prepare this file.")
    }

    companion object {
        internal const val DOES_NOT_FIT = "This file can't be sent on this connection; remove it or pick it again."
        internal const val PICK_FILE = "Pick the file again."
        private const val BAD_NAME = "This file's name can't be sent; rename it and pick it again."
        private const val INVALID_CONTENT = "The computer can't take this file: it isn't a valid TXT/PDF."
        private const val UNSUPPORTED_TYPE = "The computer can't take this file. Pick a TXT or PDF."
        private const val READ_CHUNK = 64 * 1024
        private val pdfHeader = "%PDF-".toByteArray(Charsets.US_ASCII)

        private fun tooLarge(cap: Int): String {
            val mb = cap.toBigDecimal().divide(1_048_576.toBigDecimal()).stripTrailingZeros()
            return "Too large for the computer (max ${mb.toPlainString()} MB)."
        }

        internal fun displayBase(name: String?): String? =
            name?.substringAfterLast('/')?.substringAfterLast('\\')?.takeIf { it.isNotEmpty() }

        internal fun wellFormed(name: String): Boolean {
            var index = 0
            while (index < name.length) {
                val point = name.codePointAt(index)
                if (point in 0xD800..0xDFFF) return false
                index += Character.charCount(point)
            }
            return true
        }

        private fun cutName(name: String, limit: Int): String {
            var index = 0
            var bytes = 0
            while (index < name.length) {
                val point = name.codePointAt(index)
                bytes += when {
                    point <= 0x7F -> 1
                    point <= 0x7FF -> 2
                    point <= 0xFFFF -> 3
                    else -> 4
                }
                if (bytes > limit) break
                index += Character.charCount(point)
            }
            return name.substring(0, index)
        }

        private fun isControl(point: Int): Boolean {
            val category = Character.getType(point)
            return category == Character.CONTROL.toInt() || category == Character.FORMAT.toInt()
        }

        internal fun admittedName(name: String, type: String): Boolean {
            val extension = if (type == Attach.PDF) ".pdf" else ".txt"
            return name.endsWith(extension) && wellFormed(name) && name.toByteArray(Charsets.UTF_8).size <= 128 &&
                '/' !in name && '\\' !in name && cleanName(name) == name
        }

        private fun cleanName(name: String): String = buildString {
            var index = 0
            while (index < name.length) {
                val point = name.codePointAt(index)
                if (!isControl(point)) appendCodePoint(point)
                index += Character.charCount(point)
            }
        }

        internal fun suffixType(name: String?): String? =
            when (name?.substringAfterLast('.', "")?.lowercase(Locale.ROOT)) {
                "pdf" -> Attach.PDF
                "txt" -> Attach.TXT
                else -> null
            }

        // The tray draws only fixed labels from the final ASCII suffix, never the supplied stem.
        internal fun trayLabel(name: String?): String = when (suffixType(name)) {
            Attach.PDF -> "PDF"
            Attach.TXT -> "TXT"
            else -> "File"
        }

        internal fun words(reason: String, code: String): String = when (reason) {
            "unsupported" -> when (code) {
                Attach.FILES_UNSUPPORTED -> "the computer doesn't take files"
                "SUBAGENT_FILE_UNSUPPORTED" -> "this Bot can't take files now"
                else -> "the computer couldn't take this file"
            }
            "rejected" -> if (code == "timeout") "the computer took too long to take the file"
                else "the computer refused this file"
            "unavailable" -> "the computer couldn't take this file right now"
            "expired" -> "the files expired on the computer"
            "quota" -> "the computer takes no more attachments now (daily limit or low disk); try later"
            "busy" -> "the computer is busy with another attachment"
            else -> Attach.words(reason, code)
        }

        private fun read(stream: InputStream, cap: Int): ByteArray {
            val chunks = mutableListOf<ByteArray>()
            var size = 0
            while (true) {
                val chunk = ByteArray(minOf(READ_CHUNK, cap + 1 - size))
                chunks += chunk
                var offset = 0
                while (offset < chunk.size) {
                    val read = stream.read(chunk, offset, chunk.size - offset)
                    if (read < 0) break
                    if (read == 0) {
                        val byte = stream.read()
                        if (byte < 0) break
                        chunk[offset++] = byte.toByte()
                    } else offset += read
                }
                size += offset
                if (size > cap) throw Refusal(tooLarge(cap))
                if (offset < chunk.size) break
            }
            val result = ByteArray(size)
            var copied = 0
            for (chunk in chunks) {
                val length = minOf(chunk.size, size - copied)
                chunk.copyInto(result, destinationOffset = copied, endIndex = length)
                copied += length
            }
            return result
        }

        private fun isPdf(bytes: ByteArray) =
            bytes.size >= pdfHeader.size && pdfHeader.indices.all { bytes[it] == pdfHeader[it] }

        private fun isText(bytes: ByteArray): Boolean {
            if (0.toByte() in bytes) return false
            val decoder = Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            val input = ByteBuffer.wrap(bytes)
            val scratch = CharBuffer.allocate(4096)
            while (true) {
                val result = decoder.decode(input, scratch, true)
                if (result.isError) return false
                scratch.clear()
                if (result.isUnderflow) break
            }
            return decoder.flush(scratch).isUnderflow
        }
    }
}

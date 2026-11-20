package ai.namastex.automagik

import android.app.Application
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.provider.OpenableColumns
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.FileNotFoundException
import java.io.InputStream

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AttachDocumentTest {
    private val uri = Uri.parse("content://fixture/uri-must-not-be-used.txt")
    private val valid = "notes".toByteArray()

    private class Source(private val bytes: ByteArray, private val oneByte: Boolean = false) : InputStream() {
        var consumed = 0
            private set
        var closed = false
            private set

        override fun read(): Int = if (consumed == bytes.size) -1 else bytes[consumed++].toInt() and 0xff

        override fun read(out: ByteArray, offset: Int, length: Int): Int {
            if (consumed == bytes.size) return -1
            val count = minOf(length, bytes.size - consumed, if (oneByte) 1 else length)
            bytes.copyInto(out, offset, consumed, consumed + count)
            consumed += count
            return count
        }

        override fun close() { closed = true }
    }

    private fun metadata(name: String? = null, size: Long? = null) =
        MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply { addRow(arrayOf<Any?>(name, size)) }

    private fun prepare(
        stream: Source, mime: String? = Attach.TXT, cursor: Cursor? = null, cap: Int = 8_388_608
    ): Prepared = AttachDocument({ cursor }, { mime }, { stream }).prepare(uri, testDocuments(cap))

    private fun refusal(block: () -> Unit): String {
        return try {
            block()
            error("Expected a local file refusal")
        } catch (e: AttachDocument.Refusal) {
            e.words
        }
    }

    @Test fun contractsOpenOnlyOpenableEntriesWithWildcardAndSetMultipleOnlyForMany() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val filter = arrayOf("*/*")
        val single = OpenAttachDocument().createIntent(app, filter)
        val multiple = OpenAttachDocuments().createIntent(app, filter)
        for (intent in listOf(single, multiple)) {
            assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.action)
            assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE))
            assertEquals("*/*", intent.type)
            assertArrayEquals(filter, intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES))
        }
        assertFalse(single.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
        assertTrue(multiple.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
    }

    @Test fun explicitMimeWinsAndOnlyMissingOrGenericMimeUsesTheLastSuffix() {
        val offer = testDocuments()
        for (mime in listOf(null, "", " application/octet-stream ; x=y")) {
            assertEquals(Attach.PDF, Attach.documentType(mime, "sample.txt.PdF", offer))
            assertEquals(Attach.TXT, Attach.documentType(mime, "sample.TxT", offer))
            assertNull(Attach.documentType(mime, "sample.txt.backup", offer))
            assertNull(Attach.documentType(mime, null, offer))
        }
        assertEquals(Attach.PDF, Attach.documentType(" Application/PDF ; charset=UTF-8", "sample.txt", offer))
        assertEquals(Attach.TXT, Attach.documentType(" TEXT/PLAIN ; charset=UTF-8", "sample.pdf", offer))
        assertNull(Attach.documentType("text/html", "sample.txt", offer))
        assertNull(Attach.documentType("image/svg+xml", "sample.txt", offer))
        assertNull(Attach.documentType(Attach.PDF, "sample.pdf", testDocuments(types = setOf(Attach.TXT))))
        val unopened = Source(valid)
        refusal { prepare(unopened, "text/html", metadata("sample.txt")) }
        assertEquals(0, unopened.consumed)
        assertFalse(unopened.closed)
    }

    @Test fun missingOrEmptyNamesStayAbsentAndBothSlashStylesUseOnlyTheBase() {
        for (cursor in listOf(null, MatrixCursor(arrayOf("other")).apply { addRow(arrayOf("value")) },
            MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME)), metadata(), metadata(""), metadata("dir/"))) {
            val item = prepare(Source(valid), cursor = cursor)
            assertNull(item.name)
            assertEquals("", item.uri)
            if (cursor != null) assertTrue(cursor.isClosed)
        }
        for (name in listOf("a/b/report.txt", "a\\b\\report.txt", "a\\b/report.txt")) {
            assertEquals("report.txt", prepare(Source(valid), cursor = metadata(name)).name)
        }
    }

    @Test fun missingSizeColumnDoesNotPreventReadingTheActualBytes() {
        val cursor = MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME)).apply {
            addRow(arrayOf<Any?>("folder/notes.txt"))
        }
        val stream = Source(valid, oneByte = true)
        val item = prepare(stream, cursor = cursor, cap = valid.size)
        assertEquals("notes.txt", item.name)
        assertArrayEquals(valid, item.bytes)
        assertTrue(cursor.isClosed)
        assertTrue(stream.closed)
    }

    @Test fun nameLimitsUseUtf8CodePointsAndTheFullBaseDeterminesType() {
        for (length in listOf(1023, 1024, 1025)) {
            val name = "a".repeat(length)
            assertEquals(name.take(1024), prepare(Source(valid), cursor = metadata(name)).name)
        }
        val prefix = "a".repeat(1022)
        val pair = "\uD83D\uDE00"
        assertEquals(prefix, prepare(Source(valid), cursor = metadata(prefix + pair + ".txt")).name)
        val exactPair = "a".repeat(1020) + pair
        assertEquals(exactPair, prepare(Source(valid), cursor = metadata(exactPair + ".txt")).name)
        for (surrogate in listOf("\uD800", "\uDC00")) {
            val source = Source(valid)
            assertEquals("This file's name can't be sent; rename it and pick it again.", refusal {
                prepare(source, cursor = metadata("a".repeat(1024) + surrogate))
            })
            assertEquals(0, source.consumed)
        }
        val pdf = prepare(Source("%PDF-".toByteArray()), null, metadata("a".repeat(1025) + ".PDF"))
        assertEquals(Attach.PDF, pdf.mediaType)
        assertEquals("a".repeat(1024), pdf.name)
    }

    @Test fun sizeIsOnlyAnEarlyHintAndReadsAlwaysStopAtCapPlusOne() {
        val exact = Source(valid, oneByte = true)
        assertArrayEquals(valid, prepare(exact, cursor = metadata(size = null), cap = 5).bytes)
        assertEquals(5, exact.consumed)
        assertTrue(exact.closed)

        for (hint in listOf(null, 1L)) {
            val long = Source(ByteArray(50) { 'x'.code.toByte() })
            assertTrue(refusal { prepare(long, cursor = metadata(size = hint), cap = 5) }.startsWith("Too large for the computer"))
            assertEquals(6, long.consumed)
            assertTrue(long.closed)
        }
        val neverOpened = AttachDocument({ metadata(size = Long.MAX_VALUE) }, { Attach.TXT }, { error("Size must refuse first") })
        assertEquals("Too large for the computer (max 8 MB).", refusal { neverOpened.prepare(uri, testDocuments()) })
        val empty = Source(byteArrayOf())
        assertEquals("This file is empty.", refusal { prepare(empty) })
        assertTrue(empty.closed)
    }

    @Test fun shortReadsValidateTextAtEofAndKeepBomAndMarkupVerbatim() {
        val text = "\uFEFF<p>caf\u00e9</p>".toByteArray()
        val split = Source(text, oneByte = true)
        assertArrayEquals(text, prepare(split).bytes)
        assertTrue(split.closed)
        for (bad in listOf(byteArrayOf(0xC3.toByte()), byteArrayOf(0xC3.toByte(), 0x28), byteArrayOf(65, 0, 66))) {
            val source = Source(bad, oneByte = true)
            assertEquals("The computer can't take this file: it isn't a valid TXT/PDF.", refusal { prepare(source) })
            assertTrue(source.closed)
        }
        val crossingChunk = ("a".repeat(65_535) + "\uD83D\uDE00").toByteArray()
        assertArrayEquals(crossingChunk, prepare(Source(crossingChunk)).bytes)
    }

    @Test fun pdfPrefixMustStartAtZeroAndCanSpanShortReads() {
        val pdf = "%PDF-\u0000".toByteArray()
        assertArrayEquals(pdf, prepare(Source(pdf, oneByte = true), Attach.PDF).bytes)
        for (bad in listOf("%PDF", " %PDF-", "%PdF-")) {
            val source = Source(bad.toByteArray(), oneByte = true)
            assertEquals("The computer can't take this file: it isn't a valid TXT/PDF.", refusal { prepare(source, Attach.PDF) })
            assertTrue(source.closed)
        }
    }

    @Test fun unreadableProvidersAndAuthorityLostDuringQueryNeverLeakProviderDetails() {
        val unavailable: List<(Uri) -> InputStream?> = listOf(
            { null }, { throw FileNotFoundException("fixture path") }, { throw SecurityException("fixture path") }
        )
        for (stream in unavailable) {
            assertEquals("Pick the file again.", refusal { AttachDocument({ null }, { Attach.TXT }, stream).prepare(uri, testDocuments()) })
        }
        var allowed = true
        val cursor = metadata("sample.txt")
        val delayed = AttachDocument({ allowed = false; cursor }, { Attach.TXT }, { error("Must check authority again") })
        assertEquals("Pick the file again.", refusal { delayed.prepare(uri, testDocuments()) { allowed } })
        assertTrue(cursor.isClosed)
    }

    @Test fun aReadFailureClosesTheStreamAndUsesFixedRefusalWords() {
        val stream = object : InputStream() {
            var closed = false
            override fun read(): Int = throw FileNotFoundException("private provider detail")
            override fun close() { closed = true }
        }
        val document = AttachDocument({ null }, { Attach.TXT }, { stream })
        assertEquals("Pick the file again.", refusal { document.prepare(uri, testDocuments()) })
        assertTrue(stream.closed)
    }
}

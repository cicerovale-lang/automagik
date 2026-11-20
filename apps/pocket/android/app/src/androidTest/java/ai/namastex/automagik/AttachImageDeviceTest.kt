package ai.namastex.automagik

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.media.ExifInterface
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.util.Base64
import java.util.zip.CRC32

@Suppress("DEPRECATION") // The disposable harness supplies androidx.test:runner.
@RunWith(androidx.test.runner.AndroidJUnit4::class)
class AttachImageDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    @get:Rule val tmp = TemporaryFolder(context.cacheDir)
    private val resolver get() = context.contentResolver

    private val offer = Attach.Offer(
        mediaTypes = setOf(Attach.PNG, Attach.JPEG, Attach.WEBP),
        fileBytes = 8_388_608,
        files = 4,
        messageBytes = 16_777_216,
        maxPixels = 40_000_000,
        maxDimension = 9_007_199_254_740_991L,
        chunkBytes = Attach.CHUNK_BYTES,
        thumbnail = Attach.Thumbnail(edge = 512, bytes = 131_072)
    )

    private fun image(bitmap: Bitmap, format: Bitmap.CompressFormat): ByteArray =
        ByteArrayOutputStream().also { assertTrue(bitmap.compress(format, 100, it)) }.toByteArray()

    private fun file(name: String, bytes: ByteArray) = tmp.newFile(name).apply { writeBytes(bytes) }
    private fun decode(bytes: ByteArray): Bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        ?: error("Fixture was not decoded")

    private fun corners(bitmap: Bitmap) = listOf(
        bitmap.getPixel(1, 1), bitmap.getPixel(bitmap.width - 2, 1),
        bitmap.getPixel(1, bitmap.height - 2), bitmap.getPixel(bitmap.width - 2, bitmap.height - 2)
    )

    private fun colorNear(expected: Int, actual: Int, sample: String = "pixel") {
        val message = "$sample: expected color ${expected.toUInt().toString(16)}, observed ${actual.toUInt().toString(16)}"
        assertTrue("$message (red)", kotlin.math.abs(Color.red(expected) - Color.red(actual)) <= 28)
        assertTrue("$message (green)", kotlin.math.abs(Color.green(expected) - Color.green(actual)) <= 28)
        assertTrue("$message (blue)", kotlin.math.abs(Color.blue(expected) - Color.blue(actual)) <= 28)
    }

    /** Supply the JPEG's input metadata directly so each API starts with the same EXIF. */
    private fun jpegWithExif(jpg: ByteArray, orientation: Int): ByteArray {
        assertEquals("Fixture JPEG starts with SOI", listOf(0xff, 0xd8), jpg.take(2).map { it.toInt() and 0xff })
        val tiff = ByteArrayOutputStream()
        DataOutputStream(tiff).apply {
            fun entry(tag: Int, type: Int, count: Int, value: Int) {
                writeShort(tag); writeShort(type); writeInt(count); writeInt(value)
            }
            val firstIfd = 8
            val gpsIfd = firstIfd + 2 + 2 * 12 + 4
            val latitude = gpsIfd + 2 + 5 * 12 + 4
            val longitude = latitude + 3 * 8

            writeShort(0x4d4d); writeShort(42); writeInt(firstIfd) // Big-endian TIFF header
            writeShort(2)
            entry(0x0112, 3, 1, orientation shl 16) // Orientation, an inline SHORT
            entry(0x8825, 4, 1, gpsIfd)
            writeInt(0) // No next IFD
            writeShort(5)
            entry(0, 1, 4, 0x02030000) // GPS version 2.3.0.0
            entry(1, 2, 2, 'N'.code shl 24)
            entry(2, 5, 3, latitude)
            entry(3, 2, 2, 'E'.code shl 24)
            entry(4, 5, 3, longitude)
            writeInt(0)
            repeat(2) { for (part in listOf(12, 34, 56)) { writeInt(part); writeInt(1) } }
        }
        return ByteArrayOutputStream().also { out ->
            DataOutputStream(out).use {
                it.write(jpg, 0, 2)
                it.writeShort(0xffe1)
                it.writeShort(2 + 6 + tiff.size())
                it.writeBytes("Exif\u0000\u0000")
                tiff.writeTo(it)
                // Android 8.0's EXIF reader requires a full 5,000-byte signature read.
                // A JPEG comment brings the tiny image above that limit with its pixels intact.
                val remainingJpegBytes = jpg.size - 2
                val shortfall = 5_000 - out.size() - remainingJpegBytes
                if (shortfall > 0) {
                    val comment = "RFC 0033 orientation fixture".padEnd(shortfall, ' ')
                    it.writeShort(0xfffe) // COM
                    it.writeShort(2 + comment.length)
                    it.writeBytes(comment)
                }
                it.write(jpg, 2, remainingJpegBytes)
            }
        }.toByteArray()
    }

    @Test fun imageDecoderOrientsJpegCornersAndRemovesApp1IncludingGps() {
        val palette = listOf(Color.RED, Color.GREEN, Color.BLUE, Color.YELLOW)
        val base = Bitmap.createBitmap(48, 32, Bitmap.Config.ARGB_8888)
        for (y in 0 until base.height) for (x in 0 until base.width)
            base.setPixel(x, y, palette[(if (y < 16) 0 else 2) + if (x < 24) 0 else 1])
        val jpg = image(base, Bitmap.CompressFormat.JPEG)
        base.recycle()

        val expected = listOf(
            listOf(0, 1, 2, 3), listOf(1, 0, 3, 2), listOf(3, 2, 1, 0), listOf(2, 3, 0, 1),
            listOf(0, 2, 1, 3), listOf(2, 0, 3, 1), listOf(3, 1, 2, 0), listOf(1, 3, 0, 2)
        )
        for (orientation in 1..8) {
            val input = jpegWithExif(jpg, orientation)
            val fixture = file("orientation-$orientation.jpg", input)
            val expectedExif = "D13 JPEG fixture for orientation $orientation"
            assertTrue("$expectedExif has APP1", jpegHasApp1(input))
            val exif = ExifInterface(fixture.path)
            assertEquals("$expectedExif orientation tag", orientation, exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, 0))
            assertNotNull("$expectedExif GPS latitude", exif.getAttribute(ExifInterface.TAG_GPS_LATITUDE))
            assertNotNull("$expectedExif GPS longitude", exif.getAttribute(ExifInterface.TAG_GPS_LONGITUDE))
            val prepared = try {
                AttachImage(resolver, forceLegacy = false).prepare(Uri.fromFile(fixture),
                    offer.copy(mediaTypes = setOf(Attach.JPEG)))
            } catch (error: AttachImage.Refusal) {
                throw AssertionError("D13 could not prepare the JPEG for orientation $orientation: ${error.words}", error)
            }
            assertEquals("D13 output width for orientation $orientation", if (orientation >= 5) 32 else 48, prepared.width)
            assertEquals("D13 output height for orientation $orientation", if (orientation >= 5) 48 else 32, prepared.height)
            assertFalse("D13 output still has APP1 for orientation $orientation", jpegHasApp1(prepared.bytes))
            val actual = decode(prepared.bytes)
            corners(actual).zip(expected[orientation - 1]).forEachIndexed { corner, (pixel, index) ->
                colorNear(palette[index], pixel, "D13 orientation $orientation, corner ${corner + 1}")
            }
            actual.recycle()
            prepared.preview?.recycle()
        }
    }

    @Test fun alphaPngAndWebpKeepPixelsWhileJpegFlattensOnWhiteAndPngDropsMetadata() {
        val source = Bitmap.createBitmap(24, 24, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.TRANSPARENT) }
        val png = image(source, Bitmap.CompressFormat.PNG)
        source.recycle()
        val fixture = file("alpha.png", withTextChunk(png))
        assertTrue("tEXt" in pngChunks(fixture.readBytes()))
        for (type in listOf(Attach.PNG, Attach.WEBP, Attach.JPEG)) {
            val prepared = AttachImage(resolver, forceLegacy = false)
                .prepare(Uri.fromFile(fixture), offer.copy(mediaTypes = setOf(type)))
            assertEquals(type, prepared.mediaType)
            val image = decode(prepared.bytes)
            if (type == Attach.JPEG) colorNear(Color.WHITE, image.getPixel(12, 12))
            else assertEquals(0, Color.alpha(image.getPixel(12, 12)))
            if (type == Attach.PNG)
                assertTrue(pngChunks(prepared.bytes).none { it in setOf("eXIf", "tEXt", "iTXt", "zTXt") })
            image.recycle()
            prepared.preview?.recycle()
        }
    }

    @Test fun imageDecoderBoundsLargeInputAndPreview() {
        val bitmap = Bitmap.createBitmap(6000, 4000, Bitmap.Config.RGB_565).apply { eraseColor(Color.BLUE) }
        val fixture = file("large.jpg", image(bitmap, Bitmap.CompressFormat.JPEG))
        bitmap.recycle()
        val prepared = AttachImage(resolver, forceLegacy = false).prepare(Uri.fromFile(fixture), offer)
        assertEquals(2048, prepared.width)
        assertTrue(prepared.height in 1363..1366)
        val preview = prepared.preview!!
        assertTrue(maxOf(preview.width, preview.height) <= 192)
        colorNear(Color.BLUE, preview.getPixel(preview.width / 2, preview.height / 2))
        preview.recycle()
    }

    @Test fun encoderStepsDownBeforeShrinkingAndPreviewsOnlyAcceptedOutput() {
        val bitmap = Bitmap.createBitmap(64, 32, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }
        val fixture = Uri.fromFile(file("small.jpg", image(bitmap, Bitmap.CompressFormat.JPEG)))
        bitmap.recycle()
        val smallOffer = offer.copy(fileBytes = 4096, mediaTypes = setOf(Attach.JPEG))
        val steps = mutableListOf<Pair<Int, Int>>()
        val prepared = AttachImage(resolver, forceLegacy = false) { candidate, format, quality, output ->
            steps += candidate.width to quality
            if (steps.size < 3) {
                try { output.write(ByteArray(smallOffer.fileBytes + 1)) } catch (_: IOException) { }
                false
            } else {
                // Give the encoded copy a different color without changing the decoded source.
                val encoded = Bitmap.createBitmap(candidate.width, candidate.height, Bitmap.Config.ARGB_8888)
                try {
                    encoded.eraseColor(Color.RED)
                    encoded.compress(format, quality, output)
                } finally {
                    encoded.recycle()
                }
            }
        }.prepare(fixture, smallOffer)
        assertEquals(listOf(64 to 90, 64 to 80, 48 to 80), steps)
        assertTrue(prepared.bytes.size <= smallOffer.fileBytes)
        val preview = prepared.preview!!
        colorNear(Color.RED, preview.getPixel(preview.width / 2, preview.height / 2))
        preview.recycle()
        val falseReturn = AttachImage(resolver, forceLegacy = false) { _, _, _, _ -> false }
        assertEquals("Couldn't prepare this picture.", assertThrows(AttachImage.Refusal::class.java) {
            falseReturn.prepare(fixture, smallOffer)
        }.words)
        assertEquals("Too large to send even after shrinking.", assertThrows(AttachImage.Refusal::class.java) {
            AttachImage(resolver, forceLegacy = false).prepare(fixture, smallOffer.copy(fileBytes = 1))
        }.words)
    }

    @Test fun animatedGifSendsOnlyTheFirstFrame() {
        val data = "R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7"
        val fixture = Uri.fromFile(file("animated.gif", Base64.getDecoder().decode(data)))
        val prepared = AttachImage(resolver, forceLegacy = false)
            .prepare(fixture, offer.copy(mediaTypes = setOf(Attach.PNG)))
        assertEquals(Attach.PNG, prepared.mediaType)
        val still = decode(prepared.bytes)
        assertEquals(Color.RED, still.getPixel(0, 0))
        still.recycle()
        prepared.preview?.recycle()
    }

    @Test fun imageDecoderRefusesUnreadableImagesLocally() {
        val garbage = Uri.fromFile(file("garbage.png", byteArrayOf(1, 2)))
        assertEquals("Couldn't prepare this picture.", assertThrows(AttachImage.Refusal::class.java) {
            AttachImage(resolver, forceLegacy = false).prepare(garbage, offer)
        }.words)
    }

    @Test fun webpEncodingMatchesPlatformGuarantees() {
        val sdk = android.os.Build.VERSION.SDK_INT
        val encoding = Attach.encoding(setOf(Attach.WEBP), alpha = true, sdk = sdk)
        assertEquals(Attach.WEBP, encoding.mediaType)
        assertEquals(sdk < 29, encoding.lossy)
        if (sdk >= 30) assertEquals(Attach.Kind.WEBP_LOSSLESS, encoding.kind)
        else assertEquals(Attach.Kind.WEBP, encoding.kind)
        val source = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888)
        for (y in 0 until 32) for (x in 0 until 32)
            source.setPixel(x, y, when { x < 8 -> Color.TRANSPARENT; x < 24 -> Color.argb(128, 128, 64, 32); else -> Color.RED })
        val fixture = Uri.fromFile(file("webp-source.png", image(source, Bitmap.CompressFormat.PNG)))
        val prepared = AttachImage(resolver, forceLegacy = false)
            .prepare(fixture, offer.copy(mediaTypes = setOf(Attach.WEBP)))
        assertEquals(Attach.WEBP, prepared.mediaType)
        val actual = decode(prepared.bytes)
        if (sdk >= 29) {
            for (y in 0 until 32) for (x in 0 until 32)
                assertEquals(source.getPixel(x, y), actual.getPixel(x, y))
        } else assertEquals(0, Color.alpha(actual.getPixel(2, 2)))
        source.recycle(); actual.recycle(); prepared.preview?.recycle()
    }

    private fun jpegHasApp1(data: ByteArray): Boolean {
        var offset = 2
        while (offset + 4 <= data.size && data[offset].toInt() and 255 == 255) {
            val marker = data[offset + 1].toInt() and 255
            if (marker == 0xe1) return true
            if (marker == 0xda || marker == 0xd9) return false
            offset += 2 + ((data[offset + 2].toInt() and 255) shl 8) + (data[offset + 3].toInt() and 255)
        }
        return false
    }

    private fun pngChunks(data: ByteArray): List<String> = buildList {
        val input = ByteBuffer.wrap(data)
        input.position(8)
        while (input.remaining() >= 12) {
            val size = input.int
            val type = ByteArray(4).also { input.get(it) }
            add(String(type, Charsets.US_ASCII))
            input.position(input.position() + size + 4)
        }
    }

    private fun withTextChunk(data: ByteArray): ByteArray {
        val field = "tEXtcomment\u0000synthetic".toByteArray()
        val crc = CRC32().apply { update(field) }
        val out = ByteArrayOutputStream()
        DataOutputStream(out).use {
            it.write(data, 0, 33) // Signature and IHDR.
            it.writeInt(field.size - 4)
            it.write(field)
            it.writeInt(crc.value.toInt())
            it.write(data, 33, data.size - 33)
        }
        return out.toByteArray()
    }
}

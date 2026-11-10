// On-device text recognition for BillieWeather on Android: ML Kit Text Recognition v2 with the
// BUNDLED Chinese-script model (com.google.mlkit:text-recognition-chinese). The model is inside
// the APK; no image or text leaves the device. (See AndroidManifest.xml for ML Kit's usage-log
// transport, which is disabled separately.)
//
// Contract (identical for every BillieWeather OCR adapter, see
// packages/finance-core/src/universal/ocr.ts `OcrResult` and ocr-apple/BillieVisionOCR.swift):
// - coordinates are pixels of the UPRIGHT full-resolution image: origin top-left, after the EXIF
//   orientation and after the detected extra rotation (`rotation`, clockwise degrees) are applied.
//   `width`/`height` are that upright frame. How it is done here: the bitmap itself is rotated
//   with a Matrix (EXIF + extra rotation) and handed to ML Kit with rotationDegrees = 0, so ML Kit's
//   boxes are already in the upright frame; they are only scaled back up if the bitmap was
//   decoded with inSampleSize > 1 to bound memory.
// - confidence is ML Kit's per-line / per-element value in 0..1. If ML Kit reports 0 for every
//   line (its documented "not available" value), confidences are null and
//   "line_confidence"/"word_confidence" are listed as unsupported.
// - nothing is guessed: text ML Kit does not return is absent; items without a bounding box are
//   dropped rather than given an invented position.
package app.billieweather.ocr

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Rect
import android.os.Build
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import java.io.ByteArrayInputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.abs
import org.json.JSONArray
import org.json.JSONObject

@InvokeArg
class RecognizeArgs {
  /** Base64 of the PNG/JPEG bytes. */
  lateinit var image: String
  var page: Int = 0
  var languages: Array<String>? = null
}

@TauriPlugin
class OcrPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    /** Same limit as the Apple Vision adapter. */
    const val MAX_PIXELS = 60_000_000L

    /** Decoded-bitmap budget (ARGB_8888 = 4 bytes/pixel, ~64 MB). Larger inputs are subsampled. */
    const val DECODE_BUDGET_PIXELS = 16_000_000L

    /** Languages the Chinese-script model is documented to cover (it maps zh-Hans/zh-Hant to zh). */
    private val CHINESE = setOf("zh")

    /**
     * Latin-script languages listed as supported on
     * https://developers.google.com/ml-kit/vision/text-recognition/v2/languages
     * ASSUMPTION (not stated in Google's docs, must be verified on device): the Chinese-script
     * model also reads Latin script. If it does not, add com.google.mlkit:text-recognition and
     * pick the recognizer from the requested languages.
     */
    private val LATIN = setOf(
      "af", "sq", "ca", "hr", "cs", "da", "nl", "en", "et", "fil", "tl", "fi", "fr", "de", "hu",
      "is", "id", "it", "lv", "lt", "ms", "no", "nb", "pl", "pt", "ro", "sk", "sl", "es", "sv",
      "tr", "vi"
    )
  }

  private val executor: ExecutorService = Executors.newSingleThreadExecutor()
  private val recognizer: TextRecognizer by lazy {
    TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
  }

  override fun onDestroy() {
    executor.shutdownNow()
    try {
      recognizer.close()
    } catch (ignored: Exception) {
    }
    super.onDestroy()
  }

  @Command
  fun recognize(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(RecognizeArgs::class.java)
    } catch (ex: Exception) {
      invoke.reject("invalid_arguments")
      return
    }
    executor.execute {
      try {
        invoke.resolve(run(args))
      } catch (ex: Throwable) {
        // Should not happen (run() reports per-page problems in `errors`), but never leave the
        // JS promise pending.
        invoke.reject("recognition_failed")
      }
    }
  }

  private fun run(args: RecognizeArgs): JSObject {
    val page = args.page
    val requested = args.languages?.toList() ?: emptyList()
    val unsupported = JSONArray()
    requested.filterNot { isSupported(it) }.forEach { unsupported.put("language:$it") }

    val result = JSObject()
    result.put("engine", JSONObject()
      .put("id", "mlkit-text-v2")
      .put("version", "ML Kit ${BuildConfig.MLKIT_TEXT_VERSION} (bundled); Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"))
    result.put("languages", JSONArray(requested))
    result.put("pages", JSONArray())
    result.put("errors", JSONArray())
    result.put("unsupported", unsupported)

    fun fail(code: String, message: String): JSObject {
      result.put("errors", JSONArray().put(JSONObject().put("page", page).put("code", code).put("message", message)))
      return result
    }

    val bytes = try {
      Base64.decode(args.image, Base64.DEFAULT)
    } catch (ex: IllegalArgumentException) {
      return fail("decode_failed", "The image is not valid base64.")
    }

    // 1. Size check without allocating pixels.
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val rawWidth = bounds.outWidth
    val rawHeight = bounds.outHeight
    if (rawWidth <= 0 || rawHeight <= 0) return fail("decode_failed", "The image could not be decoded.")
    if (rawWidth.toLong() * rawHeight.toLong() > MAX_PIXELS) return fail("too_large", "The image has too many pixels.")

    // 2. EXIF orientation (JPEG; PNG normally has none -> ORIENTATION_NORMAL).
    val orientation = try {
      ExifInterface(ByteArrayInputStream(bytes))
        .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    } catch (ex: Exception) {
      ExifInterface.ORIENTATION_NORMAL
    }
    val transposed = orientation in setOf(
      ExifInterface.ORIENTATION_TRANSPOSE, ExifInterface.ORIENTATION_ROTATE_90,
      ExifInterface.ORIENTATION_TRANSVERSE, ExifInterface.ORIENTATION_ROTATE_270
    )
    // Full-resolution upright frame (after EXIF, before the extra rotation).
    val uprightWidth = if (transposed) rawHeight else rawWidth
    val uprightHeight = if (transposed) rawWidth else rawHeight

    // 3. Decode (subsampled if needed) and apply EXIF.
    var sample = 1
    while (rawWidth.toLong() * rawHeight.toLong() / (sample.toLong() * sample) > DECODE_BUDGET_PIXELS) sample *= 2
    val upright: Bitmap = try {
      val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply {
        inSampleSize = sample
        inPreferredConfig = Bitmap.Config.ARGB_8888
      }) ?: return fail("decode_failed", "The image could not be decoded.")
      transform(decoded, exifMatrix(orientation))
    } catch (ex: OutOfMemoryError) {
      return fail("too_large", "Not enough memory to decode the image.")
    }

    try {
      // 4. A scan may be sideways or upside down without EXIF saying so: like the Apple adapter,
      //    try 0 first and only try 90/180/270 if 0 does not read confidently.
      var best: Triple<Int, Text, Bitmap>? = null
      var bestScore = -1.0
      for (rotation in intArrayOf(0, 90, 180, 270)) {
        val candidate = if (rotation == 0) upright else transform(upright, Matrix().apply { postRotate(rotation.toFloat()) }, recycleSource = false)
        val text = Tasks.await(recognizer.process(InputImage.fromBitmap(candidate, 0)))
        val score = score(text)
        if (score > bestScore) {
          best?.third?.let { if (it !== upright) it.recycle() }
          best = Triple(rotation, text, candidate)
          bestScore = score
        } else if (candidate !== upright) {
          candidate.recycle()
        }
        if (rotation == 0 && score > 0 && isConfidentlyUpright(text)) break
      }
      val (rotation, text, bitmap) = best!!

      // 5. Map ML Kit boxes (in `bitmap` pixels) to the full-resolution upright frame.
      val swap = rotation == 90 || rotation == 270
      val width = if (swap) uprightHeight else uprightWidth
      val height = if (swap) uprightWidth else uprightHeight
      val sx = width.toDouble() / bitmap.width
      val sy = height.toDouble() / bitmap.height
      if (bitmap !== upright) bitmap.recycle()

      val lines = text.textBlocks.flatMap { it.lines }
      val confidenceAvailable = lines.isEmpty() || lines.any { it.confidence > 0f } ||
        lines.any { line -> line.elements.any { it.confidence > 0f } }
      if (!confidenceAvailable) {
        unsupported.put("line_confidence")
        unsupported.put("word_confidence")
      }

      val outLines = JSONArray()
      for (line in lines) {
        val box = line.boundingBox ?: continue
        val words = JSONArray()
        for (element in line.elements) {
          val wordBox = element.boundingBox ?: continue
          words.put(item(element.text, element.confidence, confidenceAvailable, wordBox, sx, sy))
        }
        outLines.put(item(line.text, line.confidence, confidenceAvailable, box, sx, sy).put("words", words))
      }
      result.put("pages", JSONArray().put(JSONObject()
        .put("page", page)
        .put("width", width)
        .put("height", height)
        .put("rotation", rotation)
        .put("lines", outLines)))
      return result
    } catch (ex: OutOfMemoryError) {
      return fail("too_large", "Not enough memory to recognize the image.")
    } catch (ex: Exception) {
      // Do not echo exception text from the image pipeline into the result.
      return fail("recognition_failed", "Text recognition failed.")
    } finally {
      upright.recycle()
    }
  }

  private fun item(text: String, confidence: Float, available: Boolean, box: Rect, sx: Double, sy: Double): JSONObject =
    JSONObject()
      .put("text", text)
      .put("confidence", if (available) confidence.toDouble() else JSONObject.NULL)
      .put("x", box.left * sx)
      .put("y", box.top * sy)
      .put("width", box.width() * sx)
      .put("height", box.height() * sy)

  /** Sum of confidence x length, as in the Apple adapter (length only if confidence is absent). */
  private fun score(text: Text): Double {
    val lines = text.textBlocks.flatMap { it.lines }
    val anyConfidence = lines.any { it.confidence > 0f }
    return lines.sumOf { (if (anyConfidence) it.confidence.toDouble() else 1.0) * it.text.length }
  }

  private fun isConfidentlyUpright(text: Text): Boolean {
    val lines = text.textBlocks.flatMap { it.lines }
    if (lines.size < 3) return false
    val angles = lines.map { abs(it.angle) }.sorted()
    if (angles[angles.size / 2] > 30f) return false
    return lines.map { it.confidence.toDouble() }.average() >= 0.8
  }

  private fun isSupported(tag: String): Boolean {
    val parts = tag.lowercase().split('-', '_')
    val primary = parts.firstOrNull() ?: return false
    if (primary in CHINESE) return true
    if (primary == "sr") return parts.contains("latn")
    return primary in LATIN
  }

  /** EXIF orientation -> transform that makes the stored pixels upright. */
  private fun exifMatrix(orientation: Int): Matrix = Matrix().apply {
    when (orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(-90f); postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
      else -> {}
    }
  }

  /** Applies `matrix` (createBitmap re-origins the result at 0,0). Identity returns the source. */
  private fun transform(source: Bitmap, matrix: Matrix, recycleSource: Boolean = true): Bitmap {
    if (matrix.isIdentity) return source
    val out = Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
    if (recycleSource && out !== source) source.recycle()
    return out
  }
}

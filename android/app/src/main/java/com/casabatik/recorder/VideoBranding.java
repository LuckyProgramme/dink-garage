package com.casabatik.recorder;

import static org.bytedeco.ffmpeg.global.avcodec.AV_CODEC_ID_AAC;
import static org.bytedeco.ffmpeg.global.avutil.AV_PIX_FMT_BGR24;
import static org.bytedeco.ffmpeg.global.avutil.AV_PIX_FMT_YUV420P;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.util.Log;
import java.io.File;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.function.BooleanSupplier;
import org.bytedeco.javacv.FFmpegFrameGrabber;
import org.bytedeco.javacv.FFmpegFrameRecorder;
import org.bytedeco.javacv.Frame;

/** Adds the public Dink Vision mark while preserving the original until validation succeeds. */
final class VideoBranding {
  private static final String ASSET = "dink-vision-logo.png";
  private static final String BRAND = "DinkVision";
  private static final String TEMP_SUFFIX = ".dinkvision.tmp";
  private static final String BACKUP_SUFFIX = ".dinkvision.backup";

  static final class ProcessingPausedException extends Exception {
    ProcessingPausedException() {
      super("Logo processing paused while another recording starts.");
    }
  }

  static void recoverInterruptedSwaps(File directory) {
    File[] backups = directory.listFiles((parent, name) -> name.endsWith(BACKUP_SUFFIX));
    if (backups == null) return;
    for (File backup : backups) {
      String name = backup.getName().substring(0, backup.getName().length() - BACKUP_SUFFIX.length());
      File recording = new File(directory, name);
      if (!recording.exists()) {
        try {
          Files.move(backup.toPath(), recording.toPath(), StandardCopyOption.REPLACE_EXISTING);
          Log.w("DinkVisionVideo", "Restored recording after an interrupted logo save: " + name);
        } catch (Exception e) {
          Log.e("DinkVisionVideo", "Could not restore " + name, e);
        }
      }
    }
  }

  static long apply(Context context, File source, long expectedMillis, boolean expectAudio)
      throws Exception {
    return apply(context, source, expectedMillis, expectAudio, () -> false);
  }

  static long apply(
      Context context,
      File source,
      long expectedMillis,
      boolean expectAudio,
      BooleanSupplier pauseRequested)
      throws Exception {
    long sourceMillis = RtspRecorder.validate(source, expectedMillis, expectAudio);
    if (pauseRequested.getAsBoolean()) throw new ProcessingPausedException();
    File temporary = new File(source.getParentFile(), source.getName() + TEMP_SUFFIX);
    File backup = new File(source.getParentFile(), source.getName() + BACKUP_SUFFIX);
    if (isBranded(source)) {
      temporary.delete();
      backup.delete();
      return sourceMillis;
    }
    if (temporary.exists() && !temporary.delete())
      throw new Exception("A previous logo save is still being cleaned up. Please retry.");
    if (source.getParentFile().getUsableSpace() < source.length() + 50_000_000L)
      throw new Exception("Not enough tablet storage to finish the Dink Vision video.");

    try {
      render(context, source, temporary, sourceMillis, expectAudio, pauseRequested);
      long brandedMillis = RtspRecorder.validate(temporary, expectedMillis, expectAudio);
      if (pauseRequested.getAsBoolean()) throw new ProcessingPausedException();
      replaceValidated(source, temporary, backup);
      long confirmedMillis = RtspRecorder.validate(source, expectedMillis, expectAudio);
      if (!isBranded(source)) throw new Exception("The saved video is missing its Dink Vision logo marker.");
      backup.delete();
      Log.i(
          "DinkVisionVideo",
          "Logo saved durationMs=" + confirmedMillis + " bytes=" + source.length());
      return brandedMillis;
    } catch (Exception failure) {
      temporary.delete();
      if (!source.exists() && backup.exists())
        try {
          Files.move(backup.toPath(), source.toPath(), StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception restoreFailure) {
          failure.addSuppressed(restoreFailure);
        }
      if (failure instanceof ProcessingPausedException) throw failure;
      Log.e("DinkVisionVideo", "Logo processing failed; the source video was preserved", failure);
      throw new Exception(
          "The Dink Vision logo could not be added. The original video was preserved. Please retry.",
          failure);
    }
  }

  private static boolean isBranded(File source) {
    try (FFmpegFrameGrabber grabber = new FFmpegFrameGrabber(source)) {
      grabber.start();
      String comment = grabber.getMetadata("comment");
      return comment != null && comment.contains(BRAND);
    } catch (Exception ignored) {
      return false;
    }
  }

  private static void replaceValidated(File source, File temporary, File backup) throws Exception {
    try {
      Files.move(
          temporary.toPath(),
          source.toPath(),
          StandardCopyOption.ATOMIC_MOVE,
          StandardCopyOption.REPLACE_EXISTING);
      return;
    } catch (AtomicMoveNotSupportedException ignored) {
      // Some Android filesystems do not expose atomic replacement. The backup
      // path below is recoverable by recoverInterruptedSwaps after a restart.
    }
    if (backup.exists() && !backup.delete())
      throw new Exception("A previous safe video backup could not be released.");
    Files.move(source.toPath(), backup.toPath(), StandardCopyOption.REPLACE_EXISTING);
    try {
      Files.move(temporary.toPath(), source.toPath(), StandardCopyOption.REPLACE_EXISTING);
    } catch (Exception failure) {
      Files.move(backup.toPath(), source.toPath(), StandardCopyOption.REPLACE_EXISTING);
      throw failure;
    }
  }

  private static void render(
      Context context,
      File source,
      File output,
      long sourceMillis,
      boolean expectAudio,
      BooleanSupplier pauseRequested)
      throws Exception {
    Bitmap original = null, scaled = null, mark = null;
    long timeoutMillis = Math.max(180_000L, Math.min(2_700_000L, sourceMillis * 3L + 60_000L));
    long deadline = System.nanoTime() + timeoutMillis * 1_000_000L;
    try (InputStream stream = context.getAssets().open(ASSET);
        FFmpegFrameGrabber grabber = new FFmpegFrameGrabber(source)) {
      original = BitmapFactory.decodeStream(stream);
      if (original == null) throw new Exception("Dink Vision logo image is unreadable.");
      grabber.setPixelFormat(AV_PIX_FMT_BGR24);
      grabber.start();
      int width = grabber.getImageWidth(), height = grabber.getImageHeight();
      if (width < 1 || height < 1) throw new Exception("The saved video has no picture.");
      int rotation = normalizeRotation(grabber.getDisplayRotation());
      int displayWidth = rotation % 180 == 0 ? width : height;
      int displayHeight = rotation % 180 == 0 ? height : width;
      double scale =
          Math.min(
              displayWidth * 0.20 / original.getWidth(),
              displayHeight * 0.16 / original.getHeight());
      int markWidth = Math.max(1, (int) Math.round(original.getWidth() * scale));
      int markHeight = Math.max(1, (int) Math.round(original.getHeight() * scale));
      scaled = Bitmap.createScaledBitmap(original, markWidth, markHeight, true);
      mark = orientMark(scaled, rotation);
      int[] pixels = new int[mark.getWidth() * mark.getHeight()];
      mark.getPixels(pixels, 0, mark.getWidth(), 0, 0, mark.getWidth(), mark.getHeight());
      int channels = expectAudio ? Math.min(2, grabber.getAudioChannels()) : 0;
      int sampleRate = channels > 0 ? grabber.getSampleRate() : 0;
      if (channels > 0 && sampleRate < 1) throw new Exception("The saved audio sample rate is invalid.");
      double fps = grabber.getFrameRate();
      if (!Double.isFinite(fps) || fps <= 0 || fps > 120)
        throw new Exception("The saved video frame rate is invalid.");

      try (FFmpegFrameRecorder recorder = new FFmpegFrameRecorder(output, width, height, channels)) {
        recorder.setFormat("mp4");
        recorder.setVideoCodecName("libopenh264");
        int bitrate = grabber.getVideoBitrate();
        recorder.setVideoBitrate(bitrate > 0 ? Math.max(2_000_000, Math.min(8_000_000, bitrate)) : 4_000_000);
        recorder.setFrameRate(fps);
        recorder.setGopSize(Math.max(1, (int) Math.round(fps)));
        recorder.setPixelFormat(AV_PIX_FMT_YUV420P);
        recorder.setOption("movflags", "frag_keyframe+hybrid_fragmented");
        recorder.setMetadata("comment", BRAND);
        recorder.setDisplayRotation(grabber.getDisplayRotation());
        if (channels > 0) {
          recorder.setAudioCodec(AV_CODEC_ID_AAC);
          recorder.setSampleRate(sampleRate);
          recorder.setAudioBitrate(128_000);
        }
        recorder.start();
        long sourceStart = Long.MIN_VALUE, lastVideo = Long.MIN_VALUE;
        int outputFrameNumber = -1;
        boolean wroteVideo = false, wroteAudio = false;
        Frame frame;
        while ((frame = grabber.grabFrame(channels > 0, true, true, false)) != null) {
          if (pauseRequested.getAsBoolean()) throw new ProcessingPausedException();
          if (System.nanoTime() > deadline)
            throw new Exception("Adding the logo took too long. The original video was preserved.");
          if (output.getParentFile().getUsableSpace() < 50_000_000L)
            throw new Exception("Tablet storage is nearly full. The original video was preserved.");
          if (frame.image != null) {
            if (sourceStart == Long.MIN_VALUE) sourceStart = frame.timestamp;
            if (frame.timestamp <= lastVideo)
              throw new Exception("The saved video timestamps do not advance.");
            blend(frame, pixels, mark.getWidth(), mark.getHeight(), rotation);
            // JavaCV converts setTimestamp() to a rounded frame number. Two valid source
            // timestamps can therefore round to the same frame and make FFmpeg reject the
            // second packet as non-monotonic. Assign the closest strictly increasing frame
            // number instead so every device produces valid MP4 packet timestamps.
            outputFrameNumber =
                nextFrameNumber(frame.timestamp, sourceStart, fps, outputFrameNumber);
            recorder.setFrameNumber(outputFrameNumber);
            recorder.record(frame);
            lastVideo = frame.timestamp;
            wroteVideo = true;
          } else if (frame.samples != null && channels > 0 && sourceStart != Long.MIN_VALUE) {
            recorder.record(frame);
            wroteAudio = true;
          }
        }
        recorder.stop();
        if (!wroteVideo) throw new Exception("No video picture was available for the logo.");
        if (channels > 0 && !wroteAudio) throw new Exception("No audio was available while saving the logo.");
      }
    } finally {
      if (mark != null && mark != scaled) mark.recycle();
      if (scaled != null) scaled.recycle();
      if (original != null) original.recycle();
    }
  }

  static int nextFrameNumber(
      long sourceTimestampUs, long sourceStartUs, double frameRate, int previousFrameNumber)
      throws Exception {
    if (!Double.isFinite(frameRate) || frameRate <= 0)
      throw new Exception("The saved video frame rate is invalid.");
    long relativeTimestampUs = Math.max(0L, sourceTimestampUs - sourceStartUs);
    long timestampFrame = Math.round(relativeTimestampUs * frameRate / 1_000_000.0);
    long nextFrame = Math.max(timestampFrame, (long) previousFrameNumber + 1L);
    if (nextFrame > Integer.MAX_VALUE)
      throw new Exception("The saved video is too long to finish safely.");
    return (int) nextFrame;
  }

  static Bitmap orientMark(Bitmap scaled, int rotation) {
    int normalized = normalizeRotation(rotation);
    if (normalized == 0) return scaled;
    Matrix matrix = new Matrix();
    // getDisplayRotation() reports the display transform counterclockwise.
    // Android Bitmap coordinates run downward, so using the same numeric
    // angle produces the inverse visual transform required before playback.
    matrix.postRotate(normalized);
    return Bitmap.createBitmap(
        scaled, 0, 0, scaled.getWidth(), scaled.getHeight(), matrix, true);
  }

  static void blend(Frame frame, int[] pixels, int logoWidth, int logoHeight, int rotation)
      throws Exception {
    if (frame.image == null || frame.image.length == 0 || !(frame.image[0] instanceof ByteBuffer))
      throw new Exception("The saved video picture format is unsupported.");
    ByteBuffer image = ((ByteBuffer) frame.image[0]).duplicate();
    int width = frame.imageWidth, height = frame.imageHeight;
    int margin = Math.max(12, Math.round(Math.min(width, height) * 0.02f));
    // Choose the raw-frame corner that becomes bottom-right after the player
    // applies the MP4 display rotation copied by the recorder.
    int left, top;
    switch (normalizeRotation(rotation)) {
      case 90 -> {
        left = margin;
        top = height - logoHeight - margin;
      }
      case 180 -> {
        left = margin;
        top = margin;
      }
      case 270 -> {
        left = width - logoWidth - margin;
        top = margin;
      }
      default -> {
        left = width - logoWidth - margin;
        top = height - logoHeight - margin;
      }
    }
    left = Math.max(0, Math.min(left, width - logoWidth));
    top = Math.max(0, Math.min(top, height - logoHeight));
    int base = image.position(), stride = frame.imageStride;
    for (int y = 0; y < logoHeight; y++) {
      for (int x = 0; x < logoWidth; x++) {
        int color = pixels[y * logoWidth + x];
        int alpha = Math.round(((color >>> 24) & 0xff) * 0.92f);
        if (alpha == 0) continue;
        int offset = base + (top + y) * stride + (left + x) * 3;
        int inverse = 255 - alpha;
        int blue = color & 0xff, green = (color >>> 8) & 0xff, red = (color >>> 16) & 0xff;
        image.put(offset, (byte) ((blue * alpha + (image.get(offset) & 0xff) * inverse) / 255));
        image.put(offset + 1, (byte) ((green * alpha + (image.get(offset + 1) & 0xff) * inverse) / 255));
        image.put(offset + 2, (byte) ((red * alpha + (image.get(offset + 2) & 0xff) * inverse) / 255));
      }
    }
  }

  private static int normalizeRotation(double degrees) {
    if (!Double.isFinite(degrees)) return 0;
    int rotation = ((int) Math.round(degrees / 90.0) * 90) % 360;
    return rotation < 0 ? rotation + 360 : rotation;
  }
}

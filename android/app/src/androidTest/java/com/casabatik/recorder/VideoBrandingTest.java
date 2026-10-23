package com.casabatik.recorder;

import static org.junit.Assert.*;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import android.graphics.Bitmap;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import org.bytedeco.javacv.FFmpegFrameGrabber;
import org.bytedeco.javacv.Frame;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class VideoBrandingTest {
  @Test
  public void savedVideoHasLogoMarkerAndRemainsPlayable() throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    File source =
        new File(instrumentation.getTargetContext().getCacheDir(), "branded-recording.mp4");
    try {
      try (InputStream input =
              instrumentation.getContext().getAssets().open("recording-one-second.mp4");
          FileOutputStream output = new FileOutputStream(source)) {
        input.transferTo(output);
      }
      long duration =
          VideoBranding.apply(instrumentation.getTargetContext(), source, -1, true);
      assertTrue(duration > 0);
      assertTrue(RtspRecorder.validate(source, -1, true) > 0);
      try (FFmpegFrameGrabber grabber = new FFmpegFrameGrabber(source)) {
        grabber.start();
        assertTrue(grabber.getMetadata("comment").contains("DinkVision"));
      }
      long bytes = source.length();
      assertEquals(
          "Applying branding twice must keep the existing valid file",
          duration,
          VideoBranding.apply(instrumentation.getTargetContext(), source, -1, true));
      assertEquals(bytes, source.length());
    } finally {
      source.delete();
    }
  }

  @Test
  public void roundedVideoTimestampsAlwaysProduceIncreasingFrameNumbers() throws Exception {
    double frameRate = 30.0;
    long sourceStart = 1_000_000L;
    int first = VideoBranding.nextFrameNumber(sourceStart, sourceStart, frameRate, -1);
    // Both timestamps normally round to frame zero at 30 fps. The second output frame must
    // still advance or FFmpeg rejects the MP4 packet with av_interleaved_write_frame error -22.
    int second = VideoBranding.nextFrameNumber(sourceStart + 8_000L, sourceStart, frameRate, first);
    int third = VideoBranding.nextFrameNumber(sourceStart + 16_000L, sourceStart, frameRate, second);
    int afterGap =
        VideoBranding.nextFrameNumber(sourceStart + 200_000L, sourceStart, frameRate, third);

    assertEquals(0, first);
    assertEquals(1, second);
    assertEquals(2, third);
    assertEquals(6, afterGap);
  }

  @Test
  public void aNewRecordingPausesBrandingWithoutChangingTheOriginal() throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    File source =
        new File(instrumentation.getTargetContext().getCacheDir(), "paused-branding.mp4");
    try {
      try (InputStream input =
              instrumentation.getContext().getAssets().open("recording-one-second.mp4");
          FileOutputStream output = new FileOutputStream(source)) {
        input.transferTo(output);
      }
      long originalBytes = source.length();
      assertThrows(
          VideoBranding.ProcessingPausedException.class,
          () ->
              VideoBranding.apply(
                  instrumentation.getTargetContext(), source, -1, true, () -> true));
      assertEquals(originalBytes, source.length());
      assertTrue(RtspRecorder.validate(source, -1, true) > 0);
      assertFalse(new File(source.getParentFile(), source.getName() + ".dinkvision.tmp").exists());
    } finally {
      source.delete();
    }
  }

  @Test
  public void markIsPlacedAtTheDisplayedBottomRight() throws Exception {
    try (Frame frame = new Frame(100, 60, Frame.DEPTH_UBYTE, 3)) {
      int[] red = {0xffff0000, 0xffff0000, 0xffff0000, 0xffff0000};
      VideoBranding.blend(frame, red, 2, 2, 0);
      ByteBuffer pixels = ((ByteBuffer) frame.image[0]).duplicate();
      int offset = (60 - 12 - 2) * frame.imageStride + (100 - 12 - 2) * 3;
      assertTrue((pixels.get(offset + 2) & 0xff) > 200);
      assertEquals(0, pixels.get(0));
    }
  }

  @Test
  public void rotatedMetadataUsesTheRawCornerThatDisplaysBottomRight() throws Exception {
    int[][] expected = {
      {86, 46}, // 0: raw bottom-right
      {12, 46}, // 90: raw bottom-left
      {12, 12}, // 180: raw top-left
      {86, 12}  // 270: raw top-right
    };
    int[] rotations = {0, 90, 180, 270};
    for (int index = 0; index < rotations.length; index++) {
      try (Frame frame = new Frame(100, 60, Frame.DEPTH_UBYTE, 3)) {
        int[] red = {0xffff0000, 0xffff0000, 0xffff0000, 0xffff0000};
        VideoBranding.blend(frame, red, 2, 2, rotations[index]);
        ByteBuffer pixels = ((ByteBuffer) frame.image[0]).duplicate();
        int offset = expected[index][1] * frame.imageStride + expected[index][0] * 3;
        assertTrue("Rotation " + rotations[index] + " uses the correct raw corner",
            (pixels.get(offset + 2) & 0xff) > 200);
      }
    }
  }

  @Test
  public void markIsCounterRotatedBeforeDisplayRotation() {
    Bitmap source = Bitmap.createBitmap(2, 1, Bitmap.Config.ARGB_8888);
    source.setPixel(0, 0, 0xffff0000);
    source.setPixel(1, 0, 0xff0000ff);
    Bitmap oriented = VideoBranding.orientMark(source, 270);
    try {
      assertEquals(1, oriented.getWidth());
      assertEquals(2, oriented.getHeight());
      // A 270-degree source display transform rotates clockwise at playback,
      // so the raw mark is stored counterclockwise: blue above red.
      assertEquals(0xff0000ff, oriented.getPixel(0, 0));
      assertEquals(0xffff0000, oriented.getPixel(0, 1));
    } finally {
      oriented.recycle();
      if (oriented != source) source.recycle();
    }
  }
}

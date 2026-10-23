package com.casabatik.recorder;

import static org.junit.Assert.assertEquals;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.serenegiant.usb.Size;
import com.serenegiant.usb.UVCCamera;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class UvcCameraRecorderTest {
  private static Size size(int type, int width, int height, Integer... fps) {
    List<Integer> rates = Arrays.asList(fps);
    return new Size(type, width, height, rates.get(0), rates);
  }

  @Test
  public void prefersSafe720pMjpegModeAndCapsFrameRate() throws Exception {
    Size selected =
        UvcCameraRecorder.chooseRecordingSize(
            Arrays.asList(
                size(UVCCamera.UVC_VS_FRAME_MJPEG, 3840, 2160, 60),
                size(UVCCamera.UVC_VS_FRAME_UNCOMPRESSED, 1280, 720, 30),
                size(UVCCamera.UVC_VS_FRAME_MJPEG, 1280, 720, 60, 30, 15)));
    assertEquals(UVCCamera.UVC_VS_FRAME_MJPEG, selected.type);
    assertEquals(1280, selected.width);
    assertEquals(720, selected.height);
    assertEquals(30, selected.fps);
  }

  @Test
  public void avoids4kWhenCameraHasA1080pMjpegMode() throws Exception {
    Size selected =
        UvcCameraRecorder.chooseRecordingSize(
            Arrays.asList(
                size(UVCCamera.UVC_VS_FRAME_MJPEG, 3840, 2160, 30),
                size(UVCCamera.UVC_VS_FRAME_MJPEG, 1920, 1080, 25),
                size(UVCCamera.UVC_VS_FRAME_UNCOMPRESSED, 640, 480, 30)));
    assertEquals(1920, selected.width);
    assertEquals(1080, selected.height);
    assertEquals(25, selected.fps);
  }

  @Test
  public void avoids4kEvenWhenOnlyTheSmallerModeIsUncompressed() throws Exception {
    Size selected =
        UvcCameraRecorder.chooseRecordingSize(
            Arrays.asList(
                size(UVCCamera.UVC_VS_FRAME_MJPEG, 3840, 2160, 30),
                size(UVCCamera.UVC_VS_FRAME_UNCOMPRESSED, 1280, 720, 30)));
    assertEquals(1280, selected.width);
    assertEquals(720, selected.height);
  }

  @Test
  public void preservesTheOnlyFrameRateReportedByTheCamera() throws Exception {
    Size selected =
        UvcCameraRecorder.chooseRecordingSize(
            Arrays.asList(size(UVCCamera.UVC_VS_FRAME_MJPEG, 1280, 720, 60)));
    assertEquals(60, selected.fps);
  }
}

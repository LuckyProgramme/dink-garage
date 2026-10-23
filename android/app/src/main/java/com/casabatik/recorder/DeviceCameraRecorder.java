package com.casabatik.recorder;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.camera2.*;
import android.media.MediaRecorder;
import android.os.*;
import android.util.Size;
import java.io.File;
import java.util.Collections;
import java.util.Comparator;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/** Records the Android device's rear camera and microphone into an H.264/AAC MP4. */
final class DeviceCameraRecorder {
  static boolean hasPermissions(Context context) {
    return context.checkSelfPermission(Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED
        && context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
  }

  private static Size recordingSize(CameraCharacteristics details) throws Exception {
    android.hardware.camera2.params.StreamConfigurationMap map =
        details.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
    Size[] sizes = map == null ? null : map.getOutputSizes(MediaRecorder.class);
    if (sizes == null || sizes.length == 0) throw new Exception("No recordable camera size found.");
    for (Size size : sizes)
      if (size.getWidth() == 1280 && size.getHeight() == 720) return size;
    return java.util.Arrays.stream(sizes)
        .filter(size -> size.getWidth() <= 1920 && size.getHeight() <= 1080)
        .max(Comparator.comparingLong(size -> (long) size.getWidth() * size.getHeight()))
        .orElse(sizes[0]);
  }

  private static String[] selectCamera(CameraManager manager) throws Exception {
    String fallback = null, external = null, back = null;
    for (String id : manager.getCameraIdList()) {
      CameraCharacteristics details = manager.getCameraCharacteristics(id);
      Integer facing = details.get(CameraCharacteristics.LENS_FACING);
      if (fallback == null) fallback = id;
      if (facing == null) continue;
      if (facing == CameraCharacteristics.LENS_FACING_EXTERNAL && external == null) external = id;
      else if (facing == CameraCharacteristics.LENS_FACING_BACK && back == null) back = id;
    }
    if (external != null) return new String[] {external, "USB camera"};
    if (back != null) return new String[] {back, "Built-in camera"};
    if (fallback != null) return new String[] {fallback, "Built-in camera"};
    throw new Exception("This Android device has no camera.");
  }

  static android.util.Range<Integer> recordingRate(android.util.Range<Integer>[] ranges, long minFrameNs) throws Exception {
    if (ranges == null || ranges.length == 0)
      throw new RecordingAccuracy.Failure("Camera does not report supported recording frame rates.");
    int ceiling = minFrameNs > 0 ? (int)(1_000_000_000L / minFrameNs) : 30;
    android.util.Range<Integer> best = null;
    for (var range : ranges) {
      if (range.getUpper() > Math.min(30, ceiling) || range.getLower() < 1) continue;
      if (best == null || range.getUpper() > best.getUpper()
          || (range.getUpper().equals(best.getUpper()) && range.getLower() > best.getLower())) best = range;
    }
    if (best == null) throw new RecordingAccuracy.Failure("Camera cannot sustain a supported recording mode. Test another camera.");
    return best;
  }

  @SuppressLint("MissingPermission")
  static long capture(
      Context context,
      File file,
      int seconds,
      int countInSeconds,
      BooleanSupplier stop,
      RtspRecorder.Listener listener)
      throws Exception {
    if (!hasPermissions(context))
      throw new Exception("Allow camera and microphone permissions in the Android app.");

    CameraManager manager = context.getSystemService(CameraManager.class);
    String[] selection;
    try {
      selection = selectCamera(manager);
    } catch (Exception noPlatformCamera) {
      if (UvcCameraRecorder.hasAttachedCamera(context))
        return UvcCameraRecorder.capture(
            context, file, seconds, countInSeconds, stop, listener);
      throw noPlatformCamera;
    }
    String cameraId = selection[0];
    if (!"USB camera".equals(selection[1]) && UvcCameraRecorder.hasAttachedCamera(context))
      return UvcCameraRecorder.capture(
          context, file, seconds, countInSeconds, stop, listener);
    listener.camera(selection[1]);
    CameraCharacteristics details = manager.getCameraCharacteristics(cameraId);
    Size size = recordingSize(details);
    var map = details.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
    var rate = recordingRate(details.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES),
        map.getOutputMinFrameDuration(MediaRecorder.class, size));
    HandlerThread thread = new HandlerThread("wpc-device-camera");
    thread.start();
    Handler handler = new Handler(thread.getLooper());
    MediaRecorder recorder =
        Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(context) : new MediaRecorder();
    CameraDevice camera = null;
    CameraCaptureSession session = null;
    long capturedMillis = 0;
    boolean recording = false;
    try {
      recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
      recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
      recorder.setOutputFile(file.getAbsolutePath());
      recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
      recorder.setVideoEncodingBitRate(6_000_000);
      recorder.setVideoFrameRate(rate.getUpper());
      recorder.setVideoSize(size.getWidth(), size.getHeight());
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
      recorder.setAudioEncodingBitRate(128_000);
      recorder.setAudioSamplingRate(48_000);
      Integer orientation = details.get(CameraCharacteristics.SENSOR_ORIENTATION);
      if (orientation != null) recorder.setOrientationHint(orientation);
      recorder.prepare();

      CountDownLatch opened = new CountDownLatch(1);
      AtomicReference<CameraDevice> openedCamera = new AtomicReference<>();
      AtomicReference<Exception> failure = new AtomicReference<>();
      java.util.concurrent.atomic.AtomicLong lastFrame = new java.util.concurrent.atomic.AtomicLong(System.nanoTime());
      recorder.setOnErrorListener((r, what, extra) -> failure.set(new RecordingAccuracy.Failure("Android camera encoder failed. Available footage remains on this device.")));
      manager.openCamera(
          cameraId,
          new CameraDevice.StateCallback() {
            public void onOpened(CameraDevice value) {
              openedCamera.set(value);
              opened.countDown();
            }

            public void onDisconnected(CameraDevice value) {
              value.close();
              failure.set(new Exception("Android camera disconnected."));
              opened.countDown();
            }

            public void onError(CameraDevice value, int error) {
              value.close();
              failure.set(new Exception("Android camera could not be opened."));
              opened.countDown();
            }
          },
          handler);
      if (!opened.await(10, TimeUnit.SECONDS))
        throw new Exception("Timed out while opening the Android camera.");
      if (failure.get() != null) throw failure.get();
      camera = openedCamera.get();
      if (camera == null) throw new Exception("Android camera could not be opened.");

      android.view.Surface surface = recorder.getSurface();
      CaptureRequest.Builder request = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
      request.addTarget(surface);
      request.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
      request.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, rate);
      int[] focusModes = details.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
      if (focusModes != null)
        for (int mode : focusModes)
          if (mode == CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO) {
            request.set(CaptureRequest.CONTROL_AF_MODE, mode);
            break;
          }
      CountDownLatch configured = new CountDownLatch(1);
      AtomicReference<CameraCaptureSession> openedSession = new AtomicReference<>();
      camera.createCaptureSession(
          Collections.singletonList(surface),
          new CameraCaptureSession.StateCallback() {
            public void onConfigured(CameraCaptureSession value) {
              openedSession.set(value);
              configured.countDown();
            }

            public void onConfigureFailed(CameraCaptureSession value) {
              failure.set(new Exception("Android camera recording could not be configured."));
              configured.countDown();
            }
          },
          handler);
      if (!configured.await(10, TimeUnit.SECONDS))
        throw new Exception("Timed out while preparing the Android camera.");
      if (failure.get() != null) throw failure.get();
      session = openedSession.get();
      if (session == null) throw new Exception("Android camera recording could not be configured.");
      session.setRepeatingRequest(request.build(), new CameraCaptureSession.CaptureCallback() {
        private final RecordingAccuracy.Timeline clock = new RecordingAccuracy.Timeline();
        @Override public void onCaptureCompleted(CameraCaptureSession s, CaptureRequest request, TotalCaptureResult result) {
          long now = System.nanoTime();
          Long timestamp = result.get(CaptureResult.SENSOR_TIMESTAMP);
          lastFrame.set(now);
          if (timestamp != null) try { clock.observe(timestamp / 1000, now); }
          catch (RecordingAccuracy.Failure e) { failure.set(e); }
        }
      }, handler);

      listener.ready();
      for (int value = countInSeconds; value > 0; value--) {
        listener.countdown(value);
        long deadline = System.nanoTime() + 1_000_000_000L;
        while (!stop.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(25);
      }
      listener.countdown(0);
      if (stop.getAsBoolean()) throw new Exception("Recording start was cancelled.");

      recorder.start();
      recording = true;
      long start = System.nanoTime();
      lastFrame.set(start);
      listener.started();
      while (!stop.getAsBoolean()
          && (System.nanoTime() - start) / 1_000_000_000L < seconds) {
        if (failure.get() != null) throw failure.get();
        if (System.nanoTime() - lastFrame.get() > 3_000_000_000L)
          throw new RecordingAccuracy.Failure("Device camera stopped delivering frames. Available footage remains on this device.");
        listener.frame((int) ((System.nanoTime() - start) / 1_000_000_000L));
        if (file.getParentFile().getUsableSpace() < 50_000_000)
          throw new Exception("Tablet storage is nearly full.");
        Thread.sleep(100);
      }
      capturedMillis = Math.max(1, (System.nanoTime() - start) / 1_000_000L);
      listener.finalizing();
      recorder.stop();
      recording = false;
    } catch (RuntimeException e) {
      throw new Exception("Android camera could not save a complete recording.", e);
    } finally {
      if (recording) try { recorder.stop(); } catch (Exception ignored) {}
      if (session != null) session.close();
      if (camera != null) camera.close();
      try {
        recorder.reset();
      } catch (Exception ignored) {
      }
      recorder.release();
      thread.quitSafely();
    }
    return capturedMillis;
  }
}

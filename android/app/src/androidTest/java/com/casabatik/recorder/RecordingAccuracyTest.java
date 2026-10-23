package com.casabatik.recorder;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.util.concurrent.*;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class RecordingAccuracyTest {
  @Test public void deviceCameraPreservesElapsedTime() throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    var context = instrumentation.getTargetContext();
    instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.CAMERA);
    instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.RECORD_AUDIO);
    File file = new File(context.getCacheDir(), "device-clock.mp4");
    try (var activity = androidx.test.core.app.ActivityScenario.launch(MainActivity.class)) {
      long duration = DeviceCameraRecorder.capture(context, file, 6, 0, () -> false,
          new RtspRecorder.Listener() {
            public void ready() {} public void countdown(int n) {} public void started() {} public void frame(int n) {}
          });
      RtspRecorder.validate(file, duration, true);
    } finally { file.delete(); }
  }
  private void record(String path, boolean audio, String name, int seconds) throws Exception {
    File file = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(), name + ".mp4");
    try {
      long duration = RtspRecorder.capture("rtsp://10.0.2.2:18554/" + path, file,
          seconds, audio, 0, () -> false, new RtspRecorder.Listener() {
            public void ready() {} public void countdown(int n) {} public void started() {} public void frame(int n) {}
          });
      RtspRecorder.validate(file, duration, audio);
    } finally { file.delete(); }
  }
  @Test public void videoOnlyPacketCopy() throws Exception { record("camera", false, "no-audio", 4); }
  @Test public void audioOnlyConversionRetainsSourceTiming() throws Exception { record("g711", true, "g711", 6); }
  @Test public void fourConcurrentRecordersKeepIndependentClocks() throws Exception {
    ExecutorService pool = Executors.newFixedThreadPool(4);
    try {
      java.util.List<Future<?>> futures = new java.util.ArrayList<>();
      for (int i = 0; i < 4; i++) {
        final int index = i;
        futures.add(pool.submit(() -> { record("camera", true, "concurrent-" + index, 6); return null; }));
      }
      for (var future : futures) future.get(45, TimeUnit.SECONDS);
    } finally { pool.shutdownNow(); }
  }
  @Test public void incompleteAudioCannotPassRecoveryValidation() throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    File file = new File(instrumentation.getTargetContext().getCacheDir(), "bad-timing.mp4");
    try {
      try (InputStream in = instrumentation.getContext().getAssets().open("mismatched-tracks.mp4");
          OutputStream out = new FileOutputStream(file)) { in.transferTo(out); }
      try { RtspRecorder.validate(file, -1, true); fail("Recovery must reject mismatched tracks"); }
      catch (RecordingAccuracy.Failure expected) {}
    } finally { file.delete(); }
  }
}

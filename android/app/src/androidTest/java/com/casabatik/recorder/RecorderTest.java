package com.casabatik.recorder;

import static org.junit.Assert.*;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.util.concurrent.atomic.AtomicBoolean;
import org.bytedeco.javacv.FFmpegFrameGrabber;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class RecorderTest {
  @Test
  public void rtspVideoAudioAndStop() throws Exception {
    File file =
        new File(
            InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),
            "instrumented.mp4");
    AtomicBoolean started = new AtomicBoolean(), stop = new AtomicBoolean();
    long begin = System.nanoTime();
    long capturedMillis =
        RtspRecorder.capture(
            "rtsp://10.0.2.2:18554/camera",
            file,
            30,
            true,
            0,
            stop::get,
            new RtspRecorder.Listener() {
              public void ready() {}

              public void countdown(int value) {}

              public void started() {
                started.set(true);
              }

              public void frame(int s) {
                if (s >= 4) stop.set(true);
              }
            });
    assertTrue(started.get());
    assertTrue(stop.get());
    assertTrue(capturedMillis >= 3_500 && capturedMillis < 8_000);
    assertTrue((System.nanoTime() - begin) / 1e9 < 45);
    RtspRecorder.validate(file, capturedMillis, true);
    try (FFmpegFrameGrabber g = new FFmpegFrameGrabber(file)) {
      g.start();
      assertEquals("h264", g.getVideoCodecName());
      assertEquals("aac", g.getAudioCodecName());
      assertTrue(g.getAudioChannels() > 0);
      assertTrue(g.getLengthInTime() >= 2_000_000 && g.getLengthInTime() < 10_000_000);
      assertNotNull(g.grabImage());
      assertNotNull(g.grabSamples());
    }
    file.delete();
  }

  @Test
  public void sourceClockDoesNotStretchDelayedVideo() throws Exception {
    var clock = new RecordingAccuracy.Timeline();
    assertEquals(0, clock.observe(9_000_000, 1_000_000_000L));
    assertEquals(1_000_000, clock.observe(10_000_000, 3_000_000_000L));
    try { clock.observe(11_000_000, 7_000_000_000L); fail("Backlog must fail, not stretch video"); }
    catch (RecordingAccuracy.Failure expected) {}
    try { clock.observe(1, 7_000_000_000L); fail("Clock reset must fail"); }
    catch (RecordingAccuracy.Failure expected) {}
  }

  @Test public void sharedValidationRejectsStretchedVideoAndShortAudio() throws Exception {
    RecordingAccuracy.duration(120_050_000, 120_000_000, "Video");
    for (long actual : new long[] {74_900_000, 180_000_000}) {
      try { RecordingAccuracy.duration(actual, 121_550_000, "Video/audio"); fail(); }
      catch (RecordingAccuracy.Failure expected) {}
    }
  }

  @Test public void deviceCameraUsesSupportedFrameRate() throws Exception {
    android.util.Range<Integer>[] ranges = new android.util.Range[] {
      new android.util.Range<>(15, 15), new android.util.Range<>(15, 30), new android.util.Range<>(30, 30)
    };
    assertEquals(Integer.valueOf(15), DeviceCameraRecorder.recordingRate(ranges, 66_666_666).getUpper());
    assertEquals(Integer.valueOf(30), DeviceCameraRecorder.recordingRate(ranges, 33_333_333).getLower());
  }

  @Test
  public void playerScreenAndForegroundService() throws Exception {
    android.app.Instrumentation i = InstrumentationRegistry.getInstrumentation();
    if (android.os.Build.VERSION.SDK_INT >= 33)
      i.getUiAutomation()
          .grantRuntimePermission(
              i.getTargetContext().getPackageName(),
              android.Manifest.permission.POST_NOTIFICATIONS);
    MainActivity activity =
        (MainActivity)
            i.startActivitySync(
                new android.content.Intent(i.getTargetContext(), MainActivity.class)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
    Engine engine = Engine.get(activity);
    engine.busy = true;
    try {
      i.runOnMainSync(
          () ->
              activity.startForegroundService(
                  new android.content.Intent(activity, RecorderService.class)));
      Thread.sleep(2000);
      java.util.concurrent.CountDownLatch loaded = new java.util.concurrent.CountDownLatch(1);
      java.util.concurrent.atomic.AtomicReference<String> result =
          new java.util.concurrent.atomic.AtomicReference<>();
      i.runOnMainSync(
          () -> {
            android.webkit.WebView w =
                (android.webkit.WebView)
                    ((android.view.ViewGroup) activity.findViewById(android.R.id.content))
                        .getChildAt(0);
            w.evaluateJavascript(
                "document.getElementById('begin').textContent.includes('Tap to start') &&"
                    + " document.querySelector('.court').naturalWidth>0 &&"
                    + " document.getElementById('queue-indicator') !== null &&"
                    + " document.getElementById('camera-test-video') !== null &&"
                    + " document.getElementById('camera-test-confirm').textContent.includes('see and hear') &&"
                    + " document.getElementById('camera-test-retry').textContent.includes('another test')",
                v -> {
                  result.set(v);
                  loaded.countDown();
                });
          });
      assertTrue(loaded.await(5, java.util.concurrent.TimeUnit.SECONDS));
      assertEquals("true", result.get());

      java.util.concurrent.CountDownLatch uploadUiLoaded =
          new java.util.concurrent.CountDownLatch(1);
      java.util.concurrent.atomic.AtomicReference<String> uploadUiResult =
          new java.util.concurrent.atomic.AtomicReference<>();
      i.runOnMainSync(
          () -> {
            android.webkit.WebView w =
                (android.webkit.WebView)
                    ((android.view.ViewGroup) activity.findViewById(android.R.id.content))
                        .getChildAt(0);
            w.evaluateJavascript(
                "renderUploadStatus([{status:'pending'},{status:'uploading'},{status:'uploaded'},{status:'failed'}]);"
                    + " !document.getElementById('queue-indicator').hidden &&"
                    + " document.getElementById('queue-pending').textContent === '1' &&"
                    + " document.getElementById('queue-uploading').textContent === '1' &&"
                    + " document.getElementById('queue-completed').textContent === '1' &&"
                    + " document.getElementById('queue-failed').textContent === '1'",
                value -> {
                  uploadUiResult.set(value);
                  uploadUiLoaded.countDown();
                });
          });
      assertTrue(uploadUiLoaded.await(5, java.util.concurrent.TimeUnit.SECONDS));
      assertEquals("true", uploadUiResult.get());

      engine.cameraTestReady = true;
      engine.cameraTestHasAudio = true;
      engine.cameraTestRevision = "test-revision";
      engine.cameraTestCamera = "{\"type\":\"device\"}";
      engine.cameraTestToken = "test-token";
      Thread.sleep(1000);
      java.util.concurrent.CountDownLatch reviewLoaded = new java.util.concurrent.CountDownLatch(1);
      java.util.concurrent.atomic.AtomicReference<String> reviewResult =
          new java.util.concurrent.atomic.AtomicReference<>();
      i.runOnMainSync(
          () -> {
            android.webkit.WebView w =
                (android.webkit.WebView)
                    ((android.view.ViewGroup) activity.findViewById(android.R.id.content))
                        .getChildAt(0);
            w.evaluateJavascript(
                "!document.getElementById('camera-test').hidden &&"
                    + " document.getElementById('camera-test-video').src.includes('/camera-test/clip.mp4') &&"
                    + " document.getElementById('camera-test-confirm').textContent.includes('see and hear')",
                v -> {
                  reviewResult.set(v);
                  reviewLoaded.countDown();
                });
          });
      assertTrue(reviewLoaded.await(5, java.util.concurrent.TimeUnit.SECONDS));
      assertEquals("true", reviewResult.get());
      android.graphics.Bitmap image = i.getUiAutomation().takeScreenshot();
      if (image != null)
        try (java.io.FileOutputStream out =
            new java.io.FileOutputStream(new File(activity.getCacheDir(), "player-test.png"))) {
          image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
        }

      long notificationDeadline = System.nanoTime() + 12_000_000_000L;
      while (i.getTargetContext().getSystemService(android.app.NotificationManager.class)
          .getActiveNotifications().length == 0 && System.nanoTime() < notificationDeadline)
        Thread.sleep(100);
      assertEquals(
          1,
          i.getTargetContext()
              .getSystemService(android.app.NotificationManager.class)
              .getActiveNotifications()
              .length);
      RecorderService.updateUploadProgress(42);
      Thread.sleep(250);
      android.service.notification.StatusBarNotification active =
          i.getTargetContext()
              .getSystemService(android.app.NotificationManager.class)
              .getActiveNotifications()[0];
      assertTrue(
          String.valueOf(active.getNotification().extras.getCharSequence("android.text"))
              .contains("42%"));
      i.runOnMainSync(
          () -> activity.stopService(new android.content.Intent(activity, RecorderService.class)));
    } finally {
      engine.cameraTestReady = false;
      engine.cameraTestHasAudio = false;
      engine.cameraTestRevision = "";
      engine.cameraTestCamera = "";
      engine.cameraTestToken = "";
      engine.busy = false;
      i.runOnMainSync(
          () -> activity.stopService(new android.content.Intent(activity, RecorderService.class)));
      i.runOnMainSync(activity::finish);
    }
  }

  @Test
  public void uriEscapesCredentialsAndRejectsUnsafeInput() throws Exception {
    assertEquals(
        "rtsp://u%3Aa:p%40%20x@192.168.1.2:554/stream1",
        RtspRecorder.cameraUri("rtsp://192.168.1.2:554/stream1", "u:a", "p@ x"));
    try {
      RtspRecorder.cameraUri("https://example.com", "", "");
      fail();
    } catch (Exception expected) {
    }
    try {
      RtspRecorder.cameraUri("rtsp://user:pass@192.168.1.2/stream1", "", "");
      fail();
    } catch (Exception expected) {
    }
  }

  @Test
  public void managedCameraRequiresMatchingRevision() throws Exception {
    android.content.Context c = InstrumentationRegistry.getInstrumentation().getTargetContext();
    Engine engine = Engine.get(c);
    engine.heartbeat.shutdownNow();
    engine.vault.put("camera", "{}");
    engine.vault.put("camera-revision", "revision-1");
    org.json.JSONObject d =
        new org.json.JSONObject()
            .put("recorder_mode", "android_rtsp")
            .put("video_device", "android-rtsp-v2")
            .put("tested_at", "2026-10-06")
            .put("config_revision", "revision-1")
            .put("tested_revision", "revision-1");
    assertTrue(engine.cameraReady(d));
    d.put("config_revision", "revision-2");
    assertFalse(engine.cameraReady(d));
    d.put("config_revision", "revision-1").put("tested_revision", org.json.JSONObject.NULL);
    assertFalse(engine.cameraReady(d));
    engine.vault.put("camera", "");
    engine.vault.put("camera-revision", "");
  }

  @Test
  public void deviceCameraSourceIsSelectedFromManagedConfiguration() throws Exception {
    Engine engine = Engine.get(InstrumentationRegistry.getInstrumentation().getTargetContext());
    JSONObject original = engine.server;
    try {
      engine.server =
          new JSONObject()
              .put("device", new JSONObject().put("video_device", "android-camera-v1"));
      assertTrue(engine.usesDeviceCamera());
      assertFalse(engine.usesWifiCamera());
      engine.server =
          new JSONObject()
              .put("device", new JSONObject().put("video_device", "android-rtsp-v2"));
      assertFalse(engine.usesDeviceCamera());
      assertTrue(engine.usesWifiCamera());
      engine.server =
          new JSONObject()
              .put("device", new JSONObject().put("video_device", "unexpected-source"));
      assertFalse(engine.usesDeviceCamera());
      assertFalse(engine.usesWifiCamera());
    } finally {
      engine.server = original;
    }
  }

  @Test
  public void audioExpectationMatchesCameraMode() throws Exception {
    Engine engine = Engine.get(InstrumentationRegistry.getInstrumentation().getTargetContext());
    assertTrue(engine.expectsAudio(new JSONObject().put("type", "device")));
    assertTrue(
        engine.expectsAudio(new JSONObject().put("type", "rtsp").put("audio", true)));
    assertFalse(
        engine.expectsAudio(new JSONObject().put("type", "rtsp").put("audio", false)));
  }

  @Test
  public void corruptRecordingIsRejected() throws Exception {
    File f =
        new File(
            InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),
            "missing.mp4");
    try {
      RtspRecorder.validate(f);
      fail();
    } catch (Exception expected) {
    }
  }

  @Test
  public void vaultPersistsEncryptedData() throws Exception {
    android.content.Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String preferenceName = "vault-test-" + java.util.UUID.randomUUID();
    android.content.Context c =
        new android.content.ContextWrapper(base) {
          public android.content.Context getApplicationContext() {
            return this;
          }

          public android.content.SharedPreferences getSharedPreferences(String name, int mode) {
            return base.getSharedPreferences(preferenceName, mode);
          }
        };
    Vault v = new Vault(c);
    try {
      v.put("test-secret", "fixture-password");
      assertEquals("fixture-password", new Vault(c).get("test-secret"));
      assertFalse(
          c.getSharedPreferences("vault", 0).getAll().toString().contains("fixture-password"));
    } finally {
      base.getSharedPreferences(preferenceName, 0).edit().clear().commit();
    }
  }
}

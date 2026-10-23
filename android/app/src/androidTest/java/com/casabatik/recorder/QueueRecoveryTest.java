package com.casabatik.recorder;

import static org.junit.Assert.*;
import android.content.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.util.UUID;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class QueueRecoveryTest {
  @Test public void restartRestoresUploadsWithoutDeletingFootageOrResettingRetries() throws Exception {
    Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String namespace = "queue-test-" + UUID.randomUUID();
    String deviceId = UUID.randomUUID().toString();
    File root = new File(base.getCacheDir(), namespace);
    Context context = new ContextWrapper(base) {
      public Context getApplicationContext() { return this; }
      public File getFilesDir() { return root; }
      public SharedPreferences getSharedPreferences(String name, int mode) {
        return base.getSharedPreferences(namespace + name, mode);
      }
    };
    File directory = new File(root, "recordings");
    assertTrue(directory.mkdirs());
    JSONArray jobs = new JSONArray();
    String[] states = {"uploading", "recording", "local_only", "failed", "uploaded", "retrying"};
    File[] files = new File[states.length];
    Engine engine = null;
    try {
      for (int i = 0; i < states.length; i++) {
        String id = UUID.randomUUID().toString();
        files[i] = new File(directory, id + ".mp4");
        try (FileOutputStream out = new FileOutputStream(files[i])) { out.write(new byte[2048]); }
        jobs.put(new JSONObject().put("id", id).put("device", deviceId).put("status", states[i]).put("retryCount", 7)
            .put("createdAt", i).put("nextRetryAt", states[i].equals("retrying") ? System.currentTimeMillis()+60000 : 0)
            .put("localAvailable", true));
      }
      Vault vault = new Vault(context);
      vault.put("upload-queue", jobs.toString());
      engine = new Engine(context);
      engine.heartbeat.shutdownNow();
      engine.server = new JSONObject().put("device", new JSONObject().put("id", deviceId));
      JSONArray restored = new Vault(context).array("upload-queue");
      for (int i = 0; i < states.length; i++) {
        assertEquals(2048, files[i].length());
        assertEquals(i == 0 ? 8 : 7, restored.getJSONObject(i).getInt("retryCount"));
        assertEquals(i == 0 ? "failed" : i == 1 ? "pending" : states[i], restored.getJSONObject(i).getString("status"));
      }
      // Simulate the restored head backing off: another eligible item wins.
      restored.getJSONObject(0).put("status", "retrying").put("nextRetryAt", System.currentTimeMillis()+60000);
      engine.vault.put("upload-queue", restored.toString());
      var next = Engine.class.getDeclaredMethod("nextUpload"); next.setAccessible(true);
      assertEquals(restored.getJSONObject(1).getString("id"), ((JSONObject)next.invoke(engine)).getString("id"));
      // Re-enrollment must not process or reset a different device's saved jobs.
      restored.getJSONObject(1).put("device", UUID.randomUUID().toString());
      engine.vault.put("upload-queue", restored.toString());
      assertNull(next.invoke(engine));
      try {engine.localPlaybackFile(restored.getJSONObject(1).getString("id"));fail("Foreign-device local playback must be denied");}
      catch(Exception expected){assertTrue(expected.getMessage().contains("playable"));}
      engine.retryUpload(restored.getJSONObject(1).getString("id"));
      assertEquals(7, engine.vault.array("upload-queue").getJSONObject(1).getInt("retryCount"));
      restored.getJSONObject(1).put("device", deviceId);
      // A stale pre-failure server poll cannot grant a new retry budget.
      restored.getJSONObject(3).put("failureServerUpdatedAt", "2026-10-13T12:00:00Z");
      engine.vault.put("upload-queue", restored.toString());
      assertEquals(files[1],engine.localPlaybackFile(restored.getJSONObject(1).getString("id")));
      JSONObject remote = new JSONObject().put("session_id", restored.getJSONObject(3).getString("id"))
          .put("upload_state", "retrying").put("retry_count", 0).put("last_error", "")
          .put("upload_updated_at", "2026-10-13T11:59:00Z");
      engine.server.put("queue", new JSONArray().put(remote));
      var reconcile = Engine.class.getDeclaredMethod("reconcileServerUploadRequests"); reconcile.setAccessible(true);
      reconcile.invoke(engine);
      assertEquals("failed", engine.vault.array("upload-queue").getJSONObject(3).getString("status"));
      remote.put("upload_updated_at", "2026-10-13T12:01:00Z");
      reconcile.invoke(engine);
      assertEquals("pending", engine.vault.array("upload-queue").getJSONObject(3).getString("status"));
    } finally {
      if (engine != null) { engine.heartbeat.shutdownNow(); engine.work.shutdownNow(); engine.uploads.shutdownNow(); }
      // Only this test's synthetic files are removed.
      for (File file : files) if (file != null) file.delete();
      directory.delete(); root.delete();
      context.getSharedPreferences("vault", 0).edit().clear().commit();
    }
  }
}

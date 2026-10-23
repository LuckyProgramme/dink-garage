package com.casabatik.recorder;

import static org.junit.Assert.*;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class UploadTransferTest {
  @Test
  public void chunkTransportUsesPairedEndpointAndExactFileRange() throws Exception {
    android.content.Context base =
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().getTargetContext();
    String preferenceName = "upload-transfer-test-" + java.util.UUID.randomUUID();
    android.content.Context context =
        new android.content.ContextWrapper(base) {
          public android.content.Context getApplicationContext() {
            return this;
          }

          public android.content.SharedPreferences getSharedPreferences(String name, int mode) {
            return base.getSharedPreferences(preferenceName, mode);
          }
        };
    Vault vault = new Vault(context);
    java.io.File file = new java.io.File(context.getCacheDir(), "upload-fixture.bin");
    try {
      vault.put("cookies", "{\"cb-kiosk\":\"fixture-device-token\"}");
      try (java.io.FileOutputStream out = new java.io.FileOutputStream(file)) {
        out.write(new byte[] {1, 2, 3, 4, 5});
      }
      java.io.ByteArrayOutputStream sent = new java.io.ByteArrayOutputStream();
      java.net.HttpURLConnection[] request = new java.net.HttpURLConnection[1];
      Api api =
          new Api(
              vault,
              url ->
                  request[0] =
                      new java.net.HttpURLConnection(url) {
                        public void connect() {}

                        public void disconnect() {}

                        public boolean usingProxy() {
                          return false;
                        }

                        public java.io.OutputStream getOutputStream() {
                          return sent;
                        }

                        public int getResponseCode() {
                          return 200;
                        }

                        public java.io.InputStream getInputStream() {
                          return new java.io.ByteArrayInputStream(
                              "{\"accepted\":true}"
                                  .getBytes(java.nio.charset.StandardCharsets.UTF_8));
                        }
                      });
      String id = "12345678-1234-1234-1234-123456789abc";
      assertTrue(api.uploadChunk(id, file, 2, 3).getBoolean("accepted"));
      assertEquals(
          Api.ORIGIN + "/api/tablet/upload-chunk?id=" + id, request[0].getURL().toString());
      assertEquals("PUT", request[0].getRequestMethod());
      assertEquals(Api.ORIGIN, request[0].getRequestProperty("Origin"));
      assertEquals("cb-kiosk=fixture-device-token", request[0].getRequestProperty("Cookie"));
      assertEquals("bytes 2-4/5", request[0].getRequestProperty("Content-Range"));
      assertEquals("video/mp4", request[0].getRequestProperty("Content-Type"));
      assertArrayEquals(new byte[] {3, 4, 5}, sent.toByteArray());
    } finally {
      file.delete();
      base.getSharedPreferences(preferenceName, 0).edit().clear().commit();
    }
  }

  static class Backend implements UploadTransfer.Transport {
    long offset = 0, bytes = 5 * 1024 * 1024;
    int chunks = 0, restarts = 0;
    boolean expire = false, loseResponse = false, confirm = true;

    public JSONObject action(String action) throws Exception {
      if (action.equals("upload")) return new JSONObject().put("ready", false);
      if (action.equals("restart-upload")) {
        restarts++;
        offset = 0;
        return new JSONObject().put("ready", false);
      }
      if (action.equals("finish")) return new JSONObject().put("ready", confirm && offset == bytes);
      return offset == bytes
          ? new JSONObject().put("uploaded", true)
          : new JSONObject().put("offset", offset);
    }

    public JSONObject chunk(long start, int length) throws Exception {
      assertEquals(offset, start);
      assertTrue(length > 0 && length <= 4 * 1024 * 1024);
      chunks++;
      if (expire) {
        expire = false;
        return new JSONObject().put("expired", true);
      }
      offset += length;
      if (loseResponse) {
        loseResponse = false;
        throw new java.io.IOException("Connection interrupted");
      }
      return new JSONObject().put("accepted", true).put("complete", offset == bytes);
    }
  }

  @Test
  public void currentResponseWithoutUriUploadsAndConfirms() throws Exception {
    Backend backend = new Backend();
    long[] progress = {-1};
    UploadTransfer.send(backend.bytes, backend, value -> progress[0] = value);
    assertEquals(2, backend.chunks);
    assertEquals(100, progress[0]);
  }

  @Test
  public void queuedUploadWaitsForTheFirstDeviceAndReportsItsProgress() throws Exception {
    Backend backend =
        new Backend() {
          int uploadCalls = 0;

          public JSONObject action(String action) throws Exception {
            if (action.equals("upload") && uploadCalls++ == 0)
              return new JSONObject()
                  .put("ready", false)
                  .put("queued", true)
                  .put(
                      "queue",
                      new JSONObject()
                          .put("activeDevice", "Tablet 1")
                          .put("position", 2)
                          .put("total", 2)
                          .put("percent", 45));
            return super.action(action);
          }
        };
    int[] queueProgress = {-1};
    UploadTransfer.send(
        backend.bytes,
        backend,
        value -> {},
        queue -> queueProgress[0] = queue.optInt("percent"));
    assertEquals(45, queueProgress[0]);
    assertEquals(backend.bytes, backend.offset);
  }

  @Test
  public void cancelledUploadStopsUntilManualRecoveryRequeuesIt() throws Exception {
    boolean[] retried = {false};
    Backend backend =
        new Backend() {
          public JSONObject action(String action) throws Exception {
            if (action.equals("retry-upload")) {
              retried[0] = true;
              return new JSONObject().put("ready", false);
            }
            if (action.equals("upload") && !retried[0])
              return new JSONObject()
                  .put("ready", false)
                  .put("queued", true)
                  .put("queue", new JSONObject().put("state", "cancelled"));
            return super.action(action);
          }
        };
    try {
      UploadTransfer.send(backend.bytes, backend, value -> {});
      fail();
    } catch (UploadTransfer.CancelledException expected) {
      assertTrue(expected.getMessage().contains("remains saved"));
    }
    assertEquals(0, backend.chunks);

    UploadTransfer.send(backend.bytes, backend, value -> {}, queue -> {}, true);
    assertTrue(retried[0]);
    assertEquals(backend.bytes, backend.offset);
  }

  @Test
  public void recoveryResumesAtAcknowledgedOffsetAfterLostResponse() throws Exception {
    Backend backend = new Backend();
    backend.loseResponse = true;
    try {
      UploadTransfer.send(backend.bytes, backend, value -> {});
      fail();
    } catch (java.io.IOException expected) {
    }
    assertEquals(4 * 1024 * 1024, backend.offset);
    UploadTransfer.send(backend.bytes, backend, value -> {});
    assertEquals(2, backend.chunks);
    assertEquals(backend.bytes, backend.offset);
  }

  @Test
  public void expiredSessionRestartsAndMissingConfirmationFails() throws Exception {
    Backend backend = new Backend();
    backend.expire = true;
    backend.confirm = false;
    try {
      UploadTransfer.send(backend.bytes, backend, value -> {});
      fail();
    } catch (Exception expected) {
      assertTrue(expected.getMessage().contains("confirmation"));
    }
    assertEquals(1, backend.restarts);
    backend.confirm = true;
    UploadTransfer.send(backend.bytes, backend, value -> {});
    assertEquals(3, backend.chunks);
  }
}

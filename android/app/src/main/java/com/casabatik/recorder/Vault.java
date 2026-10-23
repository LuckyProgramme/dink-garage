package com.casabatik.recorder;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/** Device-only encrypted settings and recovery journal. Never backed up. */
final class Vault {
  private final Context context;
  private JSONObject values;

  Vault(Context c) {
    context = c.getApplicationContext();
    try {
      String saved = context.getSharedPreferences("vault", 0).getString("data", null);
      if (saved == null) values = new JSONObject();
      else {
        JSONObject box = new JSONObject(saved);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            new GCMParameterSpec(128, Base64.decode(box.getString("iv"), Base64.NO_WRAP)));
        values =
            new JSONObject(
                new String(
                    cipher.doFinal(Base64.decode(box.getString("bytes"), Base64.NO_WRAP)),
                    java.nio.charset.StandardCharsets.UTF_8));
      }
    } catch (Exception e) {
      throw new IllegalStateException(
          "Secure storage cannot be opened. Do not clear app data if videos are pending.");
    }
  }

  private SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    String alias = "casa-batik-recorder-v1";
    if (!store.containsAlias(alias)) {
      KeyGenerator gen =
          KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
      gen.init(
          new KeyGenParameterSpec.Builder(
                  alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
              .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
              .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
              .build());
      gen.generateKey();
    }
    return (SecretKey) store.getKey(alias, null);
  }

  synchronized String get(String name) {
    return values.optString(name, "");
  }

  synchronized JSONObject object(String name) {
    try {
      return new JSONObject(get(name));
    } catch (Exception e) {
      return new JSONObject();
    }
  }

  synchronized JSONArray array(String name) {
    try {
      return new JSONArray(get(name));
    } catch (Exception e) {
      return new JSONArray();
    }
  }

  synchronized void put(String name, String value) throws Exception {
    values.put(name, value);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key());
    JSONObject box =
        new JSONObject()
            .put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .put(
                "bytes",
                Base64.encodeToString(
                    cipher.doFinal(
                        values.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)),
                    Base64.NO_WRAP));
    if (!context.getSharedPreferences("vault", 0).edit().putString("data", box.toString()).commit())
      throw new Exception("Could not save device state.");
  }
}

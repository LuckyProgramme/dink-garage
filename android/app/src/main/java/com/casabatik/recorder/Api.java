package com.casabatik.recorder;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.JSONObject;

final class Api {
  static final String ORIGIN = BuildConfig.APP_ORIGIN;
  private final Vault vault;

  interface Connections {
    HttpURLConnection open(URL url) throws Exception;
  }

  private final Connections connections;

  Api(Vault v) {
    this(v, url -> (HttpURLConnection) url.openConnection());
  }

  Api(Vault v, Connections connections) {
    vault = v;
    this.connections = connections;
  }

  synchronized JSONObject call(String path, JSONObject body) throws Exception {
    if (!path.startsWith("/api/")) throw new Exception("Invalid application request.");
    HttpURLConnection c = connections.open(new URL(ORIGIN + path));
    c.setConnectTimeout(15000);
    c.setReadTimeout(30000);
    c.setInstanceFollowRedirects(false);
    c.setRequestProperty("Accept", "application/json");
    c.setRequestProperty("Origin", ORIGIN);
    JSONObject jar = vault.object("cookies");
    List<String> cookies = new ArrayList<>();
    for (Iterator<String> i = jar.keys(); i.hasNext(); ) {
      String n = i.next();
      cookies.add(n + "=" + jar.getString(n));
    }
    if (!cookies.isEmpty()) c.setRequestProperty("Cookie", String.join("; ", cookies));
    try {
      if (body != null) {
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        try (OutputStream o = c.getOutputStream()) {
          o.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
      }
      int status = c.getResponseCode();
      for (Map.Entry<String, List<String>> h : c.getHeaderFields().entrySet())
        if ("set-cookie".equalsIgnoreCase(h.getKey()))
          for (String line : h.getValue())
            for (HttpCookie cookie : HttpCookie.parse(line)) {
              if (cookie.getMaxAge() == 0) jar.remove(cookie.getName());
              else jar.put(cookie.getName(), cookie.getValue());
            }
      vault.put("cookies", jar.toString());
      InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
      String text = in == null ? "" : read(in);
      JSONObject result;
      try {
        result = new JSONObject(text);
      } catch (Exception e) {
        throw new Exception("Hosted app unavailable. Check the deployment and try again.");
      }
      if (status < 200 || status >= 300)
        throw new Exception(result.optString("error", "Request failed. Please retry."));
      return result;
    } finally {
      c.disconnect();
    }
  }

  JSONObject tablet(String action, JSONObject fields) throws Exception {
    return call("/api/tablet", fields.put("action", action));
  }

  static String read(InputStream in) throws IOException {
    try (in;
        ByteArrayOutputStream b = new ByteArrayOutputStream()) {
      byte[] chunk = new byte[8192];
      int n;
      while ((n = in.read(chunk)) != -1) {
        if (b.size() + n > 2_000_000) throw new IOException("Response too large.");
        b.write(chunk, 0, n);
      }
      return b.toString("UTF-8");
    }
  }

  JSONObject uploadChunk(String session, File file, long offset, int length) throws Exception {
    UUID.fromString(session);
    if (offset < 0 || length < 1 || length > 4 * 1024 * 1024 || offset + length > file.length())
      throw new Exception("Invalid upload chunk.");
    HttpURLConnection c =
        connections.open(new URL(ORIGIN + "/api/tablet/upload-chunk?id=" + session));
    c.setRequestProperty("Origin", ORIGIN);
    c.setRequestProperty("Accept", "application/json");
    String credential = vault.object("cookies").optString("cb-kiosk");
    if (credential.isEmpty()) throw new Exception("Tablet enrollment is missing.");
    c.setRequestProperty("Cookie", "cb-kiosk=" + credential);
    try {
      c.setInstanceFollowRedirects(false);
      c.setConnectTimeout(15000);
      c.setReadTimeout(60000);
      c.setRequestMethod("PUT");
      c.setDoOutput(true);
      c.setFixedLengthStreamingMode(length);
      c.setRequestProperty("Content-Type", "video/mp4");
      c.setRequestProperty(
          "Content-Range", "bytes " + offset + "-" + (offset + length - 1) + "/" + file.length());
      try (RandomAccessFile f = new RandomAccessFile(file, "r");
          OutputStream o = c.getOutputStream()) {
        f.seek(offset);
        byte[] b = new byte[65536];
        int remain = length;
        while (remain > 0) {
          int n = f.read(b, 0, Math.min(b.length, remain));
          if (n < 0) throw new IOException("Video incomplete.");
          o.write(b, 0, n);
          remain -= n;
        }
      }
      int status = c.getResponseCode();
      InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
      JSONObject result;
      try {
        result = new JSONObject(in == null ? "" : read(in));
      } catch (Exception e) {
        throw new Exception("Upload service unavailable. Saved video remains on this tablet.");
      }
      if (status < 200 || status >= 300)
        throw new Exception(
            result.optString("error", "Upload interrupted. Retry the saved video."));
      return result;
    } finally {
      c.disconnect();
    }
  }
}

package com.casabatik.recorder;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import androidx.webkit.WebViewAssetLoader;
import java.net.URI;
import java.util.ArrayList;
import org.json.JSONObject;

public final class MainActivity extends androidx.activity.ComponentActivity {
  private Engine engine;
  private WebView web;
  private boolean configureDeviceCameraAfterPermission;

  @Override
  public void onCreate(Bundle b) {
    super.onCreate(b);
    try {
      engine = Engine.get(this);
    } catch (Exception e) {
      new AlertDialog.Builder(this)
          .setMessage(e.getMessage())
          .setPositiveButton("Close", (d, w) -> finish())
          .show();
      return;
    }
    getOnBackPressedDispatcher()
        .addCallback(
            this,
            new androidx.activity.OnBackPressedCallback(true) {
              @Override
              public void handleOnBackPressed() {
                leavePlayer();
              }
            });
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    web = new WebView(this);
    web.setBackgroundColor(Color.rgb(252, 252, 248));
    setContentView(web);
    web.setOnApplyWindowInsetsListener(
        (v, insets) -> {
          if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets i =
                insets.getInsets(android.view.WindowInsets.Type.systemBars());
            v.setPadding(i.left, i.top, i.right, i.bottom);
          } else
            v.setPadding(
                insets.getSystemWindowInsetLeft(),
                insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(),
                insets.getSystemWindowInsetBottom());
          return insets;
        });
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(false);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    WebViewAssetLoader loader =
        new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler(
                "/camera-test/",
                new WebViewAssetLoader.InternalStoragePathHandler(
                    this, engine.cameraTestDirectory()))
            .build();
    web.setWebViewClient(
        new WebViewClient() {
          @Override
          public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
            Uri u = req.getUrl();
            if ("appassets.androidplatform.net".equals(u.getHost())
                && "https".equals(u.getScheme())) return loader.shouldInterceptRequest(u);
            return new WebResourceResponse(
                "text/plain", "UTF-8", new java.io.ByteArrayInputStream(new byte[0]));
          }

          @Override
          public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
            return true;
          }
        });
    web.addJavascriptInterface(new Bridge(), "CasaNative");
    web.loadUrl("https://appassets.androidplatform.net/assets/index.html");
    ArrayList<String> permissions = new ArrayList<>();
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
            != android.content.pm.PackageManager.PERMISSION_GRANTED)
      permissions.add(android.Manifest.permission.POST_NOTIFICATIONS);
    if (!permissions.isEmpty()) requestPermissions(permissions.toArray(new String[0]), 1);
  }

  private final class Bridge {
    @JavascriptInterface
    public String state() {
      return engine.snapshot();
    }

    @JavascriptInterface
    public void action(String action, String value) {
      if (value == null || value.length() > ("start".equals(action) ? 1200 : 254)) return;
      switch (action) {
        case "setup":
          runOnUiThread(() -> setup());
          break;
        case "reenroll":
          runOnUiThread(() -> enrollment(true));
          break;
        case "start":
          engine.start(value.trim());
          break;
        case "stop":
          engine.requestStop();
          break;
        case "recover":
          engine.recover();
          break;
        case "retry-upload":
          engine.retryUpload(value.trim());
          break;
        case "confirm-camera-test":
          engine.confirmCameraTest(true, false);
          break;
        case "retry-camera-test":
          engine.confirmCameraTest(false, true);
          break;
        case "reset":
          engine.reset();
          break;
        case "discard":
          runOnUiThread(
              () ->
                  new AlertDialog.Builder(MainActivity.this)
                      .setTitle("Discard saved footage?")
                      .setMessage(
                          "This permanently deletes the unsent video from this tablet. Try Recover"
                              + " first.")
                      .setPositiveButton("Delete video", (d, w) -> engine.discard())
                      .setNegativeButton("Keep video", null)
                      .show());
          break;
      }
    }
  }

  private LinearLayout panel() {
    LinearLayout p = new LinearLayout(this);
    p.setOrientation(LinearLayout.VERTICAL);
    int pad = (int) (20 * getResources().getDisplayMetrics().density);
    p.setPadding(pad, pad, pad, pad);
    return p;
  }

  private EditText field(LinearLayout p, String label, String value, boolean secret) {
    TextView title = new TextView(this);
    title.setText(label);
    p.addView(title);
    EditText input = new EditText(this);
    input.setSingleLine(true);
    input.setText(value);
    input.setInputType(secret ? 129 : 1);
    p.addView(input);
    return input;
  }

  private JSONObject cameraConfiguration(Object... entries) {
    JSONObject result = new JSONObject();
    try {
      for (int index = 0; index < entries.length; index += 2)
        result.put(String.valueOf(entries[index]), entries[index + 1]);
      return result;
    } catch (Exception impossible) {
      throw new IllegalStateException("Could not prepare camera settings.", impossible);
    }
  }

  private void setup() {
    if (engine.busy) {
      Toast.makeText(this, "Finish the current operation first.", Toast.LENGTH_SHORT).show();
      return;
    }
    if (!engine.server.optBoolean("enabled")) {
      if (engine.hasStoredEnrollment()) {
        new AlertDialog.Builder(this)
            .setTitle("Enrollment saved")
            .setMessage(
                "This tablet already has a saved enrollment, but its assignment could not be retrieved. Check the connection and try again. Re-enroll only when you intentionally want to replace the saved device.")
            .setPositiveButton("Check again", (d, w) -> engine.refreshConfiguration())
            .setNeutralButton("Re-enroll", (d, w) -> enrollment(true))
            .setNegativeButton("Close", null)
            .show();
      } else enrollment(false);
      return;
    }
    boolean deviceCamera = engine.usesDeviceCamera();
    boolean wifiCamera = engine.usesWifiCamera();
    if (!deviceCamera && !wifiCamera) {
      chooseCameraMode();
      return;
    }
    if (deviceCamera && !DeviceCameraRecorder.hasPermissions(this)) {
      configureDeviceCameraAfterPermission = true;
      requestPermissions(
          new String[] {
            android.Manifest.permission.CAMERA, android.Manifest.permission.RECORD_AUDIO
          },
          2);
      return;
    }
    new AlertDialog.Builder(this)
        .setTitle(
            deviceCamera
                ? "USB / built-in camera"
                : wifiCamera ? "Tapo Wi-Fi camera mode" : "Camera setup incomplete")
        .setMessage(
            deviceCamera
                ? "Uses an attached Android-compatible USB camera when available, otherwise this tablet’s rear camera. Allow camera and microphone access, then run the test."
                : wifiCamera
                    ? "Uses the external Tapo stream on the same Wi-Fi. This Android camera and microphone are not used."
                    : "Choose this tablet camera or a Tapo Wi-Fi camera.")
        .setPositiveButton(
            (wifiCamera || deviceCamera) ? "Record a 3-second test clip" : "Check again",
            (d, w) -> engine.syncCamera())
        .setNeutralButton("Change camera", (d, w) -> chooseCameraMode())
        .setNegativeButton("Close", null)
        .show();
  }

  private void chooseCameraMode() {
    new AlertDialog.Builder(this)
        .setTitle("Set up this tablet camera")
        .setItems(
            new String[] {
              "Wired USB / built-in Android camera\nUses this tablet and its microphone",
              "Tapo Wi-Fi camera\nUses a Camera Account on the same network"
            },
            (dialog, which) -> {
              if (which == 0) configureDeviceCamera();
              else configureTapoCamera();
            })
        .setNeutralButton("Re-enroll", (dialog, which) -> enrollment(true))
        .setNegativeButton("Close", null)
        .show();
  }

  private void configureDeviceCamera() {
    if (!DeviceCameraRecorder.hasPermissions(this)) {
      configureDeviceCameraAfterPermission = true;
      requestPermissions(
          new String[] {
            android.Manifest.permission.CAMERA, android.Manifest.permission.RECORD_AUDIO
          },
          2);
      return;
    }
    engine.configureCamera(cameraConfiguration("recorder_mode", "android_camera"));
  }

  private String rtspHost(JSONObject device) {
    try {
      String value = device.optString("rtsp_url");
      return value.isEmpty() ? "" : new URI(value).getHost();
    } catch (Exception ignored) {
      return "";
    }
  }

  private void configureTapoCamera() {
    JSONObject currentDevice = engine.server.optJSONObject("device");
    final JSONObject device = currentDevice == null ? new JSONObject() : currentDevice;
    final boolean savedTapo = engine.usesWifiCamera();
    LinearLayout p = panel();
    TextView help = new TextView(this);
    help.setText(
        "Use the Tapo Camera Account credentials, not the Tapo app or Wi-Fi password. The camera and tablet must be on the same network.");
    p.addView(help);
    EditText name = field(p, "Camera name", savedTapo ? device.optString("camera_name") : "", false);
    EditText host = field(p, "Camera IP address", savedTapo ? rtspHost(device) : "", false);
    EditText user =
        field(p, "Camera Account username", savedTapo ? device.optString("rtsp_username") : "", false);
    EditText password = field(p, "Camera Account password", "", true);
    if (savedTapo && device.optBoolean("has_camera_password"))
      password.setHint("Leave blank to keep the saved password");
    AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle("Set up Tapo Wi-Fi camera")
            .setView(p)
            .setPositiveButton("Save and record test clip", null)
            .setNegativeButton("Cancel", null)
            .create();
    dialog.setOnShowListener(
        ignored ->
            dialog
                .getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(
                    view -> {
                      if (name.getText().toString().trim().isEmpty()
                          || host.getText().toString().trim().isEmpty()
                          || user.getText().toString().trim().isEmpty()
                          || (password.getText().toString().isEmpty()
                              && !(savedTapo && device.optBoolean("has_camera_password")))) {
                        Toast.makeText(
                                this,
                                "Enter the camera name, IP address, username, and password.",
                                Toast.LENGTH_LONG)
                            .show();
                        return;
                      }
                      engine.configureCamera(
                          cameraConfiguration(
                              "recorder_mode",
                              "android_rtsp",
                              "camera_name",
                              name.getText().toString().trim(),
                              "rtsp_host",
                              host.getText().toString().trim(),
                              "rtsp_username",
                              user.getText().toString().trim(),
                              "rtsp_password",
                              password.getText().toString()));
                      dialog.dismiss();
                    }));
    dialog.show();
  }

  @Override
  public void onRequestPermissionsResult(
      int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode != 2 || !configureDeviceCameraAfterPermission) return;
    configureDeviceCameraAfterPermission = false;
    if (DeviceCameraRecorder.hasPermissions(this)) configureDeviceCamera();
    else
      new AlertDialog.Builder(this)
          .setTitle("Camera access required")
          .setMessage(
              "Allow camera and microphone access to configure and test the USB or built-in camera.")
          .setPositiveButton("Close", null)
          .show();
  }

  private void enrollment(boolean replace) {
    if (engine.busy) {
      Toast.makeText(this, "Finish the current operation first.", Toast.LENGTH_SHORT).show();
      return;
    }
    LinearLayout p = panel();
    TextView help = new TextView(this);
    help.setText(
        replace
            ? "Enter a new enrollment code created for an Android camera device in Admin / Devices & cameras."
            : "Enter the enrollment code from Admin / Devices & cameras before using the recorder.");
    p.addView(help);
    EditText code = field(p, "Enrollment code", "", false);
    new AlertDialog.Builder(this)
        .setTitle(replace ? "Complete device setup" : "Register this tablet")
        .setView(p)
        .setPositiveButton(
            replace ? "Enroll again" : "Enroll",
            (d, w) -> engine.enroll(code.getText().toString(), replace))
        .setNegativeButton("Cancel", null)
        .show();
  }

  @Override
  public void onResume() {
    super.onResume();
    if (engine != null) engine.visible = true;
  }

  @Override
  public void onPause() {
    if (engine != null) engine.visible = false;
    super.onPause();
  }

  private void leavePlayer() {
    if (engine != null && engine.busy)
      new AlertDialog.Builder(this)
          .setMessage("Recording or upload will continue in the background.")
          .setPositiveButton("Leave app", (d, w) -> moveTaskToBack(true))
          .setNegativeButton("Stay", null)
          .show();
    else finish();
  }

  @Override
  public void onDestroy() {
    if (web != null) {
      web.removeJavascriptInterface("CasaNative");
      web.destroy();
    }
    super.onDestroy();
  }
}

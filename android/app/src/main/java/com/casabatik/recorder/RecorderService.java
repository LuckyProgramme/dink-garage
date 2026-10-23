package com.casabatik.recorder;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.*;
import android.util.Log;

public final class RecorderService extends Service {
  private static final String TAG = "DinkVisionRecorder";
  private static volatile RecorderService running;
  static final String EXTRA_CAMERA_ACTIVE = "camera-active";
  static final String EXTRA_UPLOAD_ACTIVE = "upload-active";
  private PowerManager.WakeLock wake;
  private WifiManager.WifiLock wifi;
  private Notification notification;
  private boolean cameraWork;
  private boolean uploadWork;

  static int foregroundTypes(
      int sdk, boolean deviceCamera, boolean cameraActive, boolean uploadActive) {
    int types = 0;
    if (cameraActive && deviceCamera) {
      types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
      if (sdk >= 30) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
    }
    if (uploadActive) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
    if (types == 0) types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
    return types;
  }

  private Notification buildNotification(
      boolean cameraActive, boolean uploadActive, int uploadPercent) {
    PendingIntent open =
        PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    String detail =
        cameraActive && uploadActive
            ? "Recording your match · background upload "
                + Math.max(0, uploadPercent)
                + "%"
            : cameraActive
                ? "Recording your match"
                : uploadActive
                    ? (uploadPercent > 0
                        ? "Uploading saved video · " + uploadPercent + "%"
                        : "Preparing background upload")
                    : "Preparing your match";
    Notification.Builder builder =
        new Notification.Builder(this, "recording")
            .setSmallIcon(com.casabatik.recorder.R.drawable.ic_camera)
            .setContentTitle("Dink Vision Recorder")
            .setContentText(detail)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setOngoing(true);
    if (uploadActive)
      builder.setProgress(100, Math.max(0, Math.min(100, uploadPercent)), uploadPercent <= 0);
    if (cameraActive) {
      PendingIntent stop =
          PendingIntent.getService(
              this,
              1,
              new Intent(this, RecorderService.class).setAction("stop"),
              PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
      builder.addAction(new Notification.Action.Builder(null, "Stop recording", stop).build());
    }
    return builder.build();
  }

  static void updateUploadProgress(int percent) {
    RecorderService service = running;
    if (service == null) return;
    Engine engine = Engine.get(service);
    service.cameraWork = service.cameraWork && engine.busy;
    service.uploadWork = true;
    service.notification =
        service.buildNotification(service.cameraWork, true, Math.max(0, Math.min(100, percent)));
    service.getSystemService(NotificationManager.class).notify(1, service.notification);
  }

  @Override
  public void onCreate() {
    super.onCreate();
    running = this;
    NotificationManager manager = getSystemService(NotificationManager.class);
    manager.createNotificationChannel(
        new NotificationChannel(
            "recording", "Match recording", NotificationManager.IMPORTANCE_LOW));
    notification = buildNotification(false, false, -1);
    // Android starts the foreground-service timeout before onStartCommand. Promote the service
    // immediately with the permission-safe connected-device type, then narrow/update the type
    // from the actual work flags in onStartCommand.
    if (Build.VERSION.SDK_INT >= 29)
      startForeground(
          1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
    else startForeground(1, notification);
    wake =
        getSystemService(PowerManager.class)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "WPC:Recording");
    wake.acquire(3 * 60 * 60 * 1000L);
    wifi =
        getSystemService(WifiManager.class)
            .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "WPC:Upload");
    wifi.setReferenceCounted(false);
    wifi.acquire();
  }

  @Override
  public int onStartCommand(Intent i, int f, int id) {
    if (i != null && "stop".equals(i.getAction())) Engine.get(this).stop = true;
    boolean requestedCamera = i != null && i.getBooleanExtra(EXTRA_CAMERA_ACTIVE, false);
    boolean requestedUpload = i != null && i.getBooleanExtra(EXTRA_UPLOAD_ACTIVE, false);
    Engine engine = Engine.get(this);
    cameraWork = requestedCamera || (cameraWork && engine.busy);
    uploadWork = requestedUpload || (uploadWork && engine.uploadWorkerRunning.get());
    notification = buildNotification(cameraWork, uploadWork, engine.uploadPercent);
    try {
      if (Build.VERSION.SDK_INT >= 29)
        startForeground(
            1,
            notification,
            foregroundTypes(
                Build.VERSION.SDK_INT,
                engine.usesDeviceCamera(),
                cameraWork,
                uploadWork));
      else startForeground(1, notification);
    } catch (RuntimeException failure) {
      Log.e(TAG, "Unable to update foreground service type", failure);
      engine.stop = true;
      engine.error =
          cameraWork
              ? "Open Device setup and allow camera and microphone access first."
              : "Android could not start the background upload service. Reopen the app and retry.";
      stopSelf(id);
      return START_NOT_STICKY;
    }
    if (!engine.busy && !engine.uploadWorkerRunning.get() && !engine.hasPendingUploadWork())
      stopSelf(id);
    return START_NOT_STICKY;
  }

  static void stopWhenIdle() {
    RecorderService service = running;
    if (service != null) service.stopSelf();
  }

  @Override
  public IBinder onBind(Intent i) {
    return null;
  }

  @Override
  public void onDestroy() {
    if (running == this) running = null;
    if (wifi != null && wifi.isHeld()) wifi.release();
    if (wake != null && wake.isHeld()) wake.release();
    super.onDestroy();
  }
}

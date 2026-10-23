package com.casabatik.recorder;

/** Source media time must never be stretched to disguise a slow receiver/encoder. */
final class RecordingAccuracy {
  static final long MAX_GAP_US = 3_000_000;

  static final class Failure extends Exception {
    Failure(String message) { super(message); }
  }

  static long tolerance(long expectedUs) {
    return Math.max(1_500_000, Math.min(3_000_000, expectedUs / 50));
  }

  static void duration(long actualUs, long expectedUs, String track) throws Failure {
    if (actualUs <= 0 || (expectedUs > 0
        && Math.abs(actualUs - expectedUs) > tolerance(expectedUs)))
      { android.util.Log.w("WPCRecording", track + " actualUs=" + actualUs + " expectedUs=" + expectedUs);
        throw new Failure(track + " timing does not match the recording. Footage remains on this device."); }
  }

  static final class Timeline {
    private long first = Long.MIN_VALUE, previous = Long.MIN_VALUE, startNanos;
    long count;
    long observe(long sourceUs, long nowNanos) throws Failure {
      if (first == Long.MIN_VALUE) { first = sourceUs; startNanos = nowNanos; }
      if (previous != Long.MIN_VALUE
          && (sourceUs < previous || sourceUs - previous > MAX_GAP_US))
        throw new Failure("Camera timing reset or a video gap exceeded 3 seconds. Check the camera connection and retry.");
      long elapsed = sourceUs - first;
      long wall = (nowNanos - startNanos) / 1_000;
      if (Math.abs(wall - elapsed) > MAX_GAP_US)
        throw new Failure("Recording cannot keep up with the camera, or its clock changed. Try a lower camera quality and check the connection.");
      previous = sourceUs;
      count++;
      return elapsed;
    }
  }
}

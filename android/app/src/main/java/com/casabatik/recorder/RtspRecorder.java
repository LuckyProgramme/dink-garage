package com.casabatik.recorder;

import static org.bytedeco.ffmpeg.global.avcodec.*;
import static org.bytedeco.ffmpeg.global.avutil.*;

import java.io.File;
import java.net.URI;
import java.util.function.BooleanSupplier;
import org.bytedeco.ffmpeg.avformat.AVFormatContext;
import org.bytedeco.ffmpeg.avformat.AVStream;
import org.bytedeco.ffmpeg.avcodec.AVPacket;
import org.bytedeco.javacv.*;

/** Native TCP RTSP capture. Hybrid MP4 stays recoverable while recording and seekable when done. */
final class RtspRecorder {
  interface Listener {
    void ready() throws Exception;

    void countdown(int value);

    void started() throws Exception;

    void frame(int seconds);

    default void camera(String label) {}

    default void finalizing() {}
  }

  static String cameraUri(String address, String user, String password) throws Exception {
    URI u = new URI(address.trim());
    if (!"rtsp".equalsIgnoreCase(u.getScheme())
        || u.getHost() == null
        || u.getUserInfo() != null
        || u.getFragment() != null)
      throw new Exception(
          "Enter rtsp://camera-ip:554/stream1 without a username or password in the address.");
    String auth =
        user.isEmpty()
            ? ""
            : java.net.URLEncoder.encode(user, "UTF-8").replace("+", "%20")
                + ":"
                + java.net.URLEncoder.encode(password, "UTF-8").replace("+", "%20")
                + "@";
    return "rtsp://"
        + auth
        + u.getRawAuthority()
        + (u.getRawPath() == null ? "" : u.getRawPath())
        + (u.getRawQuery() == null ? "" : "?" + u.getRawQuery());
  }

  static long capture(
      String input,
      File file,
      int seconds,
      boolean audio,
      int countInSeconds,
      BooleanSupplier stop,
      Listener listener)
      throws Exception {
    av_log_set_level(AV_LOG_QUIET); // FFmpeg diagnostics can contain camera credentials.
    try (FFmpegFrameGrabber grabber = new FFmpegFrameGrabber(input)) {
      grabber.setOption("rtsp_transport", "tcp");
      grabber.setOption("rw_timeout", "10000000");
      grabber.setOption("timeout", "10000000");
      grabber.setImageWidth(1280);
      grabber.setImageHeight(720);
      grabber.start();
      if (grabber.getImageWidth() < 1) throw new Exception("No camera video stream.");
      int channels = audio ? Math.min(2, grabber.getAudioChannels()) : 0;
      if (audio && channels < 1)
        throw new Exception("The camera stream did not provide microphone audio.");
      if (PacketRecorder.compatible(grabber, channels > 0))
        return PacketRecorder.capture(grabber, file, seconds, channels > 0,
            countInSeconds, stop, listener);
      long connected = System.nanoTime();
      Frame firstVideo = null;
      while (firstVideo == null || firstVideo.image == null) {
        if ((System.nanoTime() - connected) > 30_000_000_000L)
          throw new Exception("No video frames received.");
        firstVideo = grabber.grabFrame(channels > 0, true, true, false);
        if (firstVideo == null) throw new Exception("Camera stream ended.");
      }
      listener.ready();
      for (int value = Math.max(2, countInSeconds); value > 0; value--) {
        listener.countdown(Math.min(value, countInSeconds));
        long deadline = System.nanoTime() + 1_000_000_000L;
        while (System.nanoTime() < deadline) {
          Frame discarded = grabber.grabFrame(channels > 0, true, true, false);
          if (discarded == null) throw new Exception("Camera stream ended.");
        }
      }
      listener.countdown(0);
      if (stop.getAsBoolean()) throw new Exception("Recording start was cancelled.");
      try (FFmpegFrameRecorder recorder =
          new FFmpegFrameRecorder(
              file, grabber.getImageWidth(), grabber.getImageHeight(), channels)) {
        recorder.setFormat("mp4");
        recorder.setVideoCodecName("libopenh264");
        recorder.setVideoBitrate(3000000);
        double fps = grabber.getFrameRate();
        if (!Double.isFinite(fps) || fps <= 0 || fps > 120)
          throw new RecordingAccuracy.Failure("Camera frame rate is invalid. Check its stream settings.");
        recorder.setFrameRate(fps);
        recorder.setGopSize(30);
        recorder.setPixelFormat(AV_PIX_FMT_YUV420P);
        // Hybrid fragmentation preserves recoverable fragments during capture, then stop()
        // converts a clean recording into a regular MP4 with seekable metadata.
        recorder.setOption("movflags", "frag_keyframe+hybrid_fragmented");
        if (channels > 0) {
          recorder.setAudioCodec(AV_CODEC_ID_AAC);
          recorder.setSampleRate(48000);
          recorder.setAudioBitrate(128000);
        }
        recorder.start();
        long start = 0;
        long capturedMillis = 0;
        boolean began = false, heard = false;
        long sourceStart = 0;
        long audioSamples = 0;
        RecordingAccuracy.Timeline timeline = new RecordingAccuracy.Timeline();
        while (!stop.getAsBoolean()
            && (!began || (System.nanoTime() - start) / 1_000_000_000L < seconds)) {
          Frame frame = grabber.grabFrame(channels > 0, true, true, false);
          if (frame == null) throw new Exception("Camera stream ended.");
          if (frame.image == null && frame.samples == null) continue;
          if (!began && frame.image == null) continue;
          long now = System.nanoTime();
          boolean firstImage = frame.image != null && !began;
          if (firstImage) sourceStart = frame.timestamp;
          if (frame.image != null) {
            long mediaUs = timeline.observe(frame.timestamp, now);
            recorder.setTimestamp(mediaUs);
          }
          if (frame.samples != null) {
            // This encoder uses audio sample counts. Reject gaps rather than
            // compressing missing audio or stretching video to compensate.
            long sampleUs = audioSamples * 1_000_000L / grabber.getSampleRate();
            if (Math.abs(frame.timestamp - sourceStart - sampleUs) > 1_500_000)
              throw new RecordingAccuracy.Failure("Camera audio timing drifted. Available footage remains on this device.");
            audioSamples += frame.samples[0].remaining() / (frame.samples.length == 1 ? grabber.getAudioChannels() : 1);
          }
          recorder.record(frame);
          if (frame.samples != null) heard = true;
          if (firstImage) {
            began = true;
            start = now;
            listener.started();
          }
          listener.frame((int) ((System.nanoTime() - start) / 1_000_000_000L));
          if (file.getParentFile().getUsableSpace() < 50_000_000)
            throw new Exception("Tablet storage is nearly full.");
        }
        if (began)
          capturedMillis =
              Math.max(1, (System.nanoTime() - start) / 1_000_000L);
        listener.finalizing();
        // stop() flushes delayed encoder frames and writes the MP4 trailer before returning.
        recorder.stop();
        android.util.Log.i("WPCRecording", "mode=source-timed-encode frames=" + timeline.count + " elapsedMs=" + capturedMillis);
        if (!began) throw new Exception("No video frames received.");
        if (channels > 0 && !heard) throw new Exception("No microphone samples received.");
        return capturedMillis;
      }
    }
  }

  static void validate(File file) throws Exception {
    validate(file, -1, false);
  }

  static void validate(File file, long expectedMillis) throws Exception {
    validate(file, expectedMillis, false);
  }

  private static long streamDurationMicros(FFmpegFrameGrabber grabber, int mediaType) {
    AVFormatContext context = grabber.getFormatContext();
    long longest = 0;
    if (context == null) return longest;
    for (int index = 0; index < context.nb_streams(); index++) {
      AVStream stream = context.streams(index);
      if (stream == null
          || stream.codecpar() == null
          || stream.codecpar().codec_type() != mediaType
          || stream.duration() <= 0
          || stream.duration() == AV_NOPTS_VALUE)
        continue;
      double seconds =
          stream.duration()
              * (double) stream.time_base().num()
              / (double) stream.time_base().den();
      if (Double.isFinite(seconds) && seconds > 0)
        longest = Math.max(longest, Math.round(seconds * 1_000_000d));
    }
    return longest;
  }

  static long validate(File file, long expectedMillis, boolean expectAudio) throws Exception {
    if (!file.isFile() || file.length() < 1024)
      throw new Exception("No recoverable video was saved.");
    long validatedDurationMicros;
    try (FFmpegFrameGrabber g = new FFmpegFrameGrabber(file)) {
      g.start();
      long durationMicros = g.getLengthInTime();
      long videoMicros = streamDurationMicros(g, AVMEDIA_TYPE_VIDEO);
      long audioMicros = streamDurationMicros(g, AVMEDIA_TYPE_AUDIO);
      validatedDurationMicros = videoMicros > 0 ? videoMicros : durationMicros;
      Frame f;
      int count = 0;
      while ((f = g.grabImage()) != null && count < 2) count++;
      if (count == 0) throw new Exception("Saved video cannot be read.");
      if (expectAudio && (g.getAudioChannels() < 1 || audioMicros <= 0))
        throw new Exception(
            "Saved video has no complete audio track. It was kept locally and was not uploaded.");
      if (expectedMillis > 0) {
        long expectedMicros = expectedMillis * 1_000L;
        long savedVideoMicros = videoMicros > 0 ? videoMicros : durationMicros;
        RecordingAccuracy.duration(savedVideoMicros, expectedMicros, "Video");
        if (expectAudio) RecordingAccuracy.duration(audioMicros, expectedMicros, "Audio");
      }
      if (expectAudio) RecordingAccuracy.duration(audioMicros,
          videoMicros > 0 ? videoMicros : durationMicros, "Audio/video");
    }
    validatePackets(file, expectedMillis, expectAudio);
    return Math.round(validatedDurationMicros / 1_000d);
  }

  private static void validatePackets(File file, long expectedMillis, boolean expectAudio) throws Exception {
    try (FFmpegFrameGrabber g = new FFmpegFrameGrabber(file)) {
      g.start();
      var context = g.getFormatContext();
      long[] first = new long[context.nb_streams()], last = new long[first.length], end = new long[first.length];
      java.util.Arrays.fill(first, Long.MAX_VALUE);
      java.util.Arrays.fill(last, Long.MIN_VALUE);
      AVPacket packet;
      while ((packet = g.grabPacket()) != null) {
        try {
          int i = packet.stream_index();
          var stream = context.streams(i);
          int kind = stream.codecpar().codec_type();
          if (kind != AVMEDIA_TYPE_VIDEO && kind != AVMEDIA_TYPE_AUDIO) continue;
          if (packet.pts() == AV_NOPTS_VALUE || packet.dts() == AV_NOPTS_VALUE)
            throw new RecordingAccuracy.Failure("Saved recording has missing timestamps.");
          long dts = av_rescale_q(packet.dts(), stream.time_base(), av_get_time_base_q());
          long pts = av_rescale_q(packet.pts(), stream.time_base(), av_get_time_base_q());
          long duration = av_rescale_q(packet.duration(), stream.time_base(), av_get_time_base_q());
          if (duration > RecordingAccuracy.MAX_GAP_US || (last[i] != Long.MIN_VALUE
              && (dts <= last[i] || dts - last[i] > RecordingAccuracy.MAX_GAP_US)))
            throw new RecordingAccuracy.Failure("Saved recording contains a clock reset or a gap exceeding 3 seconds.");
          first[i] = Math.min(first[i], pts);
          last[i] = dts;
          end[i] = Math.max(end[i], pts + duration);
        } finally { av_packet_unref(packet); }
      }
      long videoStart = Long.MAX_VALUE, audioStart = Long.MAX_VALUE, videoDuration = 0, audioDuration = 0;
      for (int i = 0; i < first.length; i++) {
        if (first[i] == Long.MAX_VALUE) continue;
        int kind = context.streams(i).codecpar().codec_type();
        if (kind == AVMEDIA_TYPE_VIDEO) { videoStart = first[i]; videoDuration = end[i] - first[i]; }
        if (kind == AVMEDIA_TYPE_AUDIO) { audioStart = first[i]; audioDuration = end[i] - first[i]; }
      }
      RecordingAccuracy.duration(videoDuration, expectedMillis > 0 ? expectedMillis * 1000 : -1, "Video packets");
      if (expectAudio || audioStart != Long.MAX_VALUE) {
        RecordingAccuracy.duration(audioDuration, videoDuration, "Audio/video packets");
        if (audioStart == Long.MAX_VALUE || Math.abs(audioStart - videoStart) > 1_500_000)
          throw new RecordingAccuracy.Failure("Saved audio and video do not start together.");
      }
      android.util.Log.i("WPCRecording", "validated videoUs=" + videoDuration + " audioUs=" + audioDuration);
    }
  }
}

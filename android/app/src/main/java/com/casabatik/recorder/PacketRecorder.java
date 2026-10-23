package com.casabatik.recorder;

import static org.bytedeco.ffmpeg.global.avcodec.*;
import static org.bytedeco.ffmpeg.global.avutil.*;
import java.io.File;
import java.util.function.BooleanSupplier;
import org.bytedeco.ffmpeg.avcodec.AVPacket;
import org.bytedeco.ffmpeg.avformat.AVStream;
import org.bytedeco.javacv.*;

/** MP4-compatible streams retain their compressed frames and source PTS/DTS. */
final class PacketRecorder {
  static boolean compatible(FFmpegFrameGrabber grabber, boolean audio) {
    int videos = 0, audios = 0;
    var context = grabber.getFormatContext();
    for (int i = 0; i < context.nb_streams(); i++) {
      var parameters = context.streams(i).codecpar();
      if (parameters.codec_type() == AVMEDIA_TYPE_VIDEO) videos++;
      if (parameters.codec_type() == AVMEDIA_TYPE_AUDIO) audios++;
    }
    return videos == 1 && audios <= 1 && grabber.getVideoCodec() == AV_CODEC_ID_H264
        && (!audio || grabber.getAudioCodec() == AV_CODEC_ID_AAC
            || grabber.getAudioCodec() == AV_CODEC_ID_PCM_ALAW
            || grabber.getAudioCodec() == AV_CODEC_ID_PCM_MULAW);
  }

  static long capture(FFmpegFrameGrabber grabber, File file, int seconds, boolean audio,
      int countIn, BooleanSupplier stop, RtspRecorder.Listener listener) throws Exception {
    var context = grabber.getFormatContext();
    long connected = System.nanoTime(), readyAt = 0, start = 0, originUs = 0, elapsed = 0, lastVideoAt = 0;
    int announced = -1;
    boolean began = false, heard = false;
    RecordingAccuracy.Timeline videoClock = new RecordingAccuracy.Timeline();
    long[] lastDts = new long[context.nb_streams()];
    java.util.Arrays.fill(lastDts, Long.MIN_VALUE);
    AVStream convertedAudio = null;
    if (audio && grabber.getAudioCodec() != AV_CODEC_ID_AAC)
      for (int i = 0; i < context.nb_streams(); i++)
        if (context.streams(i).codecpar().codec_type() == AVMEDIA_TYPE_AUDIO) convertedAudio = context.streams(i);
    try (FFmpegFrameRecorder recorder = new FFmpegFrameRecorder(file,
        grabber.getImageWidth(), grabber.getImageHeight(), audio ? grabber.getAudioChannels() : 0);
        PacketAudio audioDecoder = convertedAudio == null ? null : new PacketAudio(convertedAudio)) {
      recorder.setFormat("mp4");
      recorder.setVideoCodecName("libopenh264");
      recorder.setOption("movflags", "frag_keyframe+hybrid_fragmented");
      recorder.setAudioCodec(AV_CODEC_ID_AAC);
      recorder.setSampleRate(48000);
      recorder.setAudioBitrate(128000);
      // JavaCV selects input streams during start(context). Hide only the
      // G.711 stream while it configures video-copy plus a new AAC encoder.
      // Restore immediately; the input context is used on this thread only.
      if (convertedAudio != null) convertedAudio.codecpar().codec_type(AVMEDIA_TYPE_DATA);
      try { recorder.start(context); }
      finally { if (convertedAudio != null) convertedAudio.codecpar().codec_type(AVMEDIA_TYPE_AUDIO); }
      try {
        while (!stop.getAsBoolean() && (!began || System.nanoTime() - start < seconds * 1_000_000_000L)) {
          if (!began && System.nanoTime() - connected > (30L + countIn) * 1_000_000_000L)
            throw new RecordingAccuracy.Failure("No camera keyframe received. Check the camera and retry.");
          AVPacket packet = grabber.grabPacket();
          if (packet == null) throw new RecordingAccuracy.Failure("Camera stream interrupted. Available footage remains on this device.");
          try {
            int index = packet.stream_index();
            AVStream stream = context.streams(index);
            int type = stream.codecpar().codec_type();
            if (type != AVMEDIA_TYPE_VIDEO && (type != AVMEDIA_TYPE_AUDIO || !audio)) continue;
            long now = System.nanoTime();
            if (began && now - lastVideoAt > 3_000_000_000L)
              throw new RecordingAccuracy.Failure("Camera video stalled. Check the connection and retry.");
            if (readyAt == 0) {
              if (type != AVMEDIA_TYPE_VIDEO) continue;
              readyAt = now;
              listener.ready();
            }
            int remaining = Math.max(0, countIn - (int)((now - readyAt) / 1_000_000_000L));
            if (remaining != announced) { listener.countdown(remaining); announced = remaining; }
            // find_stream_info can buffer startup packets. Drain them before
            // choosing the first keyframe, even for a zero-countdown camera test.
            if (remaining > 0 || now - readyAt < 2_000_000_000L) continue;
            if (!began && (type != AVMEDIA_TYPE_VIDEO || (packet.flags() & AV_PKT_FLAG_KEY) == 0)) continue;
            // RTP carries presentation time; DTS can be absent for streams
            // without frame reordering. Never invent decode time for B-frames.
            if (packet.dts() == AV_NOPTS_VALUE && stream.codecpar().video_delay() == 0)
              packet.dts(packet.pts());
            if (packet.pts() == AV_NOPTS_VALUE || packet.dts() == AV_NOPTS_VALUE)
              { if (!began) continue;
                throw new RecordingAccuracy.Failure("Camera timestamps are missing. Recording stopped to prevent incorrect playback speed."); }
            long dtsUs = av_rescale_q(packet.dts(), stream.time_base(), av_get_time_base_q());
            if (!began) {
              if (type != AVMEDIA_TYPE_VIDEO || (packet.flags() & AV_PKT_FLAG_KEY) == 0) continue;
              originUs = dtsUs;
              start = now;
              began = true;
              listener.started();
            }
            long offset = av_rescale_q(originUs, av_get_time_base_q(), stream.time_base());
            if (packet.dts() < offset || packet.pts() < offset) continue;
            if (lastDts[index] != Long.MIN_VALUE && dtsUs <= lastDts[index])
              throw new RecordingAccuracy.Failure("Camera timestamps moved backwards. Check the camera and retry.");
            lastDts[index] = dtsUs;
            if (type == AVMEDIA_TYPE_VIDEO) { videoClock.observe(dtsUs, now); lastVideoAt = now; }
            else heard = true;
            if (type == AVMEDIA_TYPE_AUDIO && audioDecoder != null) {
              audioDecoder.record(packet, dtsUs - originUs, recorder);
            } else {
              packet.pts(packet.pts() - offset);
              packet.dts(packet.dts() - offset);
              recorder.recordPacket(packet);
            }
            listener.frame((int)((now - start) / 1_000_000_000L));
            if (file.getParentFile().getUsableSpace() < 50_000_000)
              throw new RecordingAccuracy.Failure("Tablet storage is nearly full. Available footage remains on this device.");
          } finally { av_packet_unref(packet); }
        }
      } finally {
        if (began) elapsed = Math.max(1, (System.nanoTime() - start) / 1_000_000L);
        listener.finalizing();
        // JavaCV's remux stop does not flush a manually encoded audio stream.
        if (audioDecoder != null) while (recorder.recordSamples((java.nio.Buffer[])null)) {}
        recorder.stop();
      }
    }
    if (!began || (audio && !heard))
      throw new RecordingAccuracy.Failure("Camera did not supply the required video/audio tracks.");
    android.util.Log.i("WPCRecording", "mode=packet-copy videoPackets=" + videoClock.count + " elapsedMs=" + elapsed);
    return elapsed;
  }
}

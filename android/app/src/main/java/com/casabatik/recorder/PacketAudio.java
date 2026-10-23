package com.casabatik.recorder;

import static org.bytedeco.ffmpeg.global.avcodec.*;
import static org.bytedeco.ffmpeg.global.avutil.*;
import org.bytedeco.ffmpeg.avcodec.*;
import org.bytedeco.ffmpeg.avformat.AVStream;
import org.bytedeco.ffmpeg.avutil.*;
import org.bytedeco.javacv.FFmpegFrameRecorder;

/** Convert G.711 microphone audio to AAC while leaving H.264 video untouched. */
final class PacketAudio implements AutoCloseable {
  private AVCodecContext decoder;
  private AVFrame frame;
  private long samples;
  private final int rate;
  PacketAudio(AVStream stream) throws Exception {
    rate = stream.codecpar().sample_rate();
    decoder = avcodec_alloc_context3(avcodec_find_decoder(stream.codecpar().codec_id()));
    frame = av_frame_alloc();
    if (rate <= 0 || decoder == null || frame == null
        || avcodec_parameters_to_context(decoder, stream.codecpar()) < 0
        || avcodec_open2(decoder, avcodec_find_decoder(stream.codecpar().codec_id()), (AVDictionary)null) < 0) {
      close();
      throw new RecordingAccuracy.Failure("Camera microphone decoder could not start.");
    }
  }
  void record(AVPacket packet, long mediaUs, FFmpegFrameRecorder recorder) throws Exception {
    if (Math.abs(mediaUs - samples * 1_000_000L / rate) > 1_500_000)
      throw new RecordingAccuracy.Failure("Camera microphone timing drifted. Check the connection and retry.");
    if (avcodec_send_packet(decoder, packet) < 0)
      throw new RecordingAccuracy.Failure("Camera microphone packet could not be decoded.");
    int result;
    while ((result = avcodec_receive_frame(decoder, frame)) >= 0) {
      try {
        int channels = frame.ch_layout().nb_channels();
        if (frame.format() != AV_SAMPLE_FMT_S16 || channels < 1)
          throw new RecordingAccuracy.Failure("Unsupported camera microphone sample format.");
        var buffer = frame.data(0).position(0).capacity((long)frame.nb_samples() * channels * 2)
            .asByteBuffer().order(java.nio.ByteOrder.nativeOrder()).asShortBuffer();
        recorder.recordSamples(rate, channels, buffer);
        samples += frame.nb_samples();
      } finally { av_frame_unref(frame); }
    }
    if (result != AVERROR_EAGAIN() && result != AVERROR_EOF())
      throw new RecordingAccuracy.Failure("Camera microphone decoding failed.");
  }
  @Override public void close() {
    if (frame != null) { av_frame_free(frame); frame = null; }
    if (decoder != null) { avcodec_free_context(decoder); decoder = null; }
  }
}

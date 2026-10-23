package com.casabatik.recorder;

import static org.bytedeco.ffmpeg.global.avcodec.AV_CODEC_ID_AAC;
import static org.bytedeco.ffmpeg.global.avutil.AV_PIX_FMT_YUV420P;
import java.io.File;
import java.nio.*;
import java.util.function.BooleanSupplier;
import org.bytedeco.javacv.*;

/** Offline clip export. Presentation times come from the source, not CPU speed. */
final class VideoClip {
  static Buffer slice(Buffer source, int start, int end) {
    Buffer copy;
    if(source instanceof ShortBuffer) copy=((ShortBuffer)source).duplicate();
    else if(source instanceof FloatBuffer) copy=((FloatBuffer)source).duplicate();
    else if(source instanceof ByteBuffer) copy=((ByteBuffer)source).duplicate();
    else if(source instanceof DoubleBuffer) copy=((DoubleBuffer)source).duplicate();
    else if(source instanceof IntBuffer) copy=((IntBuffer)source).duplicate();
    else throw new IllegalArgumentException("Unsupported source audio samples");
    int origin=copy.position();copy.limit(origin+end);copy.position(origin+start);return copy;
  }
  static long lastMinute(File source, File output, boolean audio, BooleanSupplier cancelled) throws Exception {
    long sourceMs=RtspRecorder.validate(source,-1,audio);
    if(sourceMs<=60000) throw new Exception("This recording is already under one minute. Keep its original local video.");
    if(!output.createNewFile()) throw new Exception("Clip output already exists; it was preserved.");
    long startUs=(sourceMs-60000)*1000, endUs=sourceMs*1000, deadline=System.nanoTime()+180_000_000_000L;
    try(FFmpegFrameGrabber grabber=new FFmpegFrameGrabber(source)) {
      grabber.start();
      int channels=audio?grabber.getAudioChannels():0;
      double fps=grabber.getFrameRate();
      if(!Double.isFinite(fps)||fps<=0||fps>120)throw new Exception("Invalid source frame rate.");
      try(FFmpegFrameRecorder recorder=new FFmpegFrameRecorder(output,grabber.getImageWidth(),grabber.getImageHeight(),channels)) {
        recorder.setFormat("mp4");recorder.setVideoCodecName("libopenh264");recorder.setVideoBitrate(4_000_000);
        recorder.setFrameRate(fps);recorder.setGopSize(Math.max(1,(int)fps));recorder.setPixelFormat(AV_PIX_FMT_YUV420P);
        recorder.setOption("movflags","frag_keyframe+hybrid_fragmented");
        if(channels>0){recorder.setAudioCodec(AV_CODEC_ID_AAC);recorder.setSampleRate(grabber.getSampleRate());recorder.setAudioBitrate(128000);}
        recorder.start();grabber.setTimestamp(Math.max(0,startUs-1_000_000));
        long lastVideo=-1;
        Frame frame;
        while((frame=grabber.grabFrame(channels>0,true,true,false))!=null){
          if(cancelled.getAsBoolean())throw new Exception("Clip export cancelled. The original was preserved.");
          if(System.nanoTime()>deadline)throw new Exception("Clip export timed out. The original was preserved.");
          if(output.getParentFile().getUsableSpace()<50_000_000)throw new Exception("Not enough storage for the clip.");
          long pts=frame.timestamp;
          if(pts>=endUs)break;
          if(frame.image!=null && pts>=startUs){
            if(pts<=lastVideo)throw new Exception("Source video timestamps do not advance.");
            recorder.setTimestamp(pts-startUs);recorder.record(frame);lastVideo=pts;
          } else if(frame.samples!=null && channels>0){
            int stride=frame.samples.length==1?channels:1, count=frame.samples[0].remaining()/stride;
            int rate=grabber.getSampleRate();
            int from=(int)Math.max(0,Math.ceil((startUs-pts)*rate/1_000_000.0));
            int to=(int)Math.min(count,Math.floor((endUs-pts)*rate/1_000_000.0));
            if(to>from){Buffer[] samples=new Buffer[frame.samples.length];for(int i=0;i<samples.length;i++)samples[i]=slice(frame.samples[i],from*stride,to*stride);recorder.recordSamples(rate,channels,samples);}
          }
        }
        recorder.stop();
      }
    }
    return RtspRecorder.validate(output,60000,audio);
  }
}

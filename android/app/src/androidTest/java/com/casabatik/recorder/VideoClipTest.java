package com.casabatik.recorder;
import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class VideoClipTest {
  @Test public void lastMinuteKeepsSourceAndValidatesAudioVideoClock() throws Exception {
    var instrumentation=InstrumentationRegistry.getInstrumentation();
    File source=new File(instrumentation.getTargetContext().getCacheDir(),"clip-source.mp4");
    File output=new File(instrumentation.getTargetContext().getCacheDir(),java.util.UUID.randomUUID()+".mp4");
    try {
      try(InputStream in=instrumentation.getContext().getAssets().open("recording-sixty-five-seconds.mp4");OutputStream out=new FileOutputStream(source)){in.transferTo(out);}
      long bytes=source.length();
      long duration=VideoClip.lastMinute(source,output,true,()->false);
      assertTrue(Math.abs(duration-60000)<1500);
      assertEquals(bytes,source.length());
      assertTrue(RtspRecorder.validate(source,65000,true)>0);
      try {VideoClip.lastMinute(source,output,true,()->false);fail("Existing clip must not be overwritten");}
      catch(Exception expected){assertTrue(expected.getMessage().contains("already exists"));}
      assertTrue(RtspRecorder.validate(output,60000,true)>0);
    } finally {source.delete();output.delete();}
  }
}

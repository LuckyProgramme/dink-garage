package com.casabatik.recorder;

import static org.junit.Assert.*;
import android.content.pm.ServiceInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class CompatibilityTest {
  @Test public void foregroundTypesKeepUploadAndCameraPermissionsSeparate() {
    assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,RecorderService.foregroundTypes(36,false,true,true));
    assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA,RecorderService.foregroundTypes(29,true,true,false));
    assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA|ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
        RecorderService.foregroundTypes(30,true,true,false));
    assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,RecorderService.foregroundTypes(36,true,false,false));
    assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA|ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE|ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        RecorderService.foregroundTypes(36,true,true,true));
  }
}

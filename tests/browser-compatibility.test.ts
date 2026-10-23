import test from "node:test";
import assert from "node:assert/strict";
import {testCamera} from "../lib/browser-media";

test("a missing camera-test stop event times out and releases every track", async()=>{
  const keys=["window","document","navigator","MediaRecorder","MediaStream","MediaStreamTrackProcessor","MediaStreamTrackGenerator","Worker","setTimeout"];
  const previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const originalTimeout=setTimeout;
  let stopped=0;
  const track={readyState:"live",enabled:true,stop(){stopped++;}};
  class Recorder {
    static isTypeSupported(){return true;}
    state="inactive";onstart?:()=>void;
    start(){this.state="recording";queueMicrotask(()=>this.onstart?.());}
    stop(){this.state="inactive";} // A buggy encoder never emits onstop.
  }
  class OutputTrack { readyState="live"; stop(){this.readyState="ended";} }
  class Processor { readable={cancel:async()=>{}}; }
  class Generator extends OutputTrack { writable={}; }
  class Stream {
    constructor(private tracks: Array<typeof track|OutputTrack>){}
    getTracks(){return this.tracks;}
    getVideoTracks(){return this.tracks.filter(item=>item instanceof OutputTrack);}
    getAudioTracks(){return [];}
  }
  class LogoWorker {
    onerror?:()=>void;onmessage?:(event:{data:{type:string}})=>void;
    postMessage(){queueMicrotask(()=>this.onmessage?.({data:{type:"frame"}}));}
    terminate(){}
  }
  try {
    const globals={window:{isSecureContext:true,addEventListener(){},removeEventListener(){}},document:{visibilityState:"visible",addEventListener(){},removeEventListener(){}},
      navigator:{mediaDevices:{getUserMedia:async()=>({getVideoTracks:()=>[track],getAudioTracks:()=>[],getTracks:()=>[track]})}},MediaRecorder:Recorder,
      MediaStream:Stream,MediaStreamTrackProcessor:Processor,MediaStreamTrackGenerator:Generator,Worker:LogoWorker,
      setTimeout:(fn:()=>void,ms:number)=>originalTimeout(fn,Math.max(1,ms/100))};
    for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,value});
    await assert.rejects(testCamera({source_type:"local",video_device:"usb",audio_device:"",camera_name:"USB"}),/finalization timed out/);
    assert.equal(stopped,1);
    Recorder.isTypeSupported=()=>false;
    await assert.rejects(testCamera({source_type:"local",video_device:"usb",audio_device:"",camera_name:"USB"}),/cannot create MP4/);
    assert.equal(stopped,1,"Unsupported encoding is rejected before opening any camera");
  }finally{for(const key of keys){const value=previous.get(key);if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}
});

import { inspectRecording } from "./recording-integrity";
import { recordingMime } from "./browser-media";

export function lastMinuteRange(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw Error("Source video has no valid duration.");
  return {startMs:Math.max(0,durationMs-60000), durationMs:Math.min(60000,durationMs)};
}

/** Decode at the source's normal speed. Never reinterpret its frame clock. */
export async function cutLastMinute(source: Blob, video: HTMLVideoElement, expectAudio: boolean,
  signal: AbortSignal, progress: (seconds:number)=>void) {
  const timing=await inspectRecording(source,undefined,expectAudio);
  const range=lastMinuteRange(timing.videoMs);
  if (range.startMs===0) return {blob:source,...range};
  const element=video as HTMLVideoElement & {captureStream?:()=>MediaStream};
  if (!element.captureStream) throw Error("This browser cannot export local clips. Use current Chrome or Edge.");
  const url=URL.createObjectURL(source), parts:Blob[]=[];
  let stream:MediaStream|undefined, recorder:MediaRecorder|undefined;
  let timer:ReturnType<typeof setInterval>|undefined;
  const requireVisible=()=>{
    if (signal.aborted) throw Error("Clip export cancelled. The original recording is unchanged.");
    if (document.visibilityState!=="visible") throw Error("Keep the clip page visible during export. The original recording is unchanged.");
  };
  const waitFor=(event:string,run:()=>void)=>new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>finish(Error("Video playback timed out.")),15000);
    const finish=(error?:Error)=>{
      clearTimeout(timeout);video.removeEventListener(event,done);video.removeEventListener("error",failed);signal.removeEventListener("abort",aborted);
      error?reject(error):resolve();
    };
    const done=()=>finish(),failed=()=>finish(Error("The source video could not be decoded.")),aborted=()=>finish(Error("Clip export cancelled."));
    video.addEventListener(event,done,{once:true});video.addEventListener("error",failed,{once:true});signal.addEventListener("abort",aborted,{once:true});
    try {requireVisible();run();} catch(e) {finish(e as Error);}
  });
  try {
    video.muted=true;video.playsInline=true;video.playbackRate=1;
    await waitFor("loadeddata",()=>{video.src=url;video.load();});
    await waitFor("seeked",()=>{video.currentTime=range.startMs/1000;});
    requireVisible();
    stream=element.captureStream();
    if (!stream.getVideoTracks().length || (expectAudio && !stream.getAudioTracks().length))
      throw Error("This browser could not capture the source video and audio tracks.");
    recorder=new MediaRecorder(stream,{mimeType:recordingMime(),videoBitsPerSecond:4_000_000,audioBitsPerSecond:128_000});
    const started=performance.now();
    await new Promise<void>((resolve,reject)=>{
      let failure:Error|undefined, stopping=false;
      let finalization:ReturnType<typeof setTimeout>|undefined;
      const aborted=()=>stop(Error("Clip export cancelled."));
      const finish=(error?:Error)=>{
        if(finalization) clearTimeout(finalization);
        signal.removeEventListener("abort",aborted);
        error?reject(error):resolve();
      };
      const stop=(error?:Error)=>{
        if(error) failure=error;
        if(stopping) return;stopping=true;
        finalization=setTimeout(()=>finish(Error("Clip finalization timed out.")),5000);
        if(recorder?.state!=="inactive") {try {recorder!.stop();} catch(e) {finish(e as Error);}}
        else finish(failure);
      };
      recorder!.ondataavailable=event=>{if(event.data.size) parts.push(event.data);};
      recorder!.onerror=()=>stop(Error("Clip encoder failed. The original recording is unchanged."));
      recorder!.onstop=()=>finish(failure);
      recorder!.start(1000);
      void video.play().catch(e=>stop(e));
      timer=setInterval(()=>{
        try {
          requireVisible();
          progress(Math.min(60,Math.max(0,video.currentTime-range.startMs/1000)));
          if (video.ended) stop();
          else if(performance.now()-started>85000) stop(Error("Clip export timed out. The original recording is unchanged."));
        } catch(e) {stop(e as Error);}
      },100);
      // A recorder that never dispatches onstop must not retain the export lock.
      signal.addEventListener("abort",aborted,{once:true});
    });
    const blob=new Blob(parts,{type:recorder.mimeType});
    const output=await inspectRecording(blob,range.durationMs,expectAudio);
    return {blob,startMs:range.startMs,durationMs:Math.floor(output.videoMs)};
  } finally {
    if(timer) clearInterval(timer);
    if(recorder?.state!=="inactive") {try {recorder?.stop();} catch { /* Already closed. */ }}
    stream?.getTracks().forEach(track=>track.stop());
    video.pause();video.removeAttribute("src");video.load();URL.revokeObjectURL(url);
  }
}

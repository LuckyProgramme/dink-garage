"use client";
import {useEffect,useRef,useState} from "react";
import {BrowserCapture} from "@/lib/browser-recorder";
import {getMeta,listMeta,saveMeta,saveChunk,savedVideo,type LocalRecording} from "@/lib/browser-storage";
import {cutLastMinute} from "@/lib/video-clip";

export default function LocalClips() {
  const [device,setDevice]=useState(""),[items,setItems]=useState<LocalRecording[]>([]),[message,setMessage]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const video=useRef<HTMLVideoElement>(null),controller=useRef<AbortController|null>(null),worker=useRef<BrowserCapture|null>(null);
  async function refresh(id:string) {setItems((await listMeta()).filter(row=>row.deviceId===id&&row.complete).sort((a,b)=>b.createdAt-a.createdAt));}
  useEffect(()=>{
    let closed=false;
    const capture=new BrowserCapture(()=>{},()=>{});worker.current=capture;
    let timer:ReturnType<typeof setInterval>|undefined;
    void (async()=>{
      try {
        const response=await fetch("/api/tablet",{signal:AbortSignal.timeout(15000)}),state=await response.json().catch(()=>null);
        if(!state)throw Error("Tablet connection unavailable. Please retry.");
        if(!response.ok||!state.enabled||!state.device?.id) throw Error(state.error||"Enroll this device first.");
        if(closed)return;
        const id=state.device.id;setDevice(id);await refresh(id);
        const run=()=>{void refresh(id).catch(()=>{});if(navigator.onLine)void capture.processQueue(id);};
        run();timer=setInterval(run,15000);
      } catch(e) {if(!closed)setError((e as Error).message);}
    })();
    return()=>{closed=true;if(timer)clearInterval(timer);controller.current?.abort();capture.dispose();};
  },[]);
  async function download(item:LocalRecording) {
    const blob=await savedVideo(item.id,item.mime);
    if(!blob.size)throw Error("This video has already uploaded and its local copy is no longer available.");
    const url=URL.createObjectURL(blob),link=document.createElement("a");
    link.href=url;link.download=`dinkvision-${item.id}.mp4`;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
  }
  async function clip(item:LocalRecording) {
    if(controller.current || !video.current)return;
    const abort=new AbortController();controller.current=abort;setBusy(true);setError("");
    try {
      if(!navigator.locks)throw Error("Use current Chrome or Edge to export clips.");
      await navigator.locks.request(`casa-tablet-recorder-v2:${device}`,{ifAvailable:true},async lock=>{
        if(!lock)throw Error("Finish the active recording on this device before exporting a clip.");
        const source=await savedVideo(item.id,item.mime);
        if(!source.size)throw Error("The local source is no longer available.");
        if((item.durationMs||0)<=60000) {await download(item);setMessage("The source is under one minute. Its original video was downloaded and stays local.");return;}
        setMessage("Exporting the last minute at normal speed. Keep this page visible.");
        const output=await cutLastMinute(source,video.current!,!!item.expectAudio,abort.signal,seconds=>setMessage(`Exporting clip… ${Math.floor(seconds)} / 60 seconds`));
        if(abort.signal.aborted)throw Error("Clip export cancelled.");
        const id=crypto.randomUUID();
        // Chunk storage must commit before the queue can observe complete=true.
        await saveMeta({id,deviceId:device,mime:"video/mp4",complete:false,interrupted:false,createdAt:Date.now(),sourceSessionId:item.id,clipStartMs:Math.floor(output.startMs),expectAudio:item.expectAudio});
        await saveChunk(id,0,output.blob);
        const meta=await getMeta(id);
        await saveMeta({...meta!,complete:true,bytes:output.blob.size,durationMs:output.durationMs,status:"pending",localAvailable:true});
        setMessage("Clip saved locally and added to this device’s upload queue. The original is unchanged. Clips under one minute stay local.");
      });
      await refresh(device);void worker.current?.processQueue(device);
    } catch(e) {setError((e as Error).message);}
    finally {controller.current=null;setBusy(false);}
  }
  return <main className="shell"><a href="/">← Recording screen</a><section className="card">
    <h1>Local recordings &amp; clips</h1><p>Save the last minute of a finished recording. The original stays unchanged. Export takes about a minute; leave this page visible.</p>
    <video ref={video} playsInline muted style={{width:"100%",maxWidth:640,display:busy?"block":"none"}} />
    {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
    {busy&&<button onClick={()=>controller.current?.abort()}>Cancel export</button>}
    {!items.length&&<p>No finished recordings saved on this device.</p>}
    {items.map(item=><article className="card" key={item.id}>
      <strong>{item.sourceSessionId?"Clip":"Recording"} · {new Date(item.createdAt).toLocaleString()}</strong>
      <p>{Math.round((item.durationMs||0)/1000)} seconds · {(item.status||"saved locally").replaceAll("_"," ")}</p>
      {item.lastError&&<p>{item.lastError}</p>}
      <button disabled={busy||item.localAvailable===false} onClick={()=>void download(item).catch(e=>setError(e.message))}>Download local video</button>{" "}
      {!item.sourceSessionId&&<button disabled={busy||item.localAvailable===false||item.validationFailed} onClick={()=>void clip(item)}>Save last minute</button>}{" "}
      {item.status==="failed"&&!item.validationFailed&&<button disabled={busy} onClick={()=>void worker.current?.retry(item.id,device).then(()=>refresh(device)).catch(e=>setError(e.message))}>Retry upload</button>}
    </article>)}
    <p>Videos under one minute are kept locally without a Drive upload or email. Browser data belongs to this device; clearing it removes local recordings.</p>
  </section></main>;
}

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "fake-indexeddb/auto";
import { BrowserCapture } from "../lib/browser-recorder";
import { openCamera } from "../lib/browser-media";
import { getMeta, patchMeta, removeVideo, saveMeta, savedVideo } from "../lib/browser-storage";

const clip = readFileSync(new URL("./fixtures/recording-one-second.mp4", import.meta.url));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 1000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await sleep(5);
  }
}

test("concurrent metadata updates preserve completion, UI dismissal and retry fields", async () => {
  const id = "atomic-meta-stress";
  try {
    for (let i = 0; i < 20; i++) {
      await saveMeta({id, deviceId:"stress", mime:"video/mp4", complete:true, interrupted:false, createdAt:1, status:"uploading"});
      await Promise.all([
        patchMeta(id,{status:"uploaded",progress:100}),
        patchMeta(id,{dismissedFromPlayer:true}),
        patchMeta(id,{failureReportPending:false,failureServerUpdatedAt:Date.parse("2026-10-13T12:00:00Z")}),
      ]);
      const result = (await getMeta(id))!;
      assert.equal(result.status,"uploaded","dismissing a result must not resurrect an uploading job");
      assert.equal(result.dismissedFromPlayer,true);
      assert.equal(result.failureServerUpdatedAt,Date.parse("2026-10-13T12:00:00Z"));
    }
  } finally { await removeVideo(id); }
});

type Fault = "none" | "permission" | "missing-audio" | "construct" | "start-throws" | "encoder-error"
  | "no-start" | "empty-stop" | "stop-throws" | "no-stop" | "permission-timeout" | "permission-delayed" | "server-delayed";
async function captureHarness(run: (h: {
  capture: BrowserCapture; config: Parameters<BrowserCapture["start"]>[0];
  setFault: (fault: Fault) => void; start: () => Promise<void>; held: Set<string>;
  ids: string[]; tracks: Array<{readyState:string}>; page: EventTarget; events:string[];
}) => Promise<void>) {
  const names = ["navigator","window","document","MediaRecorder","MediaStream","MediaStreamTrackProcessor","MediaStreamTrackGenerator","Worker","fetch","setTimeout"] as const;
  const old = new Map(names.map(name => [name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const realTimeout = globalThis.setTimeout;
  const held = new Set<string>(), ids: string[] = [], events: string[] = [];
  const tracks: Array<Track> = [];
  const page = new EventTarget();
  const documentMock = Object.assign(new EventTarget(), {visibilityState:"visible"});
  const config = {id:"stress-device",source_type:"local" as const,video_device:"camera",audio_device:"microphone",camera_name:"Stress camera"};
  let fault: Fault = "none";
  class Track extends EventTarget {
    readyState = "live"; enabled = true;
    stop() { this.readyState = "ended"; }
  }
  class Generator extends Track { writable={}; }
  class Processor { readable={cancel:async()=>{}}; }
  class Stream {
    constructor(private streamTracks: Track[]) {}
    getTracks(){return this.streamTracks;}
    getVideoTracks(){return this.streamTracks.filter(track=>track instanceof Generator);}
    getAudioTracks(){return this.streamTracks.filter(track=>!(track instanceof Generator));}
  }
  class LogoWorker {
    onerror?:()=>void;onmessage?:(event:{data:{type:string}})=>void;
    postMessage(){queueMicrotask(()=>this.onmessage?.({data:{type:"frame"}}));}
    terminate(){}
  }
  class Recorder {
    static isTypeSupported() { return true; }
    state = "inactive";
    onstart?: () => void; onstop?: () => void; onerror?: () => void;
    ondataavailable?: (event:{data:Blob}) => void;
    constructor() { if (fault === "construct") throw Error("Encoder construction failed"); }
    start() {
      if (fault === "start-throws") throw Error("Encoder start failed");
      this.state = "recording";
      const currentFault = fault;
      realTimeout(() => {
        if (currentFault === "no-start") return;
        if (currentFault === "encoder-error") { this.onerror?.(); return; }
        this.onstart?.();
        if (currentFault === "empty-stop") { this.state="inactive"; this.onstop?.(); return; }
        this.ondataavailable?.({data:new Blob([clip])});
      },0);
    }
    requestData() {}
    stop() {
      if (fault === "stop-throws") throw Error("Encoder stop failed");
      this.state="inactive";
      if (fault !== "no-stop") realTimeout(() => this.onstop?.(),0);
    }
  }
  const capture = new BrowserCapture(()=>{},()=>{});
  const mocks = {
    window:Object.assign(page,{isSecureContext:true}), document:documentMock, MediaRecorder:Recorder,
    MediaStream:Stream,MediaStreamTrackProcessor:Processor,MediaStreamTrackGenerator:Generator,Worker:LogoWorker,
    setTimeout:((fn:()=>void, ms?:number, ...args:unknown[]) => realTimeout(fn, ms && ms >= 10000 && ms <= 20000 ? 60 : ms,...args)) as typeof setTimeout,
    navigator:{
      storage:{estimate:async()=>({quota:1_000_000_000,usage:0}),persist:async()=>true},
      mediaDevices:{getUserMedia:async()=>{
        if (fault === "permission") throw new DOMException("Camera permission denied","NotAllowedError");
        const video=new Track(), audio=new Track(); tracks.push(video,audio);
        const stream={getTracks:()=>[video,audio],getVideoTracks:()=>[video],getAudioTracks:()=>fault === "missing-audio" ? [] : [audio]};
        if (fault === "permission-timeout") await new Promise(resolve=>realTimeout(resolve,100));
        if (fault === "permission-delayed") await new Promise(resolve=>realTimeout(resolve,20));
        return stream;
      }},
      locks:{request:async(name:string,options:{ifAvailable?:boolean},fn:(lock:object|null)=>Promise<void>)=>{
        if (held.has(name) && options.ifAvailable) return fn(null);
        held.add(name);
        try { await fn({}); } finally { held.delete(name); }
      }},
    },
    fetch:async(_input:unknown,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body)); events.push(body.action);
      if(body.action === "start") {
        const id=`stress-${ids.length}`;ids.push(id);
        if (fault === "server-delayed") await new Promise(resolve=>realTimeout(resolve,20));
        return Response.json({id});
      }
      if(body.action === "saved") return Response.json({localOnly:true,reason:"short_recording"});
      return Response.json({ok:true});
    },
  };
  for (const [name,value] of Object.entries(mocks)) Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  try {
    await run({capture,config,setFault:value=>{fault=value;},
      start:()=>capture.start(config,["test@gmail.com"],`key-${ids.length}`,60),held,ids,tracks,page,events});
  } finally {
    fault="none"; capture.dispose();
    await new Promise(resolve=>realTimeout(resolve,100));
    for (const id of ids) await removeVideo(id);
    for (const [name,descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis,name,descriptor);
      else Reflect.deleteProperty(globalThis,name);
    }
  }
}

for (const fault of ["permission","missing-audio","construct","start-throws","encoder-error","no-start","empty-stop"] as Fault[]) {
  test(`capture can start again after ${fault}`, {timeout:3000}, async()=>captureHarness(async h=>{
    h.setFault(fault);
    await assert.rejects(Promise.race([h.start(),sleep(500).then(()=>{throw Error("Capture promise hung");})]), error=>{
      assert.doesNotMatch(String(error),/Capture promise hung/);
      return true;
    });
    await until(()=>h.held.size===0,"failed capture releases locks");
    assert.equal(h.capture.activeId,null);
    assert.ok(h.tracks.every(track=>track.readyState==="ended"),"all opened camera tracks close");
    h.setFault("none");
    await h.start();
    assert.ok(h.capture.activeId,"same capture instance reconnects");
    h.capture.stop(true);
    await until(()=>h.capture.activeId===null && h.held.size===0,"next capture finalizes");
  }));
}

for (const fault of ["stop-throws","no-stop"] as Fault[]) {
  test(`capture releases hardware and preserves bytes after ${fault}`, {timeout:3000}, async()=>captureHarness(async h=>{
    await h.start();
    const id=h.capture.activeId!;
    h.setFault(fault); h.capture.stop(true);
    await until(()=>h.capture.activeId===null && h.held.size===0,"encoder failure releases lock");
    assert.equal((await savedVideo(id,"video/mp4")).size,clip.length);
    assert.equal((await getMeta(id))?.status,"failed");
    h.setFault("none"); await h.start(); h.capture.stop(true);
    await until(()=>h.capture.activeId===null && h.held.size===0,"next recording finalizes");
  }));
}

test("late permission response closes tracks after camera-open timeout",async()=>captureHarness(async h=>{
  h.setFault("permission-timeout");
  await assert.rejects(openCamera(h.config),/Camera access did not open/);
  await until(()=>h.tracks.every(track=>track.readyState==="ended"),"late camera tracks closed");
}));

for (const fault of ["permission-delayed","server-delayed"] as Fault[]) {
  test(`leaving during ${fault} cannot start a ghost recording`,async()=>captureHarness(async h=>{
    h.setFault(fault);
    const start=h.start();
    await until(()=>fault === "permission-delayed" ? h.tracks.length>0 : h.events.includes("start"),"startup request entered");
    h.capture.dispose();
    await assert.rejects(start,/cancel|closed/i);
    await until(()=>h.held.size===0,"cancelled startup releases capture lock");
    assert.equal(h.capture.activeId,null);
    assert.ok(h.tracks.every(track=>track.readyState==="ended"));
    assert.equal(h.events.includes("started"),false);
  }));
}

test("navigation during countdown cancels startup without trapping the next match",async()=>captureHarness(async h=>{
  await assert.rejects(h.capture.start(h.config,["test@gmail.com"],"countdown",60,async()=>{
    h.page.dispatchEvent(new Event("pagehide"));
  }),/cancel|closed|stopped/i);
  await until(()=>h.held.size===0,"countdown releases lock");
  assert.equal(h.events.includes("started"),false);
  await h.start(); h.capture.stop(true);
  await until(()=>h.held.size===0,"next recording completes");
}));

test("full local storage stops capture and a later recording can recover",async()=>captureHarness(async h=>{
  const put=IDBObjectStore.prototype.put;
  const transaction=IDBDatabase.prototype.transaction, close=IDBDatabase.prototype.close;
  const connections=new Set<IDBDatabase>();
  IDBDatabase.prototype.transaction=function(...args:Parameters<IDBDatabase["transaction"]>) {
    connections.add(this);return transaction.apply(this,args);
  };
  IDBDatabase.prototype.close=function() { connections.delete(this);return close.call(this); };
  IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey) {
    if(this.name==="chunks") throw new DOMException("Storage is full","QuotaExceededError");
    return put.call(this,value,key);
  };
  try {
    try { await assert.rejects(h.start(),/storage/i); }
    finally { IDBObjectStore.prototype.put=put; }
    await until(()=>h.held.size===0,"storage failure releases locks");
    assert.equal((await getMeta(h.ids[0]))?.status,"failed");
    assert.equal(connections.size,0,"quota errors close their IndexedDB connection");
    await h.start();h.capture.stop(true);
    await until(()=>h.held.size===0,"recording works after storage is available");
  } finally {
    for (const db of connections) close.call(db);
    IDBDatabase.prototype.transaction=transaction;
    IDBDatabase.prototype.close=close;
  }
}));

test("double start and repeated stop do not create duplicate sessions",async()=>captureHarness(async h=>{
  h.setFault("permission-delayed");
  const starting=h.start();
  await assert.rejects(h.start(),/Finish the current recording/);
  await starting;
  h.setFault("none");
  await assert.rejects(h.start(),/Finish the current recording/);
  h.capture.stop();h.capture.stop();h.capture.stop(true);h.capture.stop(true);
  await until(()=>h.held.size===0,"one finalization releases all locks");
  assert.equal(h.ids.length,1);
  assert.equal(h.events.filter(event=>event==="stopped").length,1);
  assert.equal((await savedVideo(h.ids[0],"video/mp4")).size,clip.length);
}));

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "fake-indexeddb/auto";
import { BrowserCapture, tabletRequest } from "../lib/browser-recorder";
import { saveMeta, saveChunk, getMeta, savedVideo, removeVideo, patchMeta } from "../lib/browser-storage";

const clip=readFileSync(new URL("./fixtures/recording-one-second.mp4",import.meta.url));
async function queueHarness(run:(h:{worker:BrowserCapture;held:Set<string>;actions:string[];ids:string[];
  respond:(fn:(body:any)=>Response|Promise<Response>)=>void; seed:(id:string,complete?:boolean)=>Promise<void>})=>Promise<void>) {
  const nav=Object.getOwnPropertyDescriptor(globalThis,"navigator"), originalFetch=globalThis.fetch;
  const held=new Set<string>(), actions:string[]=[], ids:string[]=[];
  let response:(body:any)=>Response|Promise<Response>=()=>Response.json({ok:true,ready:true});
  Object.defineProperty(globalThis,"navigator",{configurable:true,value:{locks:{
    request:async(name:string,options:any,run:(lock:object|null)=>Promise<void>)=>{
      if(held.has(name) && options.ifAvailable) return run(null);
      held.add(name);try{await run({});}finally{held.delete(name);}
    },
  }}});
  globalThis.fetch=async(input,init)=>{
    const body=String(input).includes("upload-chunk") ? {id:new URL(String(input),"http://local").searchParams.get("id"),action:"chunk"} : JSON.parse(String(init?.body));
    actions.push(`${body.id}:${body.action}`);
    return response(body);
  };
  try { await run({worker:new BrowserCapture(()=>{},()=>{}),held,actions,ids,respond:fn=>{response=fn;},seed:async(id,complete=true)=>{
    ids.push(id);
    await saveMeta({id,deviceId:"fault-device",mime:"video/mp4",complete,interrupted:false,createdAt:ids.length,status:"saved_locally",durationMs:1000,bytes:clip.length});
    await saveChunk(id,0,new Blob([clip]));
  }}); } finally {
    for(const id of ids) await removeVideo(id);
    globalThis.fetch=originalFetch;
    if(nav) Object.defineProperty(globalThis,"navigator",nav);else Reflect.deleteProperty(globalThis,"navigator");
  }
}

const faults:Record<string,(body:any)=>Response|Promise<Response>>={
  "non-JSON server failure":()=>new Response("<html>Bad gateway</html>",{status:502}),
  "empty success response":()=>new Response("",{status:200}),
  "null response":()=>Response.json(null),
  "request timeout":()=>{throw new DOMException("Request timed out","TimeoutError");},
  "missing upload offset":body=>Response.json(body.action==="upload-status"?{}:{ok:true}),
  "negative offset":body=>Response.json(body.action==="upload-status"?{offset:-1}:{ok:true}),
  "fractional offset":body=>Response.json(body.action==="upload-status"?{offset:1.5}:{ok:true}),
  "offset beyond video":body=>Response.json(body.action==="upload-status"?{offset:clip.length+1}:{ok:true}),
  "lost chunk response":body=>body.action==="chunk"?Promise.reject(Error("Network lost after chunk")):Response.json({ok:true,offset:0}),
  "missing final confirmation":body=>Response.json(body.action==="upload"?{ready:true}:{ok:true}),
  "repeated upload expiry":body=>Response.json(body.action==="upload-status"?{expired:true}:{ok:true}),
};
for(const [fault,respond] of Object.entries(faults)) test(`queue retains video and advances after ${fault}`,async()=>queueHarness(async h=>{
  await h.seed("faulty");await h.seed("healthy");
  h.respond(body=>body.id==="healthy"||body.action==="upload-failed"?Response.json({ok:true,ready:true}):respond(body));
  await h.worker.processQueue("fault-device");
  assert.equal((await getMeta("faulty"))?.status,"retrying");
  assert.equal((await getMeta("faulty"))?.retryCount,1);
  assert.equal((await savedVideo("faulty","video/mp4")).size,clip.length);
  assert.equal((await getMeta("healthy"))?.status,"uploaded");
  assert.equal(h.held.size,0);
  assert.ok(h.actions.length<20,"one bad recording has a bounded number of requests");
}));

test("API errors show a connection message instead of raw JSON parsing errors",async()=>queueHarness(async h=>{
  h.respond(()=>new Response("<html>Bad gateway</html>",{status:502}));
  await assert.rejects(tabletRequest("heartbeat"),/Tablet.*502|connection unavailable/i);
  h.respond(()=>Response.json(null));
  await assert.rejects(tabletRequest("heartbeat"),/Tablet|connection unavailable/i);
}));

test("cancelled uploads stay local, stop retrying and release the next recording",async()=>queueHarness(async h=>{
  await h.seed("cancelled");await h.seed("healthy");
  h.respond(body=>body.id==="cancelled"&&body.action==="upload"?Response.json({queued:true,queue:{state:"cancelled"}}):Response.json({ok:true,ready:true}));
  await h.worker.processQueue("fault-device");
  assert.equal((await getMeta("cancelled"))?.status,"failed");
  assert.equal((await savedVideo("cancelled","video/mp4")).size,clip.length);
  assert.equal((await getMeta("healthy"))?.status,"uploaded");
  const requests=h.actions.length;await h.worker.processQueue("fault-device");
  assert.equal(h.actions.length,requests);
}));

test("eight failures exhaust retries with persistent exponential backoff",async()=>queueHarness(async h=>{
  await h.seed("exhausted");
  h.respond(body=>body.action==="upload-failed"?Response.json({ok:true}):Promise.reject(Error("Offline")));
  for(let attempt=1;attempt<=8;attempt++) {
    await patchMeta("exhausted",{nextRetryAt:0});
    const before=Date.now();
    await new BrowserCapture(()=>{},()=>{}).processQueue("fault-device");
    const item=(await getMeta("exhausted"))!;
    assert.equal(item.retryCount,attempt);
    assert.equal(item.status,attempt===8?"failed":"retrying");
    if(attempt<8) {
      const delay=Math.min(900000,5000*2**(attempt-1));
      assert.ok(item.nextRetryAt!>=before+delay);
      assert.ok(item.nextRetryAt!<=Date.now()+delay+Math.max(1000,delay/4));
    }
  }
  const count=h.actions.length; await h.worker.processQueue("fault-device");
  assert.equal(h.actions.length,count);
  assert.equal((await savedVideo("exhausted","video/mp4")).size,clip.length);
}));

test("restart quarantines abandoned capture but never touches an active capture",async()=>queueHarness(async h=>{
  await h.seed("unfinished",false);
  h.held.add("casa-tablet-recorder-v2:fault-device");
  await h.worker.processQueue("fault-device");
  assert.equal((await getMeta("unfinished"))?.status,"saved_locally");
  assert.equal(h.actions.length,0);
  h.held.delete("casa-tablet-recorder-v2:fault-device");
  await new BrowserCapture(()=>{},()=>{}).processQueue("fault-device");
  assert.equal((await getMeta("unfinished"))?.status,"failed");
  assert.equal((await getMeta("unfinished"))?.interrupted,true);
  assert.equal((await savedVideo("unfinished","video/mp4")).size,clip.length);
  assert.ok(h.actions.includes("unfinished:failed"));
  assert.equal(h.actions.some(action=>action.endsWith(":upload")),false);
}));

test("lost completion response resumes confirmation without transferring another copy",async()=>queueHarness(async h=>{
  await h.seed("confirm");let finish=0,transfers=0;
  h.respond(body=>{
    if(body.action==="upload")return Response.json({ready:finish>0});
    if(body.action==="upload-status")return Response.json({offset:0});
    if(body.action==="chunk"){transfers++;return Response.json({accepted:true});}
    if(body.action==="finish"&&finish++===0)throw Error("Confirmation response lost");
    return Response.json({ok:true,ready:true});
  });
  await h.worker.processQueue("fault-device");
  assert.equal((await savedVideo("confirm","video/mp4")).size,clip.length);
  await patchMeta("confirm",{nextRetryAt:0});
  // Retry uses the same server job; it reports the already completed object.
  h.respond(body=>{if(body.action==="chunk")transfers++;return Response.json({ok:true,ready:true});});
  await new BrowserCapture(()=>{},()=>{}).processQueue("fault-device");
  assert.equal((await getMeta("confirm"))?.status,"uploaded");
  assert.equal(transfers,1);
}));

test("overlapping workers drain two device queues without duplicates or losing local clips",async()=>queueHarness(async h=>{
  for(let i=0;i<24;i++) {
    await h.seed(`batch-${i}`);
    if(i%2)await patchMeta(`batch-${i}`,{deviceId:"second-device"});
  }
  h.respond(async body=>{
    await new Promise(resolve=>setTimeout(resolve,1));
    const index=Number(body.id.split("-")[1]);
    if(body.action==="saved" && index%3===0)return Response.json({localOnly:true,reason:"short_recording"});
    return Response.json({ok:true,ready:true});
  });
  await Promise.all(Array.from({length:8},(_,i)=>new BrowserCapture(()=>{},()=>{}).processQueue(i%2?"second-device":"fault-device")));
  for(let i=0;i<24;i++) {
    assert.equal(h.actions.filter(action=>action===`batch-${i}:saved`).length,1);
    assert.equal((await getMeta(`batch-${i}`))?.status,i%3===0?"local_only":"uploaded");
    assert.equal((await savedVideo(`batch-${i}`,"video/mp4")).size,i%3===0?clip.length:0);
  }
  assert.equal(h.held.size,0);
}));

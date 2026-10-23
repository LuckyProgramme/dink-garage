// Optional real Chrome/Edge media and persistence checks. Synthetic camera only;
// this is not a physical USB, Android WebView or cloud integration test.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import ts from 'typescript';
import ffmpeg from 'ffmpeg-static';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.DINKVISION_PLAYWRIGHT || 'playwright');
const output=resolve('.local/cross-platform/media');
await mkdir(output,{recursive:true});
const run=promisify(execFile),results=[];
await run(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x90:rate=30','-f','lavfi','-i','sine=frequency=1000:sample_rate=48000','-t','65','-c:v','libx264','-preset','ultrafast','-c:a','aac','-movflags','+faststart','-y',`${output}/source.mp4`],{windowsHide:true});
const modules=new Set(['browser-media','browser-storage','recording-integrity','capture-visibility','camera-transform','video-clip']);
const server=createServer(async(req,res)=>{
 try {
  if(req.url==='/') {res.setHeader('content-type','text/html');res.end('<!doctype html><video muted playsinline controls width="640" height="360"></video>');}
  else if(req.url==='/source.mp4') {res.setHeader('content-type','video/mp4');res.end(await readFile(`${output}/source.mp4`));}
  else if(req.url==='/camera-transform-worker.js') {res.setHeader('content-type','text/javascript');res.end(await readFile('public/camera-transform-worker.js'));}
  else if(req.url?.startsWith('/lib/')&&modules.has(req.url.slice(5))) {
   res.setHeader('content-type','text/javascript');res.end(ts.transpileModule(await readFile(`lib/${req.url.slice(5)}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
  } else if(['/output/chrome','/output/edge'].includes(req.url)&&req.method==='POST') {
   const parts=[];for await(const chunk of req)parts.push(chunk);
   await writeFile(`${output}/${req.url.split('/').at(-1)}-clip.mp4`,Buffer.concat(parts));res.end('ok');
  } else {res.statusCode=404;res.end();}
 }catch(error){res.statusCode=500;res.end('Test fixture failed');console.error(error);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const stamp=Date.now();
try {
 for(const [name,channel] of [['chrome','chrome'],['edge','msedge']]) {
  let context;
  const profile=`${output}/${name}-profile-${stamp}`;
  const options={channel,headless:true,permissions:['camera','microphone'],locale:'en-US',timezoneId:'Pacific/Honolulu',acceptDownloads:true,
   args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling']};
  const check=async(test,action)=>{
   try {const evidence=await action();results.push({engine:name,test,status:'PASS',evidence});console.log(`${name}: PASS ${test}`);}
   catch(error) {results.push({engine:name,test,status:'FAIL',error:error.stack});console.error(`${name}: FAIL ${test}: ${error.message}`);}
   await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));
  };
  try {
   context=await chromium.launchPersistentContext(profile,options);
   let page=context.pages()[0];await page.goto(origin);
   await check('three repeated short MP4 captures, transformed camera and track cleanup',()=>page.evaluate(async()=>{
    const {testCamera}=await import('/lib/browser-media');
    const {inspectRecording}=await import('/lib/recording-integrity');
    const {saveMeta,saveChunk}=await import('/lib/browser-storage');
    const devices=await navigator.mediaDevices.enumerateDevices();
    const camera={source_type:'local',video_device:devices.find(d=>d.kind==='videoinput').deviceId,audio_device:devices.find(d=>d.kind==='audioinput').deviceId,camera_name:'Synthetic test'};
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),tracks=[];
    navigator.mediaDevices.getUserMedia=async c=>{const stream=await original(c);tracks.push(...stream.getTracks());return stream;};
    const clips=[];
    try {
     for(let i=0;i<3;i++) {
      const start=performance.now(),blob=await testCamera({...camera,video_flip_horizontal:i===1},document.querySelector('video'));
      const timing=await inspectRecording(blob,undefined,true);
      if(timing.videoMs<2500||timing.videoMs>4000)throw Error(`Unexpected capture duration ${timing.videoMs}`);
      if(tracks.some(t=>t.readyState!=='ended'))throw Error('Camera track leaked after test');
      if(document.querySelector('video').srcObject)throw Error('Preview retained camera');
      await saveMeta({id:`short-${i}`,deviceId:'test-device',mime:'video/mp4',complete:true,interrupted:false,createdAt:Date.now(),durationMs:timing.videoMs,status:'local_only'});
      await saveChunk(`short-${i}`,0,blob);
      clips.push({...timing,bytes:blob.size,wallMs:performance.now()-start});
     }
     return clips;
    } finally {navigator.mediaDevices.getUserMedia=original;tracks.forEach(t=>t.stop());}
   }));
   await check('offline local video read and MP4 validation',async()=>{
    await context.setOffline(true);
    try {return await page.evaluate(async()=>{
     const {savedVideo,listMeta}=await import('/lib/browser-storage');const {inspectRecording}=await import('/lib/recording-integrity');
     const rows=await listMeta();if(rows.length!==3)throw Error('Queued recordings missing');
     return {records:rows.length,timing:await inspectRecording(await savedVideo('short-0','video/mp4'),undefined,true)};
    });} finally {await context.setOffline(false);}
   });
   await check('local recordings survive complete browser process restart',async()=>{
    await context.close();context=await chromium.launchPersistentContext(profile,options);page=context.pages()[0];await page.goto(origin);
    return page.evaluate(async()=>{
     const {savedVideo,listMeta}=await import('/lib/browser-storage');const {inspectRecording}=await import('/lib/recording-integrity');
     const rows=await listMeta();if(rows.length!==3||rows.some(r=>r.status!=='local_only'))throw Error('Persistent queue changed');
     return {records:rows.length,timing:await inspectRecording(await savedVideo('short-2','video/mp4'),undefined,true)};
    });
   });
   await check('H.264/AAC playback at normal speed, seek and Unicode download',async()=>{
    const evidence=await page.evaluate(async()=>{
     const video=document.querySelector('video');const blob=await(await fetch('/source.mp4')).blob();
     video.src=URL.createObjectURL(blob);await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(Error('MP4 decoder rejected source'));video.load();});
     await new Promise(resolve=>{video.onseeked=resolve;video.currentTime=30;});
     const start=performance.now(),position=video.currentTime;await video.play();await new Promise(resolve=>setTimeout(resolve,2000));video.pause();
     const ratio=(video.currentTime-position)/((performance.now()-start)/1000);
     if(ratio<0.85||ratio>1.15)throw Error(`Unexpected playback rate ${ratio}`);
     const result={ratio,duration:video.duration,position:video.currentTime,width:video.videoWidth};
     if(Math.abs(video.duration-65)>0.1)throw Error('Source timeline changed');
     URL.revokeObjectURL(video.src);video.removeAttribute('src');video.load();return result;
    });
    const download=page.waitForEvent('download');
    await page.evaluate(async()=>{const {savedVideo}=await import('/lib/browser-storage');const a=document.createElement('a');a.href=URL.createObjectURL(await savedVideo('short-0','video/mp4'));a.download='DinkVision 日本 São Paulo.mp4';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);});
    const file=await download;await file.saveAs(`${output}/${name}-download.mp4`);
    if(file.suggestedFilename()!=='DinkVision 日本 São Paulo.mp4')throw Error('Unicode filename changed');
    await run(ffmpeg,['-hide_banner','-v','error','-xerror','-i',`${output}/${name}-download.mp4`,'-f','null','-'],{windowsHide:true});
    return {...evidence,downloadDecoded:true};
   });
   await check('real last-minute export, full decode and cancellation cleanup',async()=>{
    const evidence=await page.evaluate(async name=>{
     const {cutLastMinute}=await import('/lib/video-clip');
     const source=await(await fetch('/source.mp4')).blob(),video=document.querySelector('video');
     const start=performance.now();const clip=await cutLastMinute(source,video,true,new AbortController().signal,()=>{});
     const wallMs=performance.now()-start;
     if(clip.durationMs<59000||clip.durationMs>61500)throw Error(`Clip duration ${clip.durationMs}`);
     await fetch(`/output/${name}`,{method:'POST',body:clip.blob});
     const cancelled=new AbortController();setTimeout(()=>cancelled.abort(),1500);let failed=false;
     try {await cutLastMinute(source,video,true,cancelled.signal,()=>{});}catch(e){failed=/cancelled/i.test(e.message);}
     if(!failed||video.getAttribute('src'))throw Error('Cancellation retained playback/export resources');
     return {durationMs:clip.durationMs,startMs:clip.startMs,wallMs,bytes:clip.blob.size,cancellation:true};
    },name);
    await run(ffmpeg,['-hide_banner','-v','error','-xerror','-i',`${output}/${name}-clip.mp4`,'-f','null','-'],{windowsHide:true});
    return {...evidence,fullDecode:true};
   });
  }catch(error){results.push({engine:name,test:'browser runtime',status:'FAIL',error:error.stack});}
  finally{await context?.close();}
 }
}finally{server.closeAllConnections();server.close();}
await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify({pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL')},null,2));
if(results.some(r=>r.status==='FAIL'))process.exitCode=1;

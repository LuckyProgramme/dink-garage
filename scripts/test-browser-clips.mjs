// Real Chromium MediaRecorder + playback integration. Synthetic source; no USB
// camera or cloud credentials. Run explicitly, not in the fast unit suite.
import {createServer} from "node:http";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {spawn,execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";
import ts from "typescript";
import ffmpeg from "ffmpeg-static";
const run=promisify(execFile),folder=resolve(".local/rebrand-audit/browser-clips");
await mkdir(folder,{recursive:true});
await run(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=160x90:rate=30","-f","lavfi","-i","sine=frequency=1000:sample_rate=48000","-t","65","-c:v","libx264","-preset","ultrafast","-c:a","aac","-movflags","+faststart","-y",`${folder}/source.mp4`],{windowsHide:true});
let settle;
const result=new Promise(resolve=>{settle=resolve;});
const modules=new Set(["video-clip","recording-integrity","browser-media","capture-visibility","camera-transform"]);
const html=`<html><body><video id="video" width="640" height="360" muted playsinline></video><pre id="status">running</pre>
<script type="module">
import {cutLastMinute} from '/lib/video-clip';
try {
const source=await (await fetch('/source.mp4')).blob();
const result=await cutLastMinute(source,document.querySelector('video'),true,new AbortController().signal,seconds=>document.querySelector('pre').textContent=seconds);
await fetch('/output',{method:'POST',body:result.blob});
const cancelled=new AbortController();setTimeout(()=>cancelled.abort(),1500);
let cancellation=false;
try {await cutLastMinute(source,document.querySelector('video'),true,cancelled.signal,()=>{});}
catch(error){cancellation=/cancelled/.test(String(error));}
if(!cancellation || document.querySelector('video').getAttribute('src'))throw Error('Cancellation did not release the video source');
await fetch('/result',{method:'POST',body:JSON.stringify({pass:true,startMs:result.startMs,durationMs:result.durationMs,bytes:result.blob.size,cancellation:true})});
} catch(error) {await fetch('/result',{method:'POST',body:JSON.stringify({pass:false,error:String(error),stack:error.stack})});}
</script></body></html>`;
const server=createServer(async(req,res)=>{
  try {
    if(req.url==='/'){res.setHeader('content-type','text/html');res.end(html);}
    else if(req.url==='/source.mp4'){res.setHeader('content-type','video/mp4');res.end(await readFile(`${folder}/source.mp4`));}
    else if(req.url?.startsWith('/lib/') && modules.has(req.url.slice(5))){
      res.setHeader('content-type','text/javascript');res.end(ts.transpileModule(await readFile(`lib/${req.url.slice(5)}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
    } else if(req.url==='/output'||req.url==='/result') {
      const parts=[];for await(const chunk of req)parts.push(chunk);const data=Buffer.concat(parts);
      if(req.url==='/output')await writeFile(`${folder}/output.mp4`,data);
      else settle(JSON.parse(data.toString()));
      res.end('ok');
    } else {res.statusCode=404;res.end();}
  }catch(error){res.statusCode=500;res.end('test failure');settle({pass:false,error:String(error)});}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const chrome=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--disable-background-networking','--disable-background-timer-throttling',
  '--autoplay-policy=no-user-gesture-required',`--user-data-dir=${folder}/chrome-profile`,
  '--no-first-run','--no-default-browser-check',`http://127.0.0.1:${server.address().port}/`
],{windowsHide:true,stdio:'ignore'});
let deadline;
try {
  const evidence=await Promise.race([result,new Promise(resolve=>{deadline=setTimeout(()=>resolve({pass:false,error:'Browser integration timed out'}),110000);})]);
  if(evidence.pass) await run(ffmpeg,['-hide_banner','-v','error','-xerror','-i',`${folder}/output.mp4`,'-f','null','-'],{windowsHide:true});
  await writeFile(`${folder}/result.json`,JSON.stringify(evidence,null,2));
  console.log(evidence);if(!evidence.pass)process.exitCode=1;
}finally{clearTimeout(deadline);chrome.kill();server.closeAllConnections();server.close();}

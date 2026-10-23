// Optional browser acceptance runner. Uses an externally installed Playwright;
// no application dependency or real account/Google/camera access is required.
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const pw=require(process.env.DINKVISION_PLAYWRIGHT || 'playwright');
const base=process.env.TEST_ORIGIN || 'http://127.0.0.1:3108';
const output=resolve('.local/cross-platform');await mkdir(output,{recursive:true});
const results=[];
const engines=[['chrome',pw.chromium,{channel:'chrome'}],['edge',pw.chromium,{channel:'msedge'}]];
const viewports=[{width:320,height:640},{width:390,height:844},{width:768,height:1024},{width:1024,height:600},{width:1280,height:800},{width:1920,height:1080},{width:640,height:400}];
for(const [name,engine,options] of engines){
 let browser;
 try{browser=await engine.launch({...options,headless:true});}catch(error){results.push({engine:name,test:'launch',status:'BLOCKED',error:error.message});continue;}
 try{
  const context=await browser.newContext({locale:'en-US',timezoneId:'Pacific/Honolulu'});
  // Render the actual bundled APK UI with a fake bridge. This tests its DOM/CSS,
  // not native Android capture, WebView implementation or OS lifecycle.
  await context.route('**/__native/**',async route=>{const file=new URL(route.request().url()).pathname.split('/').at(-1);if(!['index.html','app.js','style.css','dink-vision-logo.png','court.svg'].includes(file))return route.abort();await route.fulfill({body:await readFile(`android/app/src/main/assets/${file}`),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':'text/html'});});
  await context.addInitScript(()=>{window.fixture={enabled:true,tested:true,court:'Court 日本 — São Paulo',maxSeconds:900,phase:'idle',busy:false,queue:[]};window.nativeActions=[];window.DinkVisionNative={state:()=>JSON.stringify(window.fixture),action:(action,value)=>window.nativeActions.push({action,value})};});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/preview`);await page.getByRole('button',{name:/Tap to start/}).waitFor();
  const capabilities=await page.evaluate(()=>({secure:window.isSecureContext,media:!!navigator.mediaDevices?.getUserMedia,mp4:typeof MediaRecorder!=='undefined'&&MediaRecorder.isTypeSupported('video/mp4'),locks:!!navigator.locks,idb:!!window.indexedDB,captureStream:typeof HTMLVideoElement.prototype.captureStream==='function',transform:typeof MediaStreamTrackProcessor!=='undefined'&&typeof MediaStreamTrackGenerator!=='undefined',playback:document.createElement('video').canPlayType('video/mp4;codecs="avc1.42E01E,mp4a.40.2"')}));
  results.push({engine:name,test:'capabilities',status:'PASS',capabilities,version:browser.version()});
  for(const viewport of viewports){
   await page.setViewportSize(viewport);
   for(const route of ['/admin/login','/tablet/setup','/tablet/clips','/preview','/__native/index.html']){
    await page.goto(`${base}${route}`,{waitUntil:'networkidle'});
    if(route==='/preview')await page.getByRole('button',{name:/Tap to start/}).waitFor();
    const layout=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));
    results.push({engine:name,test:'layout',route,viewport,status:layout.scroll<=layout.width+1?'PASS':'FAIL',...layout});
    if(route==='/preview'||route==='/__native/index.html'){
     if(route==='/preview')await page.getByRole('button',{name:/Tap to start/}).click();else await page.locator('#begin').click();
     await page.locator('#player-email').fill('dinkvision.test@gmail.com');
     await page.getByRole('button',{name:/Add Gmail/}).click();
     const form=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,buttons:[...document.querySelectorAll('.tablet-record,.record')].filter(e=>e.getClientRects().length).map(e=>({height:e.getBoundingClientRect().height,width:e.getBoundingClientRect().width,text:e.textContent}))}));
     results.push({engine:name,test:'recording form',route,viewport,status:form.scroll<=form.width+1&&form.buttons.every(b=>b.width>=44&&b.height>=44)?'PASS':'FAIL',...form});
     if(route==='/__native/index.html') {
      const overlap=await page.evaluate(()=>{const a=document.querySelector('.brand').getBoundingClientRect(),b=document.querySelector('#setup').getBoundingClientRect();return a.right>b.left+1&&a.left<b.right-1&&a.bottom>b.top+1&&a.top<b.bottom-1;});
      results.push({engine:name,test:'native header controls do not overlap',viewport,status:overlap?'FAIL':'PASS'});
     }
     if(viewport.width===320||viewport.width===1024)await page.screenshot({path:`${output}/${name}-${route==='/preview'?'web':'native'}-${viewport.width}.png`,fullPage:true});
    }
   }
  }
  await page.goto(`${base}/__native/index.html`);await page.locator('#begin').click();
  await page.locator('#player-email').fill('retry.test@gmail.com');await page.locator('#add-email').click();
  await page.locator('#email-form').evaluate(form=>form.requestSubmit());await page.locator('#record').click();
  await page.evaluate(()=>{window.fixture={...window.fixture,busy:false,phase:'error',error:'Camera temporarily unavailable.'};});
  await page.waitForTimeout(850);await page.locator('#record').click();
  const retryRecipients=await page.evaluate(()=>{const attempts=window.nativeActions.filter(a=>a.action==='start');return attempts.length===2&&attempts.every(a=>JSON.parse(a.value)[0]==='retry.test@gmail.com');});
  results.push({engine:name,test:'native immediate failed start retains recipients for retry',status:retryRecipients?'PASS':'FAIL'});
  await page.goto(`${base}/__native/index.html`);await page.locator('#begin').click();
  await page.evaluate(()=>{window.fixture={...window.fixture,busy:true,phase:'recording'};});
  await page.locator('#stop').waitFor();
  await page.evaluate(()=>{window.fixture={...window.fixture,busy:false,phase:'complete',message:'Short clip saved locally.'};});
  await page.waitForTimeout(850);
  const result=await page.locator('#reset').isVisible();results.push({engine:name,test:'native result stays until next match',status:result?'PASS':'FAIL'});
  if(result){await page.locator('#reset').click();results.push({engine:name,test:'native next match opens form',status:await page.locator('#email-form').isVisible()?'PASS':'FAIL'});}
  await page.evaluate(()=>{window.fixture={...window.fixture,busy:true,phase:'recording',session:{status:'recording'}};});
  await page.locator('#stop').waitFor();
  await page.evaluate(()=>{window.fixture={...window.fixture,busy:false,phase:'error',error:'USB camera disconnected.'};});
  await page.waitForTimeout(850);
  results.push({engine:name,test:'native stale server recording cannot trap a failed capture',status:await page.locator('#reset').isVisible()?'PASS':'FAIL'});
  if(await page.locator('#reset').isVisible())await page.locator('#reset').click();
  await page.evaluate(()=>{window.fixture={...window.fixture,phase:'idle',error:'',queue:[{id:'test-local',status:'local_only',localAvailable:true,durationMs:3200},{id:'bad-file',status:'failed',localAvailable:true,validationFailed:true,durationMs:60000}]};});
  await page.waitForTimeout(850);
  await page.locator('#local-videos').evaluate(e=>e.open=true);
  const plays=page.getByRole('button',{name:'Play local video'});
  const onePlayable=await plays.count()===1;
  if(onePlayable)await plays.click();
  const played=await page.evaluate(()=>window.nativeActions.some(a=>a.action==='play-local'&&a.value==='test-local'));
  results.push({engine:name,test:'native local playback excludes invalid files',status:onePlayable&&played?'PASS':'FAIL'});
  // Enlarge all computed text sizes to exercise Android-style font scaling.
  for(const route of ['/preview','/__native/index.html']){
   await page.setViewportSize({width:768,height:1024});await page.goto(`${base}${route}`);
   if(route==='/preview')await page.getByRole('button',{name:/Tap to start/}).click();else await page.locator('#begin').click();
   await page.evaluate(()=>{const elements=[...document.querySelectorAll('body *')];const sizes=elements.map(e=>parseFloat(getComputedStyle(e).fontSize));elements.forEach((e,i)=>e.style.fontSize=`${sizes[i]*2}px`);});
   const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
   results.push({engine:name,test:'200 percent text scale',route,status:fits?'PASS':'FAIL'});
   const textFits=await page.evaluate(()=>{
    const button=document.querySelector('.tablet-record,.record'),box=button.getBoundingClientRect(),walker=document.createTreeWalker(button,NodeFilter.SHOW_TEXT);
    let node;while(node=walker.nextNode()){if(!node.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(node);
     for(const r of range.getClientRects())if(r.left<box.left||r.right>box.right||r.top<box.top||r.bottom>box.bottom)return false;}
    return true;
   });
   results.push({engine:name,test:'enlarged recording label is not clipped',route,status:textFits?'PASS':'FAIL'});
   await page.screenshot({path:`${output}/${name}-${route==='/preview'?'web':'native'}-text200.png`,fullPage:true});
  }
  results.push({engine:name,test:'uncaught browser errors',status:errors.length?'FAIL':'PASS',errors});
  await context.route('**/api/tablet',route=>route.fulfill({status:500,contentType:'text/plain',body:''}));
  await page.goto(`${base}/tablet/clips`);
  await page.getByText('Tablet connection unavailable. Please retry.',{exact:true}).waitFor();
  results.push({engine:name,test:'empty API error produces actionable local-video error',status:'PASS'});
  await context.close();
  // Desktop Chromium touch emulation is deliberately not labelled Android runtime.
  const touch=await browser.newContext({hasTouch:true,isMobile:true,viewport:{width:800,height:1280},deviceScaleFactor:2});
  const tablet=await touch.newPage();await tablet.goto(`${base}/preview`);
  await tablet.getByRole('button',{name:/Tap to start/}).tap();
  await tablet.locator('#player-email').fill('touch.test@gmail.com');
  await tablet.locator('#player-email').press('Enter');
  const touchFits=await tablet.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
  results.push({engine:name,test:'tablet touch and keyboard email entry (emulated)',status:touchFits&&await tablet.getByRole('button',{name:'Remove touch.test@gmail.com'}).isVisible()?'PASS':'FAIL'});
  await touch.close();
 }catch(error){results.push({engine:name,test:'runner',status:'FAIL',error:error.stack});}
 finally{await browser.close();}
 await writeFile(`${output}/browser-results.json`,JSON.stringify(results,null,2));
}
await writeFile(`${output}/browser-results.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify({pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL'),blocked:results.filter(r=>r.status==='BLOCKED'),capabilities:results.filter(r=>r.test==='capabilities')},null,2));
if(results.some(r=>r.status==='FAIL'))process.exitCode=1;

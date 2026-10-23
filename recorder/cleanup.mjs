import {realpath,lstat,readFile,unlink} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
export async function removeExpiredLocal(home,job) {
 if(!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(job.session_id) || job.local_filename!==`${job.session_id}/video.mp4`) throw new Error('Invalid cleanup path');
 const root=await realpath(resolve(home,'captures'));
 const directory=join(root,job.session_id);
 let path;
 try {
  if((await lstat(directory)).isSymbolicLink()) throw new Error('Linked directory');
  const actual=await realpath(directory);
  if(actual!==directory || !actual.startsWith(root+sep)) throw new Error('Outside captures');
  path=join(actual,'video.mp4');
  const info=await lstat(path);
  if(info.isSymbolicLink() || !info.isFile()) throw new Error('Not a regular recording');
 } catch(e) {if(e.code==='ENOENT') return;throw e;}
 const state=JSON.parse(await readFile(join(directory,'state.json'),'utf8'));
 if(state.state!=='local_ready' || state.job?.session_id!==job.session_id) throw new Error('Capture not finalized');
 // Delete the single validated video, never recursively remove a computed directory.
 await unlink(path);
}
export async function cleanupLoop(home,config,api,stopping) {
 while(!stopping()) {
  try {
   const {job}=await api(config,'cleanup',{action:'next'});
   if(job) {
    try {await removeExpiredLocal(home,job);await api(config,'cleanup',{action:'complete',file_id:job.file_id,token:job.token});}
    catch {await api(config,'cleanup',{action:'failed',file_id:job.file_id,token:job.token}).catch(()=>{});}
   }
  } catch { /* Durable job and retry timestamp survive outages. */ }
  if(!stopping()) await delay(10000);
 }
}

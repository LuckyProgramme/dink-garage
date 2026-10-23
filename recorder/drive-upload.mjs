import { open, stat, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function validateUploadUri(value) {
  const u=new URL(value);
  if (u.protocol!=="https:" || u.hostname!=="www.googleapis.com" || !u.pathname.startsWith("/upload/drive/v3/files") || u.username || u.password || u.port || u.hash)
    throw new Error("Invalid upload address");
  return u.href;
}
function acknowledged(response, bytes) {
  const range=response.headers.get("range");
  if (!range) return 0;
  const match=/^bytes=0-(\d+)$/.exec(range);
  const offset=match ? Number(match[1])+1 : NaN;
  if (!Number.isSafeInteger(offset) || offset>bytes || offset<1) throw new Error("Invalid upload offset");
  return offset;
}
export async function transferFile(path, uri, bytes, renew, request=fetch) {
  validateUploadUri(uri);
  const put=(body, range)=>request(uri,{method:"PUT",redirect:"manual",signal:AbortSignal.timeout(60000),headers:{"Content-Type":"video/mp4","Content-Length":String(body?.length || 0),"Content-Range":range},body});
  const status=await put(undefined,`bytes */${bytes}`);
  if (status.status===200 || status.status===201) return "complete";
  if ([400,401,403,404,410].includes(status.status)) return "expired";
  if (status.status!==308) throw new Error("Upload interrupted");
  let offset=acknowledged(status,bytes);
  const file=await open(path,"r");
  try {
    while (offset<bytes) {
      await renew();
      const buffer=Buffer.alloc(Math.min(4*1024*1024,bytes-offset));
      const {bytesRead}=await file.read(buffer,0,buffer.length,offset);
      if (bytesRead!==buffer.length) throw new Error("Local file changed");
      const response=await put(buffer,`bytes ${offset}-${offset+bytesRead-1}/${bytes}`);
      if (response.status===200 || response.status===201) return "complete";
      if ([400,401,403,404,410].includes(response.status)) return "expired";
      if (response.status!==308) throw new Error("Upload interrupted");
      const next=acknowledged(response,bytes);
      if (next<=offset || next>offset+bytesRead) throw new Error("Upload made no progress");
      offset=next;
    }
    // A full-range 308 isn't proof of successful finalization.
    throw new Error("Upload not finalized");
  } finally { await file.close(); }
}
export async function uploadOne(home, config, api) {
  const {job}=await api(config,"uploads",{action:"next"});
  if (!job) return false;
  const identity={file_id:job.file_id,token:job.token};
  let localValid=false;
  try {
    if (!/^[a-f0-9-]{36}$/.test(job.session_id) || job.local_filename!==`${job.session_id}/video.mp4`) throw new Error("Invalid local file");
    const root=await realpath(resolve(home,"captures"));
    const path=await realpath(join(root,job.local_filename));
    if (!path.startsWith(root+sep)) throw new Error("Invalid local file");
    const bytes=Number(job.bytes);
    if (!Number.isSafeInteger(bytes) || bytes<=0 || (await stat(path)).size!==bytes) throw new Error("Local file missing");
    localValid=true;
    const hash=createHash("md5");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const md5=hash.digest("hex");
    const prepared=await api(config,"uploads",{action:"prepare",...identity,md5});
    if (!prepared.uploaded) {
      const result=await transferFile(path,prepared.uri,bytes,()=>api(config,"uploads",{action:"renew",...identity}));
      if (result==="expired") {
        await api(config,"uploads",{action:"reset",...identity});
        throw new Error("Upload session expired");
      }
    }
    await api(config,"uploads",{action:"finish",...identity});
    // Keep the local original until the later cleanup build provides a recovery policy.
    return true;
  } catch {
    await api(config,"uploads",{action:"failed",...identity,code:localValid?"upload_interrupted":"local_file_missing"}).catch(()=>{});
    return false;
  }
}
export async function uploadLoop(home,config,api,stopping) {
  while (!stopping()) {
    try { await uploadOne(home,config,api); } catch { /* Retry independently of camera control. */ }
    if (!stopping()) await delay(5000);
  }
}

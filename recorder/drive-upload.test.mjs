import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { transferFile, validateUploadUri } from "./drive-upload.mjs";
test("Drive upload resumes from Google's acknowledged offset after a lost response",async()=>{
  const root=resolve(".local"); await mkdir(root,{recursive:true});
  const dir=await mkdtemp(join(root,"drive-test-"));
  try {
    const payload=Buffer.alloc(5*1024*1024,7), path=join(dir,"video.mp4");
    await writeFile(path,payload);
    let received=0,lose=true;
    const offsets=[];
    const fake=async(_uri,options)=>{
      const range=options.headers["Content-Range"];
      if(range.startsWith("bytes */")) return new Response(null,{status:received===payload.length?200:308,headers:received?{range:`bytes=0-${received-1}`}:{}});
      const match=/bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      assert.equal(Number(match[1]),received); offsets.push(received);
      assert.equal(options.body.length,Number(match[2])-received+1);
      received=Number(match[2])+1;
      if(lose){lose=false;throw Error("Connection dropped after server received chunk");}
      return new Response(null,{status:received===payload.length?200:308,headers:{range:`bytes=0-${received-1}`}});
    };
    const uri="https://www.googleapis.com/upload/drive/v3/files?upload_id=private";
    await assert.rejects(()=>transferFile(path,uri,payload.length,async()=>{},fake));
    assert.equal(await transferFile(path,uri,payload.length,async()=>{},fake),"complete");
    assert.deepEqual(offsets,[0,4*1024*1024]);
    assert.equal(await transferFile(path,uri,payload.length,async()=>{},fake),"complete");
    assert.equal(offsets.length,2,"completed upload is not retransmitted");
    assert.equal(await transferFile(path,uri,payload.length,async()=>{},async()=>new Response(null,{status:404})),"expired");
    assert.throws(()=>validateUploadUri("https://evil.example/upload"));
  } finally {await rm(dir,{recursive:true,force:true});}
});

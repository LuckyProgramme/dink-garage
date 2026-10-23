import test from 'node:test';
import assert from 'node:assert/strict';
import {GoogleDrive} from '../lib/google-drive';
import {deleteExpiredVideo} from '../lib/retention';
test('Retention only deletes expired owned videos in their recorded folder',async()=>{
 let deletes=0;
 const drive=new GoogleDrive('test',(async(_url,init)=>{if(init?.method==='DELETE'){deletes++;return new Response(null,{status:204});}return Response.json({mimeType:'video/mp4',parents:['folder123'],owners:[{emailAddress:'owner@gmail.com'}]});}) as typeof fetch);
 const file={drive_file_id:'video12345',expires_at:new Date(Date.now()-1000).toISOString()};
 await assert.rejects(deleteExpiredVideo(drive,{...file,expires_at:new Date(Date.now()+60000).toISOString()},'folder123','owner@gmail.com'),/not_expired/);
 await assert.rejects(deleteExpiredVideo(drive,file,'different','owner@gmail.com'),/identity_mismatch/);
 await assert.rejects(deleteExpiredVideo(drive,file,'folder123','other@gmail.com'),/identity_mismatch/);
 assert.equal(deletes,0);await deleteExpiredVideo(drive,file,'folder123','owner@gmail.com');assert.equal(deletes,1);
});
test('Missing Drive file is idempotent; permission and transient failures are not marked deleted',async()=>{
 const file={drive_file_id:'video12345',expires_at:new Date(Date.now()-1000).toISOString()};
 for(const status of [404,403,503]) {
  const drive=new GoogleDrive('test',(async()=>Response.json({}, {status})) as typeof fetch);
  if(status===404) await deleteExpiredVideo(drive,file,'folder123','owner@gmail.com');
  else await assert.rejects(deleteExpiredVideo(drive,file,'folder123','owner@gmail.com'));
 }
});

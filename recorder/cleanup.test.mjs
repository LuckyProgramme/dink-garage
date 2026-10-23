import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {removeExpiredLocal} from './cleanup.mjs';
test('Local cleanup unlinks only a finalized recording and tolerates repeated acknowledgement',async()=>{
 const home=await mkdtemp(resolve('.local/cleanup-test-')),id=randomUUID();
 const dir=join(home,'captures',id);await mkdir(dir,{recursive:true});
 await writeFile(join(dir,'video.mp4'),'fixture');await writeFile(join(dir,'keep.txt'),'metadata');
 const job={session_id:id,local_filename:`${id}/video.mp4`};
 await writeFile(join(dir,'state.json'),JSON.stringify({state:'recording',job:{session_id:id}}));
 await assert.rejects(removeExpiredLocal(home,job),/not finalized/);
 await assert.rejects(removeExpiredLocal(home,{...job,local_filename:'../video.mp4'}),/Invalid/);
 await writeFile(join(dir,'state.json'),JSON.stringify({state:'local_ready',job:{session_id:id}}));
 await removeExpiredLocal(home,job);await removeExpiredLocal(home,job);
 await assert.rejects(stat(join(dir,'video.mp4')),/ENOENT/);assert.ok(await stat(join(dir,'keep.txt')));
});

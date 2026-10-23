// Explicit live camera/Drive verification. Requires owner OAuth and a real seeded player.
// node --env-file=.env --import tsx scripts/test-drive-live.mts <player-credentials.json>
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../lib/google-crypto";
import { GoogleDrive, privatePermissions } from "../lib/google-drive";
const base=process.env.TEST_APP_URL || "http://127.0.0.1:3000";
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SECRET_KEY!,{auth:{persistSession:false}});
const integration=await db.from("google_integration").select("*").eq("id",true).single();
assert.ok(integration.data,"Owner must connect Google in Admin Settings first");
const credentials=JSON.parse(await readFile(process.argv[2],"utf8"));
const login=await fetch(base+"/api/auth/login",{method:"POST",headers:{Origin:base,"Content-Type":"application/json"},body:JSON.stringify({email:credentials.email,password:credentials.password})});
assert.equal(login.status,200);
const cookie=login.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ");
async function action(body: object) {
  const r=await fetch(base+"/api/recordings",{method:"POST",headers:{Cookie:cookie,Origin:base,"Content-Type":"application/json"},body:JSON.stringify(body)});
  assert.equal(r.status,200); return r.json();
}
async function snapshot() {
  const r=await fetch(base+"/api/recordings",{headers:{Cookie:cookie}});
  assert.equal(r.status,200);return r.json();
}
let id: string | undefined;
try {
  const before=await snapshot();
  const court=before.courts.find((c:{camera_status:string})=>c.camera_status==="online");
  assert.ok(court,"A court must be available");
  id=(await action({action:"start",court_id:court.id,key:randomUUID()})).id;
  let recorded=false;
  for(let i=0;i<45;i++) {
    const session=(await snapshot()).sessions.find((s:{id:string})=>s.id===id);
    if(session?.status==="recording"){recorded=true;break;}
    assert.notEqual(session?.status,"failed");await delay(1000);
  }
  assert.ok(recorded,"Camera must deliver frames");
  await delay(5000);await action({action:"stop",id});
  let ready=false;
  for(let i=0;i<150;i++) {
    const session=(await snapshot()).sessions.find((s:{id:string})=>s.id===id);
    assert.notEqual(session?.status,"failed",`Upload failed at ${session?.failure_stage}`);
    if(session?.playback_available){ready=true;break;}
    await delay(2000);
  }
  assert.ok(ready,"Drive upload and sharing must complete");
  const playback=await fetch(`${base}/api/recordings/${id}/playback`,{headers:{Cookie:cookie},redirect:"manual"});
  assert.equal(playback.status,303);
  assert.match(playback.headers.get("location") || "",/^https:\/\/drive\.google\.com\/file\/d\//);
  assert.equal((await fetch(`${base}/api/recordings/${id}/playback`,{redirect:"manual"})).status,401);
  const file=await db.from("recording_files").select("drive_file_id,bytes").eq("session_id",id).single();
  assert.ok(file.data?.drive_file_id);
  const tokens=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID!,client_secret:process.env.GOOGLE_CLIENT_SECRET!,grant_type:"refresh_token",refresh_token:decryptSecret(integration.data!.refresh_token_encrypted)})});
  assert.equal(tokens.status,200);
  const drive=new GoogleDrive((await tokens.json()).access_token);
  assert.equal(Number((await drive.file(file.data.drive_file_id)).size),Number(file.data.bytes));
  const permissions=await drive.permissions(file.data.drive_file_id);
  assert.ok(privatePermissions(permissions,integration.data!.owner_email,credentials.email));
  assert.ok(permissions.some(p=>p.emailAddress?.toLowerCase()===credentials.email.toLowerCase()));
  console.log(`PASS: real capture, upload size, private recipient sharing and authenticated playback redirect. Session: ${id}`);
  console.log("Final manual check: sign into Google as the player and play the video from Recent recordings.");
} finally {if(id) await action({action:"stop",id}).catch(()=>{});}

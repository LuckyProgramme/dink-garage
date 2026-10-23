import test from "node:test";
import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {DEFAULT_TENANT_ID,TENANT_HEADER,scopedFetch} from "../lib/tenant-scope";
import {createClient} from "@supabase/supabase-js";

async function database(beforeTenancy?:(db:PGlite)=>Promise<void>) {
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create table auth.users(id uuid primary key,email text unique,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to authenticated,anon,service_role;
    alter default privileges in schema public grant all on tables to authenticated,anon;
    alter default privileges in schema public grant usage,select on sequences to authenticated;`);
  for(const name of (await readdir("supabase/migrations")).filter(name=>name.endsWith(".sql")).sort()) {
    if(name.includes("0036_") && beforeTenancy)await beforeTenancy(db);
    await db.exec((await readFile(`supabase/migrations/${name}`,"utf8")).replace("create extension if not exists pgcrypto;",""));
  }
  return db;
}

test("two tenants isolate table reads, writes, device RPCs, queue claims and revoked memberships",async()=>{
  const db=await database();
  try {
    const ownerA=randomUUID(),ownerB=randomUUID();
    await db.query("insert into auth.users(id,email) values($1,'owner-a@example.test'),($2,'owner-b@example.test')",[ownerA,ownerB]);
    const a=(await db.query<{id:string}>("select public.register_tenant($1,'Tenant A','tenant-a') id",[ownerA])).rows[0].id;
    const b=(await db.query<{id:string}>("select public.register_tenant($1,'Tenant B','tenant-b') id",[ownerB])).rows[0].id;
    async function scope(id:string,user="",role="none") {
      await db.exec("reset role");
      await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claim.sub',$2,false)",[JSON.stringify({[TENANT_HEADER]:id}),user]);
      if(role!=="none") await db.exec(`set role ${role}`);
    }
    const fixture=async(tid:string,owner:string)=>{
      await scope(tid);
      const court=(await db.query<{id:string}>("insert into public.courts(name) values('Court 1') returning id")).rows[0].id;
      const kiosk=(await db.query<{id:string}>("insert into public.kiosk_devices(token_hash,created_by) values($1,$2) returning id",[randomUUID(),owner])).rows[0].id;
      const device=(await db.query<{id:string}>("insert into public.browser_devices(name,court_id,kiosk_id,tested_at) values('Tablet',$1,$2,now()) returning id",[court,kiosk])).rows[0].id;
      const session=(await db.query<{id:string}>("select public.browser_start($1,'player@example.test',$2) id",[kiosk,randomUUID()])).rows[0].id;
      await db.query("select public.browser_event($1,$2,'started')",[kiosk,session]);
      await db.query("select public.browser_event($1,$2,'saved',100,'video/mp4')",[kiosk,session]);
      await db.query("select public.queue_browser_upload($1,$2)",[session,device]);
      const file=(await db.query<{file_id:string}>("select file_id from public.browser_recordings where session_id=$1",[session])).rows[0].file_id;
      await db.query("insert into public.audit_events(session_id,action) values($1,'fixture.private')",[session]);
      return {court,kiosk,device,session,file};
    };
    const fa=await fixture(a,ownerA),fb=await fixture(b,ownerB);
    await scope(a,ownerA,"authenticated");
    for(const table of ["courts","recording_sessions","recording_files","audit_events","venue_settings"]){
      const rows=await db.query<{tenant_id:string}>(`select tenant_id from public.${table}`);
      assert.ok(rows.rows.length>0,`${table} own data visible`);
      assert.ok(rows.rows.every(row=>row.tenant_id===a),`${table} isolated`);
    }
    assert.equal((await db.query("update public.courts set name='Intrusion' where id=$1 returning id",[fb.court])).rows.length,0);
    await assert.rejects(()=>db.query("insert into public.courts(tenant_id,name) values($1,'Intrusion')",[b]),/row-level security/);
    await assert.rejects(()=>db.query("select * from public.browser_recordings"),/permission denied/);
    await assert.rejects(()=>db.query("select * from public.browser_upload_turn($1,$2,true)",[fb.session,fb.device]),/permission denied/);
    await scope(b,ownerA,"authenticated");
    assert.equal((await db.query("select * from public.courts")).rows.length,0,"forged tenant header fails closed");
    assert.equal((await db.query("select * from public.player_court_status()")).rows.length,0,"security definer respects membership");
    await scope(a,"","service_role");
    assert.equal((await db.query("select * from public.browser_upload_turn($1,$2,true)",[fb.session,fb.device])).rows.length,0,"service RPC cannot claim another tenant's job");
    const first=(await db.query<any>("select * from public.browser_upload_turn($1,$2,true)",[fa.session,fa.device])).rows[0];
    assert.equal(first.allowed,true);
    await assert.rejects(()=>db.query("insert into public.browser_devices(name,court_id) values('Wrong owner',$1)",[fb.court]),/foreign key/);
    await assert.rejects(()=>db.query("update public.browser_devices set tenant_id=$1 where id=$2",[b,fa.device]),/Tenant ownership/);
    await scope(b,"","service_role");
    assert.equal((await db.query<any>("select * from public.browser_upload_turn($1,$2,true)",[fb.session,fb.device])).rows[0].allowed,true,"second tenant uploads independently");
    await db.query("select public.report_browser_upload($1,$2,'failed',0)",[fb.session,fb.device]);
    await scope(a,"","service_role");
    assert.equal((await db.query<any>("select * from public.browser_upload_turn($1,$2,false)",[fa.session,fa.device])).rows[0].upload_state,"uploading","failure in B cannot change A");
    await scope(a);
    await db.query("update public.tenant_memberships set active=false where tenant_id=$1 and user_id=$2",[a,ownerA]);
    await scope(a,ownerA,"authenticated");
    assert.equal((await db.query("select * from public.recording_files")).rows.length,0,"removed admin loses access immediately with same JWT");
    assert.equal((await db.query<any>("select public.is_admin() value")).rows[0].value,false);
    await scope(b,ownerB,"authenticated");
    assert.equal((await db.query("select * from public.recording_sessions")).rows.length,1);
  } finally {await db.close();}
});

test("tenancy migration preserves existing device identity, videos, encrypted credentials and queued retries",async()=>{
  const owner=randomUUID(),court=randomUUID(),kiosk=randomUUID(),device=randomUUID(),session=randomUUID(),file=randomUUID(),lease=randomUUID();
  const db=await database(async legacy=>{
    await legacy.query("insert into auth.users(id,email) values($1,'legacy@example.test')",[owner]);
    await legacy.query("update public.profiles set role='admin' where id=$1",[owner]);
    await legacy.query("insert into public.courts(id,name,location) values($1,'Existing court','Original venue')",[court]);
    await legacy.query("insert into public.kiosk_devices(id,token_hash,created_by) values($1,'original-token',$2)",[kiosk,owner]);
    await legacy.query("insert into public.browser_devices(id,name,court_id,kiosk_id) values($1,'Original tablet',$2,$3)",[device,court,kiosk]);
    await legacy.query("insert into public.recording_sessions(id,kiosk_id,court_id,idempotency_key,recipient_email,status,configuration_snapshot) values($1,$2,$3,$4,'legacy@example.test','uploading',$5)",[session,kiosk,court,randomUUID(),JSON.stringify({capture_mode:"browser",device_id:device,sharing_mode:"link"})]);
    await legacy.query("insert into public.recording_files(id,session_id,status,bytes) values($1,$2,'local_ready',123456)",[file,session]);
    await legacy.query("insert into public.browser_recordings(session_id,device_id,file_id,bytes,mime_type,upload_state,retry_count,duration_ms,lease_token,lease_until,upload_uri_encrypted) values($1,$2,$3,123456,'video/mp4','retrying',3,90000,$4,now()+interval '1 minute','original-encrypted-upload')",[session,device,file,lease]);
    await legacy.exec("insert into public.google_integration(owner_email,root_folder_id,refresh_token_encrypted) values('legacy@example.test','originalRoot123','original-encrypted-google')");
  });
  try {
    const saved=(await db.query<any>("select * from public.browser_recordings where session_id=$1",[session])).rows[0];
    assert.equal(saved.tenant_id,DEFAULT_TENANT_ID);assert.equal(saved.file_id,file);assert.equal(saved.device_id,device);
    assert.equal(saved.upload_state,"retrying");assert.equal(saved.retry_count,3);assert.equal(saved.lease_token,lease);
    assert.equal(saved.upload_uri_encrypted,"original-encrypted-upload");assert.equal(Number(saved.bytes),123456);
    const connection=(await db.query<any>("select * from public.google_integration")).rows[0];
    assert.equal(connection.refresh_token_encrypted,"original-encrypted-google");assert.equal(connection.root_folder_id,"originalRoot123");
    assert.equal((await db.query<any>("select token_hash from public.kiosk_devices where id=$1",[kiosk])).rows[0].token_hash,"original-token");
    assert.equal((await db.query<any>("select role from public.tenant_memberships where user_id=$1",[owner])).rows[0].role,"admin");
    assert.equal((await db.query<any>("select configuration_snapshot->>'sharing_mode' mode from public.recording_sessions where id=$1",[session])).rows[0].mode,"link","existing sharing contract is unchanged");
  } finally {await db.close();}
});

test("new accounts cannot self-assign membership or super-admin through metadata",async()=>{
  const db=await database();
  try {
    const user=randomUUID();
    await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'attacker@example.test',$2)",[user,JSON.stringify({role:"admin",is_super_admin:true,tenant_id:DEFAULT_TENANT_ID})]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
    await db.exec("set role authenticated");
    assert.equal((await db.query("select * from public.courts")).rows.length,0);
    assert.equal((await db.query<any>("select public.is_super_admin() value")).rows[0].value,false);
    assert.equal((await db.query("update public.profiles set is_super_admin=true returning id")).rows.length,0);
    await assert.rejects(()=>db.query("insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,'admin')",[DEFAULT_TENANT_ID,user]),/permission denied/);
  } finally {await db.close();}
});

test("service transport scopes selects, bulk inserts, updates and RPC context",async()=>{
  const requests:Request[]=[];
  const fake:typeof fetch=async input=>{requests.push(input as Request);return Response.json([]);};
  const db=createClient("https://fixture.supabase.co","fixture-key",{global:{fetch:scopedFetch(DEFAULT_TENANT_ID,fake)},auth:{persistSession:false}});
  await db.from("courts").select("*");
  await db.from("courts").insert([{name:"One"},{name:"Two"}]);
  await db.from("courts").update({name:"Changed"}).eq("id",randomUUID());
  await db.rpc("browser_upload_turn",{p_session:randomUUID(),p_device:randomUUID()});
  assert.equal(requests.length,4);
  for(const request of requests) assert.equal(request.headers.get(TENANT_HEADER),DEFAULT_TENANT_ID);
  for(const request of requests.slice(0,3)) assert.equal(new URL(request.url).searchParams.get("tenant_id"),`eq.${DEFAULT_TENANT_ID}`);
  assert.ok((await requests[1].json()).every((row:any)=>row.tenant_id===DEFAULT_TENANT_ID));
  assert.deepEqual(await requests[2].json(),{name:"Changed"},"preserve column-level UPDATE permissions");
  const before=requests.length;
  const mismatch=await db.from("courts").insert({tenant_id:randomUUID(),name:"Wrong tenant"});
  assert.ok(mismatch.error);assert.equal(requests.length,before,"forged ownership never reaches network");
});

test("tenant administration enforces last admin, quotas, locations and private clips across shared courts",async()=>{
  const db=await database();
  try {
    const owner=randomUUID(),player=randomUUID(),other=randomUUID();
    await db.query("insert into auth.users(id,email) values($1,'owner@example.test'),($2,'player@example.test'),($3,'other@example.test')",[owner,player,other]);
    const tenant=(await db.query<{id:string}>("select public.register_tenant($1,'Quota tenant','quota-tenant') id",[owner])).rows[0].id;
    await db.query("select set_config('request.headers',$1,false)",[JSON.stringify({[TENANT_HEADER]:tenant})]);
    await assert.rejects(()=>db.query("select public.set_tenant_member($1,$2,'owner@example.test','player',false)",[tenant,owner]),/at least one active/);
    await assert.rejects(()=>db.query("select public.set_tenant_member($1,$2,'other@example.test','admin',true)",[tenant,other]),/administrator required/);
    await db.query("select public.set_tenant_member($1,$2,'player@example.test','player',true)",[tenant,owner]);
    const court=(await db.query<{id:string}>("insert into public.courts(name,location) values('Shared court','North venue') returning id")).rows[0].id;
    assert.equal((await db.query<any>("select l.name from public.courts c join public.locations l on l.id=c.location_id where c.id=$1",[court])).rows[0].name,"North venue");
    await db.query("update public.tenants set max_courts=1,max_devices=2,storage_limit_bytes=250 where id=$1",[tenant]);
    await assert.rejects(()=>db.query("insert into public.courts(name) values('Too many')"),/court limit/);
    const devices=[];
    for(let i=0;i<2;i++){
      const kiosk=(await db.query<{id:string}>("insert into public.kiosk_devices(token_hash,created_by) values($1,$2) returning id",[randomUUID(),owner])).rows[0].id;
      const device=(await db.query<{id:string}>("insert into public.browser_devices(name,court_id,kiosk_id,tested_at) values($1,$2,$3,now()) returning id",[`Device ${i}`,court,kiosk])).rows[0].id;
      const session=(await db.query<{id:string}>("select public.browser_start($1,'player@example.test',$2) id",[kiosk,randomUUID()])).rows[0].id;
      devices.push({kiosk,device,session});
    }
    assert.equal((await db.query("select * from public.recording_sessions where status='requested'")).rows.length,2,"same court supports independent active devices");
    assert.equal((await db.query<any>("select configuration_snapshot->>'sharing_mode' mode from public.recording_sessions limit 1")).rows[0].mode,"private");
    await assert.rejects(()=>db.query("insert into public.browser_devices(name) values('Too many')"),/device limit/);
    const a=devices[0],b=devices[1];
    await assert.rejects(()=>db.query("select public.browser_start($1,'player@example.test',$2)",[a.kiosk,randomUUID()]),/previous recording/);
    await db.query("select public.browser_event($1,$2,'saved',100,'video/mp4')",[a.kiosk,a.session]);
    await db.query("select public.hold_short_browser_recording($1,$2,90000)",[a.session,a.device]);
    const clip=randomUUID();
    await assert.rejects(()=>db.query("select public.register_browser_clip($1,$2,$3,30000,60000)",[b.kiosk,a.session,clip]),/Finalize/);
    await assert.rejects(()=>db.query("select public.register_browser_clip($1,$2,$3,80000,60000)",[a.kiosk,a.session,clip]),/Invalid clip/);
    for(let i=0;i<2;i++)assert.equal((await db.query<any>("select public.register_browser_clip($1,$2,$3,30000,60000) id",[a.kiosk,a.session,clip])).rows[0].id,clip);
    await db.query("select public.browser_event($1,$2,'saved',100,'video/mp4')",[a.kiosk,clip]);
    const rows=await db.query<any>("select id from public.recording_files where session_id=$1",[clip]);
    await assert.rejects(()=>db.query("update public.recording_files set bytes=151 where id=$1",[rows.rows[0].id]),/storage limit/);
    assert.equal(Number((await db.query<any>("select public.tenant_storage_usage() bytes")).rows[0].bytes),200);
    assert.equal((await db.query<any>("select current_session_id from public.kiosk_devices where id=$1",[b.kiosk])).rows[0].current_session_id,b.session,"clip does not disturb another device's capture");
    const next=(await db.query<any>("select public.browser_start($1,'player@example.test',$2) id",[a.kiosk,randomUUID()])).rows[0].id;
    assert.ok(next,"clip queue never occupies physical recorder");
    await db.query("select public.browser_event($1,$2,'failed')",[a.kiosk,next]);
    await db.query("update public.browser_devices set enrollment_hash='rotate-fixture',enrollment_expires_at=now()+interval '5 minutes' where id=$1",[a.device]);
    await assert.rejects(()=>db.query("select public.enroll_browser('rotate-fixture','new-token','new-setup',$1)",[other]),/administrator no longer/);
    const rotated=(await db.query<any>("select public.enroll_browser('rotate-fixture','new-token','new-setup',$1) id",[owner])).rows[0].id;
    assert.equal(rotated,a.kiosk,"credential rotation preserves saved session owner identity");
    assert.equal((await db.query<any>("select token_hash from public.kiosk_devices where id=$1",[rotated])).rows[0].token_hash,"new-token");
    assert.equal((await db.query<any>("select public.browser_event($1,$2,'saved',100,'video/mp4') ok",[rotated,a.session])).rows[0].ok,true,"old finalized source remains recoverable");
    // A removed membership cannot retain administrator rights through profiles.role.
    await db.query("update public.profiles set role='admin' where id=$1",[player]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[player]);await db.exec("set role authenticated");
    assert.equal((await db.query<any>("select public.is_admin() value")).rows[0].value,false);
    const before=(await db.query<any>("select max_duration_seconds from public.venue_settings")).rows[0].max_duration_seconds;
    try {assert.equal((await db.query("update public.venue_settings set max_duration_seconds=120 returning id")).rows.length,0);}
    catch(error){assert.match(String(error),/row-level security|permission denied/);}
    assert.equal((await db.query<any>("select max_duration_seconds from public.venue_settings")).rows[0].max_duration_seconds,before);
  } finally {await db.close();}
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { provisionLegacyFixtureMemberships } from "./helpers/legacy-memberships";

test("signed-in admins can create and edit camera audio; players and forged health remain blocked", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to authenticated,anon;
      alter default privileges in schema public grant all on tables to authenticated,anon;`);
    for (const file of (await readdir("supabase/migrations")).filter(f => f.endsWith(".sql")).sort()) {
      await db.exec((await readFile(`supabase/migrations/${file}`, "utf8")).replace("create extension if not exists pgcrypto;", ""));
    }
    const admin = randomUUID(), player = randomUUID(), recorder = randomUUID();
    await db.query("insert into auth.users(id) values($1),($2)", [admin, player]);
    await db.query("update public.profiles set role='admin' where id=$1", [admin]);
    await provisionLegacyFixtureMemberships(db);
    await db.query("insert into public.recorders(id,name) values($1,'Recorder')", [recorder]);
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [admin]);
    const { rows } = await db.query<{id: string}>(
      "insert into public.cameras(name,recorder_id,source_type,device_reference,audio_source,is_primary,enabled) values('Camera',$1,'usb','usb-test','mic-123456789012345678901234',false,true) returning id", [recorder]);
    const camera = rows[0].id;
    const updated = await db.query<{audio_source: string}>("update public.cameras set audio_source='mic-000000000000000000000000' where id=$1 returning audio_source", [camera]);
    assert.equal(updated.rows[0].audio_source, "mic-000000000000000000000000");
    await assert.rejects(() => db.query("update public.cameras set health='online' where id=$1", [camera]), /permission denied/);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [player]);
    assert.equal((await db.query("update public.cameras set audio_source='' where id=$1 returning id", [camera])).rows.length, 0);
    await assert.rejects(() => db.query("insert into public.cameras(name,recorder_id,source_type,device_reference,audio_source,is_primary,enabled) values('Player camera',$1,'network','net-test','stream',false,true)", [recorder]), /row-level security/);
  } finally { await db.close(); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { provisionLegacyFixtureMemberships } from "./helpers/legacy-memberships";

test("a stopped browser capture releases the device for the next recording", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
   create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('public.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema public,auth to authenticated,anon;
   alter default privileges in schema public grant all on tables to authenticated,anon;
   alter default privileges in schema public grant usage,select on sequences to authenticated;`);
    for (const file of (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(
        (await readFile(`supabase/migrations/${file}`, "utf8")).replace(
          "create extension if not exists pgcrypto;",
          "",
        ),
      );
    const admin = randomUUID(),
      device = randomUUID(),
      court = randomUUID();
    await db.query("insert into auth.users(id) values($1)", [admin]);
    await db.query("update profiles set role='admin' where id=$1", [admin]);
    await provisionLegacyFixtureMemberships(db);
    await db.query("insert into courts(id,name) values($1,'Court 1')", [court]);
    await db.query(
      "insert into browser_devices(id,name,court_id,enrollment_hash,enrollment_expires_at) values($1,'Tablet 1',$2,'enroll',now()+interval '10 minutes')",
      [device, court],
    );
    const kiosk = (
      await db.query<{ id: string }>(
        "select enroll_browser('enroll','token','setup',$1) id",
        [admin],
      )
    ).rows[0].id;
    await db.query(
      "update browser_devices set tested_at=now(),video_device='usb-browser-id' where id=$1",
      [device],
    );
    const start = async () =>
      (
        await db.query<{ id: string }>(
          "select browser_start($1,'player@gmail.com',$2) id",
          [kiosk, randomUUID()],
        )
      ).rows[0].id;
    const event = async (id: string, action: string, bytes: number | null = null, mime: string | null = null) =>
      (
        await db.query<{ ok: boolean }>(
          "select browser_event($1,$2,$3,$4,$5) ok",
          [kiosk, id, action, bytes, mime],
        )
      ).rows[0].ok;
    const session = async (id: string) =>
      (
        await db.query<any>(
          "select status,stopped_at from recording_sessions where id=$1",
          [id],
        )
      ).rows[0];

    const first = await start();
    assert.equal(await event(first, "started"), true);
    assert.equal(await event(first, "stopped"), true);
    assert.equal((await session(first)).status, "finalizing");

    const second = await start();
    assert.notEqual(second, first, "a stopped capture no longer owns the device");
    assert.equal((await session(first)).status, "uploading");
    assert.equal(
      (
        await db.query<any>(
          "select upload_state,file_id from browser_recordings where session_id=$1",
          [first],
        )
      ).rows[0].upload_state,
      "saved_locally",
    );
    assert.equal(
      await event(first, "saved", 1024, "video/mp4"),
      true,
      "the released capture still uploads its local bytes",
    );
    assert.ok(
      (
        await db.query<any>(
          "select file_id from browser_recordings where session_id=$1",
          [first],
        )
      ).rows[0].file_id,
    );

    assert.equal(await event(second, "started"), true);
    assert.equal(await event(second, "stopped"), true);
    assert.equal((await session(second)).status, "finalizing");
    assert.equal(await event(second, "heartbeat"), true);
    assert.equal(
      (await session(second)).status,
      "uploading",
      "heartbeat releases a stopped finalizing capture",
    );
    assert.equal(
      (
        await db.query<any>("select current_session_id from kiosk_devices where id=$1", [
          kiosk,
        ])
      ).rows[0].current_session_id,
      null,
    );

    const third = await start();
    assert.equal(await event(third, "started"), true);
    await assert.rejects(
      () => start(),
      /previous recording/,
      "a genuinely recording capture still blocks the next match",
    );
  } finally {
    await db.close();
  }
});

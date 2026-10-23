import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { provisionLegacyFixtureMemberships } from "./helpers/legacy-memberships";

test("browser enrollment, fixed assignments, session ownership, recovery and cloud email leases", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
   create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
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
    const countAudits = async () =>
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from audit_events",
        )
      ).rows[0].n;
    const beforeHeartbeat = await countAudits();
    await db.exec("update venue_settings set browser_worker_at=now()");
    assert.equal(
      await countAudits(),
      beforeHeartbeat,
      "worker heartbeat does not flood configuration audit",
    );
    await db.exec("update venue_settings set max_duration_seconds=120");
    assert.equal(
      await countAudits(),
      beforeHeartbeat + 1,
      "real settings changes remain audited",
    );
    await db.query("insert into auth.users(id) values($1)", [admin]);
    await db.query("update profiles set role='admin' where id=$1", [admin]);
    await provisionLegacyFixtureMemberships(db);
    await db.query("insert into courts(id,name) values($1,'Court 1')", [court]);
    await db.query(
      "insert into browser_devices(id,name,court_id,enrollment_hash,enrollment_expires_at) values($1,'Tablet 1',$2,'enroll',now()+interval '10 minutes')",
      [device, court],
    );
    assert.deepEqual(
      (
        await db.query<any>(
          "select video_rotation,video_flip_horizontal,video_flip_vertical from browser_devices where id=$1",
          [device],
        )
      ).rows[0],
      {
        video_rotation: 0,
        video_flip_horizontal: false,
        video_flip_vertical: false,
      },
    );
    await db.query(
      "insert into browser_devices(name,court_id) values('Second tablet',$1)",
      [court],
    );
    assert.equal(
      (await db.query<{ count: number }>("select count(*)::int count from browser_devices where court_id=$1", [court])).rows[0].count,
      2,
      "multiple devices may be assigned to one court",
    );
    const enroll = async (hash = "enroll") =>
      (
        await db.query<{ id: string }>(
          "select enroll_browser($1,'token','setup',$2) id",
          [hash, admin],
        )
      ).rows[0].id;
    await assert.rejects(() => enroll("wrong"), /invalid or expired/);
    const kiosk = await enroll();
    await assert.rejects(() => enroll(), /invalid or expired/);
    const key = randomUUID();
    const start = async (k = key) =>
      (
        await db.query<{ id: string }>(
          "select browser_start($1,'player@gmail.com',$2) id",
          [kiosk, k],
        )
      ).rows[0].id;
    await assert.rejects(() => start(), /Test this tablet/);
    await db.query(
      "update browser_devices set tested_at=now(),video_device='usb-browser-id' where id=$1",
      [device],
    );
    const sid = await start();
    assert.equal(await start(), sid);
    await assert.rejects(() => start(randomUUID()), /previous recording/);
    await assert.rejects(
      () =>
        db.query("update browser_devices set enabled=false where id=$1", [
          device,
        ]),
      /Finish or recover/,
    );
    await assert.rejects(
      () =>
        db.query(
          "update browser_devices set video_device='different' where id=$1",
          [device],
        ),
      /Finish or recover/,
    );
    await assert.rejects(
      () =>
        db.query(
          "update browser_devices set video_rotation=90 where id=$1",
          [device],
        ),
      /Finish or recover/,
      "an active recording locks the recorded camera orientation",
    );
    const event = async (
      action: string,
      who = kiosk,
      bytes: number | null = null,
      mime: string | null = null,
    ) =>
      (
        await db.query<{ ok: boolean }>(
          "select browser_event($1,$2,$3,$4,$5) ok",
          [who, sid, action, bytes, mime],
        )
      ).rows[0].ok;
    assert.equal(await event("started", randomUUID()), false);
    assert.equal(await event("started"), true);
    assert.equal(await event("reset"), false);
    assert.equal(await event("stopped"), true);
    assert.equal(await event("stopped"), true, "stop timestamp is idempotent");
    const stopped = (
      await db.query<any>(
        "select status,started_at,stopped_at from recording_sessions where id=$1",
        [sid],
      )
    ).rows[0];
    assert.equal(stopped.status, "finalizing");
    assert.ok(stopped.started_at);
    assert.ok(stopped.stopped_at);
    assert.equal(await event("failed"), true);
    assert.equal(
      await event("saved", kiosk, 1024, "video/webm"),
      true,
      "interrupted footage can recover",
    );
    assert.equal(
      await event("saved", kiosk, 1024, "video/webm"),
      true,
      "retry does not duplicate files",
    );
    assert.equal(
      await event("saved", kiosk, 2048, "video/webm"),
      false,
      "cannot replace immutable bytes",
    );
    assert.equal(
      await event("reset"),
      false,
      "cannot abandon unfinished upload through reset",
    );
    await db.query(
      "update browser_recordings set drive_id='drive-video-123' where session_id=$1",
      [sid],
    );
    await db.query("select finish_browser_upload($1,'anyone-reader')", [sid]);
    await db.query("select finish_browser_upload($1,'anyone-reader')", [sid]);
    const files = await db.query<any>(
      "select * from recording_files where session_id=$1",
      [sid],
    );
    assert.equal(files.rows.length, 1);
    assert.equal(files.rows[0].status, "ready");
    assert.ok(files.rows[0].expires_at);
    await db.query("select report_browser_upload($1,$2,'failed',0)", [sid,device]);
    const completedQueue = await db.query<any>(
      "select upload_state,last_error from browser_recordings where session_id=$1", [sid],
    );
    assert.equal(completedQueue.rows[0].upload_state, "uploaded", "late failure cannot undo confirmed completion");
    assert.equal(completedQueue.rows[0].last_error, null);
    const claimed = await db.query<any>("select * from claim_browser_email_for_file($1)", [files.rows[0].id]);
    assert.equal(claimed.rows.length, 1);
    assert.equal(claimed.rows[0].recorder_id, null);
    assert.equal(
      (await db.query("select * from claim_browser_email()")).rows.length,
      0,
    );
    await db.exec(
      "update email_jobs set lease_until=now()-interval '1 second' where status='sending'",
    );
    await db.exec("select * from claim_browser_email()");
    assert.equal(
      (await db.query<any>("select status from email_jobs")).rows[0].status,
      "unknown",
      "ambiguous send is never automatically resent",
    );
    assert.equal(await event("reset"), true);
    // Native settings are tested by the assigned device, with revision checks.
    await db.query(
      "update browser_devices set recorder_mode='android_rtsp',rtsp_url='rtsp://192.168.1.100/stream1',rtsp_username='camera',rtsp_password_encrypted='encrypted-fixture',video_device='android-rtsp-v2' where id=$1",
      [device],
    );
    const revision = async () =>
      (
        await db.query<any>(
          "select config_revision from browser_devices where id=$1",
          [device],
        )
      ).rows[0].config_revision;
    let rev = await revision();
    const nativeTest = async (k: string, v: string, passed = true) =>
      (
        await db.query<any>("select native_camera_test($1,$2,$3) ok", [
          k,
          v,
          passed,
        ])
      ).rows[0].ok;
    assert.equal(await nativeTest(randomUUID(), rev), false);
    assert.equal(await nativeTest(kiosk, randomUUID()), false);
    assert.equal(await nativeTest(kiosk, rev), true);
    await db.query(
      "update browser_devices set test_requested=true where id=$1",
      [device],
    );
    const next = await revision();
    assert.notEqual(next, rev);
    assert.equal(
      await nativeTest(kiosk, rev),
      false,
      "stale test cannot approve new settings",
    );
    rev = next;
    assert.equal(await nativeTest(kiosk, rev, false), true);
    assert.equal(
      (
        await db.query<any>(
          "select tested_at from browser_devices where id=$1",
          [device],
        )
      ).rows[0].tested_at,
      null,
    );
    assert.equal(await nativeTest(kiosk, rev), true);
    await assert.rejects(
      () => start(randomUUID()),
      /configuration changed/,
      "old clients cannot start managed cameras without revision",
    );
    // Reset fixture rate limiting before starting the next match.
    await db.exec(
      "update recording_sessions set created_at=now()-interval '2 minutes'",
    );
    const nativeSession = (
      await db.query<any>(
        "select browser_start($1,'one@gmail.com',$2,$3,$4::jsonb) id",
        [
          kiosk,
          randomUUID(),
          rev,
          JSON.stringify([
            "one@gmail.com",
            "two@gmail.com",
            "three@gmail.com",
            "four@gmail.com",
          ]),
        ],
      )
    ).rows[0].id;
    assert.deepEqual(
      (
        await db.query<any>(
          "select configuration_snapshot->'recipient_emails' recipients from recording_sessions where id=$1",
          [nativeSession],
        )
      ).rows[0].recipients,
      ["one@gmail.com", "two@gmail.com", "three@gmail.com", "four@gmail.com"],
    );
    await assert.rejects(
      () =>
        db.query(
          "update browser_devices set rtsp_url='rtsp://192.168.1.200/stream1' where id=$1",
          [device],
        ),
      /Finish or recover/,
    );
    assert.equal(
      await nativeTest(kiosk, rev),
      false,
      "test result is rejected during capture",
    );
    await assert.rejects(
      () => db.query("delete from browser_devices where id=$1", [device]),
      /Finish or recover/,
      "an active recording prevents permanent device removal",
    );
    await db.query("select browser_event($1,$2,'failed')", [
      kiosk,
      nativeSession,
    ]);
    await db.query("select browser_event($1,$2,'reset')", [
      kiosk,
      nativeSession,
    ]);
    await db.query("delete from browser_devices where id=$1", [device]);
    assert.equal(
      (
        await db.query<any>(
          "select count(*)::int n from browser_recordings where device_id is null",
        )
      ).rows[0].n,
      2,
      "permanent device removal preserves historical recording logs",
    );
    await db.exec("set role anon");
    await assert.rejects(
      () => db.query("select * from browser_devices"),
      /permission denied/,
    );
    await assert.rejects(() => start(randomUUID()), /permission denied/);
    await assert.rejects(
      () => db.query("select * from claim_browser_email()"),
      /permission denied/,
    );
  } finally {
    await db.close();
  }
});

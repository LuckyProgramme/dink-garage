import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
test("capture requests enforce locks, privacy, snapshots, idempotency and terminal states", async () => {
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
    const player = randomUUID(),
      other = randomUUID(),
      court = randomUUID(),
      recorder = randomUUID(),
      camera = randomUUID(),
      key = randomUUID();
    await db.query("insert into auth.users(id) values($1),($2)", [
      player,
      other,
    ]);
    await db.query("insert into public.courts(id,name) values($1,'Court')", [
      court,
    ]);
    await db.query(
      "insert into public.recorders(id,name,paired_at,last_seen_at,ffmpeg_available,agent_version) values($1,'Recorder',now(),now(),true,'0.3.0')",
      [recorder],
    );
    await db.query(
      "insert into public.cameras(id,name,recorder_id,court_id,source_type,device_reference,is_primary,enabled,health,last_health_check_at) values($1,'Camera',$2,$3,'usb','usb-test',true,true,'online',now())",
      [camera, recorder, court],
    );
    async function start(who = player, k = key) {
      return (
        await db.query<{ id: string }>(
          "select public.start_capture($1,$2,$3,$4) as id",
          [who, "test@example.com", court, k],
        )
      ).rows[0].id;
    }
    await db.exec("update public.cameras set health='offline'");
    await assert.rejects(() => start(), /connection test/);
    await db.exec("update public.cameras set health='online',last_health_check_at=null");
    await assert.rejects(() => start(), /connection test/);
    await db.exec("update public.cameras set last_health_check_at=now()-interval '1 day'");
    await db.exec("update public.recorders set last_seen_at=now()-interval '46 seconds'");
    await assert.rejects(() => start(), /offline/);
    await db.exec("update public.recorders set last_seen_at=now()");
    const microphone = 'mic-123456789012345678901234';
    await db.query("update public.cameras set audio_source=$1", [microphone]);
    await assert.rejects(() => start(), /connection test/);
    await db.exec("update public.cameras set health='online',last_health_check_at=now()");
    await assert.rejects(() => start(), /offline or needs updating/);
    await db.exec("update public.recorders set agent_version='0.4.0'");
    const session = await start();
    assert.equal((await db.query<any>("select configuration_snapshot from public.recording_sessions where id=$1", [session])).rows[0].configuration_snapshot.audio_enabled, true);
    await assert.rejects(() => db.exec("update public.cameras set audio_source=''"), /cannot change during capture/);
    assert.equal(await start(), session);
    await assert.rejects(() => start(other, randomUUID()), /already recording/);
    await assert.rejects(() => start(player, randomUUID()), /active recording/);
    await db.exec("update public.venue_settings set max_duration_seconds=60");
    const jobs = await db.query<any>("select * from public.sync_captures($1)", [
      recorder,
    ]);
    const job = jobs.rows[0];
    assert.equal(job.audio_source, microphone, "audio selection is snapshotted for the worker");
    assert.equal(job.max_seconds, 900, "duration is snapshotted at start");
    assert.equal(
      (
        await db.query<any>("select * from public.sync_captures($1)", [
          recorder,
        ])
      ).rows[0].claim_token,
      job.claim_token,
      "reconnect retains the same capture identity",
    );
    await db.query(
      "insert into public.recorder_commands(recorder_id,kind) values($1,'discover')",
      [recorder],
    );
    assert.equal(
      (
        await db.query("select * from public.claim_recorder_command($1)", [
          recorder,
        ])
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query<any>("select public.stop_capture($1,$2) as ok", [
          other,
          session,
        ])
      ).rows[0].ok,
      false,
    );
    assert.equal(
      (
        await db.query<any>("select public.stop_capture($1,$2) as ok", [
          player,
          session,
        ])
      ).rows[0].ok,
      true,
    );
    async function report(state: string, token = job.claim_token, bytes = 100) {
      return (
        await db.query<any>(
          "select public.report_capture($1,$2,$3,$4,$5,$6) as ok",
          [
            recorder,
            session,
            token,
            state,
            state === "recording" ? "running" : "player_stop",
            bytes,
          ],
        )
      ).rows[0].ok;
    }
    assert.equal(await report("recording", randomUUID()), false);
    assert.equal(await report("recording"), true);
    await assert.rejects(
      () =>
        db.query("update public.cameras set enabled=false where id=$1", [
          camera,
        ]),
      /cannot change during capture/,
    );
    assert.equal(await report("finalizing"), true);
    assert.equal(await report("recording"), true);
    assert.equal(
      (
        await db.query<any>(
          "select status from public.recording_sessions where id=$1",
          [session],
        )
      ).rows[0].status,
      "finalizing",
    );
    await assert.rejects(
      () => report("local_ready", job.claim_token, 0),
      /empty/,
    );
    assert.equal(await report("local_ready"), true);
    assert.equal(await report("local_ready"), true);
    assert.equal(
      (await db.query("select * from public.recording_files")).rows.length,
      1,
    );
    await db.exec(
      `begin;set local role authenticated;set local request.jwt.claim.sub='${other}';`,
    );
    assert.equal(
      (await db.query("select * from public.recording_sessions")).rows.length,
      0,
    );
    assert.equal(
      (await db.query("select * from public.capture_jobs")).rows.length,
      0,
    );
    await assert.rejects(
      () =>
        db.query("select public.start_capture($1,$2,$3,$4)", [
          other,
          "test@example.com",
          court,
          randomUUID(),
        ]),
      /permission denied/,
    );
    await db.exec("rollback");
    const cancelled = await start(player, randomUUID());
    await db.query("select public.stop_capture($1,$2)", [player, cancelled]);
    assert.equal(
      (await db.query("select * from public.sync_captures($1)", [recorder]))
        .rows.length,
      0,
    );
    assert.equal(
      (
        await db.query<any>(
          "select status from public.recording_sessions where id=$1",
          [cancelled],
        )
      ).rows[0].status,
      "failed",
    );
  } finally {
    await db.close();
  }
});

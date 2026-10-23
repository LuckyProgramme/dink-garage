import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

test("all devices in a tenant share one global FIFO upload queue", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to authenticated,anon;
      alter default privileges in schema public grant all on tables to authenticated,anon;
      alter default privileges in schema public grant usage,select on sequences to authenticated;`);
    for (const file of (await readdir("supabase/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await db.exec(
        (await readFile(`supabase/migrations/${file}`, "utf8")).replace(
          "create extension if not exists pgcrypto;",
          "",
        ),
      );

    const admin = randomUUID();
    const courts = [randomUUID(), randomUUID()];
    const kiosks = [randomUUID(), randomUUID()];
    const devices = [randomUUID(), randomUUID()];
    const sessions = [randomUUID(), randomUUID(), randomUUID()];
    await db.query("insert into auth.users(id) values($1)", [admin]);
    await db.query(
      "insert into courts(id,name) values($1,'Court 1'),($2,'Court 2')",
      courts,
    );
    await db.query(
      "insert into kiosk_devices(id,token_hash,created_by) values($1,'queue-token-1',$3),($2,'queue-token-2',$3)",
      [kiosks[0], kiosks[1], admin],
    );
    await db.query(
      "insert into browser_devices(id,name,court_id,kiosk_id) values($1,'Tablet 1',$3,$4),($2,'Tablet 2',$3,$5)",
      [devices[0], devices[1], courts[0], kiosks[0], kiosks[1]],
    );
    await db.query(
      `insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email,stopped_at,created_at)
       values($1,$4,$6,gen_random_uuid(),'uploading','{}','one@gmail.com',now()-interval '2 minutes',now()-interval '5 minutes'),
             ($2,$5,$6,gen_random_uuid(),'uploading','{}','two@gmail.com',now()-interval '1 minute',now()-interval '4 minutes'),
             ($3,$4,$6,gen_random_uuid(),'uploading','{}','three@gmail.com',now()-interval '30 seconds',now()-interval '3 minutes')`,
      [sessions[0], sessions[1], sessions[2], kiosks[0], kiosks[1], courts[0]],
    );
    const files = await db.query<{ id: string }>(
      `insert into recording_files(session_id,status,bytes)
       values($1,'local_ready',1000),($2,'local_ready',1000),($3,'local_ready',1000) returning id`,
      sessions,
    );
    await db.query(
      `insert into browser_recordings(session_id,device_id,file_id,mime_type,bytes,upload_state,upload_queued_at,upload_updated_at)
       values($1,$4,$6,'video/mp4',1000,'pending',now()-interval '2 minutes',now()),
             ($2,$5,$7,'video/mp4',1000,'pending',now()-interval '1 minute',now()),
             ($3,$4,$8,'video/mp4',1000,'pending',now()-interval '30 seconds',now())`,
      [
        sessions[0],
        sessions[1],
        sessions[2],
        devices[0],
        devices[1],
        files.rows[0].id,
        files.rows[1].id,
        files.rows[2].id,
      ],
    );

    const turn = async (index: number, claim = true) =>
      (
        await db.query<any>(
          "select * from browser_upload_turn($1,$2,$3)",
          [sessions[index], devices[index === 1 ? 1 : 0], claim],
        )
      ).rows[0];
    const report = async (
      index: number,
      state: "uploading" | "failed" | "complete",
      bytes: number,
    ) =>
      (
        await db.query<{ ok: boolean }>(
          "select report_browser_upload($1,$2,$3,$4) ok",
          [sessions[index], devices[index === 1 ? 1 : 0], state, bytes],
        )
      ).rows[0].ok;

    // Every camera in the tenant shares one FIFO queue, ordered by queue time.
    const first = await turn(0);
    assert.equal(first.allowed, true);
    assert.equal(first.queue_position, 1);
    assert.equal(first.queue_total, 3);
    assert.equal(first.active_device_name, "Tablet 1");

    await db.query(
      "update browser_recordings set upload_updated_at=now()-interval '10 minutes',lease_until=null where session_id=$1",
      [sessions[1]],
    );
    const second = await turn(1);
    assert.equal(second.allowed, false, "cameras on the same court share one queue");
    assert.equal(second.queue_position, 2);
    assert.equal(second.queue_total, 3);
    assert.equal(second.active_device_name, "Tablet 1");
    const waiting = (
      await db.query<{ upload_state: string; fresh: boolean }>(
        "select upload_state,upload_updated_at>now()-interval '1 minute' fresh from browser_recordings where session_id=$1",
        [sessions[1]],
      )
    ).rows[0];
    assert.deepEqual(waiting, { upload_state: "pending", fresh: true },
      "polling the queue keeps an active waiter from being expired");

    const third = await turn(2);
    assert.equal(third.allowed, false);
    assert.equal(third.queue_position, 3);
    assert.equal(third.queue_total, 3);
    assert.equal(third.active_device_name, "Tablet 1");

    assert.equal(await report(0, "uploading", 400), true);
    assert.equal((await turn(2, false)).active_percent, 40);

    // A camera on another court still waits for the tenant-wide queue head.
    const otherCourt = courts[1];
    const otherKiosk = randomUUID();
    const otherDevice = randomUUID();
    const otherSession = randomUUID();
    await db.query(
      "insert into kiosk_devices(id,token_hash,created_by) values($1,'queue-token-3',$2)",
      [otherKiosk, admin],
    );
    await db.query(
      "insert into browser_devices(id,name,court_id,kiosk_id) values($1,'Tablet 3',$2,$3)",
      [otherDevice, otherCourt, otherKiosk],
    );
    await db.query(
      `insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email,stopped_at)
       values($1,$2,$3,gen_random_uuid(),'uploading','{}','other@gmail.com',now())`,
      [otherSession, otherKiosk, otherCourt],
    );
    const otherFile = await db.query<{ id: string }>(
      "insert into recording_files(session_id,status,bytes) values($1,'local_ready',1000) returning id",
      [otherSession],
    );
    await db.query(
      `insert into browser_recordings(session_id,device_id,file_id,mime_type,bytes,upload_state,upload_queued_at,upload_updated_at)
       values($1,$2,$3,'video/mp4',1000,'pending',now(),now())`,
      [otherSession, otherDevice, otherFile.rows[0].id],
    );
    const independent = (
      await db.query<any>("select * from browser_upload_turn($1,$2,true)", [
        otherSession,
        otherDevice,
      ])
    ).rows[0];
    assert.equal(independent.allowed, false, "a different court shares the global queue");
    assert.equal(independent.queue_position, 4);
    assert.equal(independent.queue_total, 4);
    assert.equal(independent.active_device_name, "Tablet 1");

    // When the court head fails, the next camera on that court takes over.
    assert.equal(await report(0, "failed", 400), true);
    const next = await turn(1);
    assert.equal(next.allowed, true, "a failed item does not block later videos");
    assert.equal(next.queue_position, 1);
    assert.equal(next.queue_total, 3);
    assert.equal(next.active_device_name, "Tablet 2");
    assert.equal(next.blocked_by_failure, false);

    assert.equal(await report(1, "complete", 1000), true);
    await db.query("update recording_sessions set status='ready' where id=$1", [
      sessions[1],
    ]);
    const last = await turn(2);
    assert.equal(last.allowed, true);
    assert.equal(last.queue_position, 1);
    assert.equal(last.queue_total, 2);
    assert.equal(last.active_device_name, "Tablet 1");
    assert.equal(await report(2, "complete", 1000), true);
    await db.query("update recording_sessions set status='ready' where id=$1", [
      sessions[2],
    ]);

    const otherTurn = (
      await db.query<any>("select * from browser_upload_turn($1,$2,true)", [
        otherSession,
        otherDevice,
      ])
    ).rows[0];
    assert.equal(otherTurn.allowed, true);
    assert.equal(otherTurn.queue_position, 1);
    assert.equal(otherTurn.queue_total, 1);
    assert.equal(otherTurn.active_device_name, "Tablet 3");
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select report_browser_upload($1,$2,'complete',1000) ok",
          [otherSession, otherDevice],
        )
      ).rows[0].ok,
      true,
    );
    await db.query("update recording_sessions set status='ready' where id=$1", [
      otherSession,
    ]);

    await db.query(
      "update kiosk_devices set current_session_id=$1 where id=$2",
      [sessions[0], kiosks[0]],
    );

    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select cancel_browser_upload($1,$2) ok",
          [sessions[0], devices[0]],
        )
      ).rows[0].ok,
      true,
    );
    const cancelled = await turn(0, false);
    assert.equal(cancelled.upload_state, "cancelled");
    assert.equal(cancelled.queue_position, 0);
    assert.deepEqual(
      (
        await db.query<{ status: string; failure_stage: string; current_session_id: string | null }>(
          `select s.status,s.failure_stage,k.current_session_id
           from recording_sessions s join kiosk_devices k on k.id=s.kiosk_id
           where s.id=$1`,
          [sessions[0]],
        )
      ).rows[0],
      {
        status: "failed",
        failure_stage: "upload_cancelled",
        current_session_id: null,
      },
      "cancelling an upload releases the tablet recording lock",
    );

    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select queue_browser_upload($1,$2) ok",
          [sessions[0], devices[0]],
        )
      ).rows[0].ok,
      true,
      "a cancelled local video can reopen its queue from the recording device",
    );

    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select retry_browser_upload($1,$2) ok",
          [sessions[0], devices[0]],
        )
      ).rows[0].ok,
      true,
      "retry is safe when local recovery already reopened the server queue",
    );
    const requeued = await turn(0, false);
    assert.equal(requeued.allowed, true);
    assert.equal(requeued.upload_state, "retrying");
    assert.equal(requeued.queue_position, 1);
    assert.equal(requeued.queue_total, 1);
    assert.equal(requeued.active_device_name, "Tablet 1");

    const retried = await turn(0);
    assert.equal(retried.allowed, true);
    assert.equal(retried.queue_position, 1);
    assert.equal(retried.active_device_name, "Tablet 1");

    await db.query(
      "update recording_sessions set started_at=now()-interval '30 seconds',stopped_at=now() where id=$1",
      [sessions[0]],
    );
    assert.equal(
      (
        await db.query<{ held: boolean }>(
          "select hold_short_browser_recording($1,$2,$3) held",
          [sessions[0], devices[0], 60000],
        )
      ).rows[0].held,
      false,
      "an exact one-minute recording remains uploadable",
    );
    assert.equal(
      (
        await db.query<{ held: boolean }>(
          "select hold_short_browser_recording($1,$2,$3) held",
          [sessions[0], devices[0], 30000],
        )
      ).rows[0].held,
      true,
    );
    const localOnly = await db.query<{
      status: string;
      failure_stage: string;
      upload_state: string;
    }>(
      `select s.status,s.failure_stage,b.upload_state
       from recording_sessions s join browser_recordings b on b.session_id=s.id
       where s.id=$1`,
      [sessions[0]],
    );
    assert.deepEqual(localOnly.rows[0], {
      status: "failed",
      failure_stage: "short_recording",
      upload_state: "local_only",
    });

    const legacyCourt = randomUUID(),
      legacyKiosk = randomUUID(),
      legacyDevice = randomUUID(),
      legacySession = randomUUID();
    await db.query("insert into courts(id,name) values($1,'Legacy Court')", [
      legacyCourt,
    ]);
    await db.query(
      "insert into kiosk_devices(id,token_hash,created_by) values($1,'legacy-token',$2)",
      [legacyKiosk, admin],
    );
    await db.query(
      "insert into browser_devices(id,name,court_id,kiosk_id) values($1,'Legacy Tablet',$2,$3)",
      [legacyDevice, legacyCourt, legacyKiosk],
    );
    await db.query(
      `insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email,stopped_at)
       values($1,$2,$3,gen_random_uuid(),'uploading','{}','legacy@gmail.com',now())`,
      [legacySession, legacyKiosk, legacyCourt],
    );
    const legacyFile = await db.query<{ id: string }>(
      "insert into recording_files(session_id,status,bytes) values($1,'local_ready',1000) returning id",
      [legacySession],
    );
    await db.query(
      `insert into browser_recordings(session_id,device_id,file_id,mime_type,bytes,upload_state,upload_queued_at)
       values($1,$2,$3,'video/webm',1000,'queued',now())`,
      [legacySession, legacyDevice, legacyFile.rows[0].id],
    );
    assert.equal(
      (
        await db.query<{ held: boolean }>(
          "select hold_unsupported_browser_recording($1,$2) held",
          [legacySession, legacyDevice],
        )
      ).rows[0].held,
      true,
    );
    const legacyLocal = await db.query<{
      status: string;
      failure_stage: string;
      upload_state: string;
    }>(
      `select s.status,s.failure_stage,b.upload_state
       from recording_sessions s join browser_recordings b on b.session_id=s.id
       where s.id=$1`,
      [legacySession],
    );
    assert.deepEqual(legacyLocal.rows[0], {
      status: "failed",
      failure_stage: "unsupported_format",
      upload_state: "local_only",
    });

    const interruptedSession = randomUUID();
    await db.query(
      `insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email,started_at,stopped_at)
       values($1,$2,$3,gen_random_uuid(),'requested','{}','recovery@gmail.com',now()-interval '65 seconds',now())`,
      [interruptedSession, kiosks[0], courts[0]],
    );
    await db.query(
      `insert into browser_recordings(session_id,device_id,upload_state,client_created_at,duration_ms,local_available)
       values($1,$2,'saved_locally',now(),65000,true)`,
      [interruptedSession, devices[0]],
    );
    await db.query(
      "update kiosk_devices set current_session_id=$1 where id=$2",
      [interruptedSession, kiosks[0]],
    );
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select browser_event($1,$2,'captured') ok",
          [kiosks[0], interruptedSession],
        )
      ).rows[0].ok,
      true,
      "a durable local capture releases the device before branding and upload",
    );
    assert.deepEqual(
      (
        await db.query<{ status: string; current_session_id: string | null }>(
          `select s.status,k.current_session_id from recording_sessions s
           join kiosk_devices k on k.id=s.kiosk_id where s.id=$1`,
          [interruptedSession],
        )
      ).rows[0],
      { status: "uploading", current_session_id: null },
    );
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select browser_event($1,$2,'saved',2000,'video/mp4') ok",
          [kiosks[0], interruptedSession],
        )
      ).rows[0].ok,
      true,
      "final branded bytes can be registered after the camera slot is released",
    );
    assert.equal(
      (
        await db.query<{ held: boolean }>(
          "select hold_short_browser_recording($1,$2,65000) held",
          [interruptedSession, devices[0]],
        )
      ).rows[0].held,
      false,
      "interrupted footage over one minute remains eligible for upload",
    );
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select queue_browser_upload($1,$2) ok",
          [interruptedSession, devices[0]],
        )
      ).rows[0].ok,
      true,
    );
    assert.deepEqual(
      (
        await db.query<{ status: string; upload_state: string; local_available: boolean }>(
          `select s.status,b.upload_state,b.local_available
           from recording_sessions s join browser_recordings b on b.session_id=s.id
           where s.id=$1`,
          [interruptedSession],
        )
      ).rows[0],
      { status: "uploading", upload_state: "pending", local_available: true },
    );

    const stale = randomUUID();
    await db.query(`insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email)
      values($1,$2,$3,gen_random_uuid(),'recording','{}','stale@example.com')`, [stale,kiosks[0],courts[0]]);
    await db.query("insert into browser_recordings(session_id,device_id,upload_state,local_available) values($1,$2,'failed',true)", [stale,devices[0]]);
    await db.query("update kiosk_devices set current_session_id=$1 where id=$2", [stale,kiosks[0]]);
    assert.equal((await db.query<{ok:boolean}>("select cancel_browser_upload($1,$2) ok", [stale,devices[0]])).rows[0].ok, false,
      "a failed upload flag alone cannot cancel a live recording");
    // Administrator deletion overrides a live capture. The device/enrollment
    // disappears, while the interrupted session remains as failed history.
    const activeDevice = randomUUID(),
      activeKiosk = randomUUID(),
      activeSession = randomUUID();
    await db.query(
      "insert into kiosk_devices(id,token_hash,created_by) values($1,'active-delete-token',$2)",
      [activeKiosk, admin],
    );
    await db.query(
      "insert into browser_devices(id,name,court_id,kiosk_id) values($1,'Active Tablet',$2,$3)",
      [activeDevice, courts[0], activeKiosk],
    );
    await db.query(
      `insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email)
       values($1,$2,$3,gen_random_uuid(),'recording',$4,'active-delete@example.com')`,
      [
        activeSession,
        activeKiosk,
        courts[0],
        JSON.stringify({ capture_mode: "browser", device_id: activeDevice }),
      ],
    );
    await db.query(
      "insert into browser_recordings(session_id,device_id,upload_state,local_available) values($1,$2,'idle',true)",
      [activeSession, activeDevice],
    );
    await db.query("update kiosk_devices set current_session_id=$1 where id=$2", [activeSession, activeKiosk]);
    assert.equal(
      (await db.query<{ok:boolean}>("select remove_browser_device($1,$2) ok", [activeDevice, admin])).rows[0].ok,
      true,
      "an active recording does not block administrator deletion",
    );
    assert.deepEqual(
      (await db.query("select status,failure_stage from recording_sessions where id=$1", [activeSession])).rows[0],
      {status:'failed',failure_stage:'device_removed'},
    );
    assert.deepEqual(
      (await db.query("select device_id,upload_state,lease_token,lease_until from browser_recordings where session_id=$1", [activeSession])).rows[0],
      {device_id:null,upload_state:'cancelled',lease_token:null,lease_until:null},
    );
    assert.deepEqual(
      (await db.query("select active,current_session_id from kiosk_devices where id=$1", [activeKiosk])).rows[0],
      {active:false,current_session_id:null},
    );
    await db.query("update recording_sessions set status='finalizing',stopped_at=now() where id=$1", [stale]);
    assert.equal((await db.query<{ok:boolean}>("select cancel_browser_upload($1,$2) ok", [stale,devices[1]])).rows[0].ok, false);
    assert.equal((await db.query<{ok:boolean}>("select cancel_browser_upload($1,$2) ok", [stale,devices[0]])).rows[0].ok, true);
    assert.deepEqual((await db.query("select status,failure_stage from recording_sessions where id=$1", [stale])).rows[0],
      {status:'failed',failure_stage:'upload_cancelled'});
    assert.equal((await db.query<{current_session_id:string|null}>("select current_session_id from kiosk_devices where id=$1", [kiosks[0]])).rows[0].current_session_id, null);
    // Permanent deletion still cleans up an ended failed finalizer.
    await db.query("update recording_sessions set status='finalizing' where id=$1", [stale]);
    await db.query("update browser_recordings set upload_state='failed' where session_id=$1", [stale]);

    // It also cancels an active upload and releases its lease without requiring
    // a separate cancellation action first.
    const deletingUpload = randomUUID();
    await db.query(`insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email,stopped_at)
      values($1,$2,$3,gen_random_uuid(),'uploading','{}','delete-upload@example.com',now())`, [deletingUpload,kiosks[0],courts[0]]);
    await db.query("insert into browser_recordings(session_id,device_id,upload_state,local_available,lease_token,lease_until) values($1,$2,'uploading',true,gen_random_uuid(),now()+interval '3 minutes')", [deletingUpload,devices[0]]);

    const nextAfterDelete = randomUUID();
    await db.query(`insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email,stopped_at)
      values($1,$2,$3,gen_random_uuid(),'uploading','{}','next-after-delete@example.com',now())`, [nextAfterDelete,kiosks[1],courts[0]]);
    const nextAfterDeleteFile = (await db.query<{id:string}>("insert into recording_files(session_id,status,bytes) values($1,'local_ready',1000) returning id", [nextAfterDelete])).rows[0].id;
    await db.query("insert into browser_recordings(session_id,device_id,file_id,mime_type,bytes,upload_state,upload_queued_at,local_available) values($1,$2,$3,'video/mp4',1000,'pending',now()+interval '1 minute',true)", [nextAfterDelete,devices[1],nextAfterDeleteFile]);

    assert.equal((await db.query<{ok:boolean}>("select remove_browser_device($1,$2) ok", [devices[0],admin])).rows[0].ok, true);
    assert.deepEqual((await db.query("select device_id,local_available,upload_state,lease_token,lease_until from browser_recordings where session_id=$1", [deletingUpload])).rows[0],
      {device_id:null,local_available:true,upload_state:'cancelled',lease_token:null,lease_until:null});
    assert.deepEqual((await db.query("select status,failure_stage from recording_sessions where id=$1", [deletingUpload])).rows[0],
      {status:'failed',failure_stage:'device_removed'});
    assert.deepEqual((await db.query("select s.status,s.failure_stage,b.device_id,b.upload_state from recording_sessions s join browser_recordings b on b.session_id=s.id where s.id=$1", [stale])).rows[0],
      {status:'failed',failure_stage:'upload_cancelled',device_id:null,upload_state:'cancelled'});
    assert.equal((await db.query<{active:boolean}>("select active from kiosk_devices where id=$1", [kiosks[0]])).rows[0].active, false);
    assert.equal((await db.query<{allowed:boolean}>("select allowed from browser_upload_turn($1,$2,true)", [nextAfterDelete,devices[1]])).rows[0].allowed, true,
      "deleting the active uploading device releases the global queue immediately");

    await db.query("delete from courts where id=$1", [courts[0]]);
    assert.equal(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from recording_sessions where id=any($1) and court_id is null",
          [sessions],
        )
      ).rows[0].count,
      3,
      "completed, failed, and uploading history does not block device or court removal",
    );
  } finally {
    await db.close();
  }
});

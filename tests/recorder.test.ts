import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { inventoryInput, tokenHash } from "../lib/recorder-protocol";

test("inventory strips local credentials, rejects duplicates, and limits payloads", () => {
  const device = {
    device_reference: "usb-1",
    name: "Webcam",
    source_type: "usb",
    health: "online",
    diagnostic: "connected",
    audio_sources: [{device_reference: "mic-123456789012345678901234", name: "Camera microphone", input: "@private-windows-path"}],
    password: "local-only",
    stream: "rtsp://private",
  };
  assert.deepEqual(Object.keys(inventoryInput([device])[0]).sort(), [
    "audio_source",
    "audio_sources",
    "device_reference",
    "diagnostic",
    "health",
    "name",
    "source_type",
  ]);
  assert.deepEqual(inventoryInput([device])[0].audio_sources, [{device_reference: "mic-123456789012345678901234", name: "Camera microphone"}]);
  assert.throws(() => inventoryInput([{...device, audio_sources: [{device_reference: "file:///private", name: "Mic"}]}]));
  assert.throws(() => inventoryInput([device, device]));
  assert.throws(() => inventoryInput(Array(65).fill(device)));
  assert.throws(() =>
    inventoryInput([{ ...device, device_reference: "rtsp://secret" }]),
  );
  assert.equal(tokenHash("token").length, 64);
});
test("recorder pairing, leases, result isolation, RLS and stale health", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to authenticated,anon;
      alter default privileges in schema public grant all on tables to authenticated,anon;
      alter default privileges in schema public grant usage,select on sequences to authenticated;`);
    for (const name of (await readdir("supabase/migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await db.exec(
        (await readFile(`supabase/migrations/${name}`, "utf8")).replace(
          "create extension if not exists pgcrypto;",
          "",
        ),
      );
    const r = "30000000-0000-4000-8000-000000000001",
      other = "30000000-0000-4000-8000-000000000002",
      player = "10000000-0000-4000-8000-000000000001",
      court = "20000000-0000-4000-8000-000000000001";
    await db.exec(`insert into auth.users(id) values('${player}');insert into public.recorders(id,name) values('${r}','Recorder'),('${other}','Other');insert into public.courts(id,name) values('${court}','Court');
      insert into public.cameras(name,recorder_id,court_id,source_type,device_reference,is_primary,enabled) values('Camera','${r}','${court}','usb','usb-1',true,true);
      select public.issue_recorder_pair('${r}','pair',now()+interval '10 minutes');`);
    async function value(sql: string, args: unknown[] = []) {
      return Object.values((await db.query(sql, args)).rows[0] as object)[0];
    }
    assert.equal(
      await value("select public.redeem_recorder_pair($1,$2)", [
        "pair",
        "token",
      ]),
      r,
    );
    assert.equal(
      await value("select public.redeem_recorder_pair($1,$2)", [
        "pair",
        "stolen",
      ]),
      null,
    );
    await db.exec(
      `select public.issue_recorder_pair('${r}','expired',now()-interval '1 second')`,
    );
    assert.equal(
      await value("select public.redeem_recorder_pair($1,$2)", [
        "expired",
        "stolen",
      ]),
      null,
    );
    assert.equal(
      await value(
        "select token_hash from public.recorder_credentials where recorder_id=$1",
        [r],
      ),
      "token",
    );
    const device = {
      device_reference: "usb-1",
      name: "Webcam",
      source_type: "usb",
      health: "online",
      diagnostic: "connected",
      audio_source: "",
    };
    async function queue(kind: string) {
      await db.query(
        "insert into public.recorder_commands(recorder_id,kind,device_reference) values($1,$2,$3)",
        [r, kind, kind === "test" ? "usb-1" : ""],
      );
      return (
        await db.query<any>("select * from public.claim_recorder_command($1)", [
          r,
        ])
      ).rows[0];
    }
    const finish = (
      job: any,
      recorder = r,
      devices = [device],
      success = true,
    ) =>
      value("select public.finish_recorder_command($1,$2,$3,$4,$5)", [
        recorder,
        job.id,
        job.lease_token,
        success,
        JSON.stringify(devices),
      ]);
    let job = await queue("discover");
    assert.equal(
      await finish(job, other),
      false,
      "another recorder cannot complete a command",
    );
    assert.equal(await finish(job), true);
    assert.equal(
      await value("select health from public.recorder_devices"),
      "unknown",
      "discovery cannot claim a feed works",
    );
    assert.equal(await finish(job), false, "completion cannot replay");
    job = await queue("test");
    await assert.rejects(() => finish(job, r, []), /one test result/);
    await assert.rejects(
      () => finish(job, r, [{ ...device, device_reference: "usb-other" }]),
      /Wrong device/,
    );
    assert.equal(await finish(job), true);
    await db.exec(
      `update public.recorders set last_seen_at=now(),agent_version='0.3.0' where id='${r}';set request.jwt.claim.sub='${player}';`,
    );
    assert.equal(
      await value("select camera_status from public.player_court_status()"),
      "online",
    );
    await db.exec(
      `update public.recorders set last_seen_at=now()-interval '46 seconds' where id='${r}'`,
    );
    assert.equal(
      await value("select camera_status from public.player_court_status()"),
      "offline",
    );
    await db.exec(
      `update public.recorders set last_seen_at=now() where id='${r}';update public.cameras set last_health_check_at=now()-interval '6 minutes'`,
    );
    assert.equal(
      await value("select camera_status from public.player_court_status()"),
      "online",
      "a past successful check remains valid with a connected recorder",
    );
    await db.exec("update public.cameras set health='offline'");
    assert.equal(
      await value("select camera_status from public.player_court_status()"),
      "offline",
      "a failed check still blocks recording",
    );
    job = await queue("test");
    await db.exec(
      `update public.recorder_commands set lease_until=now()-interval '1 second' where id='${job.id}'`,
    );
    const retried = (
      await db.query<any>("select * from public.claim_recorder_command($1)", [
        r,
      ])
    ).rows[0];
    assert.equal(retried.attempts, 2);
    assert.equal(
      await finish(job),
      false,
      "stale lease cannot overwrite newer work",
    );
    assert.equal(await finish(retried), true);
    await db.exec("update public.cameras set audio_source='mic-123456789012345678901234'");
    job = await queue("test");
    assert.equal(await finish(job), true);
    assert.equal(await value("select health from public.cameras"), "unknown", "a test of the previous audio setting cannot validate the new selection");
    job = await queue("test");
    assert.equal(await finish(job, r, [{...device, audio_source: "mic-123456789012345678901234"}]), true);
    assert.equal(await value("select health from public.cameras"), "online");
    await db.exec("update public.cameras set device_reference='usb-changed'");
    assert.equal(
      await value("select health from public.cameras"),
      "unknown",
      "moving a device invalidates its old health",
    );
    await db.exec("begin;set local role authenticated;");
    assert.equal(
      (await db.query("select * from public.recorder_devices")).rows.length,
      0,
    );
    assert.equal(
      (await db.query("select * from public.recorder_commands")).rows.length,
      0,
    );
    await assert.rejects(
      () => db.query("select * from public.recorder_credentials"),
      /permission denied/,
    );
    await db.exec("rollback;begin;set local role authenticated;");
    await assert.rejects(
      () => db.query("select public.claim_recorder_command($1)", [r]),
      /permission denied/,
    );
    await db.exec("rollback");
    await db.query("select public.revoke_recorder($1,null)", [r]);
    assert.equal(
      await value("select count(*)::int from public.recorder_credentials"),
      0,
    );
    assert.equal(
      await value("select paired_at from public.recorders where id=$1", [r]),
      null,
    );
  } finally {
    await db.close();
  }
});

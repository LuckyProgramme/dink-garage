import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("migrations enforce roles, session privacy, primary-camera uniqueness, and hardware trust", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
      create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
      grant usage on schema public, auth to authenticated, anon;
      grant execute on function auth.uid() to authenticated;
      alter default privileges in schema public grant all on tables to authenticated, anon;
      alter default privileges in schema public grant usage, select on sequences to authenticated;`);
    for (const name of (await readdir("supabase/migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = (
        await readFile(`supabase/migrations/${name}`, "utf8")
      ).replace("create extension if not exists pgcrypto;", "");
      await db.exec(sql);
    }
    const admin = "10000000-0000-4000-8000-000000000001";
    const player = "10000000-0000-4000-8000-000000000002";
    const other = "10000000-0000-4000-8000-000000000003";
    const court = "20000000-0000-4000-8000-000000000001";
    const recorder = "30000000-0000-4000-8000-000000000001";
    await db.exec(`insert into auth.users(id,raw_user_meta_data) values ('${admin}','{}'),('${player}','{"role":"admin"}'),('${other}','{}');
      update public.profiles set role='admin' where id='${admin}';
      insert into public.courts(id,name) values('${court}','Court 01');
      insert into public.recorders(id,name) values('${recorder}','Venue PC');
      insert into public.recording_sessions(player_id,court_id,idempotency_key,configuration_snapshot,recipient_email,status)
        values('${player}','${court}',gen_random_uuid(),'{}','player@example.com','ready'),('${other}','${court}',gen_random_uuid(),'{}','other@example.com','ready');`);
    async function asUser<T>(id: string, work: () => Promise<T>) {
      await db.exec(
        `begin; set local role authenticated; set local request.jwt.claim.sub='${id}';`,
      );
      try {
        return await work();
      } finally {
        await db.exec("rollback");
      }
    }
    await asUser(player, async () => {
      const profiles = await db.query<{ role: string }>(
        "select role from public.profiles",
      );
      assert.equal(profiles.rows.length, 1);
      assert.equal(
        profiles.rows[0].role,
        "player",
        "metadata must not grant admin",
      );
      const sessions = await db.query<{ recipient_email: string }>(
        "select recipient_email from public.recording_sessions",
      );
      assert.deepEqual(sessions.rows, [
        { recipient_email: "player@example.com" },
      ]);
      assert.equal(
        (await db.query("select * from public.cameras")).rows.length,
        0,
      );
      const result = await db.query(
        "update public.profiles set role='admin' returning id",
      );
      assert.equal(result.rows.length, 0);
    });
    await assert.rejects(
      asUser(player, () =>
        db.exec(
          "insert into public.courts(name,location,active) values('Forbidden','',true)",
        ),
      ),
      /row-level security/,
    );
    await asUser(admin, async () => {
      await db.exec(
        "insert into public.courts(name,location,active) values('Court 02','Garden',true)",
      );
      await db.exec(
        "update public.venue_settings set max_duration_seconds=1200,retention_seconds=7200,venue_time_zone='Asia/Manila'",
      );
      assert.equal(
        (await db.query("select * from public.recording_sessions")).rows.length,
        2,
      );
      assert.ok(
        (await db.query("select * from public.audit_events")).rows.length >= 2,
      );
    });
    await assert.rejects(
      asUser(admin, () =>
        db.exec("update public.venue_settings set max_duration_seconds=0"),
      ),
      /check constraint/,
    );
    await assert.rejects(
      asUser(admin, () =>
        db.exec(
          "update public.venue_settings set venue_time_zone='Invalid/Zone'",
        ),
      ),
      /Invalid venue time zone/,
    );
    await assert.rejects(
      asUser(admin, () =>
        db.exec(
          `insert into public.cameras(name,recorder_id,source_type,device_reference,health) values('Fake','${recorder}','usb','usb1','online')`,
        ),
      ),
      /permission denied/,
    );
    await asUser(admin, async () => {
      await db.exec(
        `insert into public.cameras(name,recorder_id,court_id,source_type,device_reference,is_primary,enabled) values('Primary','${recorder}','${court}','usb','usb1',true,true)`,
      );
      assert.equal(
        (
          await db.query<{ health: string }>(
            "select health from public.cameras",
          )
        ).rows[0].health,
        "unknown",
      );
    });
    await assert.rejects(
      asUser(admin, async () => {
        await db.exec(
          `insert into public.cameras(name,recorder_id,court_id,source_type,device_reference,is_primary,enabled) values('A','${recorder}','${court}','usb','usb1',true,true),('B','${recorder}','${court}','usb','usb2',true,true)`,
        );
      }),
      /unique constraint/,
    );
    const busyCourt = "20000000-0000-4000-8000-000000000002";
    await db.exec(`insert into public.courts(id,name) values('${busyCourt}','Busy Court');
      insert into public.recording_sessions(player_id,court_id,idempotency_key,configuration_snapshot,recipient_email,status)
      values('${player}','${busyCourt}',gen_random_uuid(),'{}','busy@example.com','recording');`);
    await assert.rejects(
      asUser(admin, () =>
        db.exec(`delete from public.courts where id='${busyCourt}'`),
      ),
      /Stop the active recording before removing this court/,
    );
    await db.exec(
      `update public.recording_sessions set status='local_ready',stopped_at=now()
       where court_id='${busyCourt}'`,
    );
    await asUser(admin, async () => {
      await db.exec(`delete from public.courts where id='${busyCourt}'`);
      const stoppedHistory = await db.query<{
        court_id: string | null;
        court_name: string | null;
      }>(
        `select court_id,configuration_snapshot->>'court_name' as court_name
         from public.recording_sessions
         where recipient_email='busy@example.com'`,
      );
      assert.deepEqual(stoppedHistory.rows[0], {
        court_id: null,
        court_name: "Busy Court",
      });
    });
    await db.exec(
      `insert into public.cameras(name,recorder_id,court_id,source_type,device_reference,enabled)
       values('Court delete test','${recorder}','${court}','usb','court-delete-test',true)`,
    );
    await asUser(admin, async () => {
      await db.exec(`delete from public.courts where id='${court}'`);
      const history = await db.query<{
        court_id: string | null;
        court_name: string | null;
      }>(
        `select court_id,configuration_snapshot->>'court_name' as court_name
         from public.recording_sessions
         where recipient_email in ('player@example.com','other@example.com')`,
      );
      assert.equal(history.rows.length, 2);
      assert.ok(
        history.rows.every(
          (session) =>
            session.court_id === null && session.court_name === "Court 01",
        ),
        "court deletion keeps historical log labels while detaching the foreign key",
      );
      assert.equal(
        (
          await db.query<{ court_id: string | null }>(
            "select court_id from public.cameras where device_reference='court-delete-test'",
          )
        ).rows[0].court_id,
        null,
      );
    });
    await db.exec(
      `update public.profiles set active=false where id='${admin}'`,
    );
    await asUser(admin, async () => {
      assert.equal(
        (await db.query<{ is_admin: boolean }>("select public.is_admin()"))
          .rows[0].is_admin,
        false,
      );
    });
    await db.exec("begin; set local role anon;");
    assert.equal(
      (await db.query("select * from public.profiles")).rows.length,
      0,
    );
    await db.exec("rollback");
  } finally {
    await db.close();
  }
});

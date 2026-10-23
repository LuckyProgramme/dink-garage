import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { DEFAULT_TENANT_ID, TENANT_HEADER } from "../lib/tenant-scope";

test("an authorized administrator can add a court when auth schema access is unavailable to the executor", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
      create table auth.users(id uuid primary key, email text unique, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
      grant usage on schema public, auth to authenticated, anon;
      grant execute on function auth.uid() to authenticated;
      alter default privileges in schema public grant all on tables to authenticated, anon;
      alter default privileges in schema public grant usage, select on sequences to authenticated;`);
    for (const name of (await readdir("supabase/migrations"))
      .filter((entry) => entry.endsWith(".sql"))
      .sort()) {
      const sql = (await readFile(`supabase/migrations/${name}`, "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      );
      await db.exec(sql);
    }
    const admin = randomUUID();
    await db.query("insert into auth.users(id,email) values($1,$2)", [
      admin,
      "venue-admin@example.test",
    ]);
    await db.query("update public.profiles set role='admin' where id=$1", [admin]);
    await db.query(
      "insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,'admin')",
      [DEFAULT_TENANT_ID, admin],
    );
    // Hosted Supabase owns auth.* as supabase_admin. Reproduce that boundary:
    // the executor must still be able to write the audit row for a court insert.
    await db.exec("revoke usage on schema auth from dinkvision_executor");
    await db.query(
      "select set_config('request.jwt.claim.sub',$1,false), set_config('request.headers',$2,false)",
      [admin, JSON.stringify({ [TENANT_HEADER]: DEFAULT_TENANT_ID })],
    );
    await db.exec("set role authenticated");
    const created = await db.query<{
      id: string;
      tenant_id: string;
      location_id: string;
    }>(
      "insert into public.courts(name,location,active) values('Court 2','Garden Side',true) returning id,tenant_id,location_id",
    );
    assert.equal(created.rows[0].tenant_id, DEFAULT_TENANT_ID);
    assert.ok(created.rows[0].location_id);
    await assert.rejects(
      () =>
        db.query(
          "insert into public.courts(name,location,active) values('Court 2','Garden Side',true)",
        ),
      /duplicate key|unique constraint/i,
    );
    await db.exec("reset role");
    const audit = await db.query<{
      actor_id: string;
      tenant_id: string;
      action: string;
    }>(
      "select actor_id,tenant_id,action from public.audit_events where action='insert.courts' order by created_at desc limit 1",
    );
    assert.deepEqual(audit.rows[0], {
      actor_id: admin,
      tenant_id: DEFAULT_TENANT_ID,
      action: "insert.courts",
    });
    const location = await db.query<{ name: string; tenant_id: string }>(
      "select name,tenant_id from public.locations where id=$1",
      [created.rows[0].location_id],
    );
    assert.deepEqual(location.rows[0], {
      name: "Garden Side",
      tenant_id: DEFAULT_TENANT_ID,
    });
  } finally {
    await db.close();
  }
});

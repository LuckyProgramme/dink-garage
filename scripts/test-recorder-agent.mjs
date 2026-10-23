// Exercises the actual local process with disposable cloud fixtures. Enumerates
// devices only: never requests a connection test or reads camera frames.
import assert from "node:assert/strict";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const root = resolve(".local"),
  home = join(root, `agent-qa-${randomUUID()}`);
const base = process.env.TEST_APP_URL || "http://127.0.0.1:3000";
let recorder, child;
try {
  const created = await db
    .from("recorders")
    .insert({ name: `Temporary agent QA ${Date.now()}` })
    .select("id")
    .single();
  assert.equal(created.error, null);
  recorder = created.data.id;
  const code = `cbpair_${randomBytes(32).toString("base64url")}`;
  const issued = await db.rpc("issue_recorder_pair", {
    p_recorder_id: recorder,
    p_hash: createHash("sha256").update(code).digest("hex"),
    p_expires: new Date(Date.now() + 600000).toISOString(),
  });
  assert.equal(issued.error, null);
  const paired = await fetch(`${base}/api/recorder/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  assert.equal(paired.status, 200);
  const credentials = await paired.json();
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      url: base,
      token: credentials.token,
      recorderId: recorder,
      devices: [],
    }),
    { mode: 0o600 },
  );
  const queued = await db
    .from("recorder_commands")
    .insert({ recorder_id: recorder, kind: "discover" })
    .select("id")
    .single();
  assert.equal(queued.error, null);
  child = spawn(process.execPath, ["recorder/cli.mjs", "start"], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, CASA_RECORDER_HOME: home },
  });
  let completed = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(2000);
    const result = await db
      .from("recorder_commands")
      .select("status,result_code")
      .eq("id", queued.data.id)
      .single();
    assert.equal(result.error, null);
    if (result.data.status === "failed")
      throw new Error("Actual agent discovery failed.");
    if (result.data.status === "succeeded") {
      completed = true;
      break;
    }
    if (child.exitCode !== null)
      throw new Error("Local agent exited before completion.");
  }
  assert.ok(
    completed,
    "Agent must finish and acknowledge discovery within 40 seconds",
  );
  const devices = await db
    .from("recorder_devices")
    .select("health")
    .eq("recorder_id", recorder);
  assert.equal(devices.error, null);
  assert.ok(devices.data.every((d) => d.health === "unknown"));
  console.log(
    `PASS: actual recorder paired, heartbeated, discovered ${devices.data.length} device(s), and delivered results. No camera frames were read.`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  if (recorder) {
    const audit = await db
      .from("audit_events")
      .delete()
      .contains("safe_detail", { recorder_id: recorder });
    const configAudit = await db
      .from("audit_events")
      .delete()
      .contains("safe_detail", { entity_id: recorder });
    const removed = await db.from("recorders").delete().eq("id", recorder);
    if (audit.error || configAudit.error || removed.error) {
      console.error("Temporary recorder cleanup failed.");
      process.exitCode = 1;
    }
  }
  // Only this script's uniquely named directory inside the resolved local root.
  if (home.startsWith(root + "\\") || home.startsWith(root + "/"))
    await rm(home, { recursive: true, force: true });
}

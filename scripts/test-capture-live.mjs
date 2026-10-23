// Explicit hardware verification. Saves a short clip under the supplied player's
// account. Invoke with a local credentials JSON file and the exact court name.
import { readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { run } from "../recorder/hardware.mjs";
const base = process.env.TEST_APP_URL || "http://127.0.0.1:3000";
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const credentials = JSON.parse(await readFile(process.argv[2], "utf8"));
let session, other, cookie;
async function send(body, authCookie = cookie) {
  const response = await fetch(base + "/api/recordings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      Cookie: authCookie || "",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function login(email, password) {
  const response = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}
async function waitFor(read, predicate, label) {
  for (let i = 0; i < 30; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(1000);
  }
  throw new Error(`Timed out: ${label}`);
}
const readSession = async () => {
  const r = await db
    .from("recording_sessions")
    .select("status,stop_reason")
    .eq("id", session)
    .single();
  if (r.error) throw r.error;
  return r.data;
};
try {
  assert.ok(process.argv[3], "Supply the exact court name");
  const court = await db
    .from("courts")
    .select("id")
    .eq("name", process.argv[3])
    .single();
  assert.equal(court.error, null);
  const camera = await db
    .from("cameras")
    .select("id,recorder_id,device_reference,audio_source")
    .eq("court_id", court.data.id)
    .eq("is_primary", true)
    .eq("enabled", true)
    .single();
  assert.equal(camera.error, null);
  const queued = await db
    .from("recorder_commands")
    .insert({
      recorder_id: camera.data.recorder_id,
      kind: "test",
      device_reference: camera.data.device_reference,
    })
    .select("id")
    .single();
  assert.equal(queued.error, null);
  await waitFor(
    async () => {
      const r = await db
        .from("recorder_commands")
        .select("status")
        .eq("id", queued.data.id)
        .single();
      return r.data;
    },
    (r) => r?.status === "succeeded",
    "camera check",
  );
  cookie = await login(credentials.email, credentials.password);
  const key = randomUUID();
  const start = await send({ action: "start", court_id: court.data.id, key });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  session = start.body.id;
  const retry = await send({ action: "start", court_id: court.data.id, key });
  assert.equal(retry.body.id, session);
  const otherEmail = `capture-qa-${Date.now()}@example.com`,
    password = randomBytes(24).toString("base64url");
  const created = await db.auth.admin.createUser({
    email: otherEmail,
    password,
    email_confirm: true,
  });
  assert.equal(created.error, null);
  other = created.data.user.id;
  const otherCookie = await login(otherEmail, password);
  assert.equal(
    (
      await send(
        { action: "start", court_id: court.data.id, key: randomUUID() },
        otherCookie,
      )
    ).status,
    409,
  );
  assert.equal(
    (await send({ action: "stop", id: session }, otherCookie)).status,
    409,
  );
  const privateStatus = await fetch(base + "/api/recordings", {
    headers: { Cookie: otherCookie },
  });
  const otherData = await privateStatus.json();
  assert.ok(!otherData.sessions.some((s) => s.id === session));
  await waitFor(
    readSession,
    (r) => r.status === "recording",
    "camera recording",
  );
  console.log(
    "Real camera recording started. Checking recorder restart recovery.",
  );
  // Only stop the identified control process. Its independent capture worker stays alive.
  const stopped = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$recorderProcessId=[int](Get-Content .local/recorder/agent.lock); $recorderProcess=Get-CimInstance Win32_Process | Where-Object ProcessId -eq $recorderProcessId; if($recorderProcess.Name -eq 'node.exe' -and $recorderProcess.CommandLine -like '*recorder*cli.mjs*start*'){Stop-Process -Id $recorderProcessId}else{throw 'Recorder identity mismatch'}`,
    ],
    { windowsHide: true, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(stopped.status, 0, "Recorder stop must succeed");
  const restarted = spawn(process.execPath, ["recorder/cli.mjs", "start"], {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  restarted.unref();
  await delay(3000);
  assert.equal((await send({ action: "stop", id: session })).status, 200);
  const final = await waitFor(
    readSession,
    (r) => ["local_ready", "failed"].includes(r.status),
    "finalization",
  );
  assert.equal(final.status, "local_ready");
  assert.equal(final.stop_reason, "player_stop");
  const file = await db
    .from("recording_files")
    .select("local_filename,bytes")
    .eq("session_id", session)
    .single();
  assert.equal(file.error, null);
  const video = resolve(".local/recorder/captures", file.data.local_filename);
  assert.ok((await stat(video)).size > 0);
  assert.ok(
    (
      await run(
        ["-nostdin", "-v", "error", "-i", video, "-f", "null", "-"],
        30000,
      )
    ).ok,
    "Saved clip must decode fully",
  );
  const audioDecoded = await run(["-nostdin", "-v", "error", "-i", video, "-map", "0:a:0", "-f", "null", "-"], 30000);
  assert.equal(audioDecoded.ok, !!camera.data.audio_source, "Saved audio must match the camera setting");
  console.log(
    `PASS: real webcam capture, duplicate start, second-player exclusion, private status, recorder restart, manual stop, and full MP4 decode. Saved locally: ${video}`,
  );
} finally {
  if (session && cookie)
    await send({ action: "stop", id: session }).catch(() => {});
  if (other) {
    const removed = await db.auth.admin.deleteUser(other);
    if (removed.error) console.error("Temporary player cleanup failed.");
  }
}

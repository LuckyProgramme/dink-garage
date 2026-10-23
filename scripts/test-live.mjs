// Explicit integration verification: creates and removes only its own test fixtures.
// Never sends email, touches cameras, or changes global venue settings.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
const base = process.env.TEST_APP_URL || "http://127.0.0.1:3000";
const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const prefix = `casa-qa-${Date.now()}`;
const ids = { users: [], courts: [], recorders: [], cameras: [], sessions: [] };
async function send(path, body, cookie = "", origin = base) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  return {
    status: response.status,
    body: await response.json(),
    cookies: response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
    rawCookies: response.headers.getSetCookie(),
  };
}
async function identity(role) {
  const password = randomBytes(24).toString("base64url");
  const email = `${prefix}-${role}-${ids.users.length}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`Test identity setup failed: ${error.code}`);
  ids.users.push(data.user.id);
  const update = await service
    .from("profiles")
    .update({ role, active: true, display_name: "Temporary QA account" })
    .eq("id", data.user.id);
  if (update.error) throw new Error("Test profile setup failed");
  const login = await send("/api/auth/login", { email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.ok(
    login.rawCookies.some((c) => /HttpOnly/i.test(c)),
    "Auth cookies must be HttpOnly",
  );
  return { id: data.user.id, email, cookie: login.cookies, password };
}
async function machine(path, body, token) {
  const response = await fetch(`${base}/api/recorder/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
try {
  assert.equal(
    (await send("/api/admin/courts", { name: "No auth" })).status,
    401,
  );
  assert.equal(
    (
      await send(
        "/api/auth/login",
        { email: "nobody@example.com", password: "x" },
        "",
        "https://untrusted.example",
      )
    ).status,
    403,
  );
  const admin = await identity("admin"),
    player = await identity("player"),
    other = await identity("player");
  assert.equal(
    (await send("/api/admin/courts", { name: "Forbidden" }, player.cookie))
      .status,
    403,
  );
  assert.equal(
    (
      await send(
        "/api/admin/settings",
        {
          duration_minutes: 0,
          retention_hours: 24,
          venue_time_zone: "Asia/Manila",
        },
        admin.cookie,
      )
    ).status,
    400,
  );
  let result = await send(
    "/api/admin/courts",
    { name: prefix, location: "Temporary test fixture", active: true },
    admin.cookie,
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const court = await service
    .from("courts")
    .select("id")
    .eq("name", prefix)
    .single();
  ids.courts.push(court.data.id);
  result = await send("/api/admin/recorders", { name: prefix }, admin.cookie);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const recorder = await service
    .from("recorders")
    .select("id")
    .eq("name", prefix)
    .single();
  ids.recorders.push(recorder.data.id);
  result = await send(
    "/api/admin/cameras",
    {
      name: prefix,
      recorder_id: recorder.data.id,
      court_id: court.data.id,
      source_type: "usb",
      device_reference: prefix,
      is_primary: true,
      enabled: true,
    },
    admin.cookie,
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const camera = await service
    .from("cameras")
    .select("id,health")
    .eq("device_reference", prefix)
    .single();
  ids.cameras.push(camera.data.id);
  assert.equal(camera.data.health, "unknown");
  const page = await fetch(base, { headers: { Cookie: player.cookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes(prefix));
  assert.ok(html.includes("Camera not connected"));
  assert.ok(!html.includes("Sample feed"));
  assert.ok(html.includes(player.email));
  const adminPage = await fetch(`${base}/admin`, {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(adminPage.status, 200);
  assert.ok((await adminPage.text()).includes("Your club, at a glance."));
  const blockedPage = await fetch(`${base}/admin`, {
    headers: { Cookie: player.cookie },
  });
  assert.ok(
    (await blockedPage.text()).includes("Administrator access required."),
  );
  const records = await service
    .from("recording_sessions")
    .insert([
      {
        player_id: player.id,
        court_id: court.data.id,
        idempotency_key: randomUUID(),
        configuration_snapshot: {},
        recipient_email: player.email,
        status: "ready",
      },
      {
        player_id: other.id,
        court_id: court.data.id,
        idempotency_key: randomUUID(),
        configuration_snapshot: {},
        recipient_email: other.email,
        status: "ready",
      },
    ])
    .select("id");
  if (records.error) throw new Error("Test session setup failed");
  ids.sessions.push(...records.data.map((r) => r.id));
  const playerClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const auth = await playerClient.auth.signInWithPassword({
    email: player.email,
    password: player.password,
  });
  assert.equal(auth.error, null);
  const visible = await playerClient.from("recording_sessions").select("id");
  assert.equal(visible.error, null);
  assert.deepEqual(
    visible.data.map((r) => r.id),
    [ids.sessions[0]],
  );
  const denied = await playerClient
    .from("courts")
    .insert({ name: "Forbidden direct API" });
  assert.ok(denied.error);
  const secretCameras = await playerClient.from("cameras").select("*");
  assert.equal(secretCameras.data.length, 0);
  // Protocol fixtures simulate results; no physical camera is opened by this test.
  const route = `/api/admin/recorders/${recorder.data.id}`;
  assert.equal(
    (await send(route, { action: "pair" }, player.cookie)).status,
    403,
  );
  assert.equal(
    (
      await send(
        route,
        { action: "pair" },
        admin.cookie,
        "https://untrusted.example",
      )
    ).status,
    403,
  );
  const pairing = await send(route, { action: "pair" }, admin.cookie);
  assert.equal(pairing.status, 200);
  const paired = await machine("pair", { code: pairing.body.code });
  assert.equal(paired.status, 200);
  assert.equal(
    (await machine("pair", { code: pairing.body.code })).status,
    401,
  );
  const token = paired.body.token;
  const poll = {
    platform: "win32",
    version: "qa-fixture",
    ffmpeg_available: true,
  };
  assert.equal((await machine("poll", poll, "invalid")).status, 401);
  assert.equal(
    (await send(route, { action: "discover" }, admin.cookie)).status,
    200,
  );
  const claimed = await machine("poll", poll, token);
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.command.kind, "discover");
  const job = claimed.body.command;
  const device = {
    device_reference: "qa-device",
    name: "Protocol test fixture",
    source_type: "usb",
    health: "online",
    diagnostic: "connected",
  };
  const completion = {
    id: job.id,
    lease_token: job.lease_token,
    success: true,
    devices: [device],
  };
  assert.equal((await machine("complete", completion, token)).status, 200);
  assert.equal((await machine("complete", completion, token)).status, 409);
  const inventory = await service
    .from("recorder_devices")
    .select("health")
    .eq("recorder_id", recorder.data.id);
  assert.equal(inventory.data[0].health, "unknown");
  assert.equal(
    (
      await send(
        route,
        { action: "test", device_reference: "qa-device" },
        admin.cookie,
      )
    ).status,
    200,
  );
  const testJob = (await machine("poll", poll, token)).body.command;
  assert.equal(
    (
      await machine(
        "complete",
        { ...completion, id: testJob.id, lease_token: testJob.lease_token },
        token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await send(route, { action: "revoke" }, admin.cookie)).status,
    200,
  );
  assert.equal((await machine("poll", poll, token)).status, 401);
  result = await send("/api/auth/logout", {}, player.cookie);
  assert.equal(result.status, 200);
  const revoked = await send(
    "/api/admin/courts",
    { name: "Revoked" },
    player.cookie,
  );
  assert.equal(revoked.status, 401);
  console.log(
    "PASS: live login, admin CRUD, player isolation, recorder pairing, command delivery, replay rejection, revocation, and logout. Camera results were protocol fixtures, not hardware tests.",
  );
} catch (error) {
  console.error("Live verification failed:", error.message);
  process.exitCode = 1;
} finally {
  let cleanupFailed = false;
  for (const id of ids.recorders) {
    const result = await service
      .from("audit_events")
      .delete()
      .contains("safe_detail", { recorder_id: id });
    if (result.error) cleanupFailed = true;
  }
  for (const [table, list] of [
    ["recording_sessions", ids.sessions],
    ["cameras", ids.cameras],
    ["courts", ids.courts],
    ["recorders", ids.recorders],
  ]) {
    if (list.length) {
      const result = await service.from(table).delete().in("id", list);
      if (result.error) cleanupFailed = true;
    }
  }
  if (ids.users.length) {
    const result = await service
      .from("audit_events")
      .delete()
      .in("actor_id", ids.users);
    if (result.error) cleanupFailed = true;
  }
  for (const id of ids.users) {
    const result = await service.auth.admin.deleteUser(id);
    if (result.error) cleanupFailed = true;
  }
  console.log(
    cleanupFailed
      ? "Fixture cleanup needs attention."
      : "Temporary test fixtures removed.",
  );
  if (cleanupFailed) process.exitCode = 1;
}

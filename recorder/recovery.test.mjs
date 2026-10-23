import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { syncCaptures } from "./capture-manager.mjs";
test("restart retries a durable completion without launching another capture", async () => {
  const root = resolve(".local");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(join(root, "recovery-test-"));
  const job = {
    session_id: randomUUID(),
    claim_token: randomUUID(),
    max_seconds: 1,
    claimed_at: new Date(Date.now() - 120000).toISOString(),
    stop_requested: false,
  };
  const dir = join(home, "captures", job.session_id);
  await mkdir(dir, { recursive: true });
  const record = {
    job,
    state: "local_ready",
    reason: "player_stop",
    bytes: 128,
  };
  await writeFile(join(dir, "state.json"), JSON.stringify(record));
  let attempts = 0;
  const api = async (_config, _path, body) => {
    if (body.action === "sync") return { jobs: [job] };
    attempts++;
    assert.equal(body.id, job.session_id);
    assert.equal(body.token, job.claim_token);
    assert.equal(body.state, "local_ready");
    if (attempts === 1) throw new Error("network unavailable");
    return { ok: true };
  };
  try {
    await assert.rejects(() => syncCaptures(home, {}, api));
    await syncCaptures(home, {}, api);
    assert.equal(attempts, 2);
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "state.json"), "utf8")),
      record,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("recovery fails abandoned launch markers but preserves ambiguous camera locks", async () => {
  const root = resolve(".local");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(join(root, "recovery-test-"));
  const job = {
    session_id: randomUUID(),
    claim_token: randomUUID(),
    max_seconds: 1,
    claimed_at: new Date(Date.now() - 120000).toISOString(),
    stop_requested: false,
  };
  const dir = join(home, "captures", job.session_id);
  await mkdir(dir, { recursive: true });
  const reports = [];
  const api = async (_config, _path, body) =>
    body.action === "sync"
      ? { jobs: [job] }
      : (reports.push(body), { ok: true });
  try {
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ job, state: "starting", reason: "running" }),
    );
    await syncCaptures(home, {}, api);
    assert.equal(reports[0].state, "failed");
    assert.equal(reports[0].reason, "interrupted");
    reports.length = 0;
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({
        job,
        state: "starting",
        reason: "running",
        spawnAttempted: true,
      }),
    );
    await syncCaptures(home, {}, api);
    assert.equal(
      reports.length,
      0,
      "unknown child process must not release a potentially live camera",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

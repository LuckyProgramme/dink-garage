import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspectRecording } from "../lib/recording-integrity";
const clip = readFileSync(new URL("./fixtures/recording-one-second.mp4", import.meta.url));
test("normal MP4 video and audio timing is measured from sample tables", async () => {
  const result = await inspectRecording(new Blob([clip]), 1000, true);
  assert.equal(result.videoMs, 1000);
  assert.equal(result.videoSamples, 10);
  assert.ok(Math.abs(result.audioMs! - 1000) < 100);
});
test("short, stretched, and truncated recordings are rejected", async () => {
  await assert.rejects(inspectRecording(new Blob([clip]), 10000, true), /timing/);
  await assert.rejects(inspectRecording(new Blob([clip.subarray(0, clip.length - 30)])), /incomplete/);
  await assert.rejects(inspectRecording(new Blob(["not a video"])), /incomplete/);
});
test("large video time gaps cannot be hidden by plausible container duration", async () => {
  const broken = Buffer.from(clip);
  const stts = broken.indexOf(Buffer.from("stts"));
  broken.writeUInt32BE(100000, stts + 16);
  await assert.rejects(inspectRecording(new Blob([broken])), /timing gap/);
});
test("fragmented MP4 is validated using tfdt/trun source timing", async () => {
  const fragment = readFileSync(new URL("./fixtures/recording-fragmented.mp4", import.meta.url));
  const result = await inspectRecording(new Blob([fragment]), 1000, true);
  assert.equal(result.videoMs, 1000);
  const broken = Buffer.from(fragment);
  const tfdt = broken.indexOf(Buffer.from("tfdt"));
  if (broken[tfdt + 4] === 1) broken.writeBigUInt64BE(BigInt(1_000_000), tfdt + 8);
  else broken.writeUInt32BE(1_000_000, tfdt + 8);
  await assert.rejects(inspectRecording(new Blob([broken]), 1000, true), /starting times/);
});

// Preserve real muxer structures while varying timestamp deltas. An explicit
// duplicate timestamp is different from a missing default sample duration.
test("fragmented audio accepts equal timestamps without inventing duration", async () => {
  const fragment = Buffer.from(readFileSync(new URL("./fixtures/recording-fragmented.mp4", import.meta.url)));
  const baseline = await inspectRecording(new Blob([fragment]), 1000, true);
  const firstRun = fragment.indexOf(Buffer.from("trun"));
  const audioRun = fragment.indexOf(Buffer.from("trun"), firstRun + 4);
  assert.equal(fragment.readUInt32BE(audioRun + 4) & 0xffffff, 0x301);
  const sample = audioRun + 16; // full-box header, count, data offset
  const delta = fragment.readUInt32BE(sample);
  fragment.writeUInt32BE(0, sample);
  fragment.writeUInt32BE(fragment.readUInt32BE(sample + 8) + delta, sample + 8);
  const result = await inspectRecording(new Blob([fragment]), 1000, true);
  assert.equal(result.videoMs, 1000);
  assert.equal(result.audioMs, baseline.audioMs);
});

test("an audio clock that never advances is still rejected", async () => {
  const fragment = Buffer.from(readFileSync(new URL("./fixtures/recording-fragmented.mp4", import.meta.url)));
  const audioRun = fragment.indexOf(Buffer.from("trun"), fragment.indexOf(Buffer.from("trun")) + 4);
  const count = fragment.readUInt32BE(audioRun + 8);
  for (let i = 0; i < count; i++) fragment.writeUInt32BE(0, audioRun + 16 + i * 8);
  await assert.rejects(inspectRecording(new Blob([fragment]), 1000, true), /Audio sample clock does not advance/);
});

test("regular MP4 cannot pass with a zero-duration video clock", async () => {
  const broken = Buffer.from(clip);
  broken.writeUInt32BE(0, broken.indexOf(Buffer.from("stts")) + 16);
  await assert.rejects(inspectRecording(new Blob([broken]), 1000), /No complete video track/);
});

test("missing audio and excessive audio sample gaps remain failures", async () => {
  const fragment = Buffer.from(readFileSync(new URL("./fixtures/recording-fragmented.mp4", import.meta.url)));
  const audioRun = fragment.indexOf(Buffer.from("trun"), fragment.indexOf(Buffer.from("trun")) + 4);
  fragment.writeUInt32BE(1_000_000, audioRun + 16);
  await assert.rejects(inspectRecording(new Blob([fragment]), 1000, true), /Audio sample clock.*track 2/);
  const silent = Buffer.from(clip);
  silent.write("meta", silent.indexOf(Buffer.from("soun")));
  await assert.rejects(inspectRecording(new Blob([silent]), 1000, true), /expected audio track is missing/);
});


test("explicit video timestamps allow duplicates and variable frame intervals", async () => {
  const fragment = Buffer.from(readFileSync(new URL("./fixtures/recording-fragmented.mp4", import.meta.url)));
  const mdhd = fragment.indexOf(Buffer.from("mdhd"));
  const scale = fragment.readUInt32BE(mdhd + 16);
  const run = fragment.indexOf(Buffer.from("trun"));
  assert.equal(fragment.readUInt32BE(run + 4) & 0xffffff, 0xa05);
  assert.equal(fragment.readUInt32BE(run + 8), 10);
  // Replace size/CTS pairs with duration/size pairs (same byte count).
  fragment.writeUInt32BE(0x305, run + 4);
  const durations = [0, 2, 1, 1, 0.5, 1.5, 1, 1, 1, 1];
  for (let i = 0; i < 10; i++) {
    const p = run + 20 + i * 8;
    const size = fragment.readUInt32BE(p);
    fragment.writeUInt32BE(Math.round(durations[i] * scale / 10), p);
    fragment.writeUInt32BE(size, p + 4);
  }
  const result = await inspectRecording(new Blob([fragment]), 1000, true);
  assert.equal(result.videoMs, 1000);
  assert.equal(result.videoSamples, 10);
  await assert.rejects(inspectRecording(new Blob([fragment]), 10000, true), /timing/);
});

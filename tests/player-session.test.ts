import test from "node:test";
import assert from "node:assert/strict";
import { localPlayerRecording, hideQueuedSession } from "../lib/player-session";
import type { LocalRecording } from "../lib/browser-storage";
const record: LocalRecording = { id: "match", deviceId: "tablet", mime: "video/mp4", complete: false, interrupted: false, createdAt: 1 };
test("active recording takes precedence over an older recovery item", () => {
  assert.equal(localPlayerRecording([{...record,id:"old",status:"failed",createdAt:2},record],"tablet","match")?.id,"match");
  assert.equal(hideQueuedSession({...record,complete:true},"match"),false);
});
test("failed capture remains recoverable when the server clears its current session", () => {
  for (const item of [{...record,complete:true,interrupted:true},{...record,complete:true,status:"failed" as const}]) {
    assert.equal(localPlayerRecording([item],"tablet")?.id,"match");
    assert.equal(hideQueuedSession(item),false);
  }
});
test("other devices and completed uploads cannot resurrect a session", () => {
  assert.equal(localPlayerRecording([record],"other"),undefined);
  assert.equal(localPlayerRecording([{...record,status:"uploaded",localAvailable:false}],"tablet"),undefined);
  assert.equal(localPlayerRecording([{...record,complete:true,status:"pending"}],"tablet"),undefined);
  assert.equal(hideQueuedSession({...record,complete:true,status:"pending"}),true);
});

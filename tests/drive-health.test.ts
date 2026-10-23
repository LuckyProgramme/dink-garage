import test from "node:test";
import assert from "node:assert/strict";
import { inspectDrive, healthFailure } from "../lib/drive-health";
import { GoogleDrive, DriveError } from "../lib/google-drive";

function drive(quota: object, permissions = [{id:"owner",type:"user",role:"owner",emailAddress:"owner@gmail.com"}]) {
  return new GoogleDrive("test", (async (url, init) => {
    assert.equal(init?.method, undefined, "Readiness must not write files or permissions");
    const path = String(url);
    if (path.includes("/permissions")) return Response.json({permissions});
    if (path.includes("/about?")) return Response.json({storageQuota:quota});
    return Response.json({mimeType:"application/vnd.google-apps.folder",capabilities:{canAddChildren:true}});
  }) as typeof fetch);
}
test("Drive readiness accepts writable private folders with space, including unlimited quota", async () => {
  await inspectDrive(drive({limit:"1000",usage:"999"}),"folder123","owner@gmail.com");
  await inspectDrive(drive({usage:"999"}),"folder123","owner@gmail.com");
});
test("Drive readiness rejects full storage and unexpected folder sharing", async () => {
  await assert.rejects(inspectDrive(drive({limit:"1000",usage:"1000"}),"folder123","owner@gmail.com"), /drive_storage_full/);
  await assert.rejects(inspectDrive(drive({},[{id:"public",type:"anyone",role:"reader",emailAddress:""}]),"folder123","owner@gmail.com"), /drive_folder_must_be_private/);
});
test("Readiness distinguishes lost authorization from temporary connectivity errors", () => {
  assert.equal(healthFailure(new DriveError("google_reconnect_required")).code,"google_reconnect_required");
  assert.equal(healthFailure(new Error("network details")).code,"google_temporarily_unavailable");
  assert.equal(healthFailure(new Error()).ready,false);
});

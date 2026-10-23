import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { GoogleDrive, DriveError, localDay, privatePermissions, recordingFileName, uploadUri } from "../lib/google-drive";
import { encryptSecret, decryptSecret } from "../lib/google-crypto";

test("Google token encryption authenticates ciphertext and uses unique nonces", () => {
  process.env.TOKEN_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const a=encryptSecret("private-refresh-token"),b=encryptSecret("private-refresh-token");
  assert.notEqual(a,b); assert.equal(decryptSecret(a),"private-refresh-token");
  assert.ok(!a.includes("private-refresh-token"));
  const parts=a.split("."); parts[1]=Buffer.alloc(16).toString("base64url");
  assert.throws(()=>decryptSecret(parts.join(".")));
});
test("Philippine folder dates and private file permissions fail closed", () => {
  assert.equal(localDay("2026-09-30T16:01:00Z","Asia/Manila"),"2026-10-01");
  assert.equal(
    recordingFileName("2026-09-30T16:01:02Z","Asia/Manila","Court 1 / Main","Player+Match@GMAIL.COM","webm"),
    "20261001-000102_Court-1-Main_player+match@gmail.com.webm",
  );
  assert.throws(() => recordingFileName("2026-09-30T16:01:02Z","Asia/Manila","Court 1","player@gmail.com","exe"));
  const owner={id:"owner",type:"user",role:"owner",emailAddress:"owner@gmail.com"};
  assert.equal(privatePermissions([owner],"owner@gmail.com"),true);
  assert.equal(privatePermissions([owner,{id:"public",type:"anyone",role:"reader"}],"owner@gmail.com"),false);
  assert.equal(privatePermissions([owner,{id:"wrong",type:"user",role:"reader",emailAddress:"other@gmail.com"}],"owner@gmail.com","player@gmail.com"),false);
  assert.equal(privatePermissions([owner,{id:"right",type:"user",role:"reader",emailAddress:"player@gmail.com"}],"owner@gmail.com","player@gmail.com"),true);
  for(const uri of ["http://www.googleapis.com/upload/drive/v3/files?upload_id=x","https://evil.example/upload/drive/v3/files","https://www.googleapis.com:4444/upload/drive/v3/files"])
    assert.throws(()=>uploadUri(uri));
});
test("Drive sharing retries reuse recipient permissions without email or broad access", async () => {
  const permissions=[{id:"owner",type:"user",role:"owner",emailAddress:"owner@gmail.com"}];
  let writes=0;
  const fake=async(url: string | URL | Request, options?: RequestInit)=>{
    assert.ok(String(url).startsWith("https://www.googleapis.com/drive/v3/files/"));
    if(options?.method==="POST") {
      writes++; assert.ok(String(url).includes("sendNotificationEmail=false"));
      const body=JSON.parse(String(options.body));
      assert.deepEqual(body,{type:"user",role:"reader",emailAddress:"player@gmail.com"});
      permissions.push({id:"reader",...body});
      return Response.json({id:"reader"});
    }
    return Response.json({permissions});
  };
  const drive=new GoogleDrive("test",fake as typeof fetch);
  assert.equal(await drive.share("file12345","owner@gmail.com","player@gmail.com"),"reader");
  assert.equal(await drive.share("file12345","owner@gmail.com","player@gmail.com"),"reader");
  assert.equal(writes,1);
  await assert.rejects(()=>drive.share("file12345","owner@gmail.com","player.demo@example.com"),(e:unknown)=>e instanceof DriveError && e.code==="real_player_email_required");
});

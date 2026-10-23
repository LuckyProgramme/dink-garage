import test from "node:test";
import assert from "node:assert/strict";
import {recordingMessage,sendGmail,MailError} from "../lib/gmail";
const id="12345678-1234-1234-1234-123456789abc";
function plainPart(mime:string) {
  const part=mime.split(/\r\n--[^\r\n]+\r\n/).find(value=>/Content-Type: text\/plain/i.test(value));
  if (!part) throw new Error("missing plain email part");
  return Buffer.from(part.split("\r\n\r\n")[1].split(/\r\n--/)[0].replace(/\r\n/g,""),"base64").toString();
}
test("Email contains one private link, Philippines deadline and no injected headers",()=>{
  const raw=recordingMessage("owner@gmail.com","player@gmail.com",id,"drive12345","2026-10-02T00:00:00Z","Asia/Manila");
  const mime=Buffer.from(raw,"base64url").toString();
  assert.match(mime,/To: player@gmail.com\r\n/);
  assert.doesNotMatch(mime,/Bcc:|Cc:/);
  const body=plainPart(mime);
  assert.match(body,/https:\/\/drive.google.com\/file\/d\/drive12345\/view/);
  assert.match(body,/Asia\/Manila/);
  assert.match(body,/player@gmail.com/);
  assert.throws(()=>recordingMessage("owner@gmail.com","victim@gmail.com\r\nBcc: other@gmail.com",id,"drive12345","2026-10-02","Asia/Manila"));
  assert.throws(()=>recordingMessage("owner@gmail.com","player@example.com",id,"drive12345","2026-10-02","Asia/Manila"));
});
test("One replay message privately reaches all four team recipients",()=>{
  const recipients=["one@gmail.com","two@gmail.com","three@gmail.com","four@gmail.com"];
  const raw=recordingMessage("owner@gmail.com",recipients,id,"drive12345","2026-10-02T00:00:00Z","Asia/Manila",true);
  const mime=Buffer.from(raw,"base64url").toString();
  assert.doesNotMatch(mime,/\r\nTo:/);
  assert.match(mime,/Bcc: one@gmail.com, two@gmail.com, three@gmail.com, four@gmail.com\r\n/);
  assert.doesNotMatch(mime,/undisclosed-recipients/);
  const body=plainPart(mime);
  assert.equal(body.match(/https:\/\/drive\.google\.com\/file\/d\/drive12345\/view/g)?.length,1);
  assert.throws(()=>recordingMessage("owner@gmail.com",["one@gmail.com","one@gmail.com"],id,"drive12345","2026-10-02","Asia/Manila",true));
});
test("Gmail accepts successful sends; uncertain sends never silently retry",async()=>{
  const mock=(status:number,body:object,headers={})=>(async()=>Response.json(body,{status,headers})) as typeof fetch;
  assert.equal(await sendGmail("token","raw",mock(200,{id:"gmail-id"})),"gmail-id");
  for(const request of [mock(503,{}),mock(200,{}),(async()=>{throw new Error("timeout");}) as typeof fetch])
    await assert.rejects(sendGmail("token","raw",request),(e:unknown)=>e instanceof MailError && e.outcome==="unknown");
  await assert.rejects(sendGmail("token","raw",mock(429,{}, {"Retry-After":"120"})),(e:unknown)=>e instanceof MailError && e.outcome==="retry" && e.retryAfter===120000);
  await assert.rejects(sendGmail("token","raw",mock(403,{})),(e:unknown)=>e instanceof MailError && e.code==="gmail_permission_required");
  await assert.rejects(sendGmail("token","raw",mock(401,{})),(e:unknown)=>e instanceof MailError && e.outcome==="failed");
});

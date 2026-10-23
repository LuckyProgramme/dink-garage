import { driveId } from "./google-drive";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export class MailError extends Error {
  constructor(public code:string,public outcome:"retry"|"failed"|"unknown",public retryAfter=60000) { super(code); }
}
function email(value:string) {
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value) || /@example\.(com|net|org)$/i.test(value))
    throw new MailError("invalid_email_recipient","failed");
  return value;
}
export function recordingMessage(sender:string,recipient:string|string[],file:string,drive:string,expires:string,zone:string,linkAccess=false) {
  email(sender);
  const recipients=(Array.isArray(recipient)?recipient:[recipient]).map(value=>email(value.trim().toLowerCase()));
  if (!recipients.length || new Set(recipients).size!==recipients.length || recipients.length>4)
    throw new MailError("invalid_email_recipient","failed");
  if (!/^[a-f0-9-]{36}$/.test(file)) throw new MailError("invalid_recording","failed");
  const deadline = new Intl.DateTimeFormat("en-PH",{timeZone:zone,dateStyle:"medium",timeStyle:"short"}).format(new Date(expires));
  const accessNote=linkAccess
    ? "Anyone with this link can watch. Only forward it to people you want to share your recording with."
    : recipients.length===1
      ? `Sign in to Google as ${recipients[0]} to view this private recording.`
      : "Sign in using one of the recipient Google accounts to view this private recording.";
  const replayId=driveId(drive);
  const replayUrl=`https://drive.google.com/file/d/${replayId}/view`;
  const replayOpenUrl=`https://drive.google.com/open?id=${encodeURIComponent(replayId)}`;
  // Drive serves a lightweight thumbnail without downloading the video. It can
  // be unavailable briefly while Drive prepares the file, so the email also has
  // a branded fallback and keeps the normal replay link prominent.
  const thumbnailUrl=`https://drive.google.com/thumbnail?id=${encodeURIComponent(replayId)}&sz=w1200`;
  const body = `Your Dink Vision match recording is ready.\n\nWatch your recording:\n${replayUrl}\n\n${accessNote}\nGoogle may need a little time to prepare video playback.\n\nPlease save a copy before ${deadline} (${zone}), the scheduled retention deadline.\n\nEnjoy your replay!\nDink Vision`;
  const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,(character)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[character]!));
  const html=`<!doctype html><html><body style="margin:0;background:#f4f2ea;color:#173f43;font-family:Arial,Helvetica,sans-serif;">
<div style="padding:30px 14px;background:#f4f2ea;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:620px;margin:0 auto;background:#fffef9;border:1px solid #dbe3d6;border-radius:18px;overflow:hidden;">
<tr><td style="padding:26px 30px 20px;background:#0b6467;color:#fffef9;"><div style="font-family:Georgia,serif;font-size:15px;letter-spacing:3px;font-weight:bold;">Dink Vision</div><div style="margin-top:6px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#cfe5d9;">Dink Vision</div></td></tr>
<tr><td style="padding:30px;"><div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6d8275;font-weight:bold;">Match replay ready</div><h1 style="margin:10px 0 12px;font-family:Georgia,serif;font-size:31px;line-height:1.15;font-weight:normal;color:#123f43;">Your recording is ready.</h1><p style="margin:0 0 20px;color:#526b69;font-size:15px;line-height:1.55;">Your Dink Vision replay has finished processing.</p>
<a href="${escapeHtml(replayOpenUrl)}" style="display:block;text-decoration:none;"><img src="${escapeHtml(thumbnailUrl)}" alt="Match replay thumbnail" width="560" style="display:block;width:100%;max-width:560px;height:auto;min-height:190px;object-fit:cover;border-radius:12px;background:#e8efe5;border:1px solid #dbe3d6;"></a>
<p style="margin:20px 0 0;text-align:center;"><a href="${escapeHtml(replayOpenUrl)}" style="display:inline-block;padding:13px 23px;border-radius:8px;background:#0b6467;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;">Watch your recording&nbsp; →</a></p>
<div style="margin-top:24px;padding:15px 16px;border-radius:10px;background:#eef4ea;color:#526b69;font-size:13px;line-height:1.55;">${escapeHtml(accessNote)}<br>Google may need a little time to prepare video playback.</div>
<p style="margin:20px 0 0;color:#526b69;font-size:13px;line-height:1.55;">Please save a copy before <strong style="color:#173f43;">${escapeHtml(deadline)} (${escapeHtml(zone)})</strong>, the scheduled retention deadline.</p></td></tr>
<tr><td style="padding:18px 30px;border-top:1px solid #e3e8df;color:#82918a;font-size:12px;line-height:1.5;">Enjoy your replay!<br><strong style="color:#52706c;">Dink Vision</strong><br><span>Powered by Dink Vision PH</span></td></tr>
</table></div></body></html>`;
  const boundary=`----=_DinkVision_${file.replace(/[^a-z0-9]/gi,"")}`;
  // Gmail rejects the empty RFC group form ("undisclosed-recipients:;") for
  // some API messages. A Bcc-only message is valid, reaches every submitted
  // address once, and keeps players' email addresses private from each other.
  const destination=recipients.length===1
    ? [`To: ${recipients[0]}`]
    : [`Bcc: ${recipients.join(", ")}`];
  const multipart=[
    `--${boundary}`,"Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: base64","",Buffer.from(body).toString("base64").match(/.{1,76}/g)!.join("\r\n"),"",
    `--${boundary}`,"Content-Type: text/html; charset=UTF-8","Content-Transfer-Encoding: 8bit","",html,"",
    `--${boundary}--`,
  ].join("\r\n");
  return Buffer.from([
    `From: Dink Vision <${sender}>`,...destination,"Subject: Your Dink Vision match recording is ready",
    `Message-ID: <dinkvision-${file}@${sender.split("@")[1]}>`,
    "MIME-Version: 1.0",`Content-Type: multipart/alternative; boundary="${boundary}"`,"",multipart,
  ].join("\r\n")).toString("base64url");
}
export async function sendGmail(token:string,raw:string,request:typeof fetch=fetch):Promise<string> {
  let response:Response;
  try {
    response=await request("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",{
      method:"POST",redirect:"error",signal:AbortSignal.timeout(20000),
      headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({raw}),
    });
  } catch { throw new MailError("send_outcome_unknown","unknown"); }
  if (!response.ok) {
    if (response.status>=500) throw new MailError("send_outcome_unknown","unknown");
    if (response.status===401) throw new MailError("gmail_reconnect_required","failed");
    const data=await response.json().catch(()=>({}));
    const reason=data.error?.errors?.[0]?.reason;
    if (response.status===429 || ["rateLimitExceeded","userRateLimitExceeded","dailyLimitExceeded"].includes(reason)) {
      const retry=response.headers.get("retry-after") || "";
      const wait=/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now();
      throw new MailError("gmail_rate_limited","retry",Number.isFinite(wait)?Math.max(60000,wait):60000);
    }
    throw new MailError(response.status===403?"gmail_permission_required":"gmail_request_rejected","failed");
  }
  const data=await response.json().catch(()=>({}));
  if (!data.id) throw new MailError("send_outcome_unknown","unknown");
  return data.id;
}

"use client";
import { useEffect,useState } from "react";
type MailStatus={integration:{owner_email:string;gmail_authorized_at:string|null}|null;files:{id:string;session_id:string;recording_sessions:{recipient_email:string;configuration_snapshot?:{recipient_emails?:string[]}}}[];jobs:{file_id:string;status:string;attempts:number;safe_error:string|null;sent_at:string|null;next_attempt_at:string}[]};
export default function EmailControls() {
  const [data,setData]=useState<MailStatus>();
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  async function refresh() {
    try { const r=await fetch("/api/admin/email",{cache:"no-store"}); if (!r.ok) throw new Error(); setData(await r.json()); }
    catch { setMessage("Email status is unavailable. Retry shortly."); }
  }
  useEffect(()=>{void refresh();const timer=setInterval(refresh,15000);return()=>clearInterval(timer);},[]);
  async function queue(id:string) {
    setBusy(true);
    try {const r=await fetch("/api/admin/email",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({file_id:id})});const body=await r.json();setMessage(r.ok?"Email queued for background processing.":body.error);await refresh();}
    catch {setMessage("Email request failed. Refresh its status before retrying.");} finally {setBusy(false);}
  }
  return <section className="admin-card google-drive-card">
    <div className="eyebrow">MATCH DELIVERY</div><h2>Email notifications</h2>
    <p>{data?.integration?.gmail_authorized_at?`Gmail sending authorized for ${data.integration.owner_email}. New browser uploads are emailed by the cloud worker.`:"Enable Gmail sending through the Google connection button above. Existing Drive authorization alone cannot send email."}</p>
    <p className="form-note">Emails contain a playback link, not a video attachment. Anyone holding a guest replay link can watch. Sent means Gmail accepted the message; it does not confirm inbox delivery. Check Spam if needed. Previous uploads need an explicit Send email action.</p>
    {message && <p role="status">{message}</p>}
    <ul className="activity-list">{data?.files.map(file=>{
      const job=data.jobs.find(j=>j.file_id===file.id);
      const recipients=file.recording_sessions.configuration_snapshot?.recipient_emails;
      const recipientLabel=Array.isArray(recipients)&&recipients.length?recipients.join(", "):file.recording_sessions.recipient_email;
      return <li key={file.id}><div><strong>{recipientLabel} · {job?.status || "Not queued"}</strong><p className="form-note">{file.session_id}</p>
        {job && <p className="form-note">{job.attempts} attempts{job.sent_at?` · Sent ${new Date(job.sent_at).toLocaleString()}`:""}{job.status==="pending"?` · Next attempt ${new Date(job.next_attempt_at).toLocaleString()}`:""}</p>}
        {job?.safe_error && <p className="form-error">{job.status==="unknown"?"Send outcome is uncertain. Check the owner's Sent folder before contacting support; automatic resend is disabled to avoid duplicates.":job.safe_error.replaceAll("_"," ")}</p>}
        {(!job || job.status==="failed") && <button className="sign-in" disabled={busy || !data.integration?.gmail_authorized_at} onClick={()=>queue(file.id)}>{job?"Retry email":"Send email"}</button>}
      </div></li>;
    })}</ul>
  </section>;
}

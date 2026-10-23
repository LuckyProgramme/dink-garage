"use client";
import { useEffect, useState } from "react";
type GoogleStatus = {
  configured: boolean;
  integration: {owner_email:string;connected_at:string;safe_error:string|null} | null;
};
export default function GoogleDriveControls() {
  const [data,setData]=useState<GoogleStatus>();
  const [message,setMessage]=useState("");
  useEffect(()=>{
    let alive=true;
    const refresh=async()=>{
      try {
        const r=await fetch("/api/integrations/google/status",{cache:"no-store"});
        const value=await r.json();
        if (!r.ok) throw new Error(value.error);
        if (alive) setData(value);
      } catch { if (alive) setMessage("Google status is temporarily unavailable."); }
    };
    const result=new URLSearchParams(window.location.search).get("google");
    if (result) setMessage(result==="connected"?"Google Drive connected successfully.":`Google connection needs attention: ${result.replaceAll("_"," ")}.`);
    void refresh(); const timer=setInterval(refresh,15000);
    return ()=>{alive=false;clearInterval(timer);};
  },[]);
  return <section className="admin-card google-drive-card">
    <div className="eyebrow">MATCH STORAGE & PLAYBACK</div>
    <h2>Google Drive</h2>
    {data?.integration?.safe_error && <p role="alert" className="form-error">Google access needs attention. Reconnect the owner's account, then retry affected uploads.</p>}
    {data?.configured && <form method="post" action="/api/integrations/google/start"><button className="primary" type="submit">{data.integration?"Connect / reconnect Drive & Gmail":"Connect Google Drive & Gmail"}</button></form>}
    {data && !data.configured && <p className="form-error">Google credentials are missing from the server configuration.</p>}
    {message && <p role="status" className="form-note">{message}</p>}
  </section>;
}
export function DriveRetry({sessionId}:{sessionId:string}) {
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  async function queue() {
    setBusy(true);
    try {
      const r=await fetch("/api/admin/drive/retry",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({session_id:sessionId})});
      const body=await r.json();
      setMessage(r.ok?"Queued for upload. Keep the venue recorder running.":body.error);
    } catch { setMessage("Could not queue upload. Please retry."); }
    finally { setBusy(false); }
  }
  return <><button className="sign-in" disabled={busy} onClick={queue}>{busy?"Queueing…":"Upload / retry Drive"}</button>{message && <p role="status" className="form-note">{message}</p>}</>;
}

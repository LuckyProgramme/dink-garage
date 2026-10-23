"use client";
import { useEffect, useState } from "react";

type Health = {ready:boolean;code:string;checkedAt:string;message:string;redirect:string};
export default function DriveHealthBanner() {
  const [health,setHealth] = useState<Health>();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [origin,setOrigin] = useState("");
  async function check() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/integrations/google/health",{method:"POST"});
      if (!response.ok) throw new Error();
      setHealth(await response.json());
    } catch { setHealth(undefined); setError("Drive status could not be checked. Retry before starting new recordings."); }
    finally { setBusy(false); }
  }
  useEffect(() => { setOrigin(window.location.origin); void check(); },[]);
  const callbackOrigin = health?.redirect ? new URL(health.redirect).origin : "";
  const reconnect = health && ["google_not_connected","google_reconnect_required"].includes(health.code);
  return <section className="admin-card google-drive-card" aria-label="Google Drive readiness">
    <h2>{busy ? "Checking Google Drive…" : health?.ready ? "Google Drive connected" : "Google Drive needs attention"}</h2>
    <p role="status">{error || health?.message || "Checking saved authorization, folder access, and storage."}</p>
    {health && <p className="form-note">Last checked: {new Date(health.checkedAt).toLocaleTimeString()}. {health.ready ? "Access is checked again before new recordings." : "New recordings are blocked until this check passes. Existing recordings continue locally."}</p>}
    <button className="sign-in" disabled={busy} onClick={check}>{busy ? "Checking…" : "Check again"}</button>
    {reconnect && (callbackOrigin !== origin ? <p><a className="primary" href={`${callbackOrigin}/admin`}>Open connection dashboard</a></p> : <form method="post" action="/api/integrations/google/start"><button className="primary" type="submit">{health.code === "google_not_connected" ? "Connect Google Drive" : "Reconnect Google Drive"}</button></form>)}
    {reconnect && <p className="form-note">Owner authorization is only needed when connecting or restoring access. If Google shows redirect_uri_mismatch, add this exact address to your Google OAuth client's Authorized redirect URIs: <code>{health.redirect}</code></p>}
  </section>;
}

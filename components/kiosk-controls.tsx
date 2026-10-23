"use client";
import { useEffect, useState } from "react";
export default function KioskControls() {
  const [enabled, setEnabled] = useState(false),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/admin/kiosk")
      .then((r) => r.json())
      .then((d) => {
        setEnabled(d.enabled);
        if (d.error) setMessage(d.error);
      })
      .catch(() => setMessage("Tablet setup unavailable."));
  }, []);
  async function change() {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/kiosk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: enabled ? "disable" : "enable" }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      setEnabled(d.enabled);
      setMessage(
        d.enabled
          ? "This browser is ready for guests. Sign out of admin before handing over the tablet."
          : "Guest controls disabled on this browser.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="admin-card">
      <h2>Guest tablet</h2>
      <p>
        Enable this browser once. Players choose a court and enter an email
        without creating an account. Videos are accessible to anyone holding the
        emailed link.
      </p>
      <button className="sign-in" disabled={busy} onClick={change}>
        {busy
          ? "Updating…"
          : enabled
            ? "Disable this tablet"
            : "Enable this tablet"}
      </button>
      {enabled && (
        <a className="sign-in" href="/">
          Open guest screen
        </a>
      )}
      <p role="status">{message}</p>
    </section>
  );
}

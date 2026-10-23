"use client";
import { useState } from "react";
import type { Account } from "@/lib/auth";

export default function AccountControls({ account }: { account: Account }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function logout() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error();
      window.location.assign("/");
    } catch {
      setError("Sign-out failed. Please retry.");
      setBusy(false);
    }
  }
  return (
    <div className="account-controls">
      <span>{account.displayName || account.email}</span>
      {account.role === "admin" && <a href="/admin">Admin</a>}
      <button className="sign-in" disabled={busy} onClick={logout}>
        {busy ? "Signing out…" : "Sign out"}
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

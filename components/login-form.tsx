"use client";
import { useState, type FormEvent } from "react";

export default function LoginForm({
  admin = false,
  configured,
}: {
  admin?: boolean;
  configured: boolean;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const values = new FormData(event.currentTarget);
    try {
      const result = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: values.get("email"),
          password: values.get("password"),
          admin,
        }),
      });
      const body = await result.json();
      if (!result.ok) {
        setError(body.error);
        setBusy(false);
        return;
      }
      window.location.assign(body.redirect);
    } catch {
      setError("Could not reach the sign-in service. Please retry.");
      setBusy(false);
    }
  }
  return (
    <form className="stack-form" onSubmit={submit}>
      <label>
        Email address
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          maxLength={254}
          disabled={busy}
        />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={128}
          disabled={busy}
        />
      </label>
      {!configured && (
        <p className="form-error" role="alert">
          Account service has not been configured.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy || !configured}>
        {busy ? "Signing in…" : admin ? "Sign in to admin" : "Sign in"}
      </button>
      <p className="form-note">
        Use your venue-issued account. Need access or a password reset? Contact
        the venue administrator.
      </p>
    </form>
  );
}

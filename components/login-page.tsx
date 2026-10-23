import LoginForm from "./login-form";
import { isConfigured } from "@/lib/supabase-server";
import { getAccount } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function LoginPage({
  admin = false,
}: {
  admin?: boolean;
}) {
  const { account, problem } = await getAccount();
  if (account && (!admin || account.role === "admin"))
    redirect(account.role === "admin" ? "/admin" : "/");
  return (
    <main className="auth-page">
      <a className="brand" href="/">
        <img src="/dink-vision-logo.png" alt="Dink Vision" />
      </a>
      <section className="auth-card">
        <div className="eyebrow">
          {admin ? "VENUE MANAGEMENT" : "WELCOME BACK TO THE COURT"}
        </div>
        <h1>{admin ? "A place for every game." : "Your next good game."}</h1>
        <p>
          {admin
            ? "Manage your courts, cameras, and club settings."
            : "Sign in to see your courts and match recordings."}
        </p>
        {problem && (
          <p className="form-error" role="alert">
            {problem}
          </p>
        )}
        <LoginForm admin={admin} configured={isConfigured()} />
      </section>
      <a className="auth-switch" href={admin ? "/login" : "/admin/login"}>
        {admin ? "Player sign-in" : "Venue administrator? Sign in here"}
      </a>
      <a className="auth-switch" href="/">
        ← Back to Venue
      </a>
    </main>
  );
}

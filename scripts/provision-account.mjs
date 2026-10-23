import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const [emailInput, role = "player", displayName = ""] = process.argv.slice(2);
const email = emailInput?.trim().toLowerCase();
if (
  !email ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
  !["admin", "player"].includes(role)
) {
  console.error(
    'Usage: npm run account:create -- email@example.com player|admin "Display name"',
  );
  process.exit(1);
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY)
  throw new Error("Configure the Supabase URL and server secret key locally.");
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const password = randomBytes(24).toString("base64url");
// Seed only owner-confirmed test addresses. No email is sent and existing passwords are never reset.
const { data, error } = await db.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (error) {
  console.error("Account creation failed:", error.code || error.status);
  process.exit(1);
}
const { error: profileError } = await db
  .from("profiles")
  .upsert({ id: data.user.id, display_name: displayName, role, active: true });
await mkdir(".local", { recursive: true });
const path = `.local/account-${data.user.id}.json`;
await writeFile(
  path,
  JSON.stringify(
    { email, password, role, profileReady: !profileError },
    null,
    2,
  ),
  { mode: 0o600, flag: "wx" },
);
if (profileError) {
  console.error(
    "Auth account created, but profile setup failed. Saved credentials locally; repair profile before sign-in.",
  );
  process.exitCode = 1;
} else console.log("Account created. Credentials saved locally at", path);

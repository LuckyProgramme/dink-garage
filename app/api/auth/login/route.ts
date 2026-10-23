import { serverSupabase, isConfigured } from "@/lib/supabase-server";
import { json, readBody, sameOrigin } from "@/lib/http";
import { InputError } from "@/lib/validation";

export async function POST(request: Request) {
  if (!sameOrigin(request))
    return json({ error: "Request origin is not allowed." }, 403);
  if (!isConfigured())
    return json({ error: "Sign-in is not configured yet." }, 503);
  try {
    const body = await readBody(request);
    if (
      typeof body.email !== "string" ||
      body.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
      typeof body.password !== "string" ||
      body.password.length < 1 ||
      body.password.length > 128
    )
      throw new InputError("Enter a valid email and password.");
    const db = await serverSupabase();
    // Password attempts are rate-limited by Supabase Auth.
    const { data, error } = await db.auth.signInWithPassword({
      email: body.email.trim().toLowerCase(),
      password: body.password,
    });
    if (error || !data.user)
      return json(
        {
          error:
            error?.status === 429
              ? "Too many attempts. Please try again later."
              : "Unable to sign in. Check your email and password.",
        },
        error?.status === 429 ? 429 : 401,
      );
    const { data: profile } = await db
      .from("profiles")
      .select("role,active")
      .eq("id", data.user.id)
      .single();
    if (
      !profile?.active ||
      !data.user.email_confirmed_at ||
      !["admin", "player"].includes(profile.role)
    ) {
      await db.auth.signOut({ scope: "local" });
      return json(
        {
          error:
            "Your account is not ready. Please contact the venue administrator.",
        },
        403,
      );
    }
    if (body.admin === true && profile.role !== "admin") {
      await db.auth.signOut({ scope: "local" });
      return json(
        { error: "An administrator account is required for this sign-in." },
        403,
      );
    }
    return json({ redirect: profile.role === "admin" ? "/admin" : "/" });
  } catch (error) {
    return json(
      {
        error:
          error instanceof InputError
            ? error.message
            : "Sign-in is temporarily unavailable. Please try again.",
      },
      error instanceof InputError ? 400 : 503,
    );
  }
}

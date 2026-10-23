import { serverSupabase } from "@/lib/supabase-server";
import { json, sameOrigin } from "@/lib/http";
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return json({ error: "Request origin is not allowed." }, 403);
  try {
    const db = await serverSupabase();
    const { error } = await db.auth.signOut({ scope: "local" });
    if (error) return json({ error: "Unable to sign out. Please retry." }, 503);
    return json({ ok: true });
  } catch {
    return json({ error: "Unable to sign out. Please retry." }, 503);
  }
}

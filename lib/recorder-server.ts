import "server-only";
import { createClient } from "@supabase/supabase-js";
import { tokenHash } from "./recorder-protocol";
export function recorderDatabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Recorder service is not configured.");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
export function systemDatabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("System service is not configured.");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
export async function authenticateRecorder(request: Request) {
  const bearer = request.headers.get("authorization") || "";
  if (!/^Bearer cbrec_[A-Za-z0-9_-]{43}$/.test(bearer)) return null;
  const db = recorderDatabase();
  const { data, error } = await db
    .from("recorder_credentials")
    .select("recorder_id")
    .eq("token_hash", tokenHash(bearer.slice(7)))
    .maybeSingle();
  return error || !data ? null : { db, recorderId: data.recorder_id as string };
}

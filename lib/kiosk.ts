import "server-only";
import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import { recorderDatabase } from "./recorder-server";
export const kioskCookie = "cb-kiosk";
export const hashKiosk = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function kioskDevice() {
  const token = (await cookies()).get(kioskCookie)?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { data, error } = await recorderDatabase()
    .from("kiosk_devices")
    .select("id,current_session_id")
    .eq("token_hash", hashKiosk(token))
    .eq("active", true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

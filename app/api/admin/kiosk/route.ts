import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { getAccount } from "@/lib/auth";
import { recorderDatabase } from "@/lib/recorder-server";
import { kioskCookie, hashKiosk, kioskDevice } from "@/lib/kiosk";
import { json, readBody, sameOrigin } from "@/lib/http";
export async function GET() {
  const { account } = await getAccount();
  if (account?.role !== "admin")
    return json({ error: "Administrator sign-in required." }, 403);
  try {
    return json({ enabled: !!(await kioskDevice()) });
  } catch {
    return json({ error: "Tablet setup unavailable." }, 503);
  }
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  const { account } = await getAccount();
  if (account?.role !== "admin")
    return json({ error: "Administrator sign-in required." }, 403);
  try {
    const body = await readBody(request);
    if (!["enable", "disable"].includes(String(body.action)))
      return json({ error: "Unknown action." }, 400);
    const db = recorderDatabase(),
      existing = await kioskDevice();
    if (existing && body.action === "enable") return json({ enabled: true });
    if (existing) {
      const result = await db
        .from("kiosk_devices")
        .update({ active: false })
        .eq("id", existing.id);
      if (result.error) throw result.error;
    }
    const store = await cookies();
    if (body.action === "disable") {
      store.delete(kioskCookie);
      return json({ enabled: false });
    }
    const token = randomBytes(32).toString("base64url");
    const created = await db
      .from("kiosk_devices")
      .insert({ token_hash: hashKiosk(token), created_by: account.id });
    if (created.error) throw created.error;
    store.set(kioskCookie, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 24 * 180,
    });
    return json({ enabled: true });
  } catch {
    return json({ error: "Could not update tablet setup." }, 503);
  }
}

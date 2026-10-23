import { getAccount } from "@/lib/auth";
import { json, sameOrigin } from "@/lib/http";
import { checkDriveHealth, driveMessages, googleConfig } from "@/lib/google-server";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({error:"Invalid origin."},403);
  const {account} = await getAccount();
  if (account?.role !== "admin") return json({error:"Administrator access required."},403);
  const health = await checkDriveHealth(true);
  let redirect = "";
  try { redirect = googleConfig().redirect; } catch { /* reported by health */ }
  return json({...health,redirect,message:health.ready ? "Google Drive connected. Folder access checked." : driveMessages[health.code] || "Google Drive could not be checked. Retry before starting a recording."});
}

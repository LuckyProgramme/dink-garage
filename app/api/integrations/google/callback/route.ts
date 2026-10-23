import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAccount } from "@/lib/auth";
import { recorderDatabase } from "@/lib/recorder-server";
import { googleConfig, googleToken } from "@/lib/google-server";
import { encryptSecret } from "@/lib/google-crypto";
import { DriveError, GoogleDrive } from "@/lib/google-drive";
import { GMAIL_SEND_SCOPE } from "@/lib/gmail";
export async function GET(request: NextRequest) {
  const config = googleConfig();
  const back = new URL("/admin",config.redirect);
  let result = "google_connection_failed";
  try {
    const {account} = await getAccount();
    const state = request.nextUrl.searchParams.get("state") || "";
    const cookie = request.cookies.get("cb_google_state")?.value || "";
    if (account?.role !== "admin" || state.length !== 43 || cookie.length !== 43 || !timingSafeEqual(Buffer.from(state),Buffer.from(cookie))) throw new Error("Invalid OAuth state");
    const db = recorderDatabase();
    const {data,error} = await db.from("google_oauth_states").delete().eq("state_hash",createHash("sha256").update(state).digest("hex")).eq("admin_id",account.id).gt("expires_at",new Date().toISOString()).select("admin_id").maybeSingle();
    if (error || !data) throw new Error("Expired OAuth state");
    const code = request.nextUrl.searchParams.get("code");
    if (!code) throw new Error("Authorization cancelled");
    const tokens = await googleToken({code,grant_type:"authorization_code",redirect_uri:config.redirect});
    const drive = new GoogleDrive(tokens.access_token);
    const identity = await drive.call("about?fields=user(emailAddress)");
    if (identity.user?.emailAddress?.toLowerCase() !== config.owner.toLowerCase()) throw new DriveError("wrong_google_account");
    await drive.privateFolder(config.root,config.owner);
    if (!tokens.refresh_token) throw new DriveError("google_reconnect_required");
    const previous = await db.from("google_integration").select("connected_at,owner_email,root_folder_id,gmail_authorized_at").eq("id",true).maybeSingle();
    if (previous.error) throw previous.error;
    const connectedAt = previous.data?.owner_email === config.owner && previous.data?.root_folder_id === config.root ? previous.data.connected_at : new Date().toISOString();
    const gmailGranted=String(tokens.scope || "").split(" ").includes(GMAIL_SEND_SCOPE);
    const gmailAt=gmailGranted ? (previous.data?.owner_email===config.owner ? previous.data.gmail_authorized_at : null) || new Date().toISOString() : null;
    const saved = await db.from("google_integration").upsert({id:true,owner_email:config.owner,root_folder_id:config.root,refresh_token_encrypted:encryptSecret(tokens.refresh_token),connected_at:connectedAt,safe_error:null,gmail_authorized_at:gmailAt});
    if (saved.error) throw saved.error;
    result = "connected";
  } catch (e) { if (e instanceof DriveError) result=e.code; }
  back.searchParams.set("google",result);
  const response = NextResponse.redirect(back,303);
  response.cookies.set("cb_google_state","",{maxAge:0,path:"/api/integrations/google"});
  return response;
}

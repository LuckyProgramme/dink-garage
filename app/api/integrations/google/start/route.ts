import { randomBytes, createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getAccount } from "@/lib/auth";
import { json, sameOrigin } from "@/lib/http";
import { googleConfig } from "@/lib/google-server";
import { recorderDatabase } from "@/lib/recorder-server";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({error:"Invalid origin."},403);
  const {account} = await getAccount();
  if (account?.role !== "admin") return json({error:"Administrator access required."},403);
  try {
    const config = googleConfig();
    if (new URL(config.redirect).origin !== request.headers.get("origin"))
      return json({error:`Open the admin dashboard at ${new URL(config.redirect).origin} before connecting Google.`},400);
    const state = randomBytes(32).toString("base64url");
    const db = recorderDatabase();
    const {error} = await db.from("google_oauth_states").insert({state_hash:createHash("sha256").update(state).digest("hex"),admin_id:account.id,expires_at:new Date(Date.now()+600000).toISOString()});
    if (error) throw error;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirect,response_type:"code",scope:"https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.send",access_type:"offline",prompt:"consent",state,login_hint:config.owner}).toString();
    const response = NextResponse.redirect(url,303);
    response.cookies.set("cb_google_state",state,{httpOnly:true,sameSite:"lax",secure:new URL(config.redirect).protocol === "https:",maxAge:600,path:"/api/integrations/google"});
    return response;
  } catch { return json({error:"Google connection could not start. Check the server configuration."},503); }
}

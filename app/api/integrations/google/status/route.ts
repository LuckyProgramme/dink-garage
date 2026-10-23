import { getAccount } from "@/lib/auth";
import { json } from "@/lib/http";
import { recorderDatabase } from "@/lib/recorder-server";
import { googleConfig, driveMessages } from "@/lib/google-server";
export async function GET() {
  const {account}=await getAccount();
  if (account?.role!=="admin") return json({error:"Administrator access required."},403);
  let configured=true,redirect="";
  try { redirect=googleConfig().redirect; } catch { configured=false; }
  const db=recorderDatabase();
  const [integration,jobs]=await Promise.all([
    db.from("google_integration").select("owner_email,root_folder_id,connected_at,safe_error").eq("id",true).maybeSingle(),
    db.from("drive_upload_jobs").select("file_id,status,attempts,safe_error,next_attempt_at,recording_files(session_id,status)").order("created_at",{ascending:false}).limit(50),
  ]);
  if (integration.error || jobs.error) return json({error:"Drive database setup is unavailable."},503);
  return json({configured,redirect,integration:integration.data,jobs:(jobs.data || []).map(j=>({...j,message:j.safe_error ? driveMessages[j.safe_error] || "Upload paused. Retry or ask the administrator to check Google access." : null}))});
}

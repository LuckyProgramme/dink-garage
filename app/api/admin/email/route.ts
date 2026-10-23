import { after } from "next/server";
import { getAccount } from "@/lib/auth";
import { json, sameOrigin, readBody } from "@/lib/http";
import { recorderDatabase } from "@/lib/recorder-server";
import { deliverNextEmail } from "@/lib/email-server";
import { uuid } from "@/lib/validation";
export const maxDuration = 60;
export async function GET() {
  const {account}=await getAccount();
  if (account?.role!=="admin") return json({error:"Administrator access required."},403);
  const db=recorderDatabase();
  const [jobs,integration,files]=await Promise.all([
    db.from("email_jobs").select("file_id,status,attempts,safe_error,sent_at,next_attempt_at,recording_files(session_id,recording_sessions(recipient_email,configuration_snapshot))").order("created_at",{ascending:false}).limit(50),
    db.from("google_integration").select("gmail_authorized_at,owner_email").eq("id",true).maybeSingle(),
    db.from("recording_files").select("id,session_id,recording_sessions(recipient_email,configuration_snapshot)").eq("status","ready").is("deleted_at",null).gt("expires_at",new Date().toISOString()).order("uploaded_at",{ascending:false}).limit(50),
  ]);
  if (jobs.error || integration.error || files.error) return json({error:"Email status unavailable."},503);
  return json({jobs:jobs.data,files:files.data,integration:integration.data});
}
export async function POST(request:Request) {
  if (!sameOrigin(request)) return json({error:"Invalid origin."},403);
  const {account}=await getAccount();
  if (account?.role!=="admin") return json({error:"Administrator access required."},403);
  try {
    const body=await readBody(request),id=uuid(body.file_id),db=recorderDatabase();
    const integration=await db.from("google_integration").select("gmail_authorized_at").eq("id",true).maybeSingle();
    if (!integration.data?.gmail_authorized_at) return json({error:"Connect Gmail sending permission first."},409);
    const file=await db.from("recording_files").select("session_id").eq("id",id).eq("status","ready").is("deleted_at",null).gt("expires_at",new Date().toISOString()).maybeSingle();
    if (!file.data) return json({error:"Recording unavailable or expired."},409);
    const capture=await db.from("capture_jobs").select("recorder_id").eq("session_id",file.data.session_id).maybeSingle();
    if (capture.error) throw capture.error;
    const inserted=await db.from("email_jobs").upsert({file_id:id,recorder_id:capture.data?.recorder_id||null},{onConflict:"file_id",ignoreDuplicates:true});
    if (inserted.error) throw inserted.error;
    // Only definitely failed sends may be retried. Sent/ambiguous/live jobs are protected.
    const retry=await db.from("email_jobs").update({status:"pending",attempts:0,safe_error:null,next_attempt_at:new Date().toISOString(),lease_until:null}).eq("file_id",id).eq("status","failed");
    if (retry.error) throw retry.error;
    const state=await db.from("email_jobs").select("status").eq("file_id",id).single();
    if (state.error) throw state.error;
    if (state.data.status === "pending") {
      after(async () => {
        await deliverNextEmail(capture.data?.recorder_id || undefined,id);
      });
      return json({ok:true});
    }
    return json({error:"This email is already processing, sent, or needs manual review. It was not resent."},409);
  } catch { return json({error:"Could not queue email."},400); }
}

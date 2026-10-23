import { getAccount } from "@/lib/auth";
import { json, readBody, sameOrigin } from "@/lib/http";
import { recorderDatabase } from "@/lib/recorder-server";
import { uuid } from "@/lib/validation";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({error:"Invalid origin."},403);
  const {account}=await getAccount();
  if (account?.role!=="admin") return json({error:"Administrator access required."},403);
  try {
    const {session_id}=await readBody(request);
    const db=recorderDatabase();
    const file=await db.from("recording_files").select("id,session_id,status").eq("session_id",uuid(session_id)).in("status",["local_ready","sharing"]).single();
    const google=await db.from("google_integration").select("root_folder_id").eq("id",true).single();
    if (file.error || google.error) return json({error:"Connect Google first and select a completed local recording."},400);
    const capture=await db.from("capture_jobs").select("recorder_id").eq("session_id",file.data.session_id).eq("status","completed").single();
    if (capture.error) throw capture.error;
    const insert=await db.from("drive_upload_jobs").upsert({file_id:file.data.id,recorder_id:capture.data.recorder_id,root_id:google.data.root_folder_id},{onConflict:"file_id",ignoreDuplicates:true});
    if (insert.error) throw insert.error;
    const retried=await db.from("drive_upload_jobs").update({status:"pending",safe_error:null,attempts:0,next_attempt_at:new Date().toISOString()}).eq("file_id",file.data.id).eq("root_id",google.data.root_folder_id).in("status",["failed","pending"]).or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`).select("file_id").maybeSingle();
    if (retried.error || !retried.data) return json({error:"Upload is already active or belongs to a different Drive connection."},409);
    await db.from("recording_sessions").update({status:"uploading",failure_stage:null}).eq("id",file.data.session_id);
    await db.from("audit_events").insert({actor_id:account.id,session_id:file.data.session_id,action:"drive.queued"});
    return json({ok:true});
  } catch { return json({error:"Could not queue this recording."},400); }
}

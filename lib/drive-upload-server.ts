import "server-only";
import { connectedDrive } from "./google-server";
import { DriveError, localDay, recordingFileName } from "./google-drive";
import { decryptSecret, encryptSecret } from "./google-crypto";
import type { recorderDatabase } from "./recorder-server";
type DB = ReturnType<typeof recorderDatabase>;

export async function uploadJob(db: DB, recorder: string, fileId: string, token: string) {
  const {data:job,error} = await db.from("drive_upload_jobs").update({lease_until:new Date(Date.now()+180000).toISOString()})
    .eq("file_id",fileId).eq("recorder_id",recorder).eq("lease_token",token).gt("lease_until",new Date().toISOString())
    .in("status",["pending","uploading","sharing"]).select("*").maybeSingle();
  if (error || !job) throw new DriveError("upload_lease_expired");
  const file = await db.from("recording_files").select("*").eq("id",fileId).single();
  if (file.error) throw new DriveError("database_unavailable",true);
  const session = await db.from("recording_sessions").select("*").eq("id",file.data.session_id).single();
  if (session.error) throw new DriveError("database_unavailable",true);
  return {job,file:file.data,session:session.data};
}
export async function prepareUpload(db: DB, recorder: string, fileId: string, token: string, md5: string) {
  const {job,file,session}=await uploadJob(db,recorder,fileId,token);
  if (job.expected_md5 && job.expected_md5!==md5) throw new DriveError("upload_integrity_failed");
  const {drive,integration}=await connectedDrive();
  if (integration.root_folder_id!==job.root_id) throw new DriveError("google_reconnect_required");
  await drive.privateFolder(job.root_id,integration.owner_email);
  const settings=await db.from("venue_settings").select("venue_time_zone").eq("id",true).single();
  if (!settings.data?.venue_time_zone) throw new DriveError("venue_timezone_required");
  if (!job.folder_id) {
    const day=localDay(session.started_at || session.created_at,settings.data.venue_time_zone);
    let folder=await db.from("drive_folders").select("drive_id").eq("root_id",job.root_id).eq("day",day).maybeSingle();
    if (folder.error) throw folder.error;
    if (!folder.data) {
      const candidate=await drive.newId();
      const inserted=await db.from("drive_folders").upsert({root_id:job.root_id,day,drive_id:candidate},{onConflict:"root_id,day",ignoreDuplicates:true});
      if (inserted.error) throw inserted.error;
      folder=await db.from("drive_folders").select("drive_id").eq("root_id",job.root_id).eq("day",day).single();
    }
    if (!folder.data) throw new DriveError("database_unavailable",true);
    await drive.createFolder(folder.data.drive_id,job.root_id,day);
    job.folder_id=folder.data.drive_id;
  }
  await drive.privateFolder(job.folder_id,integration.owner_email);
  if (!job.drive_id) job.drive_id=await drive.newId();
  const saved=await db.from("drive_upload_jobs").update({drive_id:job.drive_id,folder_id:job.folder_id,expected_md5:md5,status:"uploading",safe_error:null})
    .eq("file_id",fileId).eq("lease_token",token).select("file_id").single();
  if (saved.error) throw new DriveError("upload_lease_expired");
  const sessionUpdate=await db.from("recording_sessions").update({status:"uploading",failure_stage:null}).eq("id",session.id);
  if (sessionUpdate.error) throw sessionUpdate.error;
  try {
    const remote=await drive.file(job.drive_id);
    if (remote.trashed || Number(remote.size)!==Number(file.bytes) || remote.md5Checksum!==md5 || !remote.parents?.includes(job.folder_id)) throw new DriveError("upload_integrity_failed");
    return {uploaded:true};
  } catch(e) { if (!(e instanceof DriveError) || e.code!=="drive_file_missing") throw e; }
  if (!job.upload_uri_encrypted) {
    let courtName=String(session.configuration_snapshot?.court_name || "").trim();
    if (session.court_id) {
      const court=await db.from("courts").select("name").eq("id",session.court_id).maybeSingle();
      if (court.error) throw new DriveError("database_unavailable",true);
      courtName=court.data?.name || courtName;
    }
    if (!courtName) throw new DriveError("database_unavailable",true);
    const uri=await drive.beginUpload(job.drive_id,job.folder_id,recordingFileName(session.started_at || session.created_at,settings.data.venue_time_zone,courtName,session.recipient_email,"mp4"),Number(file.bytes));
    const updated=await db.from("drive_upload_jobs").update({upload_uri_encrypted:encryptSecret(uri)}).eq("file_id",fileId).eq("lease_token",token);
    if (updated.error) throw updated.error;
    return {uri};
  }
  return {uri:decryptSecret(job.upload_uri_encrypted)};
}
export async function finishUpload(db: DB, recorder: string, fileId: string, token: string) {
  const {job,file,session}=await uploadJob(db,recorder,fileId,token);
  const {drive,integration}=await connectedDrive();
  if (!job.drive_id || !job.folder_id || integration.root_folder_id!==job.root_id) throw new DriveError("upload_not_prepared");
  await drive.privateFolder(job.root_id,integration.owner_email);
  await drive.privateFolder(job.folder_id,integration.owner_email);
  const remote=await drive.file(job.drive_id);
  if (remote.trashed || remote.mimeType!=="video/mp4" || Number(remote.size)!==Number(file.bytes) || remote.md5Checksum!==job.expected_md5 || !remote.parents?.includes(job.folder_id)) throw new DriveError("upload_integrity_failed");
  if (!file.uploaded_at) {
    const settings=await db.from("venue_settings").select("retention_seconds").eq("id",true).single();
    if (settings.error) throw settings.error;
    const now=Date.now();
    const saved=await db.from("recording_files").update({drive_file_id:job.drive_id,uploaded_at:new Date(now).toISOString(),expires_at:new Date(now+settings.data.retention_seconds*1000).toISOString(),status:"sharing"}).eq("id",fileId).is("uploaded_at",null);
    if (saved.error) throw saved.error;
  }
  const stage=await db.from("drive_upload_jobs").update({status:"sharing"}).eq("file_id",fileId).eq("lease_token",token);
  if (stage.error) throw stage.error;
  await db.from("recording_sessions").update({status:"sharing"}).eq("id",session.id);
  const permission=session.configuration_snapshot?.sharing_mode === "link" ? await drive.shareLink(job.drive_id,integration.owner_email) : await drive.share(job.drive_id,integration.owner_email,session.recipient_email);
  const final=await db.rpc("finish_drive_upload",{p_file:fileId,p_token:token,p_permission:permission});
  if (final.error || !final.data) throw new DriveError("upload_lease_expired");
  return {ready:true};
}
export async function failUpload(db: DB, recorder: string, fileId: string, token: string, error: unknown) {
  const code=error instanceof DriveError ? error.code : "google_temporarily_unavailable";
  const retryable=error instanceof DriveError ? error.retryable : true;
  const current=await db.from("drive_upload_jobs").select("attempts,status,recording_files(session_id)").eq("file_id",fileId).eq("recorder_id",recorder).eq("lease_token",token).gt("lease_until",new Date().toISOString()).in("status",["pending","uploading","sharing"]).maybeSingle();
  if (!current.data) return;
  const terminal=!retryable || current.data.attempts>=8;
  const result=await db.from("drive_upload_jobs").update({status:terminal?"failed":current.data.status,safe_error:code,lease_until:null,next_attempt_at:new Date(Date.now()+Math.min(3600000,15000*2**Math.min(current.data.attempts,8))).toISOString()})
    .eq("file_id",fileId).eq("recorder_id",recorder).eq("lease_token",token).select("file_id").maybeSingle();
  if (result.error || !result.data) return;
  const file=await db.from("recording_files").select("session_id").eq("id",fileId).single();
  if (file.data) {
    if (terminal) await db.from("recording_sessions").update({status:"failed",failure_stage:current.data.status==="sharing"?"sharing":"upload"}).eq("id",file.data.session_id);
    await db.from("audit_events").insert({session_id:file.data.session_id,action:terminal?"drive.failed":"drive.retry_scheduled",safe_detail:{code}});
  }
}

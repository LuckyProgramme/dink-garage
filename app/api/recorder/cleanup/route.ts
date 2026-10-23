import {authenticateRecorder} from '@/lib/recorder-server';
import {json,readBody} from '@/lib/http';
import {uuid} from '@/lib/validation';
import {connectedDrive} from '@/lib/google-server';
import {deleteExpiredVideo} from '@/lib/retention';
import {DriveError} from '@/lib/google-drive';
export const maxDuration=60;
export async function POST(request:Request) {
 const auth=await authenticateRecorder(request);
 if (!auth) return json({error:'Recorder authorization required.'},401);
 const {db,recorderId}=auth;
 let job:any;
 try {
  const body=await readBody(request);
  if(body.action==='complete' || body.action==='failed') {
   const id=uuid(body.file_id),token=uuid(body.token);
   const result=await db.from('cleanup_jobs').update(body.action==='complete'?{status:'done',local_deleted_at:new Date().toISOString(),safe_error:null,lease_until:null}:{safe_error:'local_cleanup_failed',lease_until:null,next_attempt_at:new Date(Date.now()+60000).toISOString()})
    .eq('file_id',id).eq('recorder_id',recorderId).eq('lease_token',token).eq('status','cloud_deleted').gt('lease_until',new Date().toISOString()).select('file_id').maybeSingle();
   return result.data?json({ok:true}):json({error:'Cleanup lease expired.'},409);
  }
  if(body.action!=='next') return json({error:'Unknown cleanup action.'},400);
  const claimed=await db.rpc('claim_cleanup',{p_recorder:recorderId});
  if(claimed.error) throw claimed.error;
  job=claimed.data?.[0];if(!job) return json({job:null});
  const f=await db.from('recording_files').select('session_id,local_filename,drive_file_id,expires_at').eq('id',job.file_id).single();
  if(f.error) throw f.error;
  if(job.status==='pending') {
   const upload=await db.from('drive_upload_jobs').select('drive_id,folder_id,root_id,status').eq('file_id',job.file_id).single();
   if(upload.error || upload.data.status!=='ready' || upload.data.drive_id!==f.data.drive_file_id) throw new DriveError('cleanup_identity_mismatch');
   const {drive,integration}=await connectedDrive();
   if(integration.root_folder_id!==upload.data.root_id) throw new DriveError('cleanup_connection_changed');
   await deleteExpiredVideo(drive,f.data,upload.data.folder_id,integration.owner_email);
   const finished=await db.rpc('confirm_cloud_cleanup',{p_file:job.file_id,p_token:job.lease_token});
   if(finished.error || !finished.data) throw new Error('lease expired');
  }
  return json({job:{file_id:job.file_id,token:job.lease_token,session_id:f.data.session_id,local_filename:f.data.local_filename}});
 } catch(e) {
  if(job) await db.from('cleanup_jobs').update({safe_error:e instanceof DriveError?e.code:'cleanup_service_unavailable',lease_until:null,next_attempt_at:new Date(Date.now()+Math.min(3600000,30000*2**Math.min(job.attempts,7))).toISOString()}).eq('file_id',job.file_id).eq('lease_token',job.lease_token);
  return json({error:'Cleanup will retry automatically.'},503);
 }
}

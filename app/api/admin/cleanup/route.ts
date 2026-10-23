import {getAccount} from '@/lib/auth';
import {json} from '@/lib/http';
import {recorderDatabase} from '@/lib/recorder-server';
export async function GET() {
 const {account}=await getAccount();
 if(account?.role!=='admin') return json({error:'Administrator access required.'},403);
 const result=await recorderDatabase().from('cleanup_jobs').select('file_id,status,attempts,safe_error,next_attempt_at,cloud_deleted_at,local_deleted_at,recording_files(session_id,expires_at)').order('created_at',{ascending:false}).limit(50);
 const browser=await recorderDatabase().from('browser_recordings').select('session_id,file_id,safe_error,recording_files!inner(status,expires_at,deleted_at)').lte('recording_files.expires_at',new Date().toISOString()).limit(50);
 return result.error||browser.error?json({error:'Cleanup status unavailable.'},503):json({jobs:[...result.data,...(browser.data||[]).map((b:any)=>({file_id:b.file_id,status:b.recording_files.deleted_at?'done':'pending',attempts:0,safe_error:b.safe_error,next_attempt_at:new Date(Date.now()+60000).toISOString(),recording_files:{session_id:b.session_id},browser:true}))]});
}

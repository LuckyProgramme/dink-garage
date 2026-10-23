import { authenticateRecorder } from "@/lib/recorder-server";
import { json, readBody } from "@/lib/http";
import { uuid, InputError } from "@/lib/validation";
import { prepareUpload, finishUpload, uploadJob, failUpload } from "@/lib/drive-upload-server";
import { DriveError } from "@/lib/google-drive";
export const maxDuration = 60;
export async function POST(request: Request) {
  const auth=await authenticateRecorder(request);
  if (!auth) return json({error:"Recorder authorization required."},401);
  let id="",token="";
  try {
    const body=await readBody(request);
    if (body.action==="next") {
      const claimed=await auth.db.rpc("claim_drive_upload",{p_recorder:auth.recorderId});
      if (claimed.error) throw claimed.error;
      const job=claimed.data?.[0];
      if (!job) return json({job:null});
      const file=await auth.db.from("recording_files").select("session_id,bytes,local_filename").eq("id",job.file_id).single();
      if (file.error) throw file.error;
      return json({job:{file_id:job.file_id,token:job.lease_token,...file.data}});
    }
    id=uuid(body.file_id); token=uuid(body.token);
    if (body.action==="prepare") {
      if (typeof body.md5!=="string" || !/^[a-f0-9]{32}$/.test(body.md5)) throw new InputError("Invalid file checksum.");
      return json(await prepareUpload(auth.db,auth.recorderId,id,token,body.md5));
    }
    if (body.action==="finish") return json(await finishUpload(auth.db,auth.recorderId,id,token));
    if (body.action==="renew" || body.action==="reset") {
      await uploadJob(auth.db,auth.recorderId,id,token);
      if (body.action==="reset") {
        const r=await auth.db.from("drive_upload_jobs").update({upload_uri_encrypted:null}).eq("file_id",id).eq("lease_token",token);
        if (r.error) throw r.error;
      }
      return json({ok:true});
    }
    if (body.action==="failed") {
      await uploadJob(auth.db,auth.recorderId,id,token);
      const code=body.code==="local_file_missing"?"local_file_missing":"google_temporarily_unavailable";
      await failUpload(auth.db,auth.recorderId,id,token,new DriveError(code,code!=="local_file_missing"));
      return json({ok:true});
    }
    throw new InputError("Unknown upload action.");
  } catch(e) {
    if (id && token && !(e instanceof InputError)) await failUpload(auth.db,auth.recorderId,id,token,e);
    return json({error:e instanceof DriveError?e.code:e instanceof InputError?e.message:"upload_service_unavailable"},e instanceof InputError?400:409);
  }
}

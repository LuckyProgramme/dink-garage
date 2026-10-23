import {GoogleDrive,DriveError,driveId} from './google-drive';
export async function deleteExpiredVideo(drive:GoogleDrive,file:{drive_file_id:string;expires_at:string},folder:string,owner:string) {
  if (!Number.isFinite(Date.parse(file.expires_at)) || Date.parse(file.expires_at)>Date.now()) throw new DriveError('recording_not_expired');
  const id=driveId(file.drive_file_id);
  try {
    const remote=await drive.file(id);
    if (!['video/mp4','video/webm'].includes(remote.mimeType) || !remote.parents?.includes(folder) || !remote.owners?.some((o:{emailAddress:string})=>o.emailAddress?.toLowerCase()===owner.toLowerCase()))
      throw new DriveError('cleanup_identity_mismatch');
    await drive.call(`files/${id}`,{method:'DELETE'});
  } catch(e) {
    // Retrying after a lost DELETE response is safe; absent files are already gone.
    if (!(e instanceof DriveError) || e.code!=='drive_file_missing') throw e;
  }
}

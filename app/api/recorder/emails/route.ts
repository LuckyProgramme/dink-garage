import { authenticateRecorder } from "@/lib/recorder-server";
import { json } from "@/lib/http";
import { deliverNextEmail } from "@/lib/email-server";
export const maxDuration=60;
export async function POST(request:Request) {
  const auth=await authenticateRecorder(request);
  if (!auth) return json({error:"Recorder authorization required."},401);
  try { await deliverNextEmail(auth.recorderId); return json({ok:true}); }
  catch { return json({error:"Email service temporarily unavailable."},503); }
}

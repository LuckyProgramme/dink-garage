import { getAccount } from "@/lib/auth";
import { serverSupabase } from "@/lib/supabase-server";
import { json } from "@/lib/http";
import { uuid } from "@/lib/validation";
import { driveId } from "@/lib/google-drive";
import { NextResponse } from "next/server";
export async function GET(_request: Request, context: {params:Promise<{id:string}>}) {
  const {account}=await getAccount();
  if (!account) return json({error:"Please sign in."},401);
  try {
    const db=await serverSupabase();
    const file=await db.from("recording_files").select("drive_file_id").eq("session_id",uuid((await context.params).id)).eq("status","ready").is("deleted_at",null).gt("expires_at",new Date().toISOString()).single();
    if (file.error || !file.data.drive_file_id) return json({error:"Recording is unavailable or its viewing period has ended."},404);
    const response=NextResponse.redirect(`https://drive.google.com/file/d/${driveId(file.data.drive_file_id)}/view`,303);
    response.headers.set("Cache-Control","private, no-store");
    return response;
  } catch { return json({error:"Recording is unavailable."},404); }
}

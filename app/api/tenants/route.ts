import { cookies } from "next/headers";
import { getAccount } from "@/lib/auth";
import { recorderDatabase, systemDatabase } from "@/lib/recorder-server";
import { json, readBody, sameOrigin } from "@/lib/http";
import { InputError, text, uuid } from "@/lib/validation";
import { TENANT_COOKIE } from "@/lib/tenant-scope";

async function selectTenant(id: string) {
  (await cookies()).set(TENANT_COOKIE,id,{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",path:"/",maxAge:180*86400});
}
export async function GET() {
  const {account} = await getAccount();
  if (!account) return json({error:"Sign in first."},401);
  if (account.role!=="admin") {
    const tenants = account.tenants || [];
    const current = account.tenantId || null;
    return json({tenants,current});
  }
  const db=recorderDatabase();
  const [locations,members,google,usage,limits] = await Promise.all([
    db.from("locations").select("id,name,active").order("name"),
    db.from("tenant_memberships").select("user_id,role,active,profiles(display_name)").order("created_at"),
    db.from("tenant_google_settings").select("owner_email,root_folder_id").maybeSingle(),
    db.rpc("tenant_storage_usage"),
    db.from("tenants").select("max_devices,max_courts,storage_limit_bytes").eq("id",account.tenantId).single(),
  ]);
  if (locations.error || members.error || google.error || usage.error || limits.error) return json({error:"Tenant settings unavailable."},503);
  return json({tenants:account.tenants,current:account.tenantId,locations:locations.data,members:members.data,
    google:google.data,storageBytes:Number(usage.data || 0),limits:limits.data});
}
export async function POST(request:Request) {
  if (!sameOrigin(request)) return json({error:"Invalid origin."},403);
  const {account}=await getAccount();
  if (!account) return json({error:"Sign in first."},401);
  try {
    const body=await readBody(request);
    if (body.action==="switch") {
      const id=uuid(body.tenant_id);
      const tenants = account.tenants || [];
      if (!tenants.some((tenant)=>tenant.id===id)) return json({error:"Tenant access denied."},403);
      await selectTenant(id);
      return json({ok:true});
    }
    if (body.action==="create") {
      const name=text(body.name,"Tenant name"),slug=String(body.slug||"").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) throw new InputError("Use 2–63 lowercase letters, numbers or hyphens for the tenant address.");
      const created=await systemDatabase().rpc("register_tenant",{p_owner:account.id,p_name:name,p_slug:slug});
      if (created.error) return json({error:created.error.code==="23505"?"That tenant address is already in use.":"Tenant registration failed or its daily limit was reached."},409);
      await selectTenant(created.data);
      return json({ok:true,id:created.data});
    }
    if (account.role!=="admin" || !account.tenantId) return json({error:"Tenant administrator required."},403);
const db=recorderDatabase();
    if (body.action==="membership") {
      const email=String(body.email||"").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254 || !["admin","player"].includes(String(body.role)) || typeof body.active!=="boolean") throw new InputError("Enter a valid account email and role.");
      const result=await db.rpc("set_tenant_member",{p_tenant:account.tenantId,p_actor:account.id,p_email:email,p_role:body.role,p_active:body.active});
      if (result.error) return json({error:result.error.code==="P0001"?result.error.message:"Membership could not be updated."},409);
    } else if (body.action==="location") {
      const values={name:text(body.name,"Location",150),active:body.active!==false};
      const result=body.id?await db.from("locations").update(values).eq("id",uuid(body.id)).select("id").single():await db.from("locations").insert(values).select("id").single();
      if (result.error) return json({error:"Location unavailable or that name is already in use."},409);
    } else if (body.action==="google") {
      const owner=String(body.owner_email||"").trim().toLowerCase(), root=String(body.root_folder_id||"").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner) || owner.length>254 || !/^[A-Za-z0-9_-]{8,200}$/.test(root)) throw new InputError("Enter the Google owner's email and a valid private Drive folder ID.");
      const old=await db.from("google_integration").select("owner_email,root_folder_id").maybeSingle();
      if (old.error) throw old.error;
      if (old.data && (old.data.owner_email!==owner || old.data.root_folder_id!==root))
        return json({error:"Changing an established Drive owner or root needs a coordinated recording and retention migration. Existing credentials were kept."},409);
      const saved=await db.from("tenant_google_settings").upsert({owner_email:owner,root_folder_id:root},{onConflict:"tenant_id"});
      if (saved.error) return json({error:"Folder is already assigned or settings could not be saved."},409);
    } else if (body.action==="limits" && account.isSuperAdmin) {
      const limit=(value:unknown) => value===null?null:typeof value==="number"&&Number.isSafeInteger(value)&&value>0?value:undefined;
      const values={max_devices:limit(body.max_devices),max_courts:limit(body.max_courts),storage_limit_bytes:limit(body.storage_limit_bytes)};
      if (Object.values(values).some(value=>value===undefined)) throw new InputError("Limits must be positive integers or null.");
      const result=await systemDatabase().from("tenants").update(values).eq("id",account.tenantId);
      if (result.error) throw result.error;
    } else throw new InputError("Unknown tenant action.");
    return json({ok:true});
  } catch(error) {
    return json({error:error instanceof InputError?error.message:"Tenant request failed. Please retry."},error instanceof InputError?400:503);
  }
}

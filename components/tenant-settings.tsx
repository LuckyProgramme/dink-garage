"use client";
import { useEffect,useState,type FormEvent } from "react";
import type { Account } from "@/lib/auth";

type Details={locations?:{id:string;name:string;active:boolean}[];members?:{user_id:string;role:string;active:boolean;profiles:{display_name:string}}[];google?:{owner_email:string;root_folder_id:string};storageBytes?:number;limits?:{max_devices:number|null;max_courts:number|null;storage_limit_bytes:number|null}};
export default function TenantSettings({account}:{account:Account}) {
  const [details,setDetails]=useState<Details>({}),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
  async function load(){const response=await fetch("/api/tenants",{cache:"no-store"});const data=await response.json();if(!response.ok)throw Error(data.error);setDetails(data);}
  useEffect(()=>{void load().catch(error=>setMessage(error.message));},[]);
  async function submit(event:FormEvent<HTMLFormElement>,action:string){
    event.preventDefault();if(busy)return;setBusy(true);setMessage("");
    const values=Object.fromEntries(new FormData(event.currentTarget));
    const limits=action==="limits"?Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value===""?null:Number(value)])):{};
    try {
      const response=await fetch("/api/tenants",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...values,...limits,action,...(action==="membership"?{active:values.active==="true"}:{})})});
      const result=await response.json();if(!response.ok)throw Error(result.error);
      if(action==="switch"||action==="create"){window.location.assign("/tenants");return;}
      await load();setMessage("Saved.");
    }catch(error){setMessage(error instanceof Error?error.message:"Could not save. Please retry.");}finally{setBusy(false);}
  }
  return <div className="admin-grid">
    {message&&<p role="status">{message}</p>}
    {account.tenants && account.tenants.length > 0 && <section className="admin-card"><h2>Current tenant</h2><form onSubmit={event=>void submit(event,"switch")}><label>Tenant<select name="tenant_id" defaultValue={account.tenantId || ""}>{account.tenants?.map(tenant=><option key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.role}</option>)}</select></label><button className="primary" disabled={busy}>Switch tenant</button></form><p><a href="/admin">Open dashboard</a></p></section>}
    <section className="admin-card"><h2>Register a tenant</h2><form onSubmit={event=>void submit(event,"create")}><label>Business name<input name="name" required maxLength={100}/></label><label>Tenant address<input name="slug" required minLength={2} maxLength={63} pattern="[a-z0-9][a-z0-9-]+" placeholder="your-club"/></label><button className="primary" disabled={busy}>Create tenant</button></form><p>Each tenant has its own courts, devices, recordings and Google connection.</p></section>
    {account.role==="admin"&&<>
      <section className="admin-card"><h2>Locations</h2><ul>{details.locations?.map(location=><li key={location.id}>{location.name}{!location.active&&" · inactive"}</li>)}</ul><form onSubmit={event=>void submit(event,"location")}><label>Location name<input name="name" required maxLength={150}/></label><button className="primary" disabled={busy}>Add location</button></form><p>Choose the location when registering a court.</p></section>
      <section className="admin-card"><h2>Team access</h2><ul>{details.members?.map(member=><li key={member.user_id}>{member.profiles?.display_name||member.user_id} · {member.role}{!member.active&&" · access removed"}</li>)}</ul><form onSubmit={event=>void submit(event,"membership")}><label>Existing account email<input name="email" type="email" required/></label><label>Role<select name="role"><option value="player">Player</option><option value="admin">Tenant administrator</option></select></label><label>Access<select name="active"><option value="true">Enabled</option><option value="false">Removed</option></select></label><button className="primary" disabled={busy}>Save membership</button></form><p>The account must already be registered. Removing membership leaves recording history intact.</p></section>
      <section className="admin-card"><h2>Google Drive and email</h2><form key={details.google?.root_folder_id||"new"} onSubmit={event=>void submit(event,"google")}><label>Google owner email<input name="owner_email" type="email" required defaultValue={details.google?.owner_email}/></label><label>Private Drive folder ID<input name="root_folder_id" required defaultValue={details.google?.root_folder_id}/></label><button className="primary" disabled={busy}>Save connection settings</button></form><p>Then connect this tenant's Google account from the dashboard settings.</p><p>Stored or reserved video data: {((details.storageBytes||0)/1024**3).toFixed(2)} GiB.</p></section>
      {(account.isSuperAdmin ?? false)&&<section className="admin-card"><h2>Tenant limits</h2><form key={JSON.stringify(details.limits)} onSubmit={event=>void submit(event,"limits")}>
        <label>Maximum courts<input name="max_courts" type="number" min={1} step={1} defaultValue={details.limits?.max_courts||""}/></label>
        <label>Maximum devices<input name="max_devices" type="number" min={1} step={1} defaultValue={details.limits?.max_devices||""}/></label>
        <label>Storage limit in bytes<input name="storage_limit_bytes" type="number" min={1} step={1} defaultValue={details.limits?.storage_limit_bytes||""}/></label>
        <p>Leave a limit empty for unlimited. Lower limits preserve existing data and restrict new allocations.</p><button className="primary" disabled={busy}>Save limits</button>
      </form></section>}
    </>}
  </div>;
}

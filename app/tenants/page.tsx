import { redirect } from "next/navigation";
import { getAccount } from "@/lib/auth";
import AccountControls from "@/components/account-controls";
import TenantSettings from "@/components/tenant-settings";

export default async function TenantsPage() {
  const {account}=await getAccount();
  if (!account) redirect("/admin/login?next=/tenants");
  return <>
    <header className="site-header shell"><a className="brand" href="/"><img src="/dink-vision-logo.png" alt="DinkVision"/><span>Tenant management</span></a><AccountControls account={account}/></header>
    <main className="shell admin-main"><div className="eyebrow">DINKVISION</div><h1>{account.tenantName || "Set up your tenant"}</h1>
      <p>Manage your locations, team access and Google connection.</p><TenantSettings account={account}/></main>
  </>;
}

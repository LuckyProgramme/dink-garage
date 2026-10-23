import { redirect } from "next/navigation";
import { getAccount } from "@/lib/auth";
import { serverSupabase } from "@/lib/supabase-server";
import AdminDashboard from "@/components/admin-dashboard";
import AccountControls from "@/components/account-controls";
import AppVersionFooter from "@/components/app-version-footer";
import type { AdminData } from "@/lib/admin-types";

// The dashboard is a live operational view. Do not let the route cache an
// earlier recording state between client refreshes.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminPage() {
  const { account } = await getAccount();
  if (!account) redirect("/admin/login");
  if (account.role !== "admin")
    return (
      <main className="auth-page">
        <section className="auth-card">
          <h1>Administrator access required.</h1>
          <p>Your player account does not have access to venue settings.</p>
          <a href="/" className="primary">
            Back to your courts
          </a>
        </section>
      </main>
    );
  const db = await serverSupabase();
  const [
    courts,
    cameras,
    recorders,
    settings,
    sessions,
    events,
    devices,
    commands,
  ] = await Promise.all([
    db.from("courts").select("id,name,location,active").order("created_at"),
    db
      .from("cameras")
      .select(
        "id,name,recorder_id,court_id,source_type,device_reference,audio_source,is_primary,enabled,health,last_health_check_at",
      )
      .order("name"),
    db
      .from("recorders")
      .select(
        "id,name,last_seen_at,paired_at,agent_version,platform,ffmpeg_available",
      )
      .order("created_at"),
    db
      .from("venue_settings")
      .select("max_duration_seconds,retention_seconds,venue_time_zone")
      .eq("id", true)
      .single(),
    db
      .from("recording_sessions")
      .select(
        "id,court_id,status,recipient_email,created_at,started_at,stopped_at,stop_reason,failure_stage,configuration_snapshot",
      )
      .order("created_at", { ascending: false })
      .limit(100),
    db
      .from("audit_events")
      .select("id,action,created_at")
      .order("created_at", { ascending: false })
      .limit(20),
    db
      .from("recorder_devices")
      .select(
        "id,recorder_id,device_reference,name,source_type,health,diagnostic,last_test_at,audio_sources",
      )
      .order("name"),
    db
      .from("recorder_commands")
      .select("id,recorder_id,kind,status,created_at,result_code")
      .order("created_at", { ascending: false })
      .limit(30),
  ]);
  const failed = [
    courts,
    cameras,
    recorders,
    settings,
    sessions,
    events,
    devices,
    commands,
  ].some((result) => result.error);
  return (
    <>
      <header className="site-header shell">
        <a href="/" className="brand">
          <img src="/dink-vision-logo.png" alt="Dink Vision" />
          <span>
            Venue Management
          </span>
        </a>
        <AccountControls account={account} />
      </header>
      {failed ? (
        <main className="shell admin-main">
          <div className="empty-panel">
            <h2>Database setup needs attention.</h2>
            <p>
              The admin tables could not be loaded. Apply the project
              migrations, then reload this page.
            </p>
            <a className="primary" href="/admin">
              Reload dashboard
            </a>
          </div>
        </main>
      ) : (
        <AdminDashboard
          data={
            {
              courts: courts.data,
              cameras: cameras.data,
              recorders: recorders.data,
              settings: settings.data,
              sessions: sessions.data,
              events: events.data,
              devices: devices.data,
              commands: commands.data,
            } as AdminData
          }
        />
      )}
      <AppVersionFooter />
    </>
  );
}

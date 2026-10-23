export const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001";
export const TENANT_COOKIE = "dinkvision-tenant";
export const TENANT_HEADER = "x-dinkvision-tenant-id";
export const tenantTables = new Set([
  "venue_settings", "courts", "recorders", "cameras", "recording_sessions",
  "recording_files", "delivery_attempts", "audit_events", "recorder_credentials",
  "recorder_devices", "recorder_commands", "capture_jobs", "google_integration",
  "google_oauth_states", "drive_folders", "drive_upload_jobs", "email_jobs",
  "cleanup_jobs", "kiosk_devices", "browser_devices", "browser_recordings",
  "locations", "tenant_google_settings", "tenant_memberships",
]);

export function tenantId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new Error("Select an authorized tenant first.");
  return value.toLowerCase();
}

// Service-role clients bypass PostgreSQL RLS on table requests. Add a mandatory
// scope at the transport boundary as well as checking permissions in each route.
// RPCs carry the same context and execute as a NOLOGIN role that obeys RLS.
export function scopedFetch(scope: string, transport: typeof fetch = fetch): typeof fetch {
  const id = tenantId(scope);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/rest/v1/")) return transport(request);
    const headers = new Headers(request.headers);
    headers.set(TENANT_HEADER, id);
    const table = decodeURIComponent(url.pathname.slice("/rest/v1/".length));
    if (!tenantTables.has(table) && !table.startsWith("rpc/") && table !== "tenants")
      throw new Error("Unknown table needs an explicit tenant isolation policy.");
    if(table==="tenants") {
      if(!["GET","HEAD"].includes(request.method))throw new Error("Tenant provisioning requires an authorized system operation.");
      if(url.searchParams.getAll("id").some(value=>value!==`eq.${id}`))throw new Error("Tenant scope mismatch.");
      url.searchParams.set("id",`eq.${id}`);
    }
    let body: string | undefined;
    if (tenantTables.has(table)) {
      const requested = url.searchParams.getAll("tenant_id");
      if (requested.some(value => value !== `eq.${id}`)) throw new Error("Tenant scope mismatch.");
      url.searchParams.set("tenant_id", `eq.${id}`);
      if (["POST", "PATCH"].includes(request.method)) {
        const data = await request.json();
        const scoped = (row: Record<string, unknown>) => {
          if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid tenant record.");
          if (row.tenant_id != null && row.tenant_id !== id) throw new Error("Tenant scope mismatch.");
          return request.method === "POST" ? {...row, tenant_id: id} : row;
        };
        body = JSON.stringify(Array.isArray(data) ? data.map(scoped) : scoped(data));
        // Supabase can provide an explicit columns list for bulk inserts.
        if (url.searchParams.has("columns")) {
          const columns = url.searchParams.get("columns")!;
          if (!columns.includes('"tenant_id"')) url.searchParams.set("columns", `${columns},"tenant_id"`);
        }
      }
    }
    return transport(new Request(url, {
      method: request.method, headers, signal: request.signal,
      redirect: request.redirect,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : body ?? await request.text(),
    }));
  };
}

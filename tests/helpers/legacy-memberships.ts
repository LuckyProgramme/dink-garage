import type { PGlite } from "@electric-sql/pglite";
import { DEFAULT_TENANT_ID } from "../../lib/tenant-scope";

// Existing recorder fixtures represent users of the original venue. Provision
// their memberships explicitly now that new accounts have no implicit access.
export async function provisionLegacyFixtureMemberships(db: PGlite) {
  await db.query(`insert into public.tenant_memberships(tenant_id,user_id,role)
    select $1,id,role from public.profiles on conflict do nothing`,[DEFAULT_TENANT_ID]);
}

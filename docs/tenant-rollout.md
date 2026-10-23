# DinkVision tenant rollout

Prepared October 14, 2026. This is a deployment procedure, not a record of a production migration. New migrations 036–041 have passed isolated PostgreSQL-compatible tests; they have **not** been run against the hosted Supabase project during this implementation.

## Deployment boundary

Deploy the six migrations and matching web application as a coordinated release. Old web servers use an unscoped service-role client, so an old server must never serve multiple newly created tenants. Do not create additional tenants until all web instances and scheduled jobs run the new code. Keep the existing application ID, Android signing key, origin, encryption key, and local storage directories. Do not clear app/browser data to resolve upgrade issues.

Migrations 036–041 are additive for existing recording data, but they change keys, RLS policies, function owners, and authorization semantics. They require a staging rehearsal and a maintenance window. A build does not run migrations. Running the migration command below targets the database in `.env`; verify that target privately before running it.

## 1. Back up and rehearse on staging

1. Take a restorable database backup, including auth users, profiles, operational rows, and `casa_migrations.applied`. Preserve encrypted Google tokens, machine credentials, browser identities, resumable upload URLs/offsets/leases, and all local video directories. Keep backups private.
2. Restore into a separate staging project. Disable its outbound workers until it uses staging Google folders/recipients. Never run two environments against the same production upload jobs or retention targets.
3. Verify the migration ledger and current migration level. Existing files through 035 are immutable; the runner verifies normalized SHA-256 checksums. Do not rename the ledger or edit previously applied SQL.
4. Verify the migration connection can create the NOLOGIN, NOSUPERUSER, NOBYPASSRLS role `dinkvision_executor`, transfer the explicitly listed function owners, create policies, and alter foreign keys. Managed Supabase privileges may differ from the local test database. Do not bypass a permission failure with broader public grants or service-role policies.
5. Record counts and a deterministic comparison of IDs, tenant-independent columns, video paths/Drive IDs, encrypted secrets, and queue state before migration. Compare after migration; only documented tenant/location/default metadata should differ.
6. Set staging `MIGRATION_DATABASE_URL` and `DATABASE_CA_CERT_PATH` in `.env`. Keep TLS certificate verification enabled. Then run `npm run db:migrate`. The runner serializes migration runs and commits each file separately. It reloads the PostgREST schema after completion. Do not expose command output containing connection strings.
7. Confirm all six files are recorded in the ledger. A failure rolls back the current file, not previously committed files. Keep the staging app disabled until the full migration set succeeds; do not automatically reverse successful migrations.

## 2. Schema changes and compatibility

| Migration | Purpose | Existing data |
| --- | --- | --- |
| 036 `tenant_isolation` | Tenant/membership/location schema, tenant columns, RLS, tenant-scoped RPC executor, composite foreign keys | Backfills the original tenant; preserves IDs, queues, tokens, files and credentials |
| 037 `tenant_administration` | Trusted registration, membership changes, quotas and location resolution | Original tenant has unlimited quotas; no automatic super-admin promotion |
| 038 `private_tenant_recordings` | Private sharing snapshots for new sessions, aggregate storage usage | Existing sharing snapshots and external Drive permissions remain unchanged |
| 039 `independent_court_devices` | Independent browser/APK devices on the same court | One active capture per device; legacy primary camera still serializes its own captures |
| 040 `local_video_clips` | Derived session ownership, source reference, idempotent clip registration | Keeps original files and source sessions; does not take the current camera slot |
| 041 `preserve_reenrolled_queue_ownership` | Rotate existing enrolled kiosk token in place; require an active issuing admin | Keeps device identity and queued history; blocks re-enrollment during active capture |

The original tenant is `00000000-0000-4000-8000-000000000001`. Existing profiles receive membership there with their existing roles. New accounts receive no tenant membership from signup metadata. Existing global `profiles.role` is retained for compatibility, while application authorization uses the selected tenant membership. Request headers and selected-tenant cookies do not grant membership.

The `id=true` singleton convention remains within each tenant for venue and Google settings. Old session IDs, device IDs, API URLs, recorder tokens, storage paths, and historical migration names are retained. Existing older clients without a tenant header resolve to the original tenant at the database boundary; they are not a supported client for creating additional tenants.

## 3. Accounts, tenants, and locations

1. Deploy the matching application to staging, sign in with an existing owner, and verify the default tenant's courts, devices, history, and settings.
2. `/tenants` supports tenant creation, selection, locations, memberships, Google owner/folder configuration, and storage usage. Accounts must already exist before an administrator adds membership.
3. Trusted account provisioning accepts an optional fourth argument: `npm run account:create -- owner@example.com admin "Venue owner" TENANT_UUID`. Omitting it uses the original tenant. This command creates membership; it does not make the account a super-admin. Handle generated credentials privately.
4. If a platform operator is required, verify the exact auth user UUID through trusted administration. Only then run a reviewed transaction in the target database, for example:

   ```sql
   begin;
   update public.profiles set is_super_admin = true
   where id = '<VERIFIED-OPERATOR-USER-UUID>'::uuid and active;
   -- Verify exactly the intended one row, then commit; otherwise rollback.
   commit;
   ```

   Replace the placeholder before execution. No user is promoted by these migrations. Do not derive this privilege from editable account metadata.
5. In staging, create tenant A and B with separate accounts, locations, courts, devices, and Google roots. Test a user belonging to both, a player-only user, a revoked membership, and an inactive tenant. Confirm cross-tenant URL, row-ID, cookie, header, and device-token attempts fail.
6. New tenants default to 32 device records, 64 court records, and 100 GiB of nondeleted video metadata reservations. Super-admins can adjust limits. Lowering a limit never deletes existing records. Quotas include inactive records until managed through existing removal workflows.

## 4. Google, scheduling, and deployment settings

The application uses Google OAuth, Drive for videos, and Gmail send for replay notifications. It does not require Firebase or a new Google service account.

- Keep `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, and `CRON_SECRET` server-only. Keep the existing encryption key when deploying; replacing it makes stored credentials unreadable.
- Set `APP_ORIGIN` to the canonical HTTPS origin. Register exactly `/api/integrations/google/callback` under that origin in the OAuth client. Hosting changes also require the Google callback allowlist and an Android rebuild. Browser queues remain in their original origin; drain/export them before changing a domain.
- Configure a separate private Drive root and owner per tenant in `/tenants`, then authorize that owner using Admin Settings. The original tenant can fall back to the existing `GOOGLE_DRIVE_ROOT_FOLDER_ID` and `GOOGLE_SENDER_EMAIL` environment values. Other tenants cannot inherit them.
- Each root must be owned by its connected account, private, and distinct from other tenants' roots. The application prevents switching an established owner/root because existing uploads, playback, and retention require the old configuration. Plan a separate migration if this must change.
- Confirm Drive API and Gmail API access, the required consent scopes, OAuth audience/test users or publication status, and token refresh in staging. The earlier Google testing-mode 403 is an external consent configuration issue; an application build cannot authorize a tester.
- New files share only with the recorded recipients and owner. Use real recipient Google accounts. Historical `sharing_mode=link` sessions still have bearer-link access. Inventory their ACLs and obtain owner approval before changing permissions; do not silently break existing replay links.
- Install an authenticated scheduler for `/api/jobs/browser`. One invocation selects up to four least-recently attempted active tenants and runs each independently. Monitor tenant worker timestamps and backlog age. The local jobs process does not schedule hosted production jobs. Hosting quotas and cadence must match tenant volume.
- Prove Drive completion and content integrity, then check the email in the intended recipient inbox. A Gmail API success only confirms acceptance. Ambiguous sends remain Unknown to avoid duplicates; inspect the sender's Sent folder before manual retry.

## 5. Acceptance before production promotion

Run `npm test`, `npm run typecheck`, `npm run build`, and the Android commands in `android/README.md`. Then execute the manual test matrix in the October 14 readiness report. Specifically verify:

- Existing owner login, non-admin denials, tenant selection, last-admin protection, quotas, location/court creation and editing, and recording logs.
- Original devices remain enrolled. Re-enrollment preserves the queue identity. Reassignment to another tenant must not expose or process the previous tenant's local videos.
- USB permission/disconnect/reconnect, immediate new capture after failure, 15-minute capture and normal playback, original-preserving one-minute export, and canceled export.
- Short recordings remain local; network loss and restart retain queues; independent devices progress; successful upload is confirmed before local cleanup.
- Real Google refresh, private playback for intended recipients, denial for another tenant's account, actual replay delivery, and no email for under-60-second clips.

Production rollout: stop old web/worker traffic, finish or stop active captures safely, preserve local queues, take the fresh backup, migrate, deploy all matching web/worker instances, verify the original tenant, then enable additional tenants and install the matching APK as an update. Do not uninstall the existing APK. Resume and monitor uploads. No production step in this procedure has been performed automatically.

## Roll-forward and rollback constraints

Prefer a tested roll-forward fix. Do not drop tenant columns/tables or restore an older unscoped server while additional tenants exist. If rollout fails before any post-migration writes, an operator can restore the verified backup in a maintenance window. After new recordings or tenants exist, a blanket restore would lose data; preserve those writes and create a coordinated recovery plan instead. Never delete local footage or queues as a rollback shortcut.

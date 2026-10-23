-- Accept every valid duration. Keep the old RPC for older installed clients,
-- but only use it to persist duration metadata now.
alter table public.browser_recordings add column content_md5 text
  check(content_md5 is null or content_md5 ~ '^[a-f0-9]{32}$');
create or replace function public.hold_short_browser_recording(
  p_session uuid,p_device uuid,p_duration_ms bigint default null
) returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_duration_ms is not null and (p_duration_ms<0 or p_duration_ms>7200000) then
    raise exception 'Invalid recording duration';
  end if;
  update public.browser_recordings set duration_ms=coalesce(p_duration_ms,duration_ms)
  where session_id=p_session and device_id=p_device;
  return false;
end; $$;

-- Previously held clips need revalidation on their original device. Preserve
-- file IDs, resumable URLs, and all local availability/history information.
update public.browser_recordings b set upload_state='failed',lease_until=null,
  last_error='Short recording can now be retried on the original device.',
  safe_error='Short recording can now be retried on the original device.'
from public.recording_sessions s where s.id=b.session_id
  and s.failure_stage='short_recording' and b.upload_state='local_only';
update public.recording_sessions set failure_stage='upload'
where status='failed' and failure_stage='short_recording';

-- Expired claims must leave the FIFO, not stay at its head as "retrying".
-- The originating device requeues them only when its backoff has elapsed.
create function public.expire_browser_uploads(p_device uuid default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  update public.browser_recordings b set upload_state='failed',lease_until=null,
    lease_token=null,upload_updated_at=now(),
    last_error='Upload connection expired. Local footage is retained for recovery.',
    safe_error='Upload connection expired. Local footage is retained for recovery.'
  where (p_device is null or b.device_id=p_device)
    and b.upload_state in ('pending','queued','retrying','uploading')
    and coalesce(b.upload_updated_at,b.upload_queued_at,b.last_seen_at)<now()-interval '3 minutes'
    and (b.lease_until is null or b.lease_until<now())
    and exists(select 1 from public.recording_sessions s where s.id=b.session_id and s.status in ('uploading','sharing'));
end; $$;

do $$
declare definition text; updated text;
begin
  definition := pg_get_functiondef('public.browser_upload_turn(uuid,uuid,boolean)'::regprocedure);
  updated := replace(definition,
    'select * into target from public.browser_recordings',
    'perform public.expire_browser_uploads(p_device); select * into target from public.browser_recordings');
  if updated=definition then raise exception 'Upload recovery hook not installed'; end if;
  -- The previous stale transition ignored operation leases and kept an expired
  -- head eligible forever. Expiration above now owns this transition.
  updated := replace(updated, $old$ update public.browser_recordings stale set upload_state='retrying',retry_count=least(100,stale.retry_count+1),upload_updated_at=now(),
   last_error='Upload connection was lost; automatic retry scheduled.',safe_error='Upload connection was lost; automatic retry scheduled.'
 where stale.device_id=p_device and stale.upload_state='uploading' and stale.upload_updated_at<now()-interval '3 minutes';$old$, '');
  if position('update public.browser_recordings stale' in updated)>0 then
    raise exception 'Old upload expiration transition was not removed';
  end if;
  execute updated;
end $$;

-- All failed/cancelled/completed transitions release short operation leases.
create function public.release_browser_upload_lease()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.upload_state in ('failed','cancelled','uploaded','complete','local_only') then
    new.lease_until:=null;
    new.lease_token:=null;
  end if;
  return new;
end; $$;
create trigger browser_upload_release_lease before update on public.browser_recordings
for each row execute function public.release_browser_upload_lease();

revoke all on function public.expire_browser_uploads(uuid),public.release_browser_upload_lease() from public,anon,authenticated;
grant execute on function public.expire_browser_uploads(uuid) to service_role;

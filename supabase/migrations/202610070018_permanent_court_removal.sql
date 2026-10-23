-- Courts are permanently removable while historical sessions and videos stay.
-- Device assignments become unassigned, and recording logs retain the court name
-- in their immutable configuration snapshot.
alter table public.cameras
  drop constraint if exists cameras_court_id_fkey;
alter table public.cameras
  add constraint cameras_court_id_fkey
  foreign key(court_id) references public.courts(id) on delete set null;

alter table public.browser_devices
  drop constraint if exists browser_devices_court_id_fkey;
alter table public.browser_devices
  add constraint browser_devices_court_id_fkey
  foreign key(court_id) references public.courts(id) on delete set null;

alter table public.recording_sessions
  drop constraint if exists recording_sessions_court_id_fkey;
alter table public.recording_sessions
  alter column court_id drop not null;
alter table public.recording_sessions
  add constraint recording_sessions_court_id_fkey
  foreign key(court_id) references public.courts(id) on delete set null;

grant delete on public.courts to authenticated;

create or replace function public.preserve_court_history_before_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists(
    select 1
    from public.recording_sessions
    where court_id = old.id
      and status not in ('ready', 'failed', 'deleted')
  ) then
    raise exception 'Finish the current recording before removing this court';
  end if;

  update public.recording_sessions
  set configuration_snapshot = configuration_snapshot ||
    jsonb_build_object('court_name', old.name)
  where court_id = old.id;

  return old;
end;
$$;
revoke all on function public.preserve_court_history_before_delete() from public;
drop trigger if exists preserve_court_history_before_delete on public.courts;
create trigger preserve_court_history_before_delete
before delete on public.courts
for each row execute function public.preserve_court_history_before_delete();

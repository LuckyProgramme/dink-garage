-- A stopped historical recording must not prevent permanent court removal.
-- Keep blocking only while the camera can still be actively writing footage.
-- The existing trigger stores the court name in each session snapshot before
-- the foreign key is detached, so uploads and logs can continue afterwards.
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
      and status in ('requested', 'starting', 'recording', 'finalizing')
  ) then
    raise exception 'Stop the active recording before removing this court';
  end if;

  update public.recording_sessions
  set configuration_snapshot = configuration_snapshot ||
    jsonb_build_object('court_name', old.name)
  where court_id = old.id;

  return old;
end;
$$;
revoke all on function public.preserve_court_history_before_delete() from public;

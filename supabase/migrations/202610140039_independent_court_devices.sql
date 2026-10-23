-- Browser/APK capture is physically owned by a registered device. Two devices
-- may capture different views of the same court. Keep the legacy agent's
-- primary-camera slot independent from those devices.
drop index public.one_capture_per_court;
create unique index one_capture_per_court on public.recording_sessions(court_id)
where status in ('requested','starting','recording','finalizing')
  and coalesce(configuration_snapshot->>'capture_mode','')<>'browser';
create unique index one_capture_per_browser_device on public.recording_sessions
  ((configuration_snapshot->>'device_id'))
where status in ('requested','starting','recording','finalizing')
  and configuration_snapshot->>'capture_mode'='browser';

do $$ declare definition text; updated text; fn record;
begin
  definition:=pg_get_functiondef('public.browser_start(uuid,text,uuid,uuid,jsonb)'::regprocedure);
  updated:=replace(definition,
    'if exists(select 1 from public.recording_sessions where court_id=d.court_id and status in (''requested'',''starting'',''recording'',''finalizing'')) then raise exception ''Court is already recording''; end if;',
    '-- Registered device lock and unique active-device index prevent overlapping capture.');
  if updated=definition then raise exception 'Device capture isolation was not installed'; end if;
  execute updated;
  for fn in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('start_capture','start_guest_capture','player_court_status','kiosk_court_status')
  loop
    definition:=pg_get_functiondef(fn.signature);
    -- These routines select the shared primary camera. Browser devices no
    -- longer occupy that camera's slot merely by using the same court label.
    updated:=replace(definition,'where court_id=p_court and status in',
      'where coalesce(configuration_snapshot->>''capture_mode'','''')<>''browser'' and court_id=p_court and status in');
    updated:=replace(updated,'where s.court_id=c.id and s.status in',
      'where coalesce(s.configuration_snapshot->>''capture_mode'','''')<>''browser'' and s.court_id=c.id and s.status in');
    if updated<>definition then execute updated; end if;
  end loop;
end $$;

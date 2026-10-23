-- Apply the one-minute rule to browser/Android clips that were already waiting
-- when local-only support was introduced.
do $$
declare item record;
begin
  for item in
    select b.session_id,b.device_id,
      floor(extract(epoch from (s.stopped_at-s.started_at))*1000)::bigint as duration_ms
    from public.browser_recordings b
    join public.recording_sessions s on s.id=b.session_id
    where s.status in ('uploading','sharing')
      and b.upload_state in ('queued','uploading','failed')
      and s.started_at is not null and s.stopped_at is not null
      and s.stopped_at-s.started_at<interval '1 minute'
  loop
    perform public.hold_short_browser_recording(
      item.session_id,item.device_id,item.duration_ms
    );
  end loop;
end; $$;

-- Worker liveness is operational status, not an administrator configuration edit.
drop trigger audit_settings on public.venue_settings;
create trigger audit_settings after update on public.venue_settings for each row
when ((old.max_duration_seconds,old.retention_seconds,old.venue_time_zone)
 is distinct from (new.max_duration_seconds,new.retention_seconds,new.venue_time_zone))
execute function public.audit_configuration();

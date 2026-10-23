-- Keep up to four team recipients, but require only one address per recording.
-- Rebuild the functions introduced immediately before this migration while
-- preserving the rest of their security and recording checks verbatim.
do $$
declare definition text; updated text;
begin
  definition := pg_get_functiondef('public.browser_start(uuid,text,uuid,uuid,jsonb)'::regprocedure);
  updated := replace(definition,
    'jsonb_array_length(v_recipients) not in (1,4)',
    'jsonb_array_length(v_recipients) not between 1 and 4');
  updated := replace(updated,
    'Enter two different email addresses for each team',
    'Enter at least one valid email address on either team');
  if updated=definition then raise exception 'browser_start recipient validation was not updated'; end if;
  execute updated;

  definition := pg_get_functiondef('public.start_guest_capture(uuid,text,uuid,uuid,jsonb)'::regprocedure);
  updated := replace(definition,
    'jsonb_array_length(v_recipients) not in (1,4)',
    'jsonb_array_length(v_recipients) not between 1 and 4');
  updated := replace(updated,
    'Enter two different email addresses for each team',
    'Enter at least one valid email address on either team');
  if updated=definition then raise exception 'start_guest_capture recipient validation was not updated'; end if;
  execute updated;
end $$;

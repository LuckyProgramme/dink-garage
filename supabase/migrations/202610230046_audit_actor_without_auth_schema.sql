-- The hosted auth schema is owned by supabase_admin, so the migration role
-- cannot grant dinkvision_executor USAGE on it. Executor-owned audit writes must
-- therefore not call auth.uid(). Read the same trusted PostgREST claim directly.
-- This replaces the trigger function only; existing audit rows are untouched.
create or replace function public.audit_configuration() returns trigger
language plpgsql security definer set search_path='' as $$
declare actor_id uuid;
begin
  actor_id:=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
  if actor_id is null then
    actor_id:=nullif(coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'sub','')::uuid;
  end if;
  insert into public.audit_events(actor_id,action,safe_detail)
  values (actor_id, lower(tg_op) || '.' || tg_table_name,
    jsonb_build_object('entity_id', to_jsonb(new)->>'id', 'name', to_jsonb(new)->>'name'));
  return new;
end; $$;
alter function public.audit_configuration() owner to dinkvision_executor;

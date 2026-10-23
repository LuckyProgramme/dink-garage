-- Foundation only. Apply deliberately after configuring the target project.
create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role text not null default 'player' check (role in ('player','admin')),
  created_at timestamptz not null default now()
);
create function public.is_admin() returns boolean language sql stable security definer
set search_path = '' as $$ select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin'); $$;

create table public.venue_settings (
  id boolean primary key default true check (id),
  max_duration_seconds integer not null default 900 check (max_duration_seconds between 60 and 7200),
  retention_seconds integer not null default 86400 check (retention_seconds between 3600 and 2592000),
  venue_time_zone text, -- Must be explicitly configured before live recording.
  updated_at timestamptz not null default now()
);
insert into public.venue_settings(id) values (true);

create table public.courts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.recorders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.cameras (
  id uuid primary key default gen_random_uuid(),
  recorder_id uuid not null references public.recorders(id),
  court_id uuid references public.courts(id),
  name text not null,
  source_type text not null check (source_type in ('network','usb')),
  device_reference text not null, -- Local agent reference, not raw camera credentials.
  is_primary boolean not null default false,
  enabled boolean not null default true,
  health text not null default 'unknown' check (health in ('unknown','online','offline')),
  unique(recorder_id, device_reference)
);
create unique index one_primary_camera_per_court on public.cameras(court_id) where is_primary and enabled;

create table public.recording_sessions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.profiles(id),
  court_id uuid not null references public.courts(id),
  idempotency_key uuid not null unique,
  status text not null default 'requested' check (status in ('requested','starting','recording','finalizing','uploading','sharing','ready','failed','deleting','deleted')),
  configuration_snapshot jsonb not null,
  recipient_email text not null,
  started_at timestamptz,
  stopped_at timestamptz,
  stop_reason text,
  failure_stage text,
  created_at timestamptz not null default now()
);
create unique index one_capture_per_court on public.recording_sessions(court_id)
where status in ('requested','starting','recording','finalizing');
create index player_sessions on public.recording_sessions(player_id,created_at desc);

create table public.recording_files (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.recording_sessions(id),
  camera_id uuid not null references public.cameras(id),
  drive_file_id text unique,
  uploaded_at timestamptz,
  expires_at timestamptz,
  deleted_at timestamptz,
  status text not null default 'pending',
  unique(session_id,camera_id)
);
create table public.delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.recording_sessions(id),
  status text not null check(status in ('pending','sent','failed')),
  attempted_at timestamptz not null default now(),
  provider_message_id text,
  safe_error text
);
create table public.audit_events (
  id bigint generated always as identity primary key,
  session_id uuid references public.recording_sessions(id),
  actor_id uuid references public.profiles(id),
  action text not null,
  safe_detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.venue_settings enable row level security;
alter table public.courts enable row level security;
alter table public.recorders enable row level security;
alter table public.cameras enable row level security;
alter table public.recording_sessions enable row level security;
alter table public.recording_files enable row level security;
alter table public.delivery_attempts enable row level security;
alter table public.audit_events enable row level security;

create policy profile_read on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
-- Role changes and profile provisioning require trusted server operations.
create policy settings_read on public.venue_settings for select to authenticated using (true);
create policy settings_admin on public.venue_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy courts_read on public.courts for select to authenticated using (active or public.is_admin());
create policy courts_admin on public.courts for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy recorders_admin on public.recorders for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy cameras_admin on public.cameras for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- Players obtain safe camera availability through server routes, never connection references.
create policy sessions_read on public.recording_sessions for select to authenticated using (player_id = auth.uid() or public.is_admin());
create policy files_read on public.recording_files for select to authenticated using (public.is_admin() or exists (select 1 from public.recording_sessions s where s.id = session_id and s.player_id = auth.uid()));
create policy delivery_read on public.delivery_attempts for select to authenticated using (public.is_admin() or exists (select 1 from public.recording_sessions s where s.id = session_id and s.player_id = auth.uid()));
create policy audit_admin_read on public.audit_events for select to authenticated using (public.is_admin());
-- Session/file/delivery mutations are intentionally server-only. Durable job tables,
-- permissions and RPC transitions will be added with the live recorder stage.

-- Extend existing column-level configuration grants; RLS still restricts writes to admins.
grant insert (audio_source), update (audio_source) on public.cameras to authenticated;

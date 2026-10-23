-- Update organization branding while preserving device IDs, enrollment and recordings.
alter table public.browser_devices drop constraint browser_devices_organization_check;
alter table public.browser_devices alter column organization set default 'DinkVision';
update public.browser_devices
  set organization = 'DinkVision'
  where organization in ('Wrenlabs Pickleball Camera', 'Casa Batik');
alter table public.browser_devices add constraint browser_devices_organization_check
  check (organization = 'DinkVision');

export type Court = {
  id: string;
  name: string;
  location: string;
  active: boolean;
};
export type Recorder = {
  id: string;
  name: string;
  last_seen_at: string | null;
  paired_at: string | null;
  agent_version: string | null;
  platform: string | null;
  ffmpeg_available: boolean;
};
export type Camera = {
  id: string;
  name: string;
  recorder_id: string;
  court_id: string | null;
  source_type: "network" | "usb";
  device_reference: string;
  audio_source: string;
  is_primary: boolean;
  enabled: boolean;
  health: string;
  last_health_check_at: string | null;
};
export type Device = {
  id: string;
  recorder_id: string;
  device_reference: string;
  name: string;
  source_type: "network" | "usb";
  health: string;
  diagnostic: string;
  last_test_at: string | null;
  audio_sources: { device_reference: string; name: string }[];
};
export type RecorderCommand = {
  id: string;
  recorder_id: string;
  kind: string;
  status: string;
  created_at: string;
  result_code: string | null;
};
export type Settings = {
  max_duration_seconds: number;
  retention_seconds: number;
  venue_time_zone: string | null;
};
export type Session = {
  configuration_snapshot?: {
    capture_mode?: string;
    device_id?: string;
    camera_name?: string;
    court_name?: string;
    recipient_emails?: string[];
  };
  id: string;
  court_id: string | null;
  status: string;
  recipient_email: string;
  created_at: string;
  started_at: string | null;
  stopped_at: string | null;
  stop_reason: string | null;
  failure_stage: string | null;
};
export type Audit = { id: number; action: string; created_at: string };
export type AdminData = {
  courts: Court[];
  cameras: Camera[];
  recorders: Recorder[];
  settings: Settings;
  sessions: Session[];
  events: Audit[];
  devices: Device[];
  commands: RecorderCommand[];
};

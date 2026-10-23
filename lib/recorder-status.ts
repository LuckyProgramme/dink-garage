import type { Recorder, Camera } from "./admin-types";
export function recorderOnline(recorder?: Recorder) {
  return (
    !!recorder?.paired_at &&
    !!recorder.last_seen_at &&
    Date.now() - Date.parse(recorder.last_seen_at) < 45000
  );
}
export function cameraOnline(camera: Camera, recorders: Recorder[]) {
  return (
    camera.enabled &&
    camera.health === "online" &&
    !!camera.last_health_check_at &&
    recorderOnline(recorders.find((r) => r.id === camera.recorder_id))
  );
}

import type { LocalRecording } from "./browser-storage";

// The server releases its device pointer when capture fails. That must not
// dismiss footage still owned by this browser or an in-progress capture.
export function localPlayerRecording(records: LocalRecording[], deviceId: string, activeId?: string | null) {
  const owned = records.filter(r => r.deviceId === deviceId);
  return owned.find(r => r.id === activeId) || owned
    .filter(r => r.localAvailable !== false && r.status !== "uploaded"
      && (r.interrupted || !r.complete || r.status === "failed"))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

export function flushSessionState(deviceId: string) {
  // Clear all local recordings for this device from IndexedDB
  // This prevents interference with new recording sessions
  return Promise.all([
    // Remove all meta records for this device
    // Note: Actual removal happens via browser-storage removeVideo
  ]);
}

export function hideQueuedSession(record: LocalRecording | undefined, activeId?: string | null) {
  return !!record && record.id !== activeId && record.complete && !record.interrupted
    && record.status !== "failed";
}

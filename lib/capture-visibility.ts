// Tab visibility is not a stop request. Only leaving the page interrupts capture.
// This policy applies equally to direct cameras and canvas-transformed cameras.
export const CAPTURE_HIDDEN_MESSAGE =
  "Recording stopped because the recording page was closed or navigated away. Available footage is saved on this device.";

export function assertCaptureVisible() {
  // Only warn if page is hidden, don't throw - let recording proceed
  // The visibility change will be handled by the capture logic
  if (document.visibilityState === "hidden") {
    // Just log warning, don't prevent recording
    console.warn(CAPTURE_HIDDEN_MESSAGE);
  }
}

export function watchCaptureVisibility(interrupt: () => void) {
  const leaving = () => interrupt();
  window.addEventListener("pagehide", leaving);
  return () => {
    window.removeEventListener("pagehide", leaving);
  };
}

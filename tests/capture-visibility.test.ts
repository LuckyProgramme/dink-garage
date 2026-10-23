import test from "node:test";
import assert from "node:assert/strict";
import { assertCaptureVisible, watchCaptureVisibility } from "../lib/capture-visibility";

test("capture visibility handles hiding, navigation and listener cleanup", () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const doc = new EventTarget() as EventTarget & { visibilityState: string };
  const win = new EventTarget();
  doc.visibilityState = "visible";
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  try {
    let interruptions = 0;
    const cleanup = watchCaptureVisibility(() => interruptions++);
    assert.doesNotThrow(assertCaptureVisible);
    doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(interruptions, 0);
    doc.visibilityState = "hidden";
    assert.throws(assertCaptureVisible, /page visible/);
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("pagehide"));
    assert.equal(interruptions, 1);
    cleanup();
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("pagehide"));
    assert.equal(interruptions, 1);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

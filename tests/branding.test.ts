import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("every packaged Dink Vision logo matches the public source", () => {
  const publicLogo = readFileSync(resolve(root, "public/dink-vision-logo.png"));
  for (const path of [
    "app/icon.png",
    "android/app/src/main/assets/dink-vision-logo.png",
    "android/app/src/main/res/drawable/dink_vision_logo.png",
    "android/app/src/main/assets/wpc-logo.png",
    "android/app/src/main/res/drawable/wpc_logo.png",
  ]) {
    assert.deepEqual(readFileSync(resolve(root, path)), publicLogo, path);
  }
});

test("browser recordings load the public logo before writing frames", () => {
  const worker = readFileSync(resolve(root, "public/camera-transform-worker.js"), "utf8");
  assert.match(worker, /fetch\('\/dink-vision-logo\.png'/);
  assert.match(worker, /context\.drawImage\(logo/);
});

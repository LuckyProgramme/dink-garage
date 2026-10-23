import test from "node:test";
import assert from "node:assert/strict";
import {
  googleRedirectUri,
  LOCAL_GOOGLE_REDIRECT_URI,
} from "../lib/google-redirect";

const APP_ORIGIN = "https://dinkvision.vercel.app";
const productionCallback = `${APP_ORIGIN}/api/integrations/google/callback`;

test("Google OAuth derives deployed callbacks from APP_ORIGIN", () => {
  assert.equal(googleRedirectUri({}), LOCAL_GOOGLE_REDIRECT_URI);
  assert.equal(
    googleRedirectUri({ APP_ORIGIN, VERCEL: "1", VERCEL_ENV: "production" }),
    productionCallback,
  );
  assert.equal(
    googleRedirectUri({ APP_ORIGIN, NODE_ENV: "production" }),
    productionCallback,
  );
  assert.equal(
    googleRedirectUri({
      APP_ORIGIN: "https://camera.example.com",
      NODE_ENV: "production",
    }),
    "https://camera.example.com/api/integrations/google/callback",
  );
});

test("Google OAuth accepts local overrides and ignores them when deployed", () => {
  assert.equal(
    googleRedirectUri({
      APP_ORIGIN,
      VERCEL: "1",
      GOOGLE_REDIRECT_URI: LOCAL_GOOGLE_REDIRECT_URI,
    }),
    productionCallback,
  );
  assert.equal(
    googleRedirectUri({ GOOGLE_REDIRECT_URI: LOCAL_GOOGLE_REDIRECT_URI }),
    LOCAL_GOOGLE_REDIRECT_URI,
  );
  assert.equal(
    googleRedirectUri({
      GOOGLE_REDIRECT_URI:
        "http://localhost:3000/api/integrations/google/callback",
    }),
    "http://localhost:3000/api/integrations/google/callback",
  );
});

test("Google OAuth rejects missing or invalid hosted origins", () => {
  assert.throws(
    () => googleRedirectUri({ VERCEL: "1" }),
    /google_redirect_invalid/,
  );
  for (const APP_ORIGIN of [
    "http://dinkvision.vercel.app",
    "https://dinkvision.vercel.app/admin",
    "https://dinkvision.vercel.app?source=preview",
  ])
    assert.throws(
      () => googleRedirectUri({ VERCEL: "1", APP_ORIGIN }),
      /google_redirect_invalid/,
    );
});

import { setTimeout as delay } from "node:timers/promises";
export async function emailLoop(config,api,stopping) {
  while (!stopping()) {
    try { await api(config,"emails",{}); } catch { /* Durable queue retries on the next poll. */ }
    if (!stopping()) await delay(10000);
  }
}

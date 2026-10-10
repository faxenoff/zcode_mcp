#!/usr/bin/env node
// Race probe: does the FIRST models query after a fresh app-server boot see an
// empty model list, and how long until the list becomes non-empty?
//
// For N iterations: boot a brand-new ZcodeProtocolClient (fresh child), call
// createSession the moment start() resolves (exactly what the first
// zcode_run/zcode_check after an MCP reconnect does), then poll until the
// model list is non-empty. Prints per-iteration timings and a summary.
//
// Usage: node scripts/race_probe.mjs [iterations]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZcodeProtocolClient } from "../dist/protocol.js";

const ITERATIONS = Number(process.argv[2] ?? 10);
const POLL_MS = 100;
const WAIT_NON_EMPTY_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

for (let i = 0; i < ITERATIONS; i++) {
  const ws = mkdtempSync(join(tmpdir(), `zcode-race-probe-${i}-`));
  const t0 = Date.now();
  const events = [];
  const client = new ZcodeProtocolClient(undefined, () => {});
  // handleMessage is TS-private only; tap it to record the child's first signals.
  const orig = client.handleMessage.bind(client);
  client.handleMessage = (msg) => {
    if (msg?.method && events.length < 6) events.push(`+${Date.now() - t0}ms ${msg.method}`);
    return orig(msg);
  };

  let startMs = 0;
  let firstModelsCount = -1;
  let nonEmptyMs = 0;
  let sessionsCreated = 0;
  const detail = [];
  try {
    await client.start();
    startMs = Date.now() - t0;

    // The "first call right after connect" — mirrors the observed bug.
    const first = await client.createSession(ws, "plan");
    sessionsCreated++;
    firstModelsCount = first.models.length;
    if (first.models.length > 0) {
      nonEmptyMs = Date.now() - t0;
    } else {
      // poll session/read on the same session; fall back to new sessions
      const deadline = Date.now() + WAIT_NON_EMPTY_MS;
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        let models = [];
        try {
          models = await readSnapshotModels(client, first.sessionId);
        } catch {
          models = [];
        }
        if (!models.length) {
          try {
            const again = await client.createSession(ws, "plan");
            sessionsCreated++;
            models = again.models;
          } catch { /* keep polling */ }
        }
        if (models.length) {
          nonEmptyMs = Date.now() - t0;
          detail.push(`poll-ok models=${models.map((m) => m.modelId).join("/")}`);
          break;
        }
      }
    }
  } catch (e) {
    detail.push(`error: ${e.message?.slice(0, 160)}`);
  } finally {
    await client.stop().catch(() => {});
  }
  results.push({ i, startMs, firstModelsCount, nonEmptyMs, sessionsCreated, events, detail });
  const empty = firstModelsCount === 0 ? "EMPTY" : firstModelsCount > 0 ? "ok   " : "err  ";
  console.log(
    `#${i} ${empty} start=${startMs}ms first_models=${firstModelsCount} non_empty_at=${nonEmptyMs}ms sessions=${sessionsCreated} ${detail.join(" ")}`,
  );
  console.log(`   signals: ${events.join(", ") || "(none)"}`);
  await sleep(300);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(ws, { recursive: true, force: true });
      break;
    } catch {
      await sleep(400); // Windows releases child handles shortly after exit
    }
  }
}

/** session/read with modelAvailability:"current" — returns models if present in the snapshot. */
async function readSnapshotModels(client, sessionId) {
  const res = await client["request"]("session/read", { sessionId });
  const snap = res?.value ?? res;
  const models = snap?.settings?.model?.available ?? [];
  return models
    .map((m) => ({ providerId: m.ref?.providerId, modelId: m.ref?.modelId ?? m.modelId }))
    .filter((m) => m.modelId);
}

const empty = results.filter((r) => r.firstModelsCount === 0);
const errored = results.filter((r) => r.firstModelsCount < 0);
console.log("\n=== SUMMARY ===");
console.log(`iterations: ${ITERATIONS}`);
console.log(`first-call EMPTY model list: ${empty.length}/${ITERATIONS}`);
console.log(`first-call errored: ${errored.length}/${ITERATIONS}`);
if (empty.length) {
  const waits = empty.map((r) => r.nonEmptyMs).filter(Boolean);
  console.log(
    `ms until non-empty (empty cases): ${waits.join(", ")} (median ${[...waits].sort((a, b) => a - b)[Math.floor(waits.length / 2)]}ms)`,
  );
}
const starts = results.map((r) => r.startMs).filter(Boolean);
console.log(`start() duration: median ${[...starts].sort((a, b) => a - b)[Math.floor(starts.length / 2)]}ms, max ${Math.max(...starts)}ms`);
process.exit(0);

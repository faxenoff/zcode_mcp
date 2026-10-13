// Live: boots a private zcode app-server and spends two tiny GLM-5.3-Flash turns.
// Skipped without stored zcode credentials or with ZCODE_SKIP_LIVE=1.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { descendants, listProcesses } from "../dist/processes.js";
import { ZcodeProtocolClient } from "../dist/protocol.js";

const skip =
  process.env.ZCODE_SKIP_LIVE === "1"
    ? "ZCODE_SKIP_LIVE=1"
    : !existsSync(join(homedir(), ".zcode/v2/credentials.json"))
      ? "no zcode credentials"
      : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IGNORED = new Set(["conhost.exe"]);

async function leftovers(pid) {
  const all = await listProcesses();
  return descendants(all, pid).filter((p) => p.ppid === pid && !IGNORED.has(p.name.toLowerCase()));
}

async function answerOf(c, sessionId, since) {
  const msgs = await c.readMessages(sessionId);
  return msgs
    .filter((m) => m.info.role === "assistant" && (m.info.time?.created ?? 0) >= since - 5_000)
    .flatMap((m) => (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text))
    .join(" ");
}

test("after a turn the session's processes are gone, and the session resumes", { skip, timeout: 420_000 }, async () => {
  const c = new ZcodeProtocolClient(undefined, () => {}, { reapEnabled: true, reapIntervalMs: 3_600_000 });
  const ws = mkdtempSync(join(tmpdir(), "zcode-mcp-live-"));
  await c.start();
  const pid = c.appServerPid;
  try {
    const { sessionId, models } = await c.createSession(ws, "yolo");
    const model = models.find((m) => m.modelId === "GLM-5.3-Flash") ?? models[0];
    assert.ok(model, "no models");

    let since = Date.now();
    let r = await c.runTurn(sessionId, "Use the bash tool to run exactly: echo probe-$((40+2)) . Reply with its output only.", model, "low", 180_000);
    assert.equal(r.ok, true);
    assert.match(await answerOf(c, sessionId, since), /probe-42/);

    await c.releaseSession(sessionId);
    await sleep(3_000);
    await c.sweep();
    await sleep(1_500); // taskkill returns before the kernel drops the rows
    assert.deepEqual((await leftovers(pid)).map((p) => `${p.pid} ${p.name}`), [], "children left after the turn");

    await c.resumeSession(sessionId, ws);
    since = Date.now();
    r = await c.runTurn(sessionId, "What exact output did the command in the previous turn print? Reply with it only.", model, "low", 180_000);
    assert.equal(r.ok, true);
    assert.match(await answerOf(c, sessionId, since), /probe-42/, "history survived close + resume");

    await c.releaseSession(sessionId);
    await sleep(3_000);
    await c.sweep();
    await sleep(1_500);
    assert.deepEqual((await leftovers(pid)).map((p) => `${p.pid} ${p.name}`), [], "children left after the follow-up");
  } finally {
    c.stopSync();
    await sleep(1_500);
    const all = await listProcesses();
    assert.ok(!all.some((p) => p.pid === pid), "app-server survived stop()");
    try { rmSync(ws, { recursive: true, force: true }); } catch { /* Windows handle lag */ }
  }
});

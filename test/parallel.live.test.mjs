// Live: three parallel sessions on one app-server; the short one ends and is
// closed at once while the two long ones keep working (tools + files in their
// cwd) for over a minute. Before the fix the close aborted that session's
// post-turn project_memory_extract, ZCode leaked the abort as an unhandled
// rejection and the app-server exited 1 with both long turns.
// ZCODE_LIVE_PROJECT_MEMORY=1 runs it with ZCode project memory on (reproduces the crash).
// Skipped without stored zcode credentials or with ZCODE_SKIP_LIVE=1.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ZcodeProtocolClient } from "../dist/protocol.js";

const skip =
  process.env.ZCODE_SKIP_LIVE === "1"
    ? "ZCODE_SKIP_LIVE=1"
    : !existsSync(join(homedir(), ".zcode/v2/credentials.json"))
      ? "no zcode credentials"
      : false;

const SHORT =
  "Please create a file named note.txt in the current directory containing the single line hello-short, " +
  "then read the file back with a tool and reply with its content only.";
const LONG = (tag) =>
  "Please do these steps in order, each with a tool call, and do not skip any. " +
  `1) Run this shell command and wait for it: node -e "setTimeout(()=>{},40000)" ` +
  `2) Create a file named step1.txt containing ${tag}-one. ` +
  `3) Run the same shell command again: node -e "setTimeout(()=>{},40000)" ` +
  `4) Create a file named step2.txt containing ${tag}-two. ` +
  "5) Read both files back and reply with their contents.";

test("closing one finished session does not take down the other running turns", { skip, timeout: 900_000 }, async () => {
  const log = [];
  const c = new ZcodeProtocolClient(undefined, (m) => log.push(m), {
    reapEnabled: true,
    reapIntervalMs: 3_600_000,
    ...(process.env.ZCODE_LIVE_PROJECT_MEMORY === "1" ? { projectMemory: true } : {}),
  });
  const ws = ["short", "long-a", "long-b"].map((n) => mkdtempSync(join(tmpdir(), `zcode-mcp-par-${n}-`)));
  await c.start();
  const pid = c.appServerPid;
  try {
    const sessions = [];
    for (const w of ws) sessions.push(await c.createSession(w, "yolo"));
    const model = sessions[0].models.find((m) => m.modelId === "GLM-5.3-Flash") ?? sessions[0].models[0];
    assert.ok(model, "no models");
    const [s, a, b] = sessions.map((x) => x.sessionId);

    const t0 = Date.now();
    const longA = c.runTurn(a, LONG("alpha"), model, "low", 600_000);
    const longB = c.runTurn(b, LONG("beta"), model, "low", 600_000);
    longA.catch(() => {});
    longB.catch(() => {});

    const short = await c.runTurn(s, SHORT, model, "low", 300_000);
    assert.equal(short.ok, true, `short turn failed: ${JSON.stringify(short.error)}`);
    assert.match(readFileSync(join(ws[0], "note.txt"), "utf8"), /hello-short/);
    const closedAt = Date.now();
    await c.releaseSession(s); // what zcode_run does right after the answer

    const [ra, rb] = await Promise.all([longA, longB]);
    const doneAt = Date.now();
    assert.equal(ra.ok, true, `long A failed: ${JSON.stringify(ra.error)}`);
    assert.equal(rb.ok, true, `long B failed: ${JSON.stringify(rb.error)}`);
    assert.equal(c.appServerPid, pid, "app-server was restarted");
    for (const [w, tag] of [[ws[1], "alpha"], [ws[2], "beta"]]) {
      assert.match(readFileSync(join(w, "step1.txt"), "utf8"), new RegExp(`${tag}-one`));
      assert.match(readFileSync(join(w, "step2.txt"), "utf8"), new RegExp(`${tag}-two`));
    }
    assert.ok(doneAt - t0 >= 60_000, `long turns ended after only ${doneAt - t0} ms`);
    assert.ok(doneAt - closedAt >= 20_000, `long turns outlived the close by only ${doneAt - closedAt} ms`);
    await c.releaseSession(a);
    await c.releaseSession(b);
  } catch (e) {
    console.error(log.slice(-30).join("\n"));
    throw e;
  } finally {
    c.stopSync();
    for (const w of ws) try { rmSync(w, { recursive: true, force: true }); } catch { /* Windows handle lag */ }
  }
});

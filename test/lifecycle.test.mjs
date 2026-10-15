import assert from "node:assert/strict";
import test from "node:test";

import { ZcodeProtocolClient, ZcodeProtocolError } from "../dist/protocol.js";

const SID = "sess_dddddddd-4444-4444-8444-444444444444";
const MODEL = { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3-Flash" };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * A client wired to a fake app-server: every request is answered with {} and
 * recorded; `onRequest` may emit protocol messages back.
 */
function fakeClient(lifecycle, onRequest = () => {}) {
  const c = new ZcodeProtocolClient("unused.cjs", () => {}, { reapEnabled: false, ...lifecycle });
  const calls = [];
  const emit = (msg) => c.handleMessage(msg);
  c.child = {
    pid: undefined,
    stdin: {
      write(line) {
        const msg = JSON.parse(line);
        if (typeof msg.id !== "number") return true; // a response we sent
        calls.push(msg.method);
        setImmediate(() => {
          emit({ id: msg.id, result: {} });
          onRequest(msg, emit);
        });
        return true;
      },
    },
  };
  c.ledger.open(SID);
  return { c, calls, emit };
}

const turnEvent = (type) => ({ method: "session/event", params: { sessionId: SID, type, payload: {} } });

test("turn end resolves the caller; release closes the session", async () => {
  const { c, calls } = fakeClient({}, (msg, emit) => {
    if (msg.method === "session/send") setTimeout(() => emit(turnEvent("turn.completed")), 10);
  });
  const r = await c.runTurn(SID, "hi", MODEL, "low", 5_000);
  assert.equal(r.ok, true);
  await c.releaseSession(SID);
  assert.deepEqual(calls, ["session/send", "session/close"]);
  assert.equal(c.ledger.isResident(SID), false);
});

test("timeout: the turn runs on in grace, and closes the session when it finishes by itself", async () => {
  const { c, calls, emit } = fakeClient({ turnGraceMs: 10_000 });
  await assert.rejects(c.runTurn(SID, "long", MODEL, "low", 30), (e) => e instanceof ZcodeProtocolError && e.code === "turn_timeout");
  assert.equal(c.isTurnInGrace(SID), true);
  await c.releaseSession(SID); // what zcode_run's finally does — must not close yet
  await tick(20);
  assert.deepEqual(calls, ["session/send"], "no stop and no close while the turn is in grace");
  assert.equal(c.ledger.isResident(SID), true);
  emit(turnEvent("turn.completed"));
  await tick(20);
  assert.deepEqual(calls, ["session/send", "session/close"]);
  assert.equal(c.isTurnInGrace(SID), false);
  assert.equal(c.ledger.isResident(SID), false);
});

test("timeout: when the grace period expires the turn is stopped, then the session closed", async () => {
  const { c, calls } = fakeClient({ turnGraceMs: 60 }, (msg, emit) => {
    if (msg.method === "session/stop") setTimeout(() => emit(turnEvent("turn.ended")), 5);
  });
  await assert.rejects(c.runTurn(SID, "long", MODEL, "low", 20), /timed out/);
  await tick(30);
  assert.deepEqual(calls, ["session/send"]);
  await tick(150);
  assert.deepEqual(calls, ["session/send", "session/stop", "session/close"]);
  assert.equal(c.ledger.isResident(SID), false);
});

test("a new turn on a session in grace stops the background turn first", async () => {
  let sends = 0;
  const { c, calls } = fakeClient({ turnGraceMs: 10_000 }, (msg, emit) => {
    if (msg.method === "session/stop") setTimeout(() => emit(turnEvent("turn.ended")), 5);
    if (msg.method === "session/send" && ++sends === 2) setTimeout(() => emit(turnEvent("turn.completed")), 5);
  });
  await assert.rejects(c.runTurn(SID, "long", MODEL, "low", 20), /timed out/);
  const r = await c.runTurn(SID, "follow-up", MODEL, "low", 5_000);
  assert.equal(r.ok, true);
  // the background turn's end must not close the session the new turn is using
  await tick(20);
  assert.deepEqual(calls, ["session/send", "session/stop", "session/send"]);
  assert.equal(c.ledger.isResident(SID), true);
});

test("idle reaper closes sessions without a turn for sessionIdleMs, not ones with a running turn", async () => {
  const other = "sess_eeeeeeee-5555-4555-8555-555555555555";
  const { c, calls } = fakeClient({ sessionIdleMs: 1_000 });
  c.ledger.open(other);
  const running = c.runTurn(other, "x", MODEL, "low", 5_000).catch(() => {});
  await tick(5);
  await c.idleTick(Date.now() + 5_000);
  assert.equal(c.ledger.isResident(SID), false);
  assert.equal(c.ledger.isResident(other), true);
  assert.deepEqual(calls.filter((m) => m === "session/close").length, 1);
  c.handleMessage({ method: "session/event", params: { sessionId: other, type: "turn.completed", payload: {} } });
  await running;
});

test("lifecycle defaults come from env", async () => {
  const saved = { g: process.env.ZCODE_TURN_GRACE_MS, i: process.env.ZCODE_SESSION_IDLE_MS, r: process.env.ZCODE_REAP };
  try {
    delete process.env.ZCODE_TURN_GRACE_MS;
    delete process.env.ZCODE_SESSION_IDLE_MS;
    delete process.env.ZCODE_REAP;
    let c = new ZcodeProtocolClient("x.cjs");
    assert.equal(c.lifecycle.turnGraceMs, 600_000);
    assert.equal(c.lifecycle.sessionIdleMs, 1_800_000);
    assert.equal(c.lifecycle.reapEnabled, true);
    process.env.ZCODE_TURN_GRACE_MS = "1234";
    process.env.ZCODE_SESSION_IDLE_MS = "bogus";
    process.env.ZCODE_REAP = "0";
    c = new ZcodeProtocolClient("x.cjs");
    assert.equal(c.lifecycle.turnGraceMs, 1234);
    assert.equal(c.lifecycle.sessionIdleMs, 1_800_000);
    assert.equal(c.lifecycle.reapEnabled, false);
  } finally {
    for (const [k, v] of [["ZCODE_TURN_GRACE_MS", saved.g], ["ZCODE_SESSION_IDLE_MS", saved.i], ["ZCODE_REAP", saved.r]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("three parallel turns: one finishes and is closed, the other two keep running", async () => {
  const S2 = "sess_ffffffff-6666-4666-8666-666666666666";
  const S3 = "sess_99999999-7777-4777-8777-777777777777";
  const { c, calls } = fakeClient({});
  c.ledger.open(S2);
  c.ledger.open(S3);
  const ev = (sid) => c.handleMessage({ method: "session/event", params: { sessionId: sid, type: "turn.completed", payload: {} } });
  const t1 = c.runTurn(SID, "a", MODEL, "low", 5_000);
  const t2 = c.runTurn(S2, "b", MODEL, "low", 5_000);
  const t3 = c.runTurn(S3, "c", MODEL, "low", 5_000);
  await tick(10);
  ev(SID);
  assert.equal((await t1).ok, true);
  await c.releaseSession(SID);
  assert.equal(c.ledger.isResident(SID), false);
  assert.equal(c.ledger.isResident(S2), true);
  assert.equal(c.ledger.isResident(S3), true);
  assert.deepEqual(calls.filter((m) => m !== "session/send"), ["session/close"], "only the finished session is closed");
  assert.ok(c.child, "the app-server is not touched");
  ev(S2);
  ev(S3);
  assert.equal((await t2).ok, true);
  assert.equal((await t3).ok, true);
});

test("app-server death settles every running turn with a clear error; later requests say why", async () => {
  const saved = { home: process.env.HOME, up: process.env.USERPROFILE };
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(`${tmpdir()}/zcode-mcp-home-`);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const S2 = "sess_ffffffff-6666-4666-8666-666666666666";
    const { c } = fakeClient({});
    c.ledger.open(S2);
    const t1 = c.runTurn(SID, "a", MODEL, "low", 5_000);
    const t2 = c.runTurn(S2, "b", MODEL, "low", 5_000);
    await tick(10);
    c.recordStderr(4242, "TypeError: Cannot read properties of undefined (reading 'x')\n    at foo (zcode.cjs:1:2)\n");
    let exits = 0;
    c.on("exit", () => exits++);
    c.onChildExit(c.child, 1, null);
    for (const r of [await t1, await t2]) {
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "app_server_exit");
      assert.match(r.error.message, /app-server died \(exit 1\) with 2 open session/);
      assert.match(r.error.message, /TypeError: Cannot read properties/);
    }
    assert.equal(exits, 1, "index.ts drops the client on exit, so the next call boots a new app-server");
    assert.equal(c.ledger.residentIds().length, 0);
    await assert.rejects(c.readMessages(SID), (e) => e.code === "no_child" && /app-server died/.test(e.message));
    const log = readFileSync(c.stderrLogPath(), "utf8");
    assert.match(log, /\[4242\] TypeError/);
    assert.match(log, /app-server died/);
  } finally {
    for (const [k, v] of [["HOME", saved.home], ["USERPROFILE", saved.up]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("an intentional stop is reported as a stop, not a death", async () => {
  const { c } = fakeClient({});
  const child = c.child;
  child.kill = () => true;
  const t = c.runTurn(SID, "a", MODEL, "low", 5_000);
  await tick(5);
  c.stopSync();
  c.onChildExit(child, null, "SIGKILL");
  const r = await t;
  assert.match(r.error.message, /^app-server stopped \(SIGKILL\)$/);
});

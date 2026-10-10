#!/usr/bin/env node
// Desktop-independence experiment: boot the zcode app-server with a VIRGIN HOME
// (no ~/.zcode at all — no desktop-written provider configs, no cli/config.json,
// no logs, no credentials) and observe what the CLI materializes by itself.
//
// Answers: does the CLI need anything the desktop wrote? Where does it put its
// own bundled provider config, and what builtin revision does it report?
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const ZCODE_BIN = process.env.ZCODE_BIN ?? join(homedir(), "AppData/Local/Programs/ZCode/resources/glm/zcode.cjs");
const FAKE_HOME = mkdtempSync(join(tmpdir(), "zcode-fresh-home-"));
const childEnv = { ...process.env, USERPROFILE: FAKE_HOME, HOME: FAKE_HOME, HOMEDRIVE: undefined, HOMEPATH: undefined };
// keep proxy/CAs from the real env; drop anything pointing at real ~/.zcode
delete childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
delete childEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;

console.log("fake HOME:", FAKE_HOME);
console.log("binary  :", ZCODE_BIN);

const child = spawn(process.execPath, [ZCODE_BIN, "app-server"], { stdio: ["pipe", "pipe", "inherit"], env: childEnv });
const notifications = [];
const t0 = Date.now();
let nextId = 1;
const pending = new Map();

function request(method, params, timeoutMs = 20000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
const respond = (id, result) => child.stdin.write(JSON.stringify({ id, result }) + "\n");

child.stdout.on("data", (buf) => {
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error).slice(0, 300))) : p.resolve(msg.result); }
      continue;
    }
    if (msg.method) {
      notifications.push(`+${Date.now() - t0}ms ${msg.method}`);
      if (msg.method === "session/requestRuntimePreferences") {
        respond(msg.id, { nativeSearchEnhancementsEnabled: true, memoryEnabled: true, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: "preflight-v1" });
      } else if (msg.id !== undefined) {
        respond(msg.id, {});
      }
    }
  }
});

function tree(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    out.push(prefix + e + (s.isDirectory() ? "/" : ""));
    if (s.isDirectory()) out.push(...tree(p, prefix + e + "/"));
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  // wait for the child's first unsolicited signal, then give it time to materialize
  await sleep(6000);
  console.log("\nnotifications received:", notifications.length ? "" : "(none)");
  for (const n of notifications.slice(0, 15)) console.log(" ", n);

  console.log("\nfake-home/.zcode tree:");
  for (const line of tree(join(FAKE_HOME, ".zcode"))) console.log(" ", line);

  // builtin provider configs materialized by the CLI alone:
  const runtimeRoot = join(FAKE_HOME, ".zcode/v2/runtime/provider");
  for (const line of tree(runtimeRoot)) console.log("  runtime:", line);

  // the CLI's own log: which builtin revision did it report?
  const logDir = join(FAKE_HOME, ".zcode/cli/log");
  if (existsSync(logDir)) {
    for (const f of readdirSync(logDir)) {
      const txt = readFileSync(join(logDir, f), "utf8");
      const m = txt.match(/"accountRevision":"account:\[\\"(zcode-builtin:[0-9]+:[a-f0-9]+)\\"/);
      console.log("log", f, "builtin revision:", m?.[1] ?? "(none found)");
    }
  } else console.log("no cli log dir under fake home");
} finally {
  child.kill("SIGKILL");
  process.exit(0);
}

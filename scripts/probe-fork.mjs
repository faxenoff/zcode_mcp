#!/usr/bin/env node
// Isolate how the app-server behaves under fork()+IPC: where do session/event notifications go?
import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { createHash, createDecipheriv } from "node:crypto";

const ZCODE_BIN = process.env.ZCODE_BIN ?? "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const child = fork(ZCODE_BIN, ["app-server"], { stdio: ["pipe", "pipe", "pipe", "ipc"] });

let nextId = 1;
const pending = new Map();
const req = (method, params) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
const respond = (id, result) => child.stdin.write(JSON.stringify({ id, result }) + "\n");

let buf = "";
const counts = { stdoutEvents: 0, ipcObjects: 0, ipcStrings: 0 };
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    handle(m, "stdout");
  }
});
child.on("message", (m) => {
  if (typeof m === "string") {
    counts.ipcStrings++;
    try { handle(JSON.parse(m), "ipc-string"); } catch {}
  } else if (m && typeof m === "object") {
    counts.ipcObjects++;
    handle(m, "ipc-object");
  }
});

function handle(m, via) {
  if (typeof m.id === "number" && (m.result !== undefined || m.error !== undefined)) {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error).slice(0, 300))) : p.res(m.result);
    }
    return;
  }
  if (!m.method) return;
  if (m.method === "session/event") {
    counts.stdoutEvents++;
    if (counts.stdoutEvents <= 4) console.log(`[event via ${via}] FULL: ${JSON.stringify(m.params).slice(0, 700)}`);
    else console.log(`[event via ${via}] keys=${Object.keys(m.params).join(",")} payloadKeys=${Object.keys(m.params?.payload ?? {}).join(",")}`);
    return;
  }
  console.log(`[${via}] ${m.method}`);
  if (m.method === "session/requestRuntimePreferences") {
    respond(m.id, { nativeSearchEnhancementsEnabled: true, memoryEnabled: true, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: "preflight-v1" });
  } else if (m.method === "interaction/requestProviderRuntimeHeaders") {
    const apiKey = readApiKey(m.params?.providerId);
    respond(m.id, apiKey ? { headersApplied: true, requestAuth: { apiKey } } : { headersApplied: false, errorMessage: "no key" });
  } else if (m.method?.startsWith("interaction/")) {
    respond(m.id, { decision: "deny" });
  }
}

function readApiKey(providerId) {
  try {
    const cred = JSON.parse(readFileSync(`${homedir()}/.zcode/v2/credentials.json`, "utf8"));
    for (const [k, v] of Object.entries(cred)) {
      if (k.startsWith(`account-provider:coding-plan:${providerId}:account:`) && k.endsWith(":api-key")) {
        if (!v.startsWith("enc:v1:")) return v;
        const secret = `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
        const key = createHash("sha256").update(secret).digest();
        const [a, b, c] = v.slice(7).split(".");
        const d = createDecipheriv("aes-256-gcm", key, Buffer.from(a, "base64url"));
        d.setAuthTag(Buffer.from(b, "base64url"));
        return Buffer.concat([d.update(Buffer.from(c, "base64url")), d.final()]).toString();
      }
    }
  } catch {}
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("counts:", JSON.stringify(counts)); child.kill("SIGKILL"); process.exit(0); }, 60000).unref?.();

await sleep(1500);
await req("provider/updateAccountConfig", {
  revision: "account:probe:" + Date.now(),
  basedOnZCodeBuiltinRevision: "zcode-builtin:30:88e38574b72855470e74ea688babe38a5e8c14a42c908cb73098e115a0705a5d",
  providers: { "account:bigmodel-individual-coding-plan": { access: { type: "zhipu-account", entitled: true } } },
  states: { "account:bigmodel-individual-coding-plan": { availability: "available", entitled: true, current: true } },
});
const created = await req("session/create", { workspace: { workspacePath: "/tmp", workspaceKey: "/tmp" }, mode: "yolo", titleGenerationEnabled: false });
const snap = created.value ?? created;
const sid = snap.session?.sessionId ?? snap.sessionId;
console.log("sessionId:", sid);
await req("session/subscribe", { sessionId: sid, deliveryKind: "desktop-continuous" }).catch((e) => console.log("subscribe err", e.message.slice(0, 150)));
await req("session/send", { sessionId: sid, content: "Reply with exactly one word: ok", modelSelection: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3", options: { reasoningLevel: "max" } } });
console.log("sent; waiting 45s...");
await sleep(45000);
console.log("counts:", JSON.stringify(counts));
child.kill("SIGKILL");
process.exit(0);

#!/usr/bin/env node
// Probe the zcode app-server protocol (ZCode Protocol over stdio, line-delimited JSON).
// v3: pushes account provider config + answers provider runtime headers, then runs a prompt.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import { createHash, createDecipheriv } from "node:crypto";

const ZCODE_BIN = process.env.ZCODE_BIN ?? "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const prompt = process.argv[2] ?? "Reply with exactly one word: ok";
const PROVIDER = process.env.ZCODE_MODEL_PROVIDER ?? "account:bigmodel-individual-coding-plan";
const MODEL = process.env.ZCODE_MODEL_ID ?? "GLM-5.3";

// --- credential lookup + decrypt (zcode credential store: aes-256-gcm, "enc:v1:iv.tag.ct" base64url)
function decryptCredential(v) {
  if (typeof v !== "string" || !v.startsWith("enc:v1:")) return v;
  const secret = (process.env.ZCODE_CREDENTIAL_SECRET ?? "").trim() ||
    `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  const key = createHash("sha256").update(secret).digest();
  const parts = v.slice("enc:v1:".length).split(".");
  const iv = Buffer.from(parts[0], "base64url");
  const tag = Buffer.from(parts[1], "base64url");
  const ct = Buffer.from(parts[2], "base64url");
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

function findApiKey(providerId) {
  const cred = JSON.parse(readFileSync(join(homedir(), ".zcode/v2/credentials.json"), "utf8"));
  const prefix = `account-provider:coding-plan:${providerId}:account:`;
  for (const [k, v] of Object.entries(cred)) {
    if (k.startsWith(prefix) && k.endsWith(":api-key") && typeof v === "string" && v.trim()) {
      try {
        return { apiKey: decryptCredential(v.trim()), key: k };
      } catch (e) {
        console.log(`[credential] decrypt failed for ${k}: ${e.message}`);
        return null;
      }
    }
  }
  return null;
}

// --- account provider push payload (mirrors what the desktop app sends) ---
function buildAccountConfig(providerId) {
  const providers = {};
  const states = {};
  const list = [
    "account:zai-individual-coding-plan",
    "account:zai-team-coding-plan",
    "account:zai-start-plan",
    "account:bigmodel-individual-coding-plan",
    "account:bigmodel-team-coding-plan",
    "account:bigmodel-start-plan",
    "account:zai-offpeak-idle-plan",
    "account:bigmodel-offpeak-idle-plan",
  ];
  for (const p of list) {
    const entitled = p === providerId;
    providers[p] = { access: { type: "zhipu-account", entitled } };
    states[p] = {
      availability: entitled ? "available" : "unavailable",
      entitled,
      ...(entitled ? { current: true } : { current: false, unavailableReason: "not-entitled" }),
    };
  }
  const basedOn = "zcode-builtin:30:88e38574b72855470e74ea688babe38a5e8c14a42c908cb73098e115a0705a5d";
  const revision = `account:zcode-mcp:${Date.now()}`;
  return { revision, basedOnZCodeBuiltinRevision: basedOn, providers, states };
}

const childEnv = { ...process.env };
if (!childEnv.NODE_EXTRA_CA_CERTS) {
  try {
    const { execSync } = await import("node:child_process");
    const pem = execSync(
      "security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain",
      { maxBuffer: 20 * 1024 * 1024 }
    );
    if (pem.length > 1000) {
      const path = join(homedir(), ".zcode-mcp-system-roots.pem");
      (await import("node:fs")).writeFileSync(path, pem);
      childEnv.NODE_EXTRA_CA_CERTS = path;
      console.log(`[tls] exported macOS system roots to ${path}`);
    }
  } catch {}
}
if (!childEnv.HTTPS_PROXY && process.env.ZCODE_MCP_AUTO_PROXY !== "0") {
  try {
    const { execSync } = await import("node:child_process");
    const out = execSync("scutil --proxy").toString();
    const enabled = /HTTPSEnable : 1/.test(out);
    const host = out.match(/HTTPSProxy : (\S+)/)?.[1];
    const port = out.match(/HTTPSPort : (\d+)/)?.[1];
    if (enabled && host && port) {
      childEnv.HTTPS_PROXY = `http://${host}:${port}`;
      childEnv.HTTP_PROXY = `http://${host}:${port}`;
      console.log(`[proxy] using system proxy ${host}:${port}`);
    }
  } catch {}
}
const child = spawn("node", [ZCODE_BIN, "app-server"], { stdio: ["pipe", "pipe", "inherit"], env: childEnv });

let nextId = 1;
const pending = new Map();
const logs = [];

function request(method, params, timeoutMs = 20000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
function respond(id, result) {
  child.stdin.write(JSON.stringify({ id, result }) + "\n");
}

child.stdout.on("data", (buf) => {
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      if (msg.id === "server-*" || typeof msg.id === "string") {
        // server->client request responses are not ours; requests come as {id,method,params}
      }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error).slice(0, 400))) : p.resolve(msg.result); }
      continue;
    }
    if (msg.method) handleServerMessage(msg);
  }
});

function handleServerMessage(msg) {
  const t = msg.params?.type ?? "";
  if (msg.method === "session/event") {
    const kind = msg.params?.payload?.type ?? t;
    if (!logs.includes(kind)) { logs.push(kind); console.log(`[event] ${kind}`); }
    if (kind === "turn.failed" || kind === "turn.ended" || kind === "message.completed") {
      console.log(`[VERBOSE ${kind}]`, JSON.stringify(msg.params.payload).slice(0, 900));
    }
    return;
  }
  if (msg.method === "session/requestRuntimePreferences") {
    console.log(`[prefs] scope=${msg.params?.scope}`);
    respond(msg.id, {
      nativeSearchEnhancementsEnabled: true,
      memoryEnabled: true,
      askUserQuestionAutoResolutionEnabled: true,
      modelContextBudgetStrategy: "preflight-v1",
    });
    return;
  }
  if (msg.method === "interaction/requestProviderRuntimeHeaders") {
    const { providerId, modelId } = msg.params ?? {};
    console.log(`[runtime-headers] provider=${providerId} model=${modelId}`);
    const found = findApiKey(providerId);
    if (!found) { respond(msg.id, { headersApplied: false, errorMessage: `no api key for ${providerId}` }); return; }
    respond(msg.id, { headersApplied: true, requestAuth: { apiKey: found.apiKey } });
    return;
  }
  if (msg.method?.startsWith("interaction/")) {
    console.log(`[interaction ${msg.method}]`, JSON.stringify(msg.params).slice(0, 300), "→ deny");
    respond(msg.id, { decision: "deny" });
    return;
  }
  if (msg.method !== "startup/storageState" && !msg.method.startsWith("process/") && !msg.method.startsWith("v4/") && !msg.method.startsWith("computer-use/")) {
    console.log(`[notification] ${msg.method}`, JSON.stringify(msg.params).slice(0, 200));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("[watchdog] kill"); child.kill("SIGKILL"); process.exit(0); }, 75000).unref?.();

try {
  await sleep(1200);

  // 0. push account provider config (desktop role)
  const push = await request("provider/updateAccountConfig", buildAccountConfig(PROVIDER));
  console.log("\n=== provider/updateAccountConfig ===", JSON.stringify(push).slice(0, 300));

  // 1. create session
  const created = await request("session/create", {
    workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
    mode: "yolo",
    titleGenerationEnabled: false,
  });
  const snap = created.value ?? created;
  const sessionId = snap.session?.sessionId;
  console.log("\n=== session/create ===", sessionId);
  console.log("--- settings ---", JSON.stringify(snap.settings).slice(0, 400));

  // 2. subscribe + send with model selection
  await request("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" }).catch((e) => console.log("subscribe failed:", e.message.slice(0, 200)));
  const sent = await request("session/send", {
    sessionId,
    content: prompt,
    modelSelection: { providerId: PROVIDER, modelId: MODEL, options: { reasoningLevel: process.env.ZCODE_REASONING ?? "max" } },
  });
  console.log("\n=== session/send ===", JSON.stringify(sent).slice(0, 200));

  // 3. wait for turn end
  await sleep(45000);

  // 4. read messages
  const msgs = await request("session/messages", { sessionId }).catch((e) => ({ error: e.message.slice(0, 150) }));
  const list = msgs?.messages ?? [];
  console.log(`\n=== session/messages (${list.length}) ===`);
  (await import("node:fs")).writeFileSync("/tmp/probe-msgs.json", JSON.stringify(list, null, 1));

  await request("session/close", { sessionId }).catch(() => {});
} catch (e) {
  console.log("\n[probe error]", e.message.slice(0, 500));
} finally {
  child.kill("SIGKILL");
  process.exit(0);
}

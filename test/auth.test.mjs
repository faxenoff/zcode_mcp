import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import test from "node:test";

import {
  ProjectTokenResolver,
  decryptCredential,
  familyOf,
  hasLegacyKeys,
  legacyApiKey,
  locationKey,
  oauthFamilies,
  oauthLogin,
  storedLocation,
} from "../dist/auth.js";
import { pickModel } from "../dist/models.js";
import { parseDesktopAccountLine } from "../dist/protocol.js";

/** Same scheme as the zcode credential store ("enc:v1:<iv>.<tag>.<ct>", aes-256-gcm). */
function enc(plain) {
  const secret =
    (process.env.ZCODE_CREDENTIAL_SECRET ?? "").trim() ||
    `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `enc:v1:${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}

const USER = "50529cd2-b6b6-43f1-92b7-1cc337773006";
const OLD_USER = "dfececd3-34e0-494a-84fd-1c5d1ac72cf3";
const LOC = { organizationId: "org-1", projectId: "proj-1", apiKeyId: "k".repeat(32) };

/** A ZCode 3.15.3 store: OAuth login + project-key pointers for two accounts, no api keys. */
function oauthStore() {
  return {
    "oauth:active_provider": enc("zai"),
    "oauth:zai:access_token": enc("biz.jwt.token"),
    "oauth:zai:user_info": enc(JSON.stringify({ user_id: USER, email: "x@y", name: "n" })),
    [locationKey("https://api.z.ai", "zai", OLD_USER, "non-team")]: enc(JSON.stringify({ ...LOC, apiKeyId: "o".repeat(32) })),
    [locationKey("https://api.z.ai", "zai", USER, "non-team")]: enc(JSON.stringify(LOC)),
  };
}

test("locationKey reproduces the key names ZCode 3.15.3 writes", () => {
  assert.equal(
    locationKey("https://api.z.ai", "zai", OLD_USER, "non-team"),
    "project-key-location:v1:%5B%22https%3A%2F%2Fapi.z.ai%22%2C%22zai%22%2C%22dfececd3-34e0-494a-84fd-1c5d1ac72cf3%22%2Cnull%2C1%2C%22non-team%22%5D",
  );
});

test("OAuth store: login, family, pointer of the CURRENT user; no legacy keys", () => {
  const s = oauthStore();
  assert.equal(decryptCredential(s["oauth:active_provider"]), "zai");
  assert.equal(hasLegacyKeys(s), false);
  assert.deepEqual(oauthFamilies(s), ["zai"]);
  const login = oauthLogin(s, "zai");
  assert.equal(login.userId, USER);
  assert.deepEqual(storedLocation(s, "zai", login.userId), LOC);
  assert.equal(oauthLogin(s, "bigmodel"), null);
  assert.equal(familyOf("account:zai-start-plan"), "zai");
  assert.equal(familyOf("account:bigmodel-individual-coding-plan"), "bigmodel");
  assert.equal(familyOf("custom:x"), null);
});

test("legacy store (ZCode <= 3.14) still yields the stored api key", () => {
  const s = { "account-provider:coding-plan:account:zai-individual-coding-plan:account:42:api-key": enc("legacy-key") };
  assert.equal(hasLegacyKeys(s), true);
  assert.equal(legacyApiKey(s, "account:zai-individual-coding-plan"), "legacy-key");
  assert.equal(legacyApiKey(s, "account:zai-start-plan"), null);
});

function fakeHttp(routes) {
  const calls = [];
  const http = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
    const h = routes.find(([re]) => re.test(path));
    if (!h) return { status: 404, json: null };
    return h[1](init, calls.length);
  };
  return { http, calls };
}

const tokenOk = (token = "proj-token") => ({
  status: 200,
  json: { code: 200, msg: "Operation successful", data: { enabled: true, accessToken: token, tokenType: "Bearer", expiresIn: 17296, expiresAt: Math.floor(Date.now() / 1000) + 17296 } },
});

test("project token: the stored token is used as the business token, result is cached", async () => {
  const { http, calls } = fakeHttp([[/\/access_tokens$/, () => tokenOk()]]);
  const r = new ProjectTokenResolver(http);
  const s = oauthStore();
  const login = oauthLogin(s, "zai");
  assert.deepEqual(await r.resolve(login, s), { apiKey: "proj-token", apiKeyId: LOC.apiKeyId });
  assert.deepEqual(await r.resolve(login, s), { apiKey: "proj-token", apiKeyId: LOC.apiKeyId });
  assert.equal(calls.length, 1, "second call served from cache");
  assert.equal(calls[0].path, `/api/biz/v1/organization/org-1/projects/proj-1/api_keys/${LOC.apiKeyId}/access_tokens`);
  assert.equal(calls[0].auth, "Bearer biz.jwt.token");
  assert.equal(calls[0].body.clientType, "zcode");
});

test("project token: a rejected stored token is exchanged via auth/z/login, then retried", async () => {
  const { http, calls } = fakeHttp([
    [/\/api\/auth\/z\/login$/, () => ({ status: 200, json: { code: 200, data: { access_token: "exchanged", expires_in: 3600 } } })],
    [/\/access_tokens$/, (init) => (init.headers.Authorization === "Bearer exchanged" ? tokenOk("t2") : { status: 401, json: null })],
  ]);
  const s = oauthStore();
  const res = await new ProjectTokenResolver(http).resolve(oauthLogin(s, "zai"), s);
  assert.equal(res.apiKey, "t2");
  assert.deepEqual(calls.map((c) => c.path.split("/").pop()), ["access_tokens", "login", "access_tokens"]);
});

test("project token: disabled key and server-side error codes are errors, not tokens", async () => {
  const s = oauthStore();
  const login = oauthLogin(s, "zai");
  let { http } = fakeHttp([[/\/access_tokens$/, () => ({ status: 200, json: { code: 200, data: { enabled: false } } })]]);
  await assert.rejects(new ProjectTokenResolver(http).resolve(login, s), /token_disabled/);
  ({ http } = fakeHttp([[/\/access_tokens$/, () => ({ status: 200, json: { code: 500, msg: "x" } })]]));
  await assert.rejects(new ProjectTokenResolver(http).resolve(login, s), /request_rejected/);
});

test("project token: without a stored pointer the existing zcode-api-key is discovered (read-only)", async () => {
  const s = oauthStore();
  for (const k of Object.keys(s)) if (k.startsWith("project-key-location:")) delete s[k];
  const { http, calls } = fakeHttp([
    [/getCustomerInfo$/, () => ({
      status: 200,
      json: { code: 200, data: { organizations: [{ organizationId: "o9", organizationName: "默认机构", projects: [{ projectId: "p2", projectType: 2 }, { projectId: "p9", projectName: "默认项目" }] }] } },
    })],
    [/\/api_keys$/, () => ({ status: 200, json: { code: 200, data: [{ name: "other", apiKey: "a" }, { name: "zcode-api-key", apiKey: "z".repeat(32) }] } })],
    [/\/access_tokens$/, () => tokenOk("t3")],
  ]);
  const res = await new ProjectTokenResolver(http).resolve(oauthLogin(s, "zai"), s);
  assert.deepEqual(res, { apiKey: "t3", apiKeyId: "z".repeat(32) });
  assert.ok(!calls.some((c) => c.body?.name), "never creates a key");
  assert.match(calls.at(-1).path, /organization\/o9\/projects\/p9\//);
});

test("desktop account log line: entitlements, current flags and builtinModelIds", () => {
  const inner = JSON.stringify([
    "zcode-builtin:31:abc",
    [
      { providerId: "account:zai-individual-coding-plan", config: { access: { type: "zhipu-account", entitled: true } } },
      { providerId: "account:zai-start-plan", config: { access: { type: "zhipu-account", entitled: true }, builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"] } },
      { providerId: "account:bigmodel-start-plan", config: { access: { type: "zhipu-account", entitled: false } } },
    ],
    {
      "account:zai-individual-coding-plan": { availability: "available", entitled: true, current: true },
      "account:zai-start-plan": { availability: "available", entitled: true, current: true },
      "account:bigmodel-start-plan": { availability: "unavailable", entitled: false },
    },
  ]);
  const line = `[2026-10-15 20:15:21.379] [info] account provider config 已交付到 ZCode agent {"receivedRevision":${JSON.stringify(`account:${inner}`)},"status":"received"}`;
  const snap = parseDesktopAccountLine(line);
  assert.deepEqual(snap.providers["account:zai-start-plan"].builtinModelIds, ["GLM-5.3", "GLM-5.3-Flash"]);
  assert.equal(snap.states["account:zai-individual-coding-plan"].current, true);
  assert.equal(snap.states["account:bigmodel-start-plan"].entitled, false);
  assert.equal(parseDesktopAccountLine("no revision here"), null);
});

test("pickModel: preferred provider first, start plans last", () => {
  const m = (providerId, modelId) => ({ providerId, modelId });
  const models = [
    m("account:zai-start-plan", "GLM-5.3"),
    m("account:zai-start-plan", "GLM-5.3-Flash"),
    m("account:zai-individual-coding-plan", "GLM-5.3"),
    m("account:zai-individual-coding-plan", "GLM-5.3-Flash"),
  ];
  const saved = process.env.ZCODE_PROVIDER;
  try {
    delete process.env.ZCODE_PROVIDER;
    assert.equal(pickModel(models, "GLM-5.3-Flash").model.providerId, "account:zai-individual-coding-plan");
    process.env.ZCODE_PROVIDER = "account:zai-start-plan";
    assert.equal(pickModel(models).model.providerId, "account:zai-start-plan");
    process.env.ZCODE_PROVIDER = "account:zai-individual-coding-plan";
    assert.equal(pickModel(models.slice(0, 2), "GLM-5.3").model.providerId, "account:zai-start-plan", "fallback when the preferred one has none");
  } finally {
    if (saved === undefined) delete process.env.ZCODE_PROVIDER;
    else process.env.ZCODE_PROVIDER = saved;
  }
});

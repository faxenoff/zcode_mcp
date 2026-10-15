/**
 * Coding-plan credentials for the app-server's `interaction/requestProviderRuntimeHeaders`.
 *
 * Two storage formats exist in ~/.zcode/v2/credentials.json (values "enc:v1:..."):
 *
 * - legacy (ZCode <= 3.14): the coding-plan api key itself, under
 *   `account-provider:coding-plan:<providerId>:account:<id>:api-key`.
 * - OAuth (ZCode 3.15+): no api key is stored. The login keeps
 *   `oauth:<family>:access_token` and `oauth:<family>:user_info` ({user_id, ...}),
 *   and a per-account pointer `project-key-location:v1:<urlencoded JSON
 *   [origin, family, userId, team|null, 1 (usageScene CODING_PLAN), "non-team"|"default"]>`
 *   whose value is JSON {organizationId, projectId, apiKeyId}. The key sent to the model
 *   is a short-lived project access token, minted per request batch exactly like the
 *   desktop host does (zcode.cjs createCodingPlanApiKeyResolver / ProjectAccessTokenClient):
 *     1. business token: ZCode 3.15.3 already stores it as oauth:zai:access_token (a JWT with
 *        user_id/customer_id/api_key claims), so it is used as is. Only when the server rejects it
 *        (401/403) is it treated as a chat.z.ai OAuth token and exchanged:
 *        POST https://api.z.ai/api/auth/z/login {token} -> {data: {access_token, expires_in}}.
 *     2. location from the pointer above; if missing, GET <origin>/api/biz/customer/getCustomerInfo
 *        + GET .../api_keys and pick the "zcode-api-key" (read-only discovery, nothing is created)
 *     3. POST <origin>/api/biz/v1/organization/<org>/projects/<project>/api_keys/<apiKeyId>/access_tokens
 *        {clientType: "zcode", clientVersion} -> {code: 200, data: {enabled, accessToken, tokenType: "Bearer",
 *        expiresIn (s, ~4.8 h), expiresAt (epoch s)}}
 *   The answer is `requestAuth: {apiKey: accessToken, apiKeyId}`.
 */
import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { arch, homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

export type Family = "zai" | "bigmodel";

export const ORIGINS: Record<Family, string> = {
  zai: "https://api.z.ai",
  bigmodel: process.env.BIGMODEL_API_BASE_URL?.replace(/\/+$/, "") || "https://bigmodel.cn",
};

export function credentialsPath(): string {
  return join(homedir(), ".zcode/v2/credentials.json");
}

export function readStore(path = credentialsPath()): Record<string, string> {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** zcode credential store values: "enc:v1:<iv>.<tag>.<ciphertext>", aes-256-gcm, base64url parts. */
export function decryptCredential(v: string): string {
  if (!v.startsWith("enc:v1:")) return v;
  const secret =
    (process.env.ZCODE_CREDENTIAL_SECRET ?? "").trim() ||
    `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  const key = createHash("sha256").update(secret).digest();
  const parts = v.slice("enc:v1:".length).split(".");
  if (parts.length !== 3) throw new Error("credential: invalid ciphertext format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "base64url"));
  d.setAuthTag(Buffer.from(parts[1], "base64url"));
  return Buffer.concat([d.update(Buffer.from(parts[2], "base64url")), d.final()]).toString("utf8");
}

export function familyOf(providerId: string): Family | null {
  if (providerId.startsWith("account:zai-")) return "zai";
  if (providerId.startsWith("account:bigmodel-")) return "bigmodel";
  return null;
}

/** Legacy stored api key for a provider (ZCode <= 3.14), decrypted. */
export function legacyApiKey(store: Record<string, string>, providerId: string): string | null {
  const prefix = `account-provider:coding-plan:${providerId}:account:`;
  for (const [k, v] of Object.entries(store)) {
    if (k.startsWith(prefix) && k.endsWith(":api-key") && v.trim()) {
      try { return decryptCredential(v.trim()); } catch { return null; }
    }
  }
  return null;
}

export function hasLegacyKeys(store: Record<string, string>): boolean {
  return Object.entries(store).some(
    ([k, v]) => k.startsWith("account-provider:coding-plan:") && k.endsWith(":api-key") && v.trim().length > 0,
  );
}

function decryptOr(store: Record<string, string>, key: string): string | null {
  const v = store[key]?.trim();
  if (!v) return null;
  try { return decryptCredential(v).trim() || null; } catch { return null; }
}

/** Families with an OAuth login in the store. */
export function oauthFamilies(store: Record<string, string>): Family[] {
  return (["zai", "bigmodel"] as const).filter((f) => !!store[`oauth:${f}:access_token`]?.trim());
}

export interface OAuthLogin {
  family: Family;
  accessToken: string;
  userId: string | null;
}

export function oauthLogin(store: Record<string, string>, family: Family): OAuthLogin | null {
  const accessToken = decryptOr(store, `oauth:${family}:access_token`);
  if (!accessToken) return null;
  let userId: string | null = null;
  const info = decryptOr(store, `oauth:${family}:user_info`);
  if (info) {
    try {
      const j = JSON.parse(info) as { user_id?: unknown; userId?: unknown };
      const id = j.user_id ?? j.userId;
      if (typeof id === "string" || typeof id === "number") userId = String(id);
    } catch { /* no user id */ }
  }
  return { family, accessToken, userId };
}

export interface KeyLocation {
  organizationId: string;
  projectId: string;
  apiKeyId: string;
}

/** Credential-store key of the project-key pointer, as zcode.cjs ProjectAccessTokenClient builds it. */
export function locationKey(origin: string, family: Family, accountId: string, selection: string): string {
  return `project-key-location:v1:${encodeURIComponent(JSON.stringify([origin, family, accountId, null, 1, selection]))}`;
}

export function storedLocation(
  store: Record<string, string>,
  family: Family,
  userId: string | null,
): KeyLocation | null {
  if (!userId) return null;
  for (const sel of ["non-team", "default"]) {
    const raw = decryptOr(store, locationKey(ORIGINS[family], family, userId, sel));
    if (!raw) continue;
    try {
      const j = JSON.parse(raw) as Partial<KeyLocation>;
      if (j.organizationId && j.projectId && j.apiKeyId) {
        return { organizationId: j.organizationId, projectId: j.projectId, apiKeyId: j.apiKeyId };
      }
    } catch { /* malformed pointer */ }
  }
  return null;
}

/** Desktop app version (clientVersion of the token request): newest materialised provider runtime dir. */
export function desktopVersion(): string {
  if (process.env.ZCODE_CLIENT_VERSION) return process.env.ZCODE_CLIENT_VERSION;
  try {
    const os = platform() === "win32" ? "windows" : platform() === "darwin" ? "darwin" : "linux";
    const cpu = arch() === "arm64" ? "aarch64" : "x86_64";
    const dir = join(homedir(), ".zcode/v2/runtime/provider", `${os}-${cpu}`);
    const vers = readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && statSync(join(dir, v)).isDirectory());
    vers.sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
    if (vers.length) return vers[vers.length - 1];
  } catch { /* fall through */ }
  return "0.0.0-dev";
}

export function jwtExpiryMs(token: string): number | undefined {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof p.exp === "number" && Number.isFinite(p.exp) ? p.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export interface HttpResponse {
  status: number;
  json: unknown;
}
export type HttpFn = (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

export const defaultHttp: HttpFn = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
};

export class CodingPlanAuthError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "CodingPlanAuthError";
  }
}

interface Cached {
  token: string;
  refreshAt: number;
}

function dataOf(json: unknown, what: string): any {
  const j = json as { code?: unknown; data?: unknown; msg?: unknown } | null;
  if (!j || typeof j !== "object") throw new CodingPlanAuthError("invalid_response", what);
  if (j.code != null && ![0, 200, "0", "200"].includes(j.code as never)) {
    throw new CodingPlanAuthError("request_rejected", `${what} code=${String(j.code)}`);
  }
  return j.data;
}

/**
 * Mints project access tokens from the OAuth login. Caches the business token and the
 * project token until shortly before expiry (2 min margin), keyed by the OAuth token so a
 * re-login in the desktop app is picked up without a restart.
 */
export class ProjectTokenResolver {
  private business = new Map<string, Cached>();
  private project = new Map<string, Cached & { apiKeyId: string }>();
  private location = new Map<string, KeyLocation>();

  constructor(
    private readonly http: HttpFn = defaultHttp,
    private readonly now: () => number = Date.now,
  ) {}

  clear(): void {
    this.business.clear();
    this.project.clear();
    this.location.clear();
  }

  async resolve(login: OAuthLogin, store: Record<string, string>): Promise<{ apiKey: string; apiKeyId: string }> {
    // ZCode 3.15.3 stores the business token itself under oauth:zai:access_token; an older
    // (chat.z.ai OAuth) token is exchanged first. Try as stored, exchange on rejection.
    try {
      return await this.resolveWith(login, store, login.accessToken);
    } catch (e) {
      if (login.family !== "zai" || !(e instanceof CodingPlanAuthError) || e.code !== "login_expired") throw e;
      const biz = await this.businessToken(ORIGINS.zai, login.accessToken);
      return this.resolveWith(login, store, biz);
    }
  }

  private async resolveWith(
    login: OAuthLogin,
    store: Record<string, string>,
    bizToken: string,
  ): Promise<{ apiKey: string; apiKeyId: string }> {
    const origin = ORIGINS[login.family];
    const scope = `${login.family}|${login.accessToken}`;
    let loc = this.location.get(scope) ?? storedLocation(store, login.family, login.userId);
    if (!loc) loc = await this.discover(origin, login.family, bizToken);
    this.location.set(scope, loc);

    const cacheKey = `${scope}|${bizToken.length}:${bizToken.slice(-16)}|${loc.organizationId}|${loc.projectId}|${loc.apiKeyId}`;
    const hit = this.project.get(cacheKey);
    if (hit && this.now() < hit.refreshAt) return { apiKey: hit.token, apiKeyId: hit.apiKeyId };

    const url =
      `${origin}/api/biz/v1/organization/${encodeURIComponent(loc.organizationId)}` +
      `/projects/${encodeURIComponent(loc.projectId)}/api_keys/${encodeURIComponent(loc.apiKeyId)}/access_tokens`;
    const res = await this.http(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${bizToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientType: "zcode", clientVersion: desktopVersion() }),
    });
    if (res.status === 401 || res.status === 403) {
      this.business.delete(login.accessToken);
      throw new CodingPlanAuthError("login_expired", "the ZCode login was rejected — log in again in the desktop app");
    }
    if (res.status === 404) {
      this.location.delete(scope);
      throw new CodingPlanAuthError("key_not_found", "the coding-plan api key pointed to by the login is gone");
    }
    if (res.status < 200 || res.status >= 300) throw new CodingPlanAuthError("request_failed", `access_tokens HTTP ${res.status}`);
    const d = dataOf(res.json, "access_tokens") as
      | { enable?: boolean; enabled?: boolean; accessToken?: string; expiresIn?: number; expiresAt?: number }
      | undefined;
    // the schema in zcode.cjs says `enable`, the server (10.2026) answers `enabled`
    if (!d || d.enable === false || d.enabled === false) throw new CodingPlanAuthError("token_disabled", "the coding plan key is disabled");
    const token = d.accessToken?.trim();
    if (!token) throw new CodingPlanAuthError("invalid_response", "access_tokens without accessToken");
    const now = this.now();
    const expiries = [
      typeof d.expiresAt === "number" ? d.expiresAt * 1000 : undefined,
      typeof d.expiresIn === "number" ? now + d.expiresIn * 1000 : undefined,
    ].filter((x): x is number => x !== undefined && Number.isFinite(x));
    const expiresAt = expiries.length ? Math.min(...expiries) : now + 300_000;
    this.project.set(cacheKey, { token, apiKeyId: loc.apiKeyId, refreshAt: expiresAt - 120_000 });
    return { apiKey: token, apiKeyId: loc.apiKeyId };
  }

  private async businessToken(origin: string, oauthToken: string): Promise<string> {
    const hit = this.business.get(oauthToken);
    if (hit && this.now() < hit.refreshAt) return hit.token;
    const res = await this.http(`${origin}/api/auth/z/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: oauthToken }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new CodingPlanAuthError("login_expired", "the ZCode login was rejected — log in again in the desktop app");
    }
    if (res.status < 200 || res.status >= 300) throw new CodingPlanAuthError("login_failed", `auth/z/login HTTP ${res.status}`);
    const d = dataOf(res.json, "auth/z/login") as { access_token?: string; accessToken?: string; expires_in?: number; expiresIn?: number } | undefined;
    const token = (d?.access_token ?? d?.accessToken)?.trim();
    if (!token) throw new CodingPlanAuthError("login_failed", "auth/z/login returned no token");
    const now = this.now();
    const expiresIn = d?.expires_in ?? d?.expiresIn;
    const expiries = [jwtExpiryMs(token), typeof expiresIn === "number" ? now + expiresIn * 1000 : undefined].filter(
      (x): x is number => x !== undefined,
    );
    const expiresAt = expiries.length ? Math.min(...expiries) : now + 300_000;
    this.business.set(oauthToken, { token, refreshAt: expiresAt - 120_000 });
    return token;
  }

  /** Read-only: find the existing "zcode-api-key" of the personal default project. */
  private async discover(origin: string, family: Family, bizToken: string): Promise<KeyLocation> {
    const info = await this.http(`${origin}/api/biz/customer/getCustomerInfo`, {
      method: "GET",
      headers: { Authorization: bizToken, "Content-Type": "application/json" },
    });
    if (info.status < 200 || info.status >= 300) throw new CodingPlanAuthError("discovery_failed", `getCustomerInfo HTTP ${info.status}`);
    const orgs = ((dataOf(info.json, "getCustomerInfo") as { organizations?: unknown[] } | undefined)?.organizations ?? []) as {
      organizationId?: string;
      organizationName?: string | null;
      projects?: { projectId?: string; projectName?: string | null; projectType?: string | number | null }[];
    }[];
    const candidates = orgs
      .map((o) => ({ ...o, projects: (o.projects ?? []).filter((p) => String(p.projectType ?? "").trim() !== "2") }))
      .filter((o) => o.organizationId && o.projects.length);
    const org = candidates.find((o) => o.organizationName?.includes("默认机构")) ?? candidates[0];
    const project = org?.projects.find((p) => p.projectName?.includes("默认项目")) ?? org?.projects[0];
    if (!org?.organizationId || !project?.projectId) throw new CodingPlanAuthError("project_unavailable");
    const list = await this.http(
      `${origin}/api/biz/v1/organization/${encodeURIComponent(org.organizationId)}/projects/${encodeURIComponent(project.projectId)}/api_keys`,
      {
        method: "GET",
        headers: { Authorization: family === "zai" ? `Bearer ${bizToken}` : bizToken, "Content-Type": "application/json" },
      },
    );
    if (list.status < 200 || list.status >= 300) throw new CodingPlanAuthError("discovery_failed", `api_keys HTTP ${list.status}`);
    const keys = (dataOf(list.json, "api_keys") ?? []) as { apiKey?: string; name?: string }[];
    const key = Array.isArray(keys) ? keys.find((k) => k?.name === "zcode-api-key" && k.apiKey) : undefined;
    if (!key?.apiKey) {
      throw new CodingPlanAuthError(
        "key_not_found",
        "no zcode-api-key in the account yet — send one prompt in the ZCode desktop app, then retry",
      );
    }
    return { organizationId: org.organizationId, projectId: project.projectId, apiKeyId: key.apiKey };
  }
}

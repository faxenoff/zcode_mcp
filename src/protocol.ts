/**
 * ZCode Protocol client — speaks the zcode app-server protocol over stdio.
 *
 * Wire format (reverse-engineered from ZCode 0.16.9):
 *   - line-delimited JSON, NOT JSON-RPC (a `jsonrpc` key is rejected by strict zod schemas)
 *   - client request:      {id: number, method: string, params: object}
 *   - server response:     {id: number, result?: object, error?: {code, message, data}}
 *   - server -> client:    {id: string, method, params} (request) or {method, params} (notification)
 *
 * The app-server has no account providers of its own: the hosting client (normally the
 * ZCode desktop app) pushes provider definitions via `provider/updateAccountConfig` and
 * answers `interaction/requestProviderRuntimeHeaders` with credentials. We replay that
 * role using the locally stored zcode credentials (~/.zcode/v2/credentials.json).
 */
import { fork, execFileSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  copyFileSync,
  rmSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { arch, homedir, platform, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, createDecipheriv } from "node:crypto";
import { EventEmitter } from "node:events";

export const DEFAULT_ZCODE_BIN =
  platform() === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "Programs/ZCode/resources/glm/zcode.cjs")
    : "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";

const ACCOUNT_PROVIDERS = [
  "account:zai-individual-coding-plan",
  "account:zai-team-coding-plan",
  "account:zai-start-plan",
  "account:bigmodel-individual-coding-plan",
  "account:bigmodel-team-coding-plan",
  "account:bigmodel-start-plan",
  "account:zai-offpeak-idle-plan",
  "account:bigmodel-offpeak-idle-plan",
] as const;

export type PermissionMode = "plan" | "build" | "edit" | "yolo" | "auto";

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface AvailableModel extends ModelRef {
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: { levels?: { value: string }[]; defaultLevel?: string };
}

export interface TurnResult {
  ok: boolean;
  error?: { code?: string; message?: string };
}

export interface MessagePart {
  type: string;
  text?: string;
  tool?: { name?: string; state?: { status?: string; output?: string } };
  cost?: { totalCostUsd?: number };
  tokens?: { input?: number; output?: number };
}

export interface SessionMessage {
  info: {
    role?: string;
    error?: { data?: { message?: string; code?: string } };
    modelId?: string;
    providerId?: string;
    time?: { created?: number; completed?: number };
  };
  parts?: MessagePart[];
}

export class ZcodeProtocolError extends Error {
  constructor(
    message: string,
    public readonly code?: number | string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "ZcodeProtocolError";
  }
}

/** Why the model list looks the way it does after boot — drives user-facing errors. */
export type ModelsReadiness =
  | { state: "ready" }
  | { state: "no-credentials"; preferred: string }
  | { state: "timeout"; waitedMs: number };

export class ZcodeProtocolClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private turnWaiters = new Map<string, (r: TurnResult) => void>();
  private booted = false;
  private buffer = "";
  private startWaiters: (() => void)[] = [];
  private activeBuiltinConfigPath: string | null = null;
  private pushedBuiltinRevision: string | null = null;
  private modelsReadiness: ModelsReadiness = { state: "timeout", waitedMs: 0 };

  constructor(
    private readonly binPath: string = process.env.ZCODE_BIN ?? DEFAULT_ZCODE_BIN,
    private readonly logger: (msg: string) => void = () => {},
  ) {
    super();
  }

  get binaryPath(): string {
    return this.binPath;
  }

  /** Outcome of the post-boot model-availability wait (set once by start()). */
  get readiness(): ModelsReadiness {
    return this.modelsReadiness;
  }

  /**
   * Validate the configured zcode entry script and expose it as a symlink at
   * <dir>/zcode-entry.cjs so the child is always forked from a fixed relative
   * filename (no dynamic command path anywhere). Returns the directory.
   */
  private prepareEntryLink(): string {
    const p = realpathSync(this.binPath);
    if (!isAbsolute(p) || !p.endsWith(".cjs")) {
      throw new ZcodeProtocolError(
        `invalid ZCODE_BIN (want an absolute path to the zcode .cjs entry script): ${this.binPath}`,
      );
    }
    if (!existsSync(p) || !statSync(p).isFile()) {
      throw new ZcodeProtocolError(`zcode CLI not found at ${this.binPath}. Set ZCODE_BIN to the zcode.cjs path.`);
    }
    if (platform() === "win32") return dirname(p);
    const dir = join(homedir(), ".zcode-mcp");
    mkdirSync(dir, { recursive: true });
    try {
      rmSync(join(dir, "zcode-entry.cjs"), { force: true });
      symlinkSync(p, join(dir, "zcode-entry.cjs"));

      // Newer app bundles locate their bundled provider config next to argv[1].
      // Mirror that layout beside the stable entrypoint symlink so zcode can
      // materialize and refresh its active provider config normally.
      const bundledProvider = [
        join(dirname(p), "provider/zcode-builtin.json"),
        join(dirname(dirname(p)), "config/provider/zcode-builtin.json"),
      ].find((candidate) => existsSync(candidate));
      if (bundledProvider) {
        const providerDir = join(dir, "provider");
        mkdirSync(providerDir, { recursive: true });
        rmSync(join(providerDir, "zcode-builtin.json"), { force: true });
        symlinkSync(bundledProvider, join(providerDir, "zcode-builtin.json"));
      }
    } catch {
      // A stale link will fail loudly at fork time.
    }
    return dir;
  }

  /** Start the app-server child and push the account provider config. */
  async start(): Promise<void> {
    if (this.booted) return;
    const entryDir = this.prepareEntryLink();
    const env = this.buildChildEnv();
    const entry = platform() === "win32" ? realpathSync(this.binPath) : "zcode-entry.cjs";
    this.child = fork(entry, ["app-server"], {
      cwd: entryDir,
      // "ipc" is required by fork(); the protocol itself runs over the stdin/stdout pipes.
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env,
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    // When forked with an IPC channel, the app-server delivers notifications via
    // process.send() instead of stdout — accept both.
    this.child.on("message", (m: unknown) => {
      if (m && typeof m === "object") this.handleMessage(m);
    });
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (c: string) => this.logger(`[app-server stderr] ${c.trim().slice(0, 400)}`));
    this.child.on("exit", (code, signal) => {
      this.booted = false;
      this.child = null;
      for (const [, p] of this.pending) p.reject(new ZcodeProtocolError(`app-server exited (${signal ?? code})`));
      this.pending.clear();
      // A child that dies before signaling startup must not stall start() for 30s;
      // resolving lets the follow-up request fail fast with "app-server exited".
      const waiters = this.startWaiters;
      this.startWaiters = [];
      for (const fn of waiters) fn();
      this.emit("exit");
    });

    await this.waitForStartup();
    await this.pushAccountProviders();
    // The account-config push is acknowledged before the app-server necessarily
    // applied it, and a snapshot raced ahead of the provider registry shows an
    // empty model list. Wait until models are actually exposed (or it is clear
    // none can be) before declaring the client usable.
    await this.waitForModels();
    this.booted = true;
  }

  async stop(): Promise<void> {
    this.child?.kill("SIGKILL");
    this.child = null;
    this.booted = false;
  }

  /** Create a session; returns {sessionId, models}. */
  async createSession(
    workspacePath: string,
    mode: PermissionMode = "yolo",
  ): Promise<{ sessionId: string; models: AvailableModel[] }> {
    const res = await this.request("session/create", {
      workspace: { workspacePath, workspaceKey: workspacePath },
      mode,
      titleGenerationEnabled: false,
    });
    const snap = res?.value ?? res;
    const sessionId = snap?.session?.sessionId;
    if (!sessionId) throw new ZcodeProtocolError("session/create returned no sessionId");
    await this.request("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" }).catch(() => {});
    return { sessionId, models: extractModels(snap) };
  }

  /**
   * Current model availability for a session. `session/read` recomputes the
   * availability per call (modelAvailability: "current" in the bundle), so this
   * reflects provider-registry changes that happened after the session was made.
   */
  async readCurrentModels(sessionId: string): Promise<AvailableModel[]> {
    const res = await this.request("session/read", { sessionId });
    return extractModels(res?.value ?? res);
  }

  /** Re-attach to an existing session from a previous server run. */
  async resumeSession(sessionId: string, workspacePath?: string): Promise<{ sessionId: string }> {
    await this.request("session/resume", {
      sessionId,
      ...(workspacePath ? { workspace: { workspacePath, workspaceKey: workspacePath } } : {}),
    });
    await this.request("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" }).catch(() => {});
    return { sessionId };
  }

  /** Run one turn: send a prompt and resolve when the turn completes or fails. */
  async runTurn(
    sessionId: string,
    content: string,
    model: ModelRef,
    reasoningLevel?: string,
    timeoutMs?: number,
  ): Promise<TurnResult> {
    const waiter = new Promise<TurnResult>((resolve, reject) => {
      const t = setTimeout(() => {
        this.turnWaiters.delete(sessionId);
        this.request("session/stop", { sessionId }).catch(() => {});
        reject(new ZcodeProtocolError(`turn timed out after ${timeoutMs}ms`, "turn_timeout"));
      }, timeoutMs ?? 600_000);
      this.turnWaiters.set(sessionId, (r) => {
        clearTimeout(t);
        this.turnWaiters.delete(sessionId);
        resolve(r);
      });
    });
    await this.request("session/send", {
      sessionId,
      content,
      modelSelection: {
        providerId: model.providerId,
        modelId: model.modelId,
        ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
      },
    });
    return waiter;
  }

  async readMessages(sessionId: string): Promise<SessionMessage[]> {
    const res = await this.request("session/messages", { sessionId });
    return (res?.messages ?? []) as SessionMessage[];
  }

  async listSessions(workspacePath?: string): Promise<any[]> {
    const res = await this.request("session/list", {
      ...(workspacePath ? { workspace: { workspacePath, workspaceKey: workspacePath } } : {}),
      limit: 20,
    });
    return (res?.sessions ?? res?.value ?? []) as any[];
  }

  async disposeSession(sessionId: string): Promise<void> {
    await this.request("session/close", { sessionId }).catch(() => {});
  }

  // ---- internals -------------------------------------------------------------

  private request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin) {
        reject(new ZcodeProtocolError(`app-server not running (${method})`, "no_child"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ZcodeProtocolError(`timeout waiting for ${method}`, "request_timeout"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        method,
      });
      this.child?.stdin?.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  private respond(id: unknown, result: unknown): void {
    this.child?.stdin?.write(JSON.stringify({ id, result }) + "\n");
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      this.handleMessage(msg);
    }
  }

  private waitForStartup(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      // The first notification (startup/storageState) means the process is alive.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new ZcodeProtocolError(
            "app-server sent no startup signal within 30s — check that node \"" +
              this.binPath +
              "\" app-server starts (ZCODE_BIN may point to a broken or mismatched install)",
            "startup_timeout",
          ),
        );
      }, 30_000);
      this.startWaiters.push(done);
    });
  }

  /**
   * Block until the app-server exposes at least one model, or until it is clear
   * none can appear. Runs after the provider push, which the app-server
   * acknowledges before its provider registry has necessarily applied it.
   */
  private async waitForModels(): Promise<void> {
    const preferred = process.env.ZCODE_PROVIDER ?? "account:bigmodel-individual-coding-plan";
    if (!this.hasAnyAccountCredential()) {
      this.modelsReadiness = { state: "no-credentials", preferred };
      return;
    }
    const first = await this.pollModels(10_000);
    if (first.state === "ready") {
      this.modelsReadiness = first;
      return;
    }
    // Self-heal one wrong-revision push: if the pushed basedOnZCodeBuiltinRevision
    // disagreed with the child's builtin config, the push was silently dropped.
    // The child has certainly flushed its own revision to the CLI log by now.
    const logged = this.revisionFromLogs();
    if (logged && logged !== this.pushedBuiltinRevision) {
      this.logger(`models empty after boot; re-pushing providers with the child's logged revision ${logged}`);
      await this.pushAccountProviders(logged);
      this.modelsReadiness = await this.pollModels(5_000);
      return;
    }
    this.modelsReadiness = first;
  }

  /** Poll session/read on one throwaway session until models appear. */
  private async pollModels(timeoutMs: number): Promise<ModelsReadiness> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    let delay = 100;
    let sessionId: string | null = null;
    let ws: string | null = null;
    try {
      while (Date.now() < deadline) {
        try {
          if (!sessionId) {
            ws ??= mkdtempSync(join(tmpdir(), "zcode-mcp-boot-"));
            sessionId = (await this.createSession(ws, "plan")).sessionId;
          }
          if ((await this.readCurrentModels(sessionId)).length > 0) return { state: "ready" };
        } catch {
          sessionId = null; // registry still settling; retry with a fresh session
        }
        await this.sleep(delay);
        delay = Math.min(delay * 2, 500);
      }
      return { state: "timeout", waitedMs: Date.now() - started };
    } finally {
      if (sessionId) await this.disposeSession(sessionId).catch(() => {});
      if (ws) {
        try { rmSync(ws, { recursive: true, force: true }); } catch { /* Windows handle lag */ }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Any coding-plan api key in the zcode credential store (any provider id)? */
  private hasAnyAccountCredential(): boolean {
    try {
      const path = join(homedir(), ".zcode/v2/credentials.json");
      if (!existsSync(path)) return false;
      const cred = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
      return Object.entries(cred).some(
        ([k, v]) =>
          k.startsWith("account-provider:coding-plan:") &&
          k.endsWith(":api-key") &&
          typeof v === "string" &&
          v.trim().length > 0,
      );
    } catch {
      return false;
    }
  }

  private handleMessage(msg: any): void {
    if (this.startWaiters.length && (msg.method || msg.result !== undefined)) {
      const w = this.startWaiters;
      this.startWaiters = [];
      for (const fn of w) fn();
    }
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new ZcodeProtocolError(msg.error.message ?? "protocol error", msg.error.code, msg.error.data));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }
    if (!msg.method) return;
    if (msg.method === "session/event") {
      const payload = msg.params?.payload ?? {};
      const sid = msg.params?.sessionId ?? payload.sessionId;
      // Event type lives at params.type (top level); payload.type appears on some variants.
      const type = (msg.params?.type ?? payload.type) as string | undefined;
      if (type === "turn.completed" || type === "turn.failed" || type === "turn.ended") {
        this.logger(`turn event ${type} (sessionId=${sid ?? "?"}, waiters=${this.turnWaiters.size})`);
        const waiter =
          (sid ? this.turnWaiters.get(sid) : undefined) ??
          (this.turnWaiters.size === 1 ? [...this.turnWaiters.values()][0] : undefined);
        if (waiter) {
          waiter({
            ok: type !== "turn.failed",
            error: payload.error ? { code: payload.error.code, message: payload.error.message } : undefined,
          });
        }
      }
      return;
    }
    // server -> client requests: we must answer or turns hang.
    if (msg.method === "session/requestRuntimePreferences") {
      this.respond(msg.id, {
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: true,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: "preflight-v1",
      });
      return;
    }
    if (msg.method === "interaction/requestProviderRuntimeHeaders") {
      const providerId = msg.params?.providerId as string | undefined;
      const apiKey = providerId ? this.readProviderApiKey(providerId) : null;
      this.respond(
        msg.id,
        apiKey
          ? { headersApplied: true, requestAuth: { apiKey } }
          : { headersApplied: false, errorMessage: `no credential found for ${providerId}` },
      );
      return;
    }
    // Permission / user-input / official-mcp-auth interactions: deny (headless callers cannot answer).
    if (msg.method.startsWith("interaction/")) {
      this.respond(msg.id, { decision: "deny" });
      return;
    }
    // Other notifications (startup/storageState, state.updated, telemetry...) are ignored.
  }

  private buildChildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // The CLI bundle identifies itself as 0.0.0-dev, while the desktop host
    // materializes provider config under its real app version. Reuse that
    // active config so account revisions match the desktop account payload.
    if (!env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && platform() === "darwin") {
      try {
        const resourcesDir = dirname(dirname(realpathSync(this.binPath)));
        const infoPlist = join(dirname(resourcesDir), "Info.plist");
        const appVersion = execFileSync(
          "plutil",
          ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPlist],
          { encoding: "utf8" },
        ).trim();
        const cpu = arch() === "arm64" ? "aarch64" : arch() === "x64" ? "x86_64" : arch();
        const versionDir = join(homedir(), ".zcode/v2/runtime/provider", `darwin-${cpu}`, appVersion);
        const activeConfigs = readdirSync(versionDir)
          .map((entry) => join(versionDir, entry, "zcode-builtin.json"))
          .filter((candidate) => existsSync(candidate))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        if (activeConfigs[0]) {
          env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = activeConfigs[0];
          env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = join(homedir(), ".zcode/v2/provider_config.json");
        }
      } catch { /* fall back to zcode's bundled provider discovery */ }
    }
    if (!env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && platform() === "win32") {
      try {
        const cpu = arch() === "arm64" ? "aarch64" : "x86_64";
        const archDir = join(homedir(), ".zcode/v2/runtime/provider", `windows-${cpu}`);
        const candidates: string[] = [];
        for (const ver of readdirSync(archDir)) {
          const verDir = join(archDir, ver);
          if (!statSync(verDir).isDirectory()) continue;
          for (const ep of readdirSync(verDir)) {
            const f = join(verDir, ep, "zcode-builtin.json");
            if (existsSync(f)) candidates.push(f);
          }
        }
        candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        if (candidates[0]) {
          env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = candidates[0];
          env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = join(homedir(), ".zcode/v2/provider_config.json");
        }
      } catch { /* fall back to zcode's bundled provider discovery */ }
    }
    if (!env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
      // No desktop-materialized runtime config (the desktop app never ran).
      // The installer ships the bundle's builtin config at
      // <installRoot>/config/provider/zcode-builtin.json; the CLI itself never
      // looks there, so hand it over via the env pair it requires. Copy it to
      // ~/.zcode-mcp so the CLI's refresh sidecar files never land in the
      // install directory.
      try {
        const shipped = join(dirname(dirname(realpathSync(this.binPath))), "config", "provider", "zcode-builtin.json");
        if (existsSync(shipped)) {
          const dir = join(homedir(), ".zcode-mcp");
          mkdirSync(dir, { recursive: true });
          const copy = join(dir, "zcode-builtin.json");
          if (!existsSync(copy)) copyFileSync(shipped, copy);
          env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = copy;
          env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = join(homedir(), ".zcode/v2/provider_config.json");
        }
      } catch { /* fall back to zcode's bundled provider discovery */ }
    }
    this.activeBuiltinConfigPath = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? null;
    // Node's bundled CA store misses the chain api.z.ai serves (Sectigo R46/USERTrust cross-sign);
    // export macOS system roots once and hand them to the child. Skip if user already set a bundle.
    if (!env.NODE_EXTRA_CA_CERTS && platform() === "darwin") {
      const pemPath = join(homedir(), ".zcode-mcp-system-roots.pem");
      try {
        if (!existsSync(pemPath)) {
          const pem = execFileSync(
            "security",
            ["find-certificate", "-a", "-p", "/System/Library/Keychains/SystemRootCertificates.keychain"],
            { maxBuffer: 20 * 1024 * 1024 },
          );
          if (pem.length > 1000) writeFileSync(pemPath, pem);
        }
        if (existsSync(pemPath)) env.NODE_EXTRA_CA_CERTS = pemPath;
      } catch { /* best effort */ }
    }
    // zcode honors HTTPS_PROXY; node ignores the macOS system proxy, so forward it when set.
    if (!env.HTTPS_PROXY && env.ZCODE_MCP_AUTO_PROXY !== "0" && platform() === "darwin") {
      try {
        const out = execFileSync("scutil", ["--proxy"], { encoding: "utf8" });
        const host = out.match(/HTTPSProxy : (\S+)/)?.[1];
        const port = out.match(/HTTPSPort : (\d+)/)?.[1];
        if (/HTTPSEnable : 1/.test(out) && host && port) {
          env.HTTPS_PROXY = `http://${host}:${port}`;
          env.HTTP_PROXY = `http://${host}:${port}`;
        }
      } catch { /* best effort */ }
    }
    return env;
  }

  /** Push account provider definitions, mirroring the ZCode desktop app. */
  private async pushAccountProviders(basedOnRevision?: string): Promise<void> {
    const providers: Record<string, { access: { type: string; entitled: boolean } }> = {};
    const states: Record<string, Record<string, unknown>> = {};
    const preferred = process.env.ZCODE_PROVIDER ?? "account:bigmodel-individual-coding-plan";
    let currentSet = false;
    for (const p of ACCOUNT_PROVIDERS) {
      const hasCred = this.readProviderApiKey(p) !== null;
      const isPreferred = p === preferred;
      const entitled = hasCred && (!this.readProviderApiKey(preferred) || isPreferred);
      const current = entitled && !currentSet;
      providers[p] = { access: { type: "zhipu-account", entitled } };
      states[p] = { availability: entitled ? "available" : "unavailable", entitled, current };
      if (current) currentSet = true;
    }
    const basedOn = basedOnRevision ?? this.readBuiltinRevision();
    this.pushedBuiltinRevision = basedOn;
    await this.request("provider/updateAccountConfig", {
      revision: `account:zcode-mcp:${Date.now()}`,
      basedOnZCodeBuiltinRevision: basedOn,
      providers,
      states,
    });
  }

  /**
   * The builtin provider revision the app-server we spawned will accept in
   * `provider/updateAccountConfig.basedOnZCodeBuiltinRevision`.
   *
   * It must match the BUILTIN CONFIG FILE the child resolves as active. The
   * app-server derives it as `zcode-builtin:<release.revision>:<sha256(resolve(
   * activeFilePath))>` (zcode.cjs, builtin config source constructor), and we
   * control activeFilePath through ZCODE_BUILTIN_PROVIDER_CONFIG_FILE — so the
   * same arithmetic on our chosen file is exact, with no race against the
   * child's first log flush. Log tailing and a static value only back this up.
   */
  private readBuiltinRevision(): string {
    return (
      this.deterministicBuiltinRevision() ??
      this.revisionFromLogs() ??
      "zcode-builtin:30:eb9fc603af991c9a3a620b47edb16dcf6748ce6c850bcd71441c4a84cc0532cd"
    );
  }

  private deterministicBuiltinRevision(): string | null {
    const p = this.activeBuiltinConfigPath;
    if (!p) return null;
    try {
      const cfg = JSON.parse(readFileSync(p, "utf8")) as { revision?: unknown };
      if (typeof cfg.revision === "number" && Number.isFinite(cfg.revision)) {
        return `zcode-builtin:${cfg.revision}:${createHash("sha256").update(resolve(p)).digest("hex")}`;
      }
    } catch { /* fall through */ }
    return null;
  }

  /**
   * The newest `zcode-builtin:<rev>:<hash>` line from the CLI's own logs
   * (`zcode_protocol.provider_registry.ready`, context.accountRevision). The
   * child writes it ~70 ms after start, so by the time a models wait has timed
   * out it is certainly flushed — but at push time it can race the flush and
   * hand back another process's revision (e.g. the desktop's), which the child
   * then silently drops.
   */
  private revisionFromLogs(): string | null {
    const re = /zcode-builtin:\d+:[a-f0-9]{64}/g;
    const lastIn = (dir: string, pick: (name: string) => boolean): string | null => {
      try {
        const files = readdirSync(dir).filter(pick).sort();
        for (let i = files.length - 1; i >= 0; i--) {
          const path = join(dir, files[i]);
          // the newest line is at the end; a day of logs can be large — read the tail only
          const size = statSync(path).size;
          const from = Math.max(0, size - 512 * 1024);
          const buf = Buffer.alloc(size - from);
          const fd = openSync(path, "r");
          try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
          const all = buf.toString("utf8").match(re);
          if (all && all.length) return all[all.length - 1];
        }
      } catch { /* best effort */ }
      return null;
    };
    return (
      lastIn(join(homedir(), ".zcode/cli/log"), (f) => f.startsWith("zcode-") && f.endsWith(".jsonl")) ??
      lastIn(join(homedir(), ".zcode/v2/logs"), (f) => f.endsWith(".log"))
    );
  }

  /** Find + decrypt the coding-plan api key for a provider from the zcode credential store. */
  readProviderApiKey(providerId: string): string | null {
    try {
      const path = join(homedir(), ".zcode/v2/credentials.json");
      if (!existsSync(path)) return null;
      const cred = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
      const prefix = `account-provider:coding-plan:${providerId}:account:`;
      for (const [k, v] of Object.entries(cred)) {
        if (k.startsWith(prefix) && k.endsWith(":api-key") && typeof v === "string" && v.trim()) {
          return this.decryptCredential(v.trim());
        }
      }
    } catch { /* best effort */ }
    return null;
  }

  /** zcode credential store values: "enc:v1:<iv>.<tag>.<ciphertext>", aes-256-gcm, base64url parts. */
  private decryptCredential(v: string): string {
    if (!v.startsWith("enc:v1:")) return v;
    const secret =
      (process.env.ZCODE_CREDENTIAL_SECRET ?? "").trim() ||
      `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
    const key = createHash("sha256").update(secret).digest();
    const parts = v.slice("enc:v1:".length).split(".");
    if (parts.length !== 3) throw new ZcodeProtocolError("credential: invalid ciphertext format");
    const iv = Buffer.from(parts[0], "base64url");
    const tag = Buffer.from(parts[1], "base64url");
    const ct = Buffer.from(parts[2], "base64url");
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  }
}

/** Snapshot settings.model.available entries are {ref: {providerId, modelId}, label, ...}. */
function extractModels(snap: any): AvailableModel[] {
  return (((snap?.settings?.model?.available ?? []) as any[])
    .map((m) => ({
      providerId: m.ref?.providerId ?? m.providerId,
      modelId: m.ref?.modelId ?? m.modelId,
      label: m.label,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      reasoning: m.reasoning,
    }))
    .filter((m) => typeof m.providerId === "string" && typeof m.modelId === "string")) as AvailableModel[];
}

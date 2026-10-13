/**
 * Process bookkeeping for the zcode app-server tree.
 *
 * The app-server hosts every session in its own process; what it spawns per
 * session are direct children: bash shells (their command line carries
 * `.../bash-startup/sess_<id>/...`), `__zcode-plugin-host` node processes and
 * the stdio MCP servers from ~/.zcode/cli/config.json (e.g. code-daemon-mcp).
 * Only the shells name their session. Neither `session/close` nor the
 * app-server's own residency deactivation stops the plugin hosts / MCP servers
 * (verified on ZCode 3.14.5), so they pile up — one set per opened session.
 *
 * Attribution: a child of the app-server belongs to the session named in its
 * command line; otherwise to every session that was open (resident) at the
 * moment the child was created. A child is reaped only when ALL its candidate
 * owners are closed. Children no open window explains are reaped only when no
 * session is resident at all.
 */
import { execFile, execFileSync } from "node:child_process";
import { platform } from "node:os";

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
  /** Creation time, epoch ms (null when the OS did not report it). */
  createdMs: number | null;
  /** Resident memory in bytes. */
  memBytes: number;
}

// ---- listing ------------------------------------------------------------------

const PS_WINDOWS =
  "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{" +
  "p=$_.ProcessId; pp=$_.ParentProcessId; n=$_.Name; c=$_.CommandLine; m=$_.WorkingSetSize; " +
  "t=$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }) } } " +
  "| ConvertTo-Json -Compress";

/** Parse the JSON emitted by PS_WINDOWS (an array, or a bare object for one process). */
export function parseWindowsProcessJson(text: string): ProcInfo[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const raw = JSON.parse(trimmed) as unknown;
  const rows = (Array.isArray(raw) ? raw : [raw]) as Record<string, unknown>[];
  const out: ProcInfo[] = [];
  for (const r of rows) {
    const pid = Number(r.p);
    const ppid = Number(r.pp);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const t = r.t === null || r.t === undefined ? null : Number(r.t);
    out.push({
      pid,
      ppid,
      name: typeof r.n === "string" ? r.n : "",
      cmd: typeof r.c === "string" ? r.c : "",
      createdMs: t !== null && Number.isFinite(t) ? t : null,
      memBytes: Number(r.m) || 0,
    });
  }
  return out;
}

/** `ps` etime: [[dd-]hh:]mm:ss → seconds (NaN when malformed). */
export function parseEtime(s: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return NaN;
  const [, d, h, mi, se] = m;
  return (Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 + Number(mi) * 60 + Number(se);
}

/** Parse `ps -A -o pid=,ppid=,rss=,etime=,command=` (Linux procps and macOS). */
export function parsePsOutput(text: string, nowMs: number): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line);
    if (!m) continue;
    const age = parseEtime(m[4]);
    const cmd = m[5].trim();
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: cmd.split(/\s+/)[0]?.split("/").pop() ?? "",
      cmd,
      createdMs: Number.isFinite(age) ? nowMs - age * 1000 : null,
      memBytes: Number(m[3]) * 1024,
    });
  }
  return out;
}

const PS_ARGS = ["-A", "-o", "pid=,ppid=,rss=,etime=,command="];

/** Snapshot of all processes on the machine. */
export function listProcesses(): Promise<ProcInfo[]> {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const cb = (err: Error | null, stdout: string) => {
      if (err) return reject(err);
      try {
        resolve(platform() === "win32" ? parseWindowsProcessJson(stdout) : parsePsOutput(stdout, now));
      } catch (e) {
        reject(e as Error);
      }
    };
    if (platform() === "win32") {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", PS_WINDOWS],
        { encoding: "utf8", maxBuffer: 64 << 20, windowsHide: true, timeout: 60_000 },
        cb,
      );
    } else {
      execFile("ps", PS_ARGS, { encoding: "utf8", maxBuffer: 64 << 20, timeout: 30_000 }, cb);
    }
  });
}

/** Synchronous variant for exit paths (Unix only — Windows uses taskkill /T instead). */
function listProcessesSync(): ProcInfo[] {
  if (platform() === "win32") return [];
  try {
    return parsePsOutput(execFileSync("ps", PS_ARGS, { encoding: "utf8", maxBuffer: 64 << 20, timeout: 10_000 }), Date.now());
  } catch {
    return [];
  }
}

// ---- tree helpers -------------------------------------------------------------

/** All descendants of rootPid (not including it), breadth-first. Guards against pid cycles. */
export function descendants(all: ProcInfo[], rootPid: number): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of all) {
    if (p.pid === p.ppid) continue;
    const list = byParent.get(p.ppid);
    if (list) list.push(p);
    else byParent.set(p.ppid, [p]);
  }
  const out: ProcInfo[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const id = queue.shift()!;
    for (const c of byParent.get(id) ?? []) {
      if (seen.has(c.pid)) continue;
      // A child cannot predate its parent; a "child" that does is a reused ppid.
      const parent = all.find((p) => p.pid === id);
      if (parent?.createdMs && c.createdMs && c.createdMs + 1000 < parent.createdMs) continue;
      seen.add(c.pid);
      out.push(c);
      queue.push(c.pid);
    }
  }
  return out;
}

const SESSION_MARKER_RE = /[\\/]bash-startup[\\/](sess_[A-Za-z0-9-]{1,128})[\\/]/;

/** Session id a zcode shell was started for (its bash-startup script path), or null. */
export function sessionMarker(cmd: string): string | null {
  return SESSION_MARKER_RE.exec(cmd)?.[1] ?? null;
}

// ---- session ledger -----------------------------------------------------------

interface Window {
  start: number;
  end: number | null;
}

/** Which sessions were open on the app-server, and when. */
export class SessionLedger {
  private windows = new Map<string, Window[]>();
  private activity = new Map<string, number>();

  constructor(private readonly retainMs = 6 * 3600_000) {}

  open(sessionId: string, at = Date.now()): void {
    const list = this.windows.get(sessionId) ?? [];
    const last = list[list.length - 1];
    if (!last || last.end !== null) list.push({ start: at, end: null });
    this.windows.set(sessionId, list);
    this.touch(sessionId, at);
  }

  close(sessionId: string, at = Date.now()): void {
    const last = this.windows.get(sessionId)?.at(-1);
    if (last && last.end === null) last.end = at;
    this.activity.delete(sessionId);
  }

  touch(sessionId: string, at = Date.now()): void {
    if (this.isResident(sessionId)) this.activity.set(sessionId, at);
  }

  lastActivity(sessionId: string): number | undefined {
    return this.activity.get(sessionId);
  }

  knows(sessionId: string): boolean {
    return this.windows.has(sessionId);
  }

  isResident(sessionId: string): boolean {
    const last = this.windows.get(sessionId)?.at(-1);
    return !!last && last.end === null;
  }

  residentIds(): string[] {
    return [...this.windows.keys()].filter((id) => this.isResident(id));
  }

  /** Sessions whose open window (widened by slackMs on both ends) contains t. */
  ownersAt(t: number, slackMs: number): string[] {
    const out: string[] = [];
    for (const [id, list] of this.windows) {
      if (list.some((w) => t >= w.start - slackMs && (w.end === null || t <= w.end + slackMs))) out.push(id);
    }
    return out;
  }

  /** Forget windows that closed long ago (bounded memory for a long-lived server). */
  prune(now = Date.now()): void {
    for (const [id, list] of this.windows) {
      const kept = list.filter((w) => w.end === null || now - w.end < this.retainMs);
      if (kept.length) this.windows.set(id, kept);
      else this.windows.delete(id);
    }
  }
}

// ---- reap planning ------------------------------------------------------------

/** Never reap these direct children (console host of the app-server itself, transient helpers). */
const UNTOUCHABLE = new Set(["conhost.exe", "taskkill.exe"]);

export interface ReapDecision {
  proc: ProcInfo;
  owners: string[];
  kill: boolean;
  reason: string;
}

export interface ReapOptions {
  /** Window widening when matching creation times to sessions. */
  slackMs?: number;
  /** Unattributed children younger than this are left alone. */
  minAgeMs?: number;
  now?: number;
}

/**
 * Decide, for every direct child of the app-server, whether its subtree is
 * garbage. Pure: takes a process snapshot and the ledger.
 */
export function planReap(all: ProcInfo[], rootPid: number, ledger: SessionLedger, opts: ReapOptions = {}): ReapDecision[] {
  const slack = opts.slackMs ?? 3_000;
  const minAge = opts.minAgeMs ?? 10_000;
  const now = opts.now ?? Date.now();
  const resident = ledger.residentIds();
  const decisions: ReapDecision[] = [];
  for (const p of all) {
    if (p.ppid !== rootPid || p.pid === rootPid) continue;
    if (UNTOUCHABLE.has(p.name.toLowerCase())) continue;
    const marker = sessionMarker(p.cmd);
    let owners: string[];
    if (marker && ledger.knows(marker)) owners = [marker];
    else owners = p.createdMs !== null ? ledger.ownersAt(p.createdMs, slack) : [];
    if (owners.length) {
      const live = owners.filter((o) => ledger.isResident(o));
      decisions.push({
        proc: p,
        owners,
        kill: live.length === 0,
        reason: live.length ? `owner still open: ${live.join(",")}` : `owners closed: ${owners.join(",")}`,
      });
    } else {
      const old = p.createdMs === null || now - p.createdMs >= minAge;
      const kill = resident.length === 0 && old;
      decisions.push({
        proc: p,
        owners,
        kill,
        reason: kill ? "unattributed, no session open" : "unattributed, sessions open or too young",
      });
    }
  }
  return decisions;
}

// ---- killing ------------------------------------------------------------------

/** Kill a process and everything below it. Best effort, never throws. */
export async function killTree(pid: number, snapshot?: ProcInfo[]): Promise<void> {
  if (platform() === "win32") {
    await new Promise<void>((resolve) =>
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 30_000 }, () => resolve()),
    );
    return;
  }
  const all = snapshot ?? (await listProcesses().catch(() => [] as ProcInfo[]));
  for (const p of [{ pid } as ProcInfo, ...descendants(all, pid)]) {
    try { process.kill(p.pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

/**
 * Synchronous kill of the whole app-server tree for exit handlers.
 * Windows: taskkill /T. Unix: the process group (the app-server is forked
 * detached, i.e. as a group leader) plus any descendant that left the group.
 */
export function killTreeSync(pid: number): void {
  if (platform() === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15_000 });
    } catch { /* already gone */ }
    return;
  }
  const desc = descendants(listProcessesSync(), pid);
  try { process.kill(-pid, "SIGKILL"); } catch { /* not a group leader / gone */ }
  for (const p of [{ pid } as ProcInfo, ...desc]) {
    try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ }
  }
}

/**
 * zcode app-servers whose parent is gone (a crashed / SIGKILLed zcode-mcp
 * leaves them behind with all their children). The desktop app's own
 * app-server has a live parent and is never matched.
 */
export function findOrphanAppServers(all: ProcInfo[], selfPid: number): ProcInfo[] {
  const byPid = new Map(all.map((p) => [p.pid, p] as const));
  return all.filter((p) => {
    if (p.pid === selfPid || !/zcode\.cjs"?\s+app-server\b|zcode-entry\.cjs"?\s+app-server\b/.test(p.cmd)) return false;
    const parent = byPid.get(p.ppid);
    // Unix re-parents orphans to init (or a subreaper with pid 1 in a container)
    if (!parent || p.ppid <= 1) return true;
    // a reused pid that started after the child cannot be its parent
    return !!(parent.createdMs && p.createdMs && parent.createdMs > p.createdMs + 1000);
  });
}

export function sumMemory(procs: ProcInfo[]): number {
  return procs.reduce((s, p) => s + p.memBytes, 0);
}

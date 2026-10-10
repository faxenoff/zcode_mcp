#!/usr/bin/env node
/**
 * zcode-mcp — expose the zcode coding agent as MCP tools.
 *
 * Lets external agents (Codex, Claude Code, ...) delegate development work to a
 * locally installed zcode: the calling agent plans and reviews, zcode executes.
 * Transport: stdio. One zcode app-server child hosts all sessions.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  ZcodeProtocolClient,
  ZcodeProtocolError,
  type AvailableModel,
  type PermissionMode,
  type SessionMessage,
} from "./protocol.js";
import { ModelCache, pickModel } from "./models.js";

const debug = process.env.ZCODE_MCP_DEBUG === "1";
const log = (msg: string) => {
  if (debug) process.stderr.write(`[zcode-mcp] ${msg}\n`);
};

let client: ZcodeProtocolClient | null = null;
let clientReady: Promise<ZcodeProtocolClient> | null = null;
const cachedModels = new ModelCache(); // cwd -> models (never stores an empty list)

async function getClient(): Promise<ZcodeProtocolClient> {
  if (clientReady) return clientReady;
  clientReady = (async () => {
    const c = new ZcodeProtocolClient(undefined, log);
    c.on("exit", () => {
      // Next call will boot a fresh app-server.
      client = null;
      clientReady = null;
    });
    await c.start();
    client = c;
    return c;
  })();
  try {
    return await clientReady;
  } catch (e) {
    clientReady = null;
    throw e;
  }
}

/** Validate a workspace directory (MCP params never reach the protocol layer unvalidated). */
function resolveCwd(input?: string): string {
  const raw = input?.trim() || process.env.ZCODE_DEFAULT_CWD || process.cwd();
  const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  const real = realpathSync(abs);
  if (!existsSync(real) || !statSync(real).isDirectory()) {
    throw new ZcodeProtocolError(`cwd is not an existing directory: ${raw}`);
  }
  return real;
}

const SESSION_ID_RE = /^sess_[A-Za-z0-9-]{1,128}$/;
const REASONING_RE = /^[a-z]{1,16}$/;

/** Session ids must match the zcode format before entering the protocol layer. */
function assertSessionId(id: string): string {
  if (!SESSION_ID_RE.test(id)) {
    throw new ZcodeProtocolError(`invalid session_id (want sess_...): ${id.slice(0, 48)}`);
  }
  return id;
}

/**
 * Strip control characters (except tab/newline) and clamp length.
 * Prompts are free text by design; this keeps the protocol stream clean.
 */
function sanitizeText(input: string, maxLen = 1_000_000): string {
  let cleaned = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 32 && cp !== 9 && cp !== 10) continue;
    if (cp === 127) continue;
    cleaned += ch;
    if (cleaned.length >= maxLen) break;
  }
  return cleaned;
}

/** Reasoning levels are a fixed vocabulary (low/high/max/...). */
function assertReasoning(level: string): string {
  if (!REASONING_RE.test(level)) {
    throw new ZcodeProtocolError(`invalid reasoning_level: ${level.slice(0, 24)}`);
  }
  return level;
}

interface RunSummary {
  text: string;
  tools: string[];
  tokens?: { input?: number; output?: number };
  modelId?: string;
  providerId?: string;
}

function summarizeMessages(messages: SessionMessage[]): RunSummary {
  const tools: string[] = [];
  let tokens: { input?: number; output?: number } | undefined;
  let modelId: string | undefined;
  let providerId: string | undefined;
  const assistantText: string[] = [];
  for (const m of messages) {
    if (m.info.role !== "assistant") continue;
    modelId = m.info.modelId ?? modelId;
    providerId = m.info.providerId ?? providerId;
    for (const part of m.parts ?? []) {
      if (part.type === "text" && part.text?.trim()) assistantText.push(part.text.trim());
      if (part.type === "tool" && part.tool?.name) tools.push(part.tool.name);
      if (part.type === "step-finish" && part.tokens) {
        tokens = {
          input: (tokens?.input ?? 0) + (part.tokens.input ?? 0),
          output: (tokens?.output ?? 0) + (part.tokens.output ?? 0),
        };
      }
    }
  }
  const err = messages.find((m) => m.info.role === "assistant" && m.info.error)?.info.error;
  const text = assistantText.join("\n\n") || (err ? `assistant error: ${err.data?.message ?? err.data?.code}` : "");
  return { text, tools, tokens, modelId, providerId };
}

const MAX_OUTPUT_CHARS = 100_000;

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${s.length - MAX_OUTPUT_CHARS} chars]`;
}

const server = new McpServer(
  { name: "zcode-mcp", version: "0.1.0" },
  {
    instructions:
      "Delegate coding tasks to the zcode agent. The calling model should plan and break down work, then hand each concrete task to zcode_run with the project directory as cwd. Pass back the returned session_id to continue a conversation.",
  },
);

server.registerTool(
  "zcode_run",
  {
    title: "Run zcode agent",
    description:
      "Delegate a development task to the zcode coding agent. zcode works inside the given directory: it can read/edit files, run shell commands and git. Returns zcode's final answer plus a session_id that can be used to send follow-ups in the same conversation.",
    inputSchema: {
      prompt: z.string().min(1).describe("Task instruction for zcode. Be concrete: what to change, where, and how to verify."),
      cwd: z
        .string()
        .optional()
        .describe("Absolute path of the project directory zcode should work in (required for any file work)."),
      mode: z
        .enum(["plan", "build", "edit", "yolo", "auto"])
        .optional()
        .describe("Permission mode. yolo = no confirmations (default, suitable for headless delegation); plan = read-only analysis."),
      model: z.string().optional().describe("Model id, e.g. GLM-5.3 (default) or GLM-5.3-Flash."),
      reasoning_level: z.string().optional().describe("Reasoning effort: low | high | max (default max)."),
      session_id: z.string().optional().describe("Continue a previous zcode conversation (from an earlier zcode_run result)."),
      timeout_ms: z
        .number()
        .int()
        .min(10_000)
        .max(7_200_000)
        .optional()
        .describe("Turn timeout in ms (default 600000 = 10 min, max 7200000 = 2 h)."),
    },
  },
  async (args) => {
    try {
      const cwd = resolveCwd(args.cwd);
      const prompt = sanitizeText(args.prompt);
      const c = await getClient();

      let sessionId: string;
      let models: AvailableModel[];
      let createdHere = false;
      if (args.session_id) {
        const resumeId = assertSessionId(args.session_id);
        log(`resuming session ${resumeId} in ${cwd}`);
        ({ sessionId } = await c.resumeSession(resumeId, cwd));
        models = await c.readCurrentModels(sessionId).catch(() => cachedModels.get(cwd) ?? []);
      } else {
        log(`creating session in ${cwd}`);
        const created = await c.createSession(cwd, (args.mode as PermissionMode) ?? "yolo");
        sessionId = created.sessionId;
        models = created.models;
        createdHere = true;
        cachedModels.set(cwd, models);
      }

      let model: AvailableModel;
      let level: string;
      try {
        const picked = pickModel(models, args.model, c.readiness);
        model = picked.model;
        level = assertReasoning(args.reasoning_level?.trim() || picked.reasoning || "max");
      } catch (e) {
        // Nothing was sent to this session yet — don't leave an empty row behind.
        if (createdHere) await c.disposeSession(sessionId).catch(() => {});
        throw e;
      }

      const started = Date.now();
      const result = await c.runTurn(sessionId, prompt, model, level, args.timeout_ms ?? 600_000);
      const durationS = Math.round((Date.now() - started) / 1000);

      const messages = await c.readMessages(sessionId);
      // Only summarize messages produced by THIS turn (resumed sessions carry full history).
      const summary = summarizeMessages(
        messages.filter((m) => (m.info.time?.created ?? 0) >= started - 5_000),
      );

      const toolCounts = new Map<string, number>();
      for (const t of summary.tools) toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
      const toolLine = [...toolCounts.entries()].map(([n, k]) => `${n}(${k})`).join(", ");

      const meta = [
        `session_id: ${sessionId}`,
        summary.modelId ? `model: ${summary.modelId} (${summary.providerId})` : null,
        toolLine ? `tools_used: ${toolLine}` : null,
        summary.tokens ? `tokens: in=${summary.tokens.input ?? "?"} out=${summary.tokens.output ?? "?"}` : null,
        `duration: ${durationS}s`,
        `cwd: ${cwd}`,
      ]
        .filter(Boolean)
        .join("\n");

      if (!result.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: truncate(
                `zcode turn FAILED: ${result.error?.code ?? ""} ${result.error?.message ?? "unknown error"}\n\n${summary.text}\n\n---\n${meta}`,
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: truncate(`${summary.text || "(no textual reply)"}\n\n---\n${meta}`),
          },
        ],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text" as const, text: `zcode_run error: ${msg}` }] };
    }
  },
);

server.registerTool(
  "zcode_check",
  {
    title: "Check zcode availability",
    description:
      "Report whether the zcode agent backend is reachable: binary path, stored credentials, available models after booting the app-server. Run this first when zcode_run fails.",
    inputSchema: {},
  },
  async () => {
    try {
      const c = await getClient();
      const credDir = `${homedir()}/.zcode/v2/credentials.json`;
      const hasCred = existsSync(credDir);
      const preferred = process.env.ZCODE_PROVIDER ?? "account:bigmodel-individual-coding-plan";
      const ws = resolveCwd(undefined);
      const probe = await c.createSession(ws, "plan");
      const models = probe.models.map((m) => m.modelId);
      cachedModels.set(ws, probe.models);
      await c.disposeSession(probe.sessionId).catch(() => {});
      let status: string;
      if (models.length) {
        status = "ok";
      } else if (c.readiness.state === "no-credentials") {
        status =
          "no models available — no credentials: log in once via the ZCode desktop app " +
          "(they are stored in ~/.zcode/v2/credentials.json), then retry";
      } else if (c.readiness.state === "timeout") {
        status =
          `no models available — the app-server was still loading after ${c.readiness.waitedMs}ms ` +
          "(retry in a few seconds), or the provider refused the account — verify the login is entitled and, " +
          "if it was rejected, re-login in the ZCode desktop app and restart this MCP server";
      } else {
        status = "no models available — retry in a few seconds; if it persists the provider refused the account";
      }
      const lines = [
        `binary: ${c.binaryPath}`,
        `credentials: ${hasCred ? `found (${credDir})` : `MISSING — log in via the ZCode desktop app`}`,
        `preferred_provider: ${preferred}`,
        `models: ${models.join(", ") || "(none)"}`,
        `status: ${status}`,
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text" as const, text: `zcode_check error: ${msg}` }] };
    }
  },
);

server.registerTool(
  "zcode_sessions",
  {
    title: "List zcode sessions",
    description: "List recent zcode sessions (id, title, directory) for a workspace, usable as session_id in zcode_run.",
    inputSchema: {
      cwd: z.string().optional().describe("Workspace directory to list sessions for (default: server cwd)."),
    },
  },
  async (args) => {
    try {
      const c = await getClient();
      const cwd = resolveCwd(args.cwd);
      const sessions = await c.listSessions(cwd);
      const lines = sessions.map((s: any) => {
        const id = s.sessionId ?? s.id ?? "?";
        const title = (s.title ?? "").slice(0, 80);
        const dir = s.directory ?? s.workspace?.workspacePath ?? "";
        const updated = s.timeUpdated ?? s.updatedAt ?? s.time_updated ?? "";
        return `${id} | ${updated} | ${dir} | ${title}`;
      });
      return {
        content: [
          {
            type: "text" as const,
            text: lines.length ? lines.join("\n") : `(no sessions found for ${cwd})`,
          },
        ],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text" as const, text: `zcode_sessions error: ${msg}` }] };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("zcode-mcp ready (stdio)");
  process.on("SIGTERM", async () => {
    await client?.stop();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    await client?.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});

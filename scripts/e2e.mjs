#!/usr/bin/env node
// End-to-end test: drive zcode-mcp through a real MCP stdio client.
// Usage: node scripts/e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, rmSync, readFileSync } from "node:fs";

const WORK = "/tmp/zcode-mcp-e2e";
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env, ZCODE_MCP_DEBUG: "1" },
});
const client = new Client({ name: "zcode-mcp-e2e", version: "0.0.1" });
await client.connect(transport);

console.log("== tools/list ==");
const tools = await client.listTools();
console.log(tools.tools.map((t) => t.name).join(", "));

console.log("\n== zcode_check ==");
const check = await client.callTool({ name: "zcode_check", arguments: {} });
console.log(check.content?.[0]?.text?.slice(0, 500));

const call = (name, args, timeout = 300_000) =>
  client.callTool({ name, arguments: args }, undefined, { timeout }).catch((e) => ({
    isError: true,
    content: [{ type: "text", text: `client error: ${e.message}` }],
  }));

console.log("\n== zcode_run (real task) ==");
const run = await call("zcode_run", {
  prompt:
    "Create a file named greet.txt in the current directory containing exactly one line: mcp-bridge-works. Then read it back to verify and reply with the file content.",
  cwd: WORK,
  mode: "yolo",
});
const text = run.content?.[0]?.text ?? "";
console.log(text.slice(0, 900));
console.log("isError:", run.isError === true);

const sessionId = text.match(/session_id: (sess_\S+)/)?.[1];
console.log("\nfile check:", readFileSync(`${WORK}/greet.txt`, "utf8").trim());

if (sessionId && !run.isError) {
  console.log("\n== zcode_run (follow-up via session_id) ==");
  const run2 = await call("zcode_run", {
    prompt: "In one short sentence: what did you just do in this session?",
    session_id: sessionId,
    cwd: WORK,
  });
  console.log((run2.content?.[0]?.text ?? "").slice(0, 400));
  console.log("isError:", run2.isError === true);
}

console.log("\n== zcode_sessions ==");
const sess = await client.callTool({ name: "zcode_sessions", arguments: { cwd: WORK } });
console.log((sess.content?.[0]?.text ?? "").slice(0, 300));

await client.close();
console.log("\nE2E DONE");
process.exit(0);

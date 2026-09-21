import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("zcode_check boots the bundled app-server and exposes models", { timeout: 70_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, ZCODE_MCP_DEBUG: "1" },
  });
  const client = new Client({ name: "zcode-check-test", version: "0.0.1" });

  try {
    await client.connect(transport);
    const result = await client.callTool(
      { name: "zcode_check", arguments: {} },
      undefined,
      { timeout: 60_000 },
    );
    const output = result.content?.find((part) => part.type === "text")?.text ?? "";

    assert.equal(result.isError, undefined, output);
    assert.match(output, /^models: .+/m);
    assert.doesNotMatch(output, /^models: \(none\)$/m);
    assert.match(output, /^status: ok$/m);
  } finally {
    await client.close();
  }
});

// End-to-end smoke test against the BUILT server and a real Ollama, over stdio exactly
// as an MCP client (e.g. Claude Code) would run it. Not part of CI (needs a GPU + Ollama).
//   npm run build && node scripts/smoke.mjs <tool> '<json args>'
//   node scripts/smoke.mjs list
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool = "local_status", args = "{}"] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "..", "dist", "main.js")],
    env: { ...process.env },
  }),
);
if (tool === "list") {
  console.log((await client.listTools()).tools.map((t) => t.name).join(", "));
} else {
  const res = await client.callTool({ name: tool, arguments: JSON.parse(args) }, undefined, { timeout: 600_000 });
  console.log(res.isError ? "ERROR:" : "OK:", res.content.map((c) => c.text).join("\n"));
}
await client.close();

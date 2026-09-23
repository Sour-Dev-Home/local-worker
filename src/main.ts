#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { canonicalizeRoots } from "./paths.js";
import { createServer } from "./server.js";

const config = loadConfig();
// Realpath the roots once, so a root that is (or is under) a link matches realpath'd files.
config.roots = await canonicalizeRoots(config.roots);
const server = createServer(config);
await server.connect(new StdioServerTransport());

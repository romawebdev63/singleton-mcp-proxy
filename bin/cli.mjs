#!/usr/bin/env node
import { main } from '../src/runner.mjs';

main().catch((error) => {
  // stdout belongs exclusively to the MCP stdio protocol.
  console.error(`[singleton-mcp-proxy] ${error?.stack || error}`);
  process.exitCode = 1;
});

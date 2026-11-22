import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createCoreService } from '@phone-workbench/core';

import { createWorkbenchMcpServer } from './index.ts';

const core = createCoreService();
const server = createWorkbenchMcpServer(core);
let closing = false;

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await Promise.allSettled([server.close(), core.dispose()]);
}

process.once('SIGINT', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch(async () => {
  process.stderr.write('phone-workbench MCP server failed.\n');
  process.exitCode = 1;
  await close();
});

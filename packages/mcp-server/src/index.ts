import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { CoreService, WorkspaceSnapshot } from '@phone-workbench/contracts';

import { workspaceSnapshotSchema } from './snapshot-schema.ts';

const emptyInputSchema = z.object({}).strict();
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function snapshotText(action: 'status' | 'refresh', snapshot: WorkspaceSnapshot): string {
  const prefix = action === 'refresh' ? 'Device discovery refreshed.' : 'Workbench status.';
  return [
    prefix,
    'source=' + snapshot.sourceKind,
    'discovery=' + snapshot.discoveryStatus,
    'revision=' + String(snapshot.revision),
    'devices=' + String(snapshot.devices.length),
  ].join(' ');
}

function toolResult(action: 'status' | 'refresh', snapshot: WorkspaceSnapshot) {
  return {
    content: [
      {
        type: 'text' as const,
        text: snapshotText(action, snapshot),
      },
    ],
    structuredContent: snapshot as unknown as Record<string, unknown>,
  };
}

export function createWorkbenchMcpServer(core: CoreService): McpServer {
  const server = new McpServer(
    {
      name: 'phone-workbench',
      version: '0.0.0-r1a',
    },
    {
      maxToolInputElements: 1,
    },
  );

  server.registerTool(
    'workbench_get_status',
    {
      title: 'Get workbench status',
      description: 'Return the current read-only workspace snapshot without starting discovery.',
      inputSchema: emptyInputSchema,
      outputSchema: workspaceSnapshotSchema,
      annotations: readOnlyAnnotations,
    },
    async () => toolResult('status', await core.getSnapshot()),
  );

  server.registerTool(
    'workbench_refresh_devices',
    {
      title: 'Refresh device discovery',
      description: 'Run the configured read-only device discovery and return the shared core snapshot.',
      inputSchema: emptyInputSchema,
      outputSchema: workspaceSnapshotSchema,
      annotations: readOnlyAnnotations,
    },
    async () => toolResult('refresh', await core.refreshDevices()),
  );

  return server;
}

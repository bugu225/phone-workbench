import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  type DeviceAdapter,
  type DeviceDiscovery,
  type WorkspaceSnapshot,
} from '@phone-workbench/contracts';
import { createCoreService } from '@phone-workbench/core';

import { createWorkbenchMcpServer } from '../src/index.ts';

function createReadyDiscovery(): Extract<DeviceDiscovery, { status: 'ready' }> {
  return {
    status: 'ready',
    sourceKind: 'SIMULATED',
    observedAt: '2026-11-09T09:00:00.000Z',
    devices: [
      {
        adapterDeviceKey: 'opaque-simulated-key',
        label: 'Simulated Android',
        state: 'connected',
        capabilities: [
          {
            operation: 'screen.capture',
            state: 'unknown',
            reasonCode: 'not_tested',
            scope: 'device',
            evidence: 'NOT_RUN',
          },
        ],
      },
    ],
  };
}

function createAdapter(discovery: DeviceDiscovery): DeviceAdapter & { calls: number } {
  return {
    adapterId: 'mcp-test-adapter',
    calls: 0,
    async discover(): Promise<DeviceDiscovery> {
      this.calls += 1;
      return discovery;
    },
    async dispose(): Promise<void> {},
  };
}

function createIdFactory(): () => string {
  let value = 0;
  return () => String(++value);
}

async function createHarness(core: ReturnType<typeof createCoreService>) {
  const server = createWorkbenchMcpServer(core);
  const client = new Client(
    { name: 'phone-workbench-test', version: '0.0.0' },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    server,
    async close(): Promise<void> {
      await Promise.allSettled([client.close(), server.close(), core.dispose()]);
    },
  };
}

test('server exposes exactly two read-only tools and no write surface', async () => {
  const core = createCoreService({ idFactory: createIdFactory() });
  const harness = await createHarness(core);

  try {
    const listed = await harness.client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ['workbench_get_status', 'workbench_refresh_devices'],
    );
    for (const tool of listed.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.openWorldHint, false);
      assert.deepEqual(tool.inputSchema.required ?? [], []);
    }
    assert.equal(listed.tools.some((tool) => /input|tap|file|shell|session/i.test(tool.name)), false);
  } finally {
    await harness.close();
  }
});

test('get status returns the unconfigured snapshot without running discovery', async () => {
  const adapter = createAdapter(createReadyDiscovery());
  const core = createCoreService({ adapter, idFactory: createIdFactory() });
  const harness = await createHarness(core);

  try {
    const result = await harness.client.callTool({
      name: 'workbench_get_status',
      arguments: {},
    });
    const snapshot = result.structuredContent as unknown as WorkspaceSnapshot;
    assert.equal(result.isError, undefined);
    assert.equal(adapter.calls, 0);
    assert.equal(snapshot.revision, 0);
    assert.equal(snapshot.sourceKind, 'NONE');
    assert.equal(snapshot.discoveryStatus, 'not_configured');
    assert.deepEqual(snapshot.devices, []);
  } finally {
    await harness.close();
  }
});

test('refresh and status use the same CoreService instance', async () => {
  const adapter = createAdapter(createReadyDiscovery());
  const core = createCoreService({ adapter, idFactory: createIdFactory() });
  const harness = await createHarness(core);

  try {
    const refreshedResult = await harness.client.callTool({
      name: 'workbench_refresh_devices',
      arguments: {},
    });
    const refreshed = refreshedResult.structuredContent as unknown as WorkspaceSnapshot;
    assert.equal(adapter.calls, 1);
    assert.equal(refreshed.revision, 1);
    assert.equal(refreshed.sourceKind, 'SIMULATED');
    assert.equal(refreshed.devices[0]?.connectionState, 'connected');

    const statusResult = await harness.client.callTool({
      name: 'workbench_get_status',
      arguments: {},
    });
    const status = statusResult.structuredContent as unknown as WorkspaceSnapshot;
    assert.equal(adapter.calls, 1);
    assert.equal(status.runtimeId, refreshed.runtimeId);
    assert.deepEqual(status, refreshed);
    assert.equal(JSON.stringify(status).includes('opaque-simulated-key'), false);
  } finally {
    await harness.close();
  }
});

test('tool schemas reject unexpected arguments before refreshing', async () => {
  const adapter = createAdapter(createReadyDiscovery());
  const core = createCoreService({ adapter, idFactory: createIdFactory() });
  const harness = await createHarness(core);

  try {
    const result = await harness.client.callTool({
      name: 'workbench_refresh_devices',
      arguments: { unexpected: true },
    });
    assert.equal(result.isError, true);
    assert.equal(adapter.calls, 0);
  } finally {
    await harness.close();
  }
});

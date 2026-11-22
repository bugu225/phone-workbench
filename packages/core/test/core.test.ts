import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type Capability,
  type DeviceAdapter,
  type DeviceDiscovery,
} from '@phone-workbench/contracts';

import { createCoreService } from '../src/index.ts';

const capability: Capability = {
  operation: 'screen.capture',
  state: 'unknown',
  reasonCode: 'not_tested',
  scope: 'device',
  evidence: 'NOT_RUN',
};

function connectedDevice(
  state: 'connected' | 'unauthorized' | 'offline' = 'connected',
): DeviceDiscovery & { status: 'ready' } {
  return {
    status: 'ready',
    sourceKind: 'SIMULATED',
    observedAt: '2026-11-09T08:00:00.000Z',
    devices: [
      {
        adapterDeviceKey: 'opaque-adapter-key',
        label: 'Simulated Android',
        state,
        capabilities: [capability],
      },
    ],
  };
}

function ready(
  observedAt: string,
  devices: Extract<DeviceDiscovery, { status: 'ready' }>['devices'],
): Extract<DeviceDiscovery, { status: 'ready' }> {
  return {
    status: 'ready',
    sourceKind: 'SIMULATED',
    observedAt,
    devices,
  };
}

function discoveryError(observedAt: string): DeviceDiscovery {
  return {
    status: 'error',
    sourceKind: 'SIMULATED',
    observedAt,
    devices: [],
    error: {
      code: 'DISCOVERY_FAILED',
      reasonCode: 'simulated_failure',
      message: 'Simulated discovery failed.',
      retryPolicy: 'after_refresh',
    },
  };
}

function createScriptedAdapter(script: DeviceDiscovery[]): DeviceAdapter & { calls: number; disposals: number } {
  return {
    adapterId: 'scripted',
    calls: 0,
    disposals: 0,
    async discover(): Promise<DeviceDiscovery> {
      this.calls += 1;
      const next = script.shift();
      if (!next) throw new Error('No scripted discovery remains.');
      return next;
    },
    async dispose(): Promise<void> {
      this.disposals += 1;
    },
  };
}

function createIdFactory(): () => string {
  let value = 0;
  return () => String(++value);
}

test('getSnapshot starts unconfigured and does not trigger discovery', async () => {
  const adapter = createScriptedAdapter([connectedDevice()]);
  const core = createCoreService({
    adapter,
    now: () => '2026-11-09T07:59:00.000Z',
    idFactory: createIdFactory(),
  });

  const snapshot = await core.getSnapshot();
  assert.equal(adapter.calls, 0);
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.sourceKind, 'NONE');
  assert.equal(snapshot.discoveryStatus, 'not_configured');
  assert.equal(snapshot.error?.code, 'ADAPTER_NOT_CONFIGURED');
  assert.equal(snapshot.activeSession, null);
  assert.equal(snapshot.controlOwner, 'none');
  await core.dispose();
});

test('default refresh remains explicitly not configured without claiming a real empty scan', async () => {
  const core = createCoreService({
    now: () => '2026-11-09T08:00:00.000Z',
    idFactory: createIdFactory(),
  });

  const snapshot = await core.refreshDevices();
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.sourceKind, 'NONE');
  assert.equal(snapshot.discoveryStatus, 'not_configured');
  assert.equal(snapshot.error?.code, 'ADAPTER_NOT_CONFIGURED');
  assert.deepEqual(snapshot.devices, []);
  await core.dispose();
});

test('a ready empty simulated discovery is distinct from not configured', async () => {
  const adapter = createScriptedAdapter([ready('2026-11-09T08:00:00.000Z', [])]);
  const core = createCoreService({ adapter, idFactory: createIdFactory() });

  const snapshot = await core.refreshDevices();
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.sourceKind, 'SIMULATED');
  assert.equal(snapshot.discoveryStatus, 'ready');
  assert.equal(snapshot.lastSuccessfulDiscoveryAt, '2026-11-09T08:00:00.000Z');
  assert.equal(snapshot.error, null);
  assert.deepEqual(snapshot.devices, []);
  await core.dispose();
});

test('public ID stays stable and generation increments after a connected device returns', async () => {
  const first = connectedDevice();
  const second = connectedDevice('offline');
  second.observedAt = '2026-11-09T08:01:00.000Z';
  const third = connectedDevice('connected');
  third.observedAt = '2026-11-09T08:02:00.000Z';
  const adapter = createScriptedAdapter([first, second, third]);
  const core = createCoreService({ adapter, idFactory: createIdFactory() });

  const initial = await core.refreshDevices();
  const deviceId = initial.devices[0]?.deviceId;
  assert.ok(deviceId);
  assert.equal(initial.devices[0]?.connectionGeneration, 1);

  const offline = await core.refreshDevices();
  assert.equal(offline.devices[0]?.deviceId, deviceId);
  assert.equal(offline.devices[0]?.connectionState, 'offline');
  assert.equal(offline.devices[0]?.connectionGeneration, 1);

  const reconnected = await core.refreshDevices();
  assert.equal(reconnected.devices[0]?.deviceId, deviceId);
  assert.equal(reconnected.devices[0]?.connectionState, 'connected');
  assert.equal(reconnected.devices[0]?.connectionGeneration, 2);
  assert.equal(JSON.stringify(reconnected).includes('opaque-adapter-key'), false);
  await core.dispose();
});

test('failed discovery keeps history as unknown and stale, then conservatively advances generation', async () => {
  const first = connectedDevice();
  const adapter = createScriptedAdapter([
    first,
    discoveryError('2026-11-09T08:01:00.000Z'),
    {
      ...connectedDevice(),
      observedAt: '2026-11-09T08:02:00.000Z',
    },
  ]);
  const core = createCoreService({ adapter, idFactory: createIdFactory() });

  const connected = await core.refreshDevices();
  const deviceId = connected.devices[0]?.deviceId;
  const lastSeenAt = connected.devices[0]?.lastSeenAt;

  const failed = await core.refreshDevices();
  assert.equal(failed.revision, 2);
  assert.equal(failed.discoveryStatus, 'error');
  assert.equal(failed.devices[0]?.deviceId, deviceId);
  assert.equal(failed.devices[0]?.connectionState, 'unknown');
  assert.equal(failed.devices[0]?.stale, true);
  assert.equal(failed.devices[0]?.lastSeenAt, lastSeenAt);
  assert.equal(failed.lastSuccessfulDiscoveryAt, first.observedAt);

  const recovered = await core.refreshDevices();
  assert.equal(recovered.devices[0]?.deviceId, deviceId);
  assert.equal(recovered.devices[0]?.connectionGeneration, 2);
  assert.equal(recovered.devices[0]?.stale, false);
  await core.dispose();
});

test('successful absence marks a known device disconnected without changing lastSeenAt', async () => {
  const first = connectedDevice();
  const adapter = createScriptedAdapter([
    first,
    ready('2026-11-09T08:01:00.000Z', []),
  ]);
  const core = createCoreService({ adapter, idFactory: createIdFactory() });

  const seen = await core.refreshDevices();
  const absent = await core.refreshDevices();
  assert.equal(absent.discoveryStatus, 'ready');
  assert.equal(absent.devices[0]?.connectionState, 'disconnected');
  assert.equal(absent.devices[0]?.stale, false);
  assert.equal(absent.devices[0]?.lastSeenAt, seen.devices[0]?.lastSeenAt);
  await core.dispose();
});

test('concurrent refresh calls share one discovery and receive isolated snapshots', async () => {
  let resolveDiscovery: ((value: DeviceDiscovery) => void) | undefined;
  const adapter: DeviceAdapter & { calls: number } = {
    adapterId: 'deferred',
    calls: 0,
    discover(): Promise<DeviceDiscovery> {
      this.calls += 1;
      return new Promise((resolve) => {
        resolveDiscovery = resolve;
      });
    },
    async dispose(): Promise<void> {},
  };
  const core = createCoreService({ adapter, idFactory: createIdFactory() });

  const firstCall = core.refreshDevices();
  const secondCall = core.refreshDevices();
  assert.equal(adapter.calls, 1);
  resolveDiscovery?.(connectedDevice());

  const [first, second] = await Promise.all([firstCall, secondCall]);
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
  assert.notEqual(first, second);
  first.devices[0]!.label = 'mutated by caller';
  assert.equal(second.devices[0]?.label, 'Simulated Android');
  assert.equal((await core.getSnapshot()).devices[0]?.label, 'Simulated Android');
  await core.dispose();
});

test('all snapshots are deep copies, including capabilities', async () => {
  const adapter = createScriptedAdapter([connectedDevice()]);
  const core = createCoreService({ adapter, idFactory: createIdFactory() });

  const returned = await core.refreshDevices();
  returned.devices[0]!.capabilities[0]!.state = 'supported';
  returned.devices.push({
    deviceId: 'caller-injected',
    label: 'Injected',
    connectionState: 'connected',
    connectionGeneration: 99,
    stale: false,
    lastSeenAt: 'never',
    capabilities: [],
  });

  const current = await core.getSnapshot();
  assert.equal(current.devices.length, 1);
  assert.equal(current.devices[0]?.capabilities[0]?.state, 'unknown');
  await core.dispose();
});

test('dispose aborts in-flight discovery, ignores late results, and is idempotent', async () => {
  let signal: AbortSignal | undefined;
  let resolveDiscovery: ((value: DeviceDiscovery) => void) | undefined;
  const adapter: DeviceAdapter & { disposals: number } = {
    adapterId: 'dispose-race',
    disposals: 0,
    discover(options): Promise<DeviceDiscovery> {
      signal = options?.signal;
      return new Promise((resolve) => {
        resolveDiscovery = resolve;
      });
    },
    async dispose(): Promise<void> {
      this.disposals += 1;
    },
  };
  const core = createCoreService({ adapter, idFactory: createIdFactory() });

  const pending = core.refreshDevices();
  const pendingRejection = assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof Error && (error as Error & { code?: string }).code === 'CORE_CLOSED',
  );
  await core.dispose();
  await core.dispose();
  await pendingRejection;

  assert.equal(signal?.aborted, true);
  assert.equal(adapter.disposals, 1);
  resolveDiscovery?.(connectedDevice());
  await Promise.resolve();

  const history = await core.getSnapshot();
  assert.equal(history.revision, 0);
  assert.deepEqual(history.devices, []);
  await assert.rejects(
    core.refreshDevices(),
    (error: unknown) =>
      error instanceof Error && (error as Error & { code?: string }).code === 'CORE_CLOSED',
  );
});

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  DEMO_SCENARIOS,
  SCHEMA_VERSION,
  type AdapterDevice,
  type CoreService,
  type DeviceAdapter,
  type DeviceDiscovery,
  type DomainError,
  type WorkspaceSnapshot,
} from '../../../packages/contracts/src/index.ts';
import { createAdbDeviceAdapter } from '../../../packages/device-bridge/src/index.ts';
import { createCoreService } from '../../../packages/core/src/index.ts';
import { createWorkbenchMcpServer } from '../../../packages/mcp-server/src/index.ts';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const T0 = '2026-11-09T08:00:00.000Z';
const T1 = '2026-11-09T08:00:01.000Z';
const T2 = '2026-11-09T08:00:02.000Z';
const T3 = '2026-11-09T08:00:03.000Z';
const T4 = '2026-11-09T08:00:04.000Z';
const T5 = '2026-11-09T08:00:05.000Z';
const T6 = '2026-11-09T08:00:06.000Z';
const T7 = '2026-11-09T08:00:07.000Z';
const PRIVATE_SERIAL = 'R1A-SYNTHETIC-SERIAL-PRIVATE-9F3A';

function syntheticDevice(
  state: AdapterDevice['state'] = 'connected',
  adapterDeviceKey = 'opaque-adapter-key-a',
): AdapterDevice {
  return {
    adapterDeviceKey,
    label: '合成测试设备 A',
    state,
    capabilities: [
      {
        operation: 'screen.capture',
        state: 'unknown',
        reasonCode: 'not_verified_in_r1a',
        scope: 'display',
        evidence: 'NOT_RUN',
      },
      {
        operation: 'input.text',
        state: 'unsupported',
        reasonCode: 'outside_r1a_scope',
        scope: 'display',
        evidence: 'NOT_RUN',
      },
    ],
  };
}

function readyDiscovery(
  observedAt: string,
  devices: AdapterDevice[],
): DeviceDiscovery {
  return { status: 'ready', sourceKind: 'FIXTURE', observedAt, devices };
}

function discoveryError(
  observedAt: string,
  message = 'Synthetic discovery failed',
): DeviceDiscovery {
  const error: DomainError = {
    code: 'DISCOVERY_FAILED',
    reasonCode: 'synthetic_discovery_failure',
    message,
    retryPolicy: 'after_refresh',
  };
  return {
    status: 'error',
    sourceKind: 'FIXTURE',
    observedAt,
    devices: [],
    error,
  };
}

function fixtureAdapter(
  discover: DeviceAdapter['discover'],
  onDispose: () => void = () => undefined,
): DeviceAdapter {
  return {
    adapterId: 'r1a-independent-fixture',
    discover,
    async dispose() {
      onDispose();
    },
  };
}

function sequenceIdFactory(): () => string {
  let index = 0;
  return () => `public-id-${++index}`;
}

function sequenceNow(): () => string {
  const values = [T0, T1, T2, T3, T4, T5, T6, T7];
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function assertR1aSnapshotInvariants(snapshot: WorkspaceSnapshot): void {
  assert.equal(snapshot.schemaVersion, SCHEMA_VERSION);
  assert.equal(snapshot.controlOwner, 'none');
  assert.equal(snapshot.activeSession, null);
  assert.ok(snapshot.runtimeId.length > 0);
}

test('default core is unconfigured, read-only, and distinct from a successful empty discovery', async (t) => {
  const defaultCore = createCoreService({ now: sequenceNow(), idFactory: sequenceIdFactory() });
  t.after(() => defaultCore.dispose());

  const initial = await defaultCore.getSnapshot();
  assertR1aSnapshotInvariants(initial);
  assert.equal(initial.revision, 0);
  assert.equal(initial.sourceKind, 'NONE');
  assert.equal(initial.discoveryStatus, 'not_configured');
  assert.deepEqual(initial.devices, []);
  assert.equal(initial.lastSuccessfulDiscoveryAt, null);

  const afterDefaultRefresh = await defaultCore.refreshDevices();
  assert.equal(afterDefaultRefresh.revision, 1);
  assert.equal(afterDefaultRefresh.discoveryStatus, 'not_configured');
  assert.equal(afterDefaultRefresh.sourceKind, 'NONE');
  assert.notEqual(afterDefaultRefresh.discoveryStatus, 'ready');

  const emptyCore = createCoreService({
    adapter: fixtureAdapter(async () => readyDiscovery(T1, [])),
    now: sequenceNow(),
    idFactory: sequenceIdFactory(),
  });
  t.after(() => emptyCore.dispose());

  const successfulEmpty = await emptyCore.refreshDevices();
  assertR1aSnapshotInvariants(successfulEmpty);
  assert.equal(successfulEmpty.revision, 1);
  assert.equal(successfulEmpty.discoveryStatus, 'ready');
  assert.equal(successfulEmpty.sourceKind, 'FIXTURE');
  assert.equal(successfulEmpty.lastSuccessfulDiscoveryAt, T1);
  assert.deepEqual(successfulEmpty.devices, []);
});

test('discovery errors preserve known devices as stale unknown records', async (t) => {
  const results = [
    readyDiscovery(T1, [syntheticDevice('connected')]),
    discoveryError(T2),
  ];
  const core = createCoreService({
    adapter: fixtureAdapter(async () => results.shift()!),
    now: sequenceNow(),
    idFactory: sequenceIdFactory(),
  });
  t.after(() => core.dispose());

  const first = await core.refreshDevices();
  assert.equal(first.devices[0]?.connectionState, 'connected');
  const lastSeenAt = first.devices[0]?.lastSeenAt;
  const publicDeviceId = first.devices[0]?.deviceId;

  const failed = await core.refreshDevices();
  assert.equal(failed.revision, 2);
  assert.equal(failed.discoveryStatus, 'error');
  assert.equal(failed.error?.code, 'DISCOVERY_FAILED');
  assert.equal(failed.lastSuccessfulDiscoveryAt, T1);
  assert.equal(failed.devices.length, 1);
  assert.equal(failed.devices[0]?.deviceId, publicDeviceId);
  assert.equal(failed.devices[0]?.connectionState, 'unknown');
  assert.equal(failed.devices[0]?.stale, true);
  assert.equal(failed.devices[0]?.lastSeenAt, lastSeenAt);
});

test('public device IDs stay stable while connection generation advances conservatively', async (t) => {
  const adapterKey = 'opaque-private-adapter-key-7c1d';
  const results = [
    readyDiscovery(T0, [syntheticDevice('connected', adapterKey)]),
    readyDiscovery(T1, [syntheticDevice('connected', adapterKey)]),
    readyDiscovery(T2, [syntheticDevice('offline', adapterKey)]),
    readyDiscovery(T3, [syntheticDevice('connected', adapterKey)]),
    readyDiscovery(T4, []),
    readyDiscovery(T5, [syntheticDevice('connected', adapterKey)]),
    discoveryError(T6),
    readyDiscovery(T7, [syntheticDevice('connected', adapterKey)]),
  ];
  const core = createCoreService({
    adapter: fixtureAdapter(async () => results.shift()!),
    now: sequenceNow(),
    idFactory: sequenceIdFactory(),
  });
  t.after(() => core.dispose());

  const first = await core.refreshDevices();
  const publicId = first.devices[0]!.deviceId;
  assert.notEqual(publicId, adapterKey);
  assert.equal(first.devices[0]!.connectionGeneration, 1);

  const repeated = await core.refreshDevices();
  assert.equal(repeated.devices[0]!.deviceId, publicId);
  assert.equal(repeated.devices[0]!.connectionGeneration, 1);

  const offline = await core.refreshDevices();
  assert.equal(offline.devices[0]!.connectionState, 'offline');
  assert.equal(offline.devices[0]!.connectionGeneration, 1);

  const firstReconnect = await core.refreshDevices();
  assert.equal(firstReconnect.devices[0]!.connectionState, 'connected');
  assert.equal(firstReconnect.devices[0]!.connectionGeneration, 2);

  const absent = await core.refreshDevices();
  assert.equal(absent.discoveryStatus, 'ready');
  assert.equal(absent.devices[0]!.connectionState, 'disconnected');
  assert.equal(absent.devices[0]!.stale, false);
  assert.equal(absent.devices[0]!.connectionGeneration, 2);

  const secondReconnect = await core.refreshDevices();
  assert.equal(secondReconnect.devices[0]!.connectionGeneration, 3);

  const unknown = await core.refreshDevices();
  assert.equal(unknown.devices[0]!.connectionState, 'unknown');
  assert.equal(unknown.devices[0]!.stale, true);

  const afterError = await core.refreshDevices();
  assert.equal(afterError.devices[0]!.deviceId, publicId);
  assert.equal(afterError.devices[0]!.connectionState, 'connected');
  assert.equal(afterError.devices[0]!.connectionGeneration, 4);
  assert.doesNotMatch(JSON.stringify(afterError), new RegExp(adapterKey));
});

test('concurrent refresh calls share one discovery and increment revision once', async (t) => {
  let discoverCalls = 0;
  let resolveDiscovery!: (result: DeviceDiscovery) => void;
  const discoveryPromise = new Promise<DeviceDiscovery>((resolve) => {
    resolveDiscovery = resolve;
  });
  const core = createCoreService({
    adapter: fixtureAdapter(async () => {
      discoverCalls += 1;
      return discoveryPromise;
    }),
    now: sequenceNow(),
    idFactory: sequenceIdFactory(),
  });
  t.after(() => core.dispose());

  const firstPromise = core.refreshDevices();
  const secondPromise = core.refreshDevices();
  await Promise.resolve();
  assert.equal(discoverCalls, 1);

  resolveDiscovery(readyDiscovery(T1, [syntheticDevice()]));
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(discoverCalls, 1);
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.devices, second.devices);
});

test('snapshots are defensive copies and callers cannot mutate core state', async (t) => {
  const core = createCoreService({
    adapter: fixtureAdapter(async () => readyDiscovery(T1, [syntheticDevice()])),
    now: sequenceNow(),
    idFactory: sequenceIdFactory(),
  });
  t.after(() => core.dispose());
  await core.refreshDevices();

  const exposed = await core.getSnapshot();
  const originalId = exposed.devices[0]!.deviceId;
  (exposed as { revision: number }).revision = 999;
  exposed.devices[0]!.label = '外部篡改';
  exposed.devices[0]!.capabilities[0]!.state = 'supported';
  exposed.devices.push({ ...exposed.devices[0]!, deviceId: 'injected-device' });

  const fresh = await core.getSnapshot();
  assert.equal(fresh.revision, 1);
  assert.equal(fresh.devices.length, 1);
  assert.equal(fresh.devices[0]!.deviceId, originalId);
  assert.equal(fresh.devices[0]!.label, '合成测试设备 A');
  assert.notEqual(fresh.devices[0]!.capabilities[0]!.state, 'supported');
});

test('dispose aborts in-flight discovery, rejects later refresh, and ignores late results', { timeout: 5_000 }, async () => {
  let discoverCalls = 0;
  let disposeCalls = 0;
  let observedSignal: AbortSignal | undefined;
  let resolveDiscovery!: (result: DeviceDiscovery) => void;
  const discoveryPromise = new Promise<DeviceDiscovery>((resolve) => {
    resolveDiscovery = resolve;
  });
  const core = createCoreService({
    adapter: fixtureAdapter(async (options) => {
      discoverCalls += 1;
      observedSignal = options?.signal;
      return discoveryPromise;
    }, () => {
      disposeCalls += 1;
    }),
    now: sequenceNow(),
    idFactory: sequenceIdFactory(),
  });

  const inFlight = core.refreshDevices();
  await Promise.resolve();
  const firstDispose = core.dispose();
  await Promise.resolve();
  assert.equal(observedSignal?.aborted, true);
  resolveDiscovery(readyDiscovery(T1, [syntheticDevice()]));
  await firstDispose;
  await Promise.allSettled([inFlight]);
  await core.dispose();

  assert.equal(discoverCalls, 1);
  assert.equal(disposeCalls, 1);
  const historical = await core.getSnapshot();
  assert.equal(historical.devices.some((device) => device.connectionState === 'connected'), false);

  await assert.rejects(
    () => core.refreshDevices(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, 'CORE_CLOSED');
      return true;
    },
  );
  assert.equal(discoverCalls, 1);
});

test('ADB adapter remains unconfigured without access and never calls an injected runner', async (t) => {
  let runnerCalls = 0;
  const adapter = createAdbDeviceAdapter({
    adbPath: 'C:\\synthetic\\adb.exe',
    identitySalt: 'r1a-private-test-salt',
    allowDeviceAccess: false,
    runner: async () => {
      runnerCalls += 1;
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    now: () => T0,
  });
  t.after(() => adapter.dispose());

  const discovery = await adapter.discover();
  assert.equal(runnerCalls, 0);
  assert.equal(discovery.status, 'not_configured');
  assert.equal(discovery.sourceKind, 'NONE');
  assert.deepEqual(discovery.devices, []);
  assert.equal(discovery.error.code, 'ADAPTER_NOT_CONFIGURED');
});

test('ADB adapter parses only the fixed simulated command and redacts raw identity and metadata', async (t) => {
  let runnerCalls = 0;
  const adapter = createAdbDeviceAdapter({
    adbPath: 'C:\\synthetic path\\adb.exe',
    identitySalt: 'r1a-private-test-salt',
    allowDeviceAccess: true,
    runner: async (executable, args, options) => {
      runnerCalls += 1;
      assert.equal(executable, 'C:\\synthetic path\\adb.exe');
      assert.deepEqual(args, ['devices', '-l']);
      assert.ok(options.timeoutMs > 0);
      return {
        stdout: `List of devices attached\n${PRIVATE_SERIAL}\tdevice usb:1-3 product:synthetic model:Pixel_9 device:test transport_id:7\n`,
        stderr: '',
        exitCode: 0,
      };
    },
    now: () => T1,
  });
  t.after(() => adapter.dispose());

  const discovery = await adapter.discover();
  assert.equal(runnerCalls, 1);
  assert.equal(discovery.status, 'ready');
  assert.equal(discovery.sourceKind, 'SIMULATED');
  assert.equal(discovery.devices.length, 1);
  const device = discovery.devices[0]!;
  assert.equal(device.state, 'connected');
  assert.notEqual(device.adapterDeviceKey, PRIVATE_SERIAL);
  assert.doesNotMatch(device.adapterDeviceKey, new RegExp(PRIVATE_SERIAL));
  for (const capability of device.capabilities) {
    assert.notEqual(capability.state, 'supported');
    assert.ok(capability.state === 'unknown' || capability.state === 'unsupported');
    assert.notEqual(capability.evidence, 'DEVICE_PASS');
  }
  const serialized = JSON.stringify(discovery);
  assert.doesNotMatch(serialized, new RegExp(PRIVATE_SERIAL));
  assert.doesNotMatch(serialized, /transport_id|usb:1-3/);
});

test('ADB adapter fails closed for malformed or unknown device states and redacts runner errors', async (t) => {
  const outputs = [
    { stdout: `List of devices attached\n${PRIVATE_SERIAL}\tmystery\n`, stderr: '', exitCode: 0 },
    { stdout: `${PRIVATE_SERIAL}\tdevice\n`, stderr: '', exitCode: 0 },
    { stdout: '', stderr: `cannot run ${PRIVATE_SERIAL} at C:\\Users\\Private\\adb.log`, exitCode: 1 },
  ];
  const adapter = createAdbDeviceAdapter({
    adbPath: 'C:\\synthetic\\adb.exe',
    identitySalt: 'r1a-private-test-salt',
    allowDeviceAccess: true,
    runner: async () => outputs.shift()!,
    now: sequenceNow(),
  });
  t.after(() => adapter.dispose());

  for (let index = 0; index < 3; index += 1) {
    const discovery = await adapter.discover();
    assert.equal(discovery.status, 'error');
    assert.deepEqual(discovery.devices, []);
    assert.doesNotMatch(JSON.stringify(discovery), new RegExp(PRIVATE_SERIAL));
    assert.doesNotMatch(JSON.stringify(discovery), /C:\\\\Users\\\\Private|adb\.log/);
  }
});

function fakeSnapshot(revision: number): WorkspaceSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    runtimeId: 'fixture-runtime-public',
    revision,
    sourceKind: 'FIXTURE',
    discoveryStatus: 'ready',
    observedAt: T1,
    lastSuccessfulDiscoveryAt: T1,
    devices: [],
    controlOwner: 'none',
    activeSession: null,
    error: null,
  };
}

test('MCP exposes exactly two zero-argument read-only tools backed by the same core instance', async () => {
  let statusCalls = 0;
  let refreshCalls = 0;
  const core: CoreService = {
    async getSnapshot() {
      statusCalls += 1;
      return fakeSnapshot(10);
    },
    async refreshDevices() {
      refreshCalls += 1;
      return fakeSnapshot(11);
    },
    async dispose() {},
  };
  const server = createWorkbenchMcpServer(core);
  const client = new Client({ name: 'r1a-independent-acceptance', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ['workbench_get_status', 'workbench_refresh_devices'],
    );
    for (const tool of listed.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.inputSchema.type, 'object');
      assert.deepEqual(tool.inputSchema.properties ?? {}, {});
      assert.equal(tool.inputSchema.required?.length ?? 0, 0);
    }

    const statusResult = await client.callTool({ name: 'workbench_get_status', arguments: {} });
    assert.notEqual(statusResult.isError, true);
    assert.equal(statusCalls, 1);
    assert.equal(refreshCalls, 0);
    assert.match(JSON.stringify(statusResult), /fixture-runtime-public/);

    const refreshResult = await client.callTool({ name: 'workbench_refresh_devices', arguments: {} });
    assert.notEqual(refreshResult.isError, true);
    assert.equal(statusCalls, 1);
    assert.equal(refreshCalls, 1);
    assert.match(JSON.stringify(refreshResult), /"revision"\s*:\s*11/);
  } finally {
    await client.close();
    await server.close();
  }
});

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursively(fullPath));
    } else if (/\.(?:ts|tsx|mjs|html)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readDesktopSources(): Promise<Array<{ file: string; text: string }>> {
  const desktopRoot = path.join(workspaceRoot, 'apps', 'desktop');
  const files = await listFilesRecursively(desktopRoot);
  return Promise.all(files.map(async (file) => ({
    file,
    text: await readFile(file, 'utf8'),
  })));
}

test('desktop source declares frozen unconfigured/demo labels and every sample scenario', async () => {
  const sources = await readDesktopSources();
  const combined = sources.map(({ text }) => text).join('\n');
  assert.match(combined, /尚未连接控制服务/);
  assert.match(combined, /示例数据，不会操作真实手机/);
  assert.match(combined, /--demo/);
  assert.match(combined, /setDemoScenario/);
  for (const scenario of DEMO_SCENARIOS) {
    assert.match(combined, new RegExp(scenario));
  }
  assert.doesNotMatch(combined, /真实设备已连接|控制已启用/);
});

test('desktop BrowserWindow, navigation, CSP, and preload bridge are fail-closed', async () => {
  const sources = await readDesktopSources();
  const sourceByName = new Map(sources.map(({ file, text }) => [file, text]));
  const allCombined = sources.map(({ text }) => text).join('\n');
  const srcSources = sources.filter(({ file }) => file.includes(`${path.sep}src${path.sep}`));
  const combined = srcSources.map(({ text }) => text).join('\n');
  const preload = [...sourceByName.entries()]
    .filter(([file]) => /preload/i.test(path.basename(file)))
    .map(([, text]) => text)
    .join('\n');

  assert.match(combined, /contextIsolation\s*:\s*true/);
  assert.match(combined, /sandbox\s*:\s*true/);
  assert.match(combined, /nodeIntegration\s*:\s*false/);
  assert.match(combined, /setWindowOpenHandler/);
  assert.match(combined, /will-navigate/);
  assert.match(allCombined, /Content-Security-Policy|default-src/);
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.match(preload, /getSnapshot/);
  assert.match(preload, /getMode/);
  assert.match(preload, /setDemoScenario/);
  assert.doesNotMatch(preload, /ipcRenderer\.(?:send|sendSync)\s*\(/);
  assert.doesNotMatch(preload, /invoke\s*\(\s*(?:channel|event|name)\b/);
  assert.doesNotMatch(combined, /node:child_process|@phone-workbench\/(?:core|device-bridge)|\badb\.exe\b|\bscrcpy\.exe\b/);

  const scenarioRegion = combined.match(/setDemoScenario[\s\S]{0,2500}/)?.[0] ?? '';
  assert.match(scenarioRegion, /demo/i);
  assert.match(scenarioRegion, /throw|reject|not[_ -]?configured|示例模式/iu);
});

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import type { DeviceDiscovery } from '@phone-workbench/contracts';

import {
  createAdbDeviceAdapter,
  type AdbCommandRunner,
  type AdbCommandResult,
} from '../src/index.ts';

const FIXED_TIME = '2026-11-09T08:00:00.000Z';
const ADB_PATH = 'X:\\tools\\adb.exe';
const SERIAL_ALPHA = 'TEST-SERIAL-ALPHA';
const SERIAL_BETA = 'TEST-SERIAL-BETA';

function result(stdout: string, stderr = '', exitCode: number | null = 0): AdbCommandResult {
  return { stdout, stderr, exitCode };
}

function adapterWithRunner(
  runner: AdbCommandRunner,
  overrides: Partial<Parameters<typeof createAdbDeviceAdapter>[0]> = {},
) {
  return createAdbDeviceAdapter({
    adbPath: ADB_PATH,
    identitySalt: 'unit-test-salt-a',
    allowDeviceAccess: true,
    runner,
    now: () => FIXED_TIME,
    ...overrides,
  });
}

function assertNoPrivateValues(value: unknown, privateValues: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const privateValue of privateValues) {
    assert.equal(serialized.includes(privateValue), false, `leaked private value: ${privateValue}`);
  }
}

type FailedDiscovery = Exclude<DeviceDiscovery, { status: 'ready' }>;

function expectFailed(discovery: DeviceDiscovery): FailedDiscovery {
  if (discovery.status === 'ready') assert.fail('expected discovery to fail');
  return discovery;
}

test('device access is disabled by default and never invokes an injected runner', async () => {
  let calls = 0;
  const adapter = createAdbDeviceAdapter({
    adbPath: ADB_PATH,
    identitySalt: 'unit-test-salt-a',
    runner: async () => {
      calls += 1;
      return result('List of devices attached\n');
    },
    now: () => FIXED_TIME,
  });

  const discovery = await adapter.discover();
  assert.equal(calls, 0);
  assert.equal(discovery.status, 'not_configured');
  assert.equal(discovery.sourceKind, 'NONE');
  assert.deepEqual(discovery.devices, []);
  assert.equal(expectFailed(discovery).error.code, 'ADAPTER_NOT_CONFIGURED');
});

test('runs only devices -l and parses multiple connected devices without serial leakage', async () => {
  const calls: Array<{
    executable: string;
    args: readonly string[];
    timeoutMs: number;
    hasSignal: boolean;
  }> = [];
  const runner: AdbCommandRunner = async (executable, args, options) => {
    calls.push({
      executable,
      args: [...args],
      timeoutMs: options.timeoutMs,
      hasSignal: options.signal instanceof AbortSignal,
    });
    return result(
      [
        'List of devices attached',
        `${SERIAL_ALPHA} device product:test model:Pixel_Test device:test transport_id:1`,
        `${SERIAL_BETA} device product:test model:Tablet_Test device:test transport_id:2`,
        '',
      ].join('\r\n'),
    );
  };
  const adapter = adapterWithRunner(runner);

  const discovery = await adapter.discover();
  assert.equal(discovery.status, 'ready');
  assert.equal(discovery.sourceKind, 'SIMULATED');
  assert.equal(discovery.observedAt, FIXED_TIME);
  assert.equal(discovery.devices.length, 2);
  assert.deepEqual(
    discovery.devices.map((device) => [device.label, device.state]),
    [
      ['Pixel Test', 'connected'],
      ['Tablet Test', 'connected'],
    ],
  );
  assert.deepEqual(calls, [
    { executable: ADB_PATH, args: ['devices', '-l'], timeoutMs: 5_000, hasSignal: true },
  ]);
  for (const device of discovery.devices) {
    assert.match(device.adapterDeviceKey, /^adb_[A-Za-z0-9_-]{43}$/u);
    assert.equal(
      device.capabilities.find((capability) => capability.operation === 'screen.stream')?.state,
      'unknown',
    );
    assert.equal(
      device.capabilities.find((capability) => capability.operation === 'input.pointer')?.state,
      'unsupported',
    );
  }
  assertNoPrivateValues(discovery, [SERIAL_ALPHA, SERIAL_BETA, ADB_PATH]);
});

test('parses unauthorized and offline states without claiming connection', async () => {
  const adapter = adapterWithRunner(async () =>
    result(
      [
        'List of devices attached',
        `${SERIAL_ALPHA} unauthorized usb:1-1 transport_id:4`,
        `${SERIAL_BETA} offline transport_id:5`,
      ].join('\n'),
    ),
  );

  const discovery = await adapter.discover();
  assert.equal(discovery.status, 'ready');
  assert.deepEqual(
    discovery.devices.map((device) => device.state),
    ['unauthorized', 'offline'],
  );
  assertNoPrivateValues(discovery, [SERIAL_ALPHA, SERIAL_BETA]);
});

test('accepts daemon notices and distinguishes a verified empty discovery', async () => {
  const adapter = adapterWithRunner(async () =>
    result(
      '* daemon not running; starting now at tcp:5037\nList of devices attached\n',
      '* daemon started successfully\n',
    ),
  );

  const discovery = await adapter.discover();
  assert.deepEqual(discovery, {
    status: 'ready',
    sourceKind: 'SIMULATED',
    observedAt: FIXED_TIME,
    devices: [],
  });
});

for (const fixture of [
  { name: 'empty output', stdout: '', reasonCode: 'missing_adb_header' },
  { name: 'line before header', stdout: `${SERIAL_ALPHA} device\n`, reasonCode: 'missing_adb_header' },
  {
    name: 'malformed line',
    stdout: 'List of devices attached\nmalformed-only-one-field\n',
    reasonCode: 'malformed_device_line',
  },
  {
    name: 'unknown state',
    stdout: `List of devices attached\n${SERIAL_ALPHA} recovery transport_id:8\n`,
    reasonCode: 'unknown_device_state',
  },
  {
    name: 'malformed detail',
    stdout: `List of devices attached\n${SERIAL_ALPHA} device broken-detail\n`,
    reasonCode: 'malformed_device_detail',
  },
]) {
  test(`rejects ${fixture.name} instead of manufacturing a ready empty list`, async () => {
    const adapter = adapterWithRunner(async () => result(fixture.stdout));
    const discovery = await adapter.discover();
    assert.equal(discovery.status, 'error');
    const failure = expectFailed(discovery);
    assert.equal(failure.error.code, 'DISCOVERY_FAILED');
    assert.equal(failure.error.reasonCode, fixture.reasonCode);
    assert.deepEqual(discovery.devices, []);
    assertNoPrivateValues(discovery, [SERIAL_ALPHA]);
  });
}

test('rejects unexpected stderr even when the command exits zero', async () => {
  const adapter = adapterWithRunner(async () =>
    result('List of devices attached\n', `diagnostic includes ${SERIAL_ALPHA}`),
  );
  const discovery = await adapter.discover();
  assert.equal(discovery.status, 'error');
  assert.equal(expectFailed(discovery).error.reasonCode, 'unexpected_adb_stderr');
  assertNoPrivateValues(discovery, [SERIAL_ALPHA]);
});

test('maps non-zero exits to a redacted discovery failure', async () => {
  const adapter = adapterWithRunner(async () =>
    result('', `cannot open ${ADB_PATH}; serial=${SERIAL_ALPHA}`, 1),
  );
  const discovery = await adapter.discover();
  assert.equal(discovery.status, 'error');
  const failure = expectFailed(discovery);
  assert.equal(failure.error.code, 'DISCOVERY_FAILED');
  assert.equal(failure.error.reasonCode, 'adb_nonzero_exit');
  assertNoPrivateValues(discovery, [SERIAL_ALPHA, ADB_PATH]);
});

test('redacts thrown runner errors and recognizes unavailable executables', async () => {
  const generic = adapterWithRunner(async () => {
    throw new Error(`private ${SERIAL_ALPHA} ${ADB_PATH}`);
  });
  const genericDiscovery = await generic.discover();
  assert.equal(genericDiscovery.status, 'error');
  assert.equal(expectFailed(genericDiscovery).error.reasonCode, 'adb_runner_failed');
  assertNoPrivateValues(genericDiscovery, [SERIAL_ALPHA, ADB_PATH]);

  const unavailable = adapterWithRunner(async () => {
    throw Object.assign(new Error(`missing ${ADB_PATH}`), { code: 'ENOENT' });
  });
  const unavailableDiscovery = await unavailable.discover();
  assert.equal(unavailableDiscovery.status, 'unavailable');
  assert.equal(expectFailed(unavailableDiscovery).error.code, 'ADAPTER_UNAVAILABLE');
  assertNoPrivateValues(unavailableDiscovery, [ADB_PATH]);
});

test('rejects oversized injected output without preserving it', async () => {
  const oversized = `List of devices attached\n${'x'.repeat(300_000)}`;
  const adapter = adapterWithRunner(async () => result(oversized));
  const discovery = await adapter.discover();
  assert.equal(discovery.status, 'error');
  assert.equal(expectFailed(discovery).error.reasonCode, 'adb_output_limit');
  assert.equal(JSON.stringify(discovery).includes('xxxxxxxxxxxxxxxx'), false);
});

test(
  'times out an injected runner that never completes',
  { timeout: 7_000 },
  async () => {
    const adapter = adapterWithRunner(
      async (_executable, _args, options) =>
        await new Promise<AdbCommandResult>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(new Error(`late private ${SERIAL_ALPHA}`)),
            { once: true },
          );
        }),
    );

    const discovery = await adapter.discover();
    assert.equal(discovery.status, 'error');
    const failure = expectFailed(discovery);
    assert.equal(failure.error.code, 'TIMEOUT');
    assert.equal(failure.error.reasonCode, 'adb_discovery_timeout');
    assertNoPrivateValues(discovery, [SERIAL_ALPHA]);
  },
);

test('honors caller cancellation and dispose is idempotent', async () => {
  let calls = 0;
  const runner: AdbCommandRunner = async (_executable, _args, options) => {
    calls += 1;
    return await new Promise<AdbCommandResult>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  const cancelledAdapter = adapterWithRunner(runner);
  const external = new AbortController();
  const cancelled = cancelledAdapter.discover({ signal: external.signal });
  external.abort();
  const cancelledDiscovery = await cancelled;
  assert.equal(cancelledDiscovery.status, 'error');
  assert.equal(expectFailed(cancelledDiscovery).error.code, 'CANCELLED');

  const disposedAdapter = adapterWithRunner(runner);
  const pending = disposedAdapter.discover();
  await Promise.resolve();
  await disposedAdapter.dispose();
  await disposedAdapter.dispose();
  const disposedDiscovery = await pending;
  assert.equal(disposedDiscovery.status, 'error');
  assert.equal(expectFailed(disposedDiscovery).error.code, 'CANCELLED');

  const callsBeforeRetry = calls;
  const afterDispose = await disposedAdapter.discover();
  assert.equal(afterDispose.status, 'unavailable');
  assert.equal(expectFailed(afterDispose).error.reasonCode, 'adapter_disposed');
  assert.equal(calls, callsBeforeRetry);
});

test('opaque identities are stable for one salt and isolated across salts', async () => {
  const runner: AdbCommandRunner = async () =>
    result(`List of devices attached\n${SERIAL_ALPHA} device model:Reference_Device\n`);
  const first = adapterWithRunner(runner, { identitySalt: 'salt-one' });
  const second = adapterWithRunner(runner, { identitySalt: 'salt-one' });
  const isolated = adapterWithRunner(runner, { identitySalt: 'salt-two' });

  const firstKey = (await first.discover()).devices[0]?.adapterDeviceKey;
  const repeatedKey = (await first.discover()).devices[0]?.adapterDeviceKey;
  const secondKey = (await second.discover()).devices[0]?.adapterDeviceKey;
  const isolatedKey = (await isolated.discover()).devices[0]?.adapterDeviceKey;

  assert.ok(firstKey);
  assert.equal(firstKey, repeatedKey);
  assert.equal(firstKey, secondKey);
  assert.notEqual(firstKey, isolatedKey);
  assert.equal(firstKey.includes(SERIAL_ALPHA), false);
});

test('rejects invalid factory configuration before any runner can execute', () => {
  assert.throws(
    () => createAdbDeviceAdapter({ adbPath: ' ', identitySalt: 'salt' }),
    /adbPath must not be empty/u,
  );
  assert.throws(
    () => createAdbDeviceAdapter({ adbPath: ADB_PATH, identitySalt: '' }),
    /identitySalt must not be empty/u,
  );
});

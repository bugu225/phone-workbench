/// <reference types="node" />

import { createHmac } from 'node:crypto';

import type {
  AdapterDevice,
  DeviceAdapter,
  DeviceDiscovery,
  DomainError,
  SourceKind,
} from '@phone-workbench/contracts';

import {
  cloneDefaultCapabilities,
  parseAdbDevices,
  safeDeviceLabel,
} from './parse-devices.ts';
import {
  AdbOutputLimitError,
  AdbSpawnUnavailableError,
  createSpawnAdbRunner,
  MAX_ADB_OUTPUT_BYTES,
} from './spawn-runner.ts';

const DISCOVERY_TIMEOUT_MS = 5_000;

export interface AdbCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export type AdbCommandRunner = (
  executable: string,
  args: readonly string[],
  options: { readonly signal?: AbortSignal; readonly timeoutMs: number },
) => Promise<AdbCommandResult>;

export interface CreateAdbDeviceAdapterOptions {
  readonly adbPath: string;
  readonly identitySalt: string;
  readonly allowDeviceAccess?: boolean;
  readonly runner?: AdbCommandRunner;
  readonly now?: () => string;
}

class DiscoveryAbortedError extends Error {
  constructor() {
    super('Discovery aborted');
    this.name = 'DiscoveryAbortedError';
  }
}

function domainError(
  code: DomainError['code'],
  reasonCode: string,
  message: string,
  retryPolicy: DomainError['retryPolicy'] = 'after_refresh',
): DomainError {
  return { code, reasonCode, message, retryPolicy };
}

function failedDiscovery(
  status: 'not_configured' | 'unavailable' | 'error',
  sourceKind: SourceKind,
  observedAt: string,
  error: DomainError,
): DeviceDiscovery {
  return { status, sourceKind, observedAt, devices: [], error };
}

function isUnavailableError(error: unknown): boolean {
  if (error instanceof AdbSpawnUnavailableError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' ||
      (error as { code?: unknown }).code === 'ADB_SPAWN_UNAVAILABLE')
  );
}

function isOutputLimitError(error: unknown): boolean {
  return (
    error instanceof AdbOutputLimitError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ADB_OUTPUT_LIMIT')
  );
}

function outputWithinLimit(result: AdbCommandResult): boolean {
  return (
    Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8') <=
    MAX_ADB_OUTPUT_BYTES
  );
}

/**
 * Create the R1-A read-only ADB discovery adapter.
 *
 * Device access is disabled by default. No system process is started until callers explicitly set
 * allowDeviceAccess=true and call discover(). Injecting a runner always marks executed discovery
 * as SIMULATED.
 */
export function createAdbDeviceAdapter(options: CreateAdbDeviceAdapterOptions): DeviceAdapter {
  if (!options.adbPath.trim()) throw new TypeError('adbPath must not be empty');
  if (!options.identitySalt) throw new TypeError('identitySalt must not be empty');

  const allowDeviceAccess = options.allowDeviceAccess ?? false;
  const simulated = options.runner !== undefined;
  const runner = options.runner ?? createSpawnAdbRunner();
  const now = options.now ?? (() => new Date().toISOString());
  const inFlight = new Set<AbortController>();
  const serialByKey = new Map<string, string>();
  let disposed = false;

  const attemptedSource = (): SourceKind => (simulated ? 'SIMULATED' : 'NONE');
  const keyForSerial = (serial: string): string =>
    `adb_${createHmac('sha256', options.identitySalt).update(serial, 'utf8').digest('base64url')}`;

  const adapter: DeviceAdapter = {
    adapterId: 'adb-readonly-r1a',

    async discover(discoverOptions = {}): Promise<DeviceDiscovery> {
      if (!allowDeviceAccess) {
        return failedDiscovery(
          'not_configured',
          'NONE',
          now(),
          domainError(
            'ADAPTER_NOT_CONFIGURED',
            'device_access_disabled',
            'Device discovery is disabled until explicitly configured.',
            'never',
          ),
        );
      }

      if (disposed) {
        return failedDiscovery(
          'unavailable',
          attemptedSource(),
          now(),
          domainError(
            'ADAPTER_UNAVAILABLE',
            'adapter_disposed',
            'The device adapter has been disposed.',
            'never',
          ),
        );
      }

      if (discoverOptions.signal?.aborted) {
        return failedDiscovery(
          'error',
          attemptedSource(),
          now(),
          domainError('CANCELLED', 'discovery_cancelled', 'Device discovery was cancelled.'),
        );
      }

      const controller = new AbortController();
      inFlight.add(controller);
      let abortCause: 'timeout' | 'cancelled' | null = null;

      const onExternalAbort = (): void => {
        if (!abortCause) abortCause = 'cancelled';
        controller.abort();
      };
      discoverOptions.signal?.addEventListener('abort', onExternalAbort, { once: true });

      const timeout = setTimeout(() => {
        if (!abortCause) abortCause = 'timeout';
        controller.abort();
      }, DISCOVERY_TIMEOUT_MS);

      let onInternalAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onInternalAbort = () => reject(new DiscoveryAbortedError());
        controller.signal.addEventListener('abort', onInternalAbort, { once: true });
      });
      const execution = Promise.resolve().then(() =>
        runner(options.adbPath, ['devices', '-l'], {
          signal: controller.signal,
          timeoutMs: DISCOVERY_TIMEOUT_MS,
        }),
      );

      try {
        const result = await Promise.race([execution, aborted]);

        if (disposed || controller.signal.aborted) throw new DiscoveryAbortedError();
        if (!outputWithinLimit(result)) throw new AdbOutputLimitError();
        if (result.exitCode !== 0) {
          return failedDiscovery(
            'error',
            attemptedSource(),
            now(),
            domainError(
              'DISCOVERY_FAILED',
              result.exitCode === null ? 'adb_no_exit_code' : 'adb_nonzero_exit',
              'ADB discovery did not complete successfully.',
            ),
          );
        }

        const parsed = parseAdbDevices(result.stdout, result.stderr);
        if (!parsed.ok) {
          return failedDiscovery(
            'error',
            attemptedSource(),
            now(),
            domainError(
              'DISCOVERY_FAILED',
              parsed.reasonCode,
              'ADB discovery returned an unrecognized response.',
            ),
          );
        }

        const devices: AdapterDevice[] = [];
        for (const device of parsed.devices) {
          const adapterDeviceKey = keyForSerial(device.serial);
          const existingSerial = serialByKey.get(adapterDeviceKey);
          if (existingSerial && existingSerial !== device.serial) {
            return failedDiscovery(
              'error',
              attemptedSource(),
              now(),
              domainError(
                'INTERNAL_ERROR',
                'adapter_identity_collision',
                'Device identity could not be established safely.',
                'never',
              ),
            );
          }
          serialByKey.set(adapterDeviceKey, device.serial);
          devices.push({
            adapterDeviceKey,
            label: safeDeviceLabel(device.model, device.serial, adapterDeviceKey),
            state: device.state,
            capabilities: cloneDefaultCapabilities(),
          });
        }

        return {
          status: 'ready',
          sourceKind: simulated ? 'SIMULATED' : 'REAL_DEVICE',
          observedAt: now(),
          devices,
        };
      } catch (error) {
        if (abortCause === 'timeout') {
          return failedDiscovery(
            'error',
            attemptedSource(),
            now(),
            domainError('TIMEOUT', 'adb_discovery_timeout', 'Device discovery timed out.'),
          );
        }
        if (abortCause === 'cancelled' || disposed || error instanceof DiscoveryAbortedError) {
          return failedDiscovery(
            'error',
            attemptedSource(),
            now(),
            domainError('CANCELLED', 'discovery_cancelled', 'Device discovery was cancelled.'),
          );
        }
        if (isUnavailableError(error)) {
          return failedDiscovery(
            'unavailable',
            attemptedSource(),
            now(),
            domainError(
              'ADAPTER_UNAVAILABLE',
              'adb_executable_unavailable',
              'The configured ADB executable is unavailable.',
            ),
          );
        }
        if (isOutputLimitError(error)) {
          return failedDiscovery(
            'error',
            attemptedSource(),
            now(),
            domainError(
              'DISCOVERY_FAILED',
              'adb_output_limit',
              'ADB discovery output exceeded the safety limit.',
            ),
          );
        }
        return failedDiscovery(
          'error',
          attemptedSource(),
          now(),
          domainError(
            'DISCOVERY_FAILED',
            'adb_runner_failed',
            'ADB discovery could not be completed.',
          ),
        );
      } finally {
        clearTimeout(timeout);
        discoverOptions.signal?.removeEventListener('abort', onExternalAbort);
        if (onInternalAbort) controller.signal.removeEventListener('abort', onInternalAbort);
        inFlight.delete(controller);
      }
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const controller of inFlight) controller.abort();
      inFlight.clear();
      serialByKey.clear();
    },
  };

  return adapter;
}

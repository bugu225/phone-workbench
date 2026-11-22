import { randomUUID } from 'node:crypto';

import {
  SCHEMA_VERSION,
  type AdapterDevice,
  type CoreClosedError,
  type CoreService,
  type CoreServiceOptions,
  type DeviceAdapter,
  type DeviceDiscovery,
  type DeviceRecord,
  type DomainError,
  type SourceKind,
  type WorkspaceSnapshot,
} from '@phone-workbench/contracts';

interface InternalDevice {
  readonly adapterDeviceKey: string;
  publicRecord: DeviceRecord;
  hasConnected: boolean;
}

const INITIAL_DISCOVERY_ERROR: DomainError = {
  code: 'ADAPTER_NOT_CONFIGURED',
  reasonCode: 'discovery_not_run',
  message: 'Device discovery has not been run.',
  retryPolicy: 'after_refresh',
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createCoreClosedError(): CoreClosedError {
  const error = new Error('Core service is closed.') as CoreClosedError;
  error.name = 'CoreClosedError';
  error.code = 'CORE_CLOSED';
  return error;
}

function createUnhandledDiscoveryError(): DomainError {
  return {
    code: 'DISCOVERY_FAILED',
    reasonCode: 'adapter_discover_threw',
    message: 'Device discovery failed.',
    retryPolicy: 'after_refresh',
  };
}

function createDuplicateDeviceError(): DomainError {
  return {
    code: 'DISCOVERY_FAILED',
    reasonCode: 'duplicate_adapter_device_key',
    message: 'Device discovery returned duplicate device identities.',
    retryPolicy: 'after_refresh',
  };
}

function createUnconfiguredAdapter(now: () => string): DeviceAdapter {
  return {
    adapterId: 'unconfigured',
    async discover(): Promise<DeviceDiscovery> {
      return {
        status: 'not_configured',
        sourceKind: 'NONE',
        observedAt: now(),
        devices: [],
        error: clone(INITIAL_DISCOVERY_ERROR),
      };
    },
    async dispose(): Promise<void> {},
  };
}

function waitForDiscovery(
  discovery: Promise<DeviceDiscovery>,
  signal: AbortSignal,
): Promise<DeviceDiscovery> {
  if (signal.aborted) {
    return Promise.reject(createCoreClosedError());
  }

  return new Promise<DeviceDiscovery>((resolve, reject) => {
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };

    const onAbort = (): void => {
      finish(() => reject(createCoreClosedError()));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    discovery.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function createCoreService(options: CoreServiceOptions = {}): CoreService {
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? randomUUID;
  const adapter = options.adapter ?? createUnconfiguredAdapter(now);
  const devices = new Map<string, InternalDevice>();

  let closed = false;
  let disposePromise: Promise<void> | undefined;
  let inFlight: Promise<void> | undefined;
  let inFlightController: AbortController | undefined;

  let snapshot: WorkspaceSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    runtimeId: 'runtime_' + idFactory(),
    revision: 0,
    sourceKind: 'NONE',
    discoveryStatus: 'not_configured',
    observedAt: now(),
    lastSuccessfulDiscoveryAt: null,
    devices: [],
    controlOwner: 'none',
    activeSession: null,
    error: clone(INITIAL_DISCOVERY_ERROR),
  };

  const publicDevices = (): DeviceRecord[] =>
    Array.from(devices.values(), (entry) => clone(entry.publicRecord)).sort((left, right) =>
      left.deviceId.localeCompare(right.deviceId),
    );

  const markDiscoveryFailure = (
    status: 'not_configured' | 'unavailable' | 'error',
    sourceKind: SourceKind,
    observedAt: string,
    error: DomainError,
  ): void => {
    for (const entry of devices.values()) {
      entry.publicRecord = {
        ...entry.publicRecord,
        connectionState: 'unknown',
        stale: true,
      };
    }

    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      sourceKind,
      discoveryStatus: status,
      observedAt,
      devices: publicDevices(),
      error: clone(error),
    };
  };

  const updatePresentDevice = (device: AdapterDevice, observedAt: string): void => {
    const existing = devices.get(device.adapterDeviceKey);
    if (!existing) {
      devices.set(device.adapterDeviceKey, {
        adapterDeviceKey: device.adapterDeviceKey,
        hasConnected: device.state === 'connected',
        publicRecord: {
          deviceId: 'device_' + idFactory(),
          label: device.label,
          connectionState: device.state,
          connectionGeneration: 1,
          stale: false,
          lastSeenAt: observedAt,
          capabilities: clone(device.capabilities),
        },
      });
      return;
    }

    let connectionGeneration = existing.publicRecord.connectionGeneration;
    if (
      device.state === 'connected' &&
      existing.hasConnected &&
      existing.publicRecord.connectionState !== 'connected'
    ) {
      connectionGeneration += 1;
    }

    if (device.state === 'connected') {
      existing.hasConnected = true;
    }

    existing.publicRecord = {
      deviceId: existing.publicRecord.deviceId,
      label: device.label,
      connectionState: device.state,
      connectionGeneration,
      stale: false,
      lastSeenAt: observedAt,
      capabilities: clone(device.capabilities),
    };
  };

  const markMissingDevicesDisconnected = (presentKeys: ReadonlySet<string>): void => {
    for (const [adapterDeviceKey, entry] of devices) {
      if (presentKeys.has(adapterDeviceKey)) continue;
      entry.publicRecord = {
        ...entry.publicRecord,
        connectionState: 'disconnected',
        stale: false,
      };
    }
  };

  const applyReadyDiscovery = (
    discovery: Extract<DeviceDiscovery, { status: 'ready' }>,
  ): void => {
    const presentKeys = new Set<string>();
    for (const device of discovery.devices) {
      if (presentKeys.has(device.adapterDeviceKey)) {
        markDiscoveryFailure(
          'error',
          discovery.sourceKind,
          discovery.observedAt,
          createDuplicateDeviceError(),
        );
        return;
      }
      presentKeys.add(device.adapterDeviceKey);
    }

    for (const device of discovery.devices) {
      updatePresentDevice(device, discovery.observedAt);
    }

    markMissingDevicesDisconnected(presentKeys);
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      sourceKind: discovery.sourceKind,
      discoveryStatus: 'ready',
      observedAt: discovery.observedAt,
      lastSuccessfulDiscoveryAt: discovery.observedAt,
      devices: publicDevices(),
      error: null,
    };
  };

  const performRefresh = async (signal: AbortSignal): Promise<void> => {
    let discoveryPromise: Promise<DeviceDiscovery>;
    try {
      discoveryPromise = adapter.discover({ signal });
    } catch {
      discoveryPromise = Promise.reject(new Error('Adapter discovery invocation failed.'));
    }

    try {
      const discovery = await waitForDiscovery(discoveryPromise, signal);
      if (closed || signal.aborted) {
        throw createCoreClosedError();
      }

      if (discovery.status === 'ready') {
        applyReadyDiscovery(discovery);
      } else {
        markDiscoveryFailure(
          discovery.status,
          discovery.sourceKind,
          discovery.observedAt,
          discovery.error,
        );
      }
    } catch (error) {
      if (closed || signal.aborted) {
        throw createCoreClosedError();
      }
      markDiscoveryFailure(
        'error',
        snapshot.sourceKind,
        now(),
        createUnhandledDiscoveryError(),
      );
      void error;
    }
  };

  const getSnapshot = async (): Promise<WorkspaceSnapshot> => clone(snapshot);

  const refreshDevices = async (): Promise<WorkspaceSnapshot> => {
    if (closed) {
      throw createCoreClosedError();
    }

    if (!inFlight) {
      const controller = new AbortController();
      inFlightController = controller;
      const operation = performRefresh(controller.signal);
      let tracked: Promise<void>;
      tracked = operation.finally(() => {
        if (inFlight === tracked) {
          inFlight = undefined;
        }
        if (inFlightController === controller) {
          inFlightController = undefined;
        }
      });
      inFlight = tracked;
    }

    await inFlight;
    return clone(snapshot);
  };

  const dispose = async (): Promise<void> => {
    if (!disposePromise) {
      closed = true;
      inFlightController?.abort();
      disposePromise = Promise.resolve().then(async () => {
        await adapter.dispose();
      });
    }
    await disposePromise;
  };

  return {
    getSnapshot,
    refreshDevices,
    dispose,
  };
}

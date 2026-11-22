import type { AdapterDevice, Capability } from '@phone-workbench/contracts';

export type ParsedConnectionState = AdapterDevice['state'];

export interface ParsedAdbDevice {
  readonly serial: string;
  readonly state: ParsedConnectionState;
  readonly model: string | undefined;
}

export type ParseDevicesResult =
  | { readonly ok: true; readonly devices: readonly ParsedAdbDevice[] }
  | { readonly ok: false; readonly reasonCode: string };

const HEADER = 'List of devices attached';
const DEVICE_STATES = new Map<string, ParsedConnectionState>([
  ['device', 'connected'],
  ['unauthorized', 'unauthorized'],
  ['offline', 'offline'],
]);

export const DEFAULT_DEVICE_CAPABILITIES: readonly Capability[] = Object.freeze([
  Object.freeze({
    operation: 'screen.stream',
    state: 'unknown',
    reasonCode: 'r1a_not_probed',
    scope: 'display',
    evidence: 'NOT_RUN',
  }),
  Object.freeze({
    operation: 'screen.capture',
    state: 'unknown',
    reasonCode: 'r1a_not_probed',
    scope: 'display',
    evidence: 'NOT_RUN',
  }),
  Object.freeze({
    operation: 'display.createVirtual',
    state: 'unsupported',
    reasonCode: 'r1a_not_implemented',
    scope: 'device',
    evidence: 'NOT_RUN',
  }),
  Object.freeze({
    operation: 'input.pointer',
    state: 'unsupported',
    reasonCode: 'r1a_read_only',
    scope: 'display',
    evidence: 'NOT_RUN',
  }),
  Object.freeze({
    operation: 'input.text',
    state: 'unsupported',
    reasonCode: 'r1a_read_only',
    scope: 'application',
    evidence: 'NOT_RUN',
  }),
]);

function normalizeLines(value: string): string[] {
  return value
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/u)
    .map((line) => line.trim());
}

function isIgnorableDaemonNotice(line: string): boolean {
  return (
    /^\* daemon not running; starting now at .+$/iu.test(line) ||
    /^\* daemon started successfully\b.*$/iu.test(line) ||
    /^adb server version \(\d+\) doesn't match this client \(\d+\); killing\.\.\.$/iu.test(
      line,
    )
  );
}

function parseDeviceLine(line: string): ParsedAdbDevice | string {
  const fields = line.split(/\s+/u);
  if (fields.length < 2) return 'malformed_device_line';

  const serial = fields[0];
  const rawState = fields[1];
  if (!serial || !rawState) return 'malformed_device_line';

  const state = DEVICE_STATES.get(rawState);
  if (!state) return 'unknown_device_state';

  let model: string | undefined;
  for (const detail of fields.slice(2)) {
    const separator = detail.indexOf(':');
    if (separator <= 0 || separator === detail.length - 1) return 'malformed_device_detail';
    const key = detail.slice(0, separator);
    const value = detail.slice(separator + 1);
    if (!/^[A-Za-z0-9_.-]+$/u.test(key)) return 'malformed_device_detail';
    if (key === 'model') model = value;
  }

  return { serial, state, model };
}

/** Parse only the documented shape emitted by `adb devices -l`. */
export function parseAdbDevices(stdout: string, stderr: string): ParseDevicesResult {
  const unexpectedStderr = normalizeLines(stderr).find(
    (line) => line.length > 0 && !isIgnorableDaemonNotice(line),
  );
  if (unexpectedStderr) return { ok: false, reasonCode: 'unexpected_adb_stderr' };

  let headerSeen = false;
  const devices: ParsedAdbDevice[] = [];
  const serials = new Set<string>();

  for (const line of normalizeLines(stdout)) {
    if (!line || isIgnorableDaemonNotice(line)) continue;

    if (line === HEADER) {
      if (headerSeen) return { ok: false, reasonCode: 'duplicate_adb_header' };
      headerSeen = true;
      continue;
    }

    if (!headerSeen) return { ok: false, reasonCode: 'missing_adb_header' };

    const parsed = parseDeviceLine(line);
    if (typeof parsed === 'string') return { ok: false, reasonCode: parsed };
    if (serials.has(parsed.serial)) return { ok: false, reasonCode: 'duplicate_device_entry' };
    serials.add(parsed.serial);
    devices.push(parsed);
  }

  if (!headerSeen) return { ok: false, reasonCode: 'missing_adb_header' };
  return { ok: true, devices };
}

export function cloneDefaultCapabilities(): Capability[] {
  return DEFAULT_DEVICE_CAPABILITIES.map((capability) => ({ ...capability }));
}

export function safeDeviceLabel(
  model: string | undefined,
  serial: string,
  adapterDeviceKey: string,
): string {
  if (model && !model.toLocaleLowerCase().includes(serial.toLocaleLowerCase())) {
    const normalized = model
      .replaceAll('_', ' ')
      .replace(/[^\p{L}\p{N} .()+-]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 64);
    if (normalized && !normalized.toLocaleLowerCase().includes(serial.toLocaleLowerCase())) {
      return normalized;
    }
  }
  return `Android 设备 ${adapterDeviceKey.slice(-6)}`;
}

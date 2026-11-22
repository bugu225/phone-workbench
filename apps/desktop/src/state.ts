import {
  DEMO_SCENARIOS,
  SCHEMA_VERSION,
  type Capability,
  type DemoScenario,
  type DesktopBridge,
  type DeviceRecord,
  type DomainError,
  type WorkspaceSnapshot,
} from '@phone-workbench/contracts';

export const DEMO_NOTICE = '示例数据，不会操作真实手机';

export type DesktopMode = Awaited<ReturnType<DesktopBridge['getMode']>>;

export interface DesktopViewModel {
  sourceLabel: string;
  banner: string;
  deviceLabel: string;
  connectionLabel: string;
  targetLabel: string;
  controlOwnerLabel: string;
  taskLabel: string;
  statusTitle: string;
  statusDescription: string;
  errorLabel: string | null;
  tone: 'neutral' | 'info' | 'warning' | 'danger';
  realActionsDisabled: true;
  showsSuccess: false;
  fallbackTarget: null;
}

export class DesktopStateError extends Error {
  readonly code: 'DEMO_MODE_REQUIRED' | 'INVALID_DEMO_SCENARIO';

  constructor(code: DesktopStateError['code'], message: string) {
    super(message);
    this.name = 'DesktopStateError';
    this.code = code;
  }
}

export interface DesktopStateController {
  getMode(): DesktopMode;
  getSnapshot(): WorkspaceSnapshot;
  setDemoScenario(scenario: unknown): WorkspaceSnapshot;
}

const capability = (
  operation: string,
  state: Capability['state'],
  reasonCode: string,
): Capability => ({
  operation,
  state,
  reasonCode,
  scope: 'display',
  evidence: 'STATIC_REVIEW',
});

const device = (
  state: DeviceRecord['connectionState'],
  observedAt: string,
  capabilities: Capability[] = [],
): DeviceRecord => ({
  deviceId: 'demo-device',
  label: '样例手机',
  connectionState: state,
  connectionGeneration: 1,
  stale: false,
  lastSeenAt: observedAt,
  capabilities,
});

const domainError = (
  code: DomainError['code'],
  reasonCode: string,
  message: string,
  retryPolicy: DomainError['retryPolicy'],
): DomainError => ({ code, reasonCode, message, retryPolicy });

const unconfiguredSnapshot = (observedAt: string): WorkspaceSnapshot => ({
  schemaVersion: SCHEMA_VERSION,
  runtimeId: 'desktop-unconfigured',
  revision: 0,
  sourceKind: 'NONE',
  discoveryStatus: 'not_configured',
  observedAt,
  lastSuccessfulDiscoveryAt: null,
  devices: [],
  controlOwner: 'none',
  activeSession: null,
  error: domainError(
    'ADAPTER_NOT_CONFIGURED',
    'CONTROL_SERVICE_NOT_CONNECTED',
    '尚未连接控制服务。',
    'after_refresh',
  ),
});

const demoSnapshot = (
  scenario: DemoScenario,
  observedAt: string,
  revision: number,
): WorkspaceSnapshot => {
  const base: WorkspaceSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    runtimeId: 'desktop-demo-runtime',
    revision,
    sourceKind: 'FIXTURE',
    discoveryStatus: 'ready',
    observedAt,
    lastSuccessfulDiscoveryAt: observedAt,
    devices: [],
    controlOwner: 'none',
    activeSession: null,
    error: null,
  };

  switch (scenario) {
    case 'empty':
      return base;
    case 'unauthorized':
      return { ...base, devices: [device('unauthorized', observedAt)] };
    case 'offline':
      return { ...base, devices: [device('offline', observedAt)] };
    case 'busy':
      return {
        ...base,
        devices: [
          device('connected', observedAt, [
            capability('display.virtual', 'supported', 'DEMO_SCENARIO_ONLY'),
          ]),
        ],
        controlOwner: 'agent',
      };
    case 'effect_unknown':
      return {
        ...base,
        devices: [device('connected', observedAt)],
        controlOwner: 'transitioning',
        error: domainError(
          'EFFECT_UNKNOWN',
          'DEMO_EFFECT_REQUIRES_RECONCILIATION',
          '动作结果未知，没有完成凭据；必须先核对状态且不会自动重试。',
          'reconcile_first',
        ),
      };
    case 'virtual_unavailable':
      return {
        ...base,
        devices: [
          device('connected', observedAt, [
            capability('display.virtual', 'unsupported', 'VIRTUAL_DISPLAY_UNAVAILABLE'),
          ]),
        ],
        error: domainError(
          'CAPABILITY_UNSUPPORTED',
          'VIRTUAL_DISPLAY_UNAVAILABLE',
          '应用副屏不可用，不会切换到手机主屏。',
          'never',
        ),
      };
  }
};

export const isDemoScenario = (value: unknown): value is DemoScenario =>
  typeof value === 'string' && (DEMO_SCENARIOS as readonly string[]).includes(value);

const cloneSnapshot = (snapshot: WorkspaceSnapshot): WorkspaceSnapshot => structuredClone(snapshot);

export const createDesktopStateController = (
  mode: DesktopMode,
  now: () => string = () => new Date().toISOString(),
): DesktopStateController => {
  let revision = mode === 'demo' ? 1 : 0;
  let snapshot = mode === 'demo'
    ? demoSnapshot('empty', now(), revision)
    : unconfiguredSnapshot(now());

  return {
    getMode: () => mode,
    getSnapshot: () => cloneSnapshot(snapshot),
    setDemoScenario: (scenario: unknown) => {
      if (mode !== 'demo') {
        throw new DesktopStateError(
          'DEMO_MODE_REQUIRED',
          '状态样例只能在 --demo 模式中切换。',
        );
      }
      if (!isDemoScenario(scenario)) {
        throw new DesktopStateError('INVALID_DEMO_SCENARIO', '未知的状态样例。');
      }

      revision += 1;
      snapshot = demoSnapshot(scenario, now(), revision);
      return cloneSnapshot(snapshot);
    },
  };
};

const findVirtualCapability = (snapshot: WorkspaceSnapshot): Capability | undefined =>
  snapshot.devices.flatMap((entry) => entry.capabilities)
    .find((entry) => entry.operation === 'display.virtual');

const connectionLabel = (snapshot: WorkspaceSnapshot, mode: DesktopMode): string => {
  const first = snapshot.devices[0];
  if (!first) {
    return mode === 'demo' ? '样例：没有设备' : '未连接';
  }

  if (first.connectionState === 'unauthorized') return '样例：等待授权';
  if (first.connectionState === 'offline') return '样例：离线';
  if (first.connectionState === 'connected') return '样例：在线（非真实连接）';
  return '状态未知';
};

const controlOwnerLabel = (owner: WorkspaceSnapshot['controlOwner']): string => {
  switch (owner) {
    case 'human': return '由我控制';
    case 'agent': return '智能体占用（样例）';
    case 'transitioning': return '正在确认控制状态（样例）';
    case 'none': return '没有活动控制';
  }
};

export const deriveDesktopView = (
  snapshot: WorkspaceSnapshot,
  mode: DesktopMode,
): DesktopViewModel => {
  const first = snapshot.devices[0];
  const virtual = findVirtualCapability(snapshot);
  const base = {
    sourceLabel: mode === 'demo' ? '示例数据' : '未配置',
    banner: mode === 'demo' ? DEMO_NOTICE : '尚未连接控制服务',
    deviceLabel: first?.label ?? '未选择设备',
    connectionLabel: connectionLabel(snapshot, mode),
    targetLabel: virtual?.state === 'unsupported'
      ? '应用副屏（不可用）'
      : snapshot.controlOwner === 'agent'
        ? '应用副屏（样例目标）'
        : '未建立显示目标',
    controlOwnerLabel: controlOwnerLabel(snapshot.controlOwner),
    taskLabel: '没有运行任务',
    statusTitle: '尚未连接控制服务',
    statusDescription: 'R1-A 只提供状态壳层；共享核心连接留到 R1-B。',
    errorLabel: snapshot.error?.message ?? null,
    tone: 'neutral' as const,
    realActionsDisabled: true as const,
    showsSuccess: false as const,
    fallbackTarget: null,
  };

  if (mode !== 'demo') return base;

  if (snapshot.error?.code === 'EFFECT_UNKNOWN') {
    return {
      ...base,
      taskLabel: '结果未知（样例）',
      statusTitle: '操作结果未知',
      statusDescription: '已停止后续步骤；没有完成凭据，必须先核对状态且不会自动重试。',
      tone: 'danger',
    };
  }

  if (virtual?.state === 'unsupported') {
    return {
      ...base,
      statusTitle: '应用副屏不可用',
      statusDescription: '样例目标保持为应用副屏，不会静默改到手机主屏。',
      tone: 'warning',
    };
  }

  if (first?.connectionState === 'unauthorized') {
    return {
      ...base,
      statusTitle: '等待手机授权（样例）',
      statusDescription: '这是界面样例，没有读取真实 USB 或授权状态。',
      tone: 'warning',
    };
  }

  if (first?.connectionState === 'offline') {
    return {
      ...base,
      statusTitle: '设备离线（样例）',
      statusDescription: '画面与输入均不可用；这里不会尝试重连真实设备。',
      tone: 'danger',
    };
  }

  if (snapshot.controlOwner === 'agent') {
    return {
      ...base,
      taskLabel: '智能体忙碌（样例）',
      statusTitle: '目标正由智能体使用（样例）',
      statusDescription: '本轮只展示忙碌状态，不实现暂停、接管或任何手机动作。',
      tone: 'info',
    };
  }

  return {
    ...base,
    statusTitle: '样例中没有设备',
    statusDescription: '这是固定空状态，不代表已经查询过真实设备。',
    tone: 'neutral',
  };
};

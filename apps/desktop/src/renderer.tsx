import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEMO_SCENARIOS, type DemoScenario, type WorkspaceSnapshot } from '@phone-workbench/contracts';
import { DEMO_NOTICE, deriveDesktopView, type DesktopMode } from './state.ts';

const NAV_ITEMS = [
  ['home', '首页'],
  ['screen', '手机画面'],
  ['apps', '应用'],
  ['files', '文件'],
  ['notifications', '通知'],
  ['tasks', '任务'],
  ['runs', '运行记录'],
] as const;

type SectionId = typeof NAV_ITEMS[number][0];

const SCENARIO_LABELS: Record<DemoScenario, string> = {
  empty: '无设备',
  unauthorized: '等待授权',
  offline: '离线',
  busy: '任务忙碌',
  effect_unknown: '结果未知',
  virtual_unavailable: '副屏不可用',
};

const DisabledActions = (): React.JSX.Element => (
  <div className="action-row" aria-label="真实操作（当前不可用）">
    <button type="button" data-real-action disabled>连接手机</button>
    <button type="button" data-real-action disabled>打开画面</button>
    <button type="button" data-real-action disabled>交给智能体</button>
    <button type="button" data-real-action disabled>暂停并接管</button>
  </div>
);

const EmptyPanel = ({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element => (
  <section className="empty-panel" aria-labelledby="page-empty-title">
    <span className="empty-kicker">R1-A 状态壳层</span>
    <h2 id="page-empty-title">{title}</h2>
    <p>{children}</p>
    <DisabledActions />
  </section>
);

const SectionContent = ({
  section,
  snapshot,
}: {
  section: SectionId;
  snapshot: WorkspaceSnapshot;
}): React.JSX.Element => {
  switch (section) {
    case 'home':
      return (
        <div className="dashboard-grid">
          <section className="summary-card" aria-labelledby="device-card-title">
            <span className="card-label">设备</span>
            <h2 id="device-card-title">{snapshot.devices[0]?.label ?? '未选择设备'}</h2>
            <p>本轮不查询真实 USB、ADB 或手机授权状态。</p>
          </section>
          <section className="summary-card" aria-labelledby="scope-card-title">
            <span className="card-label">本轮范围</span>
            <h2 id="scope-card-title">只读状态样例</h2>
            <p>不含投屏、输入、文件写入、通知回复或接管。</p>
          </section>
          <section className="summary-card wide" aria-labelledby="safety-card-title">
            <span className="card-label">安全边界</span>
            <h2 id="safety-card-title">真实动作全部禁用</h2>
            <p>桌面页面没有 shell、文件路径、ADB 或原始 IPC 能力。</p>
            <DisabledActions />
          </section>
        </div>
      );
    case 'screen':
      return (
        <section className="screen-workspace" aria-labelledby="screen-title">
          <div className="section-heading">
            <div>
              <span className="card-label">目标预览</span>
              <h2 id="screen-title">手机画面</h2>
            </div>
            <span className="readonly-chip">真实控制已禁用</span>
          </div>
          <div className="screen-placeholder" role="img" aria-label="没有真实手机画面的占位区域">
            <strong>R1-A 不含手机画面</strong>
            <span>此区域不会启动 ADB 或 scrcpy</span>
            <span className="watermark">{DEMO_NOTICE}</span>
          </div>
          <DisabledActions />
        </section>
      );
    case 'apps':
      return <EmptyPanel title="还没有可用的应用列表">应用读取与启动将在后续设备阶段验证。</EmptyPanel>;
    case 'files':
      return <EmptyPanel title="还没有授权的手机目录">本轮不读取或写入任何本机、手机文件。</EmptyPanel>;
    case 'notifications':
      return <EmptyPanel title="还没有通知数据">本轮不安装伴随应用，也不读取或回复通知。</EmptyPanel>;
    case 'tasks':
      return <EmptyPanel title="没有可执行任务">这里只展示状态词汇，不实现任务开始、暂停或接管。</EmptyPanel>;
    case 'runs':
      return <EmptyPanel title="没有真实运行记录">样例不含私人标识、消息、通知或设备序列号。</EmptyPanel>;
  }
};

const useLandmarkCycling = (): void => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'F6') return;
      const regions = Array.from(document.querySelectorAll<HTMLElement>('[data-focus-region]'));
      if (regions.length === 0) return;

      event.preventDefault();
      const current = regions.findIndex((region) => region === document.activeElement || region.contains(document.activeElement));
      const direction = event.shiftKey ? -1 : 1;
      const next = current < 0
        ? 0
        : (current + direction + regions.length) % regions.length;
      regions[next]?.focus();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
};

const App = (): React.JSX.Element => {
  const [mode, setMode] = useState<DesktopMode | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [section, setSection] = useState<SectionId>('home');
  const [scenario, setScenario] = useState<DemoScenario>('empty');
  const [loadError, setLoadError] = useState<string | null>(null);

  useLandmarkCycling();

  useEffect(() => {
    let active = true;
    void Promise.all([
      window.phoneWorkbench.getMode(),
      window.phoneWorkbench.getSnapshot(),
    ]).then(([nextMode, nextSnapshot]) => {
      if (!active) return;
      setMode(nextMode);
      setSnapshot(nextSnapshot);
    }).catch(() => {
      if (active) setLoadError('无法读取桌面状态。真实设备操作仍保持禁用。');
    });

    return () => {
      active = false;
    };
  }, []);

  const view = useMemo(
    () => snapshot && mode ? deriveDesktopView(snapshot, mode) : null,
    [snapshot, mode],
  );

  const selectScenario = async (nextScenario: DemoScenario): Promise<void> => {
    setLoadError(null);
    try {
      const nextSnapshot = await window.phoneWorkbench.setDemoScenario(nextScenario);
      setScenario(nextScenario);
      setSnapshot(nextSnapshot);
    } catch {
      setLoadError('无法切换状态样例。非演示模式或非法参数已被拒绝。');
    }
  };

  if (!mode || !snapshot || !view) {
    return (
      <main className="loading-state" aria-live="polite">
        <h1>安卓协同工作台</h1>
        <p>{loadError ?? '正在读取本地桌面状态…'}</p>
      </main>
    );
  }

  const activeLabel = NAV_ITEMS.find(([id]) => id === section)?.[1] ?? '首页';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主内容</a>

      <header className={`source-banner ${mode === 'demo' ? 'demo' : 'unconfigured'}`} aria-live="polite">
        <strong>{view.banner}</strong>
        <span>{mode === 'demo' ? '所有设备、任务和错误都是固定样例。' : '默认模式不会查询或伪造设备。'}</span>
      </header>

      <nav className="sidebar" aria-label="主导航" data-focus-region tabIndex={-1}>
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">工</span>
          <div>
            <strong>安卓协同工作台</strong>
            <span>Windows 状态壳层</span>
          </div>
        </div>
        <div className="nav-list">
          {NAV_ITEMS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={section === id ? 'active' : ''}
              aria-current={section === id ? 'page' : undefined}
              onClick={() => setSection(id)}
            >
              <span aria-hidden="true" className="nav-index">{String(NAV_ITEMS.findIndex(([itemId]) => itemId === id) + 1).padStart(2, '0')}</span>
              {label}
            </button>
          ))}
        </div>
        <div className="sidebar-note">
          <strong>R1-A</strong>
          <span>无手机功能</span>
        </div>
      </nav>

      <div className="workspace">
        <section className="target-bar" aria-label="当前设备与目标" data-focus-region tabIndex={-1}>
          <div className="target-item source">
            <span>数据来源</span>
            <strong>{view.sourceLabel}</strong>
          </div>
          <div className="target-item">
            <span>设备</span>
            <strong>{view.deviceLabel}</strong>
            <small>{view.connectionLabel}</small>
          </div>
          <div className="target-item">
            <span>目标</span>
            <strong>{view.targetLabel}</strong>
          </div>
          <div className="target-item">
            <span>控制状态</span>
            <strong>{view.controlOwnerLabel}</strong>
          </div>
        </section>

        {mode === 'demo' && (
          <section className="scenario-strip" aria-labelledby="scenario-title">
            <div>
              <strong id="scenario-title">状态样例</strong>
              <span>仅切换本地固定数据</span>
            </div>
            <label>
              <span className="sr-only">选择状态样例</span>
              <select value={scenario} onChange={(event) => void selectScenario(event.target.value as DemoScenario)}>
                {DEMO_SCENARIOS.map((item) => (
                  <option key={item} value={item}>{SCENARIO_LABELS[item]}</option>
                ))}
              </select>
            </label>
          </section>
        )}

        <div className="content-grid">
          <main id="main-content" className="main-content" data-focus-region tabIndex={-1}>
            <div className="page-heading">
              <div>
                <span className="eyebrow">{view.sourceLabel}</span>
                <h1>{activeLabel}</h1>
              </div>
              <span className={`status-pill ${view.tone}`}>{view.statusTitle}</span>
            </div>

            {(loadError || view.errorLabel) && (
              <div className="error-callout" role="alert">
                <strong>需要注意</strong>
                <span>{loadError ?? view.errorLabel}</span>
              </div>
            )}

            <SectionContent section={section} snapshot={snapshot} />
          </main>

          <aside className="activity-panel" aria-labelledby="activity-title" data-focus-region tabIndex={-1}>
            <div className="activity-header">
              <span className="eyebrow">任务状态</span>
              <h2 id="activity-title">{view.taskLabel}</h2>
            </div>
            <div className={`status-card ${view.tone}`}>
              <strong>{view.statusTitle}</strong>
              <p>{view.statusDescription}</p>
            </div>
            <dl className="status-details">
              <div><dt>来源</dt><dd>{view.sourceLabel}</dd></div>
              <div><dt>设备状态</dt><dd>{view.connectionLabel}</dd></div>
              <div><dt>目标</dt><dd>{view.targetLabel}</dd></div>
              <div><dt>修订号</dt><dd>{snapshot.revision}</dd></div>
            </dl>
            <button type="button" className="takeover-button" data-real-action disabled>
              暂停并接管（未实现）
            </button>
            <p className="panel-footnote">F6 可在导航、目标、内容和任务状态之间切换焦点。</p>
          </aside>
        </div>
      </div>
    </div>
  );
};

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element.');
createRoot(root).render(<App />);

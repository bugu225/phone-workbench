import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_SCENARIOS } from '@phone-workbench/contracts';
import {
  DEMO_NOTICE,
  DesktopStateError,
  createDesktopStateController,
  deriveDesktopView,
} from '../src/state.ts';

const fixedNow = () => '2026-11-09T08:00:00.000Z';

test('默认模式明确显示未配置来源，不伪造真实空设备', () => {
  const controller = createDesktopStateController('unconfigured', fixedNow);
  const snapshot = controller.getSnapshot();
  const view = deriveDesktopView(snapshot, controller.getMode());

  assert.equal(snapshot.sourceKind, 'NONE');
  assert.equal(snapshot.discoveryStatus, 'not_configured');
  assert.equal(snapshot.devices.length, 0);
  assert.equal(view.sourceLabel, '未配置');
  assert.equal(view.banner, '尚未连接控制服务');
  assert.match(view.statusDescription, /R1-B/);
});

test('六类演示场景始终带示例来源标签，真实动作始终禁用', () => {
  const controller = createDesktopStateController('demo', fixedNow);

  for (const scenario of DEMO_SCENARIOS) {
    const snapshot = controller.setDemoScenario(scenario);
    const view = deriveDesktopView(snapshot, controller.getMode());
    assert.equal(snapshot.sourceKind, 'FIXTURE');
    assert.equal(view.sourceLabel, '示例数据');
    assert.equal(view.banner, DEMO_NOTICE);
    assert.equal(view.realActionsDisabled, true);
    assert.equal(view.showsSuccess, false);
  }
});

test('结果未知场景不显示成功或已完成', () => {
  const controller = createDesktopStateController('demo', fixedNow);
  const snapshot = controller.setDemoScenario('effect_unknown');
  const view = deriveDesktopView(snapshot, controller.getMode());

  assert.equal(snapshot.error?.code, 'EFFECT_UNKNOWN');
  assert.equal(view.statusTitle, '操作结果未知');
  assert.equal(view.showsSuccess, false);
  assert.doesNotMatch(`${view.statusTitle} ${view.statusDescription} ${view.taskLabel}`, /成功|已完成/);
  assert.match(view.statusDescription, /没有完成凭据|先核对/);
});

test('副屏不可用保持原目标，不静默切换主屏', () => {
  const controller = createDesktopStateController('demo', fixedNow);
  const snapshot = controller.setDemoScenario('virtual_unavailable');
  const view = deriveDesktopView(snapshot, controller.getMode());

  assert.equal(view.targetLabel, '应用副屏（不可用）');
  assert.equal(view.fallbackTarget, null);
  assert.match(view.statusDescription, /不会静默改到手机主屏/);
});

test('非演示模式拒绝场景切换，演示模式拒绝非法参数', () => {
  const regular = createDesktopStateController('unconfigured', fixedNow);
  assert.throws(
    () => regular.setDemoScenario('empty'),
    (error: unknown) => error instanceof DesktopStateError && error.code === 'DEMO_MODE_REQUIRED',
  );

  const demo = createDesktopStateController('demo', fixedNow);
  assert.throws(
    () => demo.setDemoScenario('not-a-scenario'),
    (error: unknown) => error instanceof DesktopStateError && error.code === 'INVALID_DEMO_SCENARIO',
  );
});

test('返回的快照是副本，页面修改不能污染桌面状态', () => {
  const controller = createDesktopStateController('demo', fixedNow);
  const first = controller.setDemoScenario('unauthorized');
  first.devices[0]!.label = '被页面修改';

  const second = controller.getSnapshot();
  assert.equal(second.devices[0]?.label, '样例手机');
});

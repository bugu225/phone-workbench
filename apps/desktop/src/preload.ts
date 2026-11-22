import { contextBridge, ipcRenderer } from 'electron';
import type { DemoScenario, DesktopBridge } from '@phone-workbench/contracts';

const bridge: DesktopBridge = Object.freeze({
  getSnapshot: () => ipcRenderer.invoke('phone-workbench:get-snapshot'),
  getMode: () => ipcRenderer.invoke('phone-workbench:get-mode'),
  setDemoScenario: (scenario: DemoScenario) => ipcRenderer.invoke('phone-workbench:set-demo-scenario', scenario),
});

contextBridge.exposeInMainWorld('phoneWorkbench', bridge);

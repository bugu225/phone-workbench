import { app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDesktopStateController } from './state.ts';

const CHANNELS = {
  getSnapshot: 'phone-workbench:get-snapshot',
  getMode: 'phone-workbench:get-mode',
  setDemoScenario: 'phone-workbench:set-demo-scenario',
} as const;

const demoMode = process.argv.includes('--demo');
const state = createDesktopStateController(demoMode ? 'demo' : 'unconfigured');
const rendererFile = join(__dirname, 'index.html');
const trustedRendererUrl = pathToFileURL(rendererFile).toString();

let mainWindow: BrowserWindow | null = null;

const isTrustedRendererUrl = (value: string): boolean => {
  try {
    const candidate = new URL(value);
    candidate.hash = '';
    return candidate.toString() === trustedRendererUrl;
  } catch {
    return false;
  }
};

const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
  if (!mainWindow || event.sender !== mainWindow.webContents || !isTrustedRendererUrl(senderUrl)) {
    const error = new Error('拒绝来自非工作台页面的请求。') as Error & { code: string };
    error.code = 'UNTRUSTED_IPC_SENDER';
    throw error;
  }
};

const registerIpc = (): void => {
  ipcMain.handle(CHANNELS.getMode, (event) => {
    assertTrustedSender(event);
    return state.getMode();
  });

  ipcMain.handle(CHANNELS.getSnapshot, (event) => {
    assertTrustedSender(event);
    return state.getSnapshot();
  });

  ipcMain.handle(CHANNELS.setDemoScenario, (event, scenario: unknown) => {
    assertTrustedSender(event);
    return state.setDemoScenario(scenario);
  });
};

const createWindow = async (): Promise<void> => {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f3f6fb',
    title: demoMode ? '安卓协同工作台 · 示例' : '安卓协同工作台',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow = window;

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== trustedRendererUrl) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  await window.loadFile(rendererFile);
};

registerIpc();

void app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

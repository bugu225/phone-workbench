import type { DesktopBridge } from '@phone-workbench/contracts';

declare global {
  interface Window {
    phoneWorkbench: DesktopBridge;
  }
}

export {};

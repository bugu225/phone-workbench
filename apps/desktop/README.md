# Windows 桌面状态壳层（R1-A）

本模块是 Electron + React + TypeScript 的只读状态壳层。它不连接核心、MCP、ADB、scrcpy 或手机，也不提供投屏、输入、文件写入、通知回复和接管。

## 模式

- 默认启动：显示“尚未连接控制服务”，`sourceKind=NONE`，不查询设备。
- `--demo`：允许切换 `empty`、`unauthorized`、`offline`、`busy`、`effect_unknown`、`virtual_unavailable` 六类固定样例；全程显示“示例数据，不会操作真实手机”。

## 命令

在仓库根目录运行：

```powershell
npm run build:desktop
npm run test --workspace @phone-workbench/desktop
npm run start:desktop
npm run start --workspace @phone-workbench/desktop -- --demo
```

首次运行请在仓库根目录执行 `npm ci`，依赖版本由根锁文件固定。

## 安全边界

- `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`。
- 预加载只暴露冻结合同中的 `getSnapshot`、`getMode`、`setDemoScenario`。
- 非 `--demo` 模式拒绝样例切换；非法样例参数和非工作台 IPC sender 被拒绝。
- 禁止页面导航、新窗口、webview 和权限请求；CSP 不允许外部连接。
- 页面没有 shell、任意文件路径、ADB、scrcpy 或原始 IPC 能力。

R1-B 才会设计同一核心进程客户端。当前样例和桌面启动结果都不代表真实手机能力通过。

# @phone-workbench/device-bridge

R1-A 的只读 Android 设备发现适配器。当前只允许固定调用 `adb devices -l`，不提供 shell、投屏、display、输入、文件或 APK 能力。

## 安全默认值

- `allowDeviceAccess` 默认 `false`；`discover()` 返回 `not_configured`，不会调用 runner 或启动进程。
- 本轮测试全部使用注入的 `AdbCommandRunner`，结果自动标记为 `SIMULATED`。
- 生产候选 runner 仅以 `shell:false` 参数化启动给定 `adbPath`，命令固定为 `devices -l`，并有 5 秒超时、256 KiB 合计输出限制和取消信号。
- 不执行 `kill-server`，不清理或接管其他程序的 ADB 进程。

## 身份与隐私

- ADB serial 只在适配器闭包内用于本次解析和内部映射。
- 对外 `adapterDeviceKey` 使用 `HMAC-SHA256(identitySalt, serial)` 派生；salt、serial、原始 stdout/stderr 和用户工具路径均不进入返回值或日志。
- 同一 salt 产生稳定键，不同 salt 彼此隔离。salt 应由本机私密配置提供，不能提交到仓库。
- 设备标签只使用经过限制的 model；不可安全使用时显示基于不透明键的通用标签。

## 发现语义

- 只有带 `List of devices attached` 头部且全部设备行可解析的零退出码响应才返回 `ready`。
- `ready + devices: []` 只表示这次模拟/真实查询确实成功且为空。
- 空输出、缺头部、畸形行、未知设备状态、异常 stderr、非零退出码和超限输出都返回明确错误，不能通过丢弃行制造空列表。
- 支持 `device`、`unauthorized`、`offline`；其他状态在 R1-A 中保守失败。
- 投屏能力保持 `unknown`，输入和虚拟显示保持 `unsupported`，证据均为 `NOT_RUN`。

## 使用

```ts
import { createAdbDeviceAdapter } from '@phone-workbench/device-bridge';

const adapter = createAdbDeviceAdapter({
  adbPath: 'configured-absolute-path',
  identitySalt: 'read-from-private-local-storage',
});

// 默认不会运行 ADB。
const discovery = await adapter.discover();
```

当前验证使用模拟 runner，尚无真实设备验收结论。真实连接与外部只读投屏属于后续阶段。

## 测试

在工作区根目录执行：

```text
npm test --workspace @phone-workbench/device-bridge
```

测试覆盖默认零进程调用、多设备、未授权/离线、确认空列表、畸形/未知状态、退出错误脱敏、输出限制、超时、取消、dispose、标识稳定与盐隔离。所有设备数据均为固定模拟值。

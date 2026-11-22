# 开发说明

## 环境与命令

主要开发目标为 Windows 11；使用 Node.js 24.x 与 npm workspaces。依赖版本由 `package-lock.json` 固定。

在仓库根目录执行：

```powershell
npm ci
npm run check:workspace
npm run typecheck
npm run test:modules
npm run test:acceptance
npm run build:desktop
npm run start:desktop -- --demo
```

`check:workspace` 只检查公开源码和文档结构，不依赖本机路径、内部协作记录或仓库外资料。模块测试和独立验收使用合成数据，不查询真实手机。构建产物在 `apps/desktop/dist`。

当前锁文件保留初始安装所用的 `registry.npmmirror.com` tarball 地址及完整性校验值。`npm ci` 会使用这些地址；当前 Electron 包在首次启动时按需下载运行时。修改包源或依赖后应重新验证干净安装，不能只修改文档。

## MCP 服务

当前工具只有：

| 工具 | 功能 |
| --- | --- |
| `workbench_get_status` | 读取状态快照，不触发设备发现 |
| `workbench_refresh_devices` | 通过配置的只读适配器刷新设备 |

开发时可用 `npm run start --workspace @phone-workbench/mcp-server` 启动。MCP 客户端需要将标准输出完全留给协议；直接启动 Node/tsx 更适合接入客户端：

```json
{
  "mcpServers": {
    "phone-workbench": {
      "command": "node",
      "args": [
        "C:/path/to/phone-workbench/node_modules/tsx/dist/cli.mjs",
        "C:/path/to/phone-workbench/packages/mcp-server/src/stdio.ts"
      ]
    }
  }
}
```

将示例路径替换为克隆后的绝对路径；客户端配置格式可能不同。默认入口没有配置 ADB 或设备，刷新不会启动真实设备查询。桌面与该服务尚未共享运行中的核心。

## 测试与证据

当前模块测试共 36 项，独立验收共 12 项，覆盖状态合并、取消、错误与标识脱敏、MCP 输出以及桌面演示边界。独立验收同时输出源码哈希记录，便于关联一次检查和对应代码。

发布检查中的类型检查、模块测试、独立验收和桌面构建均不涉及手机。CI 也只验证这些条件。未来真机记录需注明机型、系统版本、应用版本及实际操作结果。

## 依赖与发布

根目录及工作区包的 `private: true` 用于防止误发布到 npm，不影响 GitHub 上的 MIT 开源许可。

目前仅发布源码，没有可直接安装的稳定桌面软件。后续打包 Electron、ADB、scrcpy 或安卓伴随组件前，应整理所分发组件及其第三方声明，并进行对应平台验收。

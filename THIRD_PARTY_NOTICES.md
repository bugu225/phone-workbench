# 第三方组件说明

Phone Workbench 的原创代码采用 MIT 许可证。以下是当前直接使用的主要依赖；这些组件保留各自的许可，完整声明请以安装包中的 LICENSE/NOTICE 为准。

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| Electron | MIT | 桌面运行时 |
| React / React DOM | MIT | 界面 |
| Model Context Protocol TypeScript SDK | MIT | MCP 服务 |
| Zod | MIT | 输入/输出校验 |
| TypeScript | Apache-2.0 | 类型检查 |
| tsx | MIT | TypeScript 开发与测试执行 |
| esbuild | MIT | 桌面构建 |
| @types/node、@types/react、@types/react-dom | MIT | 类型声明 |

具体版本与传递依赖见 `package-lock.json`。本表是直接依赖索引，不是完整的二进制发行声明；Electron 内含组件及其他传递依赖可能采用不同许可。

本次发布仅包含项目源码和明确标注的演示截图，不包含 `node_modules`、Electron 安装包、ADB/scrcpy 可执行文件、Android DEX 私有二进制或反编译代码。未来分发外部组件时，应单独满足其许可证及声明要求。

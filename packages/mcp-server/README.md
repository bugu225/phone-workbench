# MCP server

R1-A exposes exactly two read-only tools through the locked MCP SDK 1.32.2:

- workbench_get_status reads the current CoreService snapshot without discovery.
- workbench_refresh_devices runs the configured read-only adapter through the same CoreService.

Both tools have strict empty input schemas, structured snapshot output, and readOnlyHint=true. No input, shell, file, session, lease, notification, ADB, or scrcpy tool exists in this module.

The stdio entry creates the default unconfigured core. It writes no application logs to stdout; stdout is reserved for MCP protocol traffic. Shared GUI/MCP daemon integration remains an R1-B task.

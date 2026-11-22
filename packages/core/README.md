# Core service

R1-A implements the frozen read-only CoreService contract.

- getSnapshot returns a deep copy and never starts discovery.
- refreshDevices coalesces concurrent calls and advances one revision per completed discovery.
- Public device IDs and connection generations are owned by the core.
- Failed discovery preserves known devices as unknown and stale.
- dispose aborts in-flight discovery, is idempotent, and prevents late results from changing history.

This module has no input, session, lease, file, notification, ADB, or scrcpy execution surface in R1-A. Device behavior is supplied only through the frozen DeviceAdapter port.

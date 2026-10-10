# 0.1.3

- Added a saved chat-provider selector and Open ChatGPT to the popup; all eight adapters share one bridge.
- Added a ChatGPT guide and checks for provider selection and ChatGPT-to-local-tool parsing.
- Updated ChatGPT's prompt for general local tasks.
- Fixed SQLite connection handles remaining open after transactions, which caused Windows cleanup failures.
- Added repository branding, examples, contribution forms and Linux/Windows CI.

# 0.1.2

- Renamed the app, bridge, prompt, runtime state folders and distribution to FreeAgent.

# 0.1.1

- Added Always allow this tool to approval dialogs, persisted per exact tool, paired bridge, port and workspace.
- Added Settings → Reset saved tool approvals, with concurrent-tab-safe storage and connection checks.
- Added regression tests for saved permissions, approval dialogs, reset and storage failures.

# 0.1.0

- Converted ZeroScript's Roblox-specific agent into FreeAgent for general local tasks.
- Added 23 local tools for files, terminal/Python, web, desktop, memory, tasks and Markdown workflows.
- Added token pairing, request approvals, argument checks and per-tab cancellation.
- Added recoverable file deletion, write backups and workspace path confinement for file tools.
- Replaced the command parser with explicit JSON envelopes and raw Python/shell blocks.
- Added command-format retry limits, preserved MCP errors and namespaced addon tools.
- Replaced the Studio controls and setup with a general panel, pairing popup and virtual-environment launchers.
- Added regression/integration tests and retained upstream GPL attribution.

Live provider and desktop behavior still requires validation on the target user's environment.

# FreeAgent

A general local PC agent driven by a normal browser AI chat. Describe a task; the extension reads the AI's marked commands, the local bridge executes them, and tool results return to the same conversation.

Derived from **ZeroScript Free 1.5.5 by sebattfg**. The eight provider adapters and the chat/session engine are retained and adapted. Roblox Studio is no longer required. This is an independent derivative project, not affiliated with OpenClaw, Hermes, Roblox, or any AI provider.

## Quick start — Windows

1. Extract the ZIP into its own folder. Install Python 3.10 or newer if you do not have it.
2. Double-click `start.bat`. It creates a local virtual environment and installs the bridge dependency. Keep its terminal open.
3. Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, click **Load unpacked**, and select this project's `extension` folder.
4. Click the extension icon. Copy the **pairing token** printed in the bridge terminal into the popup, then click **Pair / save connection**.
5. Open an empty conversation on a supported AI site. Click **Start agent** in the FreeAgent panel. Once it is ready, give it a task.

The default workspace is the `workspace` folder beside the bridge. To choose another folder, either set `workspace` in `config.json` or run:

```bat
start.bat --workspace "C:\Users\YourName\Documents\AgentWork"
```

For another bridge port use `--port 17614` and enter the same port in the extension popup. A running process is never killed simply because it owns a port.

## macOS and Linux

```sh
chmod +x start.sh
./start.sh --workspace "$HOME/AgentWork"
```

On macOS you can also launch `MacOS_Start.command`. Python must support virtual environments. Chrome/Edge is required for the extension. File and terminal tools support macOS/Linux; graphical desktop tools depend on your OS session and permissions.

## What it can do

| Capability | Tools |
| --- | --- |
| Inspect and edit projects | `list_directory`, `read_file`, `write_file`, `edit_file`, `search_files` |
| Recoverable deletion | `delete_path` moves the exact target to local trash |
| Execute commands | `run_shell` (PowerShell on Windows, sh elsewhere), `run_python` |
| Public web pages | `fetch_url`, `open_url` |
| Persistent project notes | `memory_get`, `memory_set`, `memory_delete` |
| Task tracking | `task_create`, `task_update`, `task_list` |
| Markdown workflows | `skill_list`, `skill_read` |
| Optional desktop control | `screen_capture`, `mouse_click`, `type_text`, `press_keys` |
| Other applications | Additional stdio MCP servers from `config.json` |

**Example task:** “Create a small Python expense tracker in this workspace. Add CSV import, write useful tests, run them, and remember the project structure.”

**Another task:** “Inspect this folder and create a Markdown index of its documents. Do not rename or delete anything.”

Built-in file tools stay inside the selected workspace. Replaced text files get backups in `.freeagent/backups`. Removed targets go to `.freeagent/trash`; restore them manually by moving them back. Backups and trash are retained until you remove them yourself. Memory and task notes are stored in `.freeagent/state.sqlite3` in the workspace, so they survive new browser chats and bridge restarts.

## Optional desktop tools

Run `install-desktop.bat` on Windows or `./install-desktop.sh` on macOS/Linux after the first bridge setup. Restart the bridge. macOS may require Screen Recording and Accessibility permissions. Linux needs a graphical environment supported by PyAutoGUI; Wayland and headless sessions may not support these functions.

Desktop captures are sent to the chat provider after approval. A screenshot can be resized; the tool result includes original display dimensions and coordinate scale factors. Mouse clicks use original primary-screen pixels. PyAutoGUI's corner failsafe remains enabled. Supply the optional `x` and `y` focus point to `type_text` or `press_keys` to focus the intended app after approval. Without a focus point, keyboard actions act on whichever application is focused, which may still be the chat browser.

ChatGPT's inherited adapter disables image uploads; use text tools there. DeepSeek and other vision-capable providers can attach screenshots subject to their current upload limits.

## Approvals and stopping

Pair once using the bridge's secret token. Only authenticated loopback connections can request tools; ordinary website WebSocket origins are rejected.

Before **shell/Python execution, deletion, web requests, browser opening, desktop interaction, or an addon MCP call**, the extension displays the exact operation for **Approve once**, **Always allow this tool**, or **Deny**. Always allow saves permission for that exact tool (including its MCP namespace), with any arguments, on the same paired bridge, port and workspace. It persists across chats, browser restarts and extension reloads. A different workspace or pairing requires a new choice. Open the in-chat **Settings → Reset saved tool approvals** to clear all remembered permissions; the next protected call asks again. Approve once never saves permission, and Deny ends that agent run. File edits inside the workspace do not prompt individually, so select a folder you intend the agent to modify.

**Shell and Python have your normal OS privileges. The working folder is not a sandbox.** They can access paths beyond the workspace. Review approved code accordingly. The pairing token is a local authority credential; do not share it, your runtime state, or screenshots of the terminal containing it. Token files are generated at startup and excluded from source packages.

**Stop** requests cancellation. Local running shell/Python process trees are terminated, but already-completed changes are not undone. File operations already committed remain. MCP cancellation is best effort: a third-party server controls whether it can interrupt its operation. Disconnecting the browser socket also requests cancellation.

## Additional MCP servers

Edit `config.json` locally, then restart the bridge. Example:

```json
{
  "workspace": "C:/Users/YourName/Documents/AgentWork",
  "mcpServers": {
    "my_app": {
      "command": "python",
      "args": ["C:/path/to/your_mcp_server.py"],
      "env": {}
    }
  }
}
```

Servers must support stdio MCP. Tools are namespaced as `my_app/tool_name`, preventing collisions. All addon calls require approval because the bridge cannot confine an external server's permissions. The AI can discover servers with `list_mcp_servers` and their tools with `list_commands` using a `server` parameter. Server configuration cannot be changed by an AI tool call.

## Supported chats and practical limits

Adapters are included for DeepSeek, ChatGPT, Gemini, Kimi, GLM/Z.ai, Qwen, Arena (Direct mode) and Meta AI. They interact with each site's normal signed-in chat; no model API key is needed. Model/service quotas, account requirements, provider rules and paid tiers still apply. Website UI changes can break an adapter.

The browser tab must remain visible. Another native app can be focused while the chat tab remains visible, but switching to another browser tab or minimizing the window pauses the chat loop. The extension stays in the same conversation for subsequent commands. Fresh chats require a new Start; workspace memory persists.

This version is a **local task agent**, with files, execution, memory, tasks, skills and optional desktop/MCP integrations. It does not include messaging-channel integrations, unattended scheduling, voice, subagents or an OpenAI-compatible provider endpoint for OpenCode. Recorded tasks do not automatically run in the background. Large results are bounded and show truncation flags; the AI should request chunks rather than assume omitted contents.

## Contributor checks

From the project folder:

```sh
python -m unittest discover -s tests -v
node extension/test-parser.js
node extension/test-chatgpt.js
node extension/test-worker.js
node extension/test-loop.js
```

Tests cover workspace confinement, backup/trash behavior, persistence, cancellation, authentication, approvals, stdio MCP error propagation, command envelopes, provider reply reading, worker routing and loop failure limits. Live AI website sessions and actual mouse/keyboard permissions still require manual testing on the user's desktop. No private browser credentials are included.

## Attribution and license

GPL-3.0-or-later; see `LICENSE` and `NOTICE.md`. Original project: https://github.com/sebattfg/ZeroScript-Free. FreeAgent replaces the Roblox backend, prompt, parser, transport setup and controls with general local-agent components while retaining adapted upstream chat-provider and session code.

# Use ChatGPT with the FreeAgent bridge

ChatGPT uses the same local bridge and tools as DeepSeek. You do not need a second bridge or a model API key. Your ChatGPT account's normal limits and rules still apply.

## First setup

1. Download FreeAgent and extract it, then run `start.bat` on Windows or `sh start.sh` on macOS/Linux. Leave the terminal open.
2. Load the project's `extension/` folder in Chrome or Edge using **Developer mode → Load unpacked**.
3. Click the extension icon, paste the bridge's pairing token, and select **Pair / save connection**. Wait for **Connected**.
4. Set **AI chat provider → ChatGPT**, then click **Open ChatGPT**. Sign in on the normal ChatGPT site if needed.
5. Open a new conversation, choose your model using ChatGPT's normal controls, and click **Start agent** in FreeAgent's panel.
6. Once initialization finishes, describe your task. Keep the chat tab visible.

The popup remembers your provider. Switching from DeepSeek to ChatGPT preserves the bridge pairing and workspace. Saved approvals remain scoped to the exact tool, pairing, port and workspace; they are shared across supported chats using that same connection.

## A small first task

```text
Create hello.py in this workspace containing:
print("Hello from ChatGPT")
Then run it with the local run_python tool and show the output.
```

Approve execution when prompted. You should see the file in the bridge workspace and its output returned to the same chat. This is an example prompt, not a recorded live test.

## Updating an existing installation

Replace the project with the new download, preserving any workspace files you want to keep. Stop the old bridge, start the updated bridge, and click **Reload** on FreeAgent's card in the extensions page. Refresh the ChatGPT tab. Re-pair if the new bridge has a different token.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Popup says Bridge offline | Start the local bridge and confirm the popup port matches its terminal. |
| Pairing fails | Copy the current token locally; do not post it in an issue or chat. |
| No FreeAgent panel on ChatGPT | Load the current extension, reload its card, refresh the page and start a new conversation. |
| Agent pauses | Keep ChatGPT's tab visible and its browser window open. |
| Message will not send | Wait for the current reply, check ChatGPT's displayed quota/error, then refresh if its composer is stuck. |
| File is not where expected | Check the workspace shown in the popup. ChatGPT's hosted code environment cannot see local files; FreeAgent tools can. |

Files, terminal/Python, memory, tasks, skills and text MCP results are available. Screenshot upload is disabled in the included ChatGPT adapter, so desktop vision tasks need another compatible provider. Automated fixtures validate command reading and routing; live ChatGPT layouts still require manual checks. See [TESTING.md](../TESTING.md) and the [full guide](GUIDE.md).

# Contributing to FreeAgent

Useful contributions include adapter fixes, Windows/macOS installation checks, example tasks, Markdown skills and clearer error messages.

## Run the checks

Use Python 3.10+ and Node.js 22+. Install `requirements.txt` in a virtual environment, then run `sh run-tests.sh` on macOS/Linux or `run-tests.bat` on Windows. GitHub Actions runs the suite on Linux and Windows with Python 3.12 and Node.js 22.

See [TESTING.md](TESTING.md) for automated coverage and manual checks. Simulated tests alone do not prove that a live provider works.

## Make a focused change

1. Open an issue for substantial features so the behavior can be discussed.
2. Fork the repository and create a branch for your change.
3. Keep the change focused, with regression checks for behavior that could break.
4. Describe the problem, the resulting behavior and how you verified it in your pull request.

Provider adapters live in `extension/providers/`; the shared agent loop and parser are in `extension/core/`. Connection routing and remembered approvals live in `extension/background.js`. Local capabilities live in `local_tools.py`, authenticated transport in `bridge.py`, and stdio integrations in `mcp_client.py`.

Do not commit pairing tokens, browser sessions, personal workspace files or runtime state. Preserve GPL notices and upstream attribution. Contributions are distributed under GPL-3.0-or-later.

# Security and responsible reports

FreeAgent executes code with your user account's privileges. Pair only with a bridge you control, review protected actions, and grant persistent tool approvals deliberately. The selected workspace confines built-in file tools; it does not sandbox shell, Python or external MCP servers.

Pairing tokens, local state, command logs and screenshots can contain secrets. Never attach them to public issues. Remove private paths and content from reproductions.

For a potential vulnerability, use GitHub's **Report a vulnerability** option in the Security tab if available. If a private channel is unavailable, open an issue requesting private contact without publishing exploit details or confidential data. Ordinary installation and adapter bugs can use the bug report template.

This early release has automated transport and approval checks but has not had an independent security audit. See [TESTING.md](TESTING.md) for validation scope.

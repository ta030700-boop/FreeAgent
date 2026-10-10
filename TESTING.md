# Validation for 0.1.2

Automated validation was run in a Linux environment with Python 3.12.14 and websockets 16.0. Node ran the browser-independent JavaScript fixtures.

- 19 Python tests: workspace paths including symlinks; file backup/edit/search/trash; persisted memory/tasks; Python output/exit/timeout/cancellation; skill loading and arguments; desktop focus validation and missing dependency error; authenticated loopback WebSocket workflows, rejection of invalid credentials/website origins, approval checks, cancellation with responsive pings; stdio MCP error propagation.
- 19 command-protocol tests: explicit envelopes, raw code, quote handling, inert unmarked examples, multiple commands, incomplete/malformed replies, invalid params and markers inside JSON data.
- 8 inherited ChatGPT document-reading tests.
- 10 service-worker tests for handshake readiness, catalogue routing, per-tab cancellation, protected pairing, exact tool grants, workspace/pairing/port isolation, concurrent updates, persistence after worker restart and reset.
- 6 approval-dialog tests for approve once, saving always allow, skipping remembered tools, denial, storage failure and Stop taking priority.
- 3 actual shared-loop tests for repeated malformed replies, repeated multiple-command replies and approval denial.

The Python tests use real local WebSocket and subprocess transports, with temporary directories and a deterministic stdio MCP fixture. The JavaScript tests use simulated browser/provider interfaces; they do not establish live website sessions.

Manual validation still needed: Windows PowerShell and macOS launchers; each provider's current chat layout; screenshot upload; real mouse/keyboard control and OS permissions; third-party MCP servers. Scheduled background jobs, channel integrations and OpenCode-compatible provider endpoints are not implemented in this release.

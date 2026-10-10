"""Deterministic stdio MCP fixture used only by tests."""
import json
import sys
for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg: continue
    method = msg["method"]
    if method == "initialize": result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "test", "version": "1"}}
    elif method == "tools/list": result = {"tools": [{"name": "fail", "description": "An error", "inputSchema": {"type": "object", "properties": {}}}, {"name": "echo", "description": "Echo", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}}]}
    else:
        fail = msg["params"]["name"] == "fail"
        result = {"isError": fail, "content": [{"type": "text", "text": "Permission denied" if fail else msg["params"]["arguments"].get("text", "ok")} ]}
    print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}), flush=True)

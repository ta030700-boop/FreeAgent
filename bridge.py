# SPDX-License-Identifier: GPL-3.0-or-later
"""Authenticated loopback bridge for the FreeAgent browser extension."""
from __future__ import annotations
import argparse
import asyncio
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time

import websockets

from local_tools import CATALOGUE, TOOLS, LocalTools, validate_arguments
from mcp_client import MCPClient

HERE = Path(__file__).resolve().parent
VERSION = "0.1.3"


class Bridge:
    def __init__(self, workspace, token, config=None):
        self.local = LocalTools(workspace)
        self.token = token
        self.connections = set()
        self.active = {}
        self.addons = {}
        self.background = set()
        for sid, spec in (config or {}).get("mcpServers", {}).items():
            if sid == "local" or not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", sid):
                raise ValueError("MCP server names must be simple IDs and cannot be 'local'")
            self.addons[sid] = MCPClient(sid, spec, HERE)

    def catalogue(self):
        result = list(TOOLS)
        for sid, client in self.addons.items():
            for item in client.tools:
                result.append({**item, "name": sid + "/" + item["name"], "server": sid, "approval": True})
        return result

    def status(self):
        return {"type": "connected", "mcp_alive": True,
                # Legacy provider-neutral readiness fields consumed by the inherited UI.
                "studio": True, "studio_app": True, "studio_proc": True,
                "workspace": str(self.local.root), "version": VERSION,
                "servers": [{"id": "local", "alive": True, "tools": len(TOOLS)}] +
                           [{"id": sid, "alive": c.alive(), "tools": len(c.tools)} for sid, c in self.addons.items()],
                "tools": self.catalogue()}

    async def start_addons(self):
        async def launch(sid, client):
            try: await asyncio.to_thread(client.start)
            except Exception as e: print(f"MCP {sid} unavailable: {e}", flush=True)
        await asyncio.gather(*(launch(sid, c) for sid, c in self.addons.items()))
        for ws in list(self.connections):
            try: await ws.send(json.dumps(self.status()))
            except websockets.ConnectionClosed: pass

    async def execute(self, ws, rid, name, args, approved, cancel):
        try:
            specs = {t["name"]: t for t in self.catalogue()}
            if name not in specs: raise ValueError("Unknown tool: " + name)
            validate_arguments(specs[name], args)
            if specs[name].get("approval") and approved is not True:
                raise PermissionError("User approval is required for this tool")
            if name in CATALOGUE:
                result = await asyncio.to_thread(self.local.call, name, args, cancel)
                if isinstance(result, dict) and "images" in result:
                    response = {"ok": True, **result}
                else:
                    error = result.get("error") if isinstance(result, dict) else None
                    if isinstance(result, dict) and "exit_code" in result and result["exit_code"] != 0:
                        error = error or f"Process exited with code {result['exit_code']}"
                    response = {"ok": not bool(error), "text": json.dumps(result, ensure_ascii=False),
                                "images": [], "error": str(error) + "\n" + json.dumps(result, ensure_ascii=False) if error else None}
            else:
                sid, actual_name = name.split("/", 1)
                response = await asyncio.to_thread(self.addons[sid].call, actual_name, args, cancel)
            if cancel.is_set():
                response = {"ok": False, "kind": "cancelled", "error": "Operation stopped by user"}
        except Exception as e:
            response = {"ok": False, "error": str(e), "kind": type(e).__name__}
        finally:
            self.active.pop((ws, rid), None)
        try: await ws.send(json.dumps({"type": "tool_result", "id": rid, **response}))
        except websockets.ConnectionClosed: pass

    async def handler(self, ws):
        request = getattr(ws, "request", None)
        headers = request.headers if request else getattr(ws, "request_headers", {})
        origin = headers.get("Origin")
        if origin and not re.fullmatch(r"chrome-extension://[a-p]{32}", origin):
            await ws.close(4403, "Browser origin is not allowed"); return
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=5)
            auth = json.loads(raw)
            if not isinstance(auth, dict) or auth.get("type") != "auth" or not isinstance(auth.get("token"), str) or not hmac.compare_digest(auth["token"], self.token):
                await ws.close(4401, "Pair the extension with the bridge token"); return
        except (asyncio.TimeoutError, ValueError, websockets.ConnectionClosed):
            await ws.close(4401, "Authentication required"); return
        self.connections.add(ws)
        try:
            await ws.send(json.dumps(self.status()))
            async for raw in ws:
                rid = None
                try:
                    msg = json.loads(raw)
                    if not isinstance(msg, dict): raise ValueError("Message must be an object")
                    rid = msg.get("id")
                    if not isinstance(rid, int) or isinstance(rid, bool): raise ValueError("Integer request ID required")
                    kind = msg.get("type")
                    if kind == "ping": response = {"type": "pong", "id": rid}
                    elif kind == "studio_status":
                        response = {"type": "studio_status", "id": rid, "studio": True, "studio_app": True, "studio_proc": True, "mcp_alive": True}
                    elif kind == "list_tools": response = {**self.status(), "type": "tools", "id": rid}
                    elif kind == "call_tool":
                        if len(self.active) >= 8: raise ValueError("Too many concurrent tool calls")
                        if (ws, rid) in self.active: raise ValueError("Duplicate request ID")
                        name = msg.get("name")
                        if not isinstance(name, str): raise ValueError("Tool name must be a string")
                        cancel = threading.Event()
                        self.active[(ws, rid)] = cancel
                        task = asyncio.create_task(self.execute(ws, rid, name, msg.get("arguments", {}), msg.get("approved"), cancel))
                        self.background.add(task); task.add_done_callback(self.background.discard)
                        continue
                    elif kind == "cancel_tool":
                        target = msg.get("target_id")
                        cancel = self.active.get((ws, target))
                        if cancel: cancel.set()
                        response = {"type": "cancelled", "id": rid, "ok": True}
                    elif kind == "restart_mcp":
                        response = {"type": "mcp_status", "id": rid, "alive": True, "ok": True,
                                    "servers": self.status()["servers"], "tools": self.catalogue()}
                    elif kind in ("add_server", "remove_server"):
                        raise ValueError("Edit config.json locally and restart the bridge to change MCP servers")
                    else: raise ValueError("Unknown message type")
                    await ws.send(json.dumps(response))
                except (ValueError, TypeError, KeyError) as e:
                    await ws.send(json.dumps({"type": "error", "id": rid, "ok": False, "error": str(e)}))
        except websockets.ConnectionClosed:
            pass
        finally:
            self.connections.discard(ws)
            for (connection, _), event in list(self.active.items()):
                if connection is ws: event.set()

    async def close(self):
        for event in self.active.values(): event.set()
        if self.background:
            await asyncio.gather(*list(self.background), return_exceptions=True)
        for client in self.addons.values():
            await asyncio.to_thread(client.stop)


def load_token():
    folder = HERE / ".freeagent-config"
    folder.mkdir(mode=0o700, exist_ok=True)
    path = folder / "token.txt"
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as out: out.write(secrets.token_urlsafe(32))
    token = path.read_text().strip()
    if len(token) < 32: raise ValueError("Pairing token is invalid; remove token.txt and restart")
    return token


async def main():
    parser = argparse.ArgumentParser(description="FreeAgent local bridge")
    parser.add_argument("--workspace", help="Folder the file tools can access")
    parser.add_argument("--port", type=int, default=17613)
    args = parser.parse_args()
    config_path = HERE / "config.json"
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    workspace = args.workspace or config.get("workspace") or str(HERE / "workspace")
    token = load_token()
    bridge = Bridge(workspace, token, config)
    try:
        async with websockets.serve(bridge.handler, "127.0.0.1", args.port, max_size=4 * 1024 * 1024,
                                    ping_interval=20, ping_timeout=20):
            print(f"FreeAgent {VERSION} | workspace: {bridge.local.root}", flush=True)
            print(f"Local bridge: 127.0.0.1:{args.port}", flush=True)
            print("Open the extension popup and paste this pairing token:", flush=True)
            print(token, flush=True)
            print("Keep this terminal open. Ctrl+C stops the bridge.", flush=True)
            startup = asyncio.create_task(bridge.start_addons())
            try: await asyncio.Future()
            finally:
                await startup
    finally:
        await bridge.close()


if __name__ == "__main__":
    try: asyncio.run(main())
    except KeyboardInterrupt: print("FreeAgent stopped.")
    except OSError as e:
        print(f"Bridge could not start: {e}. Close the previous bridge or select a free --port.")
        raise SystemExit(1)

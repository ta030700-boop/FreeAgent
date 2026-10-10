# SPDX-License-Identifier: GPL-3.0-or-later
"""Small stdio MCP client. Uses request IDs, bounded waits and explicit cancellation.

Based on the request/response architecture of ZeroScript by sebattfg.
"""
from __future__ import annotations
import json
import os
import queue
import subprocess
import sys
import threading
import time


class MCPClient:
    def __init__(self, server_id, spec, directory):
        self.id, self.spec, self.directory = server_id, spec, directory
        self.proc = None
        self.tools = []
        self.pending = {}
        self.lock = threading.RLock()
        self.start_lock = threading.RLock()
        self.call_lock = threading.Lock()
        self.serial = 0
        self.last_error = None

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def start(self):
        with self.start_lock:
            if self.alive(): return
            command = self.spec.get("command")
            if not isinstance(command, str) or not command:
                raise ValueError(f"{self.id}: command is required")
            argv = [os.path.expandvars(os.path.expanduser(command))] + list(self.spec.get("args", []))
            if argv[0].endswith(".py"):
                argv = [sys.executable] + argv
            if os.name == "nt" and os.path.basename(argv[0]).lower() in ("npx", "npm", "uvx.cmd"):
                argv = ["cmd.exe", "/c"] + argv
            env = dict(os.environ)
            env.update({k: os.path.expandvars(str(v)) for k, v in self.spec.get("env", {}).items()})
            self.proc = subprocess.Popen(argv, cwd=self.directory, env=env, stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                         encoding="utf-8", errors="replace", bufsize=1,
                                         **({"start_new_session": True} if os.name != "nt" else {}))
            proc = self.proc
            threading.Thread(target=self.reader, args=(proc,), daemon=True).start()
            threading.Thread(target=self.stderr, args=(proc,), daemon=True).start()
            response = self.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                    "clientInfo": {"name": "freeagent", "version": "0.1.2"}}, timeout=15)
            if response.get("error"):
                self.stop(); raise RuntimeError(response["error"].get("message", "MCP initialization failed"))
            self.notify("notifications/initialized", {})
            response = self.request("tools/list", {}, timeout=15)
            if response.get("error"):
                self.stop(); raise RuntimeError(response["error"].get("message", "MCP tool discovery failed"))
            self.tools = response.get("result", {}).get("tools", [])

    def stderr(self, proc):
        try:
            for line in proc.stderr:
                self.last_error = line.strip()[:1000]
        except (OSError, ValueError):
            pass

    def reader(self, proc):
        try:
            for line in proc.stdout:
                try: message = json.loads(line)
                except ValueError: continue
                if not isinstance(message, dict): continue
                with self.lock:
                    waiting = self.pending.get(message.get("id"))
                if waiting:
                    try: waiting.put_nowait(message)
                    except queue.Full: pass
        except (OSError, ValueError):
            pass
        finally:
            # Only fail requests belonging to this generation of the process.
            with self.lock:
                if self.proc is proc:
                    for waiting in self.pending.values():
                        try: waiting.put_nowait({"error": {"message": "MCP server exited"}})
                        except queue.Full: pass

    def notify(self, method, params):
        with self.lock:
            if not self.alive(): return
            self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}) + "\n")
            self.proc.stdin.flush()

    def request(self, method, params, timeout=120, cancel=None):
        cancel = cancel or threading.Event()
        with self.lock:
            if not self.alive(): raise RuntimeError("MCP server is offline")
            self.serial += 1; rid = self.serial
            waiting = queue.Queue(maxsize=1); self.pending[rid] = waiting
            try:
                self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}) + "\n")
                self.proc.stdin.flush()
            except Exception:
                self.pending.pop(rid, None); raise
        deadline = time.monotonic() + timeout
        try:
            while True:
                if cancel.is_set() or time.monotonic() >= deadline:
                    self.notify("notifications/cancelled", {"requestId": rid, "reason": "User stopped or request timed out"})
                    raise RuntimeError("MCP call cancelled; the server controls whether its operation can be interrupted")
                try: return waiting.get(timeout=0.1)
                except queue.Empty: pass
        finally:
            with self.lock: self.pending.pop(rid, None)

    def call(self, name, arguments, cancel):
        # Never automatically retry side-effecting calls after a process drop.
        while not self.call_lock.acquire(timeout=0.1):
            if cancel.is_set(): raise RuntimeError("MCP call cancelled before dispatch")
        try:
            if cancel.is_set(): raise RuntimeError("MCP call cancelled before dispatch")
            if not self.alive(): self.start()
            message = self.request("tools/call", {"name": name, "arguments": arguments}, cancel=cancel)
            if message.get("error"):
                raise RuntimeError(message["error"].get("message", str(message["error"])))
            result = message.get("result", {})
            content = result.get("content", [])
            text = "\n".join(v.get("text", "") for v in content if v.get("type") == "text")
            images = [{"data": v["data"], "mimeType": v.get("mimeType", "image/png")}
                      for v in content if v.get("type") == "image" and v.get("data")]
            if "structuredContent" in result:
                text += "\n" + json.dumps(result["structuredContent"], ensure_ascii=False)
            return {"ok": not bool(result.get("isError")), "text": text[:50000], "images": images[:3],
                    "error": text[:50000] if result.get("isError") else None}
        finally:
            self.call_lock.release()

    def stop(self):
        from local_tools import LocalTools
        with self.start_lock:
            if self.proc:
                proc = self.proc
                try: LocalTools.terminate(proc); proc.wait(timeout=10)
                except (OSError, subprocess.TimeoutExpired): pass
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    try: stream.close()
                    except (OSError, ValueError): pass
                self.proc = None

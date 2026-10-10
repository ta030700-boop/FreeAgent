# SPDX-License-Identifier: GPL-3.0-or-later
"""Workspace tools for FreeAgent. No network listener or import-time execution."""
from __future__ import annotations

import base64
from contextlib import contextmanager
import io
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser


def tool(name, description, properties=None, required=(), approval=False):
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": properties or {},
                            "required": list(required), "additionalProperties": False},
            "approval": approval, "server": "local"}


def string(description):
    return {"type": "string", "description": description}


TOOLS = [
    tool("system_info", "Get OS, workspace, Python, desktop availability and current time."),
    tool("list_directory", "List a workspace folder, optionally recursively (bounded).",
         {"path": string("Relative path; default '.'"), "recursive": {"type": "boolean"}}),
    tool("read_file", "Read UTF-8 text, optionally a line range. Returns exact text, without added line numbers.",
         {"path": string("Workspace file"), "start_line": {"type": "integer", "minimum": 1},
          "end_line": {"type": "integer", "minimum": 1}}, ("path",)),
    tool("write_file", "Create or replace UTF-8 text in the workspace. Existing versions are backed up.",
         {"path": string("Workspace file"), "content": string("Exact full file content")}, ("path", "content")),
    tool("edit_file", "Replace an exact unique text match. Read the file first. Existing versions are backed up.",
         {"path": string("Workspace file"), "old_text": string("Exact unique existing text"),
          "new_text": string("Replacement text"), "replace_all": {"type": "boolean"}},
         ("path", "old_text", "new_text")),
    tool("search_files", "Search text files in the workspace. Skips binary files and common dependency folders.",
         {"query": string("Literal search text"), "path": string("Folder; default '.'"),
          "case_sensitive": {"type": "boolean"}}, ("query",)),
    tool("delete_path", "Move a workspace file/folder into recoverable local trash. Requires user approval.",
         {"path": string("Exact file/folder to remove")}, ("path",), True),
    tool("run_shell", "Run a shell command in the workspace (PowerShell on Windows, /bin/sh elsewhere). Requires approval. Shell has the user's full OS access; cwd is not a sandbox.",
         {"command": string("Command text"), "cwd": string("Workspace folder; default '.'"),
          "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 120}}, ("command",), True),
    tool("run_python", "Run Python with the bridge's interpreter in the workspace. Requires approval; full user OS access.",
         {"code": string("Python source"), "cwd": string("Workspace folder; default '.'"),
          "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 120}}, ("code",), True),
    tool("fetch_url", "Read a public HTTP/HTTPS page as text (bounded). Does not use browser login cookies.",
         {"url": string("Public HTTP/HTTPS URL")}, ("url",), True),
    tool("open_url", "Open a URL in the user's default browser. Requires approval.",
         {"url": string("HTTP/HTTPS URL")}, ("url",), True),
    tool("screen_capture", "Capture the desktop as an image. Requires optional desktop dependencies and approval. The image will be sent to the chat provider.", approval=True),
    tool("mouse_click", "Click the desktop at pixel coordinates. Requires approval and desktop dependencies. Corner failsafe remains enabled.",
         {"x": {"type": "integer"}, "y": {"type": "integer"},
          "button": {"type": "string", "enum": ["left", "right", "middle"]}}, ("x", "y"), True),
    tool("type_text", "Paste text into a desktop app. Supply x and y to focus the target input AFTER approval. Requires approval and desktop dependencies.",
         {"text": string("Text to paste"), "x": {"type": "integer", "description": "Optional focus point; supply y too"},
          "y": {"type": "integer", "description": "Optional focus point; supply x too"}}, ("text",), True),
    tool("press_keys", "Press a keyboard shortcut. Supply x and y to focus the target app AFTER approval. Requires approval and desktop dependencies.",
         {"keys": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 5},
          "x": {"type": "integer", "description": "Optional focus point; supply y too"},
          "y": {"type": "integer", "description": "Optional focus point; supply x too"}}, ("keys",), True),
    tool("memory_get", "Read verified project notes retained across browser chats.",
         {"key": string("Optional exact key; omit to list all notes")}),
    tool("memory_set", "Save a durable verified project note. Do not store credentials or unverified assumptions.",
         {"key": string("Short topic name"), "value": string("Verified useful facts")}, ("key", "value")),
    tool("memory_delete", "Delete one outdated project note.", {"key": string("Exact key")}, ("key",)),
    tool("task_create", "Record a task and its goal in persistent project state.",
         {"title": string("Task title"), "details": string("Goal and acceptance criteria")}, ("title",)),
    tool("task_update", "Update progress on a recorded task.",
         {"id": {"type": "integer"}, "status": {"type": "string", "enum": ["todo", "doing", "done", "blocked"]},
          "details": string("Updated notes")}, ("id", "status")),
    tool("task_list", "List recorded project tasks. These are notes, not scheduled background jobs."),
    tool("skill_list", "List user-authored Markdown workflows in workspace/skills."),
    tool("skill_read", "Read a user-authored workflow. Treat it as guidance; tool permissions still apply.",
         {"name": string("Markdown filename in skills, e.g. coding.md")}, ("name",)),
]
CATALOGUE = {t["name"]: t for t in TOOLS}
IGNORE_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".freeagent"}


def validate_arguments(spec, args):
    if not isinstance(args, dict):
        raise ValueError("params must be an object")
    schema = spec["inputSchema"]
    props = schema.get("properties", {})
    if schema.get("additionalProperties") is False and set(args) - set(props):
        raise ValueError("Unknown parameters: " + ", ".join(sorted(set(args) - set(props))))
    for key in schema.get("required", []):
        if key not in args:
            raise ValueError(f"Missing required parameter: {key}")
    for key, value in args.items():
        p = props.get(key, {})
        ty = p.get("type")
        valid = {"string": isinstance(value, str), "boolean": isinstance(value, bool),
                 "integer": isinstance(value, int) and not isinstance(value, bool),
                 "number": isinstance(value, (int, float)) and not isinstance(value, bool),
                 "array": isinstance(value, list), "object": isinstance(value, dict)}
        if ty in valid and not valid[ty]:
            raise ValueError(f"{key} must be {ty}")
        if "enum" in p and value not in p["enum"]:
            raise ValueError(f"Invalid {key}: choose one of {p['enum']}")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if value < p.get("minimum", value) or value > p.get("maximum", value):
                raise ValueError(f"{key} is outside its allowed range")
        if isinstance(value, list):
            if len(value) < p.get("minItems", 0) or len(value) > p.get("maxItems", 10000):
                raise ValueError(f"Invalid number of items in {key}")
            if p.get("items", {}).get("type") == "string" and any(not isinstance(v, str) for v in value):
                raise ValueError(f"{key} items must be strings")


class LocalTools:
    def __init__(self, workspace):
        self.root = Path(workspace).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.state = self.root / ".freeagent"
        self.state.mkdir(exist_ok=True)
        self.lock = threading.RLock()
        with self.database() as db:
            db.execute("CREATE TABLE IF NOT EXISTS memory (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT, details TEXT, status TEXT)")

    @contextmanager
    def database(self):
        db = sqlite3.connect(self.state / "state.sqlite3", timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def path(self, value=".", allow_root=True):
        if not isinstance(value, str) or not value.strip():
            raise ValueError("path must be a non-empty string")
        result = (self.root / value).resolve()
        if not result.is_relative_to(self.root):
            raise ValueError("Path is outside the selected workspace")
        if result == self.state or result.is_relative_to(self.state):
            raise ValueError("Internal .freeagent state is protected; use memory/task tools")
        if not allow_root and result == self.root:
            raise ValueError("Cannot modify the workspace root")
        return result

    def backup(self, path):
        if path.is_file():
            import shutil
            target = self.state / "backups" / str(time.time_ns()) / path.relative_to(self.root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)

    def write(self, path, content):
        if len(content.encode("utf-8")) > 2_000_000:
            raise ValueError("File content exceeds 2 MB; use smaller files")
        with self.lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            self.backup(path)
            tmp = path.with_name(path.name + ".freeagent-tmp")
            try:
                tmp.write_text(content, encoding="utf-8")
                os.replace(tmp, path)
            finally:
                tmp.unlink(missing_ok=True)

    @staticmethod
    def terminate(proc):
        if proc.poll() is not None:
            return
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, timeout=10)
        else:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def process(self, argv, cwd, timeout, cancel):
        # Capture to disk so a verbose process cannot exhaust bridge memory.
        import tempfile
        with tempfile.TemporaryFile() as output:
            kwargs = {"start_new_session": True} if os.name != "nt" else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
            proc = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL,
                                    stdout=output, stderr=subprocess.STDOUT, **kwargs)
            deadline = time.monotonic() + timeout
            failure = None
            try:
                while proc.poll() is None:
                    if cancel.wait(0.05):
                        failure = "Command cancelled by user"
                        break
                    if time.monotonic() >= deadline:
                        failure = f"Command exceeded {timeout}s and was terminated"
                        break
                    if output.tell() > 10_000_000:
                        failure = "Command exceeded the 10 MB output limit and was terminated"
                        break
            finally:
                if failure:
                    self.terminate(proc)
                proc.wait(timeout=10)
            output.seek(0)
            data = output.read(50001)
            result = {"exit_code": proc.returncode, "output": data[:50000].decode("utf-8", "replace"),
                      "truncated": len(data) > 50000}
            if failure:
                result["error"] = failure
            return result

    @staticmethod
    def desktop():
        try:
            import pyautogui
            pyautogui.FAILSAFE = True
            pyautogui.PAUSE = 0.15
            return pyautogui
        except Exception as e:
            raise RuntimeError("Desktop tools unavailable. Install requirements-desktop.txt and use a graphical desktop. " + str(e)) from e

    @staticmethod
    def check_url(url, public_only=True):
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
            raise ValueError("Use an HTTP/HTTPS URL without embedded credentials")
        if public_only:
            for entry in socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80)):
                if not ipaddress.ip_address(entry[4][0]).is_global:
                    raise ValueError("fetch_url supports public Internet addresses only")
        return url

    def call(self, name, a, cancel=None):
        cancel = cancel or threading.Event()
        validate_arguments(CATALOGUE[name], a)
        if cancel.is_set():
            raise RuntimeError("Cancelled before execution")
        if name == "system_info":
            return {"os": platform.platform(), "workspace": str(self.root), "python": sys.version,
                    "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "terminal": "PowerShell" if os.name == "nt" else "sh"}
        if name == "list_directory":
            folder = self.path(a.get("path", "."))
            result = []
            if a.get("recursive"):
                for parent, dirs, files in os.walk(folder):
                    dirs[:] = sorted(d for d in dirs if d not in IGNORE_DIRS and not (Path(parent) / d).is_symlink())
                    for item in dirs + sorted(files):
                        p = Path(parent) / item
                        result.append({"path": str(p.relative_to(self.root)), "directory": p.is_dir()})
                        if len(result) >= 500:
                            return {"entries": result, "truncated": True}
            else:
                for p in sorted(folder.iterdir()):
                    if p.name not in IGNORE_DIRS:
                        result.append({"path": str(p.relative_to(self.root)), "directory": p.is_dir()})
                        if len(result) >= 500:
                            return {"entries": result, "truncated": True}
            return {"entries": result, "truncated": False}
        if name == "read_file":
            p = self.path(a["path"])
            if p.stat().st_size > 2_000_000:
                raise ValueError("File exceeds 2 MB; use shell with approval to inspect it")
            text = p.read_text(encoding="utf-8")
            start = a.get("start_line", 1)
            end = a.get("end_line")
            if end is not None and end < start:
                raise ValueError("end_line must be >= start_line")
            lines = text.splitlines(keepends=True)
            selected = "".join(lines[start - 1:end])
            return {"path": str(p.relative_to(self.root)), "start_line": start, "total_lines": len(lines),
                    "content": selected[:50000], "truncated": len(selected) > 50000}
        if name == "write_file":
            p = self.path(a["path"], False)
            self.write(p, a["content"])
            return {"written": str(p.relative_to(self.root)), "bytes": len(a["content"].encode("utf-8"))}
        if name == "edit_file":
            p = self.path(a["path"], False)
            if not a["old_text"]:
                raise ValueError("old_text cannot be empty; use write_file to create content")
            with self.lock:
                if p.stat().st_size > 2_000_000:
                    raise ValueError("File exceeds 2 MB")
                text = p.read_text(encoding="utf-8")
                count = text.count(a["old_text"])
                if not count or (count != 1 and not a.get("replace_all")):
                    raise ValueError(f"old_text matched {count} times; provide a unique match or set replace_all")
                self.write(p, text.replace(a["old_text"], a["new_text"], -1 if a.get("replace_all") else 1))
            return {"edited": a["path"], "replacements": count if a.get("replace_all") else 1}
        if name == "search_files":
            folder = self.path(a.get("path", "."))
            query = a["query"] if a.get("case_sensitive") else a["query"].casefold()
            if not query:
                raise ValueError("query must not be empty")
            matches = []
            visited = 0
            for parent, dirs, files in os.walk(folder):
                dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not (Path(parent) / d).is_symlink()]
                for filename in files:
                    if cancel.is_set():
                        raise RuntimeError("Search cancelled")
                    visited += 1
                    if visited > 5000:
                        return {"matches": matches, "truncated": True}
                    p = Path(parent) / filename
                    try:
                        p = self.path(str(p))
                        if p.stat().st_size > 1_000_000:
                            continue
                        text = p.read_text(encoding="utf-8")
                        if "\x00" in text:
                            continue
                    except (OSError, UnicodeError, ValueError):
                        continue
                    for line, content in enumerate(text.splitlines(), 1):
                        target = content if a.get("case_sensitive") else content.casefold()
                        if query in target:
                            matches.append({"path": str(p.relative_to(self.root)), "line": line, "text": content[:500]})
                            if len(matches) >= 100:
                                return {"matches": matches, "truncated": True}
            return {"matches": matches, "truncated": False}
        if name == "delete_path":
            p = self.path(a["path"], False)
            target = self.state / "trash" / str(time.time_ns()) / p.relative_to(self.root)
            target.parent.mkdir(parents=True, exist_ok=True)
            import shutil
            shutil.move(str(p), str(target))
            return {"removed": a["path"], "recoverable_at": str(target)}
        if name in ("run_shell", "run_python"):
            cwd = self.path(a.get("cwd", "."))
            if name == "run_python":
                argv = [sys.executable, "-u", "-c", a["code"]]
            elif os.name == "nt":
                argv = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", a["command"]]
            else:
                argv = ["/bin/sh", "-c", a["command"]]
            return self.process(argv, cwd, a.get("timeout_seconds", 60), cancel)
        if name == "fetch_url":
            check = self.check_url
            class Redirects(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, req, fp, code, msg, headers, newurl):
                    check(newurl)
                    return super().redirect_request(req, fp, code, msg, headers, newurl)
            opener = urllib.request.build_opener(Redirects())
            req = urllib.request.Request(check(a["url"]), headers={"User-Agent": "FreeAgent/0.1"})
            with opener.open(req, timeout=15) as response:
                data = response.read(200001)
                text = data[:200000].decode(response.headers.get_content_charset() or "utf-8", "replace")
                if "html" in response.headers.get("Content-Type", ""):
                    from html.parser import HTMLParser
                    class Text(HTMLParser):
                        def __init__(self): super().__init__(); self.parts = []; self.hidden = 0
                        def handle_starttag(self, tag, attrs):
                            if tag in ("script", "style"): self.hidden += 1
                        def handle_endtag(self, tag):
                            if tag in ("script", "style"): self.hidden = max(0, self.hidden - 1)
                        def handle_data(self, data):
                            if not self.hidden and data.strip(): self.parts.append(data.strip())
                    parser = Text(); parser.feed(text); text = "\n".join(parser.parts)
                return {"url": response.url, "content": text[:40000], "truncated": len(data) > 200000 or len(text) > 40000}
        if name == "open_url":
            url = self.check_url(a["url"], False)
            if not webbrowser.open(url):
                raise RuntimeError("Default browser could not be opened")
            return {"opened": url}
        if name == "screen_capture":
            capture = self.desktop().screenshot()
            original = (capture.width, capture.height)
            capture.thumbnail((1600, 1000))
            buf = io.BytesIO(); capture.convert("RGB").save(buf, format="JPEG", quality=80)
            return {"text": f"Desktop screenshot: original screen {original[0]}x{original[1]}, image {capture.width}x{capture.height}. Mouse coordinates use original screen pixels. Multiply image x by {original[0]/capture.width:.4f}, y by {original[1]/capture.height:.4f}.",
                    "images": [{"data": base64.b64encode(buf.getvalue()).decode(), "mimeType": "image/jpeg"}]}
        if name == "mouse_click":
            desktop = self.desktop()
            w, h = desktop.size()
            if not (0 <= a["x"] < w and 0 <= a["y"] < h):
                raise ValueError("Click coordinates are outside the primary display")
            desktop.click(a["x"], a["y"], button=a.get("button", "left"))
            return {"clicked": [a["x"], a["y"]]}
        if name == "type_text":
            desktop = self.desktop()
            self.focus_target(desktop, a)
            import pyperclip
            previous = pyperclip.paste()
            try:
                pyperclip.copy(a["text"])
                desktop.hotkey("command" if sys.platform == "darwin" else "ctrl", "v")
                time.sleep(0.25)
            finally:
                pyperclip.copy(previous)
            return {"pasted_characters": len(a["text"])}
        if name == "press_keys":
            desktop = self.desktop()
            if any(k not in desktop.KEYBOARD_KEYS for k in a["keys"]):
                raise ValueError("Unsupported keyboard key")
            self.focus_target(desktop, a)
            desktop.hotkey(*a["keys"])
            return {"pressed": a["keys"]}
        if name.startswith("memory_"):
            with self.database() as db:
                if name == "memory_get":
                    rows = db.execute("SELECT key,value FROM memory WHERE key=?", (a["key"],)) if "key" in a else db.execute("SELECT key,value FROM memory ORDER BY key LIMIT 100")
                    return {"notes": [{"key": k, "value": v} for k, v in rows]}
                if name == "memory_set":
                    if not a["key"].strip() or len(a["key"]) > 120 or len(a["value"]) > 5000:
                        raise ValueError("Use a key of 1–120 characters and a note <=5000 characters")
                    db.execute("INSERT INTO memory(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (a["key"], a["value"]))
                else:
                    db.execute("DELETE FROM memory WHERE key=?", (a["key"],))
                return {"saved": a["key"]}
        if name.startswith("task_"):
            with self.database() as db:
                if name == "task_create":
                    cursor = db.execute("INSERT INTO tasks(title,details,status) VALUES (?,?,'todo')", (a["title"][:500], a.get("details", "")[:5000]))
                    return {"id": cursor.lastrowid, "status": "todo"}
                if name == "task_update":
                    row = db.execute("SELECT details FROM tasks WHERE id=?", (a["id"],)).fetchone()
                    if row is None: raise ValueError("Task not found")
                    db.execute("UPDATE tasks SET status=?,details=? WHERE id=?", (a["status"], a.get("details", row[0])[:5000], a["id"]))
                    return {"updated": a["id"]}
                rows = db.execute("SELECT id,title,details,status FROM tasks ORDER BY id DESC LIMIT 100")
                return {"tasks": [dict(zip(("id", "title", "details", "status"), row)) for row in rows]}
        if name == "skill_list":
            folder = self.path("skills")
            return {"skills": sorted(p.name for p in folder.glob("*.md"))[:100] if folder.is_dir() else []}
        if name == "skill_read":
            if Path(a["name"]).name != a["name"] or not a["name"].endswith(".md"):
                raise ValueError("Use a Markdown filename directly inside skills")
            return self.call("read_file", {"path": "skills/" + a["name"]}, cancel)
        raise ValueError("Unknown local tool")

    @staticmethod
    def focus_target(desktop, args):
        if ("x" in args) != ("y" in args):
            raise ValueError("Supply both x and y to focus a desktop target")
        if "x" in args:
            width, height = desktop.size()
            if not (0 <= args["x"] < width and 0 <= args["y"] < height):
                raise ValueError("Focus coordinates are outside the primary display")
            desktop.click(args["x"], args["y"])

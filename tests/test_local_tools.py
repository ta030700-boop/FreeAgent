import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from local_tools import LocalTools, validate_arguments, CATALOGUE


class LocalToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.tools = LocalTools(Path(self.temp.name) / "project")

    def tearDown(self): self.temp.cleanup()

    def test_file_workflow_and_backup(self):
        self.tools.call("write_file", {"path": "src/a.txt", "content": "first\nsecond\n"})
        self.tools.call("edit_file", {"path": "src/a.txt", "old_text": "second", "new_text": "changed"})
        result = self.tools.call("read_file", {"path": "src/a.txt", "start_line": 2, "end_line": 2})
        self.assertEqual(result["content"], "changed\n")
        backups = list((self.tools.state / "backups").rglob("a.txt"))
        self.assertEqual(backups[0].read_text(), "first\nsecond\n")
        found = self.tools.call("search_files", {"query": "CHANGED"})
        self.assertEqual(found["matches"][0]["line"], 2)

    def test_paths_confined_and_state_protected(self):
        for path in ("../escape.txt", str(Path(self.temp.name) / "outside.txt"), ".freeagent/state.sqlite3"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.tools.call("write_file", {"path": path, "content": "blocked"})
        outside = Path(self.temp.name) / "outside"; outside.mkdir()
        try: (self.tools.root / "link").symlink_to(outside, target_is_directory=True)
        except OSError: self.skipTest("Symlinks unavailable")
        with self.assertRaises(ValueError): self.tools.call("write_file", {"path": "link/escape.txt", "content": "blocked"})

    def test_edits_reject_ambiguous_matches(self):
        self.tools.call("write_file", {"path": "a.txt", "content": "x x"})
        with self.assertRaises(ValueError): self.tools.call("edit_file", {"path": "a.txt", "old_text": "x", "new_text": "z"})
        self.assertEqual(self.tools.call("read_file", {"path": "a.txt"})["content"], "x x")

    def test_trash_is_recoverable(self):
        self.tools.call("write_file", {"path": "a.txt", "content": "preserved"})
        result = self.tools.call("delete_path", {"path": "a.txt"})
        self.assertFalse((self.tools.root / "a.txt").exists())
        self.assertEqual(Path(result["recoverable_at"]).read_text(), "preserved")
        with self.assertRaises(ValueError): self.tools.call("delete_path", {"path": "."})

    def test_memory_and_tasks_survive_restart(self):
        self.tools.call("memory_set", {"key": "language", "value": "Python"})
        task = self.tools.call("task_create", {"title": "Build", "details": "Run tests"})
        other = LocalTools(self.tools.root)
        self.assertEqual(other.call("memory_get", {})["notes"][0]["value"], "Python")
        other.call("task_update", {"id": task["id"], "status": "done"})
        self.assertEqual(other.call("task_list", {})["tasks"][0]["status"], "done")

    def test_python_output_exit_and_timeout(self):
        r = self.tools.call("run_python", {"code": "print('works')"})
        self.assertEqual(r["output"].strip(), "works"); self.assertEqual(r["exit_code"], 0)
        r = self.tools.call("run_python", {"code": "import sys; sys.exit(4)"})
        self.assertEqual(r["exit_code"], 4)
        r = self.tools.call("run_python", {"code": "import time; time.sleep(10)", "timeout_seconds": 1})
        self.assertIn("terminated", r["error"])

    def test_running_python_cancels(self):
        event = threading.Event(); threading.Timer(0.2, event.set).start()
        start = time.monotonic()
        r = self.tools.call("run_python", {"code": "import time; time.sleep(20)"}, event)
        self.assertIn("cancelled", r["error"]); self.assertLess(time.monotonic() - start, 3)

    def test_skill_and_argument_validation(self):
        self.tools.call("write_file", {"path": "skills/build.md", "content": "Run tests first."})
        self.assertEqual(self.tools.call("skill_list", {})["skills"], ["build.md"])
        self.assertIn("Run tests", self.tools.call("skill_read", {"name": "build.md"})["content"])
        with self.assertRaises(ValueError): self.tools.call("skill_read", {"name": "../readme.md"})
        for args in ([1], {"code": 1}, {"code": "x", "timeout_seconds": 121}, {"code": "x", "surprise": True}):
            with self.assertRaises(ValueError): validate_arguments(CATALOGUE["run_python"], args)

    def test_fetch_rejects_private_addresses(self):
        with self.assertRaises(ValueError): self.tools.check_url("file:///etc/passwd")
        with self.assertRaises(ValueError): self.tools.check_url("http://127.0.0.1:1234")

    def test_missing_desktop_returns_actionable_error(self):
        with patch.dict(sys.modules, {"pyautogui": None}):
            with self.assertRaisesRegex(RuntimeError, "requirements-desktop"):
                self.tools.call("screen_capture", {})

    def test_desktop_focus_coordinates(self):
        class Desktop:
            def size(self): return (1920, 1080)
            def click(self, x, y): self.clicked = (x, y)
        desktop = Desktop()
        LocalTools.focus_target(desktop, {"x": 100, "y": 200})
        self.assertEqual(desktop.clicked, (100, 200))
        with self.assertRaises(ValueError): LocalTools.focus_target(desktop, {"x": 100})
        with self.assertRaises(ValueError): LocalTools.focus_target(desktop, {"x": 1920, "y": 200})


if __name__ == "__main__": unittest.main()

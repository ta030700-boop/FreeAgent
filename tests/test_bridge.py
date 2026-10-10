import asyncio
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

import websockets
from bridge import Bridge
from mcp_client import MCPClient


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.bridge = Bridge(self.tmp.name, "test-token-that-is-long-enough-123456")
        self.server = await websockets.serve(self.bridge.handler, "127.0.0.1", 0)
        self.url = "ws://127.0.0.1:" + str(self.server.sockets[0].getsockname()[1])

    async def asyncTearDown(self):
        self.server.close(); await self.server.wait_closed(); await self.bridge.close(); self.tmp.cleanup()

    async def auth(self, ws):
        await ws.send(json.dumps({"type": "auth", "token": self.bridge.token}))
        return json.loads(await ws.recv())

    async def request(self, ws, msg):
        await ws.send(json.dumps(msg)); return json.loads(await asyncio.wait_for(ws.recv(), 5))

    async def test_wrong_token_is_rejected(self):
        async with websockets.connect(self.url) as ws:
            await ws.send(json.dumps({"type": "auth", "token": "wrong"}))
            with self.assertRaises(websockets.ConnectionClosed) as ctx: await ws.recv()
            self.assertEqual(ctx.exception.rcvd.code, 4401)

    async def test_website_origin_is_rejected(self):
        async with websockets.connect(self.url, origin="https://evil.example") as ws:
            with self.assertRaises(websockets.ConnectionClosed) as ctx: await ws.recv()
            self.assertEqual(ctx.exception.rcvd.code, 4403)

    async def test_missing_auth_cannot_call_tools(self):
        async with websockets.connect(self.url) as ws:
            await ws.send(json.dumps({"type": "call_tool", "id": 1, "name": "write_file", "arguments": {"path": "no.txt", "content": "no"}}))
            with self.assertRaises(websockets.ConnectionClosed): await ws.recv()
        self.assertFalse((Path(self.tmp.name) / "no.txt").exists())

    async def test_readiness_and_complete_file_workflow(self):
        async with websockets.connect(self.url, origin="chrome-extension://" + "a" * 32) as ws:
            ready = await self.auth(ws)
            self.assertTrue(ready["studio"])
            self.assertTrue(any(t["name"] == "run_python" and t["approval"] for t in ready["tools"]))
            r = await self.request(ws, {"type": "call_tool", "id": 1, "name": "write_file", "arguments": {"path": "hello.txt", "content": "Hello world"}})
            self.assertTrue(r["ok"])
            r = await self.request(ws, {"type": "call_tool", "id": 2, "name": "read_file", "arguments": {"path": "hello.txt"}})
            self.assertEqual(json.loads(r["text"])["content"], "Hello world")

    async def test_shell_requires_approval_and_nonzero_exit_is_error(self):
        async with websockets.connect(self.url) as ws:
            await self.auth(ws)
            msg = {"type": "call_tool", "id": 1, "name": "run_python", "arguments": {"code": "print('approved')"}}
            r = await self.request(ws, msg); self.assertFalse(r["ok"]); self.assertIn("approval", r["error"])
            msg.update(id=2, approved=True)
            r = await self.request(ws, msg); self.assertTrue(r["ok"]); self.assertIn("approved", r["text"])
            msg.update(id=3, arguments={"code": "import sys; sys.exit(5)"})
            r = await self.request(ws, msg); self.assertFalse(r["ok"]); self.assertIn("5", r["error"])

    async def test_cancel_does_not_block_ping(self):
        async with websockets.connect(self.url) as ws:
            await self.auth(ws)
            await ws.send(json.dumps({"type": "call_tool", "id": 1, "name": "run_python", "approved": True, "arguments": {"code": "import time; time.sleep(20)"}}))
            r = await self.request(ws, {"type": "ping", "id": 2})
            self.assertEqual(r["type"], "pong")
            await ws.send(json.dumps({"type": "cancel_tool", "id": 3, "target_id": 1}))
            responses = [json.loads(await asyncio.wait_for(ws.recv(), 3)) for _ in range(2)]
            result = next(r for r in responses if r["id"] == 1)
            self.assertFalse(result["ok"]); self.assertEqual(result["kind"], "cancelled")

    async def test_bad_arguments_and_configuration_mutations_fail(self):
        async with websockets.connect(self.url) as ws:
            await self.auth(ws)
            r = await self.request(ws, {"type": "call_tool", "id": 1, "name": "read_file", "arguments": []})
            self.assertFalse(r["ok"])
            r = await self.request(ws, {"type": "add_server", "id": 2, "command": "bad"})
            self.assertFalse(r["ok"])
            r = await self.request(ws, {"type": "ping", "id": 3})
            self.assertEqual(r["type"], "pong")


class MCPTests(unittest.TestCase):
    def test_is_error_preserved(self):
        client = MCPClient("test", {"command": sys.executable, "args": ["tests/fake_mcp.py"]}, Path(__file__).resolve().parents[1])
        try:
            client.start()
            result = client.call("fail", {}, threading.Event())
            self.assertFalse(result["ok"]); self.assertIn("Permission denied", result["error"])
            result = client.call("echo", {"text": "hello"}, threading.Event())
            self.assertTrue(result["ok"]); self.assertEqual(result["text"], "hello")
        finally: client.stop()


if __name__ == "__main__": unittest.main()

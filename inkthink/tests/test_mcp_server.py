"""接别的 AI 的第一步（2026-11-17，《产品定义》第 2 节「本子、对话、AI 的关系」最后一条）：mcp_server.py 这个按 MCP 协议说话的小程序。
起一个真的测试服务，把 mcp_server.py 当子进程起来，用这里写的小客户端按 MCP 协议（stdio 上一行一条 JSON-RPC）和它说话：
握手、工具列表、对话登记到平板的单子里（带 AI 的名字）、平板交一页 → ink_wait 收到文字和图（第一次带固定规则）、ink_reply 写回记作者、
lease/ack 不丢不重、取消、服务没开、服务后开、退出、坏输入、不漏访问码、工具名和插件一致。
这里只用自己写的测试客户端；真的 Codex、Gemini 命令行各试通过一遍最简单的情形（2026-11-17，见手册「接别的 AI（试验）」），不在这套测试里。"""
import ast
import base64
import contextlib
import io
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mcp_server  # noqa: E402
import prompt  # noqa: E402
import server  # noqa: E402
import test_server as ts  # noqa: E402  （不把 HttpTest 这个名字引进来：引进来的话这个文件会把它的测试再跑一遍）

APP = Path(__file__).resolve().parents[1]
MCP = APP / "mcp_server.py"
TSX = APP.parent / "inkpad-plugin" / "inkpad" / "hooks" / "register.tsx"
THREAD_ID = "019a46cf-09fc-7ab1-b2b2-760c465315a1"
USER_META = {"threadId": THREAD_ID, "x-codex-turn-metadata": {"turn_trigger": "user"}}
QUEUE_META = {"threadId": THREAD_ID, "x-codex-turn-metadata": {"turn_trigger": "queue"}}


class Client:
    """按 MCP 协议说话的测试客户端：把 mcp_server.py 起成子进程，stdin 写、stdout 读（二进制，自己按 UTF-8 编解码，换行只写 \\n）。"""

    def __init__(self, url, *extra, cwd=None, env=None):
        e = dict(os.environ)
        e.pop("INKPAD_URL", None)
        e.pop("INKPAD_AI", None)
        e["INKPAD_CODEX"] = str(Path(cwd or ".") / "没有这个程序")
        e["INKPAD_WAKE"] = "auto"
        e.update(env or {})
        self.p = subprocess.Popen([sys.executable, str(MCP), "--url", url, *extra], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, cwd=cwd, env=e)
        self.msgs, self.raw, self.err = [], [], []
        self.cond = threading.Condition()
        self.next = 0
        self.readers = [threading.Thread(target=self._read, daemon=True), threading.Thread(target=self._read_err, daemon=True)]
        for t in self.readers:
            t.start()

    def _read(self):
        for line in iter(self.p.stdout.readline, b""):
            text = line.decode("utf-8")
            with self.cond:
                self.raw.append(text)
                self.msgs.append(json.loads(text))
                self.cond.notify_all()

    def _read_err(self):
        for line in iter(self.p.stderr.readline, b""):
            self.err.append(line.decode("utf-8", "replace"))

    def write(self, raw):
        self.p.stdin.write(raw)
        self.p.stdin.flush()

    def send(self, obj):
        self.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))

    def wait_msg(self, pred, timeout=30):
        t0 = time.time()
        with self.cond:
            while True:
                for m in self.msgs:
                    if pred(m):
                        self.msgs.remove(m)
                        return m
                left = timeout - (time.time() - t0)
                if left <= 0:
                    return None
                self.cond.wait(left)

    def request(self, method, params=None, timeout=30):
        self.next += 1
        mid = self.next
        msg = {"jsonrpc": "2.0", "id": mid, "method": method}
        if params is not None:
            msg["params"] = params
        self.send(msg)
        return self.wait_msg(lambda m: m.get("id") == mid, timeout)

    def notify(self, method, params=None):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self.send(msg)

    def handshake(self, name="codex-mcp-client", version="2025-06-18"):
        r = self.request("initialize", {"protocolVersion": version, "capabilities": {}, "clientInfo": {"name": name, "version": "1.0"}})
        self.notify("notifications/initialized")
        return r

    def tool(self, name, args=None, timeout=60, meta=None):
        params = {"name": name, "arguments": args or {}}
        if meta is not None:
            params["_meta"] = meta
        r = self.request("tools/call", params, timeout)
        assert r is not None, f"{name} 没有回话"
        return r

    def close(self, timeout=15):
        try:
            self.p.stdin.close()
        except OSError:
            pass
        try:
            self.p.wait(timeout)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait(5)
        for t in self.readers:
            t.join(5)
        for f in (self.p.stdout, self.p.stderr):
            f.close()

    def everything(self):
        """它往外说过的所有话：stdout 上的每一条、stderr 上的日志。"""
        return "".join(self.raw) + "".join(self.err)


class FlakyOut:
    """直接在测试里开 McpServer 时给它的「标准输出」：记下写出来的每一条；broken 时一写就出错（客户端那头的管道断了）。"""

    def __init__(self):
        self.msgs, self.broken, self.buf = [], False, b""

    def write(self, data):
        if self.broken:
            raise OSError("管道断了")
        self.buf += data

    def flush(self):
        if self.broken:
            raise OSError("管道断了")
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            self.msgs.append(json.loads(line.decode("utf-8")))


def text_of(res):
    return "".join(c.get("text", "") for c in res["result"]["content"] if c.get("type") == "text")


def images_of(res):
    return [c for c in res["result"]["content"] if c.get("type") == "image"]


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class McpServerTest(unittest.TestCase):
    setUp_ = ts.HttpTest.setUp
    tearDown_ = ts.HttpTest.tearDown
    call = ts.HttpTest.call
    j = ts.HttpTest.j
    put_page = ts.HttpTest.put_page

    def setUp(self):
        self.setUp_()
        self.addCleanup(self.tearDown_)  # 进程和报到线程先退出，再关本机测试服务
        self.clients = []
        self.proj = Path(self.tmp.name) / "proj" / "paper"
        self.proj.mkdir(parents=True)

    def tearDown(self):
        for c in self.clients:
            c.close()

    def client(self, *extra, url=None, cwd=None, env=None):
        c = Client(url or self.base, *extra, cwd=str(cwd or self.proj), env=env)
        self.clients.append(c)
        return c

    def sessions(self):
        return self.j("GET", "/api/sessions")[1]["sessions"]

    def session_of(self, label="paper", timeout=10):
        t0 = time.time()
        while time.time() - t0 < timeout:
            hit = [s for s in self.sessions() if s["label"] == label]
            if hit:
                return hit[0]
            time.sleep(0.2)
        return None

    def connected(self, *extra, name="codex-mcp-client"):
        c = self.client(*extra)
        r = c.handshake(name)
        self.assertIsNotNone(r)
        s = self.session_of()
        self.assertIsNotNone(s, "对话没有出现在平板的单子里")
        return c, s

    def send_page(self, sid):
        st, r = self.j("POST", "/api/send", ts.send_payload(target=sid))
        self.assertEqual(st, 200, r)
        return r["id"]

    def queue_becomes(self, sid, want, timeout=5):
        """服务那边这个对话的队列等到变成 want（结果写给客户端之后才向服务确认，比回话晚一点点）。返回最后看到的。"""
        t0 = time.time()
        while self.app.bridge.queues.get(sid) != want and time.time() - t0 < timeout:
            time.sleep(0.05)
        return self.app.bridge.queues.get(sid)

    def inproc(self, *extra):
        """不起子进程，直接在测试里开一个 McpServer：能让「写给客户端」那一步出错、能在工具返回后才取消。返回 (服务, 它的输出)。"""
        out = FlakyOut()
        opts = mcp_server.options(["--url", self.base, "--cwd", str(self.proj), "--ai", "Codex",
                                   "--wake", "auto", "--codex", str(self.proj / "没有这个程序"), *extra])
        srv = mcp_server.McpServer(opts, inp=io.BytesIO(b""), out=out)
        self.assertTrue(srv.link.hello())
        srv.link.start()
        self.addCleanup(srv.link.bye)
        return srv, out

    def run_wait(self, srv, mid, timeout=10):
        ev = threading.Event()
        srv.run_tool(mid, json.dumps(mid), ev, {"name": "ink_wait", "arguments": {"timeout": timeout}})
        return ev

    # ------------------------------------------------------------ 握手、工具列表
    def test_handshake_gives_rules_without_claude_code_wording(self):
        c = self.client()
        r = c.handshake(version="2025-06-18")
        res = r["result"]
        self.assertEqual(res["protocolVersion"], "2025-06-18")                  # 认识的版本照回
        self.assertEqual(res["capabilities"], {"tools": {}})
        self.assertEqual(res["serverInfo"]["name"], "inkpad")
        ins = res["instructions"]
        self.assertIn("ink_wait", ins)                                         # 先说这是什么、怎么用
        self.assertIn("## 手写草稿纸（inkpad）", ins)                           # 后面是固定规则
        self.assertIn("用 ink_reply。", ins)
        self.assertNotIn("mcp__inkpad__", ins)                                  # 工具名不带 Claude Code 的前缀
        self.assertNotIn("Read", ins)                                           # 没有「用 Read 看」
        self.assertIn("ink_wait 等工具的结果里附着这些图", ins)
        # 不认识的版本：回自己支持的最新一个
        c2 = self.client()
        r2 = c2.request("initialize", {"protocolVersion": "1999-01-01", "capabilities": {}, "clientInfo": {"name": "x", "version": "1"}})
        self.assertEqual(r2["result"]["protocolVersion"], mcp_server.PROTOCOL_VERSIONS[0])

    def test_tools_list_names_and_schemas(self):
        c = self.client()
        c.handshake()
        tools = c.request("tools/list")["result"]["tools"]
        names = [t["name"] for t in tools]
        self.assertEqual(sorted(names), sorted(["ink_wait", "ink_reply", "ink_show", "ink_import", "ink_scan", "ink_snapshot",
                                                "ink_confirm", "ink_ask", "ink_edit"]))
        for t in tools:
            self.assertEqual(t["inputSchema"]["type"], "object", t["name"])
            self.assertIsInstance(t["inputSchema"]["properties"], dict, t["name"])
            self.assertTrue(t["description"], t["name"])
            self.assertNotIn("Claude", t["description"], t["name"])            # 说明里不带厂商名
            self.assertNotIn("mcp__inkpad__", json.dumps(t, ensure_ascii=False), t["name"])
            self.assertNotIn("用 Read", json.dumps(t, ensure_ascii=False), t["name"])

    def test_tool_names_match_the_plugin(self):
        """两边以后不走样：插件 register.tsx 里注册的工具，名字和每个参数名都在这边有（ink_wait 是这边新加的）。"""
        src = TSX.read_text("utf-8")
        blocks = re.split(r"\$\.tool\.register\(", src)[1:]
        plugin = {}
        for b in blocks:
            m = re.search(r"name: '(ink_\w+)'", b)
            if m:
                plugin[m.group(1)] = b
        mine = {t["name"]: t for t in mcp_server.TOOLS}
        self.assertEqual(sorted(plugin), sorted(n for n in mine if n != "ink_wait"))
        for name, block in plugin.items():
            schema = mine[name]["inputSchema"]
            for key in schema["properties"]:
                self.assertRegex(block, rf"\b{key}: \{{", f"{name} 的参数 {key} 插件里没有")
            top = re.search(r"inputSchema: \{ type: 'object', properties: \{(.*)", block, re.S)
            if top and top.group(1).startswith(" }"):
                self.assertEqual(schema["properties"], {}, name)
            for req in re.findall(r"required: \[([^\]]*)\],\s*\},\s*\}\)", block):
                self.assertEqual(schema.get("required"), re.findall(r"'(\w+)'", req), name)
        items = mine["ink_reply"]["inputSchema"]["properties"]["items"]["items"]["properties"]
        enum = re.search(r"enum: \[('write'[^\]]*)\]", plugin["ink_reply"]).group(1)
        self.assertEqual(items["type"]["enum"], re.findall(r"'(\w+)'", enum))   # ink_reply 能写的种类一样

    def test_runs_on_python_310_grammar(self):
        ast.parse(MCP.read_text("utf-8"), feature_version=(3, 10))

    # ------------------------------------------------------------ 登记到平板的单子里
    def test_session_appears_with_its_ai(self):
        c, s = self.connected()
        self.assertEqual((s["label"], s["ai"], s["cwd"]), ("paper", "Codex", str(self.proj)))
        self.assertTrue(s["started"])                                           # 什么时候开的（单子里写「今天 14:05 开的」）
        sid = s["sid"]
        self.assertEqual(self.app.author_of(sid)["ai"], "Codex")
        # 按客户端报的名字猜：gemini → Gemini；认不出的照报来的名字；--ai 给了就用它
        for name, extra, want in (("gemini-cli-mcp-client", (), "Gemini"), ("my-agent", (), "my-agent"), ("codex-mcp-client", ("--ai", "通义"), "通义")):
            d = Path(self.tmp.name) / "proj" / want
            d.mkdir(parents=True, exist_ok=True)
            c2 = self.client(*extra, cwd=d)
            c2.handshake(name)
            s2 = self.session_of(want)
            self.assertEqual(s2 and s2["ai"], want, name)
        # Claude Code 插件那样的登记（不报 ai）：照旧记 Claude
        self.j("POST", "/bridge/hello", {"sid": "CL", "label": "idea", "cwd": "E:\\idea"})
        self.assertEqual(next(x for x in self.sessions() if x["sid"] == "CL")["ai"], "Claude")

    def test_exit_says_bye(self):
        c, s = self.connected()
        c.close()
        self.assertEqual(c.p.returncode, 0)
        self.assertNotIn(s["sid"], [x["sid"] for x in self.sessions()])       # 退出时 /bridge/bye：马上从单子里消失
        self.assertNotIn(s["sid"], self.app.bridge.sessions)

    # ------------------------------------------------------------ ink_wait：等平板交来的页
    def test_wait_gets_the_page_with_its_image_and_the_rules_once(self):
        c, s = self.connected()
        sid = s["sid"]
        sub = self.send_page(sid)
        r = c.tool("ink_wait", {"timeout": 20})
        self.assertNotIn("isError", r["result"])
        text = text_of(r)
        self.assertTrue(text.startswith(mcp_server.RULES_HEAD), text[:80])     # 第一次：固定规则附在前面
        self.assertIn("## 手写草稿纸（inkpad）", text)
        self.assertIn("【草稿纸】我在平板上写了一些东西发给你。", text)
        self.assertIn(f'写回用 ink_reply（submission="{sub}"）。', text)
        self.assertNotIn("mcp__inkpad__", text)
        self.assertNotIn("Read", text)
        self.assertIn("附在这条结果后面", text)
        imgs = images_of(r)
        crop = self.app.data / "submissions" / sub / "crop.jpg"
        self.assertEqual(len(imgs), 1, [i["mimeType"] for i in imgs])
        self.assertEqual(imgs[0]["mimeType"], "image/jpeg")
        self.assertEqual(base64.b64decode(imgs[0]["data"]), crop.read_bytes())  # 附的就是这一页的图
        self.assertIn(str(crop), text)                                          # 路径照样写着
        self.assertEqual(self.queue_becomes(sid, []), [])                      # 交给 AI 后确认收到了：服务那边删了
        # 第二页：不再附固定规则
        sub2 = self.send_page(sid)
        r2 = c.tool("ink_wait", {"timeout": 20})
        t2 = text_of(r2)
        self.assertTrue(t2.startswith("【草稿纸】"), t2[:80])
        self.assertNotIn("## 手写草稿纸", t2)
        self.assertIn(sub2, t2)
        self.assertEqual(len(images_of(r2)), 1)
        # 平板按钮上的进度：交出去是 delivered、reading；再来等下一页时上一页 done
        self.assertTrue({"delivered", "reading", "done"} <= self.app._rounds[sub], self.app._rounds[sub])
        t0 = time.time()                                                       # 「在看」是结果写出去之后才报的，比回话晚一点点
        while "reading" not in self.app._rounds[sub2] and time.time() - t0 < 5:
            time.sleep(0.05)
        self.assertTrue({"delivered", "reading"} <= self.app._rounds[sub2])
        self.assertNotIn("done", self.app._rounds[sub2])

    def test_wait_with_nothing_comes_back_in_time(self):
        c, s = self.connected()
        t0 = time.time()
        r = c.tool("ink_wait", {"timeout": 2})
        took = time.time() - t0
        self.assertLess(took, 8)
        self.assertNotIn("isError", r["result"])
        self.assertTrue(text_of(r).startswith("还没有新的投递（等了 2 秒）。要接着等就再调一次 ink_wait"), text_of(r))

    def test_page_that_arrives_while_nobody_waits_is_kept_and_given_once(self):
        """lease / ack 和插件一样：取到了先放着（不确认），平板按钮写「排队中」；服务 30 秒没确认再给一次也不重复交；ink_wait 来时交、确认。"""
        c, s = self.connected()
        sid = s["sid"]
        sub = self.send_page(sid)
        t0 = time.time()
        while sub not in self.app.bridge.leases and time.time() - t0 < 10:
            time.sleep(0.1)
        self.assertIn(sub, self.app.bridge.leases)                             # 小程序取走了（lease）
        self.assertEqual(self.app.bridge.queues[sid], [sub])                   # 还没确认：服务留着
        t0 = time.time()                                                       # 取到以后才报「排队中」：等它报过来
        while "queued" not in self.app._rounds.get(sub, ()) and time.time() - t0 < 5:
            time.sleep(0.1)
        self.assertIn("queued", self.app._rounds[sub])                         # 没有 ink_wait 在等：「排队中」
        self.app.bridge.leases[sub] = 0                                        # 假装 30 秒过去了：服务会再给一次
        time.sleep(2.5)
        r = c.tool("ink_wait", {"timeout": 10})
        self.assertIn(sub, text_of(r))
        self.assertEqual(self.queue_becomes(sid, []), [])
        r2 = c.tool("ink_wait", {"timeout": 2})
        self.assertIn("还没有新的投递", text_of(r2))                            # 没有交第二遍

    def test_cancelled_wait_does_not_lose_the_next_page(self):
        c, s = self.connected()
        c.send({"jsonrpc": "2.0", "id": 900, "method": "tools/call", "params": {"name": "ink_wait", "arguments": {"timeout": 30}}})
        time.sleep(1)
        c.notify("notifications/cancelled", {"requestId": 900, "reason": "test"})
        time.sleep(1)
        sub = self.send_page(s["sid"])
        time.sleep(3)
        self.assertIsNone(c.wait_msg(lambda m: m.get("id") == 900, 0.5))       # 取消了的那次不回话
        self.assertEqual(self.app.bridge.queues[s["sid"]], [sub])              # 也没被它拿走确认掉
        r = c.tool("ink_wait", {"timeout": 10})
        self.assertIn(sub, text_of(r))                                          # 下一次照样收到

    # ---- 页要真的写给了客户端才向服务确认（2026-11-18 审查后加：原来一拿到就确认，这时取消或写不出去，这一页就丢了）
    def test_page_is_not_confirmed_when_the_result_cannot_be_written(self):
        srv, out = self.inproc()
        sid = srv.link.sid
        sub = self.send_page(sid)
        out.broken = True                                                       # 客户端那头的管道断了
        self.run_wait(srv, 1)
        self.assertEqual(out.msgs, [])
        time.sleep(0.3)
        self.assertEqual(self.app.bridge.queues[sid], [sub])                   # 没确认：服务那边还留着
        self.assertEqual((list(srv.link.held), [x[0] for x in srv.link.inbox], sub in srv.link.handed), ([], [sub], False))
        self.assertFalse(srv.tools.rules_given)                                # 固定规则也没送到：下次再附
        self.app.bridge.leases[sub] = 0                                        # 服务 30 秒没等到确认再给一次：不重复放
        time.sleep(2.5)
        self.assertEqual([x[0] for x in srv.link.inbox], [sub])
        out.broken = False
        self.run_wait(srv, 2)
        text = "".join(c.get("text", "") for c in out.msgs[-1]["result"]["content"])
        self.assertEqual(out.msgs[-1]["id"], 2)
        self.assertTrue(text.startswith(mcp_server.RULES_HEAD), text[:60])
        self.assertIn(sub, text)                                                # 这回交到了，就是那一页
        self.assertEqual(self.queue_becomes(sid, []), [])                      # 交到了才确认
        self.assertIn("reading", self.app._rounds[sub])

    def test_page_is_given_again_when_the_call_was_cancelled_after_it_was_taken(self):
        srv, out = self.inproc()
        sid = srv.link.sid
        sub = self.send_page(sid)
        real = srv.call_tool

        def cancelled_late(name, args, ev):                                     # 页已经拿到手、还没写出去时，客户端取消了这次调用
            r = real(name, args, ev)
            ev.set()
            return r

        srv.call_tool = cancelled_late
        self.run_wait(srv, 1)
        srv.call_tool = real
        self.assertEqual(out.msgs, [])                                          # 取消了的不回话
        time.sleep(0.3)
        self.assertEqual(self.app.bridge.queues[sid], [sub])                   # 也没确认掉
        self.assertNotIn("reading", self.app._rounds.get(sub, ()))
        self.run_wait(srv, 2)
        self.assertIn(sub, "".join(c.get("text", "") for c in out.msgs[-1]["result"]["content"]))
        self.assertEqual(self.queue_becomes(sid, []), [])
        self.run_wait(srv, 3, timeout=1)
        self.assertIn("还没有新的投递", out.msgs[-1]["result"]["content"][0]["text"])   # 只交一遍

    def test_card_answer_that_missed_a_cancelled_call_comes_with_the_next_wait(self):
        """用户在卡片上答了、服务把回答给了小程序，可那次调用已经被客户端取消：回答存下来，下次 ink_wait 交（服务不会再给第二遍）。"""
        srv, out = self.inproc()
        srv.settle(mcp_server.Out("用户选了：先推公式", keep=True), True)       # 送到了的：不存
        self.assertEqual(srv.link.inbox, [])
        srv.settle(mcp_server.Out("用户选了：先推公式", keep=True), False)      # 没送到：存下
        srv.settle(mcp_server.Out("用户还没答（卡片留在平板上）"), False)        # 不是回答（服务以后会经投递给）：不存
        self.assertEqual(len(srv.link.inbox), 1)
        self.run_wait(srv, 1)
        text = out.msgs[-1]["result"]["content"][0]["text"]
        self.assertIn(mcp_server.LATE_HEAD, text)
        self.assertIn("用户选了：先推公式", text)
        self.assertEqual((srv.link.inbox, srv.link.held), ([], {}))
        # 等卡片的那一段说得出「用户答了没有」：答了的才标 keep
        link = srv.link
        real = link.bridge.call
        try:
            link.bridge.call = lambda *a, **k: mcp_server.Reply(True, {"text": "用户选了：B"})
            self.assertEqual(srv.tools.wait_card("/bridge/ask-wait", "x", "还没答", threading.Event()), ("用户选了：B", True))
            link.bridge.call = lambda *a, **k: mcp_server.Reply(True, {})
            self.assertEqual(srv.tools.wait_card("/bridge/ask-wait", "x", "还没答", threading.Event()), ("还没答", False))
        finally:
            link.bridge.call = real

    def test_url_keeps_only_scheme_host_port(self):
        """把平板用的带访问码的地址整个填进来：只留 http://主机:端口；写得不像地址的不启动，报错的话里不带填的那串。"""
        o = mcp_server.options(["--url", "http://127.0.0.1:8765/?code=ABCD1234#x"])
        self.assertEqual(o.url, "http://127.0.0.1:8765")
        self.assertEqual(mcp_server.options(["--url", "http://user:ABCD1234@localhost:9000/path"]).url, "http://localhost:9000")
        self.assertEqual(mcp_server.options(["--url", " http://127.0.0.1:8765/ "]).url, "http://127.0.0.1:8765")
        for bad in ("127.0.0.1:8765/?code=ABCD1234", "ftp://127.0.0.1/?code=ABCD1234", "http://:99999/?code=ABCD1234", "ABCD1234"):
            err = io.StringIO()
            with contextlib.redirect_stderr(err), self.assertRaises(SystemExit):
                mcp_server.options(["--url", bad])
            self.assertNotIn("ABCD1234", err.getvalue(), bad)
            self.assertIn("http://主机:端口", err.getvalue(), bad)

    # ------------------------------------------------------------ 用假的 Codex 试叫醒
    def fake_codex(self, version="0.170.0", code=0, queue_delay=0):
        folder = self.proj / "假的 Codex" / version
        folder.mkdir(parents=True)
        program = folder / "record.py"
        program.write_text(
            "import json, sys, time\nfrom pathlib import Path\n"
            "folder = Path(__file__).parent\n"
            "with (folder / 'args.jsonl').open('a', encoding='utf-8') as f:\n"
            "    f.write(json.dumps(sys.argv[1:], ensure_ascii=False) + '\\n')\n"
            "if sys.argv[1:] == ['--version']:\n"
            f"    print('codex-cli {version}')\n"
            "else:\n"
            f"    time.sleep({queue_delay})\n"
            f"    sys.exit({code})\n", encoding="utf-8")
        if os.name == "nt":
            cmd = folder / "codex.cmd"
            env = mock.patch.dict(os.environ, {"INKPAD_TEST_PYTHON": sys.executable})
            env.start()
            self.addCleanup(env.stop)
            cmd.write_bytes(b'@"%INKPAD_TEST_PYTHON%" "%~dp0record.py" %*\r\n')
        else:
            cmd = folder / "codex"
            cmd.write_text(f"#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(program))} \"$@\"\n", encoding="utf-8")
            cmd.chmod(0o755)
        return cmd

    def calls_to(self, cmd):
        record = cmd.parent / "args.jsonl"
        return [json.loads(line) for line in record.read_text("utf-8").splitlines()] if record.exists() else []

    def until(self, pred, why, timeout=8):
        end = time.monotonic() + timeout
        while not pred():
            if time.monotonic() >= end:
                self.fail(why)
            time.sleep(0.05)

    def test_wake_queue_and_drain(self):
        cmd = self.fake_codex()
        c, s = self.connected("--codex", str(cmd))
        self.assertEqual(self.calls_to(cmd), [])  # 握手不查版本
        t0 = time.monotonic()
        self.assertEqual(text_of(c.tool("ink_wait", meta=USER_META)), mcp_server.CONNECTED)
        self.assertLess(time.monotonic() - t0, 5)  # 默认等待 45 秒
        sid = s["sid"]
        sub = self.send_page(sid)
        args = ["queue", "--thread=" + THREAD_ID, "--message=" + mcp_server.WAKE_MESSAGE, "--resume"]
        self.until(lambda: len(self.calls_to(cmd)) >= 2, "没排叫醒消息")
        self.assertEqual(self.calls_to(cmd), [["--version"], args])  # 逐字核对，包含经 .cmd 传到脚本里的中文
        self.assertNotIn(sub, args[2])
        self.assertNotIn("之前的批注", args[2])
        self.assertIn("【草稿纸】", args[2])
        self.assertEqual(self.app.bridge.queues[sid], [sub])
        self.assertNotIn("delivered", self.app._rounds[sub])
        self.app.bridge.leases[sub] = 0
        self.until(lambda: self.app.bridge.leases[sub] > 0, "没重新取这条 lease")
        sub2 = self.send_page(sid)
        self.until(lambda: "queued" in self.app._rounds[sub2], "第二页没排队")
        self.assertEqual(self.calls_to(cmd), [["--version"], args])
        self.assertTrue(c.tool("ink_show", meta=QUEUE_META)["result"]["isError"])  # 调任何工具就算来过
        sub3 = self.send_page(sid)
        self.until(lambda: len(self.calls_to(cmd)) >= 3, "第三页没再叫醒")
        self.assertEqual(self.calls_to(cmd), [["--version"], args, args])
        for i, item in enumerate((sub, sub2, sub3)):
            r = c.tool("ink_wait", meta=QUEUE_META)
            self.assertIn(item, text_of(r))
            self.assertIn("之前的批注", text_of(r))
            self.assertEqual(base64.b64decode(images_of(r)[0]["data"]), (self.app.data / "submissions" / item / "crop.jpg").read_bytes())
            if i < 2:
                self.assertTrue(text_of(r).endswith(f"还有 {2-i} 条在等：回完这一条再调一次 ink_wait，马上返回。"))
        self.assertEqual(self.queue_becomes(sid, []), [])
        self.assertEqual(self.calls_to(cmd), [["--version"], args, args])

    def test_wake_options_and_path(self):
        cmd = self.fake_codex()
        with mock.patch.dict(os.environ, {"PATH": str(cmd.parent), "INKPAD_WAKE": "off", "INKPAD_CODEX": str(cmd)}):
            self.assertEqual(mcp_server.find_codex(""), str(cmd))
            opts = mcp_server.options([])
            self.assertEqual((opts.wake, opts.codex), ("off", str(cmd)))
            opts = mcp_server.options(["--wake", "auto", "--codex", "另一个程序"])
            self.assertEqual((opts.wake, opts.codex), ("auto", "另一个程序"))

    def test_no_wake_for_exec_missing_meta_invalid_id_or_off(self):
        cmd = self.fake_codex()
        for meta, mode in ((dict(USER_META, **{"x-codex-turn-metadata": {"turn_trigger": "exec"}}), "auto"),
                           (None, "auto"), (dict(USER_META, threadId=THREAD_ID + "&"), "auto"), (USER_META, "off")):
            with self.subTest(meta=meta, mode=mode):
                c, s = self.connected("--codex", str(cmd), "--wake", mode)
                t0 = time.monotonic()
                self.assertIn("还没有新的投递", text_of(c.tool("ink_wait", {"timeout": 1}, meta=meta)))
                self.assertGreaterEqual(time.monotonic() - t0, 0.9)
                sub = self.send_page(s["sid"])
                self.until(lambda: "queued" in self.app._rounds[sub], "没取到页")
                self.assertIn(sub, text_of(c.tool("ink_wait", meta=meta)))
                self.assertEqual(self.calls_to(cmd), [])
                c.close()

    def test_failed_wake_keeps_the_page(self):
        for version, code, log_text in (("0.148.0", 0, "版本太旧"), ("missing", 0, "没找到 Codex"), ("0.149.0", 9, "退出码 9")):
            with self.subTest(version=version):
                cmd = self.proj / "不存在" / "codex.cmd" if version == "missing" else self.fake_codex(version, code)
                c, s = self.connected("--codex", str(cmd))
                r = c.tool("ink_wait", {"timeout": 1}, meta=USER_META)
                self.assertIn("已接上" if code else "还没有新的投递", text_of(r))
                sub = self.send_page(s["sid"])
                self.until(lambda: any(log_text in line for line in c.err), "没有记录失败")
                self.until(lambda: "queued" in self.app._rounds[sub], "没报排队中")
                self.assertEqual(self.app.bridge.queues[s["sid"]], [sub])
                self.assertNotIn("delivered", self.app._rounds[sub])
                self.assertIn(sub, text_of(c.tool("ink_wait", meta=USER_META)))
                calls = self.calls_to(cmd)
                if code:
                    self.assertEqual(calls[1:], [["queue", "--thread=" + THREAD_ID, "--message=" + mcp_server.WAKE_MESSAGE]])
                else:
                    self.assertEqual(calls, [] if version == "missing" else [["--version"]])
                c.close()

    def test_stashed_answer_wakes_and_active_wait_does_not(self):
        cmd = self.fake_codex("0.165.0")
        srv, out = self.inproc("--codex", str(cmd))
        link = srv.link
        real = mcp_server.run_codex
        with mock.patch.object(mcp_server, "run_codex") as run:
            start = threading.Event()
            # 把查版本停在半路，让第一次 ink_wait 确实等着，再把迟到回答放到手边。
            def delayed(path, args, **kw):
                start.wait(3)
                return real(path, args, **kw)

            run.side_effect = delayed
            srv.handle({"method": "tools/call", "id": 1, "params": {"name": "ink_wait", "_meta": USER_META}})
            self.until(lambda: link.waiters == 1, "ink_wait 没有开始等")
            srv.settle(mcp_server.Out("用户选了甲", keep=True), False)
            self.until(lambda: bool(out.msgs), "没马上交给正在等的调用")
            self.assertIn("用户选了甲", text_of(out.msgs[-1]))
            start.set()
            self.until(lambda: link.codex_version is not None, "没查完版本")
        self.assertEqual(self.calls_to(cmd), [["--version"]])
        srv.settle(mcp_server.Out("用户选了乙", keep=True), False)
        self.until(lambda: len(self.calls_to(cmd)) >= 2, "存下迟到回答没叫醒")
        self.assertEqual(self.calls_to(cmd)[1:], [["queue", "--thread=" + THREAD_ID, "--message=" + mcp_server.WAKE_MESSAGE]])
        self.run_wait(srv, 2)
        self.assertIn("用户选了乙", text_of(out.msgs[-1]))

    def test_wake_round_finishes_after_reply_and_quiet(self):
        cmd = self.fake_codex()
        c, s = self.connected("--codex", str(cmd))
        c.tool("ink_wait", meta=USER_META)
        sub = self.send_page(s["sid"])
        self.until(lambda: "queued" in self.app._rounds[sub], "没报排队中")
        c.tool("ink_wait", meta=QUEUE_META)
        args = {"submission": sub, "items": [{"type": "note", "anchor": "g2", "text": "这一步对"}]}
        self.assertNotIn("isError", c.tool("ink_reply", args, meta=QUEUE_META)["result"])
        self.assertIn("replied", self.app._rounds[sub])
        time.sleep(6)
        self.assertTrue(c.tool("ink_show", meta=QUEUE_META)["result"]["isError"])
        time.sleep(7)
        self.assertNotIn("done", self.app._rounds[sub])
        self.until(lambda: "done" in self.app._rounds[sub], "安静下来后服务没收到 done", timeout=10)
        self.assertNotIn("isError", c.tool("ink_reply", args, meta=QUEUE_META)["result"])

    def test_queue_timeout_does_not_hold_up_poll_or_ack(self):
        cmd = self.fake_codex(queue_delay=6)
        srv, out = self.inproc("--codex", str(cmd))
        sid = srv.link.sid
        srv.handle({"method": "tools/call", "id": 1, "params": {"name": "ink_wait", "_meta": USER_META}})
        self.until(lambda: bool(out.msgs), "第一次调用没接上")
        self.assertEqual(text_of(out.msgs[-1]), mcp_server.CONNECTED)
        with mock.patch.object(mcp_server, "QUEUE_TIMEOUT_S", 4), mock.patch.object(mcp_server, "log") as log:
            first = self.send_page(sid)
            self.until(lambda: len(self.calls_to(cmd)) == 2, "没开始排消息")
            second = self.send_page(sid)
            self.until(lambda: "queued" in self.app._rounds[second], "排消息时没有接着报到")
            self.assertIsNotNone(srv.link.wake_pending)
            self.until(lambda: srv.link.wake_pending is None, "超时没有结束这次叫醒")
            log.assert_any_call("排叫醒消息超时，投递留着")
        self.assertEqual(self.app.bridge.queues[sid], [first, second])
        self.run_wait(srv, 2)
        self.assertIn(first, text_of(out.msgs[-1]))
        self.assertEqual(self.app.bridge.queues[sid], [second])

    def test_pending_cards_tell_the_woken_conversation_to_stop(self):
        cmd = self.fake_codex()
        srv, out = self.inproc("--codex", str(cmd))
        srv.handle({"method": "tools/call", "id": 1, "params": {"name": "ink_wait", "_meta": USER_META}})
        self.until(lambda: bool(out.msgs), "没接上草稿纸")
        self.assertEqual(text_of(out.msgs[-1]), mcp_server.CONNECTED)

        def unanswered(method, path, *args, **kwargs):
            data = {"/bridge/confirm": {"id": "c", "tabletOnline": True}, "/bridge/ask": {"id": "q"},
                    "/bridge/edit": {"ask": "e"}, "/bridge/edit-wait": {"pending": True, "text": prompt.EDIT_PENDING}}
            return mcp_server.Reply(True, data.get(path, {}))

        with mock.patch.object(srv.link.bridge, "call", side_effect=unanswered):
            for name, args in (("ink_confirm", {"questions": [{"guess": "甲"}]}), ("ink_ask", {"question": "选哪一个？"}),
                               ("ink_edit", {"path": "测试文件"})):
                with self.subTest(name=name):
                    res, _, whole = srv.call_tool(name, args, threading.Event())
                    self.assertTrue(whole)
                    text = res["content"][0]["text"]
                    if name == "ink_confirm":  # 读不准手写的确认：没等到不停下，先按理解继续
                        self.assertIn(mcp_server.CONFIRM_GUESS + mcp_server.CONFIRM_WAKE, text)
                        self.assertNotIn("停在这里", text)
                    else:
                        self.assertIn(mcp_server.CARD_WAKE, text)
                    self.assertNotIn(mcp_server.CARD_WAIT, text)
                    if name == "ink_edit":
                        self.assertIn("带上 mode", text)

    def test_probe_finishes_after_reply_and_latest_call_can_switch_back_to_wait(self):
        cmd = self.fake_codex()
        srv, out = self.inproc("--codex", str(cmd))
        link = srv.link
        sub = self.send_page(link.sid)
        self.until(lambda: "queued" in self.app._rounds[sub], "没取到第一页")
        real = mcp_server.run_codex
        start = threading.Event()

        def delayed(path, args, **kw):
            start.wait(8)
            return real(path, args, **kw)

        def call(mid, name, args=None, meta=None):
            params = {"name": name, "arguments": args or {}}
            if meta is not None:
                params["_meta"] = meta
            srv.handle({"method": "tools/call", "id": mid, "params": params})
            self.until(lambda: any(m["id"] == mid for m in out.msgs), "工具没回话")
            return text_of(next(m for m in out.msgs if m["id"] == mid))

        with mock.patch.object(mcp_server, "run_codex", side_effect=delayed), mock.patch.object(mcp_server, "ROUND_IDLE_S", 0.1):
            self.assertIn(sub, call(1, "ink_wait", meta=USER_META))
            self.assertIn("已写到草稿纸", call(2, "ink_reply", {"submission": sub, "items": [{"type": "note", "text": "好"}]}, USER_META))
            self.assertIsNone(link.codex_version)
            # 查版本期间只有这次新到的要叫醒；之前取走的那一页要照常收尾。
            link.stash("测试卡片")
            start.set()
            self.until(lambda: len(self.calls_to(cmd)) == 2, "查完版本没叫醒")
            self.until(lambda: "done" in self.app._rounds[sub], "查版本前的写回没收尾")
        self.assertIn("测试卡片", call(3, "ink_wait", meta=QUEUE_META))
        self.assertIn("还没有新的投递", call(4, "ink_wait", {"timeout": 1}))
        link.stash("之后的卡片")
        self.assertIn("之后的卡片", call(5, "ink_wait"))
        self.assertEqual(len(self.calls_to(cmd)), 2)

    # ------------------------------------------------------------ 写回、推页、整本检测
    def test_reply_lands_with_the_ai_as_author(self):
        c, s = self.connected()
        sub = self.send_page(s["sid"])
        c.tool("ink_wait", {"timeout": 20})
        r = c.tool("ink_reply", {"submission": sub, "items": [{"type": "note", "anchor": "g2", "text": "这一步对"},
                                                              {"type": "read", "anchor": "g2", "text": "F = m a"}]})
        self.assertNotIn("isError", r["result"], text_of(r))
        self.assertTrue(text_of(r).startswith("已写到草稿纸："), text_of(r))
        pend = self.j("GET", "/api/pending?nb=scratch&i=0")[1]
        entries = pend if isinstance(pend, list) else pend.get("items") or pend.get("pending") or []
        self.assertTrue(entries, pend)
        author = entries[-1]["author"]
        self.assertEqual((author["sid"], author["ai"], author["label"]), (s["sid"], "Codex", "paper"))
        # 写不成的：话照原样给 AI，标着出错
        bad = c.tool("ink_reply", {"submission": sub, "items": []})
        self.assertTrue(bad["result"].get("isError"))
        self.assertTrue(text_of(bad).startswith("没写成："), text_of(bad))

    def test_show_resolves_relative_paths_and_marks_who_pushed(self):
        c, s = self.connected()
        png = self.proj / "图.png"
        import pymupdf as fitz
        fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 8, 8), 0).save(str(png))
        r = c.tool("ink_show", {"path": "图.png", "title": "示意"})          # 相对路径按这个对话的文件夹解析
        self.assertNotIn("isError", r["result"], text_of(r))
        self.assertIn("已推到平板：「示意」（「推送 · paper」第 1 页）", text_of(r))
        self.assertIn("用 ink_wait 收", text_of(r))
        nb = self.app.push_book_of(str(self.proj))
        self.assertTrue(nb)
        self.assertEqual(self.app.board_index(nb)["pages"][0]["by"]["ai"], "Codex")
        miss = c.tool("ink_show", {})
        self.assertTrue(miss["result"].get("isError"))
        self.assertEqual(text_of(miss), "缺少 path")

    def test_scan_attaches_the_page_images(self):
        c, s = self.connected()
        self.app.bridge.tablet_seen = 0  # 平板不在线：不用等它存盘
        t = 1_700_000_000_000
        self.put_page(0, [ts.stroke("a", t, 100, 100), ts.stroke("b", t + 500, 130, 100, red=True)])
        r = c.tool("ink_scan", {"nb": "scratch"})
        self.assertNotIn("isError", r["result"], text_of(r))
        text = text_of(r)
        self.assertTrue(text.startswith("【草稿纸·整本】"), text[:60])
        self.assertIn("各页的图按页的先后附在这条结果后面", text)
        self.assertNotIn("Read", text)
        self.assertNotIn("mcp__inkpad__", text)
        imgs = images_of(r)
        self.assertEqual([i["mimeType"] for i in imgs], ["image/png"])
        path = re.search(r"图：(\S+?\.png)", text).group(1)
        self.assertEqual(base64.b64decode(imgs[0]["data"]), Path(path).read_bytes())

    def test_other_tools_follow_the_plugin(self):
        """ink_ask（点选项、手写的图附在结果里）、ink_confirm、ink_snapshot（平板没开）、ink_import、ink_edit：调的接口和回的话照插件。"""
        c, s = self.connected()
        # 问话卡片：平板开着，用户点了一个选项
        self.app.bridge.tablet_seen = time.time()
        box = {}
        th = threading.Thread(target=lambda: box.update(r=c.tool("ink_ask", {"question": "先算哪一步？", "options": ["A", "B"]}, timeout=120)))
        th.start()
        t0 = time.time()
        while not self.app.bridge.asks and time.time() - t0 < 10:
            time.sleep(0.1)
        cid = next(iter(self.app.bridge.asks))
        self.assertEqual(self.app.bridge.asks[cid]["sid"], s["sid"])
        self.j("POST", "/api/ask-answer", {"id": cid, "choice": "B"})
        th.join(60)
        self.assertEqual(text_of(box["r"]), "我点了「B」。")
        # 手写回答：那张图附在结果里
        import pymupdf as fitz
        png = base64.b64encode(fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 6, 6), 0).tobytes("png")).decode()
        box.clear()
        th = threading.Thread(target=lambda: box.update(r=c.tool("ink_ask", {"question": "写下结果"}, timeout=120)))
        th.start()
        t0 = time.time()
        while len(self.app.bridge.asks) < 2 and time.time() - t0 < 10:
            time.sleep(0.1)
        cid2 = next(k for k in self.app.bridge.asks if k != cid)
        self.j("POST", "/api/ask-answer", {"id": cid2, "image": "data:image/png;base64," + png})
        th.join(60)
        r = box["r"]
        self.assertIn("看这张图（附在这条结果后面）", text_of(r))
        self.assertNotIn("Read", text_of(r))
        self.assertEqual([base64.b64decode(i["data"]) for i in images_of(r)], [base64.b64decode(png)])
        # 平板没开：问话卡片不发、确认卡片留在那一页、快照取不到
        self.app.bridge.tablet_seen = 0
        self.assertEqual(text_of(c.tool("ink_ask", {"question": "还在吗？"})), "平板现在没打开草稿纸，卡片没发出去：改在对话里问用户。")
        sub = self.send_page(s["sid"])
        c.tool("ink_wait", {"timeout": 20})
        conf = c.tool("ink_confirm", {"submission": sub, "questions": [{"anchor": "g2", "guess": "F = ma"}]})
        self.assertTrue(text_of(conf).startswith("平板现在没打开草稿纸：确认卡片已经留在那一页，用户打开后回答会出现在 ink_wait 等到的结果里。"), text_of(conf))
        snap = c.tool("ink_snapshot")
        self.assertTrue(snap["result"].get("isError"))
        self.assertEqual(text_of(snap), "没取到：平板上没有打开草稿纸页面。")
        # 导入（相对路径）、改文件前先调 ink_edit（带 mode 直接另存）
        (self.proj / "值日表.md").write_bytes("# 值日表\n\n- 周一：扫地\n".encode("utf-8"))
        imp = c.tool("ink_import", {"path": "值日表.md"})
        self.assertTrue(text_of(imp).startswith("已导入：《值日表"), text_of(imp))
        ed = c.tool("ink_edit", {"path": "值日表.md", "mode": "saveas"})
        self.assertNotIn("isError", ed["result"], text_of(ed))
        self.assertIn("已经另存了一份", text_of(ed))
        self.assertNotIn("mcp__inkpad__", text_of(ed))
        bad = c.tool("ink_edit", {"path": "值日表.md", "mode": "覆盖"})
        self.assertTrue(bad["result"].get("isError"))
        self.assertIn("mode 只能是 overwrite", text_of(bad))

    def test_images_outside_the_submissions_folder_are_not_attached(self):
        sub = self.app.data / "submissions"
        sub.mkdir(parents=True, exist_ok=True)
        inside = sub / "x" / "crop.png"
        inside.parent.mkdir()
        inside.write_bytes(b"\x89PNG fake")
        outside = self.app.data / "secret.png"
        outside.write_bytes(b"\x89PNG secret")
        text = f"- 这一页：{inside}（说明）\n- 别的：{sub}\\..\\secret.png（说明）\n- 又一遍：{inside}（重复的只附一次）"
        imgs, dropped = mcp_server.attach_images(text, str(sub))
        self.assertEqual([base64.b64decode(i["data"]) for i in imgs], [b"\x89PNG fake"])
        self.assertEqual(dropped, [])
        big = sub / "x" / "big.jpg"
        big.write_bytes(b"0" * (mcp_server.IMG_MAX + 1))
        imgs, dropped = mcp_server.attach_images(f"图：{big}（太大）", str(sub))
        self.assertEqual((imgs, [p for p, _ in dropped]), ([], [str(big)]))
        self.assertIn("没有附在结果里", mcp_server.dropped_note(dropped))

    # ------------------------------------------------------------ 服务没开、后开；坏输入；不漏访问码
    def test_service_down_gets_a_plain_answer_and_it_reconnects_later(self):
        port = free_port()
        c = self.client("--wait", "2", url=f"http://127.0.0.1:{port}")
        c.handshake()
        r = c.tool("ink_reply", {"items": [{"type": "note", "text": "x"}]})
        self.assertTrue(r["result"].get("isError"))
        self.assertIn("草稿纸服务没有运行", text_of(r))
        self.assertIn("start.bat", text_of(r))
        w = c.tool("ink_wait")
        self.assertIn("草稿纸服务没有运行", text_of(w))
        self.assertEqual(c.request("ping")["result"], {})                      # 没崩
        # 服务开了：自己连上（每几秒试一次登记）
        httpd = server.Server(("127.0.0.1", port), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            s = self.session_of(timeout=15)
            self.assertIsNotNone(s, "服务开了以后没有自己连上")
            sub = self.send_page(s["sid"])
            r2 = c.tool("ink_wait", {"timeout": 10})
            self.assertIn(sub, text_of(r2))
        finally:
            c.close()
            httpd.shutdown()
            httpd.server_close()

    def test_bad_input_does_not_kill_it(self):
        c = self.client()
        c.handshake()
        c.write(b"{this is not json\n")
        self.assertEqual(c.wait_msg(lambda m: m.get("id") is None and "error" in m)["error"]["code"], -32700)
        c.write(b"\xff\xfe not utf-8 \xc3\n")                                     # 坏的 UTF-8
        self.assertEqual(c.wait_msg(lambda m: m.get("id") is None and "error" in m)["error"]["code"], -32700)
        self.assertEqual(c.request("resources/list")["error"]["code"], -32601)  # 不认识的方法
        c.notify("notifications/whatever")                                      # 不认识的通知：不回话
        c.send([{"jsonrpc": "2.0", "id": 77, "method": "ping"}])               # 批量：不支持
        self.assertEqual(c.wait_msg(lambda m: m.get("id") is None and "error" in m)["error"]["code"], -32600)
        self.assertEqual(c.request("tools/call", {"name": "no_such_tool", "arguments": {}})["error"]["code"], -32602)
        r = c.request("tools/call", {"name": "ink_reply", "arguments": "不是对象"})
        self.assertTrue(r["result"]["isError"])
        self.assertEqual(c.request("ping")["result"], {})
        time.sleep(0.5)
        self.assertEqual([m for m in c.msgs if "id" not in m or m.get("id") is None], [])  # 通知没有招来回话
        self.assertIsNone(c.p.poll())

    def test_no_access_code_in_results_or_logs(self):
        c, s = self.connected()
        sub = self.send_page(s["sid"])
        c.tool("ink_wait", {"timeout": 20})
        c.tool("ink_reply", {"submission": sub, "items": [{"type": "note", "anchor": "g2", "text": "好"}]})
        c.tool("ink_snapshot")                                                 # 平板没开：回一句话
        c.close()
        out = c.everything()
        self.assertTrue(out)
        self.assertNotIn(self.app.code, out)
        self.assertNotIn("?k=", out)
        self.assertNotIn("<svg", out)

    def test_texts_for_other_ais(self):
        """给别的 AI 的文字：工具名去掉前缀；「用 Read 看」改说法；「作为一条新消息送来」改成经 ink_wait 收；给 Claude 的原文不动。"""
        msg = '【草稿纸】……\n\n先用 Read 看这两张图：\n- 这一页：X\n\n写回用 mcp__inkpad__ink_reply（submission="1"）。'
        out = mcp_server.for_ai(msg, attached=True)
        self.assertIn("先看这两张图（附在这条结果后面", out)
        self.assertIn('写回用 ink_reply（submission="1"）。', out)
        self.assertEqual(mcp_server.for_ai(msg), msg.replace("mcp__inkpad__", "").replace("用 Read ", ""))
        self.assertIn("由 ink_wait 交给你（以【草稿纸·回答】开头", mcp_server.for_ai(prompt.EDIT_PENDING))
        self.assertIn("mcp__inkpad__ink_reply", prompt.protocol())             # prompt.py 给 Claude 的原文没动
        self.assertIn("先用 Read 看消息里列的图", prompt.protocol())


if __name__ == "__main__":
    unittest.main()

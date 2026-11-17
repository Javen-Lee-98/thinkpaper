"""别的页有新回答的记号（2026-11-16 用户定，《产品定义》第 2 节「交互上补的八样」）：服务这一侧。

本子信息（/api/notebook）里，还有 Claude 写回、没落到纸上的回答的页，pageInfo 那一项带 newAns: true——从每页的待处理文件只读地算出来，
不取走、不改任何数据文件；只有读法、只是记账（lsent、msent、vsent）的不算。回写时发给平板的 ai 事件带上页的键（key）和
这一批里有没有看得见的（shown）。

    .venv\\Scripts\\python.exe -m unittest discover -s tests
"""
import json
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # 单独跑这个文件时也找得到 test_server

from test_server import make_app, send_payload  # noqa: E402

import server  # noqa: E402


def flags(app, nb="scratch"):
    return [bool(p.get("newAns")) for p in app.notebook_info(nb)["pageInfo"]]


class WaitingRepliesTest(unittest.TestCase):
    def test_pages_with_replies_not_yet_on_paper(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            app.add_page("scratch")
            app.add_page("scratch")
            keys = [p["key"] for p in app.notebook_info("scratch")["pageInfo"]]
            self.assertEqual(flags(app), [False, False, False])
            app.add_pending("scratch", keys[1], {"req": "a", "items": [{"type": "note", "text": "短批注"}], "t": 1})
            app.add_pending("scratch", keys[2], {"req": "b", "items": [{"type": "read", "anchor": "g1", "text": "F=ma"}], "t": 2})
            app.add_pending("scratch", keys[2], {"lsent": 5, "req": "b", "t": 3})
            app.add_pending("scratch", keys[0], {"msent": {"x": ["m1"]}, "req": "c", "t": 4})
            app.add_pending("scratch", keys[0], {"vsent": ["v1"], "t": 5})
            # 第 2 页有一条短批注没落下；第 3 页只有读法和记账；第 1 页只有记账
            self.assertEqual(flags(app), [False, True, False])
            # 只读：待处理文件原样还在，平板打开那一页时照样取得到
            pend = app._key_file("scratch", keys[1], ".pending.json")
            before = pend.read_bytes()
            app.notebook_info("scratch")
            self.assertEqual(pend.read_bytes(), before)
            self.assertEqual(len(app.take_pending("scratch", 1)), 1)
            self.assertEqual(flags(app), [False, False, False])  # 取走（落到纸上）了：记号没了
            # 一批里只要有一条看得见的就算（读法和长回答一起来）
            app.add_pending("scratch", keys[2], {"req": "d", "items": [{"type": "read", "anchor": "g1", "text": "x"}, {"type": "write", "text": "长回答"}], "t": 6})
            self.assertEqual(flags(app), [False, False, True])
            # 插一页、删一页：记号跟着那一页走（按页的键）
            app.insert_page("scratch", 0)
            self.assertEqual(flags(app), [False, False, False, True])
            app.delete_page("scratch", 1)
            self.assertEqual(flags(app), [False, False, True])
            # 待处理文件坏了（正好在写的那一刻读到半截之类）：当没有，不出错
            app._key_file("scratch", keys[0], ".pending.json").write_text("{坏", "utf-8")
            self.assertEqual(flags(app), [False, False, True])

    def test_book_pages_too(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            import pymupdf as fitz  # 新模块名（import fitz 会往标准输出写一句弃用提醒）
            doc = fitz.open()
            for _ in range(3):
                doc.new_page(width=595, height=842)
            doc.save(str(app.books / "讲义.pdf"))
            nb = "book:讲义.pdf"
            keys = [p["key"] for p in app.notebook_info(nb)["pageInfo"]]
            app.add_pending(nb, keys[2], {"req": "a", "items": [{"type": "tick", "anchor": "g1"}], "t": 1})
            self.assertEqual(flags(app, nb), [False, False, True])


class ReplyEventTest(unittest.TestCase):
    def test_ai_event_carries_page_key_and_whether_anything_shows(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            server.Handler.app = app
            httpd = server.Server(("127.0.0.1", 0), server.Handler)
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            try:
                def j(path, body):
                    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST")
                    req.add_header("X-Access", app.code)
                    req.add_header("Content-Type", "application/json")
                    with urllib.request.urlopen(req, timeout=30) as r:
                        return json.loads(r.read())
                j("/bridge/hello", {"sid": "S1", "label": "idea", "cwd": tmp})
                sub = j("/api/send", send_payload())
                key = app.page_key("scratch", 0)

                def last_ai():
                    return [e for e in app.bridge.events if e["type"] == "ai"][-1]
                j("/bridge/reply", {"sid": "S1", "submission": sub["id"], "items": [{"type": "note", "anchor": "g1", "text": "看这里"}]})
                ev = last_ai()
                self.assertEqual((ev["nb"], ev["page"], ev["key"], ev["shown"]), ("scratch", 0, key, True))
                j("/bridge/reply", {"sid": "S1", "submission": sub["id"], "items": [{"type": "read", "anchor": "g1", "text": "F=ma"}]})
                ev = last_ai()
                self.assertEqual((ev["key"], ev["shown"]), (key, False))  # 只有读法：平板上看不见，不出记号
                self.assertEqual(flags(app), [True])  # 第一批里的短批注还没落下
            finally:
                httpd.shutdown()
                httpd.server_close()


if __name__ == "__main__":
    unittest.main()

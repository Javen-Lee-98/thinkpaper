"""存页按页的键，不按页码（2026-11-17 用户定，《产品定义》第 2 节「做了但还留着毛病的」第一样）：服务这一侧。

两台设备同时开着同一本，一台插了页、删了页、挪了页，另一台还没刷新就接着写：它存页时带着这一页的键（PUT /api/page?…&key=），
服务按键找它现在是第几页再存——绝不写到别的页上。键还在、页码变了：照样存到那一页，回话里 at 是它现在的页码；
那一页在别处删掉了：存进那一页（还原时字都在），回话里 deleted；哪里都没有：一个字都不写，另存到 data/conflicts/，返回 410。
不带键的旧请求照旧按页码存。同一批里，平板发来的、带页码的别的请求（取 Claude 的回答、交给 Claude、快照、报位置、插页、删页、
有新笔迹的页、几页一起交后的记账事件）也按键对。

    .venv\\Scripts\\python.exe -m unittest discover -s tests
"""
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # 单独跑这个文件时也找得到 test_server

from test_server import make_app, send_payload, stroke  # noqa: E402

import server  # noqa: E402


def body(tag, rev=None, n=1):
    """一页：n 笔，id 是 tag、tag1、tag2……（看得出是哪一页的字）。"""
    p = {"v": 1, "strokes": [stroke(tag + (str(k) if k else ""), 1 + k, 100, 100 + 20 * k) for k in range(n)], "ai": [], "reads": []}
    if rev is not None:
        p["rev"] = rev
    return json.dumps(p)


def ids(app, nb, i):
    return [s["id"] for s in json.loads(app.load_page(nb, i))["strokes"]]


def ink_files(app, nb="scratch"):
    d = app._nb_dir(nb)
    return {p.name: p.read_bytes() for p in d.iterdir() if p.name.startswith(("page-", "blank-")) and p.suffix == ".json"}


class SaveByKeyTest(unittest.TestCase):
    """App.put_page：按键存。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = make_app(self.tmp.name)
        for _ in range(2):
            self.app.add_page("scratch")
        for i, tag in enumerate("ABC"):
            self.app.save_page("scratch", i, body(tag), client="ipad")
        self.K = [p["key"] for p in self.app.notebook_info("scratch")["pageInfo"]]  # K[0] 上写着 A，K[1] 上 B，K[2] 上 C

    def tearDown(self):
        self.tmp.cleanup()

    def keys(self):
        return [p["key"] for p in self.app.notebook_info("scratch")["pageInfo"]]

    def test_page_inserted_elsewhere(self):
        """另一台在最前面插了一页：这台以为 B 那一页是第 2 页，带着键存——存到 B 那一页（现在第 3 页），回话里 at 是 2；第 2 页（A）一个字没动。"""
        app = self.app
        app.insert_page("scratch", -1)
        res = app.put_page("scratch", 1, body("B", n=2), client="ipad", key=self.K[1])
        self.assertEqual((res["at"], res["deleted"]), (2, False))
        self.assertEqual(ids(app, "scratch", 2), ["B", "B1"])
        self.assertEqual(ids(app, "scratch", 1), ["A"])
        self.assertEqual(ids(app, "scratch", 0), [])  # 新插的空白页上没有字

    def test_page_moved_elsewhere(self):
        """另一台把 B 那一页挪到了最后：照样存到它上面，at 是 2；原来第 2 页的位置现在是 C，没动。"""
        app = self.app
        app.move_page("scratch", 1, 2)
        self.assertEqual(self.keys(), [self.K[0], self.K[2], self.K[1]])
        res = app.put_page("scratch", 1, body("B", n=3), client="ipad", key=self.K[1])
        self.assertEqual(res["at"], 2)
        self.assertEqual(ids(app, "scratch", 2), ["B", "B1", "B2"])
        self.assertEqual(ids(app, "scratch", 1), ["C"])

    def test_page_deleted_elsewhere(self):
        """另一台把 B 那一页删了：这台的字存进删掉的那一页（deleted），别的页一个字没动；在「显示已删的页」里还原，字都在。"""
        app = self.app
        app.delete_page("scratch", 1)
        before = {k: v for k, v in ink_files(app).items()}
        res = app.put_page("scratch", 1, body("B", n=2), client="ipad", key=self.K[1])
        self.assertEqual((res["at"], res["deleted"]), (None, True))
        after = ink_files(app)
        changed = [n for n in after if after[n] != before.get(n)]
        self.assertEqual(changed, [app._key_file("scratch", self.K[1]).name])  # 只改了 B 自己的文件
        self.assertEqual(ids(app, "scratch", 1), ["C"])
        hidden = app.hidden_pages("scratch")
        self.assertEqual([(h["key"], h["ink"]) for h in hidden], [(self.K[1], True)])
        j = app.restore_page("scratch", self.K[1])
        self.assertEqual(ids(app, "scratch", j), ["B", "B1"])

    def test_key_nowhere_is_kept_aside(self):
        """键哪里都没有（不认识的键）：一个字都不写到本子里，这份另存到 data/conflicts/，抛 PageGone。"""
        app = self.app
        before = ink_files(app)
        with self.assertRaises(server.PageGone) as cm:
            app.put_page("scratch", 1, body("X", n=2), client="ipad", key="b0123abcd")
        self.assertIn("data/conflicts/", str(cm.exception))
        self.assertEqual(ink_files(app), before)
        kept = list((app.data / "conflicts").iterdir())
        self.assertEqual(len(kept), 1)
        self.assertEqual([s["id"] for s in json.loads(kept[0].read_text("utf-8"))["strokes"]], ["X", "X1"])
        with self.assertRaises(ValueError):  # 键的样子都不对
            app.put_page("scratch", 1, body("X"), client="ipad", key="../layout")

    def test_without_key_still_by_page_number(self):
        """不带键（还开着的旧页面）：照旧按页码存，不报错。"""
        app = self.app
        app.insert_page("scratch", -1)
        res = app.put_page("scratch", 1, body("old"), client="ipad")
        self.assertEqual((res["at"], res["deleted"]), (1, False))
        self.assertEqual(ids(app, "scratch", 1), ["old"])
        self.assertEqual(app.save_page("scratch", 2, body("B", n=2), client="ipad"), 2)  # save_page 照旧返回版本号

    def test_conflict_still_kept_aside_when_found_by_key(self):
        """按键找到的那一页在别的设备上改过了：照旧不覆盖、另存一份、抛 Conflict（版本冲突那套没弄坏）。"""
        app = self.app
        rev = json.loads(app.load_page("scratch", 1))["rev"]
        app.move_page("scratch", 1, 0)
        app.put_page("scratch", 0, body("B", rev=rev, n=2), client="mac", key=self.K[1])  # 另一台拿着最新版本改了
        with self.assertRaises(server.Conflict):
            app.put_page("scratch", 1, body("B", rev=rev, n=3), client="ipad", key=self.K[1])  # 这台手里是旧版本
        self.assertEqual(ids(app, "scratch", 0), ["B", "B1"])
        kept = list((app.data / "conflicts").iterdir())
        self.assertEqual([len(json.loads(k.read_text("utf-8"))["strokes"]) for k in kept], [3])
        # 同一台连着存（body 里的版本还没更新）不算冲突
        self.assertEqual(app.put_page("scratch", 9, body("B", rev=rev, n=4), client="mac", key=self.K[1])["at"], 0)

    def test_insert_and_delete_by_key(self):
        """插页按 after_key、删页按 key：平板手上的页码过时了也插在、删的是它眼前那一页；已经删掉的再删一次什么都不做。"""
        app = self.app
        app.insert_page("scratch", -1)  # 另一台在最前面插了一页：B 现在是第 3 页
        j = app.insert_page("scratch", 1, after_key=self.K[1])  # 这台以为 B 是第 2 页，在它后面加页
        self.assertEqual(j, 3)
        self.assertEqual(self.keys()[2], self.K[1])
        self.assertEqual(app.delete_page("scratch", 1, key=self.K[2])["key"], self.K[2])  # 以为 C 是第 2 页：删的是 C
        self.assertEqual([k for k in self.keys() if k in self.K], [self.K[0], self.K[1]])
        self.assertIsNone(app.delete_page("scratch", 1, key=self.K[2]))  # C 已经删掉了：不再删别的页
        self.assertEqual(len(self.keys()), 4)
        with self.assertRaises(ValueError):
            app.insert_page("scratch", 1, after_key=self.K[2])  # 在删掉的那一页后面加：不加
        self.assertEqual(len(self.keys()), 4)
        with self.assertRaises(KeyError):
            app.delete_page("scratch", 1, key="b0123abcd")

    def test_take_pending_by_key(self):
        """取 Claude 写回的批注按键取：页序过时的平板取不到别的页的回答。"""
        app = self.app
        app.add_pending("scratch", self.K[1], {"req": "r", "items": [{"type": "note", "text": "给 B 的"}], "t": 1})
        app.insert_page("scratch", -1)  # 现在第 2 页是 A，B 在第 3 页
        self.assertEqual(app.take_pending("scratch", 1, key=self.K[0]), [])  # 拿着 A 的键：A 没有
        self.assertEqual(len(app.take_pending("scratch", 1, key=self.K[1])), 1)  # 拿着 B 的键：取到给 B 的
        app.add_pending("scratch", self.K[0], {"req": "r", "items": [{"type": "note", "text": "给 A 的"}], "t": 2})
        self.assertEqual(len(app.take_pending("scratch", 1)), 1)  # 不带键：照旧按页码

    def test_new_pages_with_keys(self):
        """有新笔迹的页：给了列表就把同样几页的键按顺序放进去。"""
        app = self.app
        keys = []
        self.assertEqual(app.new_pages("scratch", None, keys), [0, 1, 2])
        self.assertEqual(keys, self.K)


class SaveByKeyHttpTest(unittest.TestCase):
    """HTTP 接口：GET /api/page 的回话头、PUT 的回话、取回答、交给 Claude、快照、报位置、插页、删页、有新笔迹的页、记账事件。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = make_app(self.tmp.name)
        server.Handler.app = self.app
        self.httpd = server.Server(("127.0.0.1", 0), server.Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        for _ in range(2):
            self.app.add_page("scratch")
        for i, tag in enumerate("ABC"):
            self.app.save_page("scratch", i, body(tag), client="ipad")
        self.K = self.keys()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def call(self, method, path, data=None, headers=None):
        raw = json.dumps(data).encode() if isinstance(data, (dict, list)) else data
        req = urllib.request.Request(self.base + path, data=raw, method=method)
        req.add_header("X-Access", self.app.code)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        if raw is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def j(self, method, path, data=None, headers=None):
        st, _, raw = self.call(method, path, data, headers)
        return st, json.loads(raw) if raw else None

    def keys(self):
        return [p["key"] for p in self.j("GET", "/api/notebook?nb=scratch")[1]["pageInfo"]]

    def put(self, i, key, data):
        q = f"/api/page?nb=scratch&i={i}" + (f"&key={key}" if key else "")
        return self.j("PUT", q, data, {"X-Client": "ipad"})

    def test_get_page_tells_its_key(self):
        st, hd, raw = self.call("GET", "/api/page?nb=scratch&i=1")
        self.assertEqual((st, hd.get("X-Page-Key")), (200, self.K[1]))
        self.assertEqual(json.loads(raw)["strokes"][0]["id"], "B")
        self.app.insert_page("scratch", -1)
        st, hd, raw = self.call("GET", "/api/page?nb=scratch&i=1")
        self.assertEqual((hd.get("X-Page-Key"), json.loads(raw)["strokes"][0]["id"]), (self.K[0], "A"))  # 键和数据是同一页的

    def test_put_by_key_over_http(self):
        self.app.insert_page("scratch", -1)
        st, r = self.put(1, self.K[1], json.loads(body("B", n=2)))
        self.assertEqual((st, r["ok"], r["at"], "deleted" in r), (200, True, 2, False))
        self.assertEqual(ids(self.app, "scratch", 2), ["B", "B1"])
        self.assertEqual(ids(self.app, "scratch", 1), ["A"])
        # 删掉的那一页：字存进它，回话里 deleted
        self.app.delete_page("scratch", 2)
        st, r = self.put(2, self.K[1], json.loads(body("B", n=3)))
        self.assertEqual((st, r["at"], r.get("deleted")), (200, None, True))
        self.assertEqual(ids(self.app, "scratch", 2), ["C"])
        # 哪里都没有：410，说没存进本子、另存在哪
        st, r = self.put(1, "b0123abcd", json.loads(body("X")))
        self.assertEqual((st, r.get("pageGone")), (410, True))
        self.assertIn("data/conflicts/", r["error"])
        # 不带键的旧请求：照旧按页码存，回话照旧只有 ok、rev
        st, r = self.put(1, None, json.loads(body("old")))
        self.assertEqual((st, sorted(r)), (200, ["ok", "rev"]))
        self.assertEqual(ids(self.app, "scratch", 1), ["old"])

    def test_pending_by_key_over_http(self):
        self.app.add_pending("scratch", self.K[1], {"req": "r", "items": [{"type": "note", "text": "给 B 的"}], "t": 1})
        self.app.insert_page("scratch", -1)
        self.assertEqual(self.j("GET", f"/api/pending?nb=scratch&i=1&key={self.K[0]}")[1], [])
        self.assertEqual(len(self.j("GET", f"/api/pending?nb=scratch&i=1&key={self.K[1]}")[1]), 1)

    def test_send_and_snapshot_by_key(self):
        """交给 Claude、快照：按键找到那一页现在的页码（投递里记的页码、键都是它的）；那一页删掉了就不交。"""
        self.app.insert_page("scratch", -1)  # B 现在第 3 页
        st, sent = self.j("POST", "/api/send", dict(send_payload(target="B"), page=1, key=self.K[1]))
        self.assertEqual(st, 200, sent)
        meta = self.app.load_submission(sent["id"])
        self.assertEqual((meta["page"], meta["page_key"], "key" in meta), (2, self.K[1], False))
        self.app.delete_page("scratch", 2)
        st, r = self.j("POST", "/api/send", dict(send_payload(target="B"), page=1, key=self.K[1]))
        self.assertEqual((st, r["error"]), (400, server.PAGE_DELETED))
        # 快照：平板收到请求时按键回传
        self.j("GET", "/api/events?since=0&wait=0")
        seq = self.app.bridge.seq

        def tablet():
            d = self.j("GET", f"/api/events?since={seq}&wait=10")[1]
            rid = [e for e in d["events"] if e["type"] == "snapshot"][0]["rid"]
            self.call("POST", "/api/snapshot", dict(send_payload(), page=0, key=self.K[2], rid=rid))  # 以为 C 是第 1 页；C 现在第 3 页

        th = threading.Thread(target=tablet)
        th.start()
        st, snap = self.j("POST", "/bridge/snapshot", {"sid": "B", "wait": 10})
        th.join()
        self.assertEqual(st, 200, snap)
        self.assertEqual(self.app.load_submission(snap["id"])["page_key"], self.K[2])
        self.assertIn("草稿本第 3 页", snap["text"])

    def test_where_with_key(self):
        """平板报位置带了键：Claude 不指定投递写回时，落在平板眼前那一页上（页序过时也对）；那一页删掉了就不写。"""
        self.app.insert_page("scratch", -1)
        self.j("POST", "/api/where", {"nb": "scratch", "page": 1, "key": self.K[1]})  # 平板以为 B 是第 2 页
        st, rep = self.j("POST", "/bridge/reply", {"sid": "B", "items": [{"type": "write", "text": "x", "anchor": "end"}]})
        self.assertEqual((st, rep["page"]), (200, "草稿本第 3 页（空白草稿纸）"))
        self.assertEqual(len(self.app.take_pending("scratch", 2)), 1)
        self.assertEqual(self.app.take_pending("scratch", 1), [])
        self.app.delete_page("scratch", 2)
        st, rep = self.j("POST", "/bridge/reply", {"sid": "B", "items": [{"type": "write", "text": "y", "anchor": "end"}]})
        self.assertEqual(st, 400, rep)
        self.j("POST", "/api/where", {"nb": "scratch", "page": 0, "key": "../x"})  # 键不对：只记页码
        self.assertNotIn("key", self.app.bridge.where)

    def test_insert_and_delete_over_http(self):
        self.app.insert_page("scratch", -1)  # 另一台插了一页：B 现在第 3 页
        st, r = self.j("POST", "/api/page/insert", {"nb": "scratch", "after": 1, "afterKey": self.K[1]})
        self.assertEqual((st, r["page"]), (200, 3))
        st, r = self.j("POST", "/api/page/delete", {"nb": "scratch", "i": 1, "key": self.K[2]})  # 以为 C 是第 2 页
        self.assertEqual(st, 200)
        self.assertNotIn(self.K[2], [p["key"] for p in r["notebook"]["pageInfo"]])
        self.assertIn(self.K[0], [p["key"] for p in r["notebook"]["pageInfo"]])
        st, r = self.j("POST", "/api/page/delete", {"nb": "scratch", "i": 1, "key": self.K[2]})  # 再删一次：什么都不做
        self.assertEqual((st, r["notebook"]["pages"]), (200, 4))
        st, r = self.j("POST", "/api/page/insert", {"nb": "scratch", "after": 1, "afterKey": self.K[2]})
        self.assertEqual((st, r["error"]), (400, server.PAGE_DELETED))
        st, r = self.j("POST", "/api/page/delete", {"nb": "scratch", "i": 0})  # 不带键：照旧按页码
        self.assertEqual((st, r["notebook"]["pages"]), (200, 3))

    def test_new_pages_and_sent_events_carry_keys(self):
        st, r = self.j("GET", "/api/new-pages?nb=scratch")
        self.assertEqual((r["pages"], r["keys"]), ([0, 1, 2], self.K))
        self.j("GET", "/api/events?since=0&wait=0")
        seq = self.app.bridge.seq
        self.app.mark_pages_sent("scratch", {1: 5}, "r1")
        self.app.mark_cards_sent("scratch", {2: {"a": ["m"]}}, "r1")
        self.app.mark_verdicts_sent("scratch", {0: ["v"]})
        evs = {e["type"]: e for e in self.j("GET", f"/api/events?since={seq}&wait=0")[1]["events"]}
        self.assertEqual(evs["lsent"]["keys"], {"1": self.K[1]})
        self.assertEqual(evs["msent"]["keys"], {"2": self.K[2]})
        self.assertEqual(evs["vsent"]["keys"], {"0": self.K[0]})


if __name__ == "__main__":
    unittest.main()

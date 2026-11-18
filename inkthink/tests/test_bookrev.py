"""书原地更新时页的键重新编号（2026-11-17 用户定）：服务这一侧。

书一更新，原文件那些页的键按新页码重排（新版在最前面加了一页：原来的 p0001 变成 p0002），笔迹文件跟着挪。
平板在更新那一刻还有没存上的字，这些字是按旧键排队的；直接按旧键存，会存到书里别的页上，而那一页上一次也是这台存的话
还不算冲突、直接盖掉。现在平板取一页时同时拿到这本书当时更新过几次（gen，回话头 X-Page-Gen），存页、取回答时带回来；
服务发现 gen 落后了，按这之后每次更新记在 history.json 里的新旧页对照（map）把键换成新键再存。换不过来的
（那一页在新版里没了、那次更新是对照还没记下以前做的、gen 比现在还大）一个字都不写进本子，另存到 data/conflicts/，返回 410。
不带 gen 的旧请求照旧。更新书挪笔迹文件那一段、书改名挪目录那一段也拿着存页那把锁：存页、取页等它做完再按新键办。

    .venv\\Scripts\\python.exe -m unittest discover -s tests
"""
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # 单独跑这个文件时也找得到 test_server

from test_server import make_app, make_slides, stroke  # noqa: E402

import server  # noqa: E402

SLIDES = {"A": "Intro: weekend trip planner", "B": "Method: simple travel budget", "C": "Result: total cost 300 yuan",
          "D": "Summary and the next steps", "X": "Agenda for today and tomorrow", "Y": "Questions from the last meeting"}


def body(tag, rev=None, n=1):
    """一页：n 笔，id 是 tag、tag1、tag2……（看得出是哪一页的字）。rev：平板手上那一份的版本号。"""
    p = {"v": 1, "strokes": [stroke(tag + (str(k) if k else ""), 1 + k, 100, 100 + 20 * k) for k in range(n)], "ai": [], "reads": []}
    if rev is not None:
        p["rev"] = rev
    return json.dumps(p)


def ids(app, nb, i):
    return [s["id"] for s in json.loads(app.load_page(nb, i))["strokes"]]


def ink_files(app, nb):
    d = app._nb_dir(nb)
    return {p.name: p.read_bytes() for p in d.iterdir() if p.name.startswith(("page-", "blank-")) and p.suffix == ".json"}


class BookTest(unittest.TestCase):
    """一本 A B C（原文件 例会.pdf），平板（ipad）在每页上写过一笔 a b c 并存好了（各页版本号 1）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = make_app(self.tmp.name)
        self.src = Path(self.tmp.name) / "src" / "例会.pdf"
        self.src.parent.mkdir()
        make_slides(self.src, [SLIDES[k] for k in "ABC"])
        self.nb = self.app.import_document(self.src)
        for i, k in enumerate("abc"):
            self.app.put_page(self.nb, i, body(k, rev=0), client="ipad", key=f"p{i:04d}", gen=0)

    def tearDown(self):
        self.tmp.cleanup()

    def update(self, letters, src=None):
        make_slides(src or self.src, [SLIDES[k] for k in letters])
        return self.app.update_document(self.nb, src)

    def order(self, nb=None):
        nb = nb or self.nb
        info = self.app.notebook_info(nb)
        return [ids(self.app, nb, i)[:1] for i in range(info["pages"])]

    def kept(self):
        d = self.app.data / "conflicts"
        return sorted(d.iterdir()) if d.exists() else []


class LateSaveTest(BookTest):
    """App.put_page：平板拿着更新以前的页来存。"""

    def test_page_added_in_front(self):
        """新版在最前面加了一页 X：平板还按 B 原来的键 p0001（gen 0）存——存到 B 现在那一页（第 3 页，键 p0002），
        A（现在第 2 页、键 p0001，上一次也是这台存的）一个字没动；回话里是实际存到的键、现在的 gen、现在的页码。"""
        app, nb = self.app, self.nb
        self.update("XABC")
        self.assertEqual(self.order(), [[], ["a"], ["b"], ["c"]])
        res = app.put_page(nb, 1, body("b", rev=1, n=2), client="ipad", key="p0001", gen=0)
        self.assertEqual((res["key"], res["gen"], res["at"], res["deleted"]), ("p0002", 1, 2, False))
        self.assertEqual(ids(app, nb, 2), ["b", "b1"])
        self.assertEqual(ids(app, nb, 1), ["a"])
        self.assertEqual(self.kept(), [])

    def test_late_save_keeps_the_ink_that_moved(self):
        """更新时 B 以前的笔迹挪到了新键上；平板这份是在它上面接着写的（版本号对得上），存上去以前的、新写的都在，版本号接着加。"""
        app, nb = self.app, self.nb
        self.update("XABC")
        rev = app.put_page(nb, 1, body("b", rev=1, n=3), client="ipad", key="p0001", gen=0)["rev"]
        self.assertEqual(rev, 2)
        self.assertEqual(ids(app, nb, 2), ["b", "b1", "b2"])

    def test_page_removed_in_new_version(self):
        """新版里没有 B 了：平板按 B 的旧键存——一个字都不写进本子（C 现在是 p0001，也是这台存的，不能盖掉），
        这份另存到 data/conflicts/，抛 PageGone，话里说清是书更新成了新版、这一页在新版里没有了。"""
        app, nb = self.app, self.nb
        self.update("AC")
        before = ink_files(app, nb)
        with self.assertRaises(server.PageGone) as cm:
            app.put_page(nb, 1, body("b", rev=1, n=2), client="ipad", key="p0001", gen=0)
        msg = str(cm.exception)
        self.assertTrue(msg.startswith("这本在你写的时候更新成了新版，这一页在新版里没有了"), msg)
        self.assertIn("data/conflicts/", msg)
        self.assertEqual(ink_files(app, nb), before)
        self.assertEqual(self.order(), [["a"], ["c"]])
        kept = self.kept()
        self.assertEqual(len(kept), 1)
        self.assertIn(kept[0].name, msg)
        self.assertEqual([s["id"] for s in json.loads(kept[0].read_text("utf-8"))["strokes"]], ["b", "b1"])

    def test_two_updates_in_a_row(self):
        """隔了两次更新（先在前面加 X，再在前面加 Y）：gen 0 的 B（p0001）一次次换过去，存到 p0003；gen 1 的 B（p0002）也是。"""
        app, nb = self.app, self.nb
        self.update("XABC")
        self.update("YXABC")
        self.assertEqual(self.order(), [[], [], ["a"], ["b"], ["c"]])
        res = app.put_page(nb, 1, body("b", rev=1, n=2), client="ipad", key="p0001", gen=0)
        self.assertEqual((res["key"], res["gen"], res["at"]), ("p0003", 2, 3))
        res = app.put_page(nb, 2, body("b", rev=2, n=3), client="ipad", key="p0002", gen=1)
        self.assertEqual((res["key"], res["at"]), ("p0003", 3))
        self.assertEqual(ids(app, nb, 3), ["b", "b1", "b2"])
        self.assertEqual(self.order(), [[], [], ["a"], ["b"], ["c"]])

    def test_gen_that_cannot_be_followed(self):
        """换不过来的另存、不写：那次更新是对照还没记下以前做的（history.json 里没有 map），或 gen 比现在还大。"""
        app, nb = self.app, self.nb
        self.update("XABC")
        f = app._nb_dir(nb) / "history.json"
        hist = json.loads(f.read_text("utf-8"))
        del hist[0]["map"]
        f.write_text(json.dumps(hist), "utf-8")
        before = ink_files(app, nb)
        for gen in (0, 5):
            with self.assertRaises(server.PageGone):
                app.put_page(nb, 1, body("b", rev=1, n=2), client="ipad", key="p0001", gen=gen)
        self.assertEqual(ink_files(app, nb), before)
        self.assertEqual(len(self.kept()), 2)
        res = app.put_page(nb, 2, body("b", rev=1, n=2), client="ipad", key="p0002", gen=1)  # 更新以后取的：照常存
        self.assertEqual(res["key"], "p0002")

    def test_without_gen_unchanged(self):
        """不带 gen 的（这以前的页面）照旧按键存，不换键；不带键的照旧按页码存。"""
        app, nb = self.app, self.nb
        self.update("XABC")
        res = app.put_page(nb, 1, body("a", rev=1, n=2), client="ipad", key="p0001")
        self.assertEqual((res["key"], res["gen"], res["at"]), ("p0001", 1, 1))
        self.assertEqual(ids(app, nb, 1), ["a", "a1"])
        res = app.put_page(nb, 3, body("c", rev=1, n=2), client="ipad")
        self.assertEqual(res["at"], 3)
        self.assertEqual(ids(app, nb, 3), ["c", "c1"])

    def test_blank_page_key_does_not_change(self):
        """插在书里的空白纸的键更新时不变：gen 落后也照原键存，在它跟着的那一页后面。"""
        app, nb = self.app, self.nb
        b = app.insert_page(nb, 1)  # A B _ C
        key = app.page_key(nb, b)
        app.put_page(nb, b, body("_", rev=0), client="ipad", key=key, gen=0)
        self.update("XABC")
        res = app.put_page(nb, b, body("_", rev=1, n=2), client="ipad", key=key, gen=0)
        self.assertEqual((res["key"], res["at"]), (key, 3))
        self.assertEqual(self.order(), [[], ["a"], ["b"], ["_"], ["c"]])
        self.assertEqual(ids(app, nb, 3), ["_", "_1"])

    def test_other_device_wrote_after_update_is_a_conflict(self):
        """更新以后别的设备（pc）在 B 上写过：平板迟到的那份换到 B 的新键上后照旧算冲突——不盖掉 pc 写的，另存，抛 Conflict。"""
        app, nb = self.app, self.nb
        self.update("XABC")
        key, gen, text = app.page_for_tablet(nb, 2)
        self.assertEqual((key, gen), ("p0002", 1))
        app.put_page(nb, 2, body("pc", rev=json.loads(text)["rev"]), client="pc", key=key, gen=gen)
        with self.assertRaises(server.Conflict):
            app.put_page(nb, 1, body("b", rev=1, n=2), client="ipad", key="p0001", gen=0)
        self.assertEqual(ids(app, nb, 2), ["pc"])
        self.assertEqual(ids(app, nb, 1), ["a"])
        self.assertEqual(len(self.kept()), 1)

    def test_renamed_on_update(self):
        """换成另一个文件（例会_v2）时本子跟着改了名：平板拿着旧名字、旧键、gen 0 来存，存到改名以后那本里 B 的新键上。
        不带 gen 的照旧（旧名字找不到这本）。"""
        app = self.app
        v2 = self.src.with_name("例会_v2.pdf")
        new = self.update("XABC", src=v2)["id"]
        self.assertEqual(new, "book:例会_v2.pdf")
        res = app.put_page(self.nb, 1, body("b", rev=1, n=2), client="ipad", key="p0001", gen=0)
        self.assertEqual((res["key"], res["gen"], res["at"]), ("p0002", 1, 2))
        self.assertEqual(ids(app, new, 2), ["b", "b1"])
        self.assertEqual(ids(app, new, 1), ["a"])
        with self.assertRaises(KeyError):
            app.put_page(self.nb, 1, body("b", rev=2, n=3), client="ipad", key="p0002")

    def test_rename_by_hand_is_not_an_update(self):
        """平板上给书改名不算更新：gen 不变，键不换；拿着旧名字存的跟到新名字。"""
        app = self.app
        new = app.rename_notebook(self.nb, "周会")
        self.assertEqual(app.book_gen(new), 0)
        res = app.put_page(self.nb, 1, body("b", rev=1, n=2), client="ipad", key="p0001", gen=0)
        self.assertEqual((res["key"], res["gen"]), ("p0001", 0))
        self.assertEqual(ids(app, new, 1), ["b", "b1"])

    def test_history_records_the_map_and_gen(self):
        """每次更新在 history.json 里记下新旧页对照；本子信息、取页都说这本更新过几次；不是书的没有。"""
        app, nb = self.app, self.nb
        self.assertEqual((app.notebook_info(nb)["gen"], app.page_for_tablet(nb, 0)[1]), (0, 0))
        self.update("XAC")
        hist = json.loads((app._nb_dir(nb) / "history.json").read_text("utf-8"))
        self.assertEqual(hist[-1]["map"], [None, 0, 2])
        self.assertEqual((app.notebook_info(nb)["gen"], app.page_for_tablet(nb, 0)[1]), (1, 1))
        self.assertIsNone(app.page_for_tablet("scratch", 0)[1])
        self.assertNotIn("gen", app.notebook_info("scratch"))


class PendingTest(BookTest):
    """App.take_pending：取 Claude 写回、还没落到纸上的回答也按 gen 换键。"""

    def test_pending_follows_the_page(self):
        """A、B 上各有一条待落下的回答；更新后（前面加了 X）平板拿着 B 的旧键、gen 0 来取：取到的是 B 的，A 的还留着。"""
        app, nb = self.app, self.nb
        app.add_pending(nb, "p0000", {"items": [{"type": "note", "text": "给 A"}]})
        app.add_pending(nb, "p0001", {"items": [{"type": "note", "text": "给 B"}]})
        self.update("XABC")
        got = app.take_pending(nb, 1, "p0001", 0)
        self.assertEqual([e["items"][0]["text"] for e in got], ["给 B"])
        self.assertEqual([e["items"][0]["text"] for e in app.take_pending(nb, 1, "p0001", 1)], ["给 A"])

    def test_pending_of_a_removed_page_is_not_taken(self):
        """B 在新版里没了：拿着 B 的旧键来取，什么都不取（C 现在是 p0001，它的回答留着）。"""
        app, nb = self.app, self.nb
        app.add_pending(nb, "p0002", {"items": [{"type": "note", "text": "给 C"}]})
        self.update("AC")
        self.assertEqual(app.take_pending(nb, 1, "p0001", 0), [])
        self.assertEqual([e["items"][0]["text"] for e in app.take_pending(nb, 1, "p0001", 1)], ["给 C"])


class LockTest(BookTest):
    """更新书挪笔迹文件那一段、书改名那一段拿着存页那把锁；存页、取页等它做完。"""

    def during_update(self, fn):
        """更新挪完笔迹文件、还没记下这次更新时（写 seen.json 那一刻）另开一个线程做 fn；返回 (fn 的结果, 那时存页的锁拿着没有)。"""
        app, out, state = self.app, {}, {}
        orig = app._seen_by

        def hook(nb):
            state["locked"] = app.page_lock.locked()
            t = threading.Thread(target=lambda: out.setdefault("r", self._try(fn)), daemon=True)
            t.start()
            t.join(0.5)  # 没拿着锁时它这会儿就做完了（做在更新的半中间）
            state["t"] = t
            return orig(nb)

        app._seen_by = hook
        try:
            self.update("XABC")
        finally:
            app._seen_by = orig
        state["t"].join(10)
        self.assertFalse(state["t"].is_alive(), "存页一直在等：锁没放开")
        return out["r"], state["locked"]

    @staticmethod
    def _try(fn):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 —— 交回主线程比对
            return e

    def test_save_during_update_waits_then_lands_on_new_key(self):
        app, nb = self.app, self.nb
        res, locked = self.during_update(lambda: app.put_page(nb, 1, body("b", rev=1, n=2), client="ipad", key="p0001", gen=0))
        self.assertTrue(locked)
        self.assertIsInstance(res, dict, res)
        self.assertEqual((res["key"], res["gen"]), ("p0002", 1))
        self.assertEqual(self.order(), [[], ["a"], ["b"], ["c"]])
        self.assertEqual(ids(app, nb, 2), ["b", "b1"])
        self.assertEqual(self.kept(), [])

    def test_get_page_during_update_is_all_new(self):
        """更新的半中间取第 3 页：等更新做完，键、gen、数据都是新版的（不会是新数据配旧 gen）。"""
        app, nb = self.app, self.nb
        res, _ = self.during_update(lambda: app.page_for_tablet(nb, 2))
        key, gen, text = res
        self.assertEqual((key, gen, [s["id"] for s in json.loads(text)["strokes"]]), ("p0002", 1, ["b"]))

    def test_rename_holds_the_save_lock(self):
        app = self.app
        orig, seen = app.sources, []

        def spy():
            seen.append(app.page_lock.locked())
            return orig()

        app.sources = spy
        try:
            app.rename_book("例会.pdf", "周会.pdf")
        finally:
            app.sources = orig
        self.assertTrue(seen and all(seen), seen)

    def test_rename_by_hand_writes_history_under_the_save_lock(self):
        """平板上给书改名，记进 history.json 那一下也拿着存页那把锁（存页、取页按它算 gen，别读到写了一半的）。"""
        app = self.app
        orig, seen = app._nb_dir, []

        def spy(nb):
            if nb == "book:周会.pdf":
                seen.append(app.page_lock.locked())
            return orig(nb)

        app._nb_dir = spy
        try:
            app.rename_notebook(self.nb, "周会")
        finally:
            app._nb_dir = orig
        self.assertTrue(seen and all(seen), seen)

    def test_no_deadlock_with_saves_and_page_edits(self):
        """一边更新、一边不停地存页、取页、取回答、插页：都做完，没有谁一直等着谁。"""
        app, nb = self.app, self.nb
        stop, errors = threading.Event(), []

        def worker(k):
            n = 0
            while not stop.is_set():
                n += 1
                try:
                    key, gen, text = app.page_for_tablet(nb, 0)
                    app.put_page(nb, 0, body("w", rev=json.loads(text).get("rev", 0)), client=f"w{k}", key=key, gen=gen)
                    app.take_pending(nb, 0, key, gen)
                    if n % 5 == 0:
                        app.insert_page(nb, 0)
                except (server.Conflict, server.PageGone):
                    pass
                except Exception as e:  # noqa: BLE001
                    errors.append(e)

        ts = [threading.Thread(target=worker, args=(k,), daemon=True) for k in range(3)]
        for t in ts:
            t.start()
        done = threading.Event()

        def upd():
            self.update("XABC")
            self.update("YXABC")
            done.set()

        u = threading.Thread(target=upd, daemon=True)
        u.start()
        u.join(60)
        stop.set()
        for t in ts:
            t.join(10)
        self.assertTrue(done.is_set(), "更新一直没做完")
        self.assertFalse(any(t.is_alive() for t in ts), "存页一直没做完")
        self.assertEqual(errors, [])
        self.assertEqual(app.book_gen(nb), 2)


class BookRevHttpTest(unittest.TestCase):
    """HTTP 接口：GET /api/page 的 X-Page-Gen、PUT 带 gen 的回话、410、取回答带 gen。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = make_app(self.tmp.name)
        server.Handler.app = self.app
        self.httpd = server.Server(("127.0.0.1", 0), server.Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.src = Path(self.tmp.name) / "src" / "例会.pdf"
        self.src.parent.mkdir()
        make_slides(self.src, [SLIDES[k] for k in "ABC"])
        self.nb = self.app.import_document(self.src)
        self.q = urllib.request.quote(self.nb)
        for i, k in enumerate("abc"):
            self.app.put_page(self.nb, i, body(k, rev=0), client="ipad", key=f"p{i:04d}", gen=0)

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def call(self, method, path, data=None, headers=None):
        raw = data.encode() if isinstance(data, str) else data
        req = urllib.request.Request(self.base + path, data=raw, method=method)
        req.add_header("X-Access", self.app.code)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        if raw is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def put(self, i, key, gen, data):
        st, _, raw = self.call("PUT", f"/api/page?nb={self.q}&i={i}&key={key}" + (f"&gen={gen}" if gen is not None else ""),
                               data, {"X-Client": "ipad"})
        return st, json.loads(raw)

    def test_get_page_tells_gen(self):
        st, hd, _ = self.call("GET", f"/api/page?nb={self.q}&i=1")
        self.assertEqual((st, hd.get("X-Page-Key"), hd.get("X-Page-Gen")), (200, "p0001", "0"))
        make_slides(self.src, [SLIDES[k] for k in "XABC"])
        self.app.update_document(self.nb)
        st, hd, raw = self.call("GET", f"/api/page?nb={self.q}&i=2")
        self.assertEqual((hd.get("X-Page-Key"), hd.get("X-Page-Gen"), json.loads(raw)["strokes"][0]["id"]), ("p0002", "1", "b"))
        st, hd, _ = self.call("GET", "/api/page?nb=scratch&i=0")
        self.assertEqual((st, hd.get("X-Page-Gen")), (200, None))  # 不是书：没有

    def test_put_with_gen(self):
        make_slides(self.src, [SLIDES[k] for k in "XABC"])
        self.app.update_document(self.nb)
        st, r = self.put(1, "p0001", 0, body("b", rev=1, n=2))
        self.assertEqual((st, r["ok"], r["key"], r["gen"], r["at"]), (200, True, "p0002", 1, 2))
        self.assertEqual(ids(self.app, self.nb, 2), ["b", "b1"])
        st, r = self.put(1, "p0001", "x", body("b"))
        self.assertEqual(st, 400)

    def test_put_page_gone_after_update(self):
        make_slides(self.src, [SLIDES[k] for k in "AC"])
        self.app.update_document(self.nb)
        st, r = self.put(1, "p0001", 0, body("b", rev=1, n=2))
        self.assertEqual((st, r.get("pageGone")), (410, True))
        self.assertTrue(r["error"].startswith("这本在你写的时候更新成了新版"), r)
        self.assertEqual(ids(self.app, self.nb, 1), ["c"])

    def test_pending_with_gen(self):
        self.app.add_pending(self.nb, "p0001", {"items": [{"type": "note", "text": "给 B"}]})
        make_slides(self.src, [SLIDES[k] for k in "XABC"])
        self.app.update_document(self.nb)
        st, _, raw = self.call("GET", f"/api/pending?nb={self.q}&i=1&key=p0001&gen=0")
        self.assertEqual((st, [e["items"][0]["text"] for e in json.loads(raw)]), (200, ["给 B"]))


if __name__ == "__main__":
    unittest.main()

"""复制本子、复制一页（2026-11-18 用户提的：「还希望保留复制草稿纸的功能，这样可以更改批注或者留一份有标注一份没标注」；
弹窗里定的「整本和单页都能复制，复制时选带什么」；《产品定义》第 2 节「复制本子、复制一页」）。服务这一侧：
- 三种：all 全部照样、noai 不带 AI 的蓝字（page.ai、读法、卡片上的红字、还没落到纸上的写回都不带）、ink 只留黑笔（再去掉红笔）。
  擦掉的、删掉的页从来不带。
- 副本和原来那本互不相干：改一边另一边不变；复制以前交出去的投递写回时只落到原来那本；从副本上交出去的落到副本。
- 名字「原名 副本」，重名的加 2、3……（英文界面平板给 copy）；排在原来那本后面、同一个文件夹里；「这本发往」「只在本地」照原来的。
- 中途出错不留半截的本子；推送本子不能复制；复制一页只复制空白纸。
例子都是编的（随笔、想法、例会）。"""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf as fitz  # noqa: E402

import test_server as ts  # noqa: E402  （不把 HttpTest 这个名字引进来：引进来的话这个文件会把它的测试再跑一遍）

import folders  # noqa: E402
import server  # noqa: E402

T = 1_700_000_000_000


def full_page():
    """一页什么都有的：黑笔、红笔、擦掉的一笔；短批注、带卡片红字的长回答（一笔红字擦掉了）、擦掉的批注、一张图；读法、交到哪一笔为止。"""
    return {
        "v": 1, "rev": 7, "by": "dev-x", "h": 1600, "lastSent": T + 500,
        "strokes": [ts.stroke("k1", T, 100, 100), ts.stroke("r1", T + 100, 100, 200, red=True),
                    dict(ts.stroke("e1", T + 200, 100, 300), erasedAt=T + 900)],
        "ai": [{"id": "n1", "type": "note", "on": ["k1"], "text": "单位对吗", "req": "sub-old"},
               {"id": "w1", "type": "write", "at": [700, 150], "n": 1, "text": "长回答", "q": "为什么", "on": ["r1"], "req": "sub-old",
                "author": {"sid": "A", "label": "proj"},
                "marks": [{"id": "m1", "blk": "w1", "pts": [[1, 2, 0.5, 0]], "t0": T, "w": 2, "c": "r"},
                          {"id": "m2", "blk": "w1", "pts": [[1, 2, 0.5, 0]], "t0": T, "w": 2, "c": "r", "erasedAt": T + 5}]},
               {"id": "x1", "type": "note", "on": ["k1"], "text": "擦掉的", "erasedAt": T + 800},
               {"id": "f1", "type": "figure", "img": "0123456789abcdef.png", "box": [100, 400, 300, 500]}],
        "reads": [{"g": "g1", "text": "F = m a"}],
    }


class CopyTest(unittest.TestCase):
    setUp = ts.HttpTest.setUp
    tearDown = ts.HttpTest.tearDown
    call = ts.HttpTest.call
    j = ts.HttpTest.j

    def pad(self, title, **extra):
        st, r = self.j("POST", "/api/notebook/new", dict({"title": title}, **extra))
        self.assertEqual(st, 200, r)
        return r["id"]

    def copy(self, nb, mode="all", status=200, **extra):
        st, r = self.j("POST", "/api/notebook/copy", dict({"nb": nb, "mode": mode}, **extra))
        self.assertEqual(st, status, r)
        return r

    def page(self, nb, i):
        return json.loads(self.app.load_page(nb, i))

    def keys(self, nb):
        return [e["key"] for e in self.app.layout_of(nb).pages]

    def filled_pad(self, title="随笔"):
        """两页的本子：第 1 页什么都有，第 2 页（插进来的空白纸）一笔黑的；另有一页删掉了。"""
        nb = self.pad(title, paper="landscape")
        self.app.save_page(nb, 0, json.dumps(full_page()))
        self.app.insert_page(nb, 0)
        self.app.save_page(nb, 1, json.dumps({"v": 1, "strokes": [ts.stroke("k2", T, 50, 50)], "ai": [], "reads": []}))
        self.app.insert_page(nb, 1)
        self.app.save_page(nb, 2, json.dumps({"v": 1, "strokes": [ts.stroke("gone", T, 50, 50)], "ai": [], "reads": []}))
        self.app.delete_page(nb, 2)
        return nb

    # -- 带什么

    def test_three_modes_keep_and_drop(self):
        nb = self.filled_pad()
        self.app.set_setting(nb, "flow", True)
        self.app.add_pending(nb, self.keys(nb)[0], {"req": "sub-old", "items": [{"type": "note", "anchor": "g1", "text": "还没落到纸上"}], "t": 1})
        self.app.add_pending(nb, self.keys(nb)[0], {"req": "sub-old", "msent": ["m1"]})  # 只是记账的
        before = {k: self.page(nb, i) for i, k in enumerate(self.keys(nb))}
        got = {}
        for mode in ("all", "noai", "ink"):
            r = self.copy(nb, mode)
            new = r["id"]
            got[mode] = new
            self.assertTrue(new.startswith("pad:") and new != nb)
            self.assertEqual(self.keys(new), self.keys(nb))                       # 页序、页的键照原来
            self.assertEqual(self.app.layout_of(new).hidden, [])                 # 删掉的页不带
            d = self.app._nb_dir(new)
            self.assertFalse(any(d.glob("*gone*")))
            self.assertEqual(self.app.setting(new, "paper"), "landscape")         # 纸张方向、连续 / 单页照原来
            self.assertTrue(self.app.setting(new, "flow"))
            p0, p1 = self.page(new, 0), self.page(new, 1)
            self.assertEqual(p0["h"], 1600)                                        # 纸的大小照原来
            self.assertNotIn("rev", p0)                                            # 版本号从头算
            self.assertNotIn("by", p0)
            self.assertNotIn("e1", [s["id"] for s in p0["strokes"]])              # 擦掉的一笔不带
            self.assertEqual([s["id"] for s in p1["strokes"]], ["k2"])
            ids = [a["id"] for a in p0["ai"]]
            pend = d / (Path(self.app._key_file(new, self.keys(new)[0], ".pending.json")).name)
            if mode == "all":
                self.assertEqual([s["id"] for s in p0["strokes"]], ["k1", "r1"])
                self.assertEqual(ids, ["n1", "w1", "f1"])                          # 擦掉的批注不带
                self.assertEqual([m["id"] for m in p0["ai"][1]["marks"]], ["m1"])  # 卡片上的红字带（擦掉的那笔不带）
                self.assertEqual(p0["reads"], full_page()["reads"])
                self.assertEqual(p0["lastSent"], T + 500)
                entries = json.loads(pend.read_text("utf-8"))                      # 还没落到纸上的写回带上；记账的不带
                self.assertEqual([e.get("items") for e in entries], [[{"type": "note", "anchor": "g1", "text": "还没落到纸上"}]])
                self.assertTrue(self.app.reply_waiting(new, self.keys(new)[0]))
            else:
                self.assertEqual(ids, [])
                self.assertEqual(p0["reads"], [])
                self.assertNotIn("lastSent", p0)
                self.assertFalse(pend.exists())
                want = ["k1", "r1"] if mode == "noai" else ["k1"]                 # 只留黑笔：红笔也不带
                self.assertEqual([s["id"] for s in p0["strokes"]], want)
        # 原来那本一个字没动（待处理的两条也都还在）
        self.assertEqual({k: self.page(nb, i) for i, k in enumerate(self.keys(nb))}, before)
        self.assertEqual(len(json.loads(self.app._key_file(nb, self.keys(nb)[0], ".pending.json").read_text("utf-8"))), 2)
        # 不认得的带法、不认得的本子
        self.copy(nb, "half", status=400)
        self.copy("pad:nope", status=404)

    # -- 互不相干

    def test_copy_is_independent_both_ways(self):
        nb = self.pad("随笔")
        self.app.save_page(nb, 0, json.dumps(full_page()))
        (self.app._nb_dir(nb) / "seen.json").write_text(json.dumps({"by": {"A": {"p0000": T}}}), "utf-8")
        d = Path(self.tmp.name) / "proj"
        d.mkdir()
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "proj", "cwd": str(d)})
        sent = self.j("POST", "/api/send", ts.send_payload(target="A", nb=nb))[1]  # 复制以前交出去的
        new = self.copy(nb)["id"]
        self.assertFalse((self.app._nb_dir(new) / "seen.json").exists())          # 看到哪一笔为止不带：副本对哪个对话都是新的
        # 那次投递写回：只落到原来那本
        st, _ = self.j("POST", "/bridge/reply", {"sid": "A", "submission": sent["id"], "items": [{"type": "note", "anchor": "g2", "text": "写给原来那本"}]})
        self.assertEqual(st, 200)
        self.assertTrue(self.app.reply_waiting(nb, "p0000"))
        self.assertFalse(self.app.reply_waiting(new, "p0000"))
        # 从副本上交出去的（卡片上的「再短点」）：记着的是副本，写回落到副本
        st, redo = self.j("POST", "/api/redo", {"nb": new, "page": 0, "key": "p0000", "id": "w1", "want": "brief"})
        self.assertEqual(st, 200, redo)
        meta = json.loads((self.app.data / "submissions" / redo["id"] / "meta.json").read_text("utf-8"))
        self.assertEqual((meta["nb"], meta["page_key"]), (new, "p0000"))
        self.app.take_pending(nb, 0, "p0000")
        st, _ = self.j("POST", "/bridge/reply", {"sid": "A", "submission": redo["id"], "items": [{"type": "write", "text": "短一点"}]})
        self.assertEqual(st, 200)
        self.assertTrue(self.app.reply_waiting(new, "p0000"))
        self.assertFalse(self.app.reply_waiting(nb, "p0000"))
        # 改一边，另一边不变
        p = self.page(nb, 0)
        p["strokes"].append(ts.stroke("only-orig", T + 9, 300, 300))
        self.app.save_page(nb, 0, json.dumps(p))
        self.assertNotIn("only-orig", [s["id"] for s in self.page(new, 0)["strokes"]])
        q = self.page(new, 0)
        q["ai"] = []
        self.app.save_page(new, 0, json.dumps(q))
        self.assertEqual([a["id"] for a in self.page(nb, 0)["ai"]], ["n1", "w1", "x1", "f1"])
        # 原来那本删掉、改名：副本照旧在
        self.j("POST", "/api/notebook/rename", {"nb": nb, "title": "改过名的"})
        self.j("POST", "/api/notebook/delete", {"nb": nb})
        self.assertIn(new, self.app.nb_ids())
        self.assertEqual(self.page(new, 0)["ai"], [])

    # -- 名字、放在哪

    def test_names_and_where_the_copy_goes(self):
        a, b, c = self.pad("随笔"), self.pad("想法"), self.pad("读书笔记")
        f1 = self.j("POST", "/api/folders/new", {"name": "课题"})[1]["id"]
        self.j("POST", "/api/folders/place", {"id": c, "into": f1, "after": ""})
        self.j("POST", "/api/folders/place", {"id": a, "into": f1, "after": c})   # 课题里：读书笔记、随笔（排过）
        n0 = len(self.app.bridge.events)
        r = self.copy(c)
        self.assertEqual(r["title"], "读书笔记 副本")
        self.assertEqual(r["folders"][0]["items"], [c, r["id"], a])               # 同一个文件夹里、紧跟在原来那本后面
        self.assertTrue(any(e["type"] == "folders" for e in self.app.bridge.events[n0:]))  # 别的设备上的抽屉跟着刷新
        r2 = self.copy(c)
        self.assertEqual(r2["title"], "读书笔记 副本 2")                          # 重名加 2、3……
        self.assertEqual(r2["folders"][0]["items"], [c, r2["id"], r["id"], a])
        # 最外层：排在原来那本后面
        r3 = self.copy(b)
        self.assertEqual(r3["top"], [f1, b, r3["id"]])
        # 英文界面：平板给原名和 copy
        self.assertEqual(self.copy(b, base="Ideas", suffix="copy")["title"], "Ideas copy")
        self.assertEqual(self.copy(b, base="Ideas", suffix="copy")["title"], "Ideas copy 2")
        # 草稿本的副本：一本普通的本子，排在最上面（草稿本下面）
        self.app.save_page("scratch", 0, json.dumps(full_page()))
        rs = self.copy("scratch")
        self.assertTrue(rs["id"].startswith("pad:"))
        self.assertEqual((rs["title"], rs["top"][0]), ("草稿本 副本", rs["id"]))
        self.assertEqual([s["id"] for s in self.page(rs["id"], 0)["strokes"]], ["k1", "r1"])
        # 名字太长：截原名，后缀留着；文件名不能用的字去掉
        long = self.pad("长" * 40)
        t = self.copy(long)["title"]
        self.assertTrue(len(t) <= 40 and t.endswith(" 副本"), t)
        self.assertEqual(self.copy(a, base="a/b:c")["title"], "abc 副本")
        # 重启服务：副本和它的位置都还在
        again = ts.make_app(self.tmp.name)
        self.assertEqual(again.folder_view()["folders"][0]["items"][:2], [c, r2["id"]])
        self.assertIn("读书笔记 副本", [n["title"] for n in again.notebooks()])

    def test_local_only_and_target_carry_over(self):
        nb = self.pad("随笔")
        self.app.set_setting(nb, "local", True)
        self.app.set_setting(nb, "target", {"sid": "A", "label": "proj", "cwd": "E:\\proj"})
        new = self.copy(nb, "ink")["id"]
        self.assertTrue(self.app.is_local(new))                                    # 只在本地的副本也只在本地
        self.assertEqual(self.app.setting(new, "target")["label"], "proj")         # 「这本发往」照原来
        self.assertTrue(next(n for n in self.j("GET", "/api/notebooks")[1] if n["id"] == new).get("local"))

    # -- 出错不留半截

    def test_failure_leaves_no_half_copy(self):
        nb = self.filled_pad()
        root = self.app.data / "notebooks"

        def state():
            return (sorted(p.name for p in root.iterdir()), (root / "pads.json").read_text("utf-8"),
                    folders.path_of(self.app.data).read_text("utf-8") if folders.path_of(self.app.data).exists() else None,
                    sorted(p.name for p in self.app.books.iterdir()))
        self.app.notebooks()  # 列一次本子（草稿本的文件夹在列的时候建好，平板打开时也一样），下面比的只是复制留下了什么
        before = state()
        calls, orig = [], server.copy_page_data

        def boom(page, mode):
            calls.append(1)
            if len(calls) == 2:
                raise OSError("磁盘满了")
            return orig(page, mode)
        with mock.patch.object(server, "copy_page_data", boom):
            self.assertEqual(self.j("POST", "/api/notebook/copy", {"nb": nb})[0], 500)
        self.assertEqual(len(calls), 2)                                            # 真在第二页上出的错
        self.assertEqual(state(), before)
        # 最后一步（登记进本子列表）出错：已经换上去的文件夹也拿掉
        with mock.patch.object(self.app, "_save_pads", side_effect=OSError("写不进去")):
            with self.assertRaises(OSError):
                self.app.copy_notebook(nb)
        self.assertEqual(state(), before)
        # 书：PDF 另存时出错，books 里不留半截的文件
        ts.make_pdf(self.app.books / "例会.pdf", pages=2)
        self.app.notebook_info("book:例会.pdf")
        before = state()
        with mock.patch.object(server.shutil, "copyfile", side_effect=OSError("磁盘满了")):
            with self.assertRaises(OSError):
                self.app.copy_notebook("book:例会.pdf")
        self.assertEqual(state(), before)

    # -- 书、推送本子

    def test_book_copy_is_a_separate_book(self):
        src = Path(self.tmp.name) / "src"
        src.mkdir()
        ts.make_pdf(src / "例会_v47.pdf", pages=3)
        book = self.app.import_document(src / "例会_v47.pdf")
        self.app.save_page(book, 0, json.dumps(full_page()))
        self.app.insert_page(book, 0)                                               # 书里插的空白纸
        self.app.save_page(book, 1, json.dumps({"v": 1, "strokes": [ts.stroke("k2", T, 50, 50)], "ai": [], "reads": []}))
        self.app.delete_page(book, 3)                                              # 删掉原文件的第 3 页
        self.app.set_setting(book, "flow", False)
        r = self.copy(book, "noai", base="例会_v47")
        new = r["id"]
        self.assertEqual((new, r["title"]), ("book:例会_v47 副本.pdf", "例会_v47 副本"))
        self.assertTrue((self.app.books / "例会_v47 副本.pdf").is_file())         # PDF 另存一份
        self.assertEqual(self.keys(new), self.keys(book))
        self.assertEqual([h["entry"]["key"] for h in self.app.layout_of(new).hidden], ["p0002"])  # 删掉的原文件页照旧删着
        self.assertEqual(self.app.notebook_info(new)["pages"], 3)
        self.assertEqual([s["id"] for s in self.page(new, 0)["strokes"]], ["k1", "r1"])
        self.assertEqual(self.page(new, 0)["ai"], [])
        self.assertEqual([s["id"] for s in self.page(new, 1)["strokes"]], ["k2"])
        self.assertFalse(self.app.setting(new, "flow"))
        self.assertNotIn("例会_v47 副本.pdf", self.app.sources())                  # 不跟原文件走
        self.assertEqual(self.app.book_updates(new), [])
        # 原来那本更新成新版：副本不跟着变
        ts.make_pdf(src / "例会_v47.pdf", text="v47 改过", pages=3)
        self.app.update_document(book)
        self.assertEqual([s["id"] for s in self.page(new, 0)["strokes"]], ["k1", "r1"])
        self.assertEqual(self.keys(new)[:2], ["p0000", self.keys(new)[1]])
        # 书名重名（文件名也算）：加 2
        self.assertEqual(self.copy(book, base="例会_v47")["title"], "例会_v47 副本 2")
        # 复制一页：书页不行（底图是原文件的一页），书里插的空白纸可以
        st, err = self.j("POST", "/api/page/copy", {"nb": book, "page": 0, "key": "p0000"})
        self.assertEqual(st, 400)
        self.assertIn("只有空白纸能复制", err["error"])
        bk = self.keys(book)[1]
        st, r = self.j("POST", "/api/page/copy", {"nb": book, "page": 1, "key": bk})
        self.assertEqual((st, r["page"]), (200, 2), r)

    def test_push_books_cannot_be_copied(self):
        d = Path(self.tmp.name) / "proj"
        d.mkdir()
        self.j("POST", "/bridge/hello", {"sid": "S1", "label": "proj", "cwd": str(d)})
        img = Path(self.tmp.name) / "花园.png"
        fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 60, 40), 0).save(str(img))
        self.assertEqual(self.j("POST", "/bridge/show", {"sid": "S1", "path": str(img)})[0], 200)
        board = next(i for i in self.app.nb_seq() if i.startswith("board:"))
        seq = self.app.nb_seq()
        r = self.copy(board, status=400)
        self.assertIn("推送的本子还不能复制", r["error"])
        self.assertEqual(self.app.nb_seq(), seq)
        st, err = self.j("POST", "/api/page/copy", {"nb": board, "page": 0, "key": "p0000"})
        self.assertEqual(st, 400)
        self.assertIn("只有空白纸能复制", err["error"])

    # -- 复制一页

    def test_copy_one_page(self):
        nb = self.pad("随笔")
        self.app.save_page(nb, 0, json.dumps(full_page()))
        self.app.insert_page(nb, 0)                                                # 后面还有一页：新页插在两页中间
        self.app.add_pending(nb, "p0000", {"req": "sub-old", "items": [{"type": "note", "text": "还没落到纸上"}]})
        k0, k1 = self.keys(nb)
        lay = self.app.layout_of(nb)
        lay.pages[0]["orient"] = "landscape"
        lay.save()
        for mode, strokes, ai in (("all", ["k1", "r1"], ["n1", "w1", "f1"]), ("noai", ["k1", "r1"], []), ("ink", ["k1"], [])):
            st, r = self.j("POST", "/api/page/copy", {"nb": nb, "page": 0, "key": k0, "mode": mode})
            self.assertEqual((st, r["page"]), (200, 1), r)
            keys = self.keys(nb)
            self.assertEqual((keys[0], keys[-1]), (k0, k1))                        # 接在这一页后面
            new = keys[1]
            self.assertTrue(new.startswith("b") and new not in (k0, k1))            # 自己的键
            self.assertEqual(r["notebook"]["pages"], len(keys))
            self.assertEqual(self.app.layout_of(nb).pages[1].get("orient"), "landscape")  # 纸的方向照原来
            p = self.page(nb, 1)
            self.assertEqual(([s["id"] for s in p["strokes"]], [a["id"] for a in p["ai"]]), (strokes, ai), mode)
            self.assertEqual(self.app.reply_waiting(nb, new), mode == "all")
        self.assertEqual(len(self.keys(nb)), 5)
        self.assertEqual([s["id"] for s in self.page(nb, 0)["strokes"]], ["k1", "r1", "e1"])  # 原来那一页不动
        self.assertTrue(self.app.reply_waiting(nb, k0))
        # 撤销：按键删掉新的那一页（平板上的「撤销」走的就是删页）
        new = self.keys(nb)[1]
        st, r = self.j("POST", "/api/page/delete", {"nb": nb, "i": 1, "key": new})
        self.assertEqual(st, 200)
        self.assertNotIn(new, self.keys(nb))
        # 那一页已经删掉了（别的设备上）：不复制
        st, err = self.j("POST", "/api/page/copy", {"nb": nb, "page": 1, "key": new})
        self.assertEqual(st, 400)
        self.assertIn("删", err["error"])
        self.assertEqual(self.j("POST", "/api/page/copy", {"nb": nb, "page": 0, "key": k0, "mode": "half"})[0], 400)
        # 草稿本也能复制一页
        self.app.save_page("scratch", 0, json.dumps(full_page()))
        st, r = self.j("POST", "/api/page/copy", {"nb": "scratch", "page": 0, "key": self.keys("scratch")[0], "mode": "ink"})
        self.assertEqual((st, r["page"]), (200, 1))
        self.assertEqual([s["id"] for s in self.page("scratch", 1)["strokes"]], ["k1"])

    def test_page_copy_failure_leaves_no_file(self):
        nb = self.pad("随笔")
        self.app.save_page(nb, 0, json.dumps(full_page()))
        d = self.app._nb_dir(nb)
        before = sorted(p.name for p in d.iterdir())
        with mock.patch.object(server.layout.Layout, "save", side_effect=OSError("写不进去")):
            self.assertEqual(self.j("POST", "/api/page/copy", {"nb": nb, "page": 0, "key": "p0000"})[0], 500)
        self.assertEqual(sorted(p.name for p in d.iterdir()), before)
        self.assertEqual(self.keys(nb), ["p0000"])


if __name__ == "__main__":
    unittest.main()

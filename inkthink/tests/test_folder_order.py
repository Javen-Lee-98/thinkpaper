"""抽屉里文件夹和本子的上下顺序、文件夹里的新建（2026-11-18 用户定，《产品定义》第 2 节「抽屉里再补两样小的」）。服务这一侧：
- 顺序记在 notebooks/folders.json（最外层的 top、文件夹里的 items 加 ordered），各台设备一样，服务重启后还在。
- 没排过的照原来的顺序（文件夹在前、按建立的先后，接着是不在文件夹里的本子，按 /api/notebooks 的先后）；排好的和原来一样时不记。
- 排过以后才有的（新建、新导入的本子，新的推送本子，新建的文件夹，移出文件夹的本子）跟在原来顺序里它前面、又记着的那一个后面。
- 草稿本不能挪；文件夹不能放进文件夹；不认得的本子、文件夹报 404。
- 本子删了、改名（书改名、换成新版时 id 会变）、放进文件夹，记的顺序跟着改，不留下对不上的记录；删文件夹时里面的本子排在它原来的位置。
- /api/notebook/new 带 folder 就直接建在那个文件夹里；文件夹不在了照样建，放在外面，回话里 folder 为空。
例子都是编的（随笔、想法、例会）。"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf as fitz  # noqa: E402

import test_server as ts  # noqa: E402  （不把 HttpTest 这个名字引进来：引进来的话这个文件会把它的测试再跑一遍）

import folders  # noqa: E402


class OrderLogicTest(unittest.TestCase):
    """folders.py 里排顺序的几个函数，只在一个临时文件夹上读写。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        self.seq = ["scratch", "pad:a", "pad:b", "pad:c", "book:x.pdf"]

    def tearDown(self):
        self.tmp.cleanup()

    def fs(self, *specs, top=None):
        out = folders.Folders()
        for fid, items in specs:
            out.append({"id": fid, "name": fid, "items": list(items)})
        out.top = top
        return out

    def test_natural_order_when_never_sorted(self):
        fs = self.fs(("f-1", ["pad:b"]), ("f-2", []))
        self.assertEqual(folders.top_order(fs, self.seq), ["f-1", "f-2", "pad:a", "pad:c", "book:x.pdf"])
        self.assertEqual(folders.folder_items({"id": "f", "items": ["book:x.pdf", "pad:a", "pad:gone"]}, self.seq),
                         ["pad:a", "book:x.pdf"])  # 没排过的文件夹按原来的先后，不在了的不列
        self.assertEqual(folders.folder_items({"id": "f", "items": ["book:x.pdf", "pad:a", "pad:gone"], "ordered": True}, self.seq),
                         ["book:x.pdf", "pad:a"])  # 排过的按记下的

    def test_new_ones_land_next_to_their_old_neighbour(self):
        fs = self.fs(("f-1", []), top=["pad:b", "f-1", "pad:a"])
        seq = ["scratch", "pad:a", "pad:b", "pad:new", "book:a.pdf", "book:x.pdf"]
        # pad:new 原来排在 pad:b 后面；book:a.pdf 原来在 pad:new 后面（pad:new 没记着，再往前找到 pad:b）；book:x.pdf 同理
        self.assertEqual(folders.top_order(fs, seq), ["pad:b", "pad:new", "book:a.pdf", "book:x.pdf", "f-1", "pad:a"])
        fs.append({"id": "f-2", "name": "f-2", "items": []})  # 新建的文件夹：原来排在 f-1 后面
        self.assertEqual(folders.top_order(fs, seq)[-3:], ["f-1", "f-2", "pad:a"])
        fs2 = self.fs(top=["pad:b", "pad:a"])  # 原来排在最前、前面没有记着的：排在最前
        self.assertEqual(folders.top_order(fs2, ["scratch", "pad:0", "pad:a", "pad:b"]), ["pad:0", "pad:b", "pad:a"])

    def test_place_at_top_level(self):
        fs = self.fs(("f-1", ["pad:b"]))
        folders.place(fs, self.seq, "pad:c", "", after="", before="f-1")         # 排到最前
        self.assertEqual(fs.top, ["pad:c", "f-1", "pad:a", "book:x.pdf"])
        folders.place(fs, self.seq, "f-1", "", after="book:x.pdf")               # 文件夹也能挪，排到最后
        self.assertEqual(folders.top_order(fs, self.seq), ["pad:c", "pad:a", "book:x.pdf", "f-1"])
        folders.place(fs, self.seq, "pad:b", "", after="pad:c")                  # 文件夹里的拿出来，排在 pad:c 后面
        self.assertEqual((fs[0]["items"], folders.top_order(fs, self.seq)), ([], ["pad:c", "pad:b", "pad:a", "book:x.pdf", "f-1"]))
        folders.place(fs, self.seq, "pad:c", "", after="gone", before="f-1")     # after 对不上：排在 before 前面
        self.assertEqual(folders.top_order(fs, self.seq), ["pad:b", "pad:a", "book:x.pdf", "pad:c", "f-1"])
        folders.place(fs, self.seq, "pad:c", "", after="gone", before="gone")    # 都对不上：排在最后
        self.assertEqual(folders.top_order(fs, self.seq)[-1], "pad:c")
        # 排回原来的顺序：不再记（以后照原来的规矩排）
        fs = self.fs(("f-1", []))
        folders.place(fs, self.seq, "pad:a", "", after="pad:b")
        self.assertIsNotNone(fs.top)
        folders.place(fs, self.seq, "pad:a", "", after="f-1")
        self.assertIsNone(fs.top)

    def test_place_inside_folder(self):
        fs = self.fs(("f-1", ["pad:c", "pad:a", "pad:gone"]))
        folders.place(fs, self.seq, "pad:a", "f-1", after="pad:c")               # 本来就是原来的先后（a 在 c 前）的反面：记下
        self.assertEqual((fs[0]["items"], fs[0].get("ordered")), (["pad:c", "pad:a", "pad:gone"], True))
        folders.place(fs, self.seq, "pad:b", "f-1", after="")                    # 外面的放进来、排在最前
        self.assertEqual(folders.folder_items(fs[0], self.seq), ["pad:b", "pad:c", "pad:a"])
        self.assertEqual(fs[0]["items"][-1], "pad:gone")                         # 不认得的照旧留着，不丢
        folders.place(fs, self.seq, "pad:c", "f-1", after="pad:b")               # 和原来的先后一样了：不再记 ordered
        folders.place(fs, self.seq, "pad:a", "f-1", after="")
        self.assertEqual(folders.folder_items(fs[0], self.seq), ["pad:a", "pad:b", "pad:c"])
        self.assertNotIn("ordered", fs[0])

    def test_refuses(self):
        fs = self.fs(("f-1", []), ("f-2", []))
        with self.assertRaises(ValueError):
            folders.place(fs, self.seq, "scratch", "", after="")
        with self.assertRaises(ValueError):
            folders.place(fs, self.seq, "f-1", "f-2")
        with self.assertRaises(KeyError):
            folders.place(fs, self.seq, "pad:nope", "")
        with self.assertRaises(KeyError):
            folders.place(fs, self.seq, "pad:a", "f-nope")

    def test_forget_rename_delete_keep_order_clean(self):
        fs = self.fs(("f-1", ["pad:b"]), top=["pad:c", "f-1", "book:x.pdf", "pad:a"])
        self.assertTrue(folders.forget(fs, "pad:c"))                             # 本子删了：顺序里不再记它
        self.assertEqual(fs.top, ["f-1", "book:x.pdf", "pad:a"])
        self.assertTrue(folders.rename_member(fs, "book:x.pdf", "book:y.pdf"))   # 书改名：顺序里跟着换，位置不变
        self.assertEqual(fs.top, ["f-1", "book:y.pdf", "pad:a"])
        folders.move(fs, "pad:a", "f-1")                                         # 放进文件夹：最外层不再记它
        self.assertEqual(fs.top, ["f-1", "book:y.pdf"])
        folders.delete(fs, "f-1", ["scratch", "pad:a", "pad:b", "book:y.pdf"])   # 删文件夹：里面的排在它原来的位置
        self.assertEqual(fs.top, ["pad:a", "pad:b", "book:y.pdf"])
        self.assertFalse(folders.rename_member(fs, "pad:zz", "pad:yy"))

    def test_save_load_round_trip(self):
        fs = self.fs(("f-1", ["pad:b", "pad:a"]), top=["pad:c", "f-1"])
        fs[0]["ordered"] = True
        folders.save(self.data, fs)
        got = folders.load(self.data)
        self.assertEqual((got.top, got[0].get("ordered"), got), (["pad:c", "f-1"], True, list(fs)))
        got.top = None                                                           # 和原来一样了：文件里不写 top
        folders.save(self.data, got)
        self.assertNotIn("top", json.loads(folders.path_of(self.data).read_text("utf-8")))
        raw = {"v": 1, "folders": [], "top": ["scratch", "pad:a", 3, "pad:a", ""]}  # 手改坏的：草稿本、重复、不是字的都不算
        folders.path_of(self.data).write_text(json.dumps(raw), "utf-8")
        self.assertEqual(folders.load(self.data).top, ["pad:a"])


class OrderHttpTest(unittest.TestCase):
    setUp = ts.HttpTest.setUp
    tearDown = ts.HttpTest.tearDown
    call = ts.HttpTest.call
    j = ts.HttpTest.j

    def view(self):
        st, r = self.j("GET", "/api/folders")
        self.assertEqual(st, 200, r)
        return r

    def place(self, x, into="", after="", before="", status=200):
        st, r = self.j("POST", "/api/folders/place", {"id": x, "into": into, "after": after, "before": before})
        self.assertEqual(st, status, r)
        return r

    def pad(self, title, **extra):
        st, r = self.j("POST", "/api/notebook/new", dict({"title": title}, **extra))
        self.assertEqual(st, 200, r)
        return r

    def test_order_is_kept_on_the_computer(self):
        a, b, c = self.pad("随笔")["id"], self.pad("想法")["id"], self.pad("读书笔记")["id"]
        f1 = self.j("POST", "/api/folders/new", {"name": "课题"})[1]["id"]
        self.assertEqual(self.view()["top"], [f1, a, b, c])                      # 没排过：文件夹在前，本子照原来的先后
        self.assertNotIn("top", json.loads(folders.path_of(self.app.data).read_text("utf-8")))
        r = self.place(c, after="")                                              # 「读书笔记」排到最前
        self.assertEqual(r["top"], [c, f1, a, b])
        r = self.place(f1, after=b)                                              # 文件夹排到最后
        self.assertEqual(r["top"], [c, a, b, f1])
        r = self.place(b, into=f1, after="")                                     # 拖进文件夹里某个位置：顺带放进去
        self.assertEqual((r["top"], r["folders"][0]["items"]), ([c, a, f1], [b]))
        r = self.place(a, into=f1, after="")
        self.assertEqual(r["folders"][0]["items"], [a, b])
        r = self.place(a, into=f1, after=b)                                      # 文件夹里换先后
        self.assertEqual((r["folders"][0]["items"], r["folders"][0].get("ordered")), ([b, a], True))
        self.assertTrue(any(e["type"] == "folders" for e in self.app.bridge.events))   # 别的设备上的抽屉跟着刷新
        # 重启服务（同一个数据文件夹另起一个）：顺序还在
        again = ts.make_app(self.tmp.name)
        v = again.folder_view()
        self.assertEqual((v["top"], v["folders"][0]["items"]), ([c, f1], [b, a]))
        # 不能挪的、不认得的
        self.place("scratch", status=400)
        f2 = self.j("POST", "/api/folders/new", {"name": "旧的"})[1]["id"]
        self.place(f2, into=f1, status=400)
        self.place("pad:nope", status=404)
        self.place(c, into="f-nope", status=404)
        self.assertEqual(self.view()["top"], [c, f1, f2])                        # 新建的文件夹跟在原来排在它前面的文件夹后面

    def test_new_import_delete_rename_update(self):
        a, b = self.pad("随笔")["id"], self.pad("想法")["id"]
        src = Path(self.tmp.name) / "src"
        src.mkdir()
        ts.make_pdf(src / "例会_v47.pdf")
        book = self.app.import_document(src / "例会_v47.pdf")
        self.place(book, after="")                                               # 书排到最前：[book, a, b]
        self.place(a, after=b)                                                   # [book, b, a]
        c = self.pad("草图")["id"]                                               # 新建的：原来排在 b 后面
        self.assertEqual(self.view()["top"], [book, b, c, a])
        ts.make_pdf(src / "周报.pdf")
        book2 = self.app.import_document(src / "周报.pdf")                       # 新导入的：原来排在「例会」后面（按名字）
        self.assertEqual(self.view()["top"], [book, book2, b, c, a])
        # 书换成新版（另一个文件 v48，本子跟着改名）：位置不变，记下的跟着换名字
        ts.make_pdf(src / "例会_v48.pdf", text="v48")
        self.app.update_document(book, src / "例会_v48.pdf")
        new = "book:例会_v48.pdf"
        self.assertEqual(self.view()["top"], [new, book2, b, c, a])
        self.assertNotIn(book, json.loads(folders.path_of(self.app.data).read_text("utf-8"))["top"])
        # 平板上改名：一样
        self.j("POST", "/api/notebook/rename", {"nb": new, "title": "例会定稿"})
        self.assertEqual(self.view()["top"][0], "book:例会定稿.pdf")
        # 删掉：顺序里不再记它
        self.j("POST", "/api/notebook/delete", {"nb": b})
        top = json.loads(folders.path_of(self.app.data).read_text("utf-8"))["top"]
        self.assertNotIn(b, top)
        self.assertEqual(self.view()["top"], ["book:例会定稿.pdf", book2, c, a])
        # 推送本子（对话推来的第一页）：原来排在自己建的本子后面、书前面
        d = Path(self.tmp.name) / "proj"
        d.mkdir()
        self.j("POST", "/bridge/hello", {"sid": "S1", "label": "proj", "cwd": str(d)})
        img = Path(self.tmp.name) / "花园.png"
        fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 60, 40), 0).save(str(img))
        self.assertEqual(self.j("POST", "/bridge/show", {"sid": "S1", "path": str(img)})[0], 200)
        board = next(i for i in self.app.nb_seq() if i.startswith("board:"))
        self.assertEqual(self.view()["top"], ["book:例会定稿.pdf", book2, c, board, a])

    def test_neighbours_do_not_jump(self):
        """没记着的本子（排过以后新建的）跟着原来顺序里排在它前面的那一个走；那一个被放进文件夹、被删掉时，它不跟着跳。"""
        a, b = self.pad("随笔")["id"], self.pad("想法")["id"]
        f1 = self.j("POST", "/api/folders/new", {"name": "课题"})[1]["id"]
        self.place(b, after="")                                                  # [b, f1, a]
        c = self.pad("草图")["id"]                                               # 原来排在 b 后面：[b, c, f1, a]
        self.assertEqual(self.view()["top"], [b, c, f1, a])
        self.j("POST", "/api/folders/move", {"nb": b, "folder": f1})             # 经「⋯」把 b 放进文件夹
        self.assertEqual(self.view()["top"], [c, f1, a])
        d = self.pad("草图二")["id"]                                             # 原来排在 c 后面
        self.assertEqual(self.view()["top"], [c, d, f1, a])
        self.j("POST", "/api/notebook/delete", {"nb": c})
        self.assertEqual(self.view()["top"], [d, f1, a])

    def test_delete_folder_puts_its_notebooks_where_it_was(self):
        a, b, c = self.pad("随笔")["id"], self.pad("想法")["id"], self.pad("读书笔记")["id"]
        f1 = self.j("POST", "/api/folders/new", {"name": "课题"})[1]["id"]
        self.place(c, into=f1, after="")
        self.place(a, into=f1, after=c)                                          # 课题里：读书笔记、随笔
        self.place(f1, after=b)                                                  # 最外层：想法、课题
        r = self.j("POST", "/api/folders/delete", {"id": f1})[1]
        self.assertEqual(r["top"], [b, c, a])

    def test_new_notebook_inside_a_folder(self):
        a = self.pad("随笔")["id"]
        f1 = self.j("POST", "/api/folders/new", {"name": "课题", "nb": a})[1]["id"]
        r = self.pad("新的一本", folder=f1, paper="landscape")
        self.assertEqual(r["folder"], f1)
        self.assertEqual(self.view()["folders"][0]["items"], [a, r["id"]])
        self.assertNotIn(r["id"], self.view()["top"])
        self.assertEqual(self.j("GET", "/api/notebook?nb=" + r["id"])[1]["paper"], "landscape")  # 问的照旧（纸张方向）
        r2 = self.pad("没地方放", folder="f-nope")                               # 文件夹不在了：照样建，放在外面
        self.assertEqual(r2["folder"], "")
        self.assertIn(r2["id"], self.view()["top"])
        self.assertNotIn("folder", self.pad("平常的"))                           # 不带 folder 的回话和以前一样


if __name__ == "__main__":
    unittest.main()

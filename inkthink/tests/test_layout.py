"""页面顺序表：显示的第几页是什么、插页、删页、恢复、文档更新后重排。

    .venv\\Scripts\\python.exe -m unittest tests.test_layout -v
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import layout  # noqa: E402


def keys(lay):
    return [e["key"] for e in lay.pages]


class LayoutTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "layout.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_file_names(self):
        self.assertEqual(layout.file_stem("p0003"), "page-0003")
        self.assertEqual(layout.file_stem("b1a2b3c4d"), "blank-1a2b3c4d")
        with self.assertRaises(KeyError):
            layout.file_stem("../x")

    def test_defaults(self):
        book = layout.Layout(self.path, "book", 3)
        self.assertEqual(book.pages, [{"key": "p0000", "pdf": 0}, {"key": "p0001", "pdf": 1}, {"key": "p0002", "pdf": 2}])
        self.assertEqual(layout.Layout(Path(self.tmp.name) / "s.json", "scratch", 2).pages, [{"key": "p0000"}, {"key": "p0001"}])
        self.assertEqual(len(layout.Layout(Path(self.tmp.name) / "p.json", "pad", 0).pages), 1)  # 至少一页
        self.assertFalse(self.path.exists())  # 只读不写

    def test_insert_delete_restore(self):
        lay = layout.Layout(self.path, "book", 3)
        i = lay.insert_blank(0)  # 第 1 页后插一张空白纸
        self.assertEqual(i, 1)
        blank = lay.pages[1]["key"]
        self.assertTrue(blank.startswith("b"))
        self.assertEqual(keys(lay), ["p0000", blank, "p0001", "p0002"])
        self.assertEqual(lay.index_of("p0002"), 3)
        self.assertTrue(lay.is_blank(1))
        self.assertEqual(lay.insert_blank(-1), 0)  # 插在最前
        lay.save()
        again = layout.Layout(self.path, "book", 3)
        self.assertEqual(len(again.pages), 5)
        gone = again.delete(3)  # 删掉 p0001
        self.assertEqual(gone["key"], "p0001")
        self.assertIsNone(again.index_of("p0001"))
        self.assertEqual([h["entry"]["key"] for h in again.hidden], ["p0001"])
        self.assertEqual(again.restore("p0001"), 3)  # 回到原位置（跟在空白纸后面）
        self.assertEqual(again.hidden, [])
        with self.assertRaises(KeyError):
            again.entry(99)

    def test_restore_when_previous_page_is_gone_goes_last(self):
        lay = layout.Layout(self.path, "scratch", 3)
        lay.delete(2)            # 删 p0002（前一页是 p0001）
        lay.delete(1)            # 再删 p0001
        lay.restore("p0002")     # 前一页不在了：放到最后
        self.assertEqual(keys(lay), ["p0000", "p0002"])

    def test_cannot_delete_last_page(self):
        lay = layout.Layout(self.path, "pad", 1)
        with self.assertRaises(ValueError):
            lay.delete(0)

    def test_book_sync_with_page_count(self):
        lay = layout.Layout(self.path, "book", 3)
        lay.insert_blank(2)
        lay.save()
        grown = layout.Layout(self.path, "book", 4)  # PDF 多了一页（比如被手动换过）
        self.assertEqual([e.get("pdf") for e in grown.pages], [0, 1, 2, None, 3])
        shrunk = layout.Layout(self.path, "book", 2)
        self.assertEqual([e.get("pdf") for e in shrunk.pages], [0, 1, None])

    def test_board_sync_appends_new_pushes(self):
        lay = layout.Layout(self.path, "board", 1)
        lay.insert_blank(0)
        lay.save()
        lay = layout.Layout(self.path, "board", 3)
        self.assertEqual([e.get("board") for e in lay.pages], [0, None, 1, 2])

    def test_remap_after_document_update(self):
        lay = layout.Layout(self.path, "book", 4)        # 旧版 4 页：A B C D
        b_after_b = lay.pages[lay.insert_blank(1)]["key"]  # B 后面插空白纸
        b_after_c = lay.pages[lay.insert_blank(3)]["key"]  # C 后面插空白纸
        lay.delete(lay.index_of("p0003"))                 # 用户删了 D
        # 新版：A X B Y D（A 后插了 X，C 删掉了，B 后插了 Y，D 还在）；mapping[新页] = 旧页
        lay.remap_pdf([0, None, 1, None, 3], 5)
        self.assertEqual(keys(lay), ["p0000", "p0001", "p0002", b_after_b, b_after_c, "p0003"])
        self.assertEqual([e.get("pdf") for e in lay.pages], [0, 1, 2, None, None, 3])
        # C 没了：它后面的空白纸跟到前一页 B 的空白纸之后；D 在新版里是第 5 页，仍然是删除状态
        self.assertEqual([h["entry"] for h in lay.hidden], [{"key": "p0004", "pdf": 4}])

    def test_move(self):
        """挪页（抽屉里拖缩略图，2026-11-16）：只改先后，页的键不变；j 按挪完以后的位置算。"""
        lay = layout.Layout(self.path, "book", 4)          # A B C D
        blank = lay.pages[lay.insert_blank(0)]["key"]    # A _ B C D
        self.assertEqual(lay.move(4, 0), 0)              # D A _ B C
        self.assertEqual(keys(lay), ["p0003", "p0000", blank, "p0001", "p0002"])
        self.assertEqual(lay.move(0, 4), 4)              # 挪回去
        self.assertEqual(keys(lay), ["p0000", blank, "p0001", "p0002", "p0003"])
        self.assertEqual(lay.move(2, 2), 2)              # 原地不动
        self.assertEqual(keys(lay), ["p0000", blank, "p0001", "p0002", "p0003"])
        for i, j in ((0, 5), (5, 0), (-1, 0)):
            with self.assertRaises(KeyError):
                lay.move(i, j)
        lay.save()
        self.assertEqual(keys(layout.Layout(self.path, "book", 4)), ["p0000", blank, "p0001", "p0002", "p0003"])

    def test_restore_follows_the_page_it_was_after_when_that_page_moved(self):
        """删掉的页记着原来跟在哪一页后面（按键记）：那一页挪了地方，恢复时跟着它。"""
        lay = layout.Layout(self.path, "book", 4)          # A B C D
        lay.delete(lay.index_of("p0002"))                # 删 C（跟在 B 后面）：A B D
        lay.move(lay.index_of("p0001"), 0)               # B A D
        self.assertEqual(lay.restore("p0002"), 1)        # B C A D
        self.assertEqual(keys(lay), ["p0001", "p0002", "p0000", "p0003"])

    def test_document_update_after_moving_pages(self):
        """挪过页序以后原文件更新（按内容对齐）：书页回到新版里的先后，挪过的不保留；
        空白纸跟着它在挪过的页序里前面那一页走，挪到最前面的留在最前。"""
        lay = layout.Layout(self.path, "book", 3)          # A B C
        blank = lay.pages[lay.insert_blank(0)]["key"]    # A _ B C
        lay.move(lay.index_of("p0002"), 0)               # C A _ B
        lay.move(lay.index_of(blank), 1)                 # C _ A B：空白纸跟在 C 后面
        lay.remap_pdf([0, 1, 2], 3)                      # 新版的内容和旧版一样
        self.assertEqual(keys(lay), ["p0000", "p0001", "p0002", blank])
        first = lay.pages[lay.insert_blank(-1)]["key"]   # 最前面再插一张：_ A B C _
        lay.move(lay.index_of("p0002"), 1)               # _ C A B _：后一张空白纸现在跟在 B 后面
        lay.remap_pdf([0, 1, 2], 3)
        self.assertEqual(keys(lay), [first, "p0000", "p0001", blank, "p0002"])


if __name__ == "__main__":
    unittest.main()

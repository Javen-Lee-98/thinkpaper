"""页面顺序表：显示的第几页是什么、插页、删页、恢复、文档更新后重排。

    .venv\\Scripts\\python.exe -m unittest tests.test_layout -v
"""
import copy
import random
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
        """挪过页序以后原文件更新（按内容对齐；2026-11-17 用户定）：书页保留用户排的先后；
        空白纸跟着它在挪过的页序里前面那一页走，挪到最前面的留在最前。"""
        lay = layout.Layout(self.path, "book", 3)          # A B C
        blank = lay.pages[lay.insert_blank(0)]["key"]    # A _ B C
        lay.move(lay.index_of("p0002"), 0)               # C A _ B
        lay.move(lay.index_of(blank), 1)                 # C _ A B：空白纸跟在 C 后面
        lay.remap_pdf([0, 1, 2], 3)                      # 新版的内容和旧版一样：一页不动
        self.assertEqual(keys(lay), ["p0002", blank, "p0000", "p0001"])
        first = lay.pages[lay.insert_blank(-1)]["key"]   # 最前面再插一张：_ C _ A B
        lay.move(lay.index_of(blank), 4)                 # _ C A B _：后一张空白纸现在跟在 B 后面
        lay.remap_pdf([0, 1, 2], 3)
        self.assertEqual(keys(lay), [first, "p0002", "p0000", "p0001", blank])

    def test_moved(self):
        """「挪过页序」按原文件的页在这本里的先后判断：空白纸、删掉的页不算；挪了又挪回原样的不算。"""
        lay = layout.Layout(self.path, "book", 4)          # A B C D
        self.assertFalse(lay.moved())
        b = lay.insert_blank(0)                          # A _ B C D
        lay.move(b, 4)                                   # A B C D _：只挪了空白纸
        lay.delete(lay.index_of("p0001"))                # A C D _：删页不算挪
        self.assertFalse(lay.moved())
        lay.move(lay.index_of("p0003"), 0)               # D A C _
        self.assertTrue(lay.moved())
        lay.move(0, lay.index_of("p0002"))               # A C D _：挪回去了
        self.assertFalse(lay.moved())

    def test_update_keeps_the_order_the_user_moved_to(self):
        """挪过页序的书更新：还在的页按用户排的先后；新加的页跟在新版里它前面那一页（连同那一页带着的空白纸）后面。"""
        lay = layout.Layout(self.path, "book", 4)          # A B C D
        bb = lay.pages[lay.insert_blank(1)]["key"]       # A B _ C D
        lay.move(lay.index_of("p0003"), 0)               # D A B _ C
        # 新版：A B X C D（B 后面加了一页 X）
        lay.remap_pdf([0, 1, None, 2, 3], 5)
        self.assertEqual(keys(lay), ["p0004", "p0000", "p0001", bb, "p0002", "p0003"])  # D A B _ X C
        self.assertEqual([e.get("pdf") for e in lay.pages], [4, 0, 1, None, 2, 3])
        # 再来一版：最前面加一页 Y，最后加一页 Z（Z 前面是 D，D 被挪到了最前面）
        lay.remap_pdf([None, 0, 1, 2, 3, 4, None], 7)    # Y A B X C D Z
        self.assertEqual(keys(lay), ["p0000", "p0005", "p0006", "p0001", "p0002", bb, "p0003", "p0004"])  # Y D Z A B _ X C

    def test_new_page_goes_to_the_front_after_leading_blanks(self):
        """前面没有页的新页放最前：排在最前面的空白纸后面（和没挪过的书一样）。"""
        lay = layout.Layout(self.path, "book", 3)          # A B C
        lead = lay.pages[lay.insert_blank(-1)]["key"]    # _ A B C
        lay.move(lay.index_of("p0002"), 1)               # _ C A B
        lay.remap_pdf([None, 0, 1, 2], 4)                # 新版：X A B C
        self.assertEqual(keys(lay), [lead, "p0000", "p0003", "p0001", "p0002"])  # _ X C A B

    def test_blanks_of_a_removed_page_follow_the_page_before_it_in_the_users_order(self):
        """挪过页序的书：新版里没了的页，它后面的空白纸跟到这本里排在它前面、还在的那一页（不是原文件里它前面那一页）。"""
        lay = layout.Layout(self.path, "book", 5)          # A B C D E
        lay.move(lay.index_of("p0003"), 1)               # A D B C E
        lay.move(lay.index_of("p0002"), 2)               # A D C B E
        bc = lay.pages[lay.insert_blank(2)]["key"]       # A D C _ B E：空白纸跟在 C 后面
        lay.remap_pdf([0, 1, 3, 4], 4)                   # 新版：A B D E（C 删掉了）
        self.assertEqual(keys(lay), ["p0000", "p0002", bc, "p0001", "p0003"])  # A D _ B E
        lay.move(lay.index_of("p0002"), 0)               # D A _ B E：空白纸跟在 A 后面
        lay.move(lay.index_of(bc), 1)                    # D _ A B E：空白纸跟在 D 后面，D 是最前面的书页
        lay.remap_pdf([0, 1, 3], 3)                      # 新版：A B E（D 删掉了）：前面没有页，空白纸放最前
        self.assertEqual(keys(lay), [bc, "p0000", "p0001", "p0002"])

    def test_new_page_after_a_page_the_user_deleted(self):
        """新加的页在新版里前面那一页被用户删了（还是删除状态）：再往前找，跟在那一页后面。"""
        lay = layout.Layout(self.path, "book", 4)          # A B C D
        lay.delete(lay.index_of("p0001"))                # A C D（B 删了）
        lay.move(lay.index_of("p0003"), 0)               # D A C
        lay.remap_pdf([0, 1, None, 2, 3], 5)             # 新版：A B X C D
        self.assertEqual(keys(lay), ["p0004", "p0000", "p0002", "p0003"])  # D A X C
        self.assertEqual([h["entry"] for h in lay.hidden], [{"key": "p0001", "pdf": 1}])  # B 还是删除状态，换了新页号

    def test_file_reordered(self):
        """原文件自己换了页的先后（对齐表不按先后时）：没挪过的书跟原文件；挪过的（两边都动过）保留用户排的先后。
        现在的对齐（versions.align）不会交换页的先后，原文件换了先后的页按删一页、加一页算；这里直接给打乱的对齐表，
        守着这一层的规矩。"""
        lay = layout.Layout(self.path, "book", 3)          # A B C
        bb = lay.pages[lay.insert_blank(1)]["key"]       # A B _ C
        lay.save()
        lay.remap_pdf([0, 2, 1], 3)                      # 新版：A C B
        self.assertEqual(keys(lay), ["p0000", "p0001", "p0002", bb])  # A C B _：空白纸跟着 B
        moved = layout.Layout(self.path, "book", 3)        # 回到 A B _ C，用户把 C 挪到最前：C A B _
        moved.move(moved.index_of("p0002"), 0)
        moved.remap_pdf([0, 2, 1], 3)
        self.assertEqual(keys(moved), ["p0001", "p0000", "p0002", bb])  # 还是 C A B _（C、B 换成新页号）

    def test_undo_after_moving_brings_the_order_back(self):
        """撤回（原文件回到上一版，再按内容对齐换回去）：新版只是改了页、加了页的，页序回到更新前的样子。
        新版删掉过的页撤回后是「新加的页」，放回原文件里它前面那一页后面，不一定是用户排的位置（上面的字在更新时另存了）。"""
        lay = layout.Layout(self.path, "book", 4)          # A B C D
        bb = lay.pages[lay.insert_blank(1)]["key"]       # A B _ C D
        lay.move(lay.index_of("p0003"), 0)               # D A B _ C
        before = keys(lay)
        lay.remap_pdf([0, 1, None, 2, 3], 5)             # 新版：A B X C D
        lay.remap_pdf([0, 1, 3, 4], 4)                   # 撤回：X 没了
        self.assertEqual(keys(lay), before)
        lay.remap_pdf([1, 2, 3], 3)                      # 新版删掉了 A：D B _ C
        self.assertEqual(keys(lay), ["p0002", "p0000", bb, "p0001"])
        lay.remap_pdf([None, 0, 1, 2], 4)                # 撤回：A 回来了，在原文件里它前面没有页，放最前
        self.assertEqual(keys(lay), ["p0000", "p0003", "p0001", bb, "p0002"])  # A D B _ C（更新前是 D A B _ C）


def old_remap_pdf(self, mapping, n_new):
    """2026-11-17 以前的 Layout.remap_pdf，一字不改抄在这里：没挪过页序的书，新的写法排出来必须和它一样。"""
    old_to_new = {i: j for j, i in enumerate(mapping) if i is not None}
    leading, trailing, last = [], {}, None
    for e in self.pages:
        if "pdf" in e:
            last = e["pdf"]
            trailing.setdefault(last, [])
        elif last is None:
            leading.append(e)
        else:
            trailing[last].append(e)
    # 没了的旧页：它后面的空白纸交给前面最近一个还在的旧页
    for i in sorted(trailing):
        if i not in old_to_new and trailing[i]:
            prev = max((k for k in trailing if k < i and k in old_to_new), default=None)
            (trailing[prev] if prev is not None else leading).extend(trailing[i])
            trailing[i] = []
    hidden_old = {h["entry"]["pdf"] for h in self.hidden if "pdf" in h["entry"]}
    pages = list(leading)
    for j in range(n_new):
        i = mapping[j] if j < len(mapping) else None
        if i is None or i not in hidden_old:
            pages.append({"key": f"p{j:04d}", "pdf": j})
        if i is not None:
            pages.extend(trailing.get(i, []))
    # 删掉的页：新版里还在的换成新页号；新版里没了的就不用再留着
    new_key = {f"p{i:04d}": f"p{j:04d}" for i, j in old_to_new.items()}
    hidden = []
    for h in self.hidden:
        e = h["entry"]
        if "pdf" in e:
            if e["pdf"] not in old_to_new:
                continue
            j = old_to_new[e["pdf"]]
            h = dict(h, entry={"key": f"p{j:04d}", "pdf": j})
        if h["after"] and h["after"].startswith("p"):
            h = dict(h, after=new_key.get(h["after"]))
        hidden.append(h)
    self.hidden = hidden
    self.pages = pages


class NotMovedUnchangedTest(unittest.TestCase):
    """没挪过页序的书（原文件的页在这本里还是原文件的先后）更新后，和 2026-11-17 以前排的一模一样：
    随机生成几千本（插空白纸、挪空白纸、删页）和几千种对齐表（加页、删页、改页；也有打乱先后的），新旧两种写法逐个比。"""

    def test_same_as_before_for_books_not_moved(self):
        rnd = random.Random(20261117)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "layout.json"
            checked = {"monotone": 0, "shuffled": 0}
            for _ in range(4000):
                n = rnd.randint(1, 7)
                lay = layout.Layout(path, "book", n)
                for _ in range(rnd.randint(0, 4)):         # 空白纸插在随便哪里（包括最前面）
                    lay.insert_blank(rnd.randint(-1, len(lay.pages) - 1), rnd.choice([None, "landscape"]))
                for _ in range(rnd.randint(0, 2)):         # 只挪空白纸：原文件的页还是原来的先后
                    blanks = [k for k, e in enumerate(lay.pages) if "pdf" not in e]
                    if blanks:
                        lay.move(rnd.choice(blanks), rnd.randrange(len(lay.pages)))
                for _ in range(rnd.randint(0, 2)):         # 删几页（书页、空白纸都可能）
                    if len(lay.pages) > 1:
                        lay.delete(rnd.randrange(len(lay.pages)))
                self.assertFalse(lay.moved())
                mapping, kind = self.random_mapping(rnd, n)
                checked[kind] += 1
                a = layout.Layout.__new__(layout.Layout)
                b = layout.Layout.__new__(layout.Layout)
                for x in (a, b):
                    x.path, x.kind = path, "book"
                    x.pages, x.hidden = copy.deepcopy(lay.pages), copy.deepcopy(lay.hidden)
                a.remap_pdf(mapping, len(mapping))
                old_remap_pdf(b, mapping, len(mapping))
                self.assertEqual((a.pages, a.hidden), (b.pages, b.hidden), (lay.pages, lay.hidden, mapping))
            self.assertGreater(min(checked.values()), 500, checked)

    @staticmethod
    def random_mapping(rnd, n):
        """新版的对齐表 mapping[新页号] = 旧页号或 None：多半是按先后的（现在的 versions.align 只会给这种），也有打乱的。"""
        olds = [i for i in range(n) if rnd.random() > 0.25]  # 有的旧页没了
        if rnd.random() < 0.3:
            rnd.shuffle(olds)
            kind = "shuffled"
        else:
            kind = "monotone"
        out = []
        for i in olds:
            while rnd.random() < 0.25:                     # 新加的页
                out.append(None)
            out.append(i)
        while rnd.random() < 0.25:
            out.append(None)
        return out or [None], kind


if __name__ == "__main__":
    unittest.main()

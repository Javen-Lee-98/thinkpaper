"""字帖（inksheet.py）和领域词表（vocab.py）。"""
import sys
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import inksheet  # noqa: E402
import pages  # noqa: E402
import vocab  # noqa: E402


def glyph(sid, t0, x, y, size, red=False):
    """一个「字」：一竖一横两笔，size 是它的高。"""
    ss = [{"id": sid + "a", "t0": t0, "w": 2.1, "pts": [[x, y, 0.5, 0], [x, y + size, 0.5, 60]]},
          {"id": sid + "b", "t0": t0 + 100, "w": 2.1, "pts": [[x - size / 3, y + size / 2, 0.5, 0], [x + size / 3, y + size / 2, 0.5, 60]]}]
    for s in ss:
        if red:
            s["c"] = "r"
    return ss


class InkSheetTest(unittest.TestCase):
    def test_cells_share_a_character_height(self):
        small = inksheet.cell(glyph("s", 0, 100, 100, 20))
        big = inksheet.cell(glyph("b", 0, 100, 100, 90))
        # 字高都缩放到约 CHAR_H（另有上下留白），和原来写多大无关
        self.assertLess(abs(small.height - big.height), 6)
        self.assertLess(abs(small.height - (inksheet.CHAR_H / 1.3 + 24)), 8)
        self.assertIsNone(inksheet.cell([]))

    def test_tall_paragraph_is_shrunk(self):
        lines = sum((glyph(f"l{k}", k * 1000, 100, 100 + k * 40, 30) for k in range(20)), [])
        im = inksheet.cell(lines)
        self.assertLessEqual(im.height, inksheet.CELL_MAX_H)

    def test_lines_split_by_stroke_position(self):
        """识别前按笔画位置分行：两行字分成两行；同一行里高低不齐的笔画、长竖笔不另起一行。"""
        row1 = glyph("a", 0, 100, 100, 30) + glyph("b", 100, 140, 106, 24)
        row2 = glyph("c", 200, 100, 160, 30) + glyph("d", 300, 140, 158, 30)
        tall = [{"id": "t", "t0": 400, "w": 2.1, "pts": [[200, 95, 0.5, 0], [200, 200, 0.5, 60]]}]
        got = inksheet.lines(row2 + tall + row1)
        self.assertEqual([sorted(s["id"] for s in ln) for ln in got],
                         [sorted(s["id"] for s in row1), sorted([s["id"] for s in row2] + ["t"])])
        self.assertEqual(inksheet.lines([]), [])

    def test_sheet_rows_and_pick(self):
        t = 1_700_000_000_000
        strokes = glyph("a", t, 100, 100, 30) + glyph("b", t + 60000, 100, 300, 30, red=True) + glyph("c", t + 120000, 400, 500, 30)
        page = {"strokes": strokes}
        groups = pages.compute_groups(strokes)
        groups[0]["inSel"] = True                       # g1 在圈选范围里，g2 是红笔，g3 都不是
        picked = inksheet.pick(groups, page)
        self.assertEqual([gid for gid, _ in picked], ["g1", "g2"])
        groups[1]["answered"] = True                    # 回答过的红笔问题不进字帖
        self.assertEqual([gid for gid, _ in inksheet.pick(groups, page)], ["g1"])
        del groups[1]["answered"]
        groups[0]["bbox"] = [0, 0, 1, 1]                # 平板上的这一页还没存好：对不上的不要
        self.assertEqual([gid for gid, _ in inksheet.pick(groups, page)], ["g2"])
        cells = [(gid, inksheet.cell(ss)) for gid, ss in picked]
        sheet = inksheet.sheet(cells)
        self.assertEqual(sheet.height, sum(im.height for _, im in cells) + inksheet.PAD * 3)
        self.assertGreater(sheet.width, inksheet.LABEL_W)
        self.assertIsNone(inksheet.sheet([]))


class VocabTest(unittest.TestCase):
    def test_extract_terms(self):
        c = vocab.extract("这道题里 S_abc(x) 不是常数 h_{top}；ABCD 的周长，用 PyMuPDF 读 PDF。bbox_inches 是代码名。NOT BLOCKING", quoted=True)
        self.assertEqual(set(c), {"S_abc", "h_{top}", "ABCD", "PyMuPDF"})
        self.assertEqual(vocab.extract("见「勾股定理」和 `一元二次`", quoted=True), Counter({"勾股定理": 1, "一元二次": 1}))

    def test_pick_puts_this_page_first(self):
        doc = Counter({"GPS": 9, "S_abc": 3, "R1x": 1})
        proj = Counter({"ABCD": 2, "Once": 1})
        self.assertEqual(vocab.pick(doc, proj, "这一页讲 S_abc"), ["S_abc", "GPS", "ABCD"])
        self.assertEqual(vocab.pick(doc, proj, "", n=1), ["GPS"])


if __name__ == "__main__":
    unittest.main()

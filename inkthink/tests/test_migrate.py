"""迁移旧数据的脚本（tools/migrate_cards.py）：每种旧样子各一个用例，加上跑两遍一样、试跑不写、留原件、没改的文件不动。

旧数据照重构前的 app.js 写出来的样子造（字段、排版、收起、回答栏、改写、批注、建议、judged、排队文件），文字是编的。

    .venv\\Scripts\\python.exe -m unittest tests.test_migrate -v
"""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
import migrate_cards as mc  # noqa: E402

T0 = 1_793_300_000_000
REQ = "20261030-041539-e825"
NO_SERVICE = 9  # 查「正式服务在不在」时用的端口：这里不会有草稿纸服务


def stroke(sid, t0, x, y, red=False, n=8, erased=None):
    """一笔横线（和平板存的一样：[x, y, 压力, 毫秒]，粗 2.1）。"""
    s = {"id": sid, "t0": t0, "w": 2.1, "pts": [[x + 8 * k, y + (k % 2), 0.12, 30 * k] for k in range(n)]}
    if red:
        s["c"] = "r"
    if erased:
        s["erasedAt"] = erased
    return s


def box(s):
    xs, ys = [p[0] for p in s["pts"]], [p[1] for p in s["pts"]]
    return [min(xs) - s["w"], min(ys) - s["w"], max(xs) + s["w"], max(ys) + s["w"]]


def on_paper(wid, t, text, x=48, y=600, q=None, on=None, nlines=4, **extra):
    """旧 app.js 的 relayWrite 排在纸上的整段回答（展开着）。"""
    qn = 1 if q else 0
    h = (nlines + qn) * 34 + 14
    lay = {"x": x, "y": y, "w": 904, "h": h, "lines": (["问：" + q] if q else []) + ["……"] * nlines, "fs": 24, "lh": 34}
    if qn:
        lay["qn"] = 1
    a = {"id": wid, "req": REQ, "type": "write", "t": t, "level": None}
    if on is not None:
        a["on"] = on
    if q:
        a["q"] = q
    a.update({"text": text, "lay": lay,
              "paths": [{"d": f"M{x - 20} {y + 6} Q{x - 21} {y + h / 2} {x - 20} {y + h - 8}", "cls": "bar", "w": 1.8}],
              "hit": [x - 26, y - 4, x + 904, y + h + 4], "fold": "▸ " + ("问：" + q if q else text[:12]) + f" · {nlines} 行"})
    a.update(extra)
    return a


def folded(a, notes):
    """收起（旧 foldWrite）：写在上面的批注笔迹记进 notes，跟着藏起来。"""
    a["notes"] = list(notes)
    a["shut"] = True
    return a


def in_dock(wid, t, text, q=None, on=None, **extra):
    """收在旧界面回答栏里的回答：纸上没有排版。"""
    a = {"id": wid, "req": REQ, "type": "write", "t": t, "level": None}
    if on is not None:
        a["on"] = on
    if q:
        a["q"] = q
    a["text"] = text
    a["dock"] = True
    a.update(extra)
    return a


def note(nid, t, text, on, y):
    """页边短批注（旧样子，留着不动）。"""
    return {"id": nid, "req": REQ, "type": "note", "t": t, "level": None, "on": on, "text": text, "box": [100, y - 10, 300, y + 10],
            "lay": {"x": 1022, "y": y, "w": 336, "h": 37, "lines": [text], "fs": 21, "lh": 29},
            "paths": [{"d": f"M306 {y} Q660 {y - 1} 1014 {y + 1}", "cls": "leader", "w": 1.3}], "hit": [1016, y - 4, 1358, y + 41]}


def suggest(sid, t, text, on, b, ans=None, verdict=None, on_doc=False):
    """修改建议：ans 是它画在哪段回答的文字上（旧样子）。"""
    a = {"id": sid, "req": REQ, "type": "suggest", "t": t, "level": None, "on": on}
    if ans:
        a["ans"] = ans
    if on_doc:
        a["onDoc"] = True
    a.update({"text": text, "box": b, "lay": {"x": 1022, "y": b[1], "w": 336, "h": 37, "lines": [text], "fs": 21, "lh": 29},
              "paths": [{"d": f"M{b[2]} {b[1]} L1014 {b[1]}", "cls": "leader", "w": 1.3},
                        {"d": f"M{b[0] - 6} {b[1] - 6} L{b[2] + 6} {b[1] - 6} L{b[2] + 6} {b[3] + 6} L{b[0] - 6} {b[3] + 6} L{b[0] - 6} {b[1] - 6}",
                         "cls": "sbox", "w": 1.6}],
              "hit": [1016, b[1] - 4, 1358, b[1] + 41]})
    if verdict:
        a["verdict"] = verdict
        a["sent"] = True
    return a


def page(strokes, ai, **extra):
    p = {"v": 1, "strokes": strokes, "ai": ai, "reads": [], "h": 1600}
    p.update(extra)
    return p


class MigrateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.data = self.base / "data"

    # ---- 小工具
    def put(self, rel, obj):
        f = self.data / "notebooks" / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False), "utf-8")
        return f

    def get(self, rel):
        return json.loads((self.data / "notebooks" / rel).read_text("utf-8"))

    def run_mc(self, apply=False, originals=None):
        if apply and originals is None:
            originals = self.base / "originals"
        return mc.run(self.data, apply=apply, originals=originals, port=NO_SERVICE)

    def snapshot(self, root=None):
        root = root or self.data
        return {str(f.relative_to(root)): (f.read_bytes(), f.stat().st_mtime_ns) for f in sorted(root.rglob("*")) if f.is_file()}

    def writes(self, rel="scratch/page-0000.json"):
        return [a for a in self.get(rel)["ai"] if a.get("type") == "write"]

    def assertNewFormat(self, a):
        self.assertTrue(set(a) <= set(mc.NEW_KEYS), sorted(set(a) - set(mc.NEW_KEYS)))
        for k in ("id", "type", "t", "req", "text", "on", "n", "at", "seen"):
            self.assertIn(k, a)

    # ---- 每种旧样子
    def test_answer_to_live_red_question_sits_next_to_it(self):
        q1 = stroke("q1", T0, 120, 200, red=True)
        self.put("scratch/page-0000.json", page([q1], [on_paper("w1", T0 + 1000, "先说结论：成正比。\n$$C = \\pi d$$", y=240, q="为什么是线性的？", on=["q1"])]))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        [w] = self.writes()
        self.assertNewFormat(w)
        b = box(q1)
        self.assertEqual(w["at"], [mc.n1(b[2] + 16 + 13), mc.n1((b[1] + b[3]) / 2)])  # 最后一行的右端外侧、那一行的中间
        self.assertEqual((w["n"], w["seen"], w["q"], w["on"], w["id"]), (1, True, "为什么是线性的？", ["q1"], "w1"))
        self.assertEqual(w["text"], "先说结论：成正比。\n$$C = \\pi d$$")
        self.assertRegex(text, r"圈号 1「先说结论：成正比。 \$\$C = \\pi ?…」：红笔问题旁边")  # 只引前 20 个字

    def test_question_erased_badge_goes_to_old_top_left(self):
        q1 = stroke("q1", T0, 120, 200, red=True, erased=T0 + 5000)
        w = folded(on_paper("w1", T0 + 1000, "旧的回答", y=600, q="问题", on=["q1"]), [])  # 红笔问题擦掉时旧页面把回答折起
        self.put("scratch/page-0000.json", page([q1], [w]))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        [w] = self.writes()
        self.assertEqual(w["at"], [48 + 13, 600 + 13])
        self.assertEqual(w["on"], ["q1"])  # 还记着答的是哪句（擦掉的也留着）
        self.assertIn("原来纸上的左上角（61, 613）", text)

    def test_answer_that_pointed_nowhere_goes_to_old_top_left(self):
        self.put("scratch/page-0000.json", page([], [on_paper("w1", T0, "没指着哪句的回答", x=48, y=702.5)]))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        [w] = self.writes()
        self.assertEqual((w["at"], w["on"], w["seen"]), ([61, 715.5], [], True))
        self.assertNotIn("q", w)

    def test_corner_taken_by_ink_moves_right(self):
        ink = stroke("k1", T0 + 9000, 50, 605, n=6)  # 收起后在原来那块的左上角写了字
        self.put("scratch/page-0000.json", page([ink], [folded(on_paper("w1", T0, "回答", y=600), [])]))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        [w] = self.writes()
        self.assertGreaterEqual(w["at"][0] - 13 - 4, box(ink)[2])
        self.assertEqual(w["at"][1], 613)
        self.assertIn("为了不压东西挪了", text)

    def test_docked_answers_line_up_at_top_right(self):
        q1 = stroke("q1", T0, 120, 300, red=True)
        n1 = stroke("n1", T0 + 4000, 300, 760)
        ai = [in_dock("d2", T0 + 3000, "第二条，在栏里"),
              in_dock("d1", T0 + 1000, "第一条，在栏里", q="问一"),
              in_dock("d3", T0 + 2000, "问题还在的，放问题旁边", on=["q1"]),
              folded(in_dock("d4", T0 + 5000, "从纸上拖进栏的", home={"lay": {"x": 48, "y": 740, "w": 904, "h": 82, "lines": ["……"], "fs": 24, "lh": 34},
                                                                     "paths": [], "hit": [22, 736, 952, 826]}), ["n1"])]
        self.put("scratch/page-0000.json", page([q1, n1], ai))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        ws = {w["id"]: w for w in self.writes()}
        self.assertEqual([ws[k]["n"] for k in ("d1", "d3", "d2", "d4")], [1, 2, 3, 4])  # 按 Claude 回的先后
        self.assertEqual(ws["d1"]["at"], [979, 21])                     # 页面右上角
        self.assertEqual(ws["d2"]["at"], [979, 55])                     # 依次往下
        self.assertEqual(ws["d4"]["at"], [979, 89])
        self.assertEqual(ws["d3"]["at"], [mc.n1(box(q1)[2] + 29), mc.n1((box(q1)[1] + box(q1)[3]) / 2)])
        self.assertEqual([ws[k]["seen"] for k in ("d1", "d2", "d3", "d4")], [False, False, False, True])  # 只进过栏的算没看过；上过纸的看过
        for w in ws.values():
            self.assertNewFormat(w)
        self.assertEqual(text.count("页面右上角"), 3)
        self.assertIn("以前藏着的批注笔迹 1 笔重新露出来", text)

    def test_revised_answers_merge_into_newest_card(self):
        q1 = stroke("q1", T0, 120, 200, red=True)
        n1 = stroke("n1", T0 + 1500, 100, 630)   # 写在第 1 版上的批注（第 1 版收起时一起藏着）
        n3 = stroke("n3", T0 + 2500, 140, 700)   # 写在第 2 版上的批注
        v1 = folded(on_paper("v1", T0 + 1000, "第一版说法", y=600, q="为什么", on=["q1"], revisedBy="v2"), ["n1"])
        v2 = folded(on_paper("v2", T0 + 2000, "第二版说法", y=664, q="为什么", on=["n1"], revises="v1", revisedBy="v3"), ["n3"])
        v3 = on_paper("v3", T0 + 3000, "第三版说法", y=728, q="为什么", on=["n3"], revises="v2")
        self.put("scratch/page-0000.json", page([q1, n1, n3], [v1, v2, v3]))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        [w] = self.writes()
        self.assertNewFormat(w)
        self.assertEqual((w["id"], w["text"], w["n"]), ("v3", "第三版说法", 1))
        self.assertEqual(w["older"], [{"text": "第二版说法", "t": T0 + 2000}, {"text": "第一版说法", "t": T0 + 1000}])  # 新的在前
        self.assertEqual(w["on"], ["n3", "n1", "q1"])  # 每一版答过的都还算答过
        self.assertEqual(w["at"], [mc.n1(box(n3)[2] + 29), mc.n1((box(n3)[1] + box(n3)[3]) / 2)])  # 最新一版所指的还在：放它旁边
        self.assertIn("并进 2 个旧版", text)
        self.assertIn("以前藏着的批注笔迹 2 笔重新露出来", text)

    def test_red_notes_on_revised_versions_count_as_answered(self):
        q1 = stroke("q1", T0, 120, 200, red=True)
        r1 = stroke("r1", T0 + 1500, 100, 640, red=True)  # 在第 1 版上用红笔写的意见：第 2 版就是按它改写的
        r2 = stroke("r2", T0 + 2500, 100, 704, red=True)  # 在最新一版上写的、还没发过的红笔
        v1 = folded(on_paper("v1", T0 + 1000, "第一版", y=600, on=["q1"], revisedBy="v2"), ["r1"])
        v2 = folded(on_paper("v2", T0 + 2000, "第二版", y=664, on=["q1"], revises="v1"), ["r2"])
        self.put("scratch/page-0000.json", page([q1, r1, r2], [v1, v2]))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        [w] = self.writes()
        self.assertEqual(w["on"], ["q1", "r1"])  # 第 1 版上的意见记作回答过；最新一版上的不记
        self.assertIn("以前藏着的批注笔迹 2 笔重新露出来，其中红笔 1 笔没有回答指着，下次「检查」会当红笔问题交给 Claude", text)

    def test_revision_badge_goes_after_the_whole_question(self):
        # 一句红笔问题：前半句记在新版的 on 里，后半句是写在旧版上的批注（旧版收起时一起藏着）。圈号放在整句的后面
        a1 = stroke("a1", T0 + 1500, 100, 900, red=True, n=10)
        a2 = stroke("a2", T0 + 1600, 240, 900, red=True, n=10)
        v1 = folded(on_paper("v1", T0 + 1000, "第一版", y=600, revisedBy="v2"), ["a2"])
        v2 = on_paper("v2", T0 + 2000, "第二版", y=664, on=["a1"], revises="v1")
        self.put("scratch/page-0000.json", page([a1, a2], [v1, v2]))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        [w] = self.writes()
        self.assertEqual(w["at"], [mc.n1(box(a2)[2] + 29), mc.n1((box(a2)[1] + box(a2)[3]) / 2)])
        self.assertEqual(w["on"], ["a1", "a2"])

    def test_ink_written_on_answers_stays_as_plain_ink(self):
        ns = [stroke(f"n{k}", T0 + 2000 + k, 100 + 30 * k, 640) for k in range(3)]
        seen_note = stroke("m1", T0 + 5000, 120, 1040)  # 展开着的回答上的批注：本来就看得见
        ai = [folded(on_paper("w1", T0 + 1000, "收起的回答", y=600), ["n0", "n1", "n2"]),
              on_paper("w2", T0 + 3000, "展开的回答", y=1000),
              note("c1", T0 + 4000, "批注指着藏着的那笔", ["n1"], 640)]
        before = page(ns + [seen_note], ai)
        self.put("scratch/page-0000.json", before)
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        after = self.get("scratch/page-0000.json")
        self.assertEqual(after["strokes"], before["strokes"])  # 笔迹一笔不动
        self.assertTrue(all("notes" not in w and "shut" not in w for w in self.writes()))
        self.assertIn("以前藏着的批注笔迹 3 笔重新露出来", text)
        self.assertIn("回答上本来看得见的批注笔迹 1 笔照旧", text)
        self.assertIn("另有 1 条 Claude 的批注、符号指着重新露出来的笔迹", text)

    def test_report_names_reshown_ink_that_lands_on_later_writing(self):
        half = stroke("h1", T0 + 2000, 100, 640)                 # 一个字的一半：当批注藏起来了
        other_half = stroke("h2", T0 + 2300, 104, 641)           # 同一个字的另一半（同一时候写的）：一直看得见
        later = stroke("k1", T0 + 9_000_000, 300, 641)            # 收起以后过了很久，在那块空地上写的字
        hidden = stroke("h3", T0 + 2600, 300, 640)               # 被它压着的那一笔藏着的批注
        ai = [folded(on_paper("w1", T0 + 1000, "回答", y=600), ["h1", "h3"])]
        self.put("scratch/page-0000.json", page([half, other_half, later, hidden], ai))
        code, text = self.run_mc()
        self.assertEqual(code, 0, text)
        self.assertIn("以前藏着的批注笔迹 2 笔重新露出来（其中 1 笔和后来写在那里的别的笔迹叠在一起）", text)

    def test_suggestion_drawn_on_answer_text_merges_into_card(self):
        q1 = stroke("q1", T0, 120, 200, red=True)
        w = on_paper("w1", T0 + 1000, "回答正文", y=240, on=["q1"])
        s = suggest("s1", T0 + 2000, "改为：更准的说法", ["q1"], [60, 280, 300, 310], ans="w1", verdict="yes")
        s2 = suggest("s2", T0 + 2100, "改为：书页上的建议", ["q1"], [400, 90, 600, 120], on_doc=True)
        self.put("scratch/page-0000.json", page([q1], [w, s, s2]))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        ai = self.get("scratch/page-0000.json")["ai"]
        self.assertEqual([a["id"] for a in ai], ["w1", "s2"])
        self.assertEqual(ai[0]["older"], [{"text": "修改建议：改为：更准的说法（你同意了这条）", "t": T0 + 2000}])
        self.assertEqual(ai[1], s2)  # 别的建议不动
        self.assertIn("并进画在回答上的修改建议 1 条", text)

    def test_page_with_judged_keeps_it_and_hides_it(self):
        judged = [{"stamp": "2026-10-30T04:50:54", "folded": {"strokes": [stroke("j1", T0, 300, 900), stroke("j2", T0, 340, 900)],
                                                              "ai": [{"id": "x1", "type": "tick", "t": T0, "on": ["j1"], "paths": [], "hit": [1, 2, 3, 4]},
                                                                     on_paper("old", T0, "收起的旧回答", y=900)]},
                   "moved": {"strokes": {}, "ai": {}}, "nFold": 2, "nMove": 0, "nKeep": 0},
                  {"stamp": "2026-10-29T01:00:00", "folded": {"strokes": [], "ai": []}, "moved": {"strokes": {}, "ai": {}}, "restored": True}]
        self.put("book-0123456789ab/meta.json", {"book": "某份讲义.pdf"})
        self.put("book-0123456789ab/page-0000.json", page([stroke("a", T0, 100, 100)], [in_dock("w1", T0, "栏里的回答")], judged=judged))
        only = self.put("book-0123456789ab/page-0001.json", page([], [], judged=judged))
        snap = only.read_bytes(), only.stat().st_mtime_ns
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        after = self.get("book-0123456789ab/page-0000.json")
        self.assertEqual(after["judged"], judged)  # 原样留在不再使用的位置
        self.assertNotIn("j1", {s["id"] for s in after["strokes"]})
        self.assertEqual((only.read_bytes(), only.stat().st_mtime_ns), snap)  # 只有 judged 的页：文件不用改
        self.assertIn("《某份讲义》", text)
        self.assertIn("第 2 页（page-0001.json）：没有旧的长回答，文件不用改；以前收起的旧笔迹 2 笔、收起的批注 2 条照旧不显示", text)
        self.assertEqual(mc.check_page(after), [])  # judged 里的旧回答不算

    def test_deleted_notebook_is_migrated_too(self):
        d = "_deleted-20261020-101010-book-0a1b2c3d4e5f"
        self.put(f"{d}/meta.json", {"book": "已删的一本.pdf"})
        self.put(f"{d}/page-0017.json", page([], [on_paper("w1", T0, "已删本子里的回答", y=602.5)]))
        self.put("scratch/page-0000.json", page([], [note("c1", T0, "活着的本子里只有短批注", [], 200)]))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        [w] = self.writes(f"{d}/page-0017.json")
        self.assertEqual((w["n"], w["at"]), (1, [61, 615.5]))
        self.assertIn("== 已删的本子", text)
        self.assertIn("第 18 页（page-0017.json）", text)
        self.assertIn("已删的本子：改 1 本、1 页，旧的长回答 1 条 → 圈号 1 个", text)
        self.assertIn("活着的本子：改 0 本、0 页", text)

    def test_pending_files(self):
        relocate = {"req": REQ, "relocate": [{"action": "fold", "to": None, "kind": "stroke", "ids": ["a"]}], "stamp": "2026-10-30T04:21:25",
                    "count": 1, "rot": 0, "t": T0}
        reply = {"req": "direct-954a33", "level": None, "items": [{"type": "write", "text": "排队的回答", "revises": "w9"}, {"type": "note", "text": "短的"}],
                 "groups": {}, "gx": {}, "crop": {"x0": 0, "y0": 0, "scale": 1}, "sel": None, "rot": None, "t": T0}
        vsent = {"vsent": ["s1"], "t": T0}
        plain = [{"req": "r2", "level": None, "items": [{"type": "write", "text": "格式没变的回答", "anchor": "g1"}], "groups": {"g1": [1, 2, 3, 4]},
                  "crop": {"x0": 0, "y0": 0, "scale": 1}, "sel": None, "t": T0}]
        only = self.put("scratch/page-0002.pending.json", [relocate])
        mixed = self.put("scratch/page-0003.pending.json", [relocate, reply, vsent, {"notesSent": ["w1"], "t": T0}])
        keep = self.put("scratch/page-0004.pending.json", plain)
        keep_snap = keep.read_bytes(), keep.stat().st_mtime_ns
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        self.assertFalse(only.exists())  # 只有旧条目：去掉以后空了，删掉
        self.assertTrue((self.base / "originals" / "notebooks" / "scratch" / "page-0002.pending.json").exists())
        want = [dict(reply, items=[{"type": "write", "text": "排队的回答"}, {"type": "note", "text": "短的"}]), vsent]
        self.assertEqual(json.loads(mixed.read_text("utf-8")), want)
        self.assertEqual(mixed.read_text("utf-8"), json.dumps(want, ensure_ascii=False))  # 和服务写排队文件一样
        self.assertEqual((keep.read_bytes(), keep.stat().st_mtime_ns), keep_snap)  # 新格式能用的：不动
        self.assertIn("排队文件 page-0002.pending.json（第 3 页）：以前「对旧批注的判断」1 条（功能已删，去掉） → 文件空了，删掉", text)
        self.assertIn("排队的长回答上的 revises 1 处", text)
        self.assertIn("排队文件 page-0004.pending.json（第 5 页）：Claude 的回复 1 份（其中长回答 1 条，格式没变，打开那一页时落成新圈号） → 不动", text)

    def test_short_notes_are_not_touched(self):
        q1 = stroke("q1", T0, 120, 200, red=True)
        notes = [note("c1", T0 + 100, "右侧栏位置的旧批注", ["q1"], 190), note("c2", T0 + 200, "另一条", ["q1"], 260)]
        self.put("scratch/page-0000.json", page([q1], [notes[0], on_paper("w1", T0 + 300, "长回答", y=240, on=["q1"]), notes[1]]))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        ai = self.get("scratch/page-0000.json")["ai"]
        self.assertEqual([a["id"] for a in ai], ["c1", "w1", "c2"])  # 次序不变，长回答换在原处
        self.assertEqual([ai[0], ai[2]], notes)

    def test_blank_page_file_and_page_labels(self):
        self.put("pads.json",[{"id": "12ab34cd", "title": "某个本子", "created": "2026-10-28T10:00:00"}])
        self.put("pad-12ab34cd/layout.json", {"pages": [{"key": "p0000"}, {"key": "b56ef78ab"}], "hidden": []})
        self.put("pad-12ab34cd/blank-56ef78ab.json", page([], [in_dock("w1", T0, "插进来的空白页上的回答")], xw=400, oy=500))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        [w] = self.writes("pad-12ab34cd/blank-56ef78ab.json")
        self.assertEqual(w["at"], [1400 - 13 - 8, -500 + 13 + 8])  # 加宽、往上加长过的纸，纸上一个字都没有：只好放纸的右上角
        self.assertIn("《某个本子》（pad-12ab34cd）", text)
        self.assertIn("第 2 页（blank-56ef78ab.json）", text)

    def test_docked_answers_on_enlarged_paper_go_beside_the_ink(self):
        # 用户 2026-11-13 定：纸加大过的页，纸角离字很远，只在回答栏里的回答放在字迹范围的右上角旁边
        k1 = stroke("k1", T0, 200, 300)
        k2 = stroke("k2", T0 + 100, 500, 900)
        ai = [in_dock("d1", T0 + 1000, "第一条，在栏里"), in_dock("d2", T0 + 2000, "第二条，在栏里")]
        self.put("scratch/page-0000.json", page([k1, k2], ai, xw=2000, oy=1000))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        ws = {w["id"]: w for w in self.writes()}
        right = max(box(k1)[2], box(k2)[2])
        top = min(box(k1)[1], box(k2)[1])
        self.assertEqual(ws["d1"]["at"], [mc.n1(right + 16 + 13), mc.n1(top + 13)])  # 字迹外框右上角的旁边，不在 (2979, -979)
        self.assertEqual(ws["d2"]["at"], [mc.n1(right + 16 + 13), mc.n1(top + 13 + 34)])  # 依次往下
        self.assertEqual(text.count("字迹范围的右上角（纸加大过）"), 2)
        self.assertNotIn("页面右上角", text)

    def test_docked_answers_on_ordinary_paper_stay_at_the_page_corner(self):
        k1 = stroke("k1", T0, 200, 300)
        self.put("scratch/page-0000.json", page([k1], [in_dock("d1", T0 + 1000, "在栏里")]))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        [w] = self.writes()
        self.assertEqual(w["at"], [979, 21])  # 没加大过的纸：照旧放页面右上角
        self.assertIn("页面右上角", text)

    def test_numbering_follows_reply_order_after_existing_badges(self):
        existing = {"id": "new1", "type": "write", "t": T0 + 9000, "req": REQ, "text": "迁移前就有的新圈号", "on": [], "n": 1, "at": [979, 21], "seen": True}
        ai = [existing, in_dock("late", T0 + 3000, "晚到的"), in_dock("early", T0 + 1000, "早到的"), in_dock("mid", T0 + 2000, "中间的")]
        self.put("scratch/page-0000.json", page([], ai))
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        ws = {w["id"]: w for w in self.writes()}
        self.assertEqual(ws["new1"], existing)  # 已有的新格式不动、编号不变
        self.assertEqual([ws[k]["n"] for k in ("early", "mid", "late")], [2, 3, 4])
        ats = [w["at"] for w in ws.values()]
        for i in range(len(ats)):
            for j in range(i):
                self.assertGreaterEqual(((ats[i][0] - ats[j][0]) ** 2 + (ats[i][1] - ats[j][1]) ** 2) ** 0.5, 26, (ats[i], ats[j]))  # 圈号不叠

    # ---- 跑两遍、试跑、原件、别的文件
    def make_mixed(self):
        q1 = stroke("q1", T0, 120, 200, red=True)
        self.put("scratch/page-0000.json", page([q1], [on_paper("w1", T0 + 1000, "回答一", y=240, on=["q1"]), in_dock("w2", T0 + 2000, "回答二")], rev=7, by="dev1"))
        self.put("scratch/page-0001.json", page([stroke("x", T0, 100, 100)], [note("c1", T0, "只有短批注的页", ["x"], 100)]))
        self.put("scratch/settings.json", {"paper": "portrait"})
        self.put("scratch/seen.json", {"by": {}})
        self.put("scratch/page-0005.pending.json", [{"req": REQ, "relocate": [], "stamp": "x", "count": 0, "rot": 0, "t": T0}])
        (self.data / "access_code.txt").write_text("不该被碰到", "utf-8")

    def test_running_twice_gives_the_same_result(self):
        self.make_mixed()
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        snap = self.snapshot()
        code2, text2 = self.run_mc(apply=True, originals=self.base / "originals2")
        self.assertEqual(code2, 0, text2)
        self.assertIn("没有要迁的", text2)
        self.assertEqual(self.snapshot(), snap)
        self.assertFalse((self.base / "originals2").exists())
        code3, text3 = self.run_mc()
        self.assertIn("没有要迁的", text3)

    def test_dry_run_writes_nothing(self):
        self.make_mixed()
        snap, outside = self.snapshot(), sorted(p.name for p in self.base.iterdir())
        code, text = self.run_mc()
        self.assertEqual(code, 0, text)
        self.assertIn("试跑（什么都没写）", text)
        self.assertIn("旧的长回答 2 条 → 圈号 2 个", text)
        self.assertEqual(self.snapshot(), snap)
        self.assertEqual(sorted(p.name for p in self.base.iterdir()), outside)  # 也没在旁边建原件文件夹

    def test_apply_keeps_originals_and_writes_like_the_server(self):
        self.make_mixed()
        orig = (self.data / "notebooks" / "scratch" / "page-0000.json").read_bytes()
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        kept = self.base / "originals" / "notebooks" / "scratch" / "page-0000.json"
        self.assertEqual(kept.read_bytes(), orig)  # 原件按相同的相对路径留着
        self.assertEqual(sorted(str(p.relative_to(self.base / "originals")) for p in (self.base / "originals").rglob("*") if p.is_file()),
                         [str(Path("notebooks/scratch/page-0000.json")), str(Path("notebooks/scratch/page-0005.pending.json"))])
        f = self.data / "notebooks" / "scratch" / "page-0000.json"
        new = json.loads(f.read_text("utf-8"))
        self.assertEqual(f.read_text("utf-8"), json.dumps(new, ensure_ascii=False, separators=(",", ":")))  # 和 server.save_page 一样
        self.assertIn("回答一", f.read_text("utf-8"))  # 中文原样，不转义
        self.assertEqual((new["rev"], new["by"]), (8, "migrate"))  # 平板手里迁移前的旧页面存回来会被当冲突，不会把旧格式写回去
        self.assertFalse(list(self.data.rglob("*.tmp")))
        self.assertIn("原件存在", text)

    def test_files_without_old_answers_are_not_touched(self):
        self.make_mixed()
        snap = self.snapshot()
        code, text = self.run_mc(apply=True)
        self.assertEqual(code, 0, text)
        after = self.snapshot()
        changed = sorted(k for k in snap if k not in after or after[k] != snap[k])
        self.assertEqual(changed, [str(Path("notebooks/scratch/page-0000.json")), str(Path("notebooks/scratch/page-0005.pending.json"))])
        self.assertEqual(sorted(after), sorted(k for k in snap if k != str(Path("notebooks/scratch/page-0005.pending.json"))))

    def test_default_originals_folder_is_beside_data(self):
        self.make_mixed()
        code, text = mc.run(self.data, apply=True, port=NO_SERVICE)
        self.assertEqual(code, 0, text)
        made = [p for p in self.base.iterdir() if p.name.startswith("data-originals-")]
        self.assertEqual(len(made), 1)
        self.assertTrue((made[0] / "notebooks" / "scratch" / "page-0000.json").exists())

    def test_refuses_while_the_service_runs(self):
        self.make_mixed()
        snap = self.snapshot()
        with mock.patch.object(mc, "service_alive", return_value=True):
            code, text = self.run_mc(apply=True)
        self.assertEqual(code, 2)
        self.assertIn("服务正在跑", text)
        self.assertEqual(self.snapshot(), snap)
        self.assertFalse((self.base / "originals").exists())

    def test_service_check_follows_launch_py(self):
        import launch
        (self.data / "notebooks").mkdir(parents=True)
        # 不给 --port：照 launch.py 取端口（config.json 里的 port），另外也查 8765；在跑就拒绝
        with mock.patch.object(launch, "port", return_value=8766), mock.patch.object(launch, "alive", return_value=False) as alive:
            code, _ = mc.run(self.data, apply=True, originals=self.base / "o")
        self.assertEqual(code, 0)
        self.assertEqual(sorted(c.args[0] for c in alive.call_args_list), [8765, 8766])
        with mock.patch.object(launch, "port", return_value=8766), mock.patch.object(launch, "alive", side_effect=lambda p: p == 8766):
            code, text = mc.run(self.data, apply=True, originals=self.base / "o")
        self.assertEqual(code, 2)
        self.assertIn("端口 8766", text)

    def test_originals_inside_data_is_refused(self):
        self.make_mixed()
        snap = self.snapshot()
        code, text = self.run_mc(apply=True, originals=self.data / "keep")
        self.assertEqual(code, 2)
        self.assertIn("必须在数据文件夹外面", text)
        self.assertEqual(self.snapshot(), snap)

    def test_card_marks_are_not_old_fields(self):
        """2026-11-14 卡片上的红字和接在下面的回应（more、marks、sheet）：复查不当成旧字段；这样的页、排队的回应（带 card）
        和「卡片红字交过了」的排队条目（msent），迁移脚本都不动。"""
        w = {"id": "w1", "type": "write", "t": T0, "req": REQ, "text": "回答", "q": "问", "on": [], "n": 1, "at": [300, 200], "seen": True,
             "more": [{"id": "m1", "t": T0 + 5, "req": REQ, "q": "这句不对", "text": "接着回", "on": ["k1"]}],
             "marks": [{"id": "k1", "blk": "a", "pts": [[20, 40, 0.5, 0]], "t0": T0 + 3, "w": 2.1, "c": "r", "req": REQ}],
             "sheet": {"w": 440, "h": 100, "t": T0 + 3, "blocks": [{"id": "a", "y": 12, "h": 60, "rows": []}]}}
        page = {"v": 1, "strokes": [stroke("q1", T0, 100, 200, red=True)], "ai": [w]}
        self.assertEqual(mc.check_page(page), [])
        self.assertIsNone(mc.migrate_page(page, None, None, None)[0])
        pend = [{"msent": {"w1": ["k1"]}, "req": REQ, "t": T0}, {"req": REQ, "items": [{"type": "write", "text": "接着回", "card": 1, "cid": "w1"}]}]
        self.assertIsNone(mc.migrate_pending(pend)[0])
        self.assertEqual(mc.check_pending(pend), [])
        self.assertTrue(mc.check_page({"ai": [dict(w, lay={})]}))  # 真有旧字段的照样拦

    def test_self_check_catches_leftovers(self):
        self.assertTrue(mc.check_page({"ai": [{"id": "w", "type": "write", "t": 1, "text": "x", "lay": {}}]}))
        self.assertTrue(mc.check_page({"ai": [{"id": "s", "type": "suggest", "ans": "w"}]}))
        self.assertTrue(mc.check_pending([{"relocate": []}]))
        self.assertTrue(mc.check_pending([{"items": [{"type": "write", "text": "x", "revises": "a"}]}]))
        self.assertEqual(mc.check_page({"ai": [], "judged": [{"folded": {"ai": [on_paper("o", 1, "旧的")], "strokes": []}}]}), [])
        # 复查真的拦得住：迁移算错（假装没去掉旧字段）时什么都不写、退出码 1
        self.make_mixed()
        snap = self.snapshot()
        real = mc.migrate_page

        def broken(*a, **k):
            new, rec = real(*a, **k)
            if new:
                for w in new["ai"]:
                    if w.get("type") == "write":
                        w["lay"] = {}
            return new, rec
        with mock.patch.object(mc, "migrate_page", side_effect=broken):
            code, text = self.run_mc(apply=True)
        self.assertEqual(code, 1)
        self.assertIn("复查没过", text)
        self.assertEqual(self.snapshot(), snap)

    def test_command_line_and_report_file(self):
        self.make_mixed()
        rep, out = self.base / "report.txt", io.StringIO()
        with contextlib.redirect_stdout(out):
            code = mc.main(["--data", str(self.data), "--report", str(rep), "--port", str(NO_SERVICE)])
        self.assertEqual(code, 0)
        self.assertIn("试跑（什么都没写）", rep.read_text("utf-8"))
        self.assertIn("试跑（什么都没写）", out.getvalue())  # 屏幕上也有
        with contextlib.redirect_stdout(io.StringIO()):
            code = mc.main(["--data", str(self.data), "--report", str(self.data / "r.txt")])
        self.assertEqual(code, 2)
        self.assertFalse((self.data / "r.txt").exists())


if __name__ == "__main__":
    unittest.main()

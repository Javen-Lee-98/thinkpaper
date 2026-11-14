"""InkThink 中转服务测试：提示文字、PDF、平板接口，以及「平板投递 → 插件取走 → 写回批注」整条流程。

    .venv\\Scripts\\python.exe -m unittest discover -s tests -v
"""
import base64
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import fitz  # noqa: E402

import folders  # noqa: E402
import keep  # noqa: E402
import ocr  # noqa: E402
import pages  # noqa: E402
import pdfsave  # noqa: E402
import prompt  # noqa: E402
import server  # noqa: E402
import zotero  # noqa: E402

# 本机 PP-OCR（可选安装）在测试里不跑：慢，结果也随模型变；OcrTest 里换成假的识别器
ocr.AVAILABLE = False

TINY_JPEG =base64.b64encode(fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 4, 4), 0).tobytes("jpg")).decode()


def make_pdf(path, text="Newton's second law: F = m a", pages=1):
    doc = fitz.open()
    for _ in range(pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 100), text, fontsize=14)
    doc.save(path)


def groups_fixture():
    t = 1_700_000_000_000
    return [
        {"id": "g1", "t0": t, "t1": t + 5000, "n": 4, "erased": 0, "erasedAt": None, "bbox": [100, 100, 300, 140], "inSel": False, "revisit": False},
        {"id": "g2", "t0": t + 70000, "t1": t + 82000, "n": 6, "erased": 2, "erasedAt": t + 90000, "bbox": [100, 200, 420, 250], "inSel": True, "revisit": False},
        {"id": "g3", "t0": t + 82500, "t1": t + 86000, "n": 3, "erased": 3, "erasedAt": t + 88000, "bbox": [430, 200, 520, 250], "inSel": True, "revisit": True},
    ]


def send_payload(target="", nb="scratch", page=0, level="ask"):
    return {
        "target": target, "nb": nb, "page": page, "level": level, "groups": groups_fixture(), "now": groups_fixture()[-1]["t1"] + 5000,
        "sel": {"x0": 90, "y0": 190, "x1": 530, "y1": 260},
        "crop": {"x0": 90, "y0": 190, "x1": 530, "y1": 260, "w": 4, "h": 4, "scale": 3},
        "page_size": {"w": 1000, "margin": 380, "h": 1414}, "include_process": True, "prev_notes": ["之前的批注"],
        "images": {"crop": "data:image/jpeg;base64," + TINY_JPEG},
    }


def stroke(sid, t0, x, y, red=False, n=8):
    """一笔横线：n 个点、每点 30 毫秒。"""
    s = {"id": sid, "t0": t0, "w": 2.1, "pts": [[x + 8 * k, y + (k % 2), 0.5, 30 * k] for k in range(n)]}
    if red:
        s["c"] = "r"
    return s


class PagesTest(unittest.TestCase):
    def test_groups_match_frontend_rules(self):
        t = 1_700_000_000_000
        ss = [stroke("a", t, 100, 100), stroke("b", t + 600, 170, 100),   # 紧接、相邻 → 同一组
              stroke("c", t + 1000, 240, 100, red=True),                   # 换了红笔 → 新的一组
              stroke("d", t + 60000, 100, 104)]                            # 一分钟后回到原处 → 新组、回头补写
        ss[1]["erasedAt"] = t + 9000
        g = pages.compute_groups(ss)
        self.assertEqual([x["n"] for x in g], [2, 1, 1])
        self.assertEqual((g[0]["erased"], g[0]["erasedAt"]), (1, t + 9000))
        self.assertTrue(g[1]["red"])
        self.assertTrue(g[2]["revisit"])
        self.assertEqual(pages.last_touch({"strokes": ss}), t + 60000 + 210)

    def test_render_page_draws_ink_and_notes(self):
        with tempfile.TemporaryDirectory() as tmp:
            page = {"strokes": [stroke("a", 0, 100, 100, n=30)], "h": 1414,
                    "ai": [{"type": "note", "paths": [{"d": "M10 10 Q50 60 90 10 C100 20 110 30 120 40 L130 50", "w": 2}],
                            "lay": {"x": 1022, "y": 90, "fs": 21, "lh": 29, "lines": ["页边批注"]}}]}
            out = Path(tmp) / "p.png"
            pages.render_page(page, str(out), 1414, None, pages.compute_groups(page["strokes"]), 0.5)
            pix = fitz.Pixmap(str(out))
            self.assertEqual((pix.width, pix.height), (690, 707))
            dark = min(sum(pix.pixel(x, y)) for x in range(70, 80) for y in range(48, 53))
            self.assertLess(dark, 400)  # 笔迹是黑的
            clip = Path(tmp) / "c.png"
            pages.render_page(page, str(clip), 1414, None, (), 2, clip=[80, 80, 400, 130], mark=[95, 95, 340, 105])
            self.assertEqual(fitz.Pixmap(str(clip)).width, 640)

    def test_answer_badge_and_orphaned_marks(self):
        """长回答在纸上只是一个圈号（蓝圈加数字），不画回答文字；所答的红笔问题擦掉了，圈号照样留着。"""
        write = answer_item("w1", 1, [329, 300], text="因为一\n因为二\n因为三", q="为什么？", on=["gone"])
        circle = {"id": "c1", "type": "circle", "paths": [{"d": "M100 100 L200 200"}], "hit": [90, 90, 210, 210], "on": ["a"]}
        page = {"strokes": [dict(stroke("a", 0, 100, 100), erasedAt=5)], "ai": [write, circle], "h": 1414}
        self.assertTrue(pages.ai_gone(circle, pages.live_ids(page)))
        self.assertFalse(pages.ai_gone(write, pages.live_ids(page)))       # 圈号不会落空
        self.assertEqual(pages.content_extent(page, 100)[1], 300 + 13 + 40)  # 只算圈号那一小块
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "p.png"
            pages.render_page(page, str(out), 1414, None, (), 1, clip=[0, 80, 1000, 460])
            pix = fitz.Pixmap(str(out))
            r, g, b = pix.pixel(329 - 8, 300 - 80)
            self.assertTrue(b > 140 and r < 90, (r, g, b))                     # 圈号：没看过的是实心蓝
            self.assertEqual(min(sum(pix.pixel(x, 150 - 80)) for x in range(140, 160)), 765)  # 落空的圈没画
            blue = [(x, y) for y in range(0, pix.height, 2) for x in range(0, pix.width, 2)
                    if (lambda p: p[2] - p[0] > 50)(pix.pixel(x, y))]
            self.assertTrue(blue and all(abs(x - 329) <= 16 and abs(y + 80 - 300) <= 16 for x, y in blue), blue[:5])  # 回答文字没画

    def test_seen_badge_is_hollow_and_unknown_items_do_not_break(self):
        seen = answer_item("w1", 2, [500, 300], seen=True)
        old = {"id": "w0", "type": "write", "text": "迁移前的旧样子", "lay": {"x": 48, "y": 600, "w": 904, "h": 40}}  # 没有圈号位置：不画、不出错
        page = {"strokes": [], "ai": [seen, old, {"id": "x", "type": "bogus"}], "h": 1414}
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "p.png"
            pages.render_page(page, str(out), 1414, None, (), 1)
            pix = fitz.Pixmap(str(out))
            self.assertEqual(sum(pix.pixel(500 - 7, 300 - 3)), 765)          # 看过的：空心（圈里是白的）
            r, g, b = pix.pixel(500 + 13, 300)
            self.assertTrue(b - r > 50, (r, g, b))                           # 圈是蓝的
            self.assertEqual(min(sum(pix.pixel(x, 610)) for x in range(48, 400)), 765)  # 旧样子的回答没画
        self.assertEqual(pages.content_extent(page, 1414), (1000, 1414))
        self.assertEqual(pdfsave.marks_of(page, 1414)["badges"][0]["n"], "2")


class RoleTest(unittest.TestCase):
    def msg(self, **extra):
        meta = send_payload()
        meta.update(extra)
        return prompt.build_message(meta, {"overview": "o.jpg", "crop": "c.jpg"}, "草稿本第 1 页（空白草稿纸）", "", "S1")

    def test_message_names_the_role(self):
        msg = self.msg(role={"page": "blank"})
        # 按字写在什么上面定做法的那一段删了（2026-11-12）：消息和固定说明里都没有；每页是什么照旧作为事实写出来
        for gone in ("怎么回应", "写在什么上面", "做法", "你写我审", "再判断我在做哪种事", "- 笔记："):
            self.assertNotIn(gone, msg)
            self.assertNotIn(gone, prompt.protocol())
        self.assertIn("改东西只按这一条规则", prompt.protocol())                     # 一条改动规则：在固定说明里，不随消息重复
        self.assertNotIn("改东西只按这一条规则", msg)
        self.assertIn("这次：这一页是空白纸，上面是我写的内容。", msg)
        self.assertNotIn("审阅", self.msg(role={"page": "blank"}, practice="review"))   # 平板上选做法没有了：带了也不写
        self.assertIn("这一页是 Zotero 文献的书页（只读资料）", self.msg(role={"page": "zotero"}))
        editable = self.msg(role={"page": "editable", "src": r"E:\p\大纲.docx"})
        self.assertIn(r"原文件是 E:\p\大纲.docx（要改它，先调 mcp__inkpad__ink_edit", editable)  # 2026-11-14：改之前先问覆盖还是另存、先留底
        self.assertNotIn("导入同一个文件，平板上原地更新", editable)
        meta = send_payload()
        meta["groups"][1]["on"] = "answer"             # 长回答不上纸了：没有「写在整段回答上」这回事，旧平板带了也不写
        meta["groups"][0].update(on="doc", red=True)   # 红笔问题写在书页上（g3 全擦掉了，不算）
        meta["groups"][2]["on"] = "doc"
        msg = prompt.build_message(dict(meta, role={"page": "pdf"}), {"overview": "o.jpg", "crop": "c.jpg"}, "书页", "", "S1")
        self.assertIn("看内容判断是我的稿子还是参考资料。g1 写在书页的印刷内容上。", msg)
        self.assertNotIn("整段回答", msg)
        self.assertIn("suggest 只用在改文档", prompt.protocol())
        self.assertNotIn("改东西只按这一条规则", prompt.build_scan_message("讲义", [], "S1"))

    def test_verdicts_section(self):
        self.assertNotIn("修改建议的决定", self.msg())
        msg = self.msg(verdicts=[
            {"id": "s1", "ref": "x1", "text": "改为：平均速度", "verdict": "yes", "on": "doc"},
            {"id": "s2", "ref": "x2", "text": "删去这句", "verdict": "no", "on": "mine", "near": "g5"}])
        self.assertIn("修改建议的决定：图里标 s1、s2 的虚线框是你提的修改，我逐条选了：", msg)
        self.assertIn("用 ink_reply 的 result 逐条告诉我结果", msg)
        self.assertIn("- s1（在文档上）「改为：平均速度」：采纳", msg)
        self.assertIn("- s2（在我写的内容上）「删去这句」：不采纳；旁边写了 g5", msg)
        self.assertIn("在我写的内容上的，我自己改，你不用动", msg)

    def test_suggest_item_and_page_role(self):
        self.assertEqual(server.clean_item({"type": "suggest", "text": "改为：ρ", "anchor": "g2"}),
                         {"type": "suggest", "text": "改为：ρ", "anchor": "g2"})
        self.assertIsNone(server.clean_item({"type": "suggest", "anchor": "g2"}))
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            self.assertEqual(app.page_role("scratch", 0), {"page": "blank"})
            src = Path(tmp) / "src"
            src.mkdir()
            make_pdf(src / "paper.pdf")
            (src / "大纲.md").write_text("# 大纲\n\n- 一\n", "utf-8")
            nb = app.import_document(src / "paper.pdf")
            self.assertEqual(app.page_role(nb, 0), {"page": "pdf", "src": str((src / "paper.pdf").resolve())})
            md = app.import_document(src / "大纲.md")
            self.assertEqual(app.page_role(md, 0)["page"], "editable")
            app.set_source(nb[5:], src / "paper.pdf", zotero={"item": "K1"})
            self.assertEqual(app.page_role(nb, 0), {"page": "zotero"})
            i = app.insert_page(nb, 0)
            self.assertEqual(app.page_role(nb, i), {"page": "blank"})   # 书里插的空白页
        page = {"strokes": [], "ai": [{"id": "s1", "type": "suggest", "text": "改为：ρ", "verdict": "yes", "box": [100, 100, 300, 140],
                                       "paths": [{"d": "M100 100 L300 100", "cls": "sbox"}]}]}
        notes = pdfsave.marks_of(page, 1414)["notes"]
        self.assertEqual([(n["subject"], n["text"]) for n in notes], [("修改建议", "修改建议（同意）：改为：ρ")])


class AnswerBadgeTest(unittest.TestCase):
    def test_answer_saved_into_pdf_as_badge_and_note(self):
        """存回 PDF：圈号画进 PDF（圆圈批注加数字），回答全文作为一条便签挂在圈号的位置（右上角）。"""
        t = 1_700_000_000_000
        w = answer_item("w1", 1, [229, 100], text="有：元分析。", q="有研究吗？", on=["r1"])
        page = {"strokes": [stroke("r1", t, 100, 100, red=True)], "ai": [w]}
        mk = pdfsave.marks_of(page, 1414)
        self.assertEqual([(n["subject"], n["text"]) for n in mk["notes"]], [("长回答", "圈号 1\n问：有研究吗？\n有：元分析。")])
        self.assertEqual(mk["notes"][0]["at"], (242, 87))                    # 圈号的右上角，不在原来回答排版的地方
        self.assertEqual([(b["n"], [round(v) for v in b["rect"]]) for b in mk["badges"]], [("1", [216, 87, 242, 113])])
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "p.pdf"
            doc = fitz.open()
            doc.new_page(width=1000, height=1414)
            doc.save(src)
            res = pdfsave.save(src, [(0, page)], keep.Keeper(Path(tmp) / "keep"), Path(tmp) / "w")
            self.assertEqual((res["ink"], res["notes"], res["marks"]), (1, 1, 0))
            got = own_annots(src)
            self.assertEqual(sorted(a[1] for a in got), ["Circle", "FreeText", "Ink", "Text"])
            circ = next(a for a in got if a[1] == "Circle")
            note = next(a for a in got if a[1] == "Text")
            num = next(a for a in got if a[1] == "FreeText")
            with fitz.open(src) as d2:
                rects = {a.type[1]: a.rect for a in d2[0].annots()}
            self.assertLess(abs(rects["Circle"].x0 - 216), 2.5)
            self.assertLess(abs(rects["Circle"].y0 - 87), 2.5)
            self.assertLess(abs(rects["Text"].x0 - 242), 2.5)                # 便签挂在圈号旁边
            self.assertLess(abs(rects["Text"].y0 - 87), 2.5)
            self.assertIn("有：元分析。", note[3])
            self.assertEqual((circ[3], num[3]), ("圈号 1", "1"))
            again = pdfsave.save(src, [(0, page)], keep.Keeper(Path(tmp) / "keep"), Path(tmp) / "w")
            self.assertEqual((again["removed"], len(own_annots(src))), (4, 4))  # 再存是替换，不叠加


class MarksTest(unittest.TestCase):
    def test_correction_marks_are_accepted_and_explained(self):
        for t in ("tick", "highlight", "brace"):
            self.assertEqual(server.clean_item({"type": t, "anchor": "g2"}), {"type": t, "anchor": "g2"})
        for t in ("cross", "strike", "wavy"):                                          # ✗、删除线、存疑必须写理由
            self.assertIsNone(server.clean_item({"type": t, "anchor": "g2"}))
        self.assertEqual(server.clean_item({"type": "cross", "anchor": "g2", "text": "反了"})["text"], "反了")
        self.assertIsNone(server.clean_item({"type": "insert", "anchor": "g2"}))   # 补什么得写上
        self.assertIsNone(server.clean_item({"type": "number", "anchor": "g2"}))
        self.assertEqual(server.clean_item({"type": "number", "anchor": "g2", "text": "12345"})["text"], "123")
        msg = prompt.protocol()
        self.assertIn("标记用来代替大段的话，不是越多越好", msg)
        for t in ("tick", "cross", "strike", "insert", "wavy", "highlight", "brace", "number"):
            self.assertIn(t, msg)
        self.assertNotIn("回答再短也用 write", msg)

    def test_marks_render_and_save_into_pdf(self):
        page = {"strokes": [stroke("a", 1, 100, 200)], "ai": [
            {"id": "h1", "type": "highlight", "box": [96, 190, 300, 214], "paths": [{"d": "M96 190 L300 190 L300 214 L96 214 L96 190", "cls": "hl"}],
             "hit": [96, 190, 300, 214], "on": ["a"]},
            {"id": "x1", "type": "cross", "text": "反了", "box": [96, 190, 160, 214], "on": ["a"],
             "paths": [{"d": "M320 192 L340 212 M340 192 L320 212", "w": 2.4}], "hit": [316, 188, 460, 216],
             "lay": {"x": 350, "y": 190, "w": 120, "h": 24, "lines": ["反了"], "fs": 18, "lh": 24}}]}
        with tempfile.TemporaryDirectory() as tmp:
            r, g, b = pix_at(page, tmp, 250, 196)
            self.assertTrue(r > 200 and g > 190 and b < 200, (r, g, b))   # 荧光笔：黄底
        mk = pdfsave.marks_of(page, 1414)
        self.assertEqual([(h["subject"], [round(v) for v in h["rect"]]) for h in mk["hl"]], [("荧光笔", [96, 190, 300, 214])])
        self.assertIn(("打叉", "反了"), [(m["subject"], m["content"]) for m in mk["ink"]])
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "p.pdf"
            make_pdf(src)
            res = pdfsave.save(src, [(0, page)], keep.Keeper(Path(tmp) / "keep"), Path(tmp) / "w")
            self.assertEqual((res["marks"], res["hl"]), (1, 1))
            self.assertEqual(sorted(a[1] for a in own_annots(src)), ["Highlight", "Ink", "Ink"])


class ConceptMapTest(unittest.TestCase):
    def test_map_items_are_checked_and_explained(self):
        self.assertEqual(server.clean_item({"type": "label", "anchor": "g3", "text": "导致"}), {"type": "label", "anchor": "g3", "text": "导致"})
        self.assertIsNone(server.clean_item({"type": "label", "anchor": "g3"}))
        self.assertEqual(server.clean_item({"type": "node", "text": "零花钱不够", "anchor": "g2", "links": ["g2", 5, "", None]}),
                         {"type": "node", "text": "零花钱不够", "anchor": "g2", "links": ["g2", "5"]})
        self.assertIsNone(server.clean_item({"type": "link", "from": "g1"}))          # 连线要两头
        self.assertEqual(server.clean_item({"type": "link", "from": "g1", "to": "g4", "text": "减少"})["to"], "g4")
        self.assertIsNone(server.clean_item({"type": "group", "text": "开销"}))          # 分组要说是哪几组
        self.assertEqual(server.clean_item({"type": "group", "text": "开销", "anchors": ["g1", "g2"]})["anchors"], ["g1", "g2"])
        msg = prompt.protocol()
        for t in ("label", "node", "link", "group", "anchors", "links"):
            self.assertIn(t, msg)
        msg = prompt.build_message(dict(send_payload(), verdicts=[
            {"id": "s1", "ref": "n1", "kind": "node", "text": "零花钱不够", "verdict": "yes", "on": "mine"},
            {"id": "s2", "ref": "l1", "kind": "link", "text": "减少", "verdict": "no", "on": "mine", "near": "g6"},
            {"id": "s3", "ref": "x1", "kind": "suggest", "text": "改为：ρ", "verdict": "yes", "on": "doc"}]),
            {"overview": "o.jpg", "crop": "c.jpg"}, "草稿本第 1 页", "", "S1")
        self.assertIn("图里标 s1、s2、s3 的虚线是你提的修改和概念图上建议加的东西", msg)
        self.assertIn("- s1建议加的概念「零花钱不够」：采纳", msg)
        self.assertIn("- s2建议的连线「减少」：不采纳；旁边写了 g6", msg)
        self.assertIn("- s3（在文档上）「改为：ρ」：采纳", msg)
        self.assertIn("采纳的在平板上已变成实线", msg)
        only = prompt.verdict_block([{"id": "s1", "kind": "group", "text": "开销", "verdict": "yes"}])
        self.assertIn("的虚线是你在概念图上建议加的东西", only)
        self.assertNotIn("改原文件", only)

    def test_votes_on_map_items_go_out_with_whole_notebook_send(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            page = {"strokes": [stroke("a", 1, 100, 100)], "ai": [
                {"id": "n1", "type": "node", "t": 5, "text": "零食", "verdict": "yes", "box": [400, 90, 520, 140], "vbox": [400, 90, 520, 140],
                 "paths": [{"d": "M400 115 L520 115", "cls": "dash"}]},
                {"id": "g1", "type": "group", "t": 5, "text": "开销", "box": [80, 60, 300, 160], "paths": []},   # 还没点
                {"id": "l1", "type": "link", "t": 5, "text": "减少", "verdict": "no", "sent": True, "box": [100, 100, 200, 200]}]}  # 发过了
            vs = app.page_verdicts(page, [])
            self.assertEqual([(v["id"], v["ref"], v["kind"], v["verdict"]) for v in vs], [("s1", "n1", "node", "yes")])

    def test_map_items_render_and_save(self):
        page = {"strokes": [stroke("a", 1, 100, 200)], "ai": [
            {"id": "n1", "type": "node", "text": "零食", "box": [400, 180, 520, 230], "verdict": "yes",
             "paths": [{"d": "M400 205 L520 205", "cls": "dash", "w": 2}], "hit": [400, 180, 520, 230]},
            {"id": "n2", "type": "node", "text": "车费", "box": [400, 300, 520, 350], "verdict": "no",
             "paths": [{"d": "M400 325 L520 325", "cls": "dash", "w": 2}], "hit": [400, 300, 520, 350]},
            {"id": "l1", "type": "label", "text": "导致", "box": [96, 190, 300, 214], "on": ["a"],
             "lay": {"x": 180, "y": 160, "w": 40, "h": 26, "lines": ["导致"], "fs": 20, "lh": 26}, "hit": [180, 160, 220, 186]}]}
        mk = pdfsave.marks_of(page, 1414)
        self.assertEqual([(m["subject"], m["content"]) for m in mk["ink"] if m["title"] != pdfsave.ME],
                         [("建议的概念", "建议的概念（同意）：零食")])                       # 没同意的不写
        self.assertEqual([(n["subject"], n["text"]) for n in mk["notes"]], [("关系词", "导致")])
        with tempfile.TemporaryDirectory() as tmp:
            r, g, b = pix_at(page, tmp, 460, 205)
            self.assertTrue(b > 150 and r < 120, (r, g, b))                                  # 同意了的：实线，蓝


class SketchTest(unittest.TestCase):
    def test_sketch_shapes_are_checked(self):
        it = server.clean_item({"type": "sketch", "anchor": "g2", "w": 9999, "text": "路线示意", "shapes": [
            {"type": "rect", "x": 10, "y": 10, "w": 120, "h": 60, "text": "超市", "dash": "yes"},
            {"type": "line", "pts": [[130, 40], [300, 40], ["x", 1]], "arrow": "end", "text": "走路"},
            {"type": "line", "pts": [[1, 1]]},                       # 只有一个点：不要
            {"type": "ellipse", "cx": 400, "cy": 40, "rx": 50},      # 缺 ry：不要
            {"type": "star", "x": 1, "y": 1},                        # 不认得的形状
            {"type": "axes", "x": 20, "y": 100, "w": 300, "h": 150, "xlabel": "月", "ylabel": "元"},
            {"type": "text", "x": 5, "y": 5, "text": "注", "size": True}]})
        self.assertEqual((it["w"], it["h"], it["text"], it["anchor"]), (2000.0, 300.0, "路线示意", "g2"))
        self.assertEqual([s["type"] for s in it["shapes"]], ["rect", "line", "axes", "text"])
        self.assertEqual(it["shapes"][0], {"type": "rect", "x": 10.0, "y": 10.0, "w": 120.0, "h": 60.0, "text": "超市"})
        self.assertEqual(it["shapes"][1]["pts"], [[130.0, 40.0], [300.0, 40.0]])
        self.assertNotIn("size", it["shapes"][3])
        self.assertIsNone(server.clean_item({"type": "sketch", "shapes": [{"type": "star"}]}))
        msg = prompt.protocol()
        for t in ("sketch", "nodes", "edges", "groups", "不写坐标", "figure", "path"):
            self.assertIn(t, msg)

    def test_sketch_structure_is_laid_out(self):
        it = server.clean_item({"type": "sketch", "text": "做饭", "nodes": ["买菜", "洗菜", {"id": "cook", "text": "下锅"}],
                                "edges": [{"from": "买菜", "to": "洗菜", "text": "回家"}, {"from": "洗菜", "to": "cook"}],
                                "shapes": [{"type": "rect", "x": 0, "y": 0, "w": 1, "h": 1}]})      # 给了结构：不看 shapes
        self.assertEqual([s["type"] for s in it["shapes"]], ["rect", "rect", "rect", "line", "line"])
        self.assertEqual([s.get("text") for s in it["shapes"]], ["买菜", "洗菜", "下锅", "回家", None])
        self.assertEqual([n["id"] for n in it["struct"]["nodes"]], ["买菜", "洗菜", "cook"])
        right = max(s["x"] + s["w"] for s in it["shapes"] if s["type"] == "rect")
        self.assertTrue(right < it["w"] <= 2000 and it["h"] < 300)
        self.assertIsNone(server.clean_item({"type": "sketch", "nodes": [""]}))

    def test_sketch_renders_labels_and_saves(self):
        page = {"strokes": [], "ai": [{"id": "k1", "type": "sketch", "text": "示意", "box": [100, 300, 700, 600], "hit": [100, 300, 700, 600],
                                       "paths": [{"d": "M120 320 L680 320", "w": 2}],
                                       "labels": [{"x": 300, "y": 400, "w": 120, "text": "买西瓜", "fs": 40}]}]}
        with tempfile.TemporaryDirectory() as tmp:  # 字画出来了：那一块里有蓝色像素
            out = Path(tmp) / "k.png"
            pages.render_page(page, str(out), 1414, None, (), 1)
            pm = fitz.Pixmap(str(out))
            blue = sum(1 for x in range(300, 420, 2) for y in range(400, 444, 2) if pm.pixel(x, y)[2] > 120 and pm.pixel(x, y)[0] < 120)
            self.assertGreater(blue, 3)
        self.assertEqual(pages.content_extent(dict(page, h=900), 400)[1], 640)        # 示意图算进有内容的范围
        mk = pdfsave.marks_of(page, 1414)
        self.assertEqual([(m["subject"], m["content"]) for m in mk["ink"]], [("示意图", "示意图：示意（图中的字：买西瓜）")])


class FigureTest(unittest.TestCase):
    def figure_files(self, tmp):
        png = Path(tmp) / "曲线.png"
        pm = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 200, 100), 1)  # 带透明通道：透明处铺白
        pm.clear_with()  # 不给值：连透明度一起清零
        pm.set_rect(fitz.IRect(0, 0, 100, 100), (220, 30, 30, 255))
        pm.save(str(png))
        svg = Path(tmp) / "chart.svg"
        svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect width="300" height="150" fill="#fff"/>'
                       '<path d="M10 140 L290 10" stroke="#00f" stroke-width="4"/></svg>', "utf-8")
        return png, svg

    def test_figure_is_checked_and_stored(self):
        self.assertIsNone(server.clean_item({"type": "figure", "text": "图"}))       # 要 path
        it = server.clean_item({"type": "figure", "path": " C:/x/a.png ", "text": "每月开销" * 20, "anchor": "g1"})
        self.assertEqual((it["path"], len(it["text"]), it["anchor"]), ("C:/x/a.png", 60, "g1"))
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            png, svg = self.figure_files(tmp)
            a = app.store_figure(str(png))
            self.assertEqual((a["iw"], a["ih"]), (200, 100))                            # PNG 照原来的像素
            stored = app.data / "figures" / a["img"]
            self.assertTrue(server.FIG_NAME.match(a["img"]) and stored.is_file())
            pm = fitz.Pixmap(str(stored))
            self.assertEqual((pm.alpha, pm.pixel(150, 50)), (0, (255, 255, 255)))       # 透明处是白的
            self.assertEqual(app.store_figure(str(png))["img"], a["img"])               # 同一张图只存一份
            b = app.store_figure(str(svg))
            self.assertEqual((b["iw"], b["ih"]), (900, 450))                            # SVG 画成 PNG
            with self.assertRaises(ValueError):
                app.store_figure(str(Path(tmp) / "没有.png"))
            (Path(tmp) / "a.gif").write_bytes(b"GIF89a")
            with self.assertRaises(ValueError):
                app.store_figure(str(Path(tmp) / "a.gif"))

    def test_figure_renders_and_saves_into_pdf(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            png, _ = self.figure_files(tmp)
            a = app.store_figure(str(png))
            fig = {"x": 100, "y": 300, "w": 400, "h": 200}
            page = {"strokes": [], "ai": [{"id": "f1", "type": "figure", "text": "曲线", "fig": fig, "img": a["img"], "iw": 200, "ih": 100,
                                           "box": [92, 292, 508, 544], "hit": [92, 292, 508, 544], "paths": [],
                                           "labels": [{"x": 270, "y": 508, "w": 60, "text": "曲线", "fs": 20}]}]}
            out = Path(tmp) / "r.png"
            pages.render_page(page, str(out), 1414, None, (), 1)
            pm = fitz.Pixmap(str(out))
            r, g, b = pm.pixel(150, 400)[:3]
            self.assertTrue(r > 180 and g < 90, (r, g, b))                             # 图画在 fig 那块：左半是红的
            mk = pdfsave.marks_of(page, 1414)
            self.assertEqual([(x["content"], x["rect"]) for x in mk["figs"]], [("图（Claude 生成）：曲线", [100, 300, 500, 500])])
            src = Path(tmp) / "paper.pdf"
            make_pdf(src)
            for _ in range(2):  # 再存不叠加
                res = pdfsave.save(src, [(0, page)], keep.Keeper(Path(tmp) / "keep"), Path(tmp) / "w")
            self.assertEqual(res["marks"], 1)
            self.assertEqual([(t, c) for _, t, _, c in own_annots(src)], [("Stamp", "图（Claude 生成）：曲线")])

    def test_reply_with_figure_and_serve(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            png, _ = self.figure_files(tmp)
            server.Handler.app = app
            httpd = server.Server(("127.0.0.1", 0), server.Handler)
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            try:
                def j(method, path, body=None):
                    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, method=method)
                    req.add_header("X-Access", app.code)
                    req.add_header("Content-Type", "application/json")
                    try:
                        with urllib.request.urlopen(req, timeout=30) as r:
                            return r.status, r.read()
                    except urllib.error.HTTPError as e:
                        return e.code, e.read()
                j("POST", "/bridge/hello", {"sid": "S1", "label": "idea", "cwd": tmp})
                sub = json.loads(j("POST", "/api/send", send_payload())[1])
                st, raw = j("POST", "/bridge/reply", {"sid": "S1", "submission": sub["id"], "items": [
                    {"type": "figure", "path": str(png), "text": "曲线", "anchor": "g1"}]})
                self.assertEqual(st, 200, raw)
                it = json.loads(app._key_file("scratch", "p0000", ".pending.json").read_text("utf-8"))[0]["items"][0]
                self.assertEqual((it["type"], "path" in it, it["iw"], it["src"]), ("figure", False, 200, str(png)))
                st, body = j("GET", "/api/figure?f=" + it["img"])
                self.assertEqual((st, body[:4]), (200, b"\x89PNG"))
                self.assertEqual(j("GET", "/api/figure?f=../config.json")[0], 404)
                st, raw = j("POST", "/bridge/reply", {"sid": "S1", "submission": sub["id"], "items": [
                    {"type": "figure", "path": str(Path(tmp) / "没有.png")}]})
                self.assertEqual(st, 400)
                self.assertIn("找不到文件", json.loads(raw)["error"])
            finally:
                httpd.shutdown()
                httpd.server_close()


class FormulaTest(unittest.TestCase):
    def test_formula_item_and_hint(self):
        self.assertEqual(server.clean_item({"type": "formula", "tex": " \\frac{a}{b} ", "anchor": "end"}),
                         {"type": "formula", "anchor": "end", "tex": "\\frac{a}{b}", "text": "\\frac{a}{b}"})
        self.assertIsNone(server.clean_item({"type": "formula", "text": "x"}))       # 要 tex
        msg = prompt.protocol()
        self.assertIn("formula（tex 写 LaTeX", msg)
        self.assertIn("$$…$$", msg)
        page = {"strokes": [], "ai": [{"id": "f1", "type": "formula", "tex": "3+4=7", "text": "3+4=7", "box": [300, 300, 500, 360],
                                       "lay": {"x": 308, "y": 306, "w": 184, "h": 48, "lines": ["3+4=7"], "fs": 18, "lh": 48},
                                       "paths": [], "hit": [300, 300, 500, 360]}]}
        self.assertEqual([(n["subject"], n["text"]) for n in pdfsave.marks_of(page, 1414)["notes"]], [("公式", "公式：3+4=7")])


class PageRevTest(unittest.TestCase):
    def test_older_version_from_another_device_is_kept_aside(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            body = lambda rev, n: json.dumps({"v": 1, "strokes": [stroke(f"s{k}", 1, 10 * k, 10) for k in range(n)], "ai": [], "rev": rev})  # noqa: E731
            self.assertEqual(app.save_page("scratch", 0, body(0, 1), client="ipad"), 1)
            self.assertEqual(app.save_page("scratch", 0, body(0, 2), client="ipad"), 2)    # 同一台连着存：body 里的版本还没更新也不算冲突
            self.assertEqual(app.save_page("scratch", 0, body(2, 3), client="mac"), 3)     # 另一台拿着最新版本存：照存
            with self.assertRaises(server.Conflict) as cm:
                app.save_page("scratch", 0, body(2, 9), client="ipad")                      # 这台手里是旧版本：不覆盖
            self.assertIn("data/conflicts/", str(cm.exception))
            saved = json.loads(app.load_page("scratch", 0))
            self.assertEqual((len(saved["strokes"]), saved["rev"], saved["by"]), (3, 3, "mac"))
            kept = list((Path(tmp) / "data" / "conflicts").iterdir())
            self.assertEqual(len(kept), 1)
            self.assertEqual(len(json.loads(kept[0].read_text("utf-8"))["strokes"]), 9)  # 没存上的那份留着
            self.assertEqual(app.save_page("scratch", 0, json.dumps({"v": 1, "strokes": [], "ai": []}), client="old"), 4)  # 旧版页面不带 rev：照旧存


class LaunchTest(unittest.TestCase):
    def test_auto_restart_respects_user_stop(self):
        import launch
        with tempfile.TemporaryDirectory() as tmp:
            old_root, old_argv, old_alive = launch.ROOT, sys.argv, launch.alive
            launch.ROOT = Path(tmp)
            launch.alive = lambda p: False
            started = []
            old_wmi, old_det = launch.start_via_wmi, launch.start_detached
            launch.start_via_wmi = lambda extra, log: started.append(extra) or False
            launch.start_detached = lambda extra, log: started.append(extra)
            try:
                (Path(tmp) / "data").mkdir()
                (Path(tmp) / "data" / "stopped.flag").write_text("x", "utf-8")
                sys.argv = ["launch.py", "--auto"]
                self.assertEqual(launch.main(), 0)
                self.assertEqual(started, [])                                    # 用户自己停的：自动重启不启动
                sys.argv = ["launch.py", "--port", "1"]
                launch.main()
                self.assertEqual(started[0], ["--port", "1"])                     # /ink 明确要启动：照常启动
            finally:
                launch.ROOT, sys.argv, launch.alive = old_root, old_argv, old_alive
                launch.start_via_wmi, launch.start_detached = old_wmi, old_det


class BackupTest(unittest.TestCase):
    def test_daily_backup_and_restore(self):
        import backup
        from datetime import datetime as dt
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            app.save_page("scratch", 0, json.dumps({"v": 1, "strokes": [stroke("a", 1, 10, 10)], "ai": []}), client="t")
            (app.books / "_sources.json").write_text('{"x.pdf": {"src": "E:/x.pdf"}}', "utf-8")
            # Claude 放上来的图（data/figures）、冲突时另存的那份（data/conflicts）：都没法重新得到，也要备份
            (app.data / "figures").mkdir(exist_ok=True)
            (app.data / "figures" / "0123456789abcdef.png").write_bytes(b"\x89PNG fig")
            (app.data / "conflicts").mkdir(exist_ok=True)
            (app.data / "conflicts" / "scratch-page-0000-20261101-030000-ab12.json").write_text('{"strokes": []}', "utf-8")
            # 抽屉里的文件夹（2026-11-14）：notebooks/folders.json 也要备份
            pad = app.new_pad("随笔")
            app.change_folders(lambda fs: folders.move(fs, pad, folders.create(fs, "原先", folded=True)["id"]))
            out = backup.daily(app.data, app.books, now=dt(2026, 11, 1, 3))
            self.assertIsNone(backup.daily(app.data, app.books, now=dt(2026, 11, 1, 20)))      # 一天只做一份
            import zipfile
            names = zipfile.ZipFile(out).namelist()
            self.assertIn("books/_sources.json", names)
            self.assertIn("data/access_code.txt", names)
            self.assertTrue(any(n.startswith("data/notebooks/scratch/") and n.endswith(".json") for n in names))
            self.assertIn("data/figures/0123456789abcdef.png", names)
            self.assertIn("data/conflicts/scratch-page-0000-20261101-030000-ab12.json", names)
            self.assertIn("data/notebooks/folders.json", names)
            self.assertIn("data/notebooks/pads.json", names)
            self.assertFalse(any("cache" in n or "submissions" in n for n in names))         # 能重新得到的不备份
            for day in range(2, 12):
                backup.daily(app.data, app.books, now=dt(2026, 11, day))
            kept = sorted(p.name for p in (app.data / "backups" / "daily").glob("*.zip"))
            self.assertEqual((len(kept), kept[0]), (backup.KEEP, "inkthink-20261105.zip"))   # 只留最近 7 份
            app.save_page("scratch", 0, json.dumps({"v": 1, "strokes": [], "ai": []}), client="t")  # 之后写坏了
            folders.path_of(app.data).unlink()                                               # 文件夹的记录也丢了
            shutil.rmtree(app.data / "figures")                                              # 图和另存的那份也丢了
            (app.data / "conflicts" / "scratch-page-0000-20261101-030000-ab12.json").unlink()
            (app.data / "conflicts" / "scratch-page-0000-20261112-090000-cd34.json").write_text("{}", "utf-8")  # 备份之后才有的
            aside = backup.restore(app.data / "backups" / "daily" / "inkthink-20261111.zip", app.data, app.books)
            self.assertEqual(len(json.loads(app.load_page("scratch", 0))["strokes"]), 1)     # 恢复回来
            self.assertEqual([(f["name"], f["items"], f.get("folded")) for f in folders.load(app.data)], [("原先", [pad], True)])
            self.assertTrue((aside / "notebooks").is_dir())                                  # 恢复前的挪到旁边，不删
            self.assertEqual((app.data / "figures" / "0123456789abcdef.png").read_bytes(), b"\x89PNG fig")  # 图放回来了
            self.assertEqual(sorted(p.name for p in (app.data / "conflicts").iterdir()),     # 另存的那份放回来，后来的也还在
                             ["scratch-page-0000-20261101-030000-ab12.json", "scratch-page-0000-20261112-090000-cd34.json"])


class ResultTest(unittest.TestCase):
    def test_result_maps_s_number_to_suggestion(self):
        self.assertEqual(server.clean_item({"type": "result", "anchor": "s1", "ok": False, "text": "原文件被占用"}),
                         {"type": "result", "anchor": "s1", "text": "原文件被占用", "ok": False})
        self.assertIsNone(server.clean_item({"type": "result", "anchor": "s1"}))           # ok 要写
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            sub_id, d = app.new_sub_dir()
            meta = dict(send_payload(), id=sub_id, nb="scratch", page=0, page_key="p0000",
                        verdicts=[{"id": "s1", "ref": "sg-7", "verdict": "yes"}])
            (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), "utf-8")
            self.assertEqual(app.locate("S1", sub_id)["vx"], {"s1": "sg-7"})


class InkStatesTest(unittest.TestCase):
    def test_faded_and_adopted_render_and_save(self):
        """之前几轮的不再变淡（2026-11-02：回答收进弹窗，不挡着了）；采纳的照旧深蓝。"""
        red = dict(stroke("r", 1, 100, 200), c="r", faded=True)
        page = {"strokes": [red], "ai": [
            {"id": "n1", "type": "note", "text": "旧的", "faded": True, "box": [100, 190, 300, 214], "paths": [{"d": "M100 300 L400 300", "w": 4}],
             "lay": {"x": 100, "y": 320, "w": 200, "h": 30, "lines": ["旧的"], "fs": 20, "lh": 26}, "hit": [100, 300, 400, 350]},
            {"id": "n0", "type": "note", "text": "这一轮的", "box": [100, 190, 300, 214], "paths": [{"d": "M100 700 L400 700", "w": 4}],
             "lay": {"x": 100, "y": 720, "w": 200, "h": 30, "lines": ["这一轮的"], "fs": 20, "lh": 26}, "hit": [100, 700, 400, 750]},
            {"id": "n2", "type": "note", "text": "采纳的", "adopted": True, "box": [100, 190, 300, 214], "paths": [{"d": "M100 500 L400 500", "w": 4}],
             "lay": {"x": 100, "y": 520, "w": 200, "h": 30, "lines": ["采纳的"], "fs": 20, "lh": 26}, "hit": [100, 500, 400, 550]}]}
        with tempfile.TemporaryDirectory() as tmp:
            faded = pix_at(page, tmp, 250, 300)
            plain = pix_at(page, tmp, 250, 700)
            adopted = pix_at(page, tmp, 250, 500)
        self.assertLess(abs(sum(faded) - sum(plain)), 30)                         # 之前几轮的和这一轮的一样
        self.assertGreater(sum(plain), sum(adopted) + 60)                         # 采纳的深
        notes = pdfsave.marks_of(page, 1414)["notes"]
        self.assertIn("（AI 提供、已采纳）采纳的", [n["text"] for n in notes])     # 存回 PDF 写明来源
        self.assertIn("深蓝带 ★ 的是用户采纳的", prompt.protocol())


class AnswerScanTest(unittest.TestCase):
    def test_scan_lists_answers_by_badge_number(self):
        """整本消息里图上只有圈号：每页另列出这一页之前写过的长回答（圈号 n、问、前 200 个字），擦掉的不列。"""
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            t = 1_700_000_000_000
            ai = [answer_item("w2", 2, [330, 200], text="第二条", t=t + 3000),
                  answer_item("w1", 1, [330, 100], text="长" * 300, q="提纲", on=["a"], t=t + 1000),
                  answer_item("w3", 3, [330, 300], text="擦掉的那条", erasedAt=t + 9000, dismissed=True)]
            page = {"v": 1, "strokes": [stroke("a", t, 100, 100, red=True)], "ai": ai}
            app.save_page("scratch", 0, json.dumps(page), client="t")
            _, text, n = app.scan("scratch")
            self.assertEqual(n, 1)
            self.assertIn("你之前在这一页写过的长回答（图里的蓝色圈号）：\n- 圈号 1（问：提纲）：" + "长" * 200 + "…\n- 圈号 2：第二条", text)
            self.assertNotIn("擦掉的那条", text)
            for gone in ("改写", "revises", "收着时", "另画在"):
                self.assertNotIn(gone, text)


class UnplacedTest(unittest.TestCase):
    def test_scan_says_replies_still_queued(self):
        info = {"no": 2, "image": "p2.jpg", "label": "草稿本第 2 页", "scale": 1, "h": 1414, "groups": [], "now": 0, "first": False,
                "unplaced": 3}
        msg = prompt.build_scan_message("草稿本", [info], "S1")
        self.assertIn("你之前写回这一页的 3 条批注还在排队", msg)
        self.assertNotIn("还在排队", prompt.build_scan_message("草稿本", [dict(info, unplaced=0)], "S1"))


class AnswerMessageTest(unittest.TestCase):
    def test_no_rewrite_and_answers_listed_by_badge(self):
        """改写那一套删了：write 不再认 revises，消息里没有「改写」；之前写过的长回答写成「圈号 n（问：q）：前 200 个字…」。"""
        self.assertEqual(server.clean_item({"type": "write", "text": "新版", "q": "改大纲", "anchor": "g3", "revises": "a1"}),
                         {"type": "write", "text": "新版", "anchor": "g3", "q": "改大纲"})
        self.assertIsNone(server.clean_item({"type": "write", "q": "没写全文"}))         # text 必填
        meta = send_payload()
        meta["followup"] = [{"id": "a1", "ref": "w1", "type": "write", "q": "大纲", "text": "旧", "why": "在上面写了 g2"}]  # 旧平板带了也不写
        meta["prev_notes"] = ["这里应为 ρ", {"n": 1, "q": "这一步为什么取零？", "text": "因为两边" + "等" * 250},
                              {"n": 2, "text": "短的\n两行"}, {"n": 3, "text": "  "}]
        msg = prompt.build_message(meta, {"crop": "c.jpg"}, "草稿本第 1 页（空白草稿纸）", "", "S1")
        self.assertIn("你之前在这一页写过的批注：\n- 这里应为 ρ\n- 圈号 1（问：这一步为什么取零？）：因为两边" + "等" * 196 + "…\n- 圈号 2：短的 两行", msg)
        for gone in ("改写", "revises", "整段回答", "a1（"):
            self.assertNotIn(gone, msg)
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            sub_id, d = app.new_sub_dir()
            (d / "meta.json").write_text(json.dumps(dict(meta, id=sub_id, nb="scratch", page=0, page_key="p0000"), ensure_ascii=False), "utf-8")
            self.assertNotIn("fu", app.locate("S1", sub_id))
        self.assertFalse(hasattr(server, "revise_refs") or hasattr(prompt, "revise_block") or hasattr(pages, "hidden_ids"))


def answer_item(aid, n, at, text="回答全文", q=None, on=None, seen=False, **kw):
    """一条长回答（新格式：平板上是圈号 n，圆心 at）。"""
    it = {"id": aid, "type": "write", "t": 1_700_000_000_000, "req": "r1", "text": text, "on": on or [], "n": n, "at": at, "seen": seen}
    if q:
        it["q"] = q
    it.update(kw)
    return it


def pix_at(page, tmp, x, y, base_h=1414):
    """把一页画成图（1 像素 = 1 个页面单位），取 (x, y) 处的颜色。"""
    out = Path(tmp) / f"px-{x}-{y}.png"
    pages.render_page(page, str(out), base_h, None, (), 1)
    return fitz.Pixmap(str(out)).pixel(int(x), int(y))


class PromptTest(unittest.TestCase):
    def test_timeline_mentions_pauses_erasures_and_revisits(self):
        now = groups_fixture()[-1]["t1"] + 30000
        tl = prompt.build_timeline(groups_fixture(), now, True)
        # 单页投递：整页都交上来了，每组都列，不标 ★、也不解释 ★
        self.assertIn("\ng1｜00:00 开始", tl)
        self.assertIn("\ng2｜01:10 开始，写了 12 秒，之前停顿 1 分 05 秒", tl)
        self.assertNotIn("★", tl)
        self.assertTrue(tl.startswith("书写过程（时间从这一页第一笔算起）。这一页共 3 组笔迹"))
        self.assertIn("其中 2 笔已擦掉（01:30 擦）", tl)
        # 全部擦掉的组不逐条列，只一行（第 3 阶段）
        self.assertIn("已经全部擦掉的（g3，共 3 笔）不逐条列出", tl)
        self.assertNotIn("g3｜", tl)
        # 整本消息：上次看过之后新写或擦改的标 ★
        scan = prompt.build_timeline(groups_fixture(), now, True, star="上次之后新写或擦改的")
        self.assertTrue(scan.startswith("书写过程（时间从这一页第一笔算起；★ 表示上次之后新写或擦改的）。"))
        self.assertIn("\n★ g2｜01:10 开始", scan)
        self.assertIn("\n   g1｜00:00 开始", scan)
        self.assertIn("已经全部擦掉的（★ g3，共 3 笔）不逐条列出", scan)
        kept = [dict(g, erased=0, erasedAt=None) if g["id"] == "g3" else g for g in groups_fixture()]
        self.assertIn("回头补写", prompt.build_timeline(kept, now, True))
        self.assertIn("最近一笔在 30 秒前", tl)
        red = [dict(g, red=(g["id"] == "g2")) for g in groups_fixture()]
        self.assertIn("2 笔已擦掉（01:30 擦）｜红笔（问题）", prompt.build_timeline(red, now, True))

    def test_protocol_is_third_person_and_keeps_quotes(self):
        p = prompt.protocol()
        self.assertTrue(p.startswith("## 手写草稿纸（inkpad）"))
        for must in ("改东西只按这一条规则", "两层：", "最多一条点拨", "没有就一条都不写", "写出依据",
                     "不是越多越好", "写英文就用英文回", "sketch", "ink_confirm", "【草稿纸·整本】"):
            self.assertIn(must, p)
        # 长回答（2026-11-13）：平板标圈号、点开看全文；不再自己用 number 配页末的 write，不再改写（revises）
        for must in ("长的用 write，anchor 填所答的那条红字（或它讲的那处笔迹），q 填问题原文", "平板在那里标一个圈号，用户点圈号才看到全文，不占纸面",
                     "不要自己用 number 标圈号去配页末的 write，anchor 也不要写 end", "用红笔要你改写你的某条回答时，回一条新的 write（anchor 填那条红笔），旧的那条用户自己擦",
                     "给步骤排顺序的 number"):
            self.assertIn(must, p)
        for gone in ("像脚注", "revises", "旧版收起", "写在纸上；anchor 写 end", "解释按圈号写在页末"):
            self.assertNotIn(gone, p)
        self.assertIn("用户写完一段点「检查」才交上来", p)  # 「我」换成了「用户」
        # 问话卡片（2026-11-14）：只在两种情况下发；没答就停手等着、不替用户选
        for must in ("能写在纸上的都写在纸上", "mcp__inkpad__ink_ask", "要用户回答才能继续的问题", "纸上放不下的结果",
                     "这一轮就停在这里等着，不替用户选；用户答了会作为一条新消息送来"):
            self.assertIn(must, p)
        self.assertEqual(prompt._third("我说「帮我整理」就照我说的办"), "用户说「帮我整理」就照用户说的办")  # 引号里我举的原话不改
        self.assertNotIn("我", re.sub(r"「[^」]*」", "", p))
        # 删掉的功能，固定说明里不再提：按底子分做法、档位、快通道、补一句、框选、文档更新后判断旧批注
        for gone in ("写在什么上面", "做法", "细则", "快看", "细想", "初判", "回答弹窗", "回应分三层", "另外写的一句", "圈选", "sel",
                     "旧批注", "ink_relocate"):
            self.assertNotIn(gone, p)

    def test_message_only_has_this_page(self):
        meta = send_payload()
        paths = {"overview": "E:\\d\\overview.jpg", "crop": "E:\\d\\crop.jpg"}
        msg = prompt.build_message(meta, paths, "草稿本第 1 页", "", "S1")
        self.assertIn('submission="S1"', msg)
        self.assertIn("E:\\d\\crop.jpg", msg)
        self.assertIn("书写过程", msg)
        for rule in (prompt.EDIT_RULE, prompt.WRITE_HINT[:20], prompt.COLORS[:10], prompt.CONFIRM_HINT[:20]):  # 固定说明在系统提示里
            self.assertNotIn(rule, msg)
        # 做法、档位、补一句都没有了：平板带了这些也不写进消息
        old = prompt.build_message(dict(meta, practice="review", depth="deep", note="单位对吗"), paths, "x", "", "S1")
        for gone in ("做法", "审阅", "档位", "细想", "另外写的一句", "单位对吗"):
            self.assertNotIn(gone, old)
        self.assertEqual(old, prompt.build_message(meta, paths, "x", "", "S1"))

    def test_book_text_once_and_capped(self):
        meta, paths = send_payload(), {"overview": "o.jpg", "crop": "c.jpg"}
        short = prompt.build_message(meta, paths, "书页", "整页原文" * 10, "S1", src=("E:\\b\\x.pdf", 3))
        self.assertIn("这一页的书本原文：\n" + "整页原文" * 10 + "\n\n", short)
        self.assertEqual(short.count("整页原文" * 10), 1)
        self.assertIn("整页原文在 E:\\b\\x.pdf 第 3 页", short)
        self.assertNotIn("圈选", short)
        page = prompt.build_message(meta, paths, "书页", "长" * 5000, "S1")
        self.assertIn("这一页的书本原文（节选）：", page)
        self.assertEqual(page.count("长"), prompt.TEXT_MAX)

    def test_one_image_of_the_page_and_the_sheet(self):
        """没有框选了：一页只列一张图（这一页）加字帖；平板另画的整页概览、「只有笔迹」的图都不列。"""
        paths = {"overview": "E:\\d\\overview.jpg", "crop": "E:\\d\\crop.jpg", "ink": "E:\\d\\ink.jpg"}
        msg = prompt.build_message(send_payload(), paths, "x", "", "S1")
        self.assertIn("先用 Read 看这一张图：\n- 这一页：E:\\d\\crop.jpg（笔迹旁的灰色编号 g1、g2…… 是笔迹分组；浅灰色是我擦掉的笔迹）", msg)
        for gone in ("overview.jpg", "ink.jpg", "只有笔迹", "圈选", "放大", "蓝色虚线框"):
            self.assertNotIn(gone, msg)
        both = prompt.build_message(send_payload(), dict(paths, sheet="E:\\d\\sheet.png"), "x", "", "S1")
        self.assertIn("先用 Read 看这两张图：", both)
        self.assertIn("\n- 字帖：E:\\d\\sheet.png（每组笔迹裁出来、统一字高，左边是编号；认字时看这张）", both)
        # 快照：平板按笔迹的外框截图，页面上有笔迹时不是整页，照实说；没有笔迹时截的是整页
        snap = prompt.build_message(send_payload(), paths, "x", "", "S2", snapshot=True)
        self.assertIn("- 这一页有笔迹的那一块：E:\\d\\crop.jpg（快照只截到笔迹的外框，框外的内容不在图里；", snap)
        empty = prompt.build_message(dict(send_payload(), groups=[]), paths, "x", "", "S2", snapshot=True)
        self.assertIn("- 这一页：E:\\d\\crop.jpg（", empty)

    def test_reco_from_two_recognizers(self):
        self.assertEqual(prompt.fmt_reco({"reco": ["给出", "绘出"]}), "｜电脑识别：「给出」（或：绘出）")
        self.assertEqual(prompt.fmt_reco({"reco": ["给出"], "ocr": "给出来"}), "｜电脑识别：Windows「给出」；PP-OCR「给出来」")
        self.assertEqual(prompt.fmt_reco({"ocr": "ρ"}), "｜电脑识别：PP-OCR「ρ」")
        self.assertEqual(prompt.fmt_reco({}), "")
        self.assertIn("识别结果和你的读法一致时不要问", prompt.protocol())

    def test_timeline_without_process_has_no_times(self):
        tl = prompt.build_timeline(groups_fixture(), 0, False)
        self.assertNotIn("开始", tl)
        self.assertIn("g2", tl)
        self.assertNotIn("g3", tl)  # 全部擦掉的组在「只看结果」时不出现

    def test_message(self):
        meta = send_payload()
        paths = {"overview": "E:\\d\\overview.jpg", "crop": "E:\\d\\crop.jpg"}
        msg = prompt.build_message(meta, paths, "草稿本第 1 页（空白草稿纸）", "书页原文", "S1")
        self.assertTrue(msg.startswith("【草稿纸】"))
        self.assertIn("E:\\d\\crop.jpg", msg)
        self.assertIn("浅灰色是我擦掉的笔迹", msg)
        self.assertIn("红笔是用户要问你的问题", prompt.protocol())   # 颜色的含义在固定说明里
        self.assertIn("这一页的书本原文：\n书页原文", msg)
        self.assertIn("- 之前的批注", msg)
        self.assertIn('submission="S1"', msg)
        snap = prompt.build_message(meta, paths, "x", "", "S2", snapshot=True)
        self.assertTrue(snap.startswith("【草稿纸·快照】"))

    def test_message_with_reco_and_answered_red(self):
        meta = send_payload()
        meta["groups"][0].update(red=True)                       # g1 是红笔（平板记着它在范围框外：现在整页都交，照常列出）
        meta["groups"][1].update(reco=["给相关对话", "给相知对话"])
        paths = {"overview": "o.jpg", "crop": "c.jpg"}
        msg = prompt.build_message(meta, paths, "书页", "", "S1")
        self.assertIn("\ng1｜", msg)
        self.assertIn("红笔（问题）", msg)
        self.assertNotIn("还有红笔", msg)                         # 没有「范围外还有红笔」这种提醒了
        self.assertIn("｜电脑识别：「给相关对话」（或：给相知对话）", msg)
        self.assertIn("只当旁证", prompt.protocol())
        meta["groups"][0].update(answered=True)                  # 之前几轮回答过了：不再当新问题
        msg = prompt.build_message(meta, paths, "书页", "", "S1")
        self.assertIn("红笔（回答过）", msg)
        self.assertNotIn("红笔（问题）", msg)

    def test_clean_item_write_keeps_long_text(self):
        long = "第一段。\n\n" + "很长的回答" * 200
        item = server.clean_item({"type": "write", "text": long, "anchor": "end"})
        self.assertEqual(item["text"], long.strip()[:4000])
        self.assertEqual(item["anchor"], "end")

    def test_clean_item_keeps_question_of_write_only(self):
        item = server.clean_item({"type": "write", "text": "因为两边相等", "anchor": "g2", "q": "  为什么取零？" + "长" * 300})
        self.assertEqual(item["q"], ("为什么取零？" + "长" * 300)[:200])
        self.assertNotIn("q", server.clean_item({"type": "note", "text": "好", "q": "x"}))

    def test_message_asks_for_question_and_lists_followups(self):
        meta = send_payload()
        paths = {"overview": "o.jpg", "crop": "c.jpg"}
        msg = prompt.build_message(meta, paths, "草稿本第 1 页", "", "S1")
        # 2026-11-13：短的用 note；长的用 write、anchor 填那个红笔问题，平板标圈号（不再按圈号写在页末）
        self.assertIn("短的回答（约 40 字以内）用 note，anchor 填那个红笔问题的编号；长的用 write，anchor 也填那个红笔问题的编号", prompt.protocol())
        self.assertNotIn("旧批注：", msg)
        meta["followup"] = [{"id": "a1", "ref": "x1", "type": "note", "text": "这里应为 ρ", "why": "指着的 g3 擦掉了一部分"}]
        msg = prompt.build_message(meta, paths, "草稿本第 1 页", "", "S1")
        self.assertNotIn("这里应为 ρ", msg)                               # 别的旧批注不再请 Claude 整理（第 2 阶段）
        self.assertNotIn("ink_relocate", msg)

    def test_clean_item(self):
        self.assertIsNone(server.clean_item({"type": "note", "anchor": "g1"}))
        self.assertIsNone(server.clean_item({"type": "bogus", "text": "x"}))
        self.assertEqual(server.clean_item({"type": "circle", "box": [1, 2, 3, 4]})["box"], [1.0, 2.0, 3.0, 4.0])
        self.assertEqual(server.clean_item({"type": "underline", "anchor": 3}), {"type": "underline", "anchor": "3"})
        # 以前指「整块圈选处」的 anchor="sel"：没有圈选了，不报错，当作没给 anchor
        self.assertEqual(server.clean_item({"type": "note", "anchor": "SEL", "text": "好"}), {"type": "note", "text": "好"})


def make_app(tmp):
    args = SimpleNamespace(host="127.0.0.1", port=0, config=str(Path(tmp) / "none.json"),
                           data=str(Path(tmp) / "data"), books=str(Path(tmp) / "books"), open=False)
    return server.App(args)


class PdfAndBoardTest(unittest.TestCase):
    def test_book_render_and_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            make_pdf(app.books / "物理.pdf")
            info = app.notebook_info("book:物理.pdf")
            self.assertEqual(info["pages"], 1)
            jpg = app.book_page_jpeg("物理.pdf", 0)
            self.assertTrue(jpg.startswith(b"\xff\xd8"))
            full = app.book_text("物理.pdf", 0)
            self.assertIn("second law", full)
            self.assertIn("F = m a", full)

    def test_board_pages_from_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            src = Path(tmp) / "src"
            src.mkdir()
            png = src / "fig.png"
            fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 400, 200), 1).save(png)  # 带透明通道
            make_pdf(src / "paper.pdf", pages=3)
            (src / "code.py").write_text("\n".join(f"line {i} 中文" for i in range(200)), "utf-8")
            self.assertEqual(app.add_board_page(png), 0)
            self.assertEqual(app.add_board_page(src / "paper.pdf", page_no=2), 1)
            self.assertEqual(app.add_board_page(src / "code.py", page_no=2), 2)
            info = app.notebook_info("board")
            self.assertEqual(info["pages"], 3)
            self.assertEqual(info["sizes"][0]["h"], 500.0)
            self.assertEqual(info["titles"][1], "paper.pdf 第 2 页")
            self.assertTrue(app.board_image(2).startswith(b"\x89PNG"))
            with self.assertRaises(ValueError):
                app.add_board_page(src / "missing.png")
            self.assertIn({"id": "board", "title": "Claude 推送"}, app.notebooks())

    def test_board_text_page_is_never_blank(self):
        """推文本：满 70 行的一段、有很宽的一行的一段都排得上（以前放不下时 PyMuPDF 一个字都不画，推过去是白页）。"""
        def dark(png, y0=0.0, y1=1.0):
            pix = fitz.Pixmap(fitz.csGRAY, fitz.Pixmap(str(png)))
            s, w = pix.samples, pix.stride
            return sum(1 for b in s[int(pix.height * y0) * w:int(pix.height * y1) * w] if b < 100)
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            board = app.data / "notebooks" / "board"
            full = Path(tmp) / "full.txt"
            full.write_text("\n".join(f"line {i + 1}" for i in range(100)), "utf-8")
            wide = Path(tmp) / "wide.txt"
            wide.write_text("\n".join(["开头一行"] + ["x" * 20000] + [f"第 {i} 行 " + "很长的一句话" * 30 for i in range(60)]), "utf-8")
            self.assertEqual(app.add_board_page(full), 0)                      # 第 1 段：满 70 行
            self.assertGreater(dark(board / "bg-0000.png"), 300)
            self.assertGreater(dark(board / "bg-0000.png", 0.85, 0.97), 30)     # 最后几行也排上了
            self.assertEqual(app.add_board_page(wide), 1)                      # 很宽的一行、很多折行的长句
            self.assertGreater(dark(board / "bg-0001.png"), 300)

    def test_import_documents(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            src = Path(tmp) / "src"
            src.mkdir()
            make_pdf(src / "讲义.pdf", pages=2)
            fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 300, 400), 0).save(src / "白板照片.png")
            self.assertEqual(app.import_document(src / "讲义.pdf"), "book:讲义.pdf")
            self.assertEqual(app.import_document(src / "讲义.pdf"), "book:讲义.pdf")  # 同一个文件：原地更新
            self.assertEqual(app.import_document(src / "讲义.pdf", as_new=True), "book:讲义 (2).pdf")
            nb = app.import_document(src / "白板照片.png", title="白板")
            self.assertEqual(nb, "book:白板.pdf")
            self.assertEqual(app.notebook_info(nb)["pages"], 1)
            self.assertTrue((app.books / "_原件" / "白板照片.png").is_file())
            (src / "x.zip").write_bytes(b"PK")
            with self.assertRaises(ValueError):
                app.import_document(src / "x.zip")
            self.assertNotIn("_原件", " ".join(app.book_names()))


def make_slides(path, texts):
    """每页一行字的「幻灯片」PDF（横版）。"""
    doc = fitz.open()
    for t in texts:
        page = doc.new_page(width=960, height=540)
        page.insert_text((60, 120), t, fontsize=28)
    doc.save(path)


class DeliveryTest(unittest.TestCase):
    def test_old_submission_follows_renamed_book(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            v1, v2 = Path(tmp) / "例会_v1.pdf", Path(tmp) / "例会_v2.pdf"
            make_slides(v1, ["Intro", "Method"])
            make_slides(v2, ["Intro", "Method changed"])
            nb = app.import_document(v1)
            sub = app.data / "submissions" / "20261025-000000-aaaa"
            sub.mkdir(parents=True)
            (sub / "meta.json").write_text(json.dumps({"id": sub.name, "nb": nb, "page": 1, "page_key": "p0001", "groups": [],
                                                       "crop": {"x0": 0, "y0": 0, "scale": 1}, "sel": None}), "utf-8")
            new = app.update_document(nb, v2)["id"]  # 换成 v2，本子跟着改名
            self.assertEqual(new, "book:例会_v2.pdf")
            self.assertEqual(app.current_nb(nb), new)
            self.assertEqual(app.current_nb(new), new)
            loc = app.locate("S1", sub.name)
            self.assertEqual((loc["nb"], loc["page"]), (new, 1))

    def test_delivery_kept_until_acked(self):
        b = server.Bridge()
        b.enqueue("S1", "a")
        b.enqueue("S1", "b")
        self.assertEqual(b.pop("S1", lease=True), "a")    # 交出去了，还在队里
        self.assertEqual(b.pop("S1", lease=True), "b")    # 等确认期间先给下一条
        self.assertIsNone(b.pop("S1", lease=True))
        self.assertTrue(b.ack("S1", "a"))
        b.leases["b"] -= server.LEASE_S + 1               # 「b」一直没确认：过了时限再给一次
        self.assertEqual(b.pop("S1", lease=True), "b")
        self.assertTrue(b.ack("S1", "b"))
        self.assertEqual(b.queues["S1"], [])
        self.assertFalse(b.ack("S1", "b"))
        b.enqueue("S1", "c")                              # 不带 lease 取：取走就删
        self.assertEqual(b.pop("S1"), "c")
        self.assertEqual(b.queues["S1"], [])


class UpdateDocumentTest(unittest.TestCase):
    def test_update_in_place_keeps_ink_and_marks_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            src = Path(tmp) / "src" / "例会_v1.pdf"
            src.parent.mkdir()
            make_slides(src, ["Intro: weekend trip planner", "Method: simple travel budget", "Result: total cost 300 yuan"])
            nb = app.import_document(src)
            self.assertEqual(nb, "book:例会_v1.pdf")
            ink = lambda tag: json.dumps({"v": 1, "strokes": [stroke(tag, 1, 100, 100)], "ai": [], "reads": []})  # noqa: E731
            app.save_page(nb, 0, ink("p1"))
            app.save_page(nb, 1, ink("p2"))
            app.save_page(nb, 2, ink("p3"))
            app.mark_seen(nb, {"p0001": 123})
            self.assertFalse(app.notebook_info(nb)["sourceChanged"])
            # 新版：第 1 页改了一个词，后面插了一页，方法页改了一个词，结果页不变
            time.sleep(1.1)
            make_slides(src, ["Intro: weekend trip planners", "Agenda for today and tomorrow",
                              "Method: itemized travel budget", "Result: total cost 300 yuan"])
            self.assertTrue(app.notebook_info(nb)["sourceChanged"])
            again = app.import_document(src)  # 同一个原文件再导入：原地更新
            self.assertEqual(again, nb)
            info = app.notebook_info(nb)
            self.assertEqual(info["pages"], 4)
            self.assertFalse(info["sourceChanged"])

            def sid(i):
                ss = json.loads(app.load_page(nb, i))["strokes"]
                return ss[0]["id"] if ss else None

            self.assertEqual([sid(i) for i in range(4)], ["p1", None, "p2", "p3"])  # 手写跟着内容走
            self.assertEqual(app.seen(nb), {"p0002": 123})
            ch = info["changes"]["pages"]
            self.assertEqual((ch["0"]["status"], ch["1"]["status"], ch["2"]["status"]), ("changed", "new", "changed"))
            self.assertTrue(ch["2"]["boxes"])
            self.assertNotIn("3", ch)  # 没变的页不列
            self.assertTrue(app.old_page_jpeg(nb, 2).startswith(b"\xff\xd8"))
            with self.assertRaises(KeyError):
                app.old_page_jpeg(nb, 1)
            s = app.change_summary(nb)
            self.assertEqual(s["text"], "第 1、3 页有改动；新增第 2 页")
            # 再删掉插入的那页（上面写了字）：手写另存，不丢
            app.save_page(nb, 1, ink("pa"))
            time.sleep(1.1)
            make_slides(src, ["Intro: weekend trip planners", "Method: itemized travel budget", "Result: total cost 300 yuan"])
            s = app.update_document(nb)
            self.assertEqual([sid(i) for i in range(3)], ["p1", "p2", "p3"])
            self.assertEqual(s["text"], "删掉了旧版第 2 页（上面的手写另存了）")
            self.assertEqual(len(list(app._nb_dir(nb).glob("removed-*-page-0001.json"))), 1)
            self.assertEqual(len(list((app.books / "_旧版").glob("例会_v1.*.pdf"))), 2)

    def test_offer_for_new_version_suggests_replacing(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            d = Path(tmp) / "src"
            d.mkdir()
            make_slides(d / "汇报_v47_按意见修改6.pdf", ["a", "b"])
            nb = app.import_document(d / "汇报_v47_按意见修改6.pdf")
            app.save_page(nb, 1, json.dumps({"v": 1, "strokes": [stroke("k", 1, 100, 100)], "ai": [], "reads": []}))
            time.sleep(1.1)
            make_slides(d / "汇报_v47_按意见修改7.pdf", ["a", "b changed"])
            make_slides(d / "别的.pdf", ["x"])
            (d / "~$汇报_v47_按意见修改7.pdf").write_bytes(b"lock")  # 文档开着时的锁文件：不提示
            offers = app.add_offers("S", "idea", [{"path": str(d / n)} for n in ("汇报_v47_按意见修改7.pdf", "别的.pdf", "~$汇报_v47_按意见修改7.pdf")])
            self.assertEqual(len(offers), 2)
            self.assertEqual(offers[0]["replace"], "汇报_v47_按意见修改6")
            self.assertNotIn("replace", offers[1])
            res = app.accept_offer(offers[0]["id"], "replace")
            # 换成新文件后，本子跟着改名；手写还在第 2 页
            self.assertEqual((res["nb"], res["old"]), ("book:汇报_v47_按意见修改7.pdf", "book:汇报_v47_按意见修改6.pdf"))
            self.assertEqual(res["summary"], "第 2 页有改动")
            self.assertEqual(res["headline"], "从《汇报_v47_按意见修改6》换成了《汇报_v47_按意见修改7》：第 2 页有改动")
            self.assertEqual(res["prev"], "汇报_v47_按意见修改6")
            self.assertEqual(app.book_names(), ["汇报_v47_按意见修改7.pdf"])  # 没有另建一本
            self.assertEqual(json.loads(app.load_page(res["nb"], 1))["strokes"][0]["id"], "k")
            info = app.notebook_info(res["nb"])
            self.assertEqual((info["changes"]["from"], info["changes"]["to"]), ("汇报_v47_按意见修改6", "汇报_v47_按意见修改7"))
            self.assertTrue(app.old_page_jpeg(res["nb"], 1).startswith(b"\xff\xd8"))
            self.assertFalse(info["sourceChanged"])
            # 较早的版本不会被建议去替换较新的
            make_slides(d / "汇报_v47_按意见修改5.pdf", ["a"])
            os.utime(d / "汇报_v47_按意见修改5.pdf", (1, 1))
            self.assertIsNone(app.similar_book(d / "汇报_v47_按意见修改5.pdf"))

    def test_old_import_adopts_its_source_and_versions_collapse(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            d = Path(tmp) / "src"
            d.mkdir()
            make_slides(d / "例会汇报_v48.pdf", ["a", "b"])
            nb = app.import_document(d / "例会汇报_v48.pdf", register=False)  # 像以前那样导入：没记原文件
            self.assertNotIn("source", app.notebook_info(nb))
            time.sleep(1.1)
            make_slides(d / "例会汇报_v49.pdf", ["a", "b2"])
            time.sleep(1.1)
            make_slides(d / "例会汇报_v50.pdf", ["a", "b3"])
            # 插件报上来的文件里有和本子同名的那份：认它做原文件（没改过，不用提示）；v49、v50 都像它的新版，只列最新的
            app.add_offers("S", "MY_PAPER", [{"path": str(d / n)} for n in ("例会汇报_v48.pdf", "例会汇报_v49.pdf", "例会汇报_v50.pdf")])
            self.assertEqual(app.notebook_info(nb)["source"], "例会汇报_v48.pdf")
            self.assertFalse(app.notebook_info(nb)["sourceChanged"])
            pend = {o["name"]: o for o in app.pending_offers()}
            self.assertEqual(set(pend), {"例会汇报_v50.pdf"})
            self.assertEqual(pend["例会汇报_v50.pdf"]["older"], ["例会汇报_v49.pdf"])
            res = app.accept_offer(pend["例会汇报_v50.pdf"]["id"], "replace")
            self.assertEqual(res["nb"], "book:例会汇报_v50.pdf")
            self.assertEqual([o["name"] for o in app.pending_offers()], [])  # v49 的提示一起收掉

    def test_delete_book_keeps_files_for_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            make_pdf(Path(tmp) / "x.pdf")
            nb = app.import_document(Path(tmp) / "x.pdf")
            app.save_page(nb, 0, json.dumps({"v": 1, "strokes": [stroke("k", 1, 100, 100)], "ai": [], "reads": []}))
            d = app._nb_dir(nb)
            self.assertEqual(app.delete_book(nb), "x")
            self.assertNotIn(nb, [n["id"] for n in app.notebooks()])
            self.assertEqual(len(list((app.books / "_已删除").glob("x.*.pdf"))), 1)
            self.assertEqual(len(list(d.parent.glob(f"_deleted-*-{d.name}/page-0000.json"))), 1)
            self.assertNotIn("x.pdf", app.sources())
            with self.assertRaises(ValueError):
                app.delete_book("scratch")

    def test_queue_and_pending_confirms_survive_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            app.bridge.enqueue("S", "sub-1")
            app.bridge.confirms["c1"] = {"id": "c1", "sid": "S", "answers": None, "done": threading.Event(), "late": False,
                                         "questions": [], "nb": "scratch", "page": 0}
            app.bridge.persist()
            again = make_app(tmp)
            self.assertEqual(again.bridge.queues, {"S": ["sub-1"]})
            self.assertTrue(again.bridge.confirms["c1"]["late"])  # 原来等着的那次调用已断：之后的回答作为新消息送达
            self.assertEqual(again.bridge.pop("S"), "sub-1")
            self.assertEqual(make_app(tmp).bridge.queues, {})

    def test_ask_cards_survive_restart_and_late_answers_reach_the_conversation(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            app.bridge.tablet_seen = time.time()
            asked = app.post_card("S", question="选哪个？", options=["甲", "乙"])
            mine = app.post_card("", question="服务自己问的", options=["好"], on_answer=lambda c, a: None, origin="server")
            seen = app.post_card("S", "result", text="结果")
            again = make_app(tmp)  # 服务重启：没答的卡片还在，等着的工具调用和回调都断了
            self.assertEqual(set(again.bridge.asks), {asked["id"], mine["id"], seen["id"]})
            self.assertTrue(again.bridge.asks[asked["id"]]["late"])   # 问题的回答作为新消息送进发它的对话
            self.assertFalse(again.bridge.asks[mine["id"]]["late"])   # 没有对话的不送
            self.assertNotIn("on_answer", again.bridge.asks[mine["id"]])
            again.answer_card(asked["id"], choice="乙")
            sub = again.bridge.pop("S")
            self.assertIsNotNone(sub, "重启前发的问题，重启后才答：回答应该作为一条新消息排进那个对话")
            text =(again.data / "submissions" / sub / "message.txt").read_text("utf-8")
            self.assertTrue(text.startswith("【草稿纸·回答】你之前在平板上用问话卡片问我：「选哪个？」。我现在回答了：我点了「乙」。"), text)
            again.answer_card(seen["id"])  # 结果卡片点了「知道了」：不送消息
            again.answer_card(mine["id"], choice="好")
            self.assertIsNone(again.bridge.pop("S"))
            self.assertEqual(json.loads((again.data / "bridge_state.json").read_text("utf-8"))["asks"], [])

    def test_internal_entry_asks_and_calls_back(self):
        """给服务里别的代码用的入口（比如改文件前问覆盖还是另存）：post_card 发卡片，wait_card 等答案，on_answer 答了就回调。"""
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            self.assertIsNone(app.post_card("S", question="覆盖还是另存？", options=["覆盖", "另存"]))  # 平板不在线：不发
            self.assertEqual(app.bridge.asks, {})
            app.bridge.tablet_seen = time.time()
            got = []
            card = app.post_card("S", question="覆盖还是另存？", options=["覆盖", "另存"], write=False,
                                 on_answer=lambda c, a: got.append((c["id"], a)), origin="server")
            self.assertEqual(app.bridge.events[-1]["type"], "ask")
            t0 = time.time()
            self.assertIsNone(app.wait_card(card["id"], 0.2))  # 没答：等到时候返回 None
            self.assertLess(time.time() - t0, 2)
            with self.assertRaises(ValueError):
                app.answer_card(card["id"], image_b64=base64.b64encode(fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 4, 4), 0).tobytes("png")).decode())
            threading.Timer(0.2, lambda: app.answer_card(card["id"], choice="覆盖")).start()
            self.assertEqual(app.wait_card(card["id"], 5), {"choice": "覆盖"})
            for _ in range(40):  # 回调在叫醒等着的一方之后才调用（在平板那次请求的线程里）
                if got:
                    break
                time.sleep(0.05)
            self.assertEqual(got, [(card["id"], {"choice": "覆盖"})])
            self.assertIn("asked", [e["type"] for e in app.bridge.events])
            self.assertIsNone(app.bridge.pop("S"))  # 等着的时候答的：不另发消息
            with self.assertRaises(KeyError):
                app.answer_card(card["id"], choice="另存")

    def test_repeated_offers_collapse_and_replace_is_decided_when_listed(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            d = Path(tmp) / "src"
            d.mkdir()
            make_slides(d / "例会汇报_v2.pdf", ["a", "b2"])
            app.add_offers("S", "MY_PAPER", [{"path": str(d / "例会汇报_v2.pdf"), "mtimeMs": 1}])
            app.add_offers("S", "MY_PAPER", [{"path": str(d / "例会汇报_v2.pdf"), "mtimeMs": 2}])  # 又生成了一次
            pend = app.pending_offers()
            self.assertEqual(len(pend), 1)
            self.assertNotIn("replace", pend[0])
            make_slides(d / "例会汇报_v1.pdf", ["a", "b"])
            os.utime(d / "例会汇报_v1.pdf", (1, 1))  # 旧版文件比 v2 早
            app.import_document(d / "例会汇报_v1.pdf")  # 之后才导入旧版：列出时就能看出是它的新版本
            self.assertEqual(app.pending_offers()[0]["replace"], "例会汇报_v1")


def ink_page(tag):
    return json.dumps({"v": 1, "strokes": [stroke(tag, 1, 100, 100)], "ai": [], "reads": []})


def first_stroke(app, nb, i):
    ss = json.loads(app.load_page(nb, i))["strokes"]
    return ss[0]["id"] if ss else None


class PageLayoutTest(unittest.TestCase):
    def test_blank_page_inside_a_book(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            make_slides(Path(tmp) / "例会.pdf", ["A", "B", "C"])
            nb = app.import_document(Path(tmp) / "例会.pdf")
            app.save_page(nb, 1, ink_page("onB"))
            self.assertEqual(app.insert_page(nb, 0), 1)  # 第 1 页后插一张空白纸
            info = app.notebook_info(nb)
            self.assertEqual(info["pages"], 4)
            self.assertTrue(info["pageInfo"][1]["blank"])
            self.assertEqual(info["sizes"][1]["h"], server.SCRATCH_H)
            self.assertEqual(first_stroke(app, nb, 2), "onB")  # 原来的第 2 页现在是第 3 页，笔迹跟着
            self.assertEqual(app.page_base(nb, 1), (server.SCRATCH_H, None))
            self.assertIn("原文件第 2 页", app.page_label(nb, 2))
            self.assertIn("插在原文件第 1 页后的空白纸", app.page_label(nb, 1))
            app.save_page(nb, 1, ink_page("onBlank"))
            self.assertEqual(first_stroke(app, nb, 1), "onBlank")
            self.assertTrue(list(app._nb_dir(nb).glob("blank-*.json")))

    def test_landscape_and_portrait_blank_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            make_slides(Path(tmp) / "幻灯片.pdf", ["A", "B"])  # 960×540 的横版页 → 高 562.5
            nb = app.import_document(Path(tmp) / "幻灯片.pdf")
            land = app.insert_page(nb, 0, "landscape")
            port = app.insert_page(nb, land, "portrait")
            sizes = [s["h"] for s in app.notebook_info(nb)["sizes"]]
            self.assertEqual(sizes, [562.5, 562.5, server.SCRATCH_H, 562.5])  # 横版纸和前一页 PPT 一样大
            self.assertEqual(app.page_base(nb, land), (562.5, None))
            pad = app.new_pad("横的", "landscape")
            self.assertEqual(app.notebook_info(pad)["sizes"][0]["h"], 707.2)  # 别处的横版纸是 A4 横向
            self.assertEqual(app.notebook_info(app.add_page(pad)["id"])["sizes"][1]["h"], 707.2)
            self.assertEqual(app.page_base("scratch", 0), (server.SCRATCH_H, None))

    def test_widened_page_renders_wider(self):
        with tempfile.TemporaryDirectory() as tmp:
            page = {"strokes": [stroke("far", 0, 1300, 200)], "ai": [], "h": 1414, "xw": 400}
            self.assertEqual(pages.widths(page), (1400, 1780))
            right = pages.content_extent(page, 1414)[0]
            self.assertTrue(1350 < right <= 1400, right)  # 写在拉宽出来的地方：截到笔迹为止，不带页边
            out = Path(tmp) / "w.png"
            pages.render_page(page, str(out), 1414, None, (), 0.5)
            self.assertEqual(fitz.Pixmap(str(out)).width, 890)

    def test_page_extended_up_and_left(self):
        with tempfile.TemporaryDirectory() as tmp:
            # 向上扩 500、向左扩 400：原来的内容坐标不变，新写的在负坐标上
            page = {"strokes": [stroke("old", 0, 100, 100, n=30), stroke("new", 1, -300, -400, n=30)],
                    "ai": [], "h": 1414, "ox": 400, "oy": 500}
            self.assertEqual(pages.paper_rect(page, 1414), [-400.0, -500.0, 1380.0, 1414])
            left, top = pages.content_origin(page)
            self.assertTrue(-400 <= left < -300 and -500 <= top < -400, (left, top))
            out = Path(tmp) / "e.png"
            pages.render_page(page, str(out), 1414, None, (), 0.5)
            pix = fitz.Pixmap(str(out))
            self.assertEqual((pix.width, pix.height), (890, 957))
            dark = lambda x, y: min(sum(pix.pixel(int((x + 400) * 0.5) + dx, int((y + 500) * 0.5) + dy))  # noqa: E731
                                    for dx in range(-3, 4) for dy in range(-3, 4))
            self.assertLess(dark(150, 100), 400)   # 原来的笔迹在原处
            self.assertLess(dark(-250, -400), 400)  # 新加的那块纸上的笔迹也画出来了
            self.assertGreater(dark(600, 1000), 700)  # 空白处是白的

    def test_scan_includes_writing_in_extension(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            app.save_page("scratch", 0, json.dumps({"v": 1, "strokes": [stroke("up", 1, 200, -300)], "ai": [], "reads": [],
                                                    "oy": 500}))
            sub_id, text, n = app.scan("scratch")
            self.assertEqual(n, 1)
            crop = app.load_submission(sub_id)["pages"]["1"]["crop"]
            self.assertLess(crop["y0"], -300)  # 图从扩出来的那块纸开始
            self.assertTrue(app.page_thumb("scratch", 0).startswith(b"\x89PNG"))

    def test_turned_page_geometry(self):
        self.assertAlmostEqual(pages.turned_h({"rot": 90}, 562.5), 1000 * 1000 / 562.5)
        self.assertEqual(pages.turned_h({"rot": 180}, 562.5), 562.5)
        self.assertEqual(pages.turned_h({}, 562.5), 562.5)
        m = pages.turn_between(0, 90, 562.5)
        b = pages.turn_box(m, [0, 0, 100, 50])
        self.assertAlmostEqual(b[0], 1000 - 50 * 1000 / 562.5)
        self.assertAlmostEqual(b[2], 1000)
        back = pages.turn_box(pages.turn_between(90, 0, 562.5), b)
        for u, v in zip(back, [0, 0, 100, 50]):
            self.assertAlmostEqual(u, v)

    def test_turned_background_is_drawn_rotated(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = fitz.open()
            p = src.new_page(width=1000, height=500)
            p.draw_rect(fitz.Rect(0, 0, 100, 100), color=None, fill=(1, 0, 0))  # 左上角一个红块
            bg = p.get_pixmap(alpha=False).tobytes("png")
            page = {"rot": 90, "strokes": [], "ai": []}
            out = Path(tmp) / "r.png"
            pages.render_page(page, str(out), pages.turned_h(page, 500), bg, (), 0.5, [0, 0, 1000, 2000])
            pix = fitz.Pixmap(str(out))
            self.assertEqual((pix.width, pix.height), (500, 1000))
            self.assertEqual(pix.pixel(450, 50)[:3], (255, 0, 0))  # 右转后红块在右上角
            self.assertEqual(pix.pixel(50, 50)[:3], (255, 255, 255))

    def test_text_and_scan_on_turned_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            make_slides(Path(tmp) / "讲稿.pdf", ["A", "B"])
            nb = app.import_document(Path(tmp) / "讲稿.pdf")
            self.assertEqual(app.page_text(nb, 0), "A")
            app.save_page(nb, 0, json.dumps({"v": 1, "strokes": [stroke("s", 1, 300, 600)], "ai": [], "reads": [], "rot": 90}))
            self.assertEqual(app.page_text(nb, 0), "A")  # 这一页的原文，转没转都一样（不再按范围框截）
            sub_id, _, n = app.scan(nb)
            self.assertEqual(n, 1)
            self.assertEqual(app.load_submission(sub_id)["pages"]["1"]["rot"], 90)
            self.assertEqual(app.locate("S", sub_id, 1)["rot"], 90)
            self.assertTrue(app.page_thumb(nb, 0).startswith(b"\x89PNG"))

    def test_hidden_slides_are_found_and_marked(self):
        import zipfile
        with tempfile.TemporaryDirectory() as tmp:
            pptx = Path(tmp) / "deck.pptx"  # 最小的 pptx 骨架：3 页，第 2 页隐藏
            with zipfile.ZipFile(pptx, "w") as z:
                z.writestr("ppt/presentation.xml", '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>'
                           '<p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/>'
                           '</p:sldIdLst></p:presentation>')
                z.writestr("ppt/_rels/presentation.xml.rels", '<Relationships>'
                           + "".join(f'<Relationship Id="rId{k + 2}" Type="slide" Target="slides/slide{k + 1}.xml"/>' for k in range(3))
                           + '</Relationships>')
                for k, show in enumerate(["", ' show="0"', ""]):
                    z.writestr(f"ppt/slides/slide{k + 1}.xml", f'<p:sld xmlns:p="p"{show}><p:cSld/></p:sld>')
            self.assertEqual(server.pptx_hidden(pptx), [2])
            self.assertEqual(server.pptx_hidden(Path(tmp) / "none.pptx"), [])
            app = make_app(tmp)
            make_slides(Path(tmp) / "讲稿.pdf", ["A", "B", "C"])
            nb = app.import_document(Path(tmp) / "讲稿.pdf")
            self.assertEqual(app.doc_info(nb), {"converter": server.CONVERTER, "hidden": []})
            self.assertEqual(app.notebook_info(nb)["hiddenMissing"], 0)
            app.set_doc_info(nb, [1])  # 假装第 2 页是 PPT 里的隐藏页
            info = app.notebook_info(nb)
            self.assertEqual([p["hiddenSlide"] for p in info["pageInfo"]], [False, True, False])
            self.assertIn("PPT 里的隐藏页", app.page_label(nb, 1))
            # 以前（没记 doc.json）从 pptx 导入的：提示有几张隐藏页没转进来
            (app._nb_dir(nb) / "doc.json").unlink()
            s = app.sources()
            s[nb[5:]]["src"] = str(pptx)
            (app.books / "_sources.json").write_text(json.dumps(s, ensure_ascii=False), "utf-8")
            self.assertEqual(app.notebook_info(nb)["hiddenMissing"], 1)
            # 没记原文件的（同名导入第二次的「… (2)」也一样）：用导入时另存在 _原件 里的那份来数
            s.pop(nb[5:])
            (app.books / "_sources.json").write_text(json.dumps(s, ensure_ascii=False), "utf-8")
            self.assertEqual(app.notebook_info(nb)["hiddenMissing"], 0)
            (app.books / "_原件").mkdir(exist_ok=True)
            shutil.copyfile(pptx, app.books / "_原件" / "讲稿.pptx")
            self.assertEqual(app.notebook_info(nb)["hiddenMissing"], 1)
            os.replace(app.books / "讲稿.pdf", app.books / "讲稿 (2).pdf")
            self.assertEqual(app.notebook_info("book:讲稿 (2).pdf")["hiddenMissing"], 1)

    def test_update_falls_back_to_kept_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            make_slides(Path(tmp) / "汇报.pdf", ["A", "B"])
            nb = app.import_document(Path(tmp) / "汇报.pdf")
            (app.books / "_sources.json").write_text("{}", "utf-8")  # 以前导入、没记原文件
            with self.assertRaises(ValueError):
                app.update_document(nb)
            (app.books / "_原件").mkdir(exist_ok=True)
            make_slides(app.books / "_原件" / "汇报.pdf", ["A", "hidden", "B"])
            app.update_document(nb)
            self.assertEqual(app.notebook_info(nb)["pages"], 3)
            self.assertNotIn("汇报.pdf", app.sources())  # 另存的原件不当原文件记

    def test_update_keeps_blank_pages_after_their_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            src = Path(tmp) / "汇报.pdf"
            make_slides(src, ["Intro: travel", "Method: simple budget", "Result: 300 yuan"])
            nb = app.import_document(src)
            b = app.insert_page(nb, 1)  # 方法页后面的空白纸
            app.save_page(nb, b, ink_page("blank-note"))
            time.sleep(1.1)
            make_slides(src, ["Intro: travel", "Agenda for today and tomorrow", "Method: simple budget", "Result: 300 yuan"])
            app.update_document(nb)
            info = app.notebook_info(nb)
            self.assertEqual([p["pdf"] for p in info["pageInfo"]], [0, 1, 2, None, 3])
            self.assertEqual(first_stroke(app, nb, 3), "blank-note")

    def test_seen_per_conversation_adopts_old_data(self):
        """以前不分对话记的 seen.json：第一个来记的对话接着用，别的对话从头算。"""
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            d = app.data / "notebooks" / "scratch"
            d.mkdir(parents=True, exist_ok=True)
            (d / "seen.json").write_text(json.dumps({"p0000": 5, "p0001": 7}), "utf-8")
            self.assertEqual(app.seen("scratch", "A"), {"p0000": 5, "p0001": 7})
            app.mark_seen("scratch", {"p0000": 9}, "A")
            self.assertEqual(app.seen("scratch", "A"), {"p0000": 9, "p0001": 7})
            self.assertEqual(app.seen("scratch", "B"), {})
            app.mark_seen("scratch", {"p0001": 3}, "B")
            self.assertEqual(app.seen("scratch", "B"), {"p0001": 3})
            self.assertEqual(json.loads((d / "seen.json").read_text("utf-8")), {"by": {"A": {"p0000": 9, "p0001": 7}, "B": {"p0001": 3}}})

    def test_old_scratch_data_still_opens(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            d = app.data / "notebooks" / "scratch"
            d.mkdir(parents=True, exist_ok=True)
            (d / "index.json").write_text(json.dumps({"pages": 3}), "utf-8")
            (d / "page-0002.json").write_text(ink_page("old"), "utf-8")
            (d / "seen.json").write_text(json.dumps({"2": 5}), "utf-8")
            self.assertEqual(app.notebook_info("scratch")["pages"], 3)
            self.assertEqual(first_stroke(app, "scratch", 2), "old")
            self.assertEqual(app.seen("scratch"), {"p0002": 5})

    def test_pads(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            nb = app.new_pad("零星想法")
            self.assertIn({"id": nb, "title": "零星想法"}, app.notebooks())
            info = app.notebook_info(nb)
            self.assertEqual((info["kind"], info["paper"], info["pages"]), ("pad", "portrait", 1))
            self.assertEqual(app.add_page(nb)["pages"], 2)
            self.assertEqual(app.page_label(nb, 1), "零星想法第 2 页（空白草稿纸）")
            self.assertEqual(app.notebook_info(app.new_pad("横的", "landscape"))["paper"], "landscape")
            self.assertEqual(app.delete_book(nb), "零星想法")
            self.assertNotIn(nb, [n["id"] for n in app.notebooks()])


def line_stroke(sid, t0, x0, y0, x1, y1, red=False, n=6):
    """从 (x0, y0) 到 (x1, y1) 的一笔直线。"""
    s = {"id": sid, "t0": t0, "w": 3, "pts": [[x0 + (x1 - x0) * k / (n - 1), y0 + (y1 - y0) * k / (n - 1), 0.5, 30 * k] for k in range(n)]}
    if red:
        s["c"] = "r"
    return s


def color_center(pdf, i, want):
    """PDF 第 i 页（看到的样子，1 像素 = 1pt）里某种颜色的像素的中心；want 为 'red' 或 'blue'。"""
    with fitz.open(pdf) as doc:
        pix = doc[i].get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)  # 放大一倍：细线也有整像素
    s, w = pix.samples, pix.width
    sx = sy = n = 0
    for k, (r, g, b) in enumerate(zip(s[0::3], s[1::3], s[2::3])):
        if (want == "red" and r > 170 and g < 120 and b < 120) or (want == "blue" and b > 140 and r < 110 and g < 150):
            sx, sy, n = sx + k % w, sy + k // w, n + 1
    return (sx / n / 2, sy / n / 2) if n else None


def own_annots(pdf):
    with fitz.open(pdf) as doc:
        return [(i, a.type[1], a.info["title"], a.info["content"]) for i, pg in enumerate(doc) for a in pg.annots()
                if a.info["title"].startswith("InkThink")]


def marked_page():
    """一页：黑字一组、红字问题一组、页边一组；Claude 的下划线和页边批注指着黑字，长回答（圈号）回答红字；另有划掉的、落空的、转写。"""
    t = 1_700_000_000_000
    strokes = [line_stroke("a", t, 100, 200, 140, 200), line_stroke("b", t + 300, 150, 200, 190, 200),
               line_stroke("c", t + 5000, 100, 400, 200, 400, red=True), line_stroke("d", t + 10000, 1100, 300, 1200, 300)]
    lay = {"x": 1022, "y": 190, "w": 330, "h": 37, "fs": 21, "lh": 29, "lines": ["这里应为 ρ"]}
    ai = [
        {"id": "n1", "type": "note", "text": "这里应为 ρ", "box": [100, 195, 190, 205], "lay": lay,
         "paths": [{"d": "M196 200 L1014 205", "cls": "leader", "w": 1.3}], "on": ["a", "b"]},
        {"id": "u1", "type": "underline", "box": [100, 195, 190, 205], "paths": [{"d": "M96 211 Q140 214 194 211 M102 214 L191 214", "w": 2.2}],
         "on": ["a", "b"]},
        answer_item("w1", 1, [232, 400], text="因为两边同时减去了 3", q="这一步为什么取零？", on=["c"]),
        {"id": "n2", "type": "note", "text": "划掉的", "box": [100, 195, 190, 205], "dismissed": True, "paths": []},
        {"id": "c1", "type": "circle", "box": [500, 500, 600, 560], "paths": [{"d": "M500 500 L600 560"}], "on": ["zz"]},
        {"id": "r1", "type": "read", "text": "转写"},
    ]
    return {"v": 1, "strokes": strokes, "ai": ai, "reads": []}


class SavePdfTest(unittest.TestCase):
    def test_marks_of_page(self):
        mk = pdfsave.marks_of(marked_page(), 1414)
        who = sorted((m["title"], m["subject"]) for m in mk["ink"])
        self.assertEqual(who, [("InkThink", "手写"), ("InkThink", "红笔"), ("InkThink · Claude", "下划线")])
        under = next(m for m in mk["ink"] if m["subject"] == "下划线")
        self.assertEqual(len(under["strokes"]), 2)          # 两段 M：两笔
        self.assertGreater(len(under["strokes"][0]), 5)      # 曲线拆成了折线
        notes = {n["subject"]: n for n in mk["notes"]}
        self.assertEqual(sorted(notes), ["长回答", "页边批注"])
        self.assertEqual(notes["页边批注"]["at"], (190, 195))   # 指着那块的右上角
        self.assertTrue(notes["长回答"]["text"].startswith("圈号 1\n问：这一步为什么取零？\n"))
        self.assertEqual(notes["长回答"]["at"], (245, 387))     # 圈号的右上角
        self.assertEqual([b["n"] for b in mk["badges"]], ["1"])
        self.assertEqual((mk["outside"], mk["outside_ai"]), (1, 0))

    def test_marks_follow_turned_page(self):
        # 平板上顺时针转了 90°：没转时 (250, 400) 那一点，转后在 ((h0 - 400) · k, 250 · k)，k = 1000 / h0
        h0 = 1000 * 800 / 600
        k = 1000 / h0
        x, y = (h0 - 400) * k, 250 * k
        page = {"rot": 90, "strokes": [line_stroke("a", 0, x - 10, y, x + 10, y, red=True)], "ai": []}
        pts = pdfsave.marks_of(page, h0)["ink"][0]["strokes"][0]
        cx, cy = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
        self.assertAlmostEqual(cx, 250, delta=0.5)
        self.assertAlmostEqual(cy, 400, delta=0.5)

    def test_write_puts_ink_where_it_was_drawn(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "paper.pdf"
            doc = fitz.open()
            doc.new_page(width=600, height=800)
            doc.new_page(width=600, height=800).set_rotation(90)  # PDF 本身转过：看到的是 800 × 600
            doc.save(src)
            h0 = 1000 * 800 / 600
            k = 1000 / h0
            x, y = (h0 - 400) * k, 250 * k
            p1 = {"rot": 90, "strokes": [line_stroke("a", 0, x - 10, y, x + 10, y, red=True)], "ai": []}   # 平板上转过
            p2 = {"strokes": [line_stroke("b", 0, 190, 150, 210, 150, red=True)], "ai": []}               # 没转
            res = pdfsave.save(src, [(0, p1), (1, p2)], keep.Keeper(Path(tmp) / "keep"), Path(tmp) / "work")
            self.assertEqual((res["ink"], res["notes"], res["removed"]), (2, 0, 0))
            c1 = color_center(src, 0, "red")
            self.assertAlmostEqual(c1[0], 250 * 0.6, delta=6)
            self.assertAlmostEqual(c1[1], 400 * 0.6, delta=6)
            c2 = color_center(src, 1, "red")
            self.assertAlmostEqual(c2[0], 200 * 0.8, delta=6)
            self.assertAlmostEqual(c2[1], 150 * 0.8, delta=6)
            self.assertEqual(list((Path(tmp) / "work").iterdir()), [])  # 临时文件清掉了

    def test_resave_replaces_own_and_keeps_others(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "paper.pdf"
            make_pdf(src)
            with fitz.open(src) as doc:
                pg = doc[0]
                hl = pg.add_highlight_annot(fitz.Rect(72, 86, 300, 104))
                hl.set_info(title="张三")
                hl.update()
                doc.saveIncr()
            bk, work = keep.Keeper(Path(tmp) / "keep"), Path(tmp) / "work"
            original = src.read_bytes()
            first = pdfsave.save(src, [(0, marked_page())], bk, work)
            self.assertEqual(first["kept"]["note"], "存回 PDF 前")             # 写之前留了底（2026-11-14 起用留底文件夹，不再是 backups）
            self.assertEqual(Path(first["kept"]["copy"]).read_bytes(), original)
            self.assertEqual((first["ink"], first["marks"], first["notes"], first["outside"]), (2, 1, 2, 1))
            n = len(own_annots(src))
            self.assertEqual(n, 7)                               # 两组手写、下划线、两条便签、圈号（圆圈加数字）
            notes = [a for a in own_annots(src) if a[1] == "Text"]
            self.assertIn("问：这一步为什么取零？", "".join(a[3] for a in notes))
            for _ in range(3):
                again = pdfsave.save(src, [(0, marked_page())], bk, work)
            self.assertEqual(len(own_annots(src)), n)            # 再存不叠加
            self.assertEqual(again["removed"], n)
            with fitz.open(src) as doc:
                self.assertEqual([a.info["title"] for a in doc[0].annots() if not a.info["title"].startswith("InkThink")], ["张三"])
            self.assertFalse((Path(tmp) / "bk").exists())        # 不再往旧的备份文件夹里放
            hist = bk.history(src)
            self.assertTrue(2 <= len(hist) <= 4, len(hist))      # 每次存之前留一版（内容和上一版一样的不重复留）
            self.assertEqual({r["note"] for r in hist}, {"存回 PDF 前"})
            orig = bk.original(src)                              # 第一次存之前的原样留着
            self.assertEqual(Path(orig["copy"]).read_bytes(), original)
            with fitz.open(orig["copy"]) as od:
                self.assertEqual([a.info["title"] for a in od[0].annots()], ["张三"])
            pdfsave.strip_own_file(src, {"local"})
            self.assertEqual(own_annots(src), [])
            with fitz.open(src) as doc:
                self.assertEqual(len(list(doc[0].annots())), 1)

    def test_only_this_notebooks_marks_are_replaced(self):
        """别的电脑、别人用 InkThink 写进同一份 PDF 的批注不删；改版前写的（没有归属标记）只在 legacy 时换掉。"""
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "paper.pdf"
            make_pdf(src)
            bk, work = keep.Keeper(Path(tmp) / "keep"), Path(tmp) / "work"
            pdfsave.save(src, [(0, marked_page())], bk, work, owner="other-pc")      # 别人存的
            with fitz.open(src) as doc:                                            # 改版前写的：作者是 InkThink，没有标记
                old = doc[0].add_text_annot((60, 60), "旧的")
                old.set_info(title=pdfsave.CLAUDE)
                old.update()
                doc.saveIncr()
            n_other = len(own_annots(src)) - 1
            res = pdfsave.save(src, [(0, marked_page())], bk, work, owner="mine")
            self.assertEqual(res["removed"], 0)
            self.assertEqual(len(own_annots(src)), 2 * n_other + 1)                # 都留着，加上我的
            res = pdfsave.save(src, [(0, marked_page())], bk, work, owner="mine", legacy=True)
            self.assertEqual(res["removed"], n_other + 1)                           # 换掉我上次写的和没标记的旧批注
            with fitz.open(src) as doc:
                owners = sorted(pdfsave.owner_of(doc, a) or "-" for a in doc[0].annots() if pdfsave.is_own(a))
            self.assertEqual(owners, ["mine"] * n_other + ["other-pc"] * n_other)
            self.assertEqual(pdfsave.strip_own_file(src, {"mine"}), n_other)      # 导入时也只去掉自己的
            self.assertEqual(len(own_annots(src)), n_other)

    def test_source_changed_while_saving_leaves_it_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "paper.pdf"
            make_pdf(src)
            real = pdfsave._write_page

            def write_then_sync(*a):                                              # 写的时候同步盘改了原件
                real(*a)
                with open(src, "ab") as f:
                    f.write(b"%synced")
            pdfsave._write_page = write_then_sync
            try:
                with self.assertRaises(ValueError) as cm:
                    pdfsave.save(src, [(0, marked_page())], keep.Keeper(Path(tmp) / "keep"), Path(tmp) / "work")
            finally:
                pdfsave._write_page = real
            self.assertIn("被别的程序改了", str(cm.exception))
            self.assertTrue(src.read_bytes().endswith(b"%synced"))                # 没被这次存回覆盖
            self.assertEqual(list(Path(tmp).glob(".~inkthink-*")), [])            # 临时文件清掉了
            self.assertEqual(keep.Keeper(Path(tmp) / "keep").history(src), [])    # 没走到留底

    def test_no_write_when_keep_fails(self):
        """存回 PDF 前留底没做成（比如留底文件夹建不起来）：不写原文件，说清楚。"""
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "paper.pdf"
            make_pdf(src)
            before = src.read_bytes()
            (Path(tmp) / "keep").write_text("不是文件夹", "utf-8")              # 留底文件夹的位置被一个文件占了
            with self.assertRaises(ValueError) as cm:
                pdfsave.save(src, [(0, marked_page())], keep.Keeper(Path(tmp) / "keep"), Path(tmp) / "work")
            self.assertIn("没能把原文件留底", str(cm.exception))
            self.assertIn("原文件没动", str(cm.exception))
            self.assertEqual(src.read_bytes(), before)
            self.assertEqual(list(Path(tmp).glob(".~inkthink-*")), [])

    def test_save_book_back_into_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            src = Path(tmp) / "lib" / "paper.pdf"
            src.parent.mkdir()
            make_pdf(src, pages=2)
            nb = app.import_document(src)
            info = app.notebook_info(nb)
            self.assertEqual((info["savePdf"], info.get("saved")), (True, None))
            t = 1_700_000_000_000
            app.save_page(nb, 0, json.dumps({"v": 1, "ai": [], "reads": [], "strokes": [
                line_stroke("a", t, 100, 200, 300, 200), line_stroke("m", t + 9000, 1100, 300, 1200, 300)]}))  # 页内一组、页边一组
            i = app.insert_page(nb, 0)  # 第 1 页后面插一页空白纸，上面也写了
            app.save_page(nb, i, json.dumps({"v": 1, "ai": [], "reads": [], "strokes": [line_stroke("b", t, 100, 100, 200, 100)]}))
            res = app.save_pdf(nb)
            self.assertEqual((res["ink"], res["outside"], res["blank"], res["file"]), (1, 1, 1, str(src.resolve())))
            self.assertEqual([a[0] for a in own_annots(src)], [0])
            self.assertFalse(app.source_changed(nb[5:]))         # 自己存的不算「原文件改过」
            self.assertTrue(app.notebook_info(nb)["saved"])
            owner = app.sources()[nb[5:]]["owner"]
            with fitz.open(src) as doc:
                self.assertEqual({pdfsave.owner_of(doc, a) for a in doc[0].annots()}, {owner})
            res2 = app.save_pdf(nb)
            self.assertEqual((res2["removed"], app.sources()[nb[5:]]["owner"]), (1, owner))  # 再存：换掉自己上次写的，归属不变
            app.add_pending(nb, app.layout_of(nb).entry(0)["key"], {"req": "x", "items": [{"type": "note", "text": "a"}, {"type": "tick"}]})
            res3 = app.save_pdf(nb)
            self.assertEqual((res3["unplaced"], res3["unplaced_pages"]), (2, [1]))           # Claude 的回复还没落下：提示
            app.take_pending(nb, 0)
            self.assertEqual(app.import_document(src), nb)       # 原地更新：书页里没有自己写的批注，存回时间还在
            self.assertEqual(own_annots(app.books / nb[5:]), [])
            self.assertTrue(app.notebook_info(nb)["saved"])
            nb2 = app.import_document(src, as_new=True)
            self.assertEqual(own_annots(app.books / nb2[5:]), [])
            with fitz.open(src) as doc:                           # 原文件在别处改过：页号可能对不上，不存
                doc.new_page()
                doc.saveIncr()
            with self.assertRaises(ValueError) as cm:
                app.save_pdf(nb)
            self.assertIn("先更新", str(cm.exception))
            png = Path(tmp) / "x.png"
            fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 40, 40), 0).save(png)
            self.assertFalse(app.notebook_info(app.import_document(png))["savePdf"])  # 原文件不是 PDF

    @unittest.skipUnless(sys.platform == "win32", "模拟 Acrobat 那样只许别人读的打开方式")
    def test_locked_file_is_left_alone(self):
        import ctypes
        from ctypes import wintypes
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "paper.pdf"
            make_pdf(src)
            before = src.read_bytes()
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.CreateFileW.restype = wintypes.HANDLE
            k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
            h = k32.CreateFileW(str(src), 0x80000000, 1, None, 3, 0x80, None)  # 读、只共享读、打开已有
            self.assertNotEqual(h, wintypes.HANDLE(-1).value)
            try:
                with self.assertRaises(ValueError) as cm:
                    pdfsave.save(src, [(0, marked_page())], keep.Keeper(Path(tmp) / "keep"), Path(tmp) / "work")
                self.assertIn("占用", str(cm.exception))
            finally:
                k32.CloseHandle(h)
            self.assertEqual(src.read_bytes(), before)


class FakeZotero:
    """假的 Zotero 本机接口：一篇有 PDF 的期刊文章（在分类 数学 › 几何 里）、一篇只有网页快照的专利、一条笔记、
    一个独立的 PDF 附件。forbid=True 时像没开本机接口那样回 403。"""

    def __init__(self, folder):
        folder.mkdir(parents=True, exist_ok=True)
        self.files = {"A1": folder / "Li 等 - 2022 - Pythagorean theorem.pdf", "A3": folder / "standalone.pdf"}
        for p in self.files.values():
            make_pdf(p, pages=2)
        att = lambda k, t: {"href": f"http://localhost:23119/api/users/1/items/{k}", "type": "application/json", "attachmentType": t}  # noqa: E731
        self.items = {
            "K1": {"key": "K1", "data": {"itemType": "journalArticle", "title": "A short proof of the Pythagorean theorem", "collections": ["C2"]},
                   "meta": {"creatorSummary": "Li 等", "parsedDate": "2022-03-01"}, "links": {"attachment": att("A1", "application/pdf")}},
            "K2": {"key": "K2", "data": {"itemType": "patent", "title": "无 PDF 的专利", "collections": []},
                   "meta": {"creatorSummary": "王", "parsedDate": "2020"}, "links": {"attachment": att("A2", "text/html")}},
            "N1": {"key": "N1", "data": {"itemType": "note", "note": "笔记"}, "meta": {}, "links": {}},
            "A3": {"key": "A3", "data": {"itemType": "attachment", "title": "standalone.pdf", "contentType": "application/pdf",
                                         "collections": []}, "meta": {}, "links": {}},
        }
        self.cols = {"C1": {"key": "C1", "data": {"name": "数学", "parentCollection": False}},
                     "C2": {"key": "C2", "data": {"name": "几何", "parentCollection": "C1"}}}
        self.seen, self.forbid = [], False
        fake = self

        class H(server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                u = server.urlparse(self.path)
                q = {k: v[0] for k, v in server.parse_qs(u.query).items()}
                fake.seen.append((u.path, q))
                status, body = fake.route(u.path[len("/api/users/0"):], q)
                data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Total-Results", str(len(body)) if isinstance(body, list) else "1")
                self.end_headers()
                self.wfile.write(data)

        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def route(self, path, q):
        if self.forbid:
            return 403, "Local API is not enabled"
        top = [self.items[k] for k in ("K1", "K2", "N1", "A3")]
        if path == "/items/top":
            want = q.get("q", "").lower()
            return 200, [it for it in top if want in json.dumps(it, ensure_ascii=False).lower()]
        if path == "/collections/top":
            return 200, [self.cols["C1"]]
        m = re.fullmatch(r"/collections/(\w+)(/collections|/items/top)?", path)
        if m and m.group(1) in self.cols:
            k, rest = m.groups()
            if rest == "/collections":
                return 200, [c for c in self.cols.values() if c["data"]["parentCollection"] == k]
            if rest == "/items/top":
                return 200, [it for it in top if k in it["data"].get("collections", [])]
            return 200, self.cols[k]
        m = re.fullmatch(r"/items/(\w+)(/children|/file/view/url)?", path)
        if m:
            k, rest = m.groups()
            if rest == "/file/view/url":
                return (200, self.files[k].as_uri()) if k in self.files else (404, "Not found")
            if rest == "/children":
                return 200, []
            if k in self.items:
                return 200, self.items[k]
        return 404, "Not found"


class ZoteroTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fake = FakeZotero(Path(self.tmp.name) / "同步盘" / "zotero")
        self.app = make_app(self.tmp.name)
        self.app.zotero = zotero.Zotero(self.fake.url)

    def tearDown(self):
        self.fake.close()
        self.tmp.cleanup()

    def test_list_search_and_collections(self):
        d = self.app.zotero_list()
        self.assertEqual([(e["key"], e["pdf"]) for e in d["items"]], [("K1", "A1"), ("K2", None), ("A3", "A3")])  # 笔记不列
        k1 = d["items"][0]
        self.assertEqual((k1["title"], k1["creators"], k1["year"], k1["type"]), ("A short proof of the Pythagorean theorem", "Li 等", "2022", "期刊文章"))
        self.assertEqual(([c["name"] for c in d["collections"]], d["path"]), (["数学"], []))
        self.assertEqual(self.fake.seen[0][1]["sort"], "dateAdded")
        d = self.app.zotero_list(q="pythagorean")
        self.assertEqual([e["key"] for e in d["items"]], ["K1"])
        self.assertEqual((self.fake.seen[-1][1]["q"], self.fake.seen[-1][1]["qmode"]), ("pythagorean", "titleCreatorYear"))
        d = self.app.zotero_list(coll="C1")
        self.assertEqual(([c["name"] for c in d["collections"]], d["items"]), (["几何"], []))
        d = self.app.zotero_list(coll="C2")
        self.assertEqual([e["key"] for e in d["items"]], ["K1"])
        self.assertEqual([c["name"] for c in d["path"]], ["数学", "几何"])
        with self.assertRaises(ValueError):
            self.app.zotero_list(coll="../items")

    def test_import_marks_imported_and_label_cites_paper(self):
        r = self.app.zotero_import("K1")
        self.assertEqual(r["nb"], "book:Li 等 - 2022 - A short proof of the Pythagorean theorem.pdf")
        name = r["nb"][5:]
        self.assertEqual(self.app.notebook_info(r["nb"])["pages"], 2)
        k1 = self.app.zotero_list()["items"][0]
        self.assertEqual((k1["imported"], k1["changed"]), (Path(name).stem, False))
        self.assertEqual(self.app.zotero_import("K1").get("opened"), True)   # 再点：打开原来那本
        label = self.app.page_label(r["nb"], 0)
        self.assertIn("Zotero 文献：Li 等 · 2022 · 期刊文章《A short proof of the Pythagorean theorem》，条目 K1", label)
        self.app.set_source(name, self.fake.files["A1"])                     # 原文件没换：Zotero 信息留着
        self.assertEqual(self.app.sources()[name]["zotero"]["att"], "A1")
        self.assertTrue(self.app.notebook_info(r["nb"])["savePdf"])
        with self.assertRaises(ValueError) as cm:
            self.app.zotero_import("K2")
        self.assertIn("没有 PDF", str(cm.exception))
        self.assertEqual(self.app.zotero_import("A3")["nb"], "book:standalone.pdf")
        self.fake.files["A1"].unlink()                                       # Zotero 记着、文件不在了
        with self.assertRaises(ValueError) as cm:
            self.app.zotero_import("K1")
        self.assertIn("找不到", str(cm.exception))

    def test_zotero_not_running(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        self.app.zotero = zotero.Zotero(f"http://127.0.0.1:{port}", timeout=2)
        with self.assertRaises(ValueError) as cm:
            self.app.zotero_list()
        self.assertIn("连不上 Zotero", str(cm.exception))
        self.app.zotero = zotero.Zotero(self.fake.url)
        self.fake.forbid = True
        with self.assertRaises(ValueError) as cm:
            self.app.zotero_list()
        self.assertIn("本机接口", str(cm.exception))


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = make_app(self.tmp.name)
        server.Handler.app = self.app
        self.httpd = server.Server(("127.0.0.1", 0), server.Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def call(self, method, path, body=None, auth=True, ctype="application/json"):
        data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if auth:
            req.add_header("X-Access", self.app.code)
        if data is not None:
            req.add_header("Content-Type", ctype)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                return r.status, r.headers.get("Content-Type", ""), raw
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Content-Type", ""), e.read()

    def j(self, method, path, body=None, auth=True):
        st, _, raw = self.call(method, path, body, auth)
        return st, json.loads(raw) if raw else None

    def test_auth_and_static(self):
        self.assertEqual(self.call("GET", "/api/config", auth=False)[0], 401)
        st, cfg = self.j("GET", "/api/config")
        self.assertEqual(st, 200)
        self.assertTrue(cfg["pdf"])
        st, _, body = self.call("GET", "/")
        self.assertIn(b"app.js", body)
        self.assertEqual(self.call("GET", "/static/fonts/xiaolai-gb2312.woff2")[:2], (200, "font/woff2"))
        self.assertEqual(self.call("GET", "/static/../server.py")[0], 404)
        self.assertEqual(self.call("GET", "/static/%2e%2e/server.py")[0], 404)

    def test_static_checks_the_path_before_touching_files(self):
        """/static/ 不需要访问码：网络路径、盘符、上一级这些先按字面拒掉，不拿去解析。"""
        for rel in ("//evil/share/x.js", "\\\\evil\\share\\x.js", "/etc/passwd", "C:/Windows/win.ini", "a/../../server.py", "app.js%00", "", "a//b.js"):
            self.assertFalse(server.static_rel_ok(rel), rel)
        for rel in ("app.js", "fonts/xiaolai-gb2312.woff2", "katex/fonts/KaTeX_Main-Regular.woff2", "manifest.webmanifest"):
            self.assertTrue(server.static_rel_ok(rel), rel)
        self.assertEqual(self.call("GET", "/static///evil/share/x.js", auth=False)[0], 404)

    def test_bridge_refuses_requests_from_other_sites(self):
        """本机管理接口：别的网页借浏览器发来的（Origin 对不上、标着跨站）和用别的域名指过来的都不收；插件那样不带这些头的照常。"""
        def status(path, headers):
            req = urllib.request.Request(self.base + path, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.status
            except urllib.error.HTTPError as e:
                return e.code
        self.assertEqual(status("/bridge/ping", {}), 200)
        self.assertEqual(status("/bridge/ping", {"Origin": self.base, "Sec-Fetch-Site": "same-origin"}), 200)
        self.assertEqual(status("/bridge/ping", {"Origin": "http://evil.example"}), 403)
        self.assertEqual(status("/bridge/ping", {"Origin": "null"}), 403)
        self.assertEqual(status("/bridge/ping", {"Sec-Fetch-Site": "cross-site"}), 403)
        self.assertEqual(status("/bridge/ping", {"Host": "evil.example:8765"}), 403)
        self.assertEqual(status("/qr", {"Sec-Fetch-Site": "cross-site"}), 403)
        self.assertEqual(status("/qr", {"Sec-Fetch-Site": "none"}), 200)

    def test_device_name_cannot_become_markup(self):
        dev_id, _ = self.app.pair_device("<img src=x onerror=alert(1)>", "127.0.0.1")
        name = [d for d in self.app.device_list() if d["id"] == dev_id][0]["name"]
        self.assertEqual(name, "img src=x onerror=alert(1)")
        self.assertEqual(self.app.device_list()[-1]["id"], dev_id)
        page = self.call("GET", "/qr", auth=False)[2].decode("utf-8")
        self.assertNotIn("innerHTML = '<table", page)        # 设备表不再拼 HTML
        self.assertIn("td.textContent = text", page)
        self.assertIsNone(pages.FIG_NAME.match("../../secret.png"))  # 图的文件名也只认服务自己起的

    def test_pages_roundtrip(self):
        page = {"v": 1, "strokes": [{"id": "a", "t0": 1, "w": 2.1, "pts": [[1, 2, 0.5, 0]]}], "ai": [], "reads": []}
        self.assertEqual(self.call("PUT", "/api/page?nb=scratch&i=0", page)[0], 200)
        self.assertEqual(self.j("GET", "/api/page?nb=scratch&i=0")[1]["strokes"][0]["id"], "a")
        self.assertEqual(self.call("PUT", "/api/page?nb=scratch&i=0", {"bad": 1})[0], 400)
        n0 = self.j("GET", "/api/notebook?nb=scratch")[1]["pages"]
        self.assertEqual(self.j("POST", "/api/notebook/addpage?nb=scratch", b"")[1]["pages"], n0 + 1)

    def test_rename_notebooks(self):
        st, pad = self.j("POST", "/api/notebook/new", {"title": "随笔"})
        st, r = self.j("POST", "/api/notebook/rename", {"nb": pad["id"], "title": "  周三例会想法 "})
        self.assertEqual((st, r["id"]), (200, pad["id"]))
        self.assertEqual(self.app.nb_title(pad["id"]), "周三例会想法")
        make_pdf(self.app.books / "示例 暑假旅行计划_例会汇报_v47.pdf")
        old = "book:示例 暑假旅行计划_例会汇报_v47.pdf"
        self.app.save_page(old, 0, json.dumps({"v": 1, "strokes": [stroke("a", 1, 100, 100)], "ai": [], "reads": []}))
        st, r = self.j("POST", "/api/notebook/rename", {"nb": old, "title": "例会 v47: 定稿"})
        self.assertEqual((st, r["id"]), (200, "book:例会 v47 定稿.pdf"))           # 文件名不能用的字去掉
        self.assertEqual(json.loads(self.app.load_page(r["id"], 0))["strokes"][0]["id"], "a")  # 笔迹跟着走
        self.assertEqual(self.app.current_nb(old), r["id"])                        # 按旧名字记的投递找得到
        make_pdf(self.app.books / "别的.pdf")
        self.assertEqual(self.j("POST", "/api/notebook/rename", {"nb": "book:别的.pdf", "title": "例会 v47 定稿"})[0], 400)  # 重名
        self.assertEqual(self.j("POST", "/api/notebook/rename", {"nb": "scratch", "title": "x"})[0], 400)
        self.assertEqual(self.j("POST", "/api/notebook/rename", {"nb": pad["id"], "title": "  "})[0], 400)

    def test_folders(self):
        """抽屉里的文件夹（2026-11-14）：只是归类，记在 notebooks/folders.json，不改 pads.json、本子的文件夹和书。
        新建（可以顺手放进一本）、放进去（一本只在一个文件夹里）、移出、改名、删（本子回到外面）；草稿本和 Claude 推送不进；
        本子删了、书改名了，文件夹里记的跟着变；文件夹里有已经不在的本子也不出错。"""
        _, pad = self.j("POST", "/api/notebook/new", {"title": "随笔"})
        _, pad2 = self.j("POST", "/api/notebook/new", {"title": "想法"})
        make_pdf(self.app.books / "例会_v47.pdf")
        book = "book:例会_v47.pdf"
        nbdir = self.app.data / "notebooks"
        self.app.notebook_info(book)  # 书的笔迹文件夹先建好（平板打开时会建），下面比的只是文件夹操作改了什么

        def files():
            return {str(p.relative_to(self.app.data)): p.read_bytes() for p in nbdir.rglob("*") if p.is_file()} | \
                   {str(p.relative_to(self.app.books)): p.read_bytes() for p in self.app.books.rglob("*") if p.is_file()}
        before = files()
        self.assertEqual(self.j("GET", "/api/folders")[1], {"folders": []})
        st, r = self.j("POST", "/api/folders/new", {"name": "  原先 ", "nb": pad["id"]})
        self.assertEqual(st, 200)
        f1 = r["id"]
        self.assertEqual(r["folders"], [{"id": f1, "name": "原先", "items": [pad["id"]]}])
        st, r = self.j("POST", "/api/folders/new", {"name": "课题"})
        f2 = r["id"]
        self.assertEqual([f["name"] for f in r["folders"]], ["原先", "课题"])               # 按建立的先后
        self.assertEqual(self.j("POST", "/api/folders/new", {"name": "课题"})[0], 400)     # 重名
        self.assertEqual(self.j("POST", "/api/folders/new", {"name": "  "})[0], 400)       # 空名字
        for fixed in ("scratch", "board"):                                               # 草稿本、Claude 推送不进文件夹
            self.assertEqual(self.j("POST", "/api/folders/move", {"nb": fixed, "folder": f2})[0], 400)
        self.assertEqual(self.j("POST", "/api/folders/new", {"name": "草稿", "nb": "scratch"})[0], 400)
        self.assertEqual(self.j("POST", "/api/folders/move", {"nb": "pad:nope", "folder": f2})[0], 404)
        self.assertEqual(self.j("POST", "/api/folders/move", {"nb": pad2["id"], "folder": "f-nope"})[0], 404)
        self.j("POST", "/api/folders/move", {"nb": book, "folder": f2})
        self.j("POST", "/api/folders/move", {"nb": pad2["id"], "folder": f2})
        r = self.j("POST", "/api/folders/move", {"nb": pad["id"], "folder": f2})[1]       # 换一个文件夹：从原来的拿出来
        self.assertEqual({f["name"]: f["items"] for f in r["folders"]}, {"原先": [], "课题": [book, pad2["id"], pad["id"]]})
        r = self.j("POST", "/api/folders/move", {"nb": pad2["id"], "folder": ""})[1]      # 移出
        self.assertEqual({f["name"]: f["items"] for f in r["folders"]}, {"原先": [], "课题": [book, pad["id"]]})
        r = self.j("POST", "/api/folders/rename", {"id": f1, "name": "以前的"})[1]
        self.assertEqual([f["name"] for f in r["folders"]], ["以前的", "课题"])
        self.assertEqual(self.j("POST", "/api/folders/rename", {"id": f1, "name": "课题"})[0], 400)
        self.assertEqual(self.j("POST", "/api/folders/rename", {"id": "f-nope", "name": "x"})[0], 404)
        saved = json.loads((nbdir / "folders.json").read_text("utf-8"))
        self.assertEqual(saved, {"v": 1, "folders": [{"id": f1, "name": "以前的", "items": []},
                                                     {"id": f2, "name": "课题", "items": [book, pad["id"]]}]})
        self.assertTrue(any(e["type"] == "folders" for e in self.app.bridge.events))      # 别的设备上的抽屉跟着刷新
        after = files()                                                                  # 只多了 folders.json，别的一个字节没动
        self.assertEqual(set(after) - set(before), {str(Path("notebooks") / "folders.json")})
        self.assertEqual({k: v for k, v in after.items() if k in before}, before)
        # 导入的书改名：文件夹里跟着换成新名字
        self.j("POST", "/api/notebook/rename", {"nb": book, "title": "例会_v48"})
        book2 = "book:例会_v48.pdf"
        self.assertEqual(self.j("GET", "/api/folders")[1]["folders"][1]["items"], [book2, pad["id"]])
        # 删一本：文件夹照常，里面不再有它；文件夹里有已经不在的本子（比如电脑上挪走了）：照常读，给平板的列表里滤掉
        self.j("POST", "/api/notebook/delete", {"nb": pad["id"]})
        self.assertEqual(self.j("GET", "/api/folders")[1]["folders"][1]["items"], [book2])
        (self.app.books / "例会_v48.pdf").unlink()
        st, r = self.j("GET", "/api/folders")
        self.assertEqual((st, r["folders"][1]["items"]), (200, []))
        self.assertEqual(self.j("GET", "/api/notebooks")[0], 200)
        # 删文件夹：里面的本子回到外面（本子不动）
        self.j("POST", "/api/folders/move", {"nb": pad2["id"], "folder": f2})
        r = self.j("POST", "/api/folders/delete", {"id": f2})[1]
        self.assertEqual(r["folders"], [{"id": f1, "name": "以前的", "items": []}])
        self.assertIn(pad2["id"], [n["id"] for n in self.j("GET", "/api/notebooks")[1]])
        self.assertEqual(self.j("POST", "/api/folders/delete", {"id": f2})[0], 404)
        # 新导入的书在文件夹外面：以前同名的书在文件夹里留下的记录不算它
        self.j("POST", "/api/folders/move", {"nb": pad2["id"], "folder": f1})
        raw = json.loads((nbdir / "folders.json").read_text("utf-8"))
        raw["folders"][0]["items"].append("book:新的.pdf")                                 # 手改留下的旧记录
        (nbdir / "folders.json").write_text(json.dumps(raw, ensure_ascii=False), "utf-8")
        src = Path(self.tmp.name) / "新的.pdf"
        make_pdf(src)
        self.app.import_document(src)
        self.assertNotIn("book:新的.pdf", json.loads((nbdir / "folders.json").read_text("utf-8"))["folders"][0]["items"])
        # 文件坏了：读的时候当没有，改的时候报错、不覆盖
        (nbdir / "folders.json").write_text("{坏了", "utf-8")
        self.assertEqual(self.j("GET", "/api/folders")[1], {"folders": []})
        self.assertEqual(self.j("POST", "/api/folders/new", {"name": "x"})[0], 400)
        self.assertEqual((nbdir / "folders.json").read_text("utf-8"), "{坏了")

    def test_flow_setting(self):
        make_pdf(self.app.books / "三页.pdf", pages=3)
        self.assertFalse(self.j("GET", "/api/notebook?nb=scratch")[1]["flow"])            # 草稿本默认单页
        self.assertFalse(self.j("GET", "/api/notebook?nb=scratch")[1]["flowSet"])         # 没选过：平时的页面按连续
        nb = "book:三页.pdf"
        self.assertTrue(self.j("GET", "/api/notebook?nb=" + urllib.parse.quote(nb))[1]["flow"])  # 书默认连续
        self.assertEqual(self.j("POST", "/api/notebook/setting", {"nb": nb, "key": "flow", "value": False})[0], 200)
        self.assertFalse(self.j("GET", "/api/notebook?nb=" + urllib.parse.quote(nb))[1]["flow"])
        self.assertEqual(self.j("POST", "/api/notebook/setting", {"nb": nb, "key": "paper", "value": "x"})[0], 400)
        self.assertEqual(self.j("POST", "/api/notebook/setting", {"nb": nb, "key": "flow", "value": "yes"})[0], 400)
        self.assertEqual(self.j("POST", "/api/notebook/setting", {"nb": "scratch", "key": "flow", "value": True})[0], 200)
        self.assertTrue(self.j("GET", "/api/notebook?nb=scratch")[1]["flow"])
        self.assertTrue(self.j("GET", "/api/notebook?nb=scratch")[1]["flowSet"])          # 选过了：平时的页面照选的来

    def test_send_without_session_is_refused(self):
        st, d = self.j("POST", "/api/send", send_payload())
        self.assertEqual(st, 400)
        self.assertIn("没有连上的 Claude Code 对话", d["error"])

    def test_full_flow(self):
        # 两个对话登记；后登记的那个更「活跃」，平板默认发给它
        self.assertEqual(self.j("POST", "/bridge/hello", {"sid": "A", "label": "MY_PAPER", "cwd": "E:\\proj\\MY_PAPER"})[0], 200)
        st, hello = self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\proj\\idea"})
        self.assertTrue(hello["url"].endswith("/?k=" + self.app.code))
        self.assertTrue(hello["qr"].startswith("<svg") or hello["qr"].startswith("<?xml"))
        self.j("POST", "/bridge/active", {"sid": "A"})
        sessions = self.j("GET", "/api/sessions")[1]
        self.assertEqual(sessions["default"], "A")
        self.assertEqual({s["label"] for s in sessions["sessions"]}, {"MY_PAPER", "idea"})

        # 平板指定发给 B
        st, sent = self.j("POST", "/api/send", send_payload(target="B"))
        self.assertEqual((st, sent["label"]), (200, "idea"))
        self.assertEqual(self.j("GET", "/bridge/poll?sid=A")[1], {})
        sub = self.j("GET", "/bridge/poll?sid=B")[1]["submission"]
        self.assertEqual(sub["id"], sent["id"])
        self.assertTrue(sub["text"].startswith("【草稿纸】"))
        img = sub["text"].split("- 这一页：")[1].split("（")[0]
        self.assertTrue(Path(img).is_file())
        self.assertTrue(Path(img).resolve().is_relative_to(Path(hello["submissionsDir"])))
        self.assertEqual(self.j("GET", "/bridge/poll?sid=B")[1], {})  # 只取一次

        # Claude 写回批注：进待处理队列，平板取一次就清空
        st, rep = self.j("POST", "/bridge/reply", {"sid": "B", "submission": sub["id"],
                                                   "items": [{"type": "question", "anchor": "g2", "text": "单位对吗？"}, {"type": "nope"}]})
        self.assertEqual((st, rep["count"]), (200, 1))
        pend = self.j("GET", "/api/pending?nb=scratch&i=0")[1]
        self.assertEqual(pend[0]["items"], [{"type": "question", "anchor": "g2", "text": "单位对吗？"}])
        self.assertEqual(pend[0]["groups"]["g2"], [100, 200, 420, 250])
        self.assertEqual(pend[0]["req"], sub["id"])
        self.assertEqual(self.j("GET", "/api/pending?nb=scratch&i=0")[1], [])
        # 不给 submission：写到这个对话最近一次投递的那一页
        self.assertEqual(self.j("POST", "/bridge/reply", {"sid": "B", "items": [{"type": "circle", "anchor": "g3"}]})[0], 200)
        self.assertEqual(self.j("POST", "/bridge/reply", {"sid": "A", "items": [{"type": "circle", "anchor": "g3"}]})[0], 400)
        self.assertEqual(self.j("GET", "/api/pending?nb=scratch&i=0")[1][0]["gx"], {})  # 平板没发笔迹 id

        # 事件流
        ev = self.j("GET", "/api/events?since=0&wait=0")[1]
        kinds = [e["type"] for e in ev["events"]]
        self.assertIn("ai", kinds)
        t0 = time.time()
        self.assertEqual(self.j("GET", f"/api/events?since={ev['seq']}&wait=1")[1]["events"], [])
        self.assertGreater(time.time() - t0, 0.8)  # 没有新事件时等着
        st, d = self.j("GET", "/api/events?since=99999&wait=5")  # 服务重启过的序号：立即从头给
        self.assertEqual(st, 200)
        # 删掉的接口（对话回复面板、快通道、文档更新后判断旧批注）不再应答。不带请求体：找不到的地址服务不读请求体，
        # 带着没读的字节关连接时 Windows 会直接断开（WinError 10053），拿不到 404
        for method, path in (("POST", "/bridge/answer"), ("POST", "/api/reply"), ("POST", "/bridge/route"), ("GET", "/bridge/prelim"),
                             ("POST", "/bridge/judge"), ("POST", "/bridge/relocate"), ("POST", "/api/book/judge"), ("POST", "/bridge/forward")):
            self.assertEqual(self.call(method, path)[0], 404, path)

        # 状态与告别
        status = self.j("GET", "/bridge/status?sid=B")[1]
        self.assertTrue(status["tabletOnline"])
        self.j("POST", "/bridge/bye", {"sid": "A"})
        self.assertEqual([s["sid"] for s in self.j("GET", "/api/sessions")[1]["sessions"]], ["B"])
        self.assertEqual(self.j("GET", "/bridge/poll?sid=A")[1], {"unknown": True})

    def test_send_keeps_only_the_page_image(self):
        """交一页只存消息里列的那张图（crop.jpg）；以前平板另画的整页概览不再存，旧页面发来了也不存。"""
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        body = send_payload(target="B")
        body["images"]["overview"] = "data:image/jpeg;base64," + TINY_JPEG
        st, sent = self.j("POST", "/api/send", body)
        self.assertEqual(st, 200)
        d = self.app.data / "submissions" / sent["id"]
        self.assertTrue((d / "crop.jpg").is_file())
        self.assertFalse((d / "overview.jpg").exists())

    def test_reply_carries_stroke_ids_of_groups(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        body = send_payload(target="B")
        for g, ids in zip(body["groups"], (["s1", "s2"], ["s3"], ["s4"])):
            g["ids"] = ids
        body["groups"][1]["red"] = True
        sent = self.j("POST", "/api/send", body)[1]
        self.j("GET", "/bridge/poll?sid=B")
        self.assertEqual(self.j("POST", "/bridge/reply", {"sid": "B", "submission": sent["id"],
                                                          "items": [{"type": "write", "text": "答", "q": "问？", "anchor": "g2"}]})[0], 200)
        pend = self.j("GET", "/api/pending?nb=scratch&i=0")[1][0]
        self.assertEqual(pend["items"][0]["q"], "问？")
        self.assertEqual(pend["gx"]["g2"], {"ids": ["s3"], "red": True, "sel": True})
        self.assertEqual(pend["gx"]["g1"], {"ids": ["s1", "s2"], "red": False, "sel": False})

    def test_show_and_snapshot(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        img = Path(self.tmp.name) / "plot.jpg"
        img.write_bytes(base64.b64decode(TINY_JPEG))
        st, shown = self.j("POST", "/bridge/show", {"sid": "B", "path": str(img), "title": "一周气温"})
        self.assertEqual((st, shown["page"], shown["title"]), (200, 0, "一周气温"))
        self.assertEqual(self.call("GET", "/api/boardbg?i=0")[1], "image/png")
        self.assertEqual(self.j("POST", "/bridge/show", {"sid": "B", "path": str(img) + ".none"})[0], 400)

        # 平板不在线时快照直接失败
        self.app.bridge.tablet_seen = 0
        self.assertEqual(self.j("POST", "/bridge/snapshot", {"sid": "B", "wait": 2})[0], 400)

        # 模拟平板：收到 snapshot 事件就回传
        self.j("GET", "/api/events?since=0&wait=0")
        seq = self.app.bridge.seq

        def tablet():
            d = self.j("GET", f"/api/events?since={seq}&wait=10")[1]
            rid = [e for e in d["events"] if e["type"] == "snapshot"][0]["rid"]
            body = send_payload()
            body["rid"] = rid
            self.call("POST", "/api/snapshot", body)

        th = threading.Thread(target=tablet)
        th.start()
        st, snap = self.j("POST", "/bridge/snapshot", {"sid": "B", "wait": 10})
        th.join()
        self.assertEqual(st, 200)
        self.assertTrue(snap["text"].startswith("【草稿纸·快照】"))

    def test_reply_without_submission_goes_to_tablet_page_and_import(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        self.assertEqual(self.j("POST", "/bridge/reply", {"sid": "B", "items": [{"type": "write", "text": "x"}]})[0], 400)
        for _ in range(2):
            self.j("POST", "/api/notebook/addpage?nb=scratch", b"")
        self.j("POST", "/api/where", {"nb": "scratch", "page": 2})
        st, rep = self.j("POST", "/bridge/reply", {"sid": "B", "items": [{"type": "write", "text": "第一行\n第二行", "anchor": "end"}]})
        self.assertEqual((st, rep["page"]), (200, "草稿本第 3 页（空白草稿纸）"))
        pend = self.j("GET", "/api/pending?nb=scratch&i=2")[1]
        self.assertEqual(pend[0]["items"][0]["text"], "第一行\n第二行")
        # 平板上传图片 → 导入成一本
        png = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 50, 80), 0).tobytes("png")
        st, up = self.j("POST", "/api/upload?name=" + urllib.request.quote("草图.png"), png)
        self.assertEqual((st, up["id"]), (200, "book:草图.pdf"))
        self.assertEqual(self.j("POST", "/api/upload?name=a.exe", b"MZ")[0], 400)
        # 插件导入 → 平板收到 show 事件
        pdf = Path(self.tmp.name) / "slides.pdf"
        make_pdf(pdf, pages=3)
        st, imp = self.j("POST", "/bridge/import", {"sid": "B", "path": str(pdf), "title": "例会"})
        self.assertEqual((st, imp["id"], imp["pages"]), (200, "book:例会.pdf", 3))
        shows = [e for e in self.j("GET", "/api/events?since=0&wait=0")[1]["events"] if e["type"] == "show"]
        self.assertEqual(shows[-1]["nb"], "book:例会.pdf")

    def test_refusals_arrive_even_when_the_body_was_not_read(self):
        """服务不读请求体就拒绝的那些情况（不支持的文件、没有的地址）：平板收到的应当是那句拒绝的话。
        以前不读就回，Windows 上客户端有时收到的是「连接中断」（WinError 10053），2026-11-13 整套测试里偶发过。"""
        big = b"MZ" + b"\0" * 400_000
        for _ in range(25):
            self.assertEqual(self.j("POST", "/api/upload?name=a.exe", big)[0], 400)
            self.assertEqual(self.j("POST", "/bridge/no-such-thing", big)[0], 404)

    def put_page(self, i, strokes, nb="scratch", ai=None):
        page = {"v": 1, "strokes": strokes, "ai": ai or [], "reads": []}
        self.assertEqual(self.call("PUT", f"/api/page?nb={nb}&i={i}", page)[0], 200)

    def test_notebook_remembers_its_conversation(self):
        """每本记住自己的对话：第一次发送时记下；之后别的对话「最近打字」也不漂移；原对话不在了先问（410）。"""
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "MY_PAPER", "cwd": "E:\\a"})
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\b"})
        self.j("POST", "/bridge/active", {"sid": "A"})
        st, sent = self.j("POST", "/api/send", send_payload())                     # 没绑过：发给最近打字的 A，并记下
        self.assertEqual((st, sent["label"]), (200, "MY_PAPER"))
        self.assertEqual(self.j("GET", "/api/notebook?nb=scratch")[1]["target"]["sid"], "A")
        self.j("POST", "/bridge/active", {"sid": "B"})                              # B 变成最近打字的
        self.assertEqual(self.j("POST", "/api/send", send_payload())[1]["label"], "MY_PAPER")  # 这本还是发给 A
        self.assertEqual(self.app.bridge.default_target(), "B")
        self.assertEqual(self.j("POST", "/api/notebook/target", {"nb": "scratch", "sid": "B"})[1]["target"]["label"], "idea")
        self.assertEqual(self.j("POST", "/api/send", send_payload())[1]["label"], "idea")  # 换成 B 了
        st, d = self.j("POST", "/api/notebook/target", {"nb": "scratch", "sid": "nope"})
        self.assertEqual(st, 400)
        self.j("POST", "/bridge/bye", {"sid": "B"})
        st, d = self.j("POST", "/api/send", send_payload())                         # B 关了：先问，不转给 A
        self.assertEqual((st, d["gone"]), (410, "idea"))
        self.assertIn("那个对话现在不在了", d["error"])
        self.assertEqual(self.j("POST", "/api/send-all", {"nb": "scratch"})[0], 410)
        self.assertEqual(self.j("POST", "/api/send", send_payload(target="A"))[1]["label"], "MY_PAPER")  # 选了 A：发给 A，记成 A
        self.assertEqual(self.app.nb_target("scratch")["sid"], "A")

    def test_delivery_stays_with_its_conversation(self):
        """投递时冻结接收者：对话关了，没送到的留着；接着这个对话（编号不变）时照样送到，不转给别的对话。"""
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "MY_PAPER", "cwd": "E:\\a"})
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\b"})
        sent = self.j("POST", "/api/send", send_payload(target="A"))[1]
        self.j("POST", "/bridge/bye", {"sid": "A"})
        self.j("POST", "/bridge/claim", {"sid": "B"})
        self.assertEqual(self.j("GET", "/bridge/poll?sid=B")[1], {})
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "MY_PAPER", "cwd": "E:\\a"})
        self.assertEqual(self.j("GET", "/bridge/poll?sid=A")[1]["submission"]["id"], sent["id"])

    def test_claim_binds_open_notebook_and_pushes_bind_board(self):
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "MY_PAPER", "cwd": "E:\\a"})
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\b"})
        self.j("POST", "/api/notebook/target", {"nb": "scratch", "sid": "A"})
        self.j("POST", "/api/where", {"nb": "scratch", "page": 0})
        st, status = self.j("GET", "/bridge/status?sid=B")
        self.assertEqual((status["isTarget"], status["targetLabel"], status["targetNb"]), (False, "MY_PAPER", "草稿本"))
        self.j("POST", "/bridge/claim", {"sid": "B"})                               # /ink here：开着的这本改到 B
        self.assertEqual(self.app.nb_target("scratch")["sid"], "B")
        self.assertTrue(self.j("GET", "/bridge/status?sid=B")[1]["isTarget"])
        img = Path(self.tmp.name) / "fig.png"
        fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 40, 30), 0).save(str(img))
        self.j("POST", "/bridge/show", {"sid": "A", "path": str(img)})              # A 推来的页：在上面写的发回 A
        self.assertEqual(self.app.nb_target("board")["sid"], "A")

    def test_status_has_the_protocol_and_messages_only_the_page(self):
        """固定说明在状态里（插件放进系统提示）；发给对话的投递只放这一页的内容。hello 带不带 proto 都一样：服务不再看。"""
        st, hello = self.j("POST", "/bridge/hello", {"sid": "A", "label": "MY_PAPER", "cwd": "E:\\a", "proto": 3})
        self.assertNotIn("proto", hello)
        self.assertEqual(hello["protocol"], prompt.protocol())
        self.assertIn("改东西只按这一条规则", hello["protocol"])
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\b"})
        a = self.j("POST", "/api/send", send_payload(target="A"))[1]
        b = self.j("POST", "/api/send", send_payload(target="B"))[1]
        with_proto = self.j("GET", "/bridge/poll?sid=A")[1]["submission"]["text"]
        without = self.j("GET", "/bridge/poll?sid=B")[1]["submission"]["text"]
        self.assertIn(a["id"], with_proto)
        self.assertIn(b["id"], without)
        for rule in ("改东西只按这一条规则", "不是越多越好", "颜色："):
            self.assertNotIn(rule, with_proto)
            self.assertNotIn(rule, without)
        self.assertEqual(with_proto.replace(a["id"], "X"), without.replace(b["id"], "X"))

    def test_round_progress_is_logged_and_pushed(self):
        """第 3 阶段：一轮的进展（发出、排队、送达、在看、改文件、写回、结束）推给平板，时刻记进 rounds.jsonl。"""
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "MY_PAPER", "cwd": "E:\\a"})
        sub = self.j("POST", "/api/send", send_payload(target="A"))[1]["id"]
        self.j("POST", "/bridge/progress", {"sid": "A", "id": sub, "stage": "queued"})
        self.j("GET", "/bridge/poll?sid=A&ack=1")
        self.j("POST", "/bridge/ack", {"sid": "A", "id": sub})
        self.j("POST", "/bridge/progress", {"sid": "A", "id": sub, "stage": "reading"})
        self.assertFalse(self.j("POST", "/bridge/progress", {"sid": "A", "id": sub, "stage": "reading"})[1]["ok"])  # 只记第一次
        self.assertFalse(self.j("POST", "/bridge/progress", {"sid": "A", "id": sub, "stage": "sent"})[1]["ok"])  # 插件不能报这几步
        self.j("POST", "/bridge/reply", {"sid": "A", "submission": sub, "items": [{"type": "note", "anchor": "g2", "text": "好"}]})
        self.j("POST", "/bridge/progress", {"sid": "A", "id": sub, "stage": "working"})
        self.j("POST", "/bridge/progress", {"sid": "A", "id": sub, "stage": "done"})
        rows = [json.loads(x) for x in (self.app.data / "metrics" / "rounds.jsonl").read_text("utf-8").splitlines()]
        self.assertEqual([r["stage"] for r in rows if r["id"] == sub], ["sent", "queued", "delivered", "reading", "replied", "working", "done"])
        ts = [r["t"] for r in rows if r["id"] == sub]
        self.assertEqual(ts, sorted(ts))
        evs = [e for e in self.app.bridge.events if e["type"] == "progress" and e["id"] == sub]
        self.assertEqual(len(evs), 7)
        # 上下文大小（2026-11-14 删了「对话上下文太长，回得会慢」）：还没重载插件时旧插件照样报来，不出错、不记、不转给平板
        n_ev = len(self.app.bridge.events)
        st, r = self.j("POST", "/bridge/progress", {"sid": "A", "ctx": 260000})
        self.assertEqual((st, r["ok"]), (200, False))
        self.assertEqual(len(self.app.bridge.events), n_ev)
        self.assertFalse(hasattr(self.app.bridge, "set_ctx"))
        self.assertNotIn("ctx", self.app.bridge.sessions["A"])
        ss = self.j("GET", "/api/sessions")[1]["sessions"]
        self.assertFalse(any("ctx" in s for s in ss))

    def send_strokes(self, strokes, target="A"):
        """把笔迹存成草稿本第 1 页，按服务端的分组整页交上去，返回发给对话的消息。"""
        self.put_page(0, strokes)
        ids = {gid: [s["id"] for s in ss] for gid, ss in pages.group_strokes(strokes)}  # 平板发来的分组带着笔迹 id
        groups = [dict(g, inSel=True, ids=ids.get(g["id"], [])) for g in pages.compute_groups(strokes)]
        body = dict(send_payload(target=target), groups=groups, sel={"x0": 0, "y0": 0, "x1": 800, "y1": 400})
        st, sent = self.j("POST", "/api/send", body)
        self.assertEqual(st, 200)
        return sent["id"], self.j("GET", f"/bridge/poll?sid={target}")[1]["submission"]["text"]

    def test_sheet_and_ocr_go_with_the_message(self):
        """第 3 阶段：字帖（每组统一字高）代替「只有笔迹」的图；PP-OCR 的读法和 Windows 的并列当旁证。"""
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "MY_PAPER", "cwd": "E:\\a"})
        t = 1_700_000_000_000
        seen = []

        def fake(cells, budget_s=0):
            seen.extend(gid for gid, _ in cells)
            return {"g1": "给出"}
        old = (ocr.AVAILABLE, ocr.recognize)
        ocr.AVAILABLE, ocr.recognize = True, fake
        try:
            sub, text = self.send_strokes([stroke("a", t, 100, 100), stroke("b", t + 300, 170, 100),
                                           stroke("c", t + 90000, 100, 300, red=True)])
        finally:
            ocr.AVAILABLE, ocr.recognize = old
        sheet = self.app.data / "submissions" / sub / "sheet.png"
        self.assertTrue(sheet.exists())
        self.assertIn(f"字帖：{sheet}", text)
        self.assertNotIn("只有笔迹", text)
        self.assertEqual(seen, ["g1", "g2"])
        self.assertIn("PP-OCR「给出」", text)
        meta = json.loads((self.app.data / "submissions" / sub / "meta.json").read_text("utf-8"))
        self.assertEqual([g.get("ocr") for g in meta["groups"]], ["给出", None])

    def test_corrections_are_remembered(self):
        """记住你的字：确认卡片上更正了 Claude 的读法，存进更正表；之后的发送附上相关的几条。"""
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "MY_PAPER", "cwd": "E:\\a"})
        self.app.bridge.tablet_seen = 0
        t = 1_700_000_000_000
        sub, _ = self.send_strokes([stroke("a", t, 100, 100)])
        c = self.j("POST", "/bridge/confirm", {"sid": "A", "submission": sub, "questions": [
            {"anchor": "g1", "guess": "绘出"}, {"anchor": "g1", "guess": "ρ"}]})[1]
        self.j("POST", "/api/confirm-answer", {"id": c["id"], "answers": [{"text": "给出"}, {"text": "ρ"}]})  # 第二处读对了，不算更正
        rows = json.loads((self.app.data / "corrections.json").read_text("utf-8"))
        self.assertEqual([(r["guess"], r["text"]) for r in rows], [("绘出", "给出")])
        _, text = self.send_strokes([stroke("a", t, 100, 100), stroke("b", t + 90000, 100, 300)])
        self.assertIn("你以前读错过的（我在确认卡片上更正的）：「绘出」→「给出」。", text)
        self.assertEqual(self.app.corrections_for([{"reco": ["给出来"]}], n=1, least=0), [{"guess": "绘出", "text": "给出"}])
        self.assertEqual(self.app.corrections_for([{"reco": ["无关"]}], least=0), [])

    def test_vocab_from_the_project(self):
        """领域词表：对话所在项目的说明文件里的术语（出现两次以上的）。"""
        proj = Path(self.tmp.name) / "proj"
        proj.mkdir()
        (proj / "CLAUDE.md").write_text("三角形面积 S_abc 不是常数；S_abc 和 h_top、ABCD 的周长。ABCD 见上。NOT 这个不算。", "utf-8")
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "proj", "cwd": str(proj)})
        _, text = self.send_strokes([stroke("a", 1_700_000_000_000, 100, 100)])
        line = next(ln for ln in text.split("\n\n") if ln.startswith("领域词表"))
        self.assertEqual(line, "领域词表（认字时参考）：ABCD、S_abc。")

    def test_marks_can_point_at_one_line_of_a_group(self):
        """一组笔迹写了两行（列表的下一行编号和上一行连着写）：消息里标「分 2 行」，标记用 g1:1 只指第 1 行。
        （2026-11-02 冒烟测试：「有实证」的批注和「存疑」的波浪线落到了下一行。）"""
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "idea", "cwd": "E:\\a"})
        t = 1_700_000_000_000
        line1 = [stroke(f"a{k}", t + 300 * k, 100 + 60 * k, 100) for k in range(3)]
        line2 = [stroke("b0", t + 1200, 100, 135)]  # 紧接着写的下一行编号：和上一行同一组
        sub, text = self.send_strokes(line1 + line2)
        self.assertIn("｜分 2 行（g1:1、g1:2）", text)
        self.j("POST", "/bridge/reply", {"sid": "A", "submission": sub, "items": [
            {"type": "note", "anchor": "g1:1", "text": "这一行"}, {"type": "wavy", "anchor": "g1:9", "text": "没有第 9 行"}]})
        pend = json.loads(self.app._key_file("scratch", self.app.page_key("scratch", 0), ".pending.json").read_text("utf-8"))[-1]
        self.assertEqual(sorted(pend["gx"]["g1:1"]["ids"]), ["a0", "a1", "a2"])
        self.assertLess(pend["groups"]["g1:1"][3], 110)        # 第 1 行的框不到第 2 行
        self.assertEqual(pend["groups"]["g1:9"], pend["groups"]["g1"])  # 行号对不上：当整组
        self.assertIn("g3:1", prompt.protocol())

    def test_sessions_carry_last_typed_hint(self):
        """同一个文件夹开着几个对话时，平板靠「最后打的一句话」认：插件打字时报来开头，重新登记不清掉，只在内存里。"""
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "idea", "cwd": "E:\\idea"})
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\idea"})
        self.j("POST", "/bridge/active", {"sid": "A", "hint": "那么现在我已经有问题了，\n 如果有多个对话打开" + "长" * 60})
        self.j("POST", "/bridge/active", {"sid": "B"})  # 斜杠命令之类不带 hint：不改原来的
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "idea", "cwd": "E:\\idea"})
        hints = {s["sid"]: s["hint"] for s in self.j("GET", "/api/sessions")[1]["sessions"]}
        self.assertEqual(hints["A"], ("那么现在我已经有问题了， 如果有多个对话打开" + "长" * 60)[:40])
        self.assertIsNone(hints["B"])
        self.assertNotIn("那么现在", (self.app.data / "bridge_state.json").read_text("utf-8") if (self.app.data / "bridge_state.json").exists() else "")

    def test_sessions_report_start_hint_and_ink(self):
        """「这本发往」的列表认对话用的几样（2026-11-14）：插件登记时报对话什么时候开的、对话记录里最后一句打的话、
        执行过 /ink 没有；拿不到的不报，服务也不另编；重新登记时没报的沿用原来的；/ink here 指定过的那个也算执行过 /ink。"""
        t0 = 1_794_700_000_000
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "idea", "cwd": "E:\\idea", "started": t0, "hint": "  先看看\n 菜单 ", "ink": True})
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\idea"})                    # 旧插件：什么都不报
        self.j("POST", "/bridge/hello", {"sid": "C", "label": "x", "cwd": "E:\\x", "started": 0, "ink": "yes"})  # 0 和不是 true 的都不算
        ss = {s["sid"]: s for s in self.j("GET", "/api/sessions")[1]["sessions"]}
        self.assertEqual((ss["A"]["started"], ss["A"]["hint"], ss["A"]["ink"]), (t0, "先看看 菜单", True))
        self.assertEqual((ss["B"]["started"], ss["B"]["hint"], ss["B"]["ink"]), (None, None, False))
        self.assertEqual((ss["C"]["started"], ss["C"]["ink"]), (None, False))
        self.assertEqual(ss["A"]["cwd"], "E:\\idea")
        # 重新登记（服务没重启，插件被重新加载过：ink 没报）：开始时刻、那句话、执行过 /ink 都留着；打字时报来的新的一句换上
        self.j("POST", "/bridge/active", {"sid": "A", "hint": "换一条路线试试"})
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "idea", "cwd": "E:\\idea"})
        a = next(s for s in self.j("GET", "/api/sessions")[1]["sessions"] if s["sid"] == "A")
        self.assertEqual((a["started"], a["hint"], a["ink"]), (t0, "换一条路线试试", True))
        # /ink here（claim）指定的那个：列表里也标执行过 /ink
        self.j("POST", "/bridge/claim", {"sid": "B"})
        self.assertTrue(next(s for s in self.j("GET", "/api/sessions")[1]["sessions"] if s["sid"] == "B")["ink"])

    def test_new_pages_counted_per_conversation(self):
        """「只发新写的」按对话算：A 看过的页，换到 B 时还算新写的。"""
        self.j("POST", "/bridge/hello", {"sid": "A", "label": "MY_PAPER", "cwd": "E:\\a"})
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\b"})
        self.app.bridge.tablet_seen = 0
        t = 1_700_000_000_000
        self.j("POST", "/api/notebook/addpage?nb=scratch", b"")
        self.put_page(0, [stroke("a", t, 100, 100)])
        self.put_page(1, [stroke("b", t, 100, 100)])
        self.j("POST", "/api/notebook/target", {"nb": "scratch", "sid": "A"})
        self.assertEqual(self.j("GET", "/api/new-pages?nb=scratch")[1]["pages"], [0, 1])
        self.assertEqual(self.j("POST", "/api/send-all", {"nb": "scratch", "only_new": True})[1]["pages"], 2)
        self.assertEqual(self.j("GET", "/api/new-pages?nb=scratch")[1]["pages"], [])            # A 都看过了
        self.j("POST", "/api/notebook/target", {"nb": "scratch", "sid": "B"})
        self.assertEqual(self.j("GET", "/api/new-pages?nb=scratch")[1]["pages"], [0, 1])        # B 还没看过
        self.assertEqual(self.j("POST", "/api/send-all", {"nb": "scratch", "only_new": True})[1]["pages"], 2)
        self.assertEqual(self.j("POST", "/api/send-all", {"nb": "scratch", "only_new": True})[0], 400)  # B 也看过了

    def test_send_new_pages_with_roles_and_verdicts(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        self.app.bridge.tablet_seen = 0
        t = 1_700_000_000_000
        for _ in range(2):
            self.j("POST", "/api/notebook/addpage?nb=scratch", b"")
        self.assertEqual(self.j("GET", "/api/new-pages?nb=scratch")[1]["pages"], [])
        ai = [answer_item("w1", 1, [185, 100], text="I 引言\nII 分析", q="提纲", on=["a"], t=t + 1000),
              {"id": "s9", "type": "suggest", "t": t + 2000, "text": "改为：II 行程安排", "box": [48, 560, 300, 590], "verdict": "yes",
               "lay": {"x": 1044, "y": 560, "w": 336, "h": 37, "lines": ["改为"], "fs": 21, "lh": 29},
               "paths": [{"d": "M48 560 L300 560", "cls": "sbox"}], "hit": [1038, 556, 1380, 601]},
              {"id": "s8", "type": "suggest", "t": t + 2000, "text": "删去", "box": [48, 100, 200, 140], "verdict": "no",
               "lay": {"x": 1044, "y": 100, "w": 336, "h": 37, "lines": ["删去"], "fs": 21, "lh": 29}, "paths": [], "hit": [1038, 96, 1380, 141]}]
        self.put_page(0, [stroke("a", t, 100, 100, red=True)], ai=ai)
        self.put_page(2, [stroke("c", t, 200, 300)])
        self.assertEqual(self.j("GET", "/api/new-pages?nb=scratch")[1]["pages"], [0, 2])
        events0 = self.app.bridge.seq
        st, res = self.j("POST", "/api/send-all", {"nb": "scratch", "target": "B", "only_new": True})
        self.assertEqual((st, res["pages"]), (200, 2))
        sub = self.j("GET", "/bridge/poll?sid=B")[1]["submission"]
        text = sub["text"]
        self.assertIn("这次：这一页是空白纸，上面是我写的内容。", text)
        self.assertIn("- s1（在我写的内容上）「改为：II 行程安排」：采纳", text)
        self.assertIn("- s2（在我写的内容上）「删去」：不采纳", text)
        self.assertIn("你之前在这一页写过的长回答（图里的蓝色圈号）：\n- 圈号 1（问：提纲）：I 引言 II 分析", text)
        for gone in ("改写", "revises", "整段回答"):
            self.assertNotIn(gone, text)
        meta = self.app.load_submission(sub["id"])
        self.assertNotIn("fu", meta["pages"]["1"])
        self.assertEqual(self.app.locate("B", sub["id"], 1)["vx"], {"s1": "s9", "s2": "s8"})
        saved = json.loads(self.app.load_page("scratch", 0))
        self.assertEqual([a.get("sent") for a in saved["ai"] if a["type"] == "suggest"], [None, None])  # 页面文件不直接改
        self.assertEqual(self.app.pending_vsent("scratch", "p0000"), {"s9", "s8"})                    # 排进待处理，平板打开时合进去
        st, again = self.j("POST", "/api/send-all", {"nb": "scratch", "target": "B", "only_new": False})
        self.assertEqual(st, 200)
        sub2 = self.j("GET", "/bridge/poll?sid=B")[1]["submission"]
        self.assertNotIn("修改建议的决定", sub2["text"])                                             # 发过了，不再发
        ev = [e for e in self.app.bridge.events if e["seq"] > events0 and e["type"] == "vsent"]
        self.assertEqual(ev[0]["pages"], {"0": ["s9", "s8"]})
        self.assertEqual(self.j("GET", "/api/new-pages?nb=scratch")[1]["pages"], [])  # 都看过了
        # 第 3 页没写新字，只点了一条 ✓：也算有新东西的页，「只发新写的」带上它和这条决定（平时的页面没有「发送决定」按钮）
        s7 = {"id": "s7", "type": "suggest", "t": t + 9000, "text": "改为：平均速度", "box": [180, 290, 420, 320], "verdict": "yes",
              "lay": {"x": 1044, "y": 290, "w": 336, "h": 37, "lines": ["改为"], "fs": 21, "lh": 29}, "paths": [], "hit": [1038, 286, 1380, 331]}
        self.put_page(2, [stroke("c", t, 200, 300)], ai=[s7])
        self.assertEqual(self.j("GET", "/api/new-pages?nb=scratch")[1]["pages"], [2])
        st, res = self.j("POST", "/api/send-all", {"nb": "scratch", "target": "B", "only_new": True})
        self.assertEqual((st, res["pages"]), (200, 1))
        self.assertIn("「改为：平均速度」：采纳", self.j("GET", "/bridge/poll?sid=B")[1]["submission"]["text"])
        self.assertEqual(self.j("GET", "/api/new-pages?nb=scratch")[1]["pages"], [])  # 决定发过了，不再算

    def test_card_marks_go_with_the_page_and_replies_join_the_card(self):
        """长回答卡片上的红字（2026-11-14）：交这一页时，带着没交的红字的卡片各画一张图，消息里说明，回给平板交了哪几笔；
        Claude 用带 card 的 write 回：排进待处理（平板接在那张卡片下面），圈号不对、没有、擦掉了都报错、一条都不写；
        快照不带卡片；红字被回应过以后再交这一页不再带。"""
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        t = 1_700_000_000_000
        self.put_page(0, [stroke("r1", t, 100, 100, red=True)], ai=[card_answer(marks=[card_mark("k1"), card_mark("k0", erased=t)]), card_answer("w2", 2)])
        st, sent = self.j("POST", "/api/send", send_payload(target="B"))
        self.assertEqual((st, sent["cards"]), (200, {"w1": ["k1"]}))                      # 擦掉的那笔不交；没红字的卡片不交
        meta = self.app.load_submission(sent["id"])
        img = Path(meta["cards"][0]["img"])
        self.assertEqual((meta["cards"][0]["n"], img.name, img.parent.name), (1, "card-1.png", sent["id"]))
        self.assertTrue(img.is_file())
        text = self.j("GET", "/bridge/poll?sid=B")[1]["submission"]["text"]
        self.assertIn(f"- 圈号 1 的卡片：{img}（蓝字是你之前的回答，红字是我在卡片上写的）", text)
        self.assertIn(f"圈号 1 的卡片上我用红笔写了批注，见图 {img}：蓝字是你之前的回答，红字是我写的。", text)
        # 带 card 的回应：排进待处理，记着那张卡片的 id
        st, rep = self.j("POST", "/bridge/reply", {"sid": "B", "submission": sent["id"], "items": [
            {"type": "write", "card": 1, "q": "这句不对吧", "text": "接着回：应当是成正比。"}, {"type": "write", "text": "普通的长回答", "anchor": "g1"}]})
        self.assertEqual((st, rep["count"]), (200, 2))
        pend = self.j("GET", "/api/pending?nb=scratch&i=0")[1]
        self.assertEqual(pend[0]["items"][0], {"type": "write", "text": "接着回：应当是成正比。", "q": "这句不对吧", "card": 1, "cid": "w1"})
        self.assertNotIn("card", pend[0]["items"][1])
        self.assertNotIn("cid", pend[0]["items"][1])
        # 填得不对：报错，说清怎么改；一条都不写
        for card, why in ((9, "这一页上没有圈号 9 的长回答"), ("abc", "正整数"), (0, "正整数")):
            st, d = self.j("POST", "/bridge/reply", {"sid": "B", "submission": sent["id"], "items": [{"type": "write", "card": card, "text": "x"}, {"type": "note", "text": "短的"}]})
            self.assertEqual(st, 400, card)
            self.assertIn(why, d["error"])
        self.put_page(0, [stroke("r1", t, 100, 100, red=True)], ai=[card_answer(marks=[card_mark("k1")], erasedAt=t + 5, dismissed=True)])
        st, d = self.j("POST", "/bridge/reply", {"sid": "B", "submission": sent["id"], "items": [{"type": "write", "card": 1, "text": "x"}]})
        self.assertEqual(st, 400)
        self.assertIn("圈号 1 的长回答已经被用户擦掉了", d["error"])
        self.assertEqual(len(self.j("GET", "/api/pending?nb=scratch&i=0")[1]), 0)        # 取过一次之后，报错的那几次一条都没排进去
        # 快照不带卡片（Claude 看一眼，不算交）
        self.put_page(0, [stroke("r1", t, 100, 100, red=True)], ai=[card_answer(marks=[card_mark("k1")])])
        sub_id, _ = self.app.save_submission(send_payload(target="B"), snapshot=True)
        self.assertNotIn("cards", self.app.load_submission(sub_id))
        # 回应过的红字不再交；平板发来的 cards 不认
        answered = card_answer(marks=[card_mark("k1", req=sent["id"])], more=[{"id": "m1", "t": 2, "req": sent["id"], "q": "这句", "text": "接着回", "on": ["k1"]}])
        self.put_page(0, [stroke("r1", t, 100, 100, red=True)], ai=[answered])
        st, again = self.j("POST", "/api/send", dict(send_payload(target="B"), cards=[{"n": 1, "img": "E:\\fake.png"}]))
        self.assertEqual((st, again["cards"]), (200, {}))
        text = self.j("GET", "/bridge/poll?sid=B")[1]["submission"]["text"]
        self.assertNotIn("卡片上的红字", text)
        self.assertNotIn("fake.png", text)

    def test_only_card_marks_count_as_new_and_go_with_send_all(self):
        """纸上没写新字、只在长回答的卡片上写了红字的页：算有新东西，几页一起交时带上它（卡片画成图，整本消息里说明带 page）；
        交过的红字排进那一页的待处理（不直接改页面文件）、告诉平板，之后不再算新的。"""
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        self.app.bridge.tablet_seen = 0
        t = 1_700_000_000_000
        self.j("POST", "/api/notebook/addpage?nb=scratch", b"")
        self.put_page(0, [stroke("r1", t, 100, 100, red=True)], ai=[card_answer()])
        self.put_page(1, [stroke("b1", t, 100, 100)])
        self.assertEqual(self.j("POST", "/api/send-all", {"nb": "scratch", "target": "B", "only_new": True})[1]["pages"], 2)
        self.j("GET", "/bridge/poll?sid=B")
        self.assertEqual(self.j("GET", "/api/new-pages?nb=scratch")[1]["pages"], [])         # 都看过了
        self.put_page(0, [stroke("r1", t, 100, 100, red=True)], ai=[card_answer(marks=[card_mark("k1")])])
        self.assertEqual(self.j("GET", "/api/new-pages?nb=scratch")[1]["pages"], [0])        # 只在卡片上写了红字：也算新
        events0 = self.app.bridge.seq
        st, res = self.j("POST", "/api/send-all", {"nb": "scratch", "target": "B", "only_new": True})
        self.assertEqual((st, res["pages"]), (200, 1))
        sub = self.j("GET", "/bridge/poll?sid=B")[1]["submission"]
        img = self.app.data / "submissions" / sub["id"] / "p001-card-1.png"
        self.assertTrue(img.is_file())
        self.assertIn(f"圈号 1 的卡片上我用红笔写了批注，见图 {img}：蓝字是你之前的回答，红字是我写的。回应用 ink_reply 的 write，card 填 1（再带上 page=1）", sub["text"])
        self.assertEqual(self.app.pending_msent("scratch", "p0000"), {"k1"})
        self.assertNotIn("req", json.loads(self.app.load_page("scratch", 0))["ai"][0]["marks"][0])   # 页面文件不直接改
        ev = [e for e in self.app.bridge.events if e["seq"] > events0 and e["type"] == "msent"]
        self.assertEqual((ev[0]["pages"], ev[0]["req"]), ({"0": {"w1": ["k1"]}}, sub["id"]))
        self.assertEqual(self.j("GET", "/api/new-pages?nb=scratch")[1]["pages"], [])         # 排进去了：不再算新的
        pend = self.j("GET", "/api/pending?nb=scratch&i=0")[1]
        self.assertEqual(pend[-1]["msent"], {"w1": ["k1"]})
        # 回应过以后整本检测不再带这张卡片；回应可以按整本消息的页码写回
        st, rep = self.j("POST", "/bridge/reply", {"sid": "B", "submission": sub["id"], "page": 1, "items": [{"type": "write", "card": 1, "text": "接着回"}]})
        self.assertEqual(st, 200)
        self.put_page(0, [stroke("r1", t, 100, 100, red=True)], ai=[card_answer(marks=[card_mark("k1", req=sub["id"])],
                                                                              more=[{"id": "m1", "t": 2, "req": sub["id"], "text": "接着回", "on": ["k1"]}])])
        _, text, _ = self.app.scan("scratch", target="B")
        self.assertNotIn("卡片上的红字", text)
        self.assertIn("\n  - 接着：接着回", text)                                            # 之前写过的长回答带上接着的那一段

    def test_devices_pair_revoke_and_stop(self):
        def req(method, path, body=None, headers=None):
            data = json.dumps(body).encode() if body is not None else None
            r = urllib.request.Request(self.base + path, data=data, method=method)
            for k, v in (headers or {}).items():
                r.add_header(k, v)
            if data is not None:
                r.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(r, timeout=30) as x:
                    return x.status, json.loads(x.read() or b"null")
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read() or b"null")

        st, d = req("POST", "/api/pair", {"name": "iPad"}, {"X-Access": self.app.code})
        self.assertEqual(st, 200)
        token = d["token"]
        self.assertEqual(req("GET", "/api/notebooks", headers={"X-Device": token})[0], 200)       # 配对后用令牌
        self.assertEqual(req("GET", "/api/notebooks", headers={"X-Device": "bogus"})[0], 401)
        self.assertEqual(req("POST", "/api/pair", {"name": "x"})[0], 401)                          # 配对要访问码
        devs = self.j("GET", "/bridge/devices")[1]["devices"]
        self.assertEqual([(x["name"], x["ip"]) for x in devs], [("iPad", "127.0.0.1")])
        self.assertNotIn(token, (Path(self.tmp.name) / "data" / "devices.json").read_text("utf-8"))  # 只存哈希
        old = self.app.code
        self.assertEqual(self.j("POST", "/bridge/devices/revoke", {"id": devs[0]["id"]})[0], 200)
        self.assertNotEqual(self.app.code, old)                                                    # 断开时一起换访问码
        self.assertEqual(req("GET", "/api/notebooks", headers={"X-Device": token})[0], 401)
        self.assertEqual(req("GET", "/api/notebooks", headers={"X-Access": old})[0], 401)          # 记着旧地址也进不来
        self.assertEqual(req("GET", "/api/notebooks", headers={"X-Access": self.app.code})[0], 200)
        self.assertEqual((Path(self.tmp.name) / "data" / "access_code.txt").read_text("utf-8"), self.app.code)
        self.assertEqual(self.j("POST", "/bridge/stop", {})[0], 200)
        self.assertTrue((Path(self.tmp.name) / "data" / "stopped.flag").exists())                 # 插件据此不自动重启

    def test_local_only_notebook_is_never_sent(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        self.app.bridge.tablet_seen = 0
        t = 1_700_000_000_000
        self.put_page(0, [stroke("a", t, 100, 100, red=True)])
        st, _ = self.j("POST", "/api/notebook/setting", {"nb": "scratch", "key": "local", "value": True})
        self.assertEqual(st, 200)
        self.assertTrue(self.j("GET", "/api/notebook?nb=scratch")[1]["local"])
        self.assertTrue(next(n for n in self.app.notebooks() if n["id"] == "scratch")["local"])
        self.assertEqual(self.j("GET", "/api/new-pages?nb=scratch")[1]["pages"], [])        # 不问要不要一起发
        st, res = self.j("POST", "/api/send-all", {"nb": "scratch", "target": "B", "only_new": False})
        self.assertEqual(st, 400)
        self.assertIn("只在本地", res["error"])
        # 2026-11-14 抽屉里那把锁去掉了，只在本地并进「这本发往」：提示照实说去哪里改
        self.assertIn("「这本发往」选一个对话", res["error"])
        self.assertNotIn("锁", res["error"])
        with self.assertRaises(ValueError):
            self.app.scan("scratch")                                                    # Claude 用 ink_scan 取也不行
        self.assertIsNone(self.j("GET", "/bridge/poll?sid=B")[1].get("submission"))
        self.app.bridge.where = {"nb": "scratch", "page": 0}                            # Claude 往上写批注也不行
        st, res = self.j("POST", "/bridge/reply", {"sid": "B", "items": [{"type": "note", "text": "试写", "box": [0, 0, 50, 20]}]})
        self.assertEqual(st, 400)
        self.assertIn("只在本地", res["error"])
        self.assertIn("「这本发往」选一个对话", res["error"])
        self.assertNotIn("锁", res["error"])
        self.assertEqual(self.j("GET", "/api/pending?nb=scratch&i=0")[1], [])
        self.j("POST", "/api/notebook/setting", {"nb": "scratch", "key": "local", "value": False})
        self.assertEqual(self.j("GET", "/api/new-pages?nb=scratch")[1]["pages"], [0])       # 取消后照常

    def test_scan_whole_notebook(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        self.app.bridge.tablet_seen = 0  # 平板不在线：不用等它存盘
        t = 1_700_000_000_000
        for _ in range(2):
            self.j("POST", "/api/notebook/addpage?nb=scratch", b"")
        self.put_page(0, [stroke("a", t, 100, 100), stroke("b", t + 500, 130, 100)])
        self.put_page(2, [stroke("c", t, 200, 300, red=True)])
        st, scan = self.j("POST", "/bridge/scan", {"sid": "B", "nb": "scratch"})
        self.assertEqual((st, scan["pages"]), (200, 2))
        text = scan["text"]
        self.assertTrue(text.startswith("【草稿纸·整本】"))
        self.assertIn("── 第 1 页", text)
        self.assertIn("── 第 3 页", text)
        self.assertNotIn("── 第 2 页", text)
        self.assertIn("红笔（问题）", text)
        self.assertIn("这一页你第一次看", text)
        for line in text.splitlines():
            if line.startswith("图："):
                self.assertTrue(Path(line[2:].split("（")[0]).is_file())
        # 写回到第 3 页；整本检测里不说页码就不知道写哪页
        st, rep = self.j("POST", "/bridge/reply", {"sid": "B", "submission": scan["id"], "page": 3,
                                                   "items": [{"type": "note", "anchor": "g1", "text": "问得好"}]})
        self.assertEqual(st, 200)
        pend = self.j("GET", "/api/pending?nb=scratch&i=2")[1]
        self.assertIn("g1", pend[0]["groups"])
        self.assertEqual(pend[0]["gx"]["g1"], {"ids": ["c"], "red": True, "sel": True})  # 平板据此记住批注指着哪几笔
        self.assertEqual(self.j("POST", "/bridge/reply", {"sid": "B", "submission": scan["id"],
                                                          "items": [{"type": "circle", "anchor": "g1"}]})[0], 400)
        # 看过之后：只要新笔迹 → 没有；第 1 页再写一组 → 只交第 1 页，只有新的那组标 ★
        self.assertEqual(self.j("POST", "/bridge/scan", {"sid": "B", "only_new": True})[1]["pages"], 0)
        self.put_page(0, [stroke("a", t, 100, 100), stroke("b", t + 500, 130, 100), stroke("d", t + 90000, 500, 600)])
        st, scan2 = self.j("POST", "/bridge/scan", {"sid": "B", "only_new": True})
        self.assertEqual(scan2["pages"], 1)
        self.assertIn("★ g2", scan2["text"])
        self.assertNotIn("★ g1", scan2["text"])
        self.assertIn("另有 1 页没有新笔迹", scan2["text"])
        # 按名字找本子
        self.assertEqual(self.j("POST", "/bridge/scan", {"sid": "B", "nb": "草稿本", "pages": [2]})[1]["pages"], 1)
        self.assertEqual(self.j("POST", "/bridge/scan", {"sid": "B", "nb": "没有这本"})[0], 404)
        # 单页放大一段
        st, zoom = self.j("POST", "/bridge/scan", {"sid": "B", "pages": [1], "region": [500, 700]})
        self.assertIn("只截了 y 500–700", zoom["text"])
        # 平板「整本发给 Claude」
        st, sent = self.j("POST", "/api/send-all", {"nb": "scratch", "target": "B"})
        self.assertEqual((st, sent["pages"]), (200, 2))
        sub = self.j("GET", "/bridge/poll?sid=B")[1]["submission"]
        self.assertTrue(sub["text"].startswith("【草稿纸·整本】我把《草稿本》里写过字的页一起发给你（共 2 页）。"))
        self.assertNotIn("改东西只按这一条规则", sub["text"])  # 固定说明在系统提示里，整本消息里也不附
        self.assertEqual(self.j("POST", "/api/send-all", {"nb": "scratch", "target": "B", "only_new": True})[0], 400)

    def test_confirm_card(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        self.app.bridge.tablet_seen = 0
        t = 1_700_000_000_000
        self.put_page(0, [stroke("a", t, 100, 100)])
        scan = self.j("POST", "/bridge/scan", {"sid": "B"})[1]
        st, c = self.j("POST", "/bridge/confirm", {"sid": "B", "submission": scan["id"], "questions": [
            {"anchor": "g1", "guess": "α", "options": ["a", "α"], "question": "这是 α 还是 a？"}, {"question": "第二处"}]})
        self.assertEqual(st, 200)
        cards = self.j("GET", "/api/confirms")[1]
        self.assertEqual(cards[0]["questions"][0]["options"], ["a", "α"])
        self.assertTrue(cards[0]["questions"][0]["img"])
        self.assertFalse(cards[0]["questions"][1]["img"])
        self.assertEqual(self.call("GET", f"/api/confirm-img?id={c['id']}&k=0")[1], "image/png")

        def tablet():
            time.sleep(0.3)
            self.j("POST", "/api/confirm-answer", {"id": c["id"], "answers": [{"text": "a"}, {}]})

        th = threading.Thread(target=tablet)
        th.start()
        st, ans = self.j("POST", "/bridge/confirm-wait", {"id": c["id"], "wait": 5})
        th.join()
        self.assertIn("g1：这是 α 还是 a？（你读成「α」） → 是「a」", ans["text"])
        self.assertIn("跳过", ans["text"])
        self.assertEqual(self.j("GET", "/api/confirms")[1], [])
        self.assertEqual(self.j("POST", "/api/confirm-answer", {"id": c["id"], "answers": []})[0], 404)
        # Claude 不等了 → 用户之后的回答作为新消息送进对话
        c2 = self.j("POST", "/bridge/confirm", {"sid": "B", "questions": [{"anchor": "g1", "guess": "x"}]})[1]
        self.assertTrue(self.j("POST", "/bridge/confirm-wait", {"id": c2["id"], "wait": 0.2, "last": True})[1]["pending"])
        self.j("POST", "/api/confirm-answer", {"id": c2["id"], "answers": [{"text": "x"}]})
        sub = self.j("GET", "/bridge/poll?sid=B")[1]["submission"]
        self.assertTrue(sub["text"].startswith("【草稿纸·确认】"))
        self.assertIn("对，是「x」", sub["text"])

    def test_confirm_wait_zero_does_not_wait_and_snippet_size_is_given(self):
        """确认卡片：wait 给 0 就是不等（以前被当成没给、白等 25 秒）；截图带像素大小（平板先留好位置）、带问的时刻（和问话卡片排一个队）。"""
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        self.put_page(0, [stroke("a", 1_700_000_000_000, 100, 100)])
        scan = self.j("POST", "/bridge/scan", {"sid": "B"})[1]
        c = self.j("POST", "/bridge/confirm", {"sid": "B", "submission": scan["id"], "questions": [{"anchor": "g1", "guess": "x"}]})[1]
        card = self.j("GET", "/api/confirms")[1][0]
        q = card["questions"][0]
        self.assertTrue(q["iw"] > 100 and q["ih"] > 50, q)
        self.assertEqual((q["iw"], q["ih"]), server.png_size(self.app.bridge.confirms[c["id"]]["questions"][0]["img"]))
        self.assertGreater(card["t"], 0)
        t0 = time.time()
        self.assertTrue(self.j("POST", "/bridge/confirm-wait", {"id": c["id"], "wait": 0, "last": True})[1]["pending"])
        self.assertLess(time.time() - t0, 3)

    # -- 问话卡片（2026-11-14，阶段 C）
    def online(self, sid="B"):
        self.j("POST", "/bridge/hello", {"sid": sid, "label": "idea", "cwd": "E:\\x"})
        self.app.bridge.tablet_seen = time.time()

    def test_ask_card_refuses_bad_requests_and_offline_tablet(self):
        self.online()
        for body in ({"sid": "B"}, {"sid": "B", "question": "问？", "result": "结果"},
                     {"sid": "B", "question": "选哪个？", "options": ["一", "二", "三", "四", "五"]},
                     {"sid": "B", "question": "选哪个？", "handwrite": False}):
            self.assertEqual(self.j("POST", "/bridge/ask", body)[0], 400, body)
        self.assertEqual(self.j("GET", "/api/asks")[1], [])
        # 平板不在线：不发、不排队到以后，马上告诉插件（Claude 改在对话里问）
        self.app.bridge.tablet_seen = 0
        st, r = self.j("POST", "/bridge/ask", {"sid": "B", "question": "覆盖还是另存？", "options": ["覆盖", "另存"]})
        self.assertEqual((st, r), (200, {"offline": True}))
        self.assertEqual(self.j("POST", "/bridge/ask", {"sid": "B", "result": "一大段结果"})[1], {"offline": True})
        self.assertEqual(self.j("GET", "/api/asks")[1], [])

    def test_ask_card_choice_comes_back_while_waiting(self):
        self.online()
        st, r = self.j("POST", "/bridge/ask", {"sid": "B", "question": "改动覆盖原文件，还是另存一份？", "options": ["覆盖", " 另存 ", "另存"]})
        self.assertEqual(st, 200)
        cards = self.j("GET", "/api/asks")[1]
        self.assertEqual(len(cards), 1)
        self.assertEqual({k: cards[0][k] for k in ("id", "kind", "label", "question", "options", "write", "text")},
                         {"id": r["id"], "kind": "question", "label": "idea", "question": "改动覆盖原文件，还是另存一份？",
                          "options": ["覆盖", "另存"], "write": True, "text": ""})  # 选项去掉多余的空白、重复的
        self.assertEqual(self.j("POST", "/api/ask-answer", {"id": r["id"], "choice": "删掉"})[0], 400)  # 卡片上没有的选项

        def tablet():
            time.sleep(0.3)
            self.j("POST", "/api/ask-answer", {"id": r["id"], "choice": "另存"})

        th = threading.Thread(target=tablet)
        th.start()
        t0 = time.time()
        st, ans = self.j("POST", "/bridge/ask-wait", {"id": r["id"], "wait": 5})
        th.join()
        self.assertLess(time.time() - t0, 4)
        self.assertEqual(ans["answer"], {"choice": "另存"})
        self.assertEqual(ans["text"], "我点了「另存」。")
        self.assertEqual(self.j("GET", "/api/asks")[1], [])  # 答过的平板上不留
        self.assertEqual(self.j("POST", "/api/ask-answer", {"id": r["id"], "choice": "覆盖"})[0], 404)
        self.assertEqual(self.j("GET", "/bridge/poll?sid=B")[1], {})  # 等着的时候答的：不另发消息

    def test_ask_card_late_handwritten_answer_becomes_a_message(self):
        self.online()
        r = self.j("POST", "/bridge/ask", {"sid": "B", "question": "这一步的 x 等于几？"})[1]
        # 插件等了几次都没等到，最后一次说「不等了」：卡片留在平板上
        self.assertTrue(self.j("POST", "/bridge/ask-wait", {"id": r["id"], "wait": 0.2})[1]["pending"])
        self.assertTrue(self.j("POST", "/bridge/ask-wait", {"id": r["id"], "wait": 0.2, "last": True})[1]["pending"])
        self.assertEqual([c["id"] for c in self.j("GET", "/api/asks")[1]], [r["id"]])
        self.assertEqual(self.j("POST", "/api/ask-answer", {"id": r["id"], "image": "data:image/png;base64," + base64.b64encode(b"not a png").decode()})[0], 400)
        self.assertEqual(self.j("POST", "/api/ask-answer", {"id": r["id"]})[0], 400)  # 空的回答
        png = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 40, 20), 0).tobytes("png")
        st, _ = self.j("POST", "/api/ask-answer", {"id": r["id"], "image": "data:image/png;base64," + base64.b64encode(png).decode()})
        self.assertEqual(st, 200)
        sub = self.j("GET", "/bridge/poll?sid=B")[1]["submission"]
        self.assertTrue(sub["text"].startswith("【草稿纸·回答】你之前在平板上用问话卡片问我：「这一步的 x 等于几？」。我现在回答了："), sub["text"])
        img = re.search(r"图在 (\S+?\.png)", sub["text"]).group(1)
        self.assertEqual(Path(img).read_bytes(), png)  # 笔迹的图原样交，不转文字
        self.assertTrue(Path(img).resolve().is_relative_to((self.app.data / "submissions").resolve()))  # 插件读这里的图不用问
        self.assertEqual(self.j("GET", "/api/asks")[1], [])
        self.assertEqual(self.j("POST", "/bridge/ask-wait", {"id": r["id"], "wait": 0})[1]["answer"], {"image": img})

    def test_result_card_is_seen_and_gone_without_a_message(self):
        self.online()
        st, r = self.j("POST", "/bridge/ask", {"sid": "B", "result": "第一段\n\n第二段"})
        self.assertEqual(st, 200)
        card = self.j("GET", "/api/asks")[1][0]
        self.assertEqual((card["kind"], card["text"], card["options"], card["write"]), ("result", "第一段\n\n第二段", [], False))
        self.assertEqual(self.j("POST", "/api/ask-answer", {"id": r["id"]})[0], 200)  # 点了「知道了」
        self.assertEqual(self.j("GET", "/api/asks")[1], [])
        self.assertEqual(self.j("GET", "/bridge/poll?sid=B")[1], {})  # 不告诉对话

    def test_offers_of_new_files(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        out = Path(self.tmp.name) / "out"
        out.mkdir()
        fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 200, 100), 0).save(out / "fig.png")
        (out / "清单.md").write_text("# 修改清单\n\n" + "\n".join(f"- 第 {i} 条：" + "很长" * 40 for i in range(80)), "utf-8")
        (out / "x.py").write_text("print(1)", "utf-8")
        files = [{"path": str(out / n)} for n in ("fig.png", "清单.md", "x.py", "missing.png")]
        st, r = self.j("POST", "/bridge/offer", {"sid": "B", "files": files})
        self.assertEqual((st, r["added"]), (200, 2))
        self.assertEqual(self.j("POST", "/bridge/offer", {"sid": "B", "files": files})[1]["added"], 0)  # 同一版本不重复提示
        offers = self.j("GET", "/api/offers")[1]
        self.assertEqual({o["name"] for o in offers}, {"fig.png", "清单.md"})
        self.assertEqual(offers[0]["label"], "idea")
        by = {o["name"]: o["id"] for o in offers}
        st, a = self.j("POST", "/api/offer-accept", {"id": by["fig.png"]})
        self.assertEqual((st, a["nb"], a["page"]), (200, "board", 0))
        st, b = self.j("POST", "/api/offer-accept", {"id": by["清单.md"]})
        self.assertEqual((st, b["nb"]), (200, "book:清单.pdf"))
        self.assertGreaterEqual(self.app.notebook_info(b["nb"])["pages"], 2)
        self.assertEqual(self.j("GET", "/api/offers")[1], [])
        # 草稿纸自己的数据不算新文件
        sub_png = self.app.data / "submissions" / "x.png"
        fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 20, 20), 0).save(sub_png)
        self.assertEqual(self.j("POST", "/bridge/offer", {"sid": "B", "files": [{"path": str(sub_png)}]})[1]["added"], 0)
        (out / "fig2.png").write_bytes((out / "fig.png").read_bytes())
        self.j("POST", "/bridge/offer", {"sid": "B", "files": [{"path": str(out / "fig2.png")}]})
        self.assertEqual(self.j("POST", "/api/offer-dismiss", {"all": True})[0], 200)
        self.assertEqual(self.j("GET", "/api/offers")[1], [])

    def test_page_operations_and_reply_after_insert(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        self.j("POST", "/api/notebook/addpage?nb=scratch", b"")
        st, sent = self.j("POST", "/api/send", dict(send_payload(target="B"), page=1))
        self.assertEqual(st, 200)
        sub = self.j("GET", "/bridge/poll?sid=B")[1]["submission"]
        # 投递之后在最前面插了一页：写回仍落在原来那一页（现在是第 3 页）
        st, ins = self.j("POST", "/api/page/insert", {"nb": "scratch", "after": -1})
        self.assertEqual((st, ins["page"], ins["notebook"]["pages"]), (200, 0, 3))
        st, rep = self.j("POST", "/bridge/reply", {"sid": "B", "submission": sub["id"], "items": [{"type": "note", "anchor": "g2", "text": "好"}]})
        self.assertEqual((st, rep["page"]), (200, "草稿本第 3 页（空白草稿纸）"))
        self.assertEqual(len(self.j("GET", "/api/pending?nb=scratch&i=2")[1]), 1)
        ev = [e for e in self.j("GET", "/api/events?since=0&wait=0")[1]["events"] if e["type"] == "ai"]
        self.assertEqual(ev[-1]["page"], 2)
        # 删页、列出、恢复
        self.assertEqual(self.j("POST", "/api/page/delete", {"nb": "scratch", "i": 2})[1]["notebook"]["pages"], 2)
        hidden = self.j("GET", "/api/page/hidden?nb=scratch")[1]
        self.assertEqual(len(hidden), 1)
        self.assertEqual(self.j("POST", "/bridge/reply", {"sid": "B", "submission": sub["id"], "items": [{"type": "circle", "anchor": "g2"}]})[0], 400)
        st, back = self.j("POST", "/api/page/restore", {"nb": "scratch", "key": hidden[0]["key"]})
        self.assertEqual((st, back["page"]), (200, 2))
        st, ctype, png = self.call("GET", "/api/thumb?nb=scratch&i=2")
        self.assertEqual((st, ctype), (200, "image/png"))

    def test_new_notebook_over_http(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        st, nb = self.j("POST", "/api/notebook/new", {"title": "想法", "paper": "landscape"})
        self.assertEqual((st, nb["kind"], nb["paper"], nb["title"]), (200, "pad", "landscape", "想法"))
        st, sent = self.j("POST", "/api/send", dict(send_payload(target="B"), nb=nb["id"], page=0))
        self.assertEqual(st, 200)
        text = self.j("GET", "/bridge/poll?sid=B")[1]["submission"]["text"]
        self.assertIn("想法第 1 页", text)
        self.assertIn("这次：这一页是空白纸，上面是我写的内容。", text)

    def test_browse_and_import_from_project_folder(self):
        proj = Path(self.tmp.name) / "proj"
        for d in ("sub", ".git", "node_modules"):
            (proj / d).mkdir(parents=True)
        make_slides(proj / "汇报_v1.pdf", ["a", "b"])
        (proj / "notes.md").write_text("# 笔记\n\n- 一\n", "utf-8")
        (proj / "x.py").write_text("print(1)", "utf-8")
        (proj / "~$汇报_v1.pdf").write_bytes(b"lock")
        (proj / "node_modules" / "y.pdf").write_bytes(b"%PDF")
        fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 40, 30), 0).save(proj / "sub" / "fig.png")
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "proj", "cwd": str(proj)})
        st, lst = self.j("GET", "/api/files?sid=B")
        self.assertEqual(st, 200)
        names = [e["name"] for e in lst["entries"]]
        self.assertEqual(names[0], "sub")  # 文件夹在前；.git、node_modules 不列
        self.assertEqual(sorted(names[1:]), ["notes.md", "汇报_v1.pdf"])  # 只列能导入的：x.py、Office 锁文件不列
        self.assertIn("sub/fig.png", [e["path"] for e in lst["recent"]])
        self.assertEqual(self.j("GET", "/api/files?sid=B&path=..")[0], 400)  # 出不了这个文件夹
        self.assertEqual(self.j("GET", "/api/files?sid=nobody")[0], 404)
        # 导入 PDF → 本子；再点一次 → 打开原来那本
        st, a = self.j("POST", "/api/files/import", {"sid": "B", "path": "汇报_v1.pdf"})
        self.assertEqual((st, a["nb"]), (200, "book:汇报_v1.pdf"))
        st, b = self.j("POST", "/api/files/import", {"sid": "B", "path": "汇报_v1.pdf"})
        self.assertEqual((b["nb"], b.get("opened")), ("book:汇报_v1.pdf", True))
        entry = [e for e in self.j("GET", "/api/files?sid=B")[1]["entries"] if e["name"] == "汇报_v1.pdf"][0]
        self.assertEqual((entry["imported"], entry["changed"]), ("汇报_v1", False))
        # 新版本：标出「像是旧本的新版」，可以替换
        time.sleep(1.1)
        make_slides(proj / "汇报_v2.pdf", ["a", "b changed"])
        v2 = [e for e in self.j("GET", "/api/files?sid=B")[1]["entries"] if e["name"] == "汇报_v2.pdf"][0]
        self.assertEqual(v2["replace"], "汇报_v1")
        st, c = self.j("POST", "/api/files/import", {"sid": "B", "path": "汇报_v2.pdf", "mode": "replace"})
        self.assertEqual((st, c["nb"], c["updated"]), (200, "book:汇报_v2.pdf", True))
        # 图片 → 自己成为一本（和从 iPad 上传一样；「Claude 推送」那本只放 Claude 推过来的）；再点一次打开原来那本
        st, d = self.j("POST", "/api/files/import", {"sid": "B", "path": "sub/fig.png"})
        self.assertEqual((st, d["nb"], d["page"]), (200, "book:fig.pdf", 0))
        self.assertEqual(self.app.notebook_info("book:fig.pdf")["pages"], 1)
        self.assertEqual(self.app.board_index()["pages"], [])
        self.assertEqual(self.j("POST", "/api/files/import", {"sid": "B", "path": "sub/fig.png"})[1].get("opened"), True)
        self.assertEqual(self.j("POST", "/api/files/import", {"sid": "B", "path": "x.py"})[0], 400)

    def test_bridge_is_local_only(self):
        handler = server.Handler.__new__(server.Handler)
        handler.client_address = ("192.0.2.20", 5000)  # 局域网里的别的设备（192.0.2.x 是专给示例用的地址段）
        self.assertFalse(handler.is_local)
        handler.client_address = ("127.0.0.1", 5000)
        self.assertTrue(handler.is_local)


def _note(nid, text, y, **kw):
    """一条页边批注（带排版）。"""
    return dict({"id": nid, "type": "note", "text": text, "box": [100, 190, 300, 214],
                 "paths": [{"d": f"M100 {y} L400 {y}", "w": 3}],
                 "lay": {"x": 1010, "y": y, "w": 300, "h": 30, "lines": [text], "fs": 20, "lh": 26}}, **kw)


class PaperExportTest(unittest.TestCase):
    """原稿与往来稿（2026-11-08 用户提出）：原稿只有我写的（黑字、红字），往来稿再加 Claude 的蓝字；
    横划掉的蓝字在往来稿里画淡，橡皮擦掉的不画；导出到 paper_dir/<本子名>/，存页后停笔一会儿就出。"""

    PAGE = {"strokes": [stroke("k1", 1, 100, 200), stroke("r1", 2, 100, 400, red=True)], "ai": [
        _note("n1", "留着的", 300),
        _note("n2", "划掉的", 500, dismissed=True),
        _note("n3", "擦掉的", 700, dismissed=True, erasedAt=1)]}

    def _pdf(self, path):
        doc = fitz.open(str(path))
        text = "".join(p.get_text() for p in doc)
        colors = [tuple(d["color"]) for p in doc for d in p.get_drawings() if d.get("color")]
        n = len(doc)
        doc.close()
        return n, text, colors

    @staticmethod
    def _has(colors, c):  # 线条颜色里有没有这一种（容一点舍入）
        return any(all(abs(a - b) < 0.02 for a, b in zip(x, c)) for x in colors)

    def test_original_has_only_my_ink(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "原稿.pdf"
            self.assertEqual(pages.export_pdf([(self.PAGE, 1414, None)], out, ai=False), 1)
            n, text, colors = self._pdf(out)
        self.assertEqual(n, 1)
        for t in ("留着的", "划掉的", "擦掉的"):
            self.assertNotIn(t, text)                                   # 原稿里没有蓝字
        self.assertTrue(self._has(colors, pages.INK))                   # 黑字
        self.assertTrue(self._has(colors, pages.RED))                   # 红字也是原稿
        self.assertFalse(self._has(colors, pages.AI))                   # 蓝线没有

    def test_dialog_adds_claude_struck_faded_erased_gone(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "往来.pdf"
            pages.export_pdf([(self.PAGE, 1414, None)], out, ai=True)
            n, text, colors = self._pdf(out)
            size = out.stat().st_size
            plain = pix_at(self.PAGE, tmp, 250, 300)                    # 发给 Claude 的图：照旧不画划掉的
            struck_in_png = pix_at(self.PAGE, tmp, 250, 500)
        self.assertIn("留着的", text)
        self.assertIn("划掉的", text)                                    # 横划掉的：往来稿里画（淡）
        self.assertNotIn("擦掉的", text)                                  # 橡皮擦掉的：不画
        self.assertTrue(self._has(colors, pages.AI))
        self.assertGreater(sum(struck_in_png), sum(plain) + 200)          # 出图（PNG）的老规矩不变：划掉的不画
        self.assertLess(size, 1_000_000)                                  # 楷体只嵌用到的字，不是整个 7 MB

    def test_dialog_adds_answer_pages_after_the_page(self):
        """往来稿：纸面照平板上画（长回答只有圈号）；这一页有长回答时紧跟着加一页「第 N 页的回答」，按圈号列出问和全文，
        自动换行，一页放不下就再加页；原稿不变。"""
        long = "\n".join(f"第{k}段：" + "直角三角形两直角边的平方和等于斜边" * 4 for k in range(40))
        page = {"strokes": [stroke("r1", 1, 100, 200, red=True)], "ai": [
            answer_item("w2", 2, [300, 400], text=long, q="为什么线性？"),
            answer_item("w1", 1, [229, 200], text="短的回答 A long English sentence that should wrap nicely across lines.", q="是什么？",
                        older=[{"text": "以前的说法", "t": 1}]),
            answer_item("w3", 3, [300, 600], text="擦掉的回答", erasedAt=5, dismissed=True)]}
        plain = {"strokes": [stroke("k1", 1, 100, 200)], "ai": [_note("n1", "批注", 300)]}
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "往来.pdf"
            self.assertEqual(pages.export_pdf([(plain, 1414, None, 1), (page, 1414, None, 4)], out, ai=True), 2)
            with fitz.open(str(out)) as doc:
                texts = [p.get_text() for p in doc]
                sizes = [(round(p.rect.width), round(p.rect.height)) for p in doc]
                lines = [ln for p in doc for ln in p.get_text().splitlines()]
            orig = Path(tmp) / "原稿.pdf"
            pages.export_pdf([(plain, 1414, None, 1), (page, 1414, None, 4)], orig, ai=False)
            with fitz.open(str(orig)) as doc:
                self.assertEqual(len(doc), 2)                                         # 原稿不加回答页
        self.assertGreaterEqual(len(texts), 4)                                        # 两页纸 + 至少两页回答（长的一页放不下）
        self.assertNotIn("回答", texts[0])                                             # 第 1 页没有长回答：后面不加
        self.assertNotIn("短的回答", texts[1])                                         # 纸面上只有圈号，没有回答文字
        self.assertTrue(texts[2].startswith("第 4 页的回答"), texts[2][:30])
        self.assertTrue(texts[3].startswith("第 4 页的回答（续）"), texts[3][:30])
        body = "".join(texts[2:])
        self.assertLess(body.index("圈号 1"), body.index("圈号 2"))                     # 按圈号排
        for must in ("问：是什么？", "问：为什么线性？", "之前的版本", "以前的说法", "第39段"):
            self.assertIn(must, body)
        self.assertNotIn("擦掉的回答", body)
        self.assertTrue(all(w == sizes[2][0] for w, _ in sizes[2:]))
        widest = max(fitz.Font(fontfile=pages.NOTE_FONT).text_length(ln, 20) for ln in lines if "斜边" in ln) if pages.NOTE_FONT else 0
        self.assertLess(widest, sizes[2][0] - 2 * 70 + 25)                             # 自动换行：不出页面右边

    def test_app_exports_after_save_and_on_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            paper = Path(tmp) / "纸"
            (Path(tmp) / "none.json").write_text(json.dumps({"paper_dir": str(paper), "paper_delay": 0.05}), "utf-8")
            app = make_app(tmp)
            nb = app.new_pad("推导 1/2")
            app.save_page(nb, 0, json.dumps({"v": 1, "strokes": [stroke("k1", 1, 100, 200)], "ai": [_note("n1", "批注", 300)]}))
            d = paper / "推导 1_2"                                        # 名字里不能放进路径的字换成 _
            for _ in range(60):
                if (d / "往来.pdf").exists() and (d / "原稿.pdf").exists():
                    break
                time.sleep(0.1)
            self.assertTrue((d / "原稿.pdf").exists() and (d / "往来.pdf").exists())
            self.assertIn("批注", self._pdf(d / "往来.pdf")[1])
            self.assertNotIn("批注", self._pdf(d / "原稿.pdf")[1])
            # 空白的本子不出文件
            self.assertIsNone(app.export_paper(app.new_pad("空的")))
            self.assertFalse((paper / "空的").exists())
            # 服务启动时：比文件新的本子补导
            (d / "往来.pdf").unlink()
            (d / "原稿.pdf").unlink()
            app.export_stale_papers()
            self.assertTrue((d / "原稿.pdf").exists() and (d / "往来.pdf").exists())

    def test_same_title_notebooks_get_own_folders(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "none.json").write_text(json.dumps({"paper_dir": str(Path(tmp) / "纸"), "paper_delay": 60}), "utf-8")
            app = make_app(tmp)
            a, b = app.new_pad("纸（试用）"), app.new_pad("纸（试用）")
            only = app.new_pad("只有一本")
            self.assertNotEqual(app.paper_folder(a), app.paper_folder(b))         # 同名的两本不互相盖掉
            self.assertTrue(app.paper_folder(a).name.startswith("纸（试用）（"))
            self.assertEqual(app.paper_folder(only).name, "只有一本")              # 不同名的照旧就是名字
            for nb in (a, b):
                app.save_page(nb, 0, json.dumps({"v": 1, "strokes": [stroke("k1", 1, 100, 200)], "ai": []}))
                self.assertIsNotNone(app.export_paper(nb))
            self.assertEqual(len(list((Path(tmp) / "纸").glob("*/原稿.pdf"))), 2)
            for t in list(app._paper_timers.values()):  # 存页排下的导出不等它了（临时目录马上要删）
                t.cancel()

    def test_no_paper_dir_no_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)                                             # 测试和没配置的：不导出
            self.assertIsNone(app.paper_dir)
            nb = app.new_pad("不导出")
            app.save_page(nb, 0, json.dumps({"v": 1, "strokes": [stroke("k1", 1, 100, 200)], "ai": []}))
            self.assertIsNone(app.export_paper(nb))
            self.assertFalse(any(Path(tmp).rglob("原稿.pdf")))


def card_mark(mid, blk="a", y=56, req=None, erased=None, x0=20):
    """长回答卡片上的一笔红字（坐标相对它那一块的左上角，卡片的固定宽度 440 下的单位）：一条横线。"""
    m = {"id": mid, "blk": blk, "pts": [[x0 + 10 * k, y, 0.5, 20 * k] for k in range(15)], "t0": 1_700_000_000_000, "w": 2.1, "c": "r"}
    if req:
        m["req"] = req
    if erased:
        m["erasedAt"] = erased
    return m


CARD_SHEET = {"w": 440, "h": 200, "t": 1, "blocks": [  # 平板量下的排版快照（编的）
    {"id": "a", "y": 12, "h": 100, "rows": [
        {"x": 16, "y": 0, "w": 160, "h": 18, "fs": 18, "t": "问：为什么是线性的？", "k": "q"},
        {"x": 16, "y": 30, "w": 300, "h": 20, "fs": 20, "t": "先说结论：总价和重量成正比。", "k": ""},
        {"x": 16, "y": 62, "w": 120, "h": 30, "tex": "y = k x"}]},
    {"id": "o0", "y": 130, "h": 40, "rows": [{"x": 16, "y": 8, "w": 200, "h": 20, "fs": 20, "t": "旧的说法：和店家有关。", "k": "old"}]}]}


def card_answer(aid="w1", n=1, marks=(), more=None, **kw):
    """一条长回答，卡片上写了红字（marks），带排版快照；more 是接在下面的回应。"""
    return answer_item(aid, n, [330, 100], text="先说结论：总价和重量成正比。", q="为什么是线性的？", marks=list(marks), sheet=CARD_SHEET,
                       more=more or [], older=[{"text": "旧的说法：和店家有关。", "t": 1}], **kw)


class CardMarksTest(unittest.TestCase):
    """长回答卡片上的红字（2026-11-14）：哪些红字要交、卡片画成图、消息、之前写过的长回答带上接着的各段、往来稿和存回 PDF、迁移脚本的复查。"""

    def test_which_marks_go_with_the_card(self):
        """还没交的（没 req）、交了还没被回应的（有 req、不在任何一段回应的 on 里）都交；回应过的、擦掉的不交；卡片擦掉了不交。
        圈号上的红点（unsent_marks）只看还没交的。"""
        ms = [card_mark("k1"), card_mark("k2", req="r1"), card_mark("k3", req="r1"), card_mark("k4", erased=5)]
        it = card_answer(marks=ms, more=[{"id": "m1", "t": 2, "req": "r1", "q": "这句", "text": "接着回", "on": ["k3"]}])
        self.assertEqual([m["id"] for m in pages.card_marks(it)], ["k1", "k2"])
        self.assertEqual([m["id"] for m in pages.unsent_marks(it)], ["k1"])
        page = {"strokes": [], "ai": [card_answer("w2", 2, marks=[card_mark("j1")]), it, card_answer("w3", 3)]}
        self.assertEqual([(a["id"], [m["id"] for m in ms_]) for a, ms_ in pages.cards_to_send(page)], [("w1", ["k1", "k2"]), ("w2", ["j1"])])  # 按圈号排，没红字的不交
        for gone in (dict(it, erasedAt=9, dismissed=True), dict(it, at=None), dict(it, type="note")):
            self.assertEqual(pages.card_marks(gone), [])
            self.assertEqual(pages.unsent_marks(gone), [])
        self.assertEqual(pages.more_of({"more": [{"text": "  "}, "x", {"text": "有字"}]}), [{"text": "有字"}])

    def test_card_image_has_blue_rows_and_red_marks_in_place(self):
        """卡片的图：按平板量下的排版把每行蓝字画在原位，叠上这次交的红字；两倍大（440 → 880 像素宽）。
        红字在它那一块里的坐标加上那一块的顶：主回答那块里的、之前的版本那块里的都在原位。"""
        it = card_answer(marks=[card_mark("k1", "a", 56), card_mark("k2", "o0", 34)])
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "card.png"
            pages.render_card(it, pages.card_marks(it), str(out))
            pix = fitz.Pixmap(str(out))
            self.assertEqual(pix.width, 880)
            red = lambda c: c[0] > 150 and c[1] < 130 and c[2] < 130  # noqa: E731
            blue = lambda c: c[2] - c[0] > 50 and c[2] > 90  # noqa: E731
            self.assertTrue(red(pix.pixel(2 * 90, 2 * (12 + 56))), pix.pixel(2 * 90, 2 * (12 + 56)))     # 主回答那一块：y = 12 + 56
            self.assertTrue(red(pix.pixel(2 * 90, 2 * (130 + 34))), pix.pixel(2 * 90, 2 * (130 + 34)))   # 之前的版本那一块：y = 130 + 34
            self.assertFalse(red(pix.pixel(2 * 90, 2 * (12 + 40))))                                       # 字那一行上没有红
            row = [pix.pixel(x, y) for y in range(2 * (12 + 30), 2 * (12 + 50)) for x in range(2 * 16, 2 * 316, 3)]
            self.assertGreater(sum(1 for c in row if blue(c)), 150)                                       # 「先说结论」那一行是蓝字
            beside = [pix.pixel(x, y) for y in range(2 * (12 + 30), 2 * (12 + 50)) for x in range(2 * 330, 2 * 430, 3)]
            self.assertEqual(sum(1 for c in beside if blue(c)), 0)                                         # 那一行的右边（平板上没字的地方）没有蓝字
            # 没有排版快照（不该出现）：按服务端的字体粗排，照样画得出来、有红字
            out2 = Path(tmp) / "rough.png"
            bare = dict(it)
            del bare["sheet"]
            pages.render_card(bare, pages.card_marks(bare), str(out2))
            p2 = fitz.Pixmap(str(out2))
            self.assertTrue(any(red(p2.pixel(x, y)) for y in range(0, p2.height, 2) for x in range(0, p2.width, 4)))

    def test_message_lists_card_images_and_how_to_answer(self):
        meta = send_payload()
        meta["cards"] = [{"id": "w1", "n": 1, "img": "E:\\d\\card-1.png", "marks": ["k1"]}, {"id": "w3", "n": 3, "img": "E:\\d\\card-3.png", "marks": ["k9"]}]
        msg = prompt.build_message(meta, {"crop": "E:\\d\\crop.jpg", "sheet": "E:\\d\\sheet.png"}, "草稿本第 1 页（空白草稿纸）", "", "S1")
        self.assertIn("先用 Read 看这四张图：", msg)
        self.assertIn("\n- 圈号 1 的卡片：E:\\d\\card-1.png（蓝字是你之前的回答，红字是我在卡片上写的）\n- 圈号 3 的卡片：E:\\d\\card-3.png（", msg)
        self.assertIn("卡片上的红字：\n- 圈号 1 的卡片上我用红笔写了批注，见图 E:\\d\\card-1.png：蓝字是你之前的回答，红字是我写的。"
                      "回应用 ink_reply 的 write，card 填 1，q 填你读到的那句红字，text 写回应；回应接在那张卡片下面。\n- 圈号 3 的卡片上", msg)
        self.assertNotIn("卡片上的红字", prompt.build_message(send_payload(), {"crop": "c.jpg"}, "x", "", "S1"))  # 没有就不提
        self.assertEqual([prompt.count_zh(n) for n in (1, 2, 3, 10, 11)], ["一", "两", "三", "十", "11"])
        info = {"no": 2, "image": "p2.png", "label": "草稿本第 2 页", "scale": 1, "h": 1414, "groups": [], "now": 0, "first": False,
                "cards": [{"n": 4, "img": "E:\\d\\p002-card-4.png"}]}
        scan = prompt.build_scan_message("草稿本", [info], "S9")
        self.assertIn("圈号 4 的卡片上我用红笔写了批注，见图 E:\\d\\p002-card-4.png：蓝字是你之前的回答，红字是我写的。回应用 ink_reply 的 write，card 填 4（再带上 page=2）", scan)
        # 固定说明里多了这一条（第三人称）；插件里 ink_reply 的说明见插件测试
        p = prompt.protocol()
        self.assertIn("卡片上的红字：用户也会在长回答的卡片上用红笔批注、追问；交上来时消息里附那张卡片的图（蓝字是你之前的回答，红字是用户写的）。"
                      "回应用 write，card 填那张卡片的圈号，q 填你读到的那句红字，text 写回应：它接在那张卡片最下面，不出新的圈号；要改写整段，也把改好的写在下面。", p)

    def test_prev_answers_carry_the_parts_after(self):
        """「你之前在这一页写过的批注」：长回答后面接着回过的各段另起一行跟在后面（前 200 个字）。"""
        note = {"n": 1, "q": "为什么？", "text": "先说结论", "more": [{"q": "这句不对", "text": "接着\n回" + "长" * 250}, {"text": "没写红字的一段"}, {"text": " "}]}
        self.assertEqual(prompt.fmt_prev(note), "圈号 1（问：为什么？）：先说结论\n  - 接着（回应红字「这句不对」）：接着 回" + "长" * 196 + "…\n  - 接着：没写红字的一段")
        meta = dict(send_payload(), prev_notes=[note])
        self.assertIn("你之前在这一页写过的批注：\n- 圈号 1（问：为什么？）：先说结论\n  - 接着（回应红字「这句不对」）：", prompt.build_message(meta, {"crop": "c.jpg"}, "x", "", "S1"))

    def test_dialog_pdf_and_saved_pdf_carry_the_parts_after(self):
        """往来稿「第 N 页的回答」、存回 PDF 的便签：各段回应接在全文后面（前面写着它回应的红字），之前的版本在最后；卡片上的红字本身不画。"""
        it = card_answer(marks=[card_mark("k1")], more=[{"id": "m1", "t": 2, "req": "r1", "q": "这句不对", "text": "接着回的一段", "on": ["k1"]}])
        page = {"strokes": [stroke("r1", 1, 100, 100, red=True)], "ai": [it]}
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "往来.pdf"
            pages.export_pdf([(page, 1414, None, 1)], out, ai=True)
            with fitz.open(str(out)) as doc:
                body = "".join(p.get_text() for p in doc[1:])
        for must in ("问：为什么是线性的？", "先说结论", "红字：这句不对", "接着回的一段", "之前的版本", "旧的说法"):
            self.assertIn(must, body)
        self.assertLess(body.index("先说结论"), body.index("红字：这句不对"))
        self.assertLess(body.index("接着回的一段"), body.index("之前的版本"))
        note = next(n for n in pdfsave.marks_of(page, 1414)["notes"] if n["text"].startswith("圈号 1"))["text"]
        self.assertIn("先说结论：总价和重量成正比。\n\n红字：这句不对\n接着回的一段\n\n之前的版本：", note)

    def test_clean_item_keeps_card_of_write(self):
        self.assertEqual(server.clean_item({"type": "write", "text": "接着回", "q": "这句不对", "card": 2})["card"], 2)
        self.assertEqual(server.clean_item({"type": "write", "text": "x", "card": " 3 "})["card"], 3)
        self.assertEqual(server.clean_item({"type": "write", "text": "x", "card": 4.0})["card"], 4)
        for bad in ("abc", 0, -1, True, 2.5, [1]):
            self.assertIsNone(server.clean_item({"type": "write", "text": "x", "card": bad})["card"], bad)  # 填得不对：由 bridge_reply 报错
        self.assertNotIn("card", server.clean_item({"type": "write", "text": "x", "card": None}))
        self.assertNotIn("card", server.clean_item({"type": "write", "text": "x"}))
        self.assertNotIn("card", server.clean_item({"type": "note", "text": "x", "card": 1}))


class StaticScriptTest(unittest.TestCase):
    def test_no_function_declared_twice(self):
        """页面脚本里同一层不能有两个同名函数：后一个会悄悄盖掉前一个。
        2026-11-08 给橡皮加的 boxDist（点到盒子）盖掉了分组用的 boxDist（盒子到盒子），之后每一笔都自成一组，11-10 真机上才发现。"""
        static = Path(__file__).resolve().parent.parent / "static"
        for name in ("app.js", "gesture.js", "turn.js"):
            seen = {}
            for no, line in enumerate((static / name).read_text("utf-8").splitlines(), 1):
                m = re.match(r"^( *)(?:async )?function (\w+)\(", line)
                if m:
                    key = (len(m.group(1)), m.group(2))
                    if len(m.group(1)) <= 2:  # 只查最外两层（文件顶层和主函数里那一层），再往里同名的各管各的
                        self.assertNotIn(key, seen, f"{name} 第 {seen.get(key)} 行和第 {no} 行都声明了 {m.group(2)}")
                        seen[key] = no


if __name__ == "__main__":
    unittest.main()

"""规则瘦身 B 组（2026-11-16 用户定）：原来只写在给 Claude 的固定说明里的五条，改成服务把关。

① 短批注写长了：note、question 的 text 超过 NOTE_MAX 字，服务当长回答收成圈号卡片，工具结果里说哪条收了；
② 另画 number 去配圈号、write 的 anchor 写 end：服务纠正（认得准的才动）；
③ cross、wavy、strike 不带 text：这一条退回，工具结果里说第几条、缺什么；同一次的别的照写；
④ 红笔那几组（和回应到的那几组）的读法：缺了哪几组，工具结果里点名，不拦；
⑤ 采纳的修改改完逐条回报（result）：没回报的，服务在下一条【草稿纸】消息里列出来（最多 OWED_TELLS 次）。

    .venv\\Scripts\\python.exe -m unittest tests.test_reply_guard -v

例子都是编的（买菜清单、周末安排），放在临时文件夹里。
"""
import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # 单独跑这个文件时也找得到 test_server

import pages  # noqa: E402
import prompt  # noqa: E402
import server  # noqa: E402
import test_server as T  # noqa: E402  只引模块（不把它的测试类引进来，免得跑两遍）

T0 = 1_700_000_000_000
LONG_ZH = "周六上午先去超市买菜，下午再去公园散步；要是下雨就改成在家包饺子，馅儿用白菜猪肉，面要提前和好醒半小时，晚上七点开饭，饭后一起看电影。"
SHORT_ZH = "单位对吗？"


class GuardBase(unittest.TestCase):
    setUp = T.HttpTest.setUp
    tearDown = T.HttpTest.tearDown
    call = T.HttpTest.call
    j = T.HttpTest.j
    put_page = T.HttpTest.put_page

    def send(self, strokes, ai=None, verdicts=None, sid="B"):
        """把笔迹（和 Claude 之前的批注）存成草稿本第 1 页，按服务端的分组整页交上去：返回（投递编号, 消息）。"""
        self.put_page(0, strokes, ai=ai)
        ids = {gid: [s["id"] for s in ss] for gid, ss in pages.group_strokes(strokes)}
        groups = [dict(g, inSel=True, ids=ids.get(g["id"], [])) for g in pages.compute_groups(strokes)]
        body = dict(T.send_payload(target=sid), groups=groups, sel={"x0": 0, "y0": 0, "x1": 800, "y1": 600})
        if verdicts:
            body["verdicts"] = verdicts
        st, sent = self.j("POST", "/api/send", body)
        self.assertEqual(st, 200, sent)
        return sent["id"], self.j("GET", f"/bridge/poll?sid={sid}")[1]["submission"]["text"]

    def reply(self, sub, items, status=200, **extra):
        st, rep = self.j("POST", "/bridge/reply", dict({"sid": "B", "submission": sub, "items": items}, **extra))
        self.assertEqual(st, status, rep)
        return rep

    def pending_items(self):
        f = self.app._key_file("scratch", self.app.page_key("scratch", 0), ".pending.json")
        return [it for e in json.loads(f.read_text("utf-8")) for it in e.get("items") or []] if f.exists() else []

    def strokes(self):
        """g1：黑笔一行；g2：红笔问题（一分钟后写在下面）；g3：黑笔（再过一分钟）。"""
        return [T.stroke("a", T0, 100, 100), T.stroke("b", T0 + 300, 170, 100),
                T.stroke("r", T0 + 90000, 100, 300, red=True),
                T.stroke("c", T0 + 200000, 100, 500)]

    def setUpGuard(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})


class LongNoteTest(GuardBase):
    """① 短批注写长了收成圈号卡片。"""

    def test_note_len_counts_latin_as_half(self):
        self.assertEqual(server.note_len("周六去超市"), 5)
        self.assertEqual(server.note_len("buy milk"), 4)            # 英文字母、空格各算半个
        self.assertEqual(server.note_len("（ρ）"), 2.5)              # 全角括号算 1，希腊字母算半个
        self.assertEqual(server.NOTE_MAX, 60)

    def test_long_note_becomes_a_badge_at_the_same_anchor(self):
        self.setUpGuard()
        self.assertGreater(server.note_len(LONG_ZH), server.NOTE_MAX)
        sub, _ = self.send(self.strokes())
        rep = self.reply(sub, [{"type": "note", "anchor": "g2", "text": LONG_ZH}, {"type": "note", "anchor": "g1", "text": SHORT_ZH},
                               {"type": "question", "box": [10, 10, 60, 30], "text": "Is it " + "really " * 20 + "right?"},
                               {"type": "read", "anchor": "g2", "text": "几点开饭"}])
        items = self.pending_items()
        self.assertEqual([(it["type"], it.get("anchor"), it.get("box")) for it in items],
                         [("write", "g2", None), ("note", "g1", None), ("write", None, [10.0, 10.0, 60.0, 30.0]), ("read", "g2", None)])
        self.assertEqual(items[0]["text"], LONG_ZH)                                          # 全文照收，不截成短批注的长度
        self.assertNotIn("q", items[0])                                                      # 没有 q 就没有，不编
        notes = rep["notes"]
        self.assertIn(prompt.REPLY_LONG_NOTE.format(k=1, type="note", n=round(server.note_len(LONG_ZH)), max=60, where=" g2 "), notes)
        self.assertTrue(any(n.startswith("第 3 条 question 约 ") and "放在 box 指的那块旁边" in n for n in notes), notes)
        self.assertFalse(any(n.startswith("第 2 条") for n in notes), notes)                  # 短的照旧是短批注，不提
        self.assertEqual(rep["count"], 4)

    def test_english_note_of_sixty_letters_stays_a_note(self):
        kept, notes = server.settle_items([{"type": "note", "anchor": "g1", "text": "x" * 120},
                                           {"type": "note", "anchor": "g1", "text": "x" * 122}])
        self.assertEqual([it["type"] for _, it in kept], ["note", "write"])
        self.assertEqual(len(notes), 1)


class AnchorAndNumberTest(GuardBase):
    """② write 的 anchor 写 end 当成没指明；另画 number 配圈号：认得准的不画，认不准的不动。"""

    def test_end_anchor_is_cleared(self):
        kept, notes = server.settle_items([{"type": "write", "anchor": "END", "q": "为什么？", "text": "因为……"}])
        self.assertNotIn("anchor", kept[0][1])
        self.assertEqual(notes, [prompt.REPLY_END_ANCHOR.format(k=1)])
        kept, notes = server.settle_items([{"type": "write", "card": 2, "anchor": "end", "text": "接着回"}])   # 回应卡片的不管 anchor
        self.assertEqual(notes, [])
        kept, notes = server.settle_items([{"type": "formula", "anchor": "end", "tex": "a+b"}])                # 图和公式的 end 照旧有用
        self.assertEqual(kept[0][1]["anchor"], "end")

    def test_number_that_matches_a_badge_is_dropped(self):
        for num in ({"type": "number", "anchor": "g2", "text": "1"}, {"type": "number", "anchor": "end", "text": "1"},
                    {"type": "number", "text": "1"}):
            kept, notes = server.settle_items([{"type": "write", "anchor": "g2", "q": "几点？", "text": "七点开饭。"}, num])
            self.assertEqual([it["type"] for _, it in kept], ["write"], num)
            self.assertEqual(notes, [prompt.REPLY_NUMBER_DROPPED.format(k=2)])
        kept, notes = server.settle_items([{"type": "write", "box": [1, 2, 3, 4], "text": "长"}, {"type": "number", "box": [1, 2, 3, 4], "text": "1"}])
        self.assertEqual([it["type"] for _, it in kept], ["write"])

    def test_numbers_that_order_steps_are_left_alone(self):
        steps = [{"type": "number", "anchor": "g1", "text": "1"}, {"type": "number", "anchor": "g2", "text": "2"},
                 {"type": "number", "anchor": "g3", "text": "3"}]
        kept, notes = server.settle_items([{"type": "write", "anchor": "g2", "text": "长回答"}] + steps)  # 有一条指着别处：都不动
        self.assertEqual([it["type"] for _, it in kept], ["write", "number", "number", "number"])
        self.assertEqual(notes, [])
        kept, notes = server.settle_items(steps)                                                          # 没有长回答：照旧
        self.assertEqual(len(kept), 3)
        self.assertEqual(notes, [])

    def test_reply_says_what_was_corrected(self):
        self.setUpGuard()
        sub, _ = self.send(self.strokes())
        rep = self.reply(sub, [{"type": "write", "anchor": "end", "q": "几点开饭？", "text": "七点。"},
                               {"type": "number", "anchor": "end", "text": "1"}, {"type": "read", "anchor": "g2", "text": "几点开饭"}])
        self.assertEqual(rep["count"], 2)
        self.assertEqual([(it["type"], it.get("anchor")) for it in self.pending_items()], [("write", None), ("read", "g2")])
        self.assertEqual(rep["notes"], [prompt.REPLY_END_ANCHOR.format(k=1), prompt.REPLY_NUMBER_DROPPED.format(k=2)])


class RejectedMarksTest(GuardBase):
    """③ cross、wavy、strike 不带 text：这一条退回并说明；同一次的别的照写。"""

    def test_marks_without_reason_are_named(self):
        self.setUpGuard()
        sub, _ = self.send(self.strokes())
        rep = self.reply(sub, [{"type": "cross", "anchor": "g1"}, {"type": "tick", "anchor": "g1"}, {"type": "wavy", "anchor": "g3", "text": " "},
                               {"type": "strike", "anchor": "g3"}, {"type": "bogus"}, {"type": "read", "anchor": "g2", "text": "几点开饭"},
                               {"type": "read", "anchor": "g1", "text": "买菜"}, {"type": "read", "anchor": "g3", "text": "包饺子"}])
        self.assertEqual(rep["count"], 4)
        self.assertEqual([it["type"] for it in self.pending_items()], ["tick", "read", "read", "read"])
        self.assertEqual(rep["notes"], ["第 1 条 cross 没写上：缺一句 text（为什么错）。",
                                        "第 3 条 wavy 没写上：缺一句 text（疑在哪）。",
                                        "第 4 条 strike 没写上：缺一句 text（改成什么或为什么删）。",
                                        "第 5 条 没写上：type「bogus」不认识。"])

    def test_all_rejected_is_refused_with_the_reasons(self):
        self.setUpGuard()
        sub, _ = self.send(self.strokes())
        st, rep = self.j("POST", "/bridge/reply", {"sid": "B", "submission": sub, "items": [{"type": "cross", "anchor": "g1"}]})
        self.assertEqual(st, 400)
        self.assertIn("第 1 条 cross 没写上：缺一句 text（为什么错）", rep["error"])
        self.assertEqual(self.pending_items(), [])


class ReadsTest(GuardBase):
    """④ 红笔那几组和回应到的那几组的读法：缺了的在工具结果里点名，几次 ink_reply 合起来算；不拦。"""

    def test_missing_reads_are_named_until_given(self):
        self.setUpGuard()
        sub, _ = self.send(self.strokes())
        rep = self.reply(sub, [{"type": "note", "anchor": "g2", "text": "七点"}, {"type": "tick", "anchor": "g3"}])
        self.assertEqual(rep["count"], 2)                                                     # 不拦：照写
        self.assertEqual(rep["notes"], [prompt.REPLY_MISSING_READS.format(ids="g2、g3")])
        rep = self.reply(sub, [{"type": "read", "anchor": "g2", "text": "几点开饭"}])
        self.assertEqual(rep["notes"], [prompt.REPLY_MISSING_READS.format(ids="g3")])
        rep = self.reply(sub, [{"type": "read", "anchor": "g3:1", "text": "包饺子"}])         # 指一行的读法也算那一组交了
        self.assertEqual(rep["notes"], [])

    def test_answered_and_erased_groups_need_no_read(self):
        """之前几轮回答过的红笔不算这次的问题；全擦掉的组不要读法；没指明投递（写到平板当前页）的不查。"""
        self.setUpGuard()
        strokes = self.strokes()
        strokes[3]["erasedAt"] = T0 + 210000                                                   # g3 全擦掉了
        self.put_page(0, strokes)
        ids = {gid: [s["id"] for s in ss] for gid, ss in pages.group_strokes(strokes)}
        groups = [dict(g, inSel=True, ids=ids.get(g["id"], [])) for g in pages.compute_groups(strokes)]
        self.assertEqual([(g["id"], g["red"], g["n"] > g["erased"]) for g in groups], [("g1", False, True), ("g2", True, True), ("g3", False, False)])
        groups[1]["answered"] = True                                                          # g2 之前回答过
        st, sent = self.j("POST", "/api/send", dict(T.send_payload(target="B"), groups=groups))
        self.j("GET", "/bridge/poll?sid=B")
        rep = self.reply(sent["id"], [{"type": "tick", "anchor": "g3"}, {"type": "note", "anchor": "g9", "text": "没有这组"}])
        self.assertEqual(rep["notes"], [])
        self.app.bridge.where = {"nb": "scratch", "page": 0}
        st, rep = self.j("POST", "/bridge/reply", {"sid": "B", "items": [{"type": "circle", "box": [0, 0, 50, 50]}]})
        self.assertEqual((st, rep["notes"]), (200, []))

    def test_bare_marks_need_no_read(self):
        """只是划线的红笔组不点名要读法（2026-11-16 用户定「划线免交」）：笔画少、本机认过字又没认出像样的字。
        有字的、笔画多的、没认过字的照旧要；回应时指到划线那组也不要它的读法。"""
        self.setUpGuard()
        strokes = [T.stroke("u", T0, 100, 100, red=True), T.stroke("w", T0 + 90000, 100, 300, red=True),
                   T.stroke("x", T0 + 180000, 100, 500, red=True), T.stroke("y", T0 + 270000, 100, 700, red=True)]
        self.put_page(0, strokes)
        ids = {gid: [s["id"] for s in ss] for gid, ss in pages.group_strokes(strokes)}
        groups = [dict(g, inSel=True, ids=ids.get(g["id"], [])) for g in pages.compute_groups(strokes)]
        self.assertEqual([g["id"] for g in groups], ["g1", "g2", "g3", "g4"])
        groups[0].update(reco=["=", "二", "亠"])                 # 划线：认成了等号
        groups[1].update(reco=["手", "乎"], ocr="手")            # 一笔写的字：照旧要
        groups[2].update(reco=["一"], ocr="→")                   # 箭头：认成「一」和箭头符号
        # g4 没认过字（没有 reco）：分不出，照旧要
        self.assertEqual([server.mark_like(g) for g in groups], [True, False, True, False])
        self.assertFalse(server.mark_like(dict(groups[0], n=5)))  # 笔画多的不算划线
        st, sent = self.j("POST", "/api/send", dict(T.send_payload(target="B"), groups=groups))
        self.j("GET", "/bridge/poll?sid=B")
        rep = self.reply(sent["id"], [{"type": "note", "anchor": "g1", "text": "这两行"}])   # 指到了划线那组：也不要它的读法
        self.assertEqual(rep["notes"], [prompt.REPLY_MISSING_READS.format(ids="g2、g4")])
        rep = self.reply(sent["id"], [{"type": "read", "anchor": "g2", "text": "手"}, {"type": "read", "anchor": "g4", "text": "好"},
                                      {"type": "read", "anchor": "g1", "text": "（划线）"}])  # 自己想交也照收
        self.assertEqual((rep["count"], rep["notes"]), (3, []))

    def test_scan_asks_for_new_red_only(self):
        """整本消息：要交读法的是这一页上次之后新写的红笔（按页记）；写回别的页各算各的。"""
        self.setUpGuard()
        self.app.bridge.tablet_seen = 0
        self.j("POST", "/api/notebook/addpage?nb=scratch", b"")
        self.put_page(0, [T.stroke("a", T0, 100, 100), T.stroke("r", T0 + 90000, 100, 300, red=True)])
        self.put_page(1, [T.stroke("s", T0, 100, 100, red=True)])
        st, scan = self.j("POST", "/bridge/scan", {"sid": "B", "nb": "scratch"})
        self.assertEqual(st, 200, scan)
        rep = self.reply(scan["id"], [{"type": "tick", "anchor": "g1"}], page=1)
        self.assertEqual(rep["notes"], [prompt.REPLY_MISSING_READS.format(ids="g1、g2")])
        rep = self.reply(scan["id"], [{"type": "read", "anchor": "g1", "text": "问题"}], page=2)
        self.assertEqual(rep["notes"], [])

    def test_scan_bare_marks_need_no_read(self):
        """几页一起交（整本消息）也免（2026-11-17 用户定）：只是划线的红笔组不点名要读法，回应时指到它也不要；
        有字的、没认过字的照旧要。这条路上只有本机手写识别（没有 PP-OCR 的读法）。"""
        self.setUpGuard()
        self.app.bridge.tablet_seen = 0
        self.put_page(0, [T.stroke("u", T0, 100, 100, red=True), T.stroke("w", T0 + 90000, 100, 300, red=True),
                          T.stroke("x", T0 + 180000, 100, 500, red=True)])
        reco = {"g1": ["=", "二"], "g2": ["手", "乎"]}  # g1 划线，g2 有字，g3 没认过字

        def fake_reco(nb, i, groups, only=None, page=None):
            for g in groups:
                if g["id"] in reco:
                    g["reco"] = reco[g["id"]]
        self.app.attach_reco = fake_reco
        st, scan = self.j("POST", "/bridge/scan", {"sid": "B", "nb": "scratch"})
        self.assertEqual(st, 200, scan)
        meta = self.app.load_submission(scan["id"])
        self.assertEqual((meta["pages"]["1"]["marks"], meta["pages"]["1"]["reds"]), (["g1"], ["g2", "g3"]))
        rep = self.reply(scan["id"], [{"type": "note", "anchor": "g1", "text": "这两行"}], page=1)  # 指到了划线那组：也不要它的读法
        self.assertEqual(rep["notes"], [prompt.REPLY_MISSING_READS.format(ids="g2、g3")])
        rep = self.reply(scan["id"], [{"type": "read", "anchor": "g2", "text": "手"}, {"type": "read", "anchor": "g3", "text": "好"},
                                      {"type": "read", "anchor": "g1", "text": "（划线）"}], page=1)  # 自己想交也照收
        self.assertEqual((rep["count"], rep["notes"]), (3, []))


class OwedResultsTest(GuardBase):
    """⑤ 采纳的修改（在文档上的 suggest）没用 result 回报：服务记着，下一条【草稿纸】消息里列出来，回报了就不再列。"""

    SUG = {"id": "x1", "type": "suggest", "t": T0, "text": "改为：西红柿 五个", "box": [100, 150, 400, 190], "verdict": "yes", "onDoc": True,
           "sent": True, "paths": [], "hit": [100, 150, 400, 190]}
    V = [{"id": "s1", "ref": "x1", "kind": "suggest", "text": "改为：西红柿 五个", "verdict": "yes", "on": "doc"},
         {"id": "s2", "ref": "x2", "kind": "suggest", "text": "删去这句", "verdict": "no", "on": "doc"},
         {"id": "s3", "ref": "n1", "kind": "node", "text": "雨具", "verdict": "yes"}]

    def test_unreported_adoptions_are_listed_until_reported(self):
        self.setUpGuard()
        ai = [self.SUG]
        sub1, msg1 = self.send(self.strokes(), ai=ai, verdicts=self.V)
        self.assertIn("修改建议的决定", msg1)
        self.assertNotIn("还没回报的修改", msg1)                                               # 刚带上的决定不算「没回报」
        sub2, msg2 = self.send(self.strokes(), ai=ai)
        self.assertIn(f"还没回报的修改：之前我采纳的这几条，你还没用 result 告诉我改成了没有：\n- 投递 {sub1}：s1\n", msg2)
        self.assertNotIn("s2", msg2.split("还没回报的修改")[1].split("\n\n")[0])               # 不采纳的、概念图上的不用回报
        self.assertNotIn("s3", msg2.split("还没回报的修改")[1].split("\n\n")[0])
        self.assertEqual(re.findall(r'submission="([^"]+)"', msg2), [sub2])                   # 插件认这一轮在回哪次投递，不被拐走
        self.reply(sub1, [{"type": "result", "anchor": "s1", "ok": True}])
        _, msg3 = self.send(self.strokes(), ai=ai)
        self.assertNotIn("还没回报的修改", msg3)

    def test_reminder_stops_after_a_few_times_or_when_the_suggestion_is_gone(self):
        self.setUpGuard()
        ai = [self.SUG]
        self.send(self.strokes(), ai=ai, verdicts=self.V[:1])
        told = [("还没回报的修改" in self.send(self.strokes(), ai=ai)[1]) for _ in range(self.app.OWED_TELLS + 1)]
        self.assertEqual(told, [True] * self.app.OWED_TELLS + [False])
        self.send(self.strokes(), ai=ai, verdicts=self.V[:1])                                  # 又采纳了一次
        self.assertIn("还没回报的修改", self.send(self.strokes(), ai=ai)[1])
        self.assertNotIn("还没回报的修改", self.send(self.strokes(), ai=[dict(self.SUG, dismissed=True)])[1])  # 用户把那条清掉了

    def test_tablet_scan_lists_and_records(self):
        """几页一起交（整本消息）带上的决定也记着；用户下一次点「AI」几页一起交时列出来（带页码，回报要带 page）。"""
        self.setUpGuard()
        self.app.bridge.tablet_seen = 0
        sug = dict(self.SUG, sent=False)
        self.put_page(0, [T.stroke("a", T0, 600, 600)], ai=[sug])
        st, sent = self.j("POST", "/api/send-all", {"nb": "scratch", "target": "B", "only_new": False})
        self.assertEqual(st, 200, sent)
        self.assertIn("s1（在文档上）", self.j("GET", "/bridge/poll?sid=B")[1]["submission"]["text"])
        self.put_page(0, [T.stroke("a", T0, 600, 600), T.stroke("b", T0 + 90000, 600, 800)], ai=[dict(sug, sent=True)])
        st, again = self.j("POST", "/api/send-all", {"nb": "scratch", "target": "B", "only_new": True})
        text = self.j("GET", "/bridge/poll?sid=B")[1]["submission"]["text"]
        self.assertIn(f"- 投递 {sent['id']} 第 1 页：s1", text)
        self.reply(sent["id"], [{"type": "result", "anchor": "s1", "ok": False, "text": "原文件被占用"}], page=1)
        self.assertEqual(self.app.owed_for("B"), [])


if __name__ == "__main__":
    unittest.main()

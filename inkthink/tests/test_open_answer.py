"""长回答摊在纸上、回答要多长的三档开关、卡片上的「再短点」「展开讲」（2026-11-17 用户定方向，细节是用户不在时暂定的；
《产品定义》第 2 节「蓝字摊在纸上、回答长短怎么控制」）——服务这一侧：

- 写回的 write 带的 place（四个方向或一个像素框）、fold（收着）照收、认不出的不收；
- 页面数据里摊开的长回答（spread）：电脑画的图（整本检测、往来稿）里画那一段蓝字，不画圈号；占的地方算进图的范围；
- 消息：之前写回的列表里标「（摊在纸上）」并说一句；平板带来的档（size）写一句（讲清楚不写）；几页一起交也带；
- /api/redo：交给写这条的对话（还在的话），不在了按这本发往的对话，没选过先问（410）；消息里有钮、圈号、原文、怎么写回；
  回的那条 write 接到那张卡片下面（没写 card 的补上），记下是哪个钮，AI 填的 q 不当成红字。

    .venv\\Scripts\\python.exe -m unittest tests.test_open_answer -v

例子都是编的（出门时间、买菜）。
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pages  # noqa: E402
import prompt  # noqa: E402
import server  # noqa: E402
import test_server as ts  # noqa: E402  只引模块（不把它的测试类引进来，免得跑两遍）

try:
    import pymupdf as fitz  # noqa: E402
except ImportError:  # pragma: no cover
    import fitz  # noqa: E402

T0 = 1_700_000_000_000
SPREAD = {"x": 420.0, "y": 180.0, "w": 260, "h": 66, "side": "right", "by": "auto",
          "rows": [{"y": 0, "h": 29, "w": 240, "t": "九点出门比较稳"}, {"y": 29, "h": 29, "w": 100, "t": "记得带伞"}],
          "lead": "M382 200 Q400 200 418 198"}


def answer(**kw):
    a = {"id": "w1", "type": "write", "t": T0, "text": "九点出门比较稳\n记得带伞", "q": "几点出门？", "n": 1, "at": [900.0, 900.0], "seen": True, "on": ["a"]}
    a.update(kw)
    return a


def blue_count(png, box, scale, clip):
    """图里一块（页面坐标的框）有多少蓝色的点（每两个像素取一个）。"""
    pix = fitz.Pixmap(str(png))
    x0, y0 = int((box[0] - clip[0]) * scale), int((box[1] - clip[1]) * scale)
    x1, y1 = int((box[2] - clip[0]) * scale), int((box[3] - clip[1]) * scale)
    n = 0
    for y in range(max(0, y0), min(pix.height, y1), 2):
        for x in range(max(0, x0), min(pix.width, x1), 2):
            r, g, b = pix.pixel(x, y)[:3]
            if b - r > 50 and b > 90:
                n += 1
    return n


class CleanPlaceFoldTest(unittest.TestCase):
    """write 的 place、fold：认得的照收，认不出的当没写（放哪本来由草稿纸定，不报错）。"""

    def test_place_side_box_and_fold(self):
        self.assertEqual(server.clean_item({"type": "write", "text": "x", "place": " Below "})["place"], "below")
        self.assertNotIn("place", server.clean_item({"type": "write", "text": "x", "place": "middle"}))
        self.assertEqual(server.clean_item({"type": "write", "text": "x", "place": [10, 20, 300, 400.5]})["place"], [10.0, 20.0, 300.0, 400.5])
        self.assertNotIn("place", server.clean_item({"type": "write", "text": "x", "place": [10, 20, 300]}))
        self.assertNotIn("place", server.clean_item({"type": "write", "text": "x", "place": [True, 20, 300, 400]}))
        self.assertIs(server.clean_item({"type": "write", "text": "x", "fold": True})["fold"], True)
        self.assertNotIn("fold", server.clean_item({"type": "write", "text": "x", "fold": "yes"}))
        self.assertEqual(server.WRITE_PLACES, ("right", "below", "left", "above"))

    def test_only_write_takes_them(self):
        it = server.clean_item({"type": "note", "text": "短批注", "place": "right", "fold": True})
        self.assertNotIn("place", it)
        self.assertNotIn("fold", it)


class OpenPagesTest(unittest.TestCase):
    """电脑上画的图（整本检测、往来稿）：摊开的长回答画那一段蓝字。"""

    def page(self, **kw):
        a = answer(**dict({"spread": SPREAD}, **kw))
        if a.get("spread") is None:
            del a["spread"]
        return {"v": 1, "strokes": [ts.stroke("a", T0, 120, 200, red=True, n=30)], "ai": [a], "reads": []}

    def test_open_of(self):
        self.assertEqual(pages.open_of(answer(spread=SPREAD))["rows"][1]["t"], "记得带伞")
        self.assertIsNone(pages.open_of(answer()))                                       # 收着
        self.assertIsNone(pages.open_of(answer(spread=dict(SPREAD, rows=[]))))           # 没有字
        self.assertIsNone(pages.open_of(answer(spread=dict(SPREAD, x=True))))            # 坐标不对
        self.assertIsNone(pages.open_of(dict(answer(spread=SPREAD), type="note")))       # 不是长回答

    def test_box_is_the_text_and_the_lead_not_the_badge(self):
        b = pages.ai_box(answer(spread=SPREAD))
        self.assertEqual(b, [382.0, 180.0, 680.0, 246.0])                                # 字那一块，连同细线（从 382 起）
        self.assertEqual(pages.ai_box(answer()), [900 - pages.BADGE_R, 900 - pages.BADGE_R, 900 + pages.BADGE_R, 900 + pages.BADGE_R])
        # 有内容的范围按摊开的那一段算（2026-11-18 外部审查：原来比的 680 在纸的默认宽 PAGE_W=1000 以内，怎么算都过）：
        # 摊在 1000 以外的，右边界到那一段右边再留 10；同一条收着的，只到圈号，到不了那里
        far = {k: v for k, v in SPREAD.items() if k != "lead"}
        far["x"] = 1100.0
        right, bottom = pages.content_extent(self.page(spread=far), 1414, blank=True)
        self.assertEqual(right, 1100 + 260 + 10)
        right0, bottom0 = pages.content_extent(self.page(spread=None), 1414, blank=True)
        self.assertLess(right0, 1100)

    def test_rendered_image_has_the_blue_text_not_the_badge(self):
        with ts.tempfile.TemporaryDirectory() as d:
            png = Path(d) / "p.png"
            clip = [0, 0, 1380, 1414]
            pages.render_page(self.page(), str(png), 1414, None, (), 1.0, clip, blank=True)
            self.assertGreater(blue_count(png, [420, 180, 680, 246], 1.0, clip), 40)     # 那一段字
            self.assertEqual(blue_count(png, [885, 885, 915, 915], 1.0, clip), 0)        # 圈号那里什么都没画
            pages.render_page(self.page(spread=None), str(png), 1414, None, (), 1.0, clip, blank=True)
            self.assertEqual(blue_count(png, [420, 180, 680, 246], 1.0, clip), 0)        # 收着的：那里没有字
            self.assertGreater(blue_count(png, [885, 885, 915, 915], 1.0, clip), 20)     # 画的是圈号

    def test_round_trip_pdf_writes_the_text_on_the_page(self):
        with ts.tempfile.TemporaryDirectory() as d:
            out = Path(d) / "往来稿.pdf"
            pages.export_pdf([(self.page(), 1414, None, 1)], str(out), ai=True, blank=True)
            doc = fitz.open(str(out))
            texts = [p.get_text() for p in doc]
            doc.close()                                                                   # 先关上：没关的话临时文件夹删不掉
            self.assertIn("九点出门比较稳", texts[0])                                     # 纸上就是那一段字
            self.assertIn("记得带伞", texts[0])
            self.assertTrue(any("第 1 页的回答" in t for t in texts[1:]))                 # 回答页照旧列出它

    def test_redo_segment_head(self):
        self.assertEqual(pages.redo_head({"redo": "brief"}), "按「再短点」重写：")
        self.assertEqual(pages.redo_head({"redo": "full"}), "按「展开讲」重写：")
        self.assertEqual(pages.redo_head({"q": "红字"}), "")


class OpenPromptTest(unittest.TestCase):
    """消息里怎么说摊开的、这次要多长、重写过的那一段。"""

    def test_prev_list_marks_open_answers(self):
        self.assertEqual(prompt.fmt_prev({"n": 1, "q": "几点出门？", "text": "九点", "open": True}), "圈号 1（摊在纸上）（问：几点出门？）：九点")
        self.assertEqual(prompt.fmt_prev({"n": 2, "q": "为什么？", "text": "因为"}), "圈号 2（问：为什么？）：因为")
        self.assertTrue(prompt.has_open([{"open": True}]))
        self.assertFalse(prompt.has_open(["短批注", {"n": 1}]))

    def test_prev_list_names_the_button_for_rewritten_segments(self):
        s = prompt.fmt_prev({"n": 1, "text": "原来", "more": [{"redo": "brief", "q": "再短点", "text": "短的"}, {"q": "这句不对", "text": "改了"}]})
        self.assertIn("\n  - 接着（按「再短点」重写）：短的", s)
        self.assertIn("\n  - 接着（回应红字「这句不对」）：改了", s)

    def test_size_line(self):
        self.assertEqual(prompt.size_line("brief"), prompt.SIZE_LINE["brief"])
        self.assertEqual(prompt.size_line("full"), prompt.SIZE_LINE["full"])
        self.assertEqual(prompt.size_line("clear"), "")                                  # 默认档不写
        self.assertEqual(prompt.size_line("medium"), "")
        self.assertEqual(prompt.size_line(None), "")

    def test_fixed_rule_says_red_ink_wins_then_the_size(self):
        p = prompt.protocol()
        self.assertIn("长短照消息里「这次要的长短」，没写就是讲清楚", p)
        self.assertLessEqual(len(p), 3000)
        self.assertIn("place、fold", p)

    def test_redo_message(self):
        r = {"n": 3, "want": "full", "q": "为什么？", "text": "因为单价不变。", "label": "草稿本第 1 页", "by": "「old」的对话",
             "more": [{"q": "这句不对", "text": "改过一次"}, {"redo": "brief", "text": "短的说法"}]}
        m = prompt.build_redo_message(r, "SUB1")
        self.assertTrue(m.startswith("【草稿纸·重写】我在平板上点了圈号 3 那张卡片上的「展开讲」：请把这条回答展开讲"), m)
        self.assertIn("页面：草稿本第 1 页。", m)
        self.assertIn("这条回答是「old」的对话写的（不是你）", m)
        self.assertIn("原来的回答（问：为什么？）：\n因为单价不变。", m)
        self.assertIn("卡片下面接着回过的：\n- （回应红字「这句不对」）改过一次\n- （按「再短点」重写）短的说法", m)
        self.assertNotIn("这次要的长短", m)   # 平时交页用的那句不带：「点一下」那句要的是短批注，和这里要的一条 write 对不上
        self.assertTrue(m.endswith('写回用 mcp__inkpad__ink_reply（submission="SUB1"）：一条 write（再短也用 write，不用 note），card 填 3，'
                                   'text 写重写后的整条回答；它接在那张卡片下面，不出新的圈号。'), m)
        b = prompt.build_redo_message(dict(r, want="brief"), "SUB1")
        self.assertIn("「再短点」：请把这条回答写短一点：只留最要紧的一两句", b)
        self.assertNotIn("短批注", b)       # 不叫它写成短批注


class OpenServerTest(unittest.TestCase):
    setUp = ts.HttpTest.setUp
    tearDown = ts.HttpTest.tearDown
    call = ts.HttpTest.call
    j = ts.HttpTest.j
    put_page = ts.HttpTest.put_page

    def hello(self, *sids):
        for sid, label in sids:
            self.j("POST", "/bridge/hello", {"sid": sid, "label": label, "cwd": str(Path(self.tmp.name) / label)})

    def poll(self, sid):
        return self.j("GET", f"/bridge/poll?sid={sid}")[1]["submission"]

    def queued(self):
        return {sid: len(q) for sid, q in self.app.bridge.queues.items() if q}

    def pending_items(self):
        f = self.app._key_file("scratch", self.app.page_key("scratch", 0), ".pending.json")
        return [it for e in json.loads(f.read_text("utf-8")) for it in e.get("items") or []] if f.exists() else []

    # ---- 交上去的消息
    def test_single_page_message_has_the_size_line_and_open_hint(self):
        self.hello(("A", "paper"))
        for size, want in (("brief", prompt.SIZE_LINE["brief"]), ("full", prompt.SIZE_LINE["full"]), ("clear", None), ("weird", None)):
            body = dict(ts.send_payload(target="A"), size=size,
                        prev_notes=[{"n": 1, "q": "几点出门？", "text": "九点", "open": True}, {"n": 2, "text": "收着的"}])
            st, r = self.j("POST", "/api/send", body)
            self.assertEqual(st, 200, r)
            text = self.poll("A")["text"]
            self.assertIn("- 圈号 1（摊在纸上）（问：几点出门？）：九点", text)
            self.assertIn("- 圈号 2：收着的", text)
            self.assertIn(prompt.OPEN_HINT, text)
            if want:
                self.assertEqual(text.count(want), 1, text[-400:])
                self.assertLess(text.index(want), text.rindex("\n\n") + 2)                 # 在最后那句（怎么写回）前面
            else:
                self.assertNotIn("这次要的长短", text)

    def test_no_open_hint_without_open_answers(self):
        self.hello(("A", "paper"))
        body = dict(ts.send_payload(target="A"), prev_notes=[{"n": 1, "text": "收着的"}])
        self.assertEqual(self.j("POST", "/api/send", body)[0], 200)
        self.assertNotIn(prompt.OPEN_HINT, self.poll("A")["text"])

    def test_send_all_carries_the_size_and_scan_lists_open_answers(self):
        self.hello(("A", "paper"))
        self.put_page(0, [ts.stroke("a", T0, 120, 200, red=True, n=30)], ai=[answer(spread=SPREAD)])
        st, r = self.j("POST", "/api/send-all", {"nb": "scratch", "target": "A", "only_new": False, "size": "full"})
        self.assertEqual(st, 200, r)
        text = self.poll("A")["text"]
        self.assertIn(prompt.SIZE_LINE["full"], text)
        self.assertIn("圈号 1（摊在纸上）（问：几点出门？）：九点出门比较稳", text)
        self.assertIn(prompt.OPEN_HINT, text)
        st, sc = self.j("POST", "/bridge/scan", {"sid": "A", "nb": "scratch"})       # AI 自己来看整本：没有档那一句
        self.assertEqual(st, 200, sc)
        self.assertNotIn("这次要的长短", sc["text"])
        self.assertIn("（摊在纸上）", sc["text"])
        meta = json.loads((self.app.data / "submissions" / sc["id"] / "meta.json").read_text("utf-8"))
        k = meta["pages"]["1"]["crop"]
        clip = [k["x0"], k["y0"], 1380, 1414]
        self.assertGreater(blue_count(Path(self.app.data / "submissions" / sc["id"] / "p001.png"), [420, 180, 680, 246], k["scale"], clip), 20)

    def test_reply_keeps_place_and_fold_for_the_tablet(self):
        self.hello(("A", "paper"))
        self.put_page(0, [ts.stroke("a", T0, 120, 200, red=True, n=30)])
        st, sent = self.j("POST", "/api/send", ts.send_payload(target="A"))
        self.assertEqual(st, 200, sent)
        st, rep = self.j("POST", "/bridge/reply", {"sid": "A", "submission": sent["id"], "items": [
            {"type": "write", "anchor": "g1", "text": "放下面", "place": "below"},
            {"type": "write", "anchor": "g1", "text": "收着", "fold": True},
            {"type": "write", "anchor": "g1", "text": "放在框里", "place": [10, 20, 300, 400]}]})
        self.assertEqual(st, 200, rep)
        got = [(it.get("text"), it.get("place"), it.get("fold")) for it in self.pending_items()]
        self.assertEqual(got, [("放下面", "below", None), ("收着", None, True), ("放在框里", [10.0, 20.0, 300.0, 400.0], None)])

    # ---- 「再短点」「展开讲」
    def redo_page(self, author):
        ai = [answer(author=author, more=[{"id": "m1", "t": T0 + 1, "q": "这句不对", "text": "改过一次"}]), answer(id="w2", n=2, at=[900.0, 400.0], text="第二条")]
        self.put_page(0, [ts.stroke("a", T0, 120, 200, red=True, n=30)], ai=ai)

    def test_redo_goes_to_the_author_when_it_is_still_here(self):
        self.hello(("A", "paper"), ("B", "idea"))
        self.assertEqual(self.j("POST", "/api/notebook/target", {"nb": "scratch", "sid": "B"})[0], 200)
        self.redo_page({"sid": "A", "label": "paper", "ai": "Claude"})
        st, r = self.j("POST", "/api/redo", {"nb": "scratch", "page": 0, "id": "w1", "want": "brief"})
        self.assertEqual((st, r.get("target"), r.get("label")), (200, "A", "paper"), r)
        self.assertEqual(self.queued(), {"A": 1})                                         # 写它的对话收到，B 没有
        self.assertEqual(self.app.nb_target("scratch")["sid"], "B")                         # 这本还是发往 B
        sub = self.poll("A")
        text = sub["text"]
        self.assertTrue(text.startswith("【草稿纸·重写】我在平板上点了圈号 1 那张卡片上的「再短点」"), text)
        self.assertIn("原来的回答（问：几点出门？）：\n九点出门比较稳\n记得带伞", text)
        self.assertIn("卡片下面接着回过的：\n- （回应红字「这句不对」）改过一次", text)
        self.assertNotIn("这次要的长短", text)
        self.assertIn(f'submission="{r["id"]}"）：一条 write（再短也用 write，不用 note），card 填 1', text)
        self.assertNotIn("不是你", text)                                                  # 是它自己写的
        meta = json.loads((self.app.data / "submissions" / r["id"] / "meta.json").read_text("utf-8"))
        self.assertEqual((meta["kind"], meta["redo"], meta["target"]), ("redo", {"id": "w1", "n": 1, "want": "brief"}, "A"))
        # A 回：没写 card、填了 q——服务补上 card，记下是「再短点」，q 不当成红字
        st, rep = self.j("POST", "/bridge/reply", {"sid": "A", "submission": r["id"], "items": [{"type": "write", "q": "再短点", "text": "九点出门。"}]})
        self.assertEqual(st, 200, rep)
        it = self.pending_items()[-1]
        self.assertEqual((it["type"], it["card"], it["redo"], it.get("q")), ("write", 1, "brief", None), it)

    def test_redo_reply_written_as_a_note_still_lands_on_the_card(self):
        """「再短点」的回应很短，AI 写成了 note：照样当成重写的那一段接在卡片下面（2026-11-18，审查后加）。"""
        self.hello(("A", "paper"))
        self.redo_page({"sid": "A", "label": "paper"})
        st, r = self.j("POST", "/api/redo", {"nb": "scratch", "page": 0, "id": "w1", "want": "brief", "target": "A"})
        self.assertEqual(st, 200, r)
        st, rep = self.j("POST", "/bridge/reply", {"sid": "A", "submission": r["id"], "items": [{"type": "note", "anchor": "g1", "text": "九点出门。"}]})
        self.assertEqual(st, 200, rep)
        it = self.pending_items()[-1]
        self.assertEqual((it["type"], it["card"], it["cid"], it["redo"], it.get("anchor")), ("write", 1, "w1", "brief", None), it)

    def test_redo_reply_is_refused_when_the_answer_was_replaced(self):
        """交出去以后原来那条被擦了、圈号 1 给了另一条回答：重写不接到别人的卡片上（2026-11-18，审查后加）。"""
        self.hello(("A", "paper"))
        self.redo_page({"sid": "A", "label": "paper"})
        st, r = self.j("POST", "/api/redo", {"nb": "scratch", "page": 0, "id": "w1", "want": "brief", "target": "A"})
        self.assertEqual(st, 200, r)
        before = len(self.pending_items())
        self.put_page(0, [], ai=[answer(id="w9", author={"sid": "A"}, text="另一条回答")])   # 圈号还是 1，但已经是另一条
        st, rep = self.j("POST", "/bridge/reply", {"sid": "A", "submission": r["id"], "items": [{"type": "write", "text": "九点出门。"}]})
        self.assertEqual(st, 400, rep)
        self.assertIn("已经不在这一页上了", rep["error"])
        self.assertEqual(len(self.pending_items()), before)

    def test_place_box_must_be_a_sane_box(self):
        """place 的像素框：数要有限、不离谱、右下在左上的右下；不是的当没写（平板拿它一格一格找空地，离谱的框会卡住纸面）。"""
        self.hello(("A", "paper"))
        self.put_page(0, [ts.stroke("a", T0, 120, 200, red=True, n=30)])
        st, sent = self.j("POST", "/api/send", ts.send_payload(target="A"))
        self.assertEqual(st, 200, sent)
        bad =[[0, 0, 1e9, 1e9], [0, 0, float("inf"), 10], [float("nan"), 0, 10, 10], [300, 20, 10, 400], [10, 400, 300, 20], [0, 0, 0, 0]]
        for box in bad:
            self.assertNotIn("place", server.clean_item({"type": "write", "text": "x", "anchor": "g1", "place": box}), box)
        self.assertEqual(server.clean_item({"type": "write", "text": "x", "anchor": "g1", "place": [10, 20, 300, 400]})["place"], [10.0, 20.0, 300.0, 400.0])
        st, rep = self.j("POST", "/bridge/reply", {"sid": "A", "submission": sent["id"], "items": [
            {"type": "write", "anchor": "g1", "text": "离谱的框", "place": [0, 0, 1e12, 1e12]}]})
        self.assertEqual(st, 200, rep)
        self.assertIsNone(self.pending_items()[-1].get("place"))

    def test_reply_to_another_card_in_a_redo_delivery_is_not_tagged(self):
        self.hello(("A", "paper"))
        self.redo_page({"sid": "A", "label": "paper"})
        st, r = self.j("POST", "/api/redo", {"nb": "scratch", "page": 0, "id": "w1", "want": "full", "target": "A"})
        self.assertEqual(st, 200, r)
        st, rep = self.j("POST", "/bridge/reply", {"sid": "A", "submission": r["id"], "items": [{"type": "write", "card": 2, "q": "顺便", "text": "第二条也改"}]})
        self.assertEqual(st, 200, rep)
        it = self.pending_items()[-1]
        self.assertEqual((it["card"], it.get("redo"), it.get("q")), (2, None, "顺便"), it)

    def test_redo_goes_to_the_notebook_target_when_the_author_is_gone(self):
        self.hello(("B", "idea"))
        self.assertEqual(self.j("POST", "/api/notebook/target", {"nb": "scratch", "sid": "B"})[0], 200)
        self.redo_page({"sid": "C", "label": "old", "cwd": "E:\\old", "ai": "Claude"})     # C 不在了
        st, r = self.j("POST", "/api/redo", {"nb": "scratch", "page": 0, "id": "w1", "want": "full"})
        self.assertEqual((st, r.get("target")), (200, "B"), r)
        text = self.poll("B")["text"]
        self.assertIn("「展开讲」：请把这条回答展开讲", text)
        self.assertIn("这条回答是「old」的对话写的（不是你）", text)

    def test_redo_asks_first_when_nobody_to_send_to(self):
        self.hello(("A", "paper"), ("B", "idea"))
        self.redo_page({"sid": "C", "label": "old"})                                        # 作者不在，这本没选过，连着两个
        st, r = self.j("POST", "/api/redo", {"nb": "scratch", "page": 0, "id": "w1", "want": "brief"})
        self.assertEqual((st, r.get("pick")), (410, True), r)
        self.assertEqual(self.queued(), {})
        st, r = self.j("POST", "/api/redo", {"nb": "scratch", "page": 0, "id": "w1", "want": "brief", "target": "B"})  # 平板上选了 B
        self.assertEqual((st, r.get("target")), (200, "B"), r)

    def test_redo_refuses_bad_requests(self):
        self.hello(("A", "paper"))
        self.redo_page({"sid": "A", "label": "paper"})
        self.assertEqual(self.j("POST", "/api/redo", {"nb": "scratch", "page": 0, "id": "w1", "want": "medium"})[0], 400)
        self.assertEqual(self.j("POST", "/api/redo", {"nb": "scratch", "page": 0, "id": "nope", "want": "brief"})[0], 400)
        self.put_page(0, [], ai=[answer(author={"sid": "A"}, erasedAt=T0 + 5)])                      # 擦掉了
        self.assertEqual(self.j("POST", "/api/redo", {"nb": "scratch", "page": 0, "id": "w1", "want": "brief"})[0], 400)
        self.assertEqual(self.queued(), {})

    def test_local_only_notebook_is_not_sent(self):
        self.hello(("A", "paper"))
        self.redo_page({"sid": "A", "label": "paper"})
        self.assertEqual(self.j("POST", "/api/notebook/setting", {"nb": "scratch", "key": "local", "value": True})[0], 200)
        st, r = self.j("POST", "/api/redo", {"nb": "scratch", "page": 0, "id": "w1", "want": "brief"})
        self.assertEqual(st, 400, r)
        self.assertIn("只在本地", r["error"])
        self.assertEqual(self.queued(), {})


if __name__ == "__main__":
    unittest.main()

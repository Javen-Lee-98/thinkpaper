"""蓝字记作者、交给别的对话时说明（2026-11-17 用户定，《产品定义》第 2 节「本子、对话、AI 的关系」：纸是跨对话、跨 AI 的共同记忆）。
服务这一侧：
- 写回的待处理条目带上是谁写的（sid、文件夹名、文件夹、哪个 AI；插件没报 AI 的记 Claude；没登记过的对话只记 sid）；
- 交给一个对话时（单页交、几页一起交、整本检测、快照），这一页上有别的对话写的蓝字，消息里说一句「有 N 条不是这个对话写的
  （是「某文件夹」的对话写的）」，列表里那几条标〔不是你写的〕，书写过程里别的对话答过的红笔写「回答过：别的对话答的」；
  卡片、修改建议不说成「你的」；全是它自己写的就一个字都不多（和没记作者时的消息一字不差）；
- 这以前写的没记作者：按它回的那次投递交给了谁认；查不出（没指明投递、快照）就不说；旧数据不改。
例子都是编的（周末出游的安排）。"""
import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import test_server as ts  # noqa: E402  （不把 HttpTest 这个名字引进来：引进来的话这个文件会把它的测试再跑一遍）
import prompt  # noqa: E402

T0 = 1_700_000_000_000
TAG = prompt.OTHERS_TAG


def by(sid, label, cwd, ai="Claude"):
    return {"sid": sid, "label": label, "cwd": cwd, "ai": ai}


def note(nid, text, on, author=None, req="r1", y=100, **kw):
    """一条短批注（纸上看得见：有排版、有占的地方）。"""
    it = {"id": nid, "type": "note", "t": T0 + 5000, "req": req, "text": text, "on": list(on), "box": [100, y, 300, y + 20],
          "lay": {"x": 600, "y": y, "w": 200, "h": 30, "lines": [text], "fs": 21, "lh": 29}, "paths": [], "hit": [594, y - 4, 806, y + 34]}
    if author:
        it["author"] = author
    it.update(kw)
    return it


def tick(tid, on, author=None, req="r1"):
    it = {"id": tid, "type": "tick", "t": T0 + 6000, "req": req, "on": list(on), "box": [100, 300, 200, 320], "sym": [205, 300, 225, 320],
          "paths": [{"d": "M205 310 L212 318 L225 300", "w": 2.2}], "hit": [200, 296, 230, 324]}
    if author:
        it["author"] = author
    return it


def strokes():
    return [ts.stroke("r1", T0, 100, 100, red=True), ts.stroke("r2", T0 + 300, 100, 104, red=True), ts.stroke("b1", T0 + 9000, 100, 300)]


def groups(answered=True):
    g1 = {"id": "g1", "t0": T0, "t1": T0 + 600, "n": 2, "erased": 0, "bbox": [100, 100, 160, 110], "inSel": True, "red": True, "ids": ["r1", "r2"]}
    if answered:
        g1["answered"] = True
    g2 = {"id": "g2", "t0": T0 + 9000, "t1": T0 + 9300, "n": 1, "erased": 0, "bbox": [100, 300, 160, 306], "inSel": True, "ids": ["b1"]}
    return [g1, g2]


class AuthorsTest(unittest.TestCase):
    setUp = ts.HttpTest.setUp
    tearDown = ts.HttpTest.tearDown
    call = ts.HttpTest.call
    j = ts.HttpTest.j

    def hello(self, sid, label, folder=None, ai=None):
        d = Path(self.tmp.name) / (folder or label)
        d.mkdir(exist_ok=True)
        body = {"sid": sid, "label": label, "cwd": str(d)}
        if ai:
            body["ai"] = ai
        self.j("POST", "/bridge/hello", body)
        return str(d)

    def two(self):
        """两个对话：A 在 paper 文件夹，B 在 idea 文件夹。"""
        self.pa, self.pb = self.hello("A", "paper"), self.hello("B", "idea")

    def put(self, ai, i=0, nb="scratch"):
        page = {"v": 1, "strokes": strokes(), "ai": ai, "reads": []}
        st = self.call("PUT", f"/api/page?nb={nb}&i={i}", page)[0]
        self.assertEqual(st, 200)

    def send(self, target, prev=None, ids=None, answered=True, **extra):
        body = ts.send_payload(target=target)
        body.update(groups=groups(answered), now=T0 + 20000)
        body["prev_notes"] = prev if prev is not None else []
        if ids is not None:
            body["prev_ids"] = ids
        body.update(extra)
        st, r = self.j("POST", "/api/send", body)
        self.assertEqual(st, 200, r)
        return r["id"], (self.app.data / "submissions" / r["id"] / "message.txt").read_text("utf-8")

    def page_file(self, i=0):
        return self.app._page_file("scratch", i).read_text("utf-8")

    # ---------------------------------------------------------------- 写回带作者

    def test_reply_entry_records_who_wrote_it(self):
        """写回的待处理条目带上作者：sid、文件夹名、文件夹、AI（插件没报的记 Claude，报了的照报的）；没登记过的对话只记 sid；
        没说是哪个对话的（sid 空）不记。平板取走时整条带着。"""
        self.two()
        cx = self.hello("C", "paper", "paper2", ai="Codex")
        self.put([])
        sub, _ = self.send("A")
        for sid in ("A", "C", "ghost", ""):
            st, r = self.j("POST", "/bridge/reply", {"sid": sid, "submission": sub, "items": [{"type": "note", "anchor": "g1", "text": f"来自 {sid or '空'}"}]})
            self.assertEqual(st, 200, r)
        st, got = self.j("GET", "/api/pending?nb=scratch&i=0")
        self.assertEqual(st, 200)
        authors = [e.get("author") for e in got if e.get("items")]
        self.assertEqual(authors, [by("A", "paper", self.pa), by("C", "paper", cx, ai="Codex"), {"sid": "ghost"}, None])
        self.assertEqual(self.app.author_of("A")["ai"], "Claude")

    # ---------------------------------------------------------------- 单页交

    def test_message_to_another_conversation_says_which_are_not_its(self):
        """A 写的三条（短批注、勾、长回答）和 B 接在那张卡片下面的一段、B 自己的一条短批注：交给 B 时说 3 条是「paper」的对话写的，
        列表里两条标〔不是你写的〕，勾写出是什么、在哪一组；A 答过的红笔写「回答过：别的对话答的」。交给 A 时反过来说 2 条是「idea」的。"""
        self.two()
        a, b = by("A", "paper", self.pa), by("B", "idea", self.pb)
        w1 = ts.answer_item("w1", 1, [330, 100], text="周六九点出门比较稳。", q="几点出门？", author=a,
                            more=[{"id": "m1", "t": T0 + 7000, "req": "rb", "q": "太早了", "text": "那就十点出门。", "on": [], "author": b}])
        self.put([note("n1", "先看天气预报", ["r1", "r2"], a), tick("t1", ["b1"], a), w1, note("n2", "带上雨伞", ["b1"], b, y=200)])
        prev = ["先看天气预报", {"n": 1, "q": "几点出门？", "text": "周六九点出门比较稳。", "more": [{"q": "太早了", "text": "那就十点出门。"}]}, "带上雨伞"]
        _, to_b = self.send("B", prev, ["n1", "w1", "n2"])
        self.assertIn("这一页上有 3 条蓝色批注不是这个对话写的（是「paper」的对话写的），你没有它们的上下文：当成纸上已有的内容看，"
                      "不要当成自己说过的话。下面列出的批注里标着〔不是你写的〕的是其中 2 条；另外的是：勾（g2）。", to_b)
        self.assertIn("这一页上之前写回的批注（标着〔不是你写的〕的是别的对话写的）：\n- 〔不是你写的〕先看天气预报\n"
                      "- 圈号 1〔不是你写的〕（问：几点出门？）：周六九点出门比较稳。\n  - 接着（回应红字「太早了」）：那就十点出门。\n- 带上雨伞", to_b)
        self.assertIn("｜红笔（回答过：别的对话答的）", to_b)
        self.assertNotIn("你之前在这一页写过的批注", to_b)
        _, to_a = self.send("A", prev, ["n1", "w1", "n2"])
        self.assertIn("这一页上有 2 条蓝色批注不是这个对话写的（是「idea」的对话写的），你没有它们的上下文：当成纸上已有的内容看，"
                      "不要当成自己说过的话。下面列出的批注里标着〔不是你写的〕的就是这几条。", to_a)
        self.assertIn("- 先看天气预报\n- 圈号 1（问：几点出门？）：周六九点出门比较稳。\n  - 接着〔不是你写的〕（回应红字「太早了」）：那就十点出门。\n"
                      "- 〔不是你写的〕带上雨伞", to_a)
        self.assertIn("｜红笔（回答过）", to_a)
        self.assertNotIn("别的对话答的", to_a)

    def test_all_own_ink_adds_not_a_single_word(self):
        """全是这个对话自己写的：消息和这些蓝字没记作者时一字不差（不多一句、不标、标题照旧）。"""
        self.two()
        a = by("A", "paper", self.pa)
        prev, ids = ["先看天气预报"], ["n1"]
        self.put([note("n1", "先看天气预报", ["r1", "r2"], a), tick("t1", ["b1"], a)])
        s1, with_author = self.send("A", prev, ids)
        self.put([note("n1", "先看天气预报", ["r1", "r2"]), tick("t1", ["b1"])])
        s2, without = self.send("A", prev, ids)
        self.assertEqual(with_author.replace(s1, "S"), without.replace(s2, "S"))
        for word in ("不是这个对话写的", TAG, "别的对话"):
            self.assertNotIn(word, with_author)
        self.assertIn("你之前在这一页写过的批注：\n- 先看天气预报", with_author)

    def test_other_ai_and_same_folder_are_named(self):
        """不同 AI 带上 AI 的名字；和收消息的对话在同一个文件夹里的写「另一个对话」。"""
        self.two()
        cx = self.hello("C", "idea", "elsewhere", ai="Codex")
        self.hello("B2", "idea")  # 和 B 同一个文件夹
        self.put([note("n1", "先看天气预报", ["r1"], by("C", "idea", cx, ai="Codex")), note("n2", "带上雨伞", ["b1"], by("B2", "idea", self.pb), y=200)])
        _, to_b = self.send("B")
        self.assertIn("这一页上有 2 条蓝色批注不是这个对话写的（1 条是「idea」的 Codex 对话写的，1 条是「idea」的另一个对话写的）", to_b)
        self.assertIn("它们是：短批注「先看天气预报」（g1）、短批注「带上雨伞」（g2）。", to_b)  # 这次没带「之前写回的批注」：逐条写出是什么

    def test_cards_and_suggestions_are_not_called_yours(self):
        """卡片（别的对话写的长回答，上面有还没交的红字）不说成「你之前的回答」；别的对话提的修改建议标出来，不全说成「你提的」。"""
        self.two()
        a = by("A", "paper", self.pa)
        card = ts.card_answer(marks=[ts.card_mark("k1")], author=a)
        sug = note("x1", "改为：十点出门", [], a, y=400, type="suggest", onDoc=True)
        self.put([card, sug])
        verdicts = [{"id": "s1", "ref": "x1", "kind": "suggest", "text": "改为：十点出门", "verdict": "yes", "on": "doc"}]
        _, to_b = self.send("B", verdicts=verdicts)
        self.assertIn("蓝字是「paper」的对话之前的回答（不是你写的），红字是我写的。", to_b)
        self.assertIn("蓝字是「paper」的对话之前的回答，红字是我在卡片上写的", to_b)
        self.assertIn("虚线框是之前提的修改（标着〔不是你写的〕的是别的对话提的），我逐条选了：\n- s1〔不是你写的〕（在文档上）「改为：十点出门」：采纳", to_b)
        _, to_a = self.send("A", verdicts=verdicts)
        self.assertIn("蓝字是你之前的回答，红字是我写的。", to_a)
        self.assertIn("虚线框是你提的修改，我逐条选了：\n- s1（在文档上）", to_a)

    # ---------------------------------------------------------------- 以前写的（没记作者）

    def test_old_ink_is_traced_through_its_submission_or_left_unsaid(self):
        """没记作者的旧蓝字：它回的那次投递交给了 A，交给 B 时就说是「paper」的对话写的；A 不在了只说「别的对话」；
        回的是没指明投递的（direct-…）、快照（投递记录里没记交给谁）、编不出来的编号：一个字都不说。旧数据一个字都不改。"""
        self.two()
        self.put([])
        s_a, _ = self.send("A")
        snap, _ = self.app.save_submission(dict(ts.send_payload(), groups=groups()), snapshot=True, reader="B")
        self.put([note("n1", "先看天气预报", ["r1", "r2"], req=s_a), tick("t1", ["b1"], req="direct-ab12cd"),
                  note("n2", "带上雨伞", ["b1"], req=snap, y=200), note("n3", "记得买票", ["b1"], req="../../x", y=250)])
        before = self.page_file()
        _, to_b = self.send("B", ["先看天气预报", "带上雨伞", "记得买票"], ["n1", "n2", "n3"])
        self.assertIn("这一页上有 1 条蓝色批注不是这个对话写的（是「paper」的对话写的）", to_b)
        self.assertIn("- 〔不是你写的〕先看天气预报\n- 带上雨伞\n- 记得买票", to_b)
        self.assertIn("｜红笔（回答过：别的对话答的）", to_b)
        self.j("POST", "/bridge/bye", {"sid": "A"})
        _, to_b2 = self.send("B", ["先看天气预报"], ["n1"])
        self.assertIn("这一页上有 1 条蓝色批注不是这个对话写的（是别的对话写的）", to_b2)
        self.assertNotIn("paper", to_b2)
        self.assertEqual(self.page_file(), before)  # 旧数据没改：没补上作者
        # 只剩查不出的那几条：一个字都不说
        self.put([tick("t1", ["b1"], req="direct-ab12cd"), note("n2", "带上雨伞", ["b1"], req=snap, y=200)])
        _, to_b3 = self.send("B", ["带上雨伞"], ["n2"])
        for word in ("不是这个对话写的", TAG):
            self.assertNotIn(word, to_b3)

    # ---------------------------------------------------------------- 快照、整本检测、几页一起交

    def test_snapshot_scan_and_send_all_say_it_too(self):
        """快照（给调用它的对话）、整本检测（调用的对话）、几页一起交（这本发往的对话）都说；长回答和小蓝点的列表里标出来。
        排队还没落下的回写里别的对话写的，「还在排队」那句不说成是它写的。"""
        self.two()
        a = by("A", "paper", self.pa)
        dot = note("d1", "车票要提前买", ["b1"], a, y=500, dot={"at": [420, 300], "t": T0 + 8000, "why": "room"})
        self.put([ts.answer_item("w1", 1, [330, 100], text="九点出门。", q="几点？", author=a), dot, note("n1", "带伞", ["r1"], a, y=200)])
        _, snap = self.app.save_submission(dict(ts.send_payload(), groups=groups(), prev_notes=["带伞"], prev_ids=["n1"]), snapshot=True, reader="B")
        self.assertIn("这一页上有 3 条蓝色批注不是这个对话写的（是「paper」的对话写的）", snap)
        self.assertIn("- 〔不是你写的〕带伞", snap)
        # A 又写回了一条，还在排队（平板没打开这一页）
        s_a, _ = self.send("A")
        self.j("POST", "/bridge/reply", {"sid": "A", "submission": s_a, "items": [{"type": "note", "anchor": "g1", "text": "排队的"}]})
        st, sc = self.j("POST", "/bridge/scan", {"sid": "B", "nb": "scratch"})
        self.assertEqual(st, 200, sc)
        text = sc["text"]
        self.assertIn("这一页上有 3 条蓝色批注不是这个对话写的（是「paper」的对话写的）", text)
        self.assertIn("下面列出的批注里标着〔不是你写的〕的是其中 2 条；另外的是：短批注「带伞」（g1）。", text)
        self.assertIn("这一页之前写回的长回答（图里的蓝色圈号；标着〔不是你写的〕的是别的对话写的）：\n- 圈号 1〔不是你写的〕（问：几点？）：九点出门。", text)
        self.assertIn("这一页收起来的是：\n- 〔不是你写的〕车票要提前买", text)
        self.assertIn("这一页还有 1 条写回的批注在排队（都不是这个对话写的）", text)
        st, sc_a = self.j("POST", "/bridge/scan", {"sid": "A", "nb": "scratch"})
        for word in ("不是这个对话写的", TAG):
            self.assertNotIn(word, sc_a["text"])
        self.assertIn("你之前在这一页写过的长回答（图里的蓝色圈号）：\n- 圈号 1（问：几点？）：九点出门。", sc_a["text"])
        self.assertIn("你之前写回这一页的 1 条批注还在排队", sc_a["text"])
        self.j("POST", "/api/notebook/target", {"nb": "scratch", "sid": "B"})
        st, r = self.j("POST", "/api/send-all", {"nb": "scratch", "only_new": False})
        self.assertEqual(st, 200, r)
        msg = (self.app.data / "submissions" / r["id"] / "message.txt").read_text("utf-8")
        self.assertIn("这一页上有 3 条蓝色批注不是这个对话写的（是「paper」的对话写的）", msg)

    def test_document_update_carries_authors_along(self):
        """导入的文档更新后，页面数据（连同还在排队的回写）整份挪到新页上：作者跟着走。"""
        self.two()
        src = Path(self.tmp.name) / "src" / "出游_v1.pdf"
        src.parent.mkdir()
        ts.make_slides(src, ["Day one: museum", "Day two: park"])
        nb = self.app.import_document(src)
        a = by("A", "paper", self.pa)
        self.app.save_page(nb, 1, json.dumps({"v": 1, "strokes": strokes(), "ai": [note("n1", "先看天气预报", ["r1"], a)], "reads": []}))
        self.app.add_pending(nb, self.app.page_key(nb, 1), {"req": "r9", "items": [{"type": "note", "text": "排队的"}], "author": a})
        time.sleep(1.1)
        ts.make_slides(src, ["Day one: museum", "Day one and a half: lunch", "Day two: park"])
        self.app.update_document(nb)
        moved = json.loads(self.app.load_page(nb, 2))
        self.assertEqual([(x["id"], x.get("author")) for x in moved["ai"]], [("n1", a)])
        self.assertEqual([e.get("author") for e in self.app.take_pending(nb, 2)], [a])

    def test_fixed_rule_no_longer_says_all_blue_is_yours(self):
        p = prompt.protocol()
        self.assertNotIn("蓝色是你之前写回来的批注", p)
        self.assertIn("蓝色是之前写回来的批注，多半是你写的（消息里说了哪几条不是，就当成纸上已有的内容）", p)


if __name__ == "__main__":
    unittest.main()

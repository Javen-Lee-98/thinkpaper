"""tools/evalset.py 的测试：用临时目录造假数据，不碰真实数据。"""
import json
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
import evalset  # noqa: E402

T = 1_700_000_000_000


def stroke(sid, t0, x, y, red=False, n=6):
    """一笔：从 (x, y) 往右下画一小段，像一个字的一笔。"""
    s = {"id": sid, "t0": t0, "w": 2.1, "pts": [[x + 4 * k, y + 3 * k, 0.5, 20 * k] for k in range(n)]}
    if red:
        s["c"] = "r"
    return s


def fake_data(tmp):
    """一页：红字一组（3 笔，回答过它）、黑字一组（3 笔）；两次投递；一份对话记录（一次当场回答、一次晚到的回答）。"""
    data, proj = Path(tmp) / "data", Path(tmp) / "projects"
    red = [stroke(f"r{k}", T + 100 * k, 100 + 30 * k, 100, red=True) for k in range(3)]
    black = [stroke(f"b{k}", T + 60000 + 100 * k, 100 + 30 * k, 400) for k in range(3)]
    page = {"v": 1, "strokes": red + black, "reads": [],
            "ai": [{"id": "w1", "type": "write", "q": "这步对吗", "on": ["r0", "r1", "r2"], "text": "对"}]}
    nb = data / "notebooks" / "scratch"
    nb.mkdir(parents=True)
    (nb / "page-0000.json").write_text(json.dumps(page), "utf-8")
    (nb / "meta.json").write_text("{}", "utf-8")
    subs = data / "submissions"
    old = {"id": "20261022-075103-1f73", "now": T + 90000,  # 旧投递：分组只有时间和颜色
           "groups": [{"id": "g1", "t0": T, "t1": T + 300, "n": 3, "red": True}]}
    new = {"id": "20261030-045223-0a53", "now": T + 90000,  # 新投递：带着每组的笔迹 id
           "groups": [{"id": "g2", "ids": ["b0", "b1", "b2"], "red": False}]}
    for m in (old, new):
        (subs / m["id"]).mkdir(parents=True)
        (subs / m["id"] / "meta.json").write_text(json.dumps(m), "utf-8")

    def line(obj):
        return json.dumps(obj, ensure_ascii=False)
    use1 = {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "u1", "name": "mcp__inkpad__ink_confirm",
            "input": {"submission": old["id"], "questions": [{"anchor": "g1", "guess": "这步对么", "question": "这是？"}]}}]}}
    res1 = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "u1",
            "content": "1. g1：这是？（你读成「这步对么」）→ 是「这步对吗」。\n（不必再把这些读法用 read 写回草稿纸，直接用于理解。）"}]}}
    use2 = {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "u2", "name": "mcp__inkpad__ink_confirm",
            "input": {"submission": new["id"], "questions": [{"anchor": "g2", "guess": "平均速度", "question": "这几个字？"}]}}]}}
    res2 = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "u2", "content": "用户还没回答，先往下做。"}]}}
    late = {"type": "user", "message": {"content": "【草稿纸·确认】你之前在草稿纸上问我拿不准的字迹（草稿本第 1 页），我现在回答了：\n"
            "1. g2：这几个字？（你读成「平均速度」）→ 对，是「平均速度」。\n请据此继续。"}}
    (proj / "p1").mkdir(parents=True)
    (proj / "p1" / "s.jsonl").write_text("\n".join(line(x) for x in (use1, res1, use2, res2, late)), "utf-8")
    return data, proj


def fake_reco(groups):
    return {gid: ["这步对吗" if i == 0 else "平均速渡"] for i, (gid, _) in enumerate(groups)}


class EvalsetTest(unittest.TestCase):
    def test_parse_confirm(self):
        inp = {"questions": [{"anchor": "g1", "guess": "ρ"}, {"anchor": "g2", "guess": "a"}, {"anchor": "g3", "guess": "b"}]}
        res = "1. g1：这是？（你读成「ρ」）→ 对，是「ρ」。\n2. g2：那个？（你读成「a」）→ 是「α」。\n3. g3：？ → 我没有回答（跳过了）"
        self.assertEqual(evalset.parse_confirm(inp, res), {"g1": "ρ", "g2": "α"})

    def test_build_picks_confirmed_and_keeps_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, proj = fake_data(tmp)
            out = data / "evalset"
            c = evalset.build(data, [str(proj)], n=5, reco=fake_reco)
            self.assertEqual((c["total"], c["confirm"]), (2, 2))          # 两组都有用户确认的读法（一次晚到）
            items = evalset.load_items(out)
            self.assertEqual(sorted(it["draft"] for it in items), ["平均速度", "这步对吗"])
            self.assertTrue(all(it["source"] == "confirm" for it in items))
            self.assertTrue((out / items[0]["img"]).is_file())
            self.assertGreater(items[0]["h"], 30)                          # 字放大了
            evalset.save_labels(out, {items[0]["key"]: {"truth": "x", "checked": True}})
            evalset.build(data, [str(proj)], n=5, reco=fake_reco)          # 再生成：核对过的答案还在
            self.assertEqual(evalset.load_labels(out)[items[0]["key"]]["truth"], "x")

    def test_score_cer(self):
        self.assertEqual(evalset.edit_distance("平均速渡", "平均速度"), 1)
        self.assertEqual(evalset.norm("Ｃ  = π d"), "C=πd")
        with tempfile.TemporaryDirectory() as tmp:
            data, proj = fake_data(tmp)
            evalset.build(data, [str(proj)], n=5, reco=fake_reco)
            out = data / "evalset"
            self.assertEqual(evalset.score(out)["n"], 0)                   # 没核对过：不算
            r = evalset.score(out, confirmed=True)
            self.assertEqual((r["n"], r["chars"]), (2, 8))
            self.assertLessEqual(r["edits"], 2)
            key = next(it["key"] for it in evalset.load_items(out) if it["draft"] == "平均速度")
            evalset.save_labels(out, {key: {"truth": "平均速度", "checked": True}})
            r = evalset.score(out)
            self.assertEqual((r["n"], r["edits"], r["cer"]), (1, 1, 0.25))

    def test_score_by_language_and_rerun(self):
        """分数按标准答案的语种分开列；reco 用现在的识别（先判断语种）重新认一遍。"""
        self.assertEqual([evalset.lang_of(t) for t in ("今天", "coffee", "买 coffee", "3.5")], ["中文", "英文", "中英混写", "符号"])
        with tempfile.TemporaryDirectory() as tmp:
            data, proj = fake_data(tmp)
            evalset.build(data, [str(proj)], n=5, reco=fake_reco)
            out = data / "evalset"
            r = evalset.score(out, confirmed=True)
            self.assertEqual((r["by"]["中文"]["n"], r["by"]["英文"]["n"], r["by"]["中英混写"]["n"]), (2, 0, 0))
            hyp, langs = evalset.run_reco(data, out, reco=lambda gs: {gid: {"text": ["平均速度"], "lang": "zh"} for gid, _ in gs})
            self.assertEqual((len(hyp), set(langs.values())), (2, {"zh"}))
            self.assertEqual(evalset.score(out, confirmed=True, hyp=hyp)["edits"], 4)  # 「这步对吗」全错 4 个字，另一组全对

    def test_serve_saves_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, proj = fake_data(tmp)
            evalset.build(data, [str(proj)], n=5, reco=fake_reco)
            out = data / "evalset"
            srv = evalset.serve(out, 0)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{srv.server_address[1]}"
            try:
                page = urllib.request.urlopen(base + "/").read().decode("utf-8")
                self.assertIn("手写评测集核对", page)
                d = json.loads(urllib.request.urlopen(base + "/data").read())
                key = d["items"][0]["key"]
                body = json.dumps({key: {"truth": "改过的", "checked": True}, "别的": {"truth": "x"}}).encode()
                req = urllib.request.Request(base + "/save", body, {"Content-Type": "application/json"})
                self.assertEqual(urllib.request.urlopen(req).status, 200)
                self.assertEqual(evalset.load_labels(out), {key: {"truth": "改过的", "checked": True}})  # 不认识的不存
                img = urllib.request.urlopen(base + "/" + d["items"][0]["img"]).read()
                self.assertTrue(img.startswith(b"\x89PNG"))
            finally:
                srv.shutdown()
                srv.server_close()


if __name__ == "__main__":
    unittest.main()

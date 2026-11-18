"""没选过对话的本子，第一次点「AI」先选发往哪个对话（2026-11-17 用户定，《产品定义》第 2 节）。
服务这一侧：没选过、连着不止一个对话、请求里又没带对话——不收（410，带 pick），不替用户定发给谁；带了对话的照收并记下；
只连着一个对话时照旧直接发给它；从「新文件」提示加进来的本子不记成发往报出文件的那个对话（同一个文件夹下可能开着几个对话）；
/ink 用的状态在这种时候给 targetUnset、不说发往谁；本子信息里带原文件所在的文件夹（平板的单子据此把那个文件夹的对话排在最前）。
例子文件是编的（值日表）。"""
import json
import sys
import time
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import test_server as ts  # noqa: E402  （不把 HttpTest 这个名字引进来：引进来的话这个文件会把它的测试再跑一遍）

send_payload = ts.send_payload


class FirstSendPicksTargetTest(unittest.TestCase):
    setUp = ts.HttpTest.setUp
    tearDown = ts.HttpTest.tearDown
    call = ts.HttpTest.call
    j = ts.HttpTest.j

    def hello(self, sid, label, folder):
        d = Path(self.tmp.name) / folder
        d.mkdir(exist_ok=True)
        self.j("POST", "/bridge/hello", {"sid": sid, "label": label, "cwd": str(d)})
        return d

    def three(self):
        """论文文件夹里两个对话，别处一个；别处那个最近打过字（以前没绑过的本子会悄悄发给它）。"""
        paper = self.hello("P1", "paper", "paper")
        self.hello("P2", "paper", "paper")
        self.hello("I", "idea", "idea")
        for sid in ("P1", "P2", "I"):
            self.j("POST", "/bridge/active", {"sid": sid, "hint": "打了一句话"})
            time.sleep(0.02)
        return paper

    def queued(self):
        return {sid: len(q) for sid, q in self.app.bridge.queues.items() if q}

    def test_unbound_notebook_with_several_sessions_is_not_sent_until_picked(self):
        self.three()
        self.assertEqual(self.app.bridge.default_target(), "I")
        self.assertTrue(self.app.target_unset("scratch"))
        st, r = self.j("POST", "/api/send", send_payload())
        self.assertEqual((st, r.get("pick")), (410, True), r)
        self.assertIn("还没选发往哪个对话", r["error"])
        st, r = self.j("POST", "/api/send-all", {"nb": "scratch", "target": "", "only_new": False})
        self.assertEqual((st, r.get("pick")), (410, True), r)
        self.assertEqual(self.queued(), {})                       # 谁都没收到
        self.assertIsNone(self.app.nb_target("scratch"))           # 也没有记成发往谁
        subs = self.app.data / "submissions"
        self.assertFalse(subs.exists() and any(subs.iterdir()))    # 没存成一次投递
        # 用户在平板上选了 P2（平板先记下，再发）：交给 P2，从此不再问
        st, r = self.j("POST", "/api/notebook/target", {"nb": "scratch", "sid": "P2"})
        self.assertEqual(st, 200, r)
        st, r = self.j("POST", "/api/send", send_payload())
        self.assertEqual((st, r["target"]), (200, "P2"), r)
        self.assertEqual(self.queued(), {"P2": 1})
        self.assertFalse(self.app.target_unset("scratch"))

    def test_request_that_names_a_session_is_taken_and_remembered(self):
        self.three()
        st, r = self.j("POST", "/api/send", send_payload(target="P1"))
        self.assertEqual((st, r["target"]), (200, "P1"), r)
        self.assertEqual(self.app.nb_target("scratch")["sid"], "P1")

    def test_single_session_is_used_without_asking(self):
        self.hello("P1", "paper", "paper")
        self.assertFalse(self.app.target_unset("scratch"))
        st, r = self.j("POST", "/api/send", send_payload())
        self.assertEqual((st, r["target"]), (200, "P1"), r)
        self.assertEqual(self.app.nb_target("scratch")["sid"], "P1")

    def test_book_added_from_an_offer_is_not_bound_to_the_reporting_session(self):
        paper = self.three()
        src = paper / "值日表.md"
        src.write_bytes("# 值日表\n\n- 周一：扫地\n".encode("utf-8"))
        st, r = self.j("POST", "/bridge/offer", {"sid": "P1", "files": [{"path": str(src)}]})
        self.assertEqual(st, 200, r)
        oid = self.j("GET", "/api/offers")[1][0]["id"]
        st, added = self.j("POST", "/api/offer-accept", {"id": oid})
        self.assertEqual(st, 200, added)
        nb = added["nb"]
        self.assertIsNone(self.app.nb_target(nb))
        info = self.j("GET", "/api/notebook?nb=" + urllib.parse.quote(nb))[1]
        # 平板的单子据此把这个文件夹的对话排在最前：两边都是完整写法（短文件名展开），比得上
        dirs = {s["sid"]: s["dir"] for s in self.j("GET", "/api/sessions")[1]["sessions"]}
        self.assertEqual(info["sourceDir"], str(paper.resolve()))
        self.assertEqual((dirs["P1"], dirs["P2"]), (info["sourceDir"], info["sourceDir"]))
        self.assertNotEqual(dirs["I"], info["sourceDir"])
        st, r = self.j("POST", "/api/send", send_payload(nb=nb))
        self.assertEqual((st, r.get("pick")), (410, True), r)
        # Claude 自己导入的本子照旧记成发往导入它的对话
        src2 = paper / "值日表二.md"
        src2.write_bytes("# 值日表二\n\n- 周二：擦窗\n".encode("utf-8"))
        st, imp = self.j("POST", "/bridge/import", {"sid": "P2", "path": str(src2)})
        self.assertEqual(st, 200, imp)
        self.assertEqual(self.app.nb_target(imp["id"])["sid"], "P2")

    def test_status_says_unset_instead_of_naming_a_target(self):
        self.three()
        self.j("POST", "/api/where", {"nb": "scratch", "page": 0})
        for sid in ("P1", "I"):
            status = self.j("GET", f"/bridge/status?sid={sid}")[1]
            self.assertEqual((status["isTarget"], status["targetUnset"], status["targetLabel"]), (False, True, ""), status)
        self.j("POST", "/api/notebook/target", {"nb": "scratch", "sid": "P1"})
        status = self.j("GET", "/bridge/status?sid=P1")[1]
        self.assertEqual((status["isTarget"], status["targetUnset"]), (True, False))
        status = self.j("GET", "/bridge/status?sid=I")[1]
        self.assertEqual((status["isTarget"], status["targetUnset"], status["targetLabel"]), (False, False, "paper"))

    def test_status_with_one_session_is_as_before(self):
        self.hello("P1", "paper", "paper")
        self.j("POST", "/api/where", {"nb": "scratch", "page": 0})
        status = self.j("GET", "/bridge/status?sid=P1")[1]
        self.assertEqual((status["isTarget"], status["targetUnset"]), (True, False))


if __name__ == "__main__":
    unittest.main()

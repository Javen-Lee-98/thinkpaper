"""改电脑上的文件（2026-11-14，阶段 C；《产品定义》第 4 节）：ink_edit 问覆盖还是另存、先留底，改完导入原地换新版，
平板上撤回；存回 PDF 同样留底、能撤回。另有问话卡片的「忽略」「全部忽略」（2026-11-14 用户在 iPad 上试过后定）。

    .venv\\Scripts\\python.exe -m unittest tests.test_edit -v

例子文件都是编的（买菜清单、游记、会议纪要），放在临时文件夹里。
"""
import ctypes
import json
import os
import sys
import threading
import time
import unittest
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # 单独跑这个文件时也找得到 test_server

import backup  # noqa: E402
import fitz  # noqa: E402
import keep  # noqa: E402
import prompt  # noqa: E402
import server  # noqa: E402
import test_server as T  # noqa: E402  只引模块（不把它的测试类引进来，免得跑两遍）

LIST0 = "# 周末买菜清单\n\n- 西红柿 三个\n- 鸡蛋 一盒\n- 青菜 一把\n"
LIST1 = "# 周末买菜清单\n\n- 西红柿 五个\n- 鸡蛋 一盒\n- 青菜 一把\n- 豆腐 一块\n"
TRIP0 = "# 秋天的游记\n\n第一天：坐早班车到山脚，路边的枫叶刚红。\n\n第二天：下山时下了一场小雨。\n"
TRIP1 = "# 秋天的游记\n\n第一天：坐早班车到山脚，路边的枫叶刚红，买了两个烤红薯。\n\n第二天：下山时下了一场小雨。\n"


class EditBase(unittest.TestCase):
    setUp = T.HttpTest.setUp
    tearDown = T.HttpTest.tearDown
    call = T.HttpTest.call
    j = T.HttpTest.j
    put_page = T.HttpTest.put_page

    def online(self, sid="B"):
        self.j("POST", "/bridge/hello", {"sid": sid, "label": "idea", "cwd": "E:\\x"})
        self.app.bridge.tablet_seen = time.time()

    def offline(self):
        self.app.bridge.tablet_seen = 0

    def src(self, name, text):
        d = Path(self.tmp.name) / "docs"
        d.mkdir(exist_ok=True)
        p = d / name
        p.write_bytes(text.encode("utf-8"))
        return p

    def imp(self, path, **extra):
        st, r = self.j("POST", "/bridge/import", dict({"sid": "B", "path": str(path)}, **extra))
        self.assertEqual(st, 200, r)
        return r

    def answer_later(self, cid, choice, delay=0.3):
        th = threading.Thread(target=lambda: (time.sleep(delay), self.j("POST", "/api/ask-answer", {"id": cid, "choice": choice})))
        th.start()
        return th

    def poll(self, sid="B"):
        return (self.j("GET", f"/bridge/poll?sid={sid}")[1] or {}).get("submission")

    def drain(self, sid="B"):
        while self.poll(sid):
            pass

    def undo(self, nb, changed=None):
        st, u = self.j("GET", f"/api/book/undo?nb={quote(nb)}")
        self.assertEqual(st, 200, u)
        body = {"nb": nb, "id": u.get("id"), "changed": u.get("changed") if changed is None else changed}
        return u, self.j("POST", "/api/book/undo", body)

    def info(self, nb):
        return self.j("GET", f"/api/notebook?nb={quote(nb)}")[1]


class OverwriteAndSaveasTest(EditBase):
    def test_overwrite_full_flow(self):
        """覆盖：卡片 → 选「覆盖」→ 留底 → Claude 改 → 导入原地换新版 → result 记着这一次 → 平板撤回：文件逐字节回到改之前、「已撤回」。"""
        self.online()
        path = self.src("买菜清单.md", LIST0)
        nb = self.imp(path)["id"]
        # 平板上点了「AI」：这一页带着一条采纳了的、在文档上的修改建议
        t = 1_700_000_000_000
        sug = {"id": "x1", "type": "suggest", "t": t, "text": "改为：西红柿 五个", "box": [100, 150, 400, 190], "verdict": "yes", "onDoc": True,
               "lay": {"x": 1044, "y": 150, "w": 336, "h": 37, "lines": ["改为"], "fs": 21, "lh": 29}, "paths": [], "hit": [1038, 146, 1380, 191]}
        self.put_page(0, [T.stroke("a", t + 1000, 600, 600)], nb=quote(nb), ai=[sug])
        st, sent = self.j("POST", "/api/send-all", {"nb": nb, "target": "B", "only_new": False})
        self.assertEqual(st, 200, sent)
        msg = self.poll()
        self.assertIn("s1（在文档上）「改为：西红柿 五个」：采纳", msg["text"])
        self.assertIn("动手前先调 mcp__inkpad__ink_edit", msg["text"])
        # ink_edit 不带 mode：平板顶上一张服务自己问的卡片，只能点选
        st, ask = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path)})
        self.assertEqual(st, 200, ask)
        cards = self.j("GET", "/api/asks")[1]
        self.assertEqual([(c["id"], c["question"], c["options"], c["write"], c["origin"]) for c in cards],
                         [(ask["ask"], "改《买菜清单.md》：覆盖原文件，还是另存一份？", ["覆盖", "另存"], False, "server")])
        self.assertEqual(self.app.keeper.history(path), [])                       # 用户没选之前什么都没动
        th = self.answer_later(ask["ask"], "覆盖")
        st, res = self.j("POST", "/bridge/edit-wait", {"id": ask["ask"], "wait": 5})
        th.join()
        self.assertEqual((st, res["mode"], res["chose"]), (200, "overwrite", "覆盖"))
        self.assertEqual(Path(res["target"]), path.resolve())
        self.assertIn(f"改 {path.resolve()} 本身", res["text"])
        self.assertIn("mcp__inkpad__ink_import", res["text"])
        hist = self.app.keeper.history(path)
        self.assertEqual([(r["kind"], r["note"]) for r in hist], [("copy", "覆盖前")])
        self.assertEqual(Path(hist[0]["copy"]).read_bytes(), LIST0.encode())     # 留底的是改之前的样子
        self.assertEqual(self.j("GET", "/api/asks")[1], [])
        self.assertIsNone(self.poll())                                            # 等着的时候选的：不另发消息
        # 同一张卡片插件重试：照第一次办的结果，不再留一份
        self.assertEqual(self.j("POST", "/bridge/edit-wait", {"id": ask["ask"], "wait": 0})[1]["eid"], res["eid"])
        # Claude 改原文件、导入：原地换新版，换新版记着是这一次修改
        path.write_bytes(LIST1.encode())
        r = self.imp(path)
        self.assertEqual(r["id"], nb)
        self.assertIsNone(r["remind"])                                            # 先调了 ink_edit：不提醒
        info = self.info(nb)
        self.assertEqual(info["changes"]["edit"], res["eid"])
        self.assertEqual((info["undo"]["edit"], info["undo"]["mode"], info["undo"]["left"]), (res["eid"], "overwrite", 1))
        # 用 result 回报：记着这一次修改
        st, rep = self.j("POST", "/bridge/reply", {"sid": "B", "submission": sent["id"], "page": 1,
                                                   "items": [{"type": "result", "anchor": "s1", "ok": True}]})
        self.assertEqual(st, 200, rep)
        pend = [e for e in self.j("GET", f"/api/pending?nb={quote(nb)}&i=0")[1] if e.get("items")]
        res_items = [it for e in pend for it in e["items"] if it["type"] == "result"]
        self.assertEqual([(it["ref"], it["ok"], it.get("edit")) for it in res_items], [("x1", True, res["eid"])])
        # 平板上撤回：先问（没在之后改过），确认后文件逐字节回到改之前，这本原地换回去，那一次记成撤回过
        u, (st, out) = self.undo(nb)
        self.assertEqual((u["can"], u["changed"], u["kind"], u["file"]), (True, False, "copy", "买菜清单.md"))
        self.assertEqual((st, out["ok"], out["action"], out["left"]), (200, True, "restored", 0))
        self.assertEqual(path.read_bytes(), LIST0.encode())
        self.assertEqual(self.info(nb)["undone"], [res["eid"]])
        self.assertTrue(self.info(nb)["changes"]["undo"])
        self.assertIsNone(self.info(nb)["undo"])                                  # 没有可撤的了：平板上不出按钮
        told = self.poll()
        self.assertTrue(told["text"].startswith("【草稿纸·撤回】我在平板上撤回了对 "), told["text"])
        self.assertIn("不用回复，也不用动手", told["text"])
        ev = [e for e in self.app.bridge.events if e["type"] == "undone"]
        self.assertEqual(ev[-1]["nb"], nb)
        # 再撤：没有可撤的（nothing），文件不动
        u2, (st, out2) = self.undo(nb)
        self.assertFalse(u2["can"])
        self.assertEqual((out2["ok"], out2["action"]), (False, "nothing"))
        self.assertEqual(path.read_bytes(), LIST0.encode())

    def test_saveas_full_flow(self):
        """另存：选「另存」→ 原文件旁边新建一份（v1 → v2，逐字节一样）→ Claude 改新文件 → 导入新文件，那本换成它 → 撤回：换回原文件，新文件留着。"""
        self.online()
        path = self.src("游记_v1.md", TRIP0)
        nb = self.imp(path)["id"]
        ask = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path)})[1]
        th = self.answer_later(ask["ask"], "另存")
        res = self.j("POST", "/bridge/edit-wait", {"id": ask["ask"], "wait": 5})[1]
        th.join()
        new = path.with_name("游记_v2.md")
        self.assertEqual((res["mode"], Path(res["target"])), ("saveas", new.resolve()))
        self.assertIn(f"已经另存了一份：{new.resolve()}", res["text"])
        self.assertIn("原文件", res["text"])
        self.assertEqual(new.read_bytes(), TRIP0.encode())
        self.assertEqual(path.read_bytes(), TRIP0.encode())
        self.assertEqual(self.app.keeper.history(path), [])                       # 原文件没动，不留副本
        rec = self.app.keeper.history(new)
        self.assertEqual([(r["kind"], r["note"], Path(r["path"]).name) for r in rec], [("saveas", "另存前", "游记_v1.md")])
        new.write_bytes(TRIP1.encode())
        r = self.imp(new)                                                         # 不用 replace：那本跟着换成新文件
        self.assertEqual(r["id"], "book:游记_v2.pdf")
        self.assertNotIn("book:游记_v1.pdf", [n["id"] for n in self.app.notebooks()])
        info = self.info(r["id"])
        self.assertEqual((info["undo"]["mode"], info["undo"]["back"], info["changes"]["edit"]), ("saveas", "游记_v1.md", res["eid"]))
        u, (st, out) = self.undo(r["id"])
        self.assertEqual((u["kind"], u["changed"]), ("saveas", False))
        self.assertEqual((st, out["ok"], out["action"], out["id"]), (200, True, "switched", "book:游记_v1.pdf"))
        self.assertEqual(new.read_bytes(), TRIP1.encode())                        # 另存出来的留在电脑上，不删
        self.assertEqual(path.read_bytes(), TRIP0.encode())
        self.assertEqual(self.app.sources()["游记_v1.pdf"]["src"], str(path.resolve()))
        self.assertIn(res["eid"], self.info("book:游记_v1.pdf")["undone"])
        told = self.poll()
        self.assertIn("撤回了那次另存", told["text"])
        self.assertIn("没删", told["text"])

    def test_mode_given_does_not_ask(self):
        """用户在对话里说了覆盖还是另存：带 mode，不弹卡片、不等。"""
        self.online()
        path = self.src("会议纪要.md", "# 周三例会纪要\n\n- 下周换会议室\n")
        st, res = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path), "mode": "overwrite"})
        self.assertEqual((st, res["done"], res["mode"]), (200, True, "overwrite"))
        self.assertEqual(self.j("GET", "/api/asks")[1], [])
        self.assertIsNone(res["book"])                                            # 没导入过：不拦，照样留底
        self.assertIn("没有导入过草稿纸", res["text"])
        self.assertEqual(len(self.app.keeper.history(path)), 1)
        st, res2 = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path), "mode": "saveas"})
        self.assertEqual(Path(res2["target"]).name, "会议纪要 (改1).md")
        self.assertEqual(self.j("GET", "/api/asks")[1], [])


class AskCardTest(EditBase):
    def test_card_times_out_and_late_choice_becomes_a_message(self):
        """一分半没选：插件拿到「还没选、停手等着」；之后选了，作为一条新消息送进对话，写明哪个文件、选了什么、带 mode 再调一次。"""
        self.online()
        path = self.src("买菜清单.md", LIST0)
        ask = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path)})[1]
        st, p1 = self.j("POST", "/bridge/edit-wait", {"id": ask["ask"], "wait": 0.2})
        self.assertTrue(p1["pending"])
        st, p2 = self.j("POST", "/bridge/edit-wait", {"id": ask["ask"], "wait": 0.2, "last": True})
        self.assertTrue(p2["pending"])
        self.assertEqual(p2["text"], prompt.EDIT_PENDING)
        self.assertIn("不要替用户选", p2["text"])
        self.assertIn("也不要先动这个文件", p2["text"])
        self.assertEqual(self.app.keeper.history(path), [])
        self.assertEqual(self.j("POST", "/api/ask-answer", {"id": ask["ask"], "choice": "另存"})[0], 200)
        late = self.poll()
        self.assertTrue(late["text"].startswith(f"【草稿纸·回答】你之前要改 {path.resolve()}，在平板上问我覆盖原文件还是另存一份。我现在选了「另存」。"), late["text"])
        self.assertIn(f"mcp__inkpad__ink_edit（path={path.resolve()}，mode=saveas）", late["text"])
        # 晚到的回答只是消息：服务不替 Claude 先另存
        self.assertFalse(path.with_name("买菜清单 (改1).md").exists())
        self.assertEqual(self.app.keeper.history(path), [])

    def test_offline_tablet_asks_in_the_conversation(self):
        self.offline()
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        self.offline()
        path = self.src("买菜清单.md", LIST0)
        st, r = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path)})
        self.assertEqual((st, r["offline"]), (200, True))
        self.assertIn("在对话里问用户", r["text"])
        self.assertIn("再带上 mode", r["text"])
        self.assertEqual(self.app.bridge.asks, {})
        self.assertEqual(self.app.keeper.history(path), [])

    def test_mode_withdraws_the_open_card(self):
        """卡片还没答，Claude 又带着 mode 调了（用户在对话里说了）：卡片撤下，晚到的回答不会让它再办一次。"""
        self.online()
        path = self.src("买菜清单.md", LIST0)
        ask = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path)})[1]
        self.j("POST", "/bridge/edit-wait", {"id": ask["ask"], "wait": 0.1, "last": True})
        self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path), "mode": "overwrite"})
        self.assertEqual(self.j("GET", "/api/asks")[1], [])
        self.assertEqual(self.j("POST", "/api/ask-answer", {"id": ask["ask"], "choice": "另存"})[0], 404)
        self.assertTrue(self.j("POST", "/bridge/edit-wait", {"id": ask["ask"], "wait": 0})[1]["withdrawn"])
        self.assertIsNone(self.poll())
        self.assertEqual(len(self.app.keeper.history(path)), 1)

    def test_bad_requests_and_keep_failure(self):
        self.online()
        path = self.src("买菜清单.md", LIST0)
        for body in ({"sid": "B"}, {"sid": "B", "path": "买菜清单.md"}, {"sid": "B", "path": str(path.with_name("没有.md"))},
                     {"sid": "B", "path": str(path.parent)}, {"sid": "B", "path": str(path), "mode": "replace"}):
            self.assertEqual(self.j("POST", "/bridge/edit", body)[0], 400, body)
        nb = self.imp(path)["id"]
        own = self.app.books / nb[5:]                                            # 草稿纸自己的数据（导入转成的 PDF）不能改
        st, r = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(own), "mode": "overwrite"})
        self.assertEqual(st, 400)
        self.assertIn("草稿纸自己的数据", r["error"])
        self.assertEqual(self.app.bridge.asks, {})
        # 留底做不成（留底文件夹的位置被一个文件占了）：报错、叫 Claude 别动原文件；另存也不建新文件
        self.app.keeper = keep.Keeper(Path(self.tmp.name) / "blocked")
        (Path(self.tmp.name) / "blocked").write_text("占位", "utf-8")
        st, r = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path), "mode": "overwrite"})
        self.assertEqual(st, 400)
        self.assertIn("覆盖前没能把原文件留底", r["error"])
        self.assertIn("原文件不要动", r["error"])
        self.assertEqual(path.read_bytes(), LIST0.encode())
        st, r = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path), "mode": "saveas"})
        self.assertEqual(st, 400)
        self.assertIn("先别改任何文件", r["error"])

    def test_saveas_naming_never_overwrites(self):
        """另存的名字：v 加数字往后加；已经有的名字往后顺延；只用独占方式新建，名字刚好被占了就再往后，绝不覆盖。"""
        self.online()
        path = self.src("清单 v3.md", LIST0)
        taken = path.with_name("清单 v4.md")
        taken.write_bytes(b"someone else's file")
        res = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path), "mode": "saveas"})[1]
        self.assertEqual(Path(res["target"]).name, "清单 v5.md")
        self.assertEqual(taken.read_bytes(), b"someone else's file")
        # 算名字和新建之间那个名字被别的程序占了：独占新建失败，往后顺延
        race = path.with_name("清单 v6.md")
        real_next = server.next_name
        calls = []

        def racing(p):
            calls.append(p)
            if len(calls) == 1:
                race.write_bytes(b"appeared just now")
                return str(race)
            return real_next(p)
        server.next_name = racing
        try:
            res2 = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path), "mode": "saveas"})[1]
        finally:
            server.next_name = real_next
        self.assertEqual(race.read_bytes(), b"appeared just now")
        self.assertEqual(Path(res2["target"]).name, "清单 v7.md")
        self.assertEqual(Path(res2["target"]).read_bytes(), LIST0.encode())
        self.assertEqual(path.read_bytes(), LIST0.encode())


class UndoTest(EditBase):
    def edit_round(self, path, text):
        """一次带 mode 的覆盖：留底、改、导入（平板不在线：导入不等它先存笔迹）。"""
        res = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path), "mode": "overwrite"})[1]
        path.write_bytes(text.encode())
        self.imp(path)
        return res["eid"]

    def test_seven_edits_keep_five_and_undo_five_times(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        self.offline()
        texts = [f"# 周末买菜清单\n\n- 第 {k} 版：鸡蛋 {k} 盒\n" for k in range(8)]
        path = self.src("买菜清单.md", texts[0])
        nb = self.imp(path)["id"]
        eids = [self.edit_round(path, texts[k]) for k in range(1, 8)]
        self.assertEqual(len(self.app.keeper.history(path)), 5)
        self.assertEqual(Path(self.app.keeper.original(path)["copy"]).read_bytes(), texts[0].encode())  # 第一次改之前的原件永远留着
        for k in range(5):                                                        # 撤回 5 次：一版版回去
            u, (st, out) = self.undo(nb)
            self.assertEqual((st, out["action"], out["left"]), (200, "restored", 4 - k))
            self.assertEqual(path.read_bytes(), texts[6 - k].encode())
            self.assertEqual(u["edit"], eids[6 - k])
        self.assertEqual(sorted(self.info(nb)["undone"]), sorted(eids[2:]))
        self.assertIsNone(self.info(nb)["undo"])                                  # 第 6 次：没有了，平板上不出按钮
        u, (st, out) = self.undo(nb)
        self.assertEqual((u["can"], out["action"]), (False, "nothing"))
        self.assertEqual(path.read_bytes(), texts[2].encode())

    def test_changed_after_the_edit_keeps_an_aside_copy(self):
        """那次修改之后文件又改过：确认那一句要说明；撤回前把现在这份另留一份；确认时说的和现在对不上就不撤（409）。"""
        self.online()
        path = self.src("买菜清单.md", LIST0)
        nb = self.imp(path)["id"]
        self.offline()
        self.edit_round(path, LIST1)
        u = self.j("GET", f"/api/book/undo?nb={quote(nb)}")[1]
        self.assertFalse(u["changed"])
        later = LIST1 + "- 牛奶 两盒\n"
        path.write_bytes(later.encode())                                          # 用户自己在电脑上又改了
        u = self.j("GET", f"/api/book/undo?nb={quote(nb)}")[1]
        self.assertTrue(u["changed"])
        st, r = self.j("POST", "/api/book/undo", {"nb": nb, "id": u["id"], "changed": False})  # 确认时没说明的：不撤
        self.assertEqual(st, 409)
        st, r = self.j("POST", "/api/book/undo", {"nb": nb, "id": "20000101-000000-000000", "changed": True})
        self.assertEqual(st, 409)
        self.assertEqual(path.read_bytes(), later.encode())
        st, out = self.j("POST", "/api/book/undo", {"nb": nb, "id": u["id"], "changed": True})
        self.assertEqual((st, out["action"]), (200, "restored"))
        self.assertEqual(path.read_bytes(), LIST0.encode())
        self.assertEqual(Path(out["aside"]).read_bytes(), later.encode())        # 后来改的那份另留着
        self.assertEqual([a["note"] for a in self.app.keeper.asides(path)], ["撤回前"])
        told = self.poll()
        self.assertIn(f"另留在 {out['aside']}", told["text"])

    def test_skipped_and_failed_leave_the_file_alone(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        self.offline()
        path = self.src("买菜清单.md", LIST0)
        nb = self.imp(path)["id"]
        self.edit_round(path, LIST1)
        self.edit_round(path, LIST1 + "- 葱 一把\n")
        # 写不回去（文件正被别的程序开着，只许别人读）：failed，文件没动，留底还在
        if sys.platform == "win32":
            from ctypes import wintypes
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.CreateFileW.restype = wintypes.HANDLE
            k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
            h = k32.CreateFileW(str(path), 0x80000000, 1, None, 3, 0x80, None)
            self.assertNotEqual(h, wintypes.HANDLE(-1).value)
            try:
                u, (st, out) = self.undo(nb)
            finally:
                k32.CloseHandle(h)
            self.assertEqual((st, out["ok"], out["action"]), (200, False, "failed"))
            self.assertIn("占用", out["message"])
            self.assertEqual(path.read_bytes(), (LIST1 + "- 葱 一把\n").encode())
            self.assertEqual(len(self.app.keeper.history(path)), 2)
            self.assertEqual(self.info(nb)["undone"], [])
        # 最近那一版的留底副本被手动删了：skipped，文件没动，这条记录去掉；再撤就是更早那一版
        Path(self.app.keeper.history(path)[0]["copy"]).unlink()
        u, (st, out) = self.undo(nb)
        self.assertEqual((out["ok"], out["action"]), (False, "skipped"))
        self.assertEqual(path.read_bytes(), (LIST1 + "- 葱 一把\n").encode())
        u, (st, out) = self.undo(nb)
        self.assertEqual((out["ok"], out["action"]), (True, "restored"))
        self.assertEqual(path.read_bytes(), LIST0.encode())

    def test_not_a_book_cannot_undo(self):
        self.assertEqual(self.j("GET", "/api/book/undo?nb=scratch")[0], 400)
        self.assertEqual(self.j("POST", "/api/book/undo", {"nb": "scratch"})[0], 400)

    def test_undo_message_only_to_a_live_conversation(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        self.offline()
        path = self.src("买菜清单.md", LIST0)
        nb = self.imp(path)["id"]
        self.edit_round(path, LIST1)
        self.drain()
        self.j("POST", "/bridge/bye", {"sid": "B"})                               # 改它的那个对话关了
        u, (st, out) = self.undo(nb)
        self.assertTrue(out["ok"])
        self.assertIsNone(out["told"])
        self.assertEqual(self.app.bridge.queues.get("B") or [], [])


class SavePdfUndoTest(EditBase):
    def test_save_pdf_keeps_and_undo_restores_bytes(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        lib = Path(self.tmp.name) / "lib"
        lib.mkdir()
        src = lib / "旅行路线.pdf"
        T.make_pdf(src, text="Day 1: train to the lake", pages=2)
        before = src.read_bytes()
        self.offline()
        nb = self.imp(src)["id"]                                                 # 导入时这本发往 B：撤回后告诉 B
        old_bk = self.app.data / "backups"                                       # 以前的备份：留着不动
        old_bk.mkdir(parents=True, exist_ok=True)
        (old_bk / "旅行路线.20261101-000000.原件.pdf").write_bytes(b"old backup")
        t = 1_700_000_000_000
        self.app.save_page(nb, 0, json.dumps({"v": 1, "ai": [], "reads": [], "strokes": [T.line_stroke("a", t, 100, 200, 300, 200)]}))
        st, res = self.j("POST", "/api/book/save-pdf", {"nb": nb})
        self.assertEqual((st, res["undo"]), (200, True), res)
        self.assertNotEqual(src.read_bytes(), before)
        hist = self.app.keeper.history(src)
        self.assertEqual([r["note"] for r in hist], ["存回 PDF 前"])
        self.assertEqual(Path(hist[0]["copy"]).read_bytes(), before)
        info = self.info(nb)
        self.assertEqual(info["undo"]["mode"], "savepdf")
        u, (st, out) = self.undo(nb)
        self.assertEqual((u["mode"], u["changed"]), ("savepdf", False))
        self.assertEqual((st, out["action"], out["mode"]), (200, "restored", "savepdf"))
        self.assertEqual(src.read_bytes(), before)                               # 逐字节回到存回之前
        self.assertEqual((old_bk / "旅行路线.20261101-000000.原件.pdf").read_bytes(), b"old backup")
        self.assertFalse(self.app.source_changed(nb[5:]))                        # 撤回后不算「原文件改过」
        told = self.poll()
        self.assertIn("撤回了上一次「存回 PDF」", told["text"])


class ImportRemindTest(EditBase):
    def test_import_reminds_when_changed_without_keep(self):
        self.j("POST", "/bridge/hello", {"sid": "B", "label": "idea", "cwd": "E:\\x"})
        self.offline()
        path = self.src("买菜清单.md", LIST0)
        nb = self.imp(path)["id"]
        time.sleep(1.1)  # 留底时刻按秒记：和导入错开
        path.write_bytes(LIST1.encode())                                          # 没先调 ink_edit 就改了
        r = self.imp(path)
        self.assertEqual(r["id"], nb)                                             # 照样导入（不拦）
        self.assertEqual(r["remind"], prompt.IMPORT_REMIND)
        time.sleep(1.1)
        self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path), "mode": "overwrite"})
        path.write_bytes(LIST0.encode())
        self.assertIsNone(self.imp(path)["remind"])
        self.assertIsNone(self.imp(path)["remind"])                               # 没改过：不提醒


class IgnoreTest(EditBase):
    def test_ignore_while_waiting_tells_claude(self):
        self.online()
        r = self.j("POST", "/bridge/ask", {"sid": "B", "question": "周六去哪家超市？", "options": ["东门", "西门"]})[1]
        th = threading.Thread(target=lambda: (time.sleep(0.3), self.j("POST", "/api/ask-ignore", {"id": r["id"]})))
        th.start()
        st, ans = self.j("POST", "/bridge/ask-wait", {"id": r["id"], "wait": 5})
        th.join()
        self.assertEqual(ans["answer"], {"ignored": True})
        self.assertEqual(ans["text"], prompt.ASK_IGNORED)
        for must in ("用户忽略了这个问题，没有回答", "不要再问同一个问题", "按最稳妥的做法继续", "在对话里说明", "不要替用户做有风险的选择"):
            self.assertIn(must, ans["text"])
        self.assertEqual(self.j("GET", "/api/asks")[1], [])
        self.assertIsNone(self.poll())
        self.assertEqual(self.j("POST", "/api/ask-ignore", {"id": r["id"]})[0], 404)

    def test_ignore_after_the_tool_stopped_waiting_sends_nothing(self):
        self.online()
        r = self.j("POST", "/bridge/ask", {"sid": "B", "question": "游记要不要加照片？", "options": ["加", "不加"]})[1]
        self.assertTrue(self.j("POST", "/bridge/ask-wait", {"id": r["id"], "wait": 0.1, "last": True})[1]["pending"])
        self.assertEqual(self.j("POST", "/api/ask-ignore", {"id": r["id"]})[0], 200)
        self.assertIsNone(self.poll())                                            # 已经不等了：不往对话里送消息
        self.assertEqual(self.j("GET", "/api/asks")[1], [])
        state = json.loads((self.app.data / "bridge_state.json").read_text("utf-8"))
        self.assertEqual(state["asks"], [])                                       # 刷新、重启后也不回来
        again = T.make_app(self.tmp.name)
        self.assertEqual([c for c in again.bridge.asks.values() if c["answer"] is None], [])

    def test_ignore_calls_back_once_with_ignored(self):
        self.online()
        got = []
        card = self.app.post_card("B", question="服务自己问的", options=["好"], write=False, origin="server",
                                  on_answer=lambda c, a: got.append(a))
        self.assertEqual(self.j("POST", "/api/ask-ignore", {"id": card["id"]})[0], 200)
        self.assertEqual(got, [{"ignored": True}])
        res = self.app.post_card("B", "result", text="结果")
        self.assertEqual(self.j("POST", "/api/ask-ignore", {"id": res["id"]})[0], 400)  # 结果卡片没有「忽略」，点「知道了」

    def test_edit_card_ignored_leaves_everything_alone(self):
        self.online()
        path = self.src("买菜清单.md", LIST0)
        before = sorted(p.name for p in path.parent.iterdir())
        ask = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path)})[1]
        th = threading.Thread(target=lambda: (time.sleep(0.3), self.j("POST", "/api/ask-ignore", {"id": ask["ask"]})))
        th.start()
        st, res = self.j("POST", "/bridge/edit-wait", {"id": ask["ask"], "wait": 5})
        th.join()
        self.assertEqual((st, res.get("ignored")), (200, True))
        self.assertEqual(res["text"], prompt.EDIT_IGNORED)
        self.assertIn("这次不要改这个文件", res["text"])
        self.assertEqual(path.read_bytes(), LIST0.encode())
        self.assertEqual(sorted(p.name for p in path.parent.iterdir()), before)  # 没建新文件
        self.assertEqual(self.app.keeper.history(path), [])                       # 没留底
        self.assertFalse((self.app.data / "keep").exists() and any((self.app.data / "keep").iterdir()))
        # 工具已经不等了才忽略：不送消息
        ask2 = self.j("POST", "/bridge/edit", {"sid": "B", "path": str(path)})[1]
        self.j("POST", "/bridge/edit-wait", {"id": ask2["ask"], "wait": 0.1, "last": True})
        self.j("POST", "/api/ask-ignore", {"id": ask2["ask"]})
        self.assertIsNone(self.poll())
        self.assertEqual(self.app.keeper.history(path), [])

    def test_ignore_all_clears_each_kind(self):
        """全部忽略：问题卡片按忽略、字迹确认卡片按「看不清，跳过」、结果卡片按「知道了」；都清掉、不回来、不往对话里送消息。"""
        self.online()
        self.put_page(0, [T.stroke("a", 1_700_000_000_000, 100, 100)])
        scan = self.j("POST", "/bridge/scan", {"sid": "B"})[1]
        q = self.j("POST", "/bridge/ask", {"sid": "B", "question": "清单里加不加牛奶？", "options": ["加", "不加"]})[1]
        c = self.j("POST", "/bridge/confirm", {"sid": "B", "submission": scan["id"], "questions": [{"anchor": "g1", "guess": "鸡蛋"}]})[1]
        r = self.j("POST", "/bridge/ask", {"sid": "B", "result": "会议纪要整理好了：一共三条。"})[1]
        self.drain()
        st, out = self.j("POST", "/api/cards/ignore-all", {"ids": [q["id"], c["id"], r["id"], "nope"]})
        self.assertEqual((st, out["ignored"]), (200, 3))
        self.assertEqual(self.j("GET", "/api/asks")[1], [])
        self.assertEqual(self.j("GET", "/api/confirms")[1], [])
        b = self.app.bridge
        self.assertEqual((b.asks[q["id"]]["answer"], b.asks[r["id"]]["answer"]), ({"ignored": True}, {"seen": True}))
        self.assertEqual(b.confirms[c["id"]]["answers"], [{"skip": True}])
        self.assertIn("跳过", self.j("POST", "/bridge/confirm-wait", {"id": c["id"], "wait": 0})[1]["text"])
        self.assertEqual(self.j("POST", "/bridge/ask-wait", {"id": q["id"], "wait": 0})[1]["text"], prompt.ASK_IGNORED)
        self.assertIsNone(self.poll())
        state = json.loads((self.app.data / "bridge_state.json").read_text("utf-8"))
        self.assertEqual((state["asks"], state.get("confirms", [])), ([], []))
        self.assertEqual(self.j("POST", "/api/cards/ignore-all", {"ids": [q["id"], c["id"], r["id"]]})[1]["ignored"], 0)
        # Claude 已经不等了的（过了约一分半）：问题卡片、字迹确认卡片都不往对话里送消息（忽略不把对话吵醒）
        q2 = self.j("POST", "/bridge/ask", {"sid": "B", "question": "游记要不要配照片？", "options": ["配", "不配"]})[1]
        c2 = self.j("POST", "/bridge/confirm", {"sid": "B", "submission": scan["id"], "questions": [{"anchor": "g1", "guess": "牛奶"}]})[1]
        self.assertTrue(self.j("POST", "/bridge/ask-wait", {"id": q2["id"], "wait": 0, "last": True})[1]["pending"])
        self.assertTrue(self.j("POST", "/bridge/confirm-wait", {"id": c2["id"], "wait": 0, "last": True})[1]["pending"])
        self.assertEqual(self.j("POST", "/api/cards/ignore-all", {"ids": [q2["id"], c2["id"]]})[1]["ignored"], 2)
        self.assertIsNone(self.poll())
        # 对照：一张一张点「看不清，跳过」的晚到确认，照旧作为消息送进对话
        c3 = self.j("POST", "/bridge/confirm", {"sid": "B", "submission": scan["id"], "questions": [{"anchor": "g1", "guess": "面包"}]})[1]
        self.j("POST", "/bridge/confirm-wait", {"id": c3["id"], "wait": 0, "last": True})
        self.j("POST", "/api/confirm-answer", {"id": c3["id"], "answers": []})
        self.assertTrue(self.poll()["text"].startswith("【草稿纸·确认】"))


class RulesAndBackupTest(unittest.TestCase):
    OLD = ("不覆盖原文件", "新文件放进项目", "导入同一个文件，平板上原地更新", "改过的文档再导入一次就原地更新")

    def test_rule_text_says_one_thing(self):
        """《产品定义》第 4 节：以前「新文件放进项目，不覆盖原文件」和「改原文件再原地更新」两种说法互相矛盾，删了；
        换成「动手前调 ink_edit（问覆盖还是另存、先留底）→ 按返回的路径改 → ink_import → result」。"""
        texts = [prompt.protocol(), prompt.verdict_block([{"id": "s1", "ref": "x", "kind": "suggest", "text": "改为：五个", "verdict": "yes", "on": "doc"}]),
                 prompt.role_facts({"role": {"page": "editable", "src": "E:\\docs\\清单.docx"}, "groups": []})]
        for t in texts:
            for bad in self.OLD:
                self.assertNotIn(bad, t)
        proto = prompt.protocol()  # 固定说明里「我」换成了「用户」
        for must in ("- 改文件：", "动手前先调 mcp__inkpad__ink_edit", "覆盖原文件还是另存一份", "不替用户选", "按它返回的路径改",
                     "mcp__inkpad__ink_import 导入改好的那个文件", "result 逐条回报", "用户在对话里打字让你改已导入的文档也一样先调 ink_edit",
                     "就带上 mode", "没说的在对话里问用户", "一次 ink_edit 只办一个文件", "这一轮要改同一个文件的几处合起来只调一次",
                     "要改两个文件就调两次", "下一轮再改，再调", "用户点了「忽略」，这次就不改这个文件",
                     "要生成或修改文件就照做（改已导入的文档照「改文件」那一条走）", "【草稿纸·撤回】是用户在平板上撤回了你的一次修改"):
            self.assertIn(must, proto)
        self.assertIn("用户也可能点「忽略」不答：忽略了的问题不要再问。", proto)
        self.assertIn("先调 mcp__inkpad__ink_edit", texts[1])
        self.assertIn("要改它，先调 mcp__inkpad__ink_edit", texts[2])
        plug = Path(__file__).resolve().parents[2] / "inkpad-plugin" / "inkpad" / "hooks" / "register.tsx"
        if plug.is_file():  # 插件说明也不再有那两种说法
            src = plug.read_text("utf-8")
            for bad in self.OLD + ("同一个文件改过后再导入",):
                self.assertNotIn(bad, src)
            self.assertIn("name: 'ink_edit'", src)

    def test_daily_backup_leaves_keep_out(self):
        with __import__("tempfile").TemporaryDirectory() as tmp:
            app = T.make_app(tmp)
            f = Path(tmp) / "买菜清单.md"
            f.write_text(LIST0, "utf-8")
            app.keeper.keep(f, "覆盖前")
            app.record_edit(app.keeper.history(f)[0], f, "overwrite", f)
            self.assertTrue(any((app.data / "keep").rglob("*.md")))
            out = backup.daily(app.data, app.books, now=datetime(2026, 11, 14, 3))
            names = zipfile.ZipFile(out).namelist()
            self.assertFalse(any(n.startswith("data/keep/") for n in names), [n for n in names if "keep" in n])
            self.assertIn("data/edits.json", names)                               # 每次修改的记录是小文件：照常备份


if __name__ == "__main__":
    unittest.main()

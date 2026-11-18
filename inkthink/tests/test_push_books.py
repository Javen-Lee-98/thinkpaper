"""推送按项目文件夹各一本（2026-11-17 用户定，《产品定义》第 2 节「本子、对话、AI 的关系」）。服务这一侧：
- 哪个文件夹里的对话推的页（ink_show，/bridge/show）进那个文件夹自己的一本，名字「推送 · 文件夹名」；不同地方的同名文件夹带上一级
  文件夹名；对话没有文件夹的进「推送」。文件夹按完整写法比（大小写、末尾的斜杠不算）。服务重启后还在；同一个文件夹再推还进同一本
  （改过名也是）；删掉（挪开留着）以后再推，新开一本。
- 每页记下是谁推的（sid、文件夹名、cwd、哪个 AI）和推的时刻；在哪一页上点「AI」就发回推这一页的对话，推页面时不再把整本绑给它。
- 推的对话不在了：先问（410，说的是推这一页的那个）；选了以后这一本里原本也该发给它的页都改发到选的这个（另记 to，by 不改）；
  用户在抽屉里主动换、/ink here：改的是同一个对话推的那一组。
- 推送本子和普通本子一样能改名、删除、进文件夹；只在本地的推不进去、不另开一本；以前那本「Claude 推送」有页时照旧能用、能删。
例子文件是编的（花园、值日表）。"""
import json
import sys
import time
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf as fitz  # noqa: E402

import test_server as ts  # noqa: E402  （不把 HttpTest 这个名字引进来：引进来的话这个文件会把它的测试再跑一遍）
from test_prompt_rules import REGISTER, tool_desc  # noqa: E402

import prompt  # noqa: E402

send_payload = ts.send_payload


class PushBooksTest(unittest.TestCase):
    setUp = ts.HttpTest.setUp
    tearDown = ts.HttpTest.tearDown
    call = ts.HttpTest.call
    j = ts.HttpTest.j
    put_page = ts.HttpTest.put_page

    def hello(self, sid, label, folder, **extra):
        d = Path(self.tmp.name) / folder
        d.mkdir(parents=True, exist_ok=True)
        self.j("POST", "/bridge/hello", dict({"sid": sid, "label": label, "cwd": str(d)}, **extra))
        return d

    def img(self, name="花园.png"):
        p = Path(self.tmp.name) / name
        if not p.exists():
            fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 60, 40), 0).save(str(p))
        return p

    def show(self, sid, title=None, path=None):
        body = {"sid": sid, "path": str(path or self.img())}
        if title:
            body["title"] = title
        st, r = self.j("POST", "/bridge/show", body)
        self.assertEqual(st, 200, r)
        return r

    def info(self, nb):
        return self.j("GET", "/api/notebook?nb=" + urllib.parse.quote(nb))[1]

    def send(self, nb, page, target=""):
        return self.j("POST", "/api/send", send_payload(target=target, nb=nb, page=page))

    def queued(self):
        return {sid: len(q) for sid, q in self.app.bridge.queues.items() if q}

    def drain(self):
        for q in self.app.bridge.queues.values():
            q.clear()

    def ids(self):
        return [n["id"] for n in self.j("GET", "/api/notebooks")[1]]

    # ---------------------------------------------------------------- 一个文件夹一本

    def test_each_folder_gets_its_own_book_named_after_it(self):
        self.hello("A", "paper", "proj/paper")
        self.hello("B", "idea", "proj/idea")
        a, b = self.show("A", "图一"), self.show("B", "图二")
        self.assertNotEqual(a["nb"], b["nb"])
        self.assertEqual((a["nbTitle"], b["nbTitle"]), ("推送 · paper", "推送 · idea"))
        self.assertEqual((a["page"], b["page"]), (0, 0))
        names = {n["id"]: n["title"] for n in self.j("GET", "/api/notebooks")[1]}
        self.assertEqual((names[a["nb"]], names[b["nb"]]), ("推送 · paper", "推送 · idea"))
        self.assertNotIn("board", names)                                   # 新的推送不进以前那本
        # 推送本子排在自己建的本子后面、导入的书前面（不钉在最上面：最上面只有草稿本）
        pad = self.j("POST", "/api/notebook/new", {"title": "随笔"})[1]["id"]
        order = self.ids()
        self.assertEqual(order[0], "scratch")
        self.assertLess(order.index(pad), order.index(a["nb"]))
        # 数据在 notebooks/board-<编号>/，登记在 boards.json
        reg = json.loads((self.app.data / "notebooks" / "boards.json").read_text("utf-8"))
        self.assertEqual({"board:" + x["id"] for x in reg}, {a["nb"], b["nb"]})
        self.assertTrue((self.app.data / "notebooks" / ("board-" + a["nb"][6:]) / "bg-0000.png").is_file())
        self.assertFalse((self.app.data / "notebooks" / "board").exists())  # 以前那本的目录也不再预先建

    def test_same_folder_two_sessions_share_one_book_and_folder_is_compared_by_full_path(self):
        d = self.hello("P1", "paper", "proj/paper")
        # 同一个文件夹，写法不同（大小写、末尾的斜杠；临时目录在这台电脑上是短文件名（8.3）的写法，这里换成展开了的）：还是同一个
        self.j("POST", "/bridge/hello", {"sid": "P2", "label": "paper", "cwd": str(d.resolve()).upper() + "\\"})
        r1, r2 = self.show("P1", "一"), self.show("P2", "二")
        self.assertEqual(r1["nb"], r2["nb"])
        self.assertEqual((r1["page"], r2["page"]), (0, 1))
        pages = self.app.board_index(r1["nb"])["pages"]
        self.assertEqual([p["by"]["sid"] for p in pages], ["P1", "P2"])

    def test_same_named_folders_elsewhere_carry_the_parent_name_and_no_folder_is_push(self):
        self.hello("X", "paper", "x/paper")
        self.hello("Y", "paper", "y/paper")
        rx, ry = self.show("X"), self.show("Y")
        self.assertEqual((self.app.nb_title(rx["nb"]), self.app.nb_title(ry["nb"])), ("推送 · paper（x）", "推送 · paper（y）"))
        self.j("POST", "/bridge/hello", {"sid": "N", "label": "", "cwd": ""})  # 对话没有文件夹
        rn = self.show("N")
        self.assertEqual(rn["nbTitle"], "推送")
        # 平板的提示说明是哪个文件夹的对话推的（没有文件夹的不说）
        shows = [e for e in self.j("GET", "/api/events?since=0&wait=0")[1]["events"] if e["type"] == "show"]
        # （X 推的时候还没有别处的同名文件夹，那时说的就是「paper」；之后它的名字跟着带上一级文件夹名）
        self.assertEqual([(e["nb"], e["folder"]) for e in shows], [(rx["nb"], "paper"), (ry["nb"], "paper（y）"), (rn["nb"], "")])

    def test_each_page_records_who_pushed_it_and_the_ai(self):
        self.hello("A", "paper", "proj/paper")
        self.hello("C", "paper", "proj/paper", ai="Codex")
        self.show("A", "一")
        nb = self.show("C", "二")["nb"]
        p = self.app.board_index(nb)["pages"]
        cwd = str(Path(self.tmp.name) / "proj/paper")
        self.assertEqual(p[0]["by"], {"sid": "A", "label": "paper", "cwd": cwd, "ai": "Claude"})  # 没报 ai 的记 Claude
        self.assertEqual(p[1]["by"]["ai"], "Codex")
        self.assertRegex(p[0]["t"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$")
        info = self.info(nb)
        self.assertEqual([pi["push"]["sid"] for pi in info["pageInfo"]], ["A", "C"])
        self.assertIsNone(info["target"])                                  # 不把整本绑给推的对话
        self.assertIsNone(self.app.nb_target(nb))

    def test_survives_restart_and_rename_keeps_the_book(self):
        self.hello("A", "paper", "proj/paper")
        nb = self.show("A", "一")["nb"]
        st, r = self.j("POST", "/api/notebook/rename", {"nb": nb, "title": "论文的图"})
        self.assertEqual((st, r["id"], r["title"]), (200, nb, "论文的图"))
        self.assertEqual(self.show("A", "二")["nb"], nb)                   # 改过名，同一个文件夹再推还进这一本
        again = ts.make_app(self.tmp.name)                                 # 服务重启
        self.assertEqual(again.push_book_of(str(Path(self.tmp.name) / "proj/paper")), nb)
        self.assertIn({"id": nb, "title": "论文的图"}, again.notebooks())
        self.assertEqual(len(again.board_index(nb)["pages"]), 2)

    def test_delete_moves_it_aside_and_the_next_push_opens_a_new_one(self):
        self.hello("A", "paper", "proj/paper")
        nb = self.show("A", "一")["nb"]
        d = self.app.data / "notebooks" / ("board-" + nb[6:])
        st, r = self.j("POST", "/api/notebook/delete", {"nb": nb})
        self.assertEqual((st, r["title"]), (200, "推送 · paper"))
        self.assertFalse(d.exists())
        aside = [x for x in (self.app.data / "notebooks").iterdir() if x.name.startswith("_deleted-") and x.name.endswith(d.name)]
        self.assertEqual(len(aside), 1)                                    # 挪开留着，能找回
        self.assertTrue((aside[0] / "bg-0000.png").is_file())
        self.assertNotIn(nb, self.ids())
        new = self.show("A", "二")["nb"]
        self.assertNotEqual(new, nb)
        self.assertEqual((self.app.nb_title(new), self.show("A")["page"]), ("推送 · paper", 1))

    def test_push_books_go_into_folders_like_any_other(self):
        self.hello("A", "paper", "proj/paper")
        nb = self.show("A")["nb"]
        st, r = self.j("POST", "/api/folders/new", {"name": "论文", "nb": nb})
        self.assertEqual(st, 200, r)
        self.assertEqual(r["folders"][0]["items"], [nb])
        self.assertEqual(self.j("POST", "/api/folders/move", {"nb": nb, "folder": ""})[0], 200)
        self.assertEqual(self.j("POST", "/api/folders/move", {"nb": nb, "folder": r["id"]})[1]["folders"][0]["items"], [nb])
        self.j("POST", "/api/notebook/delete", {"nb": nb})                 # 删掉的不再记在文件夹里
        self.assertEqual(self.j("GET", "/api/folders")[1]["folders"][0]["items"], [])
        self.assertEqual(self.j("POST", "/api/folders/move", {"nb": "scratch", "folder": r["id"]})[0], 400)  # 草稿本照旧不进

    def test_local_push_book_refuses_and_does_not_open_another(self):
        self.hello("A", "paper", "proj/paper")
        nb = self.show("A")["nb"]
        self.j("POST", "/api/notebook/setting", {"nb": nb, "key": "local", "value": True})
        before = (sorted(p.name for p in (self.app.data / "notebooks").rglob("*")), self.app.bridge.seq)
        st, r = self.j("POST", "/bridge/show", {"sid": "A", "path": str(self.img()), "title": "第二张"})
        self.assertEqual(st, 400, r)
        self.assertTrue(r["error"].startswith("这个文件夹的推送本子只在本地"), r)
        self.assertNotIn("推送 ·", r["error"])                             # 不带本子名
        self.assertEqual((sorted(p.name for p in (self.app.data / "notebooks").rglob("*")), self.app.bridge.seq), before)
        self.assertEqual(len(self.app.boards()), 1)

    def test_failed_first_push_leaves_no_empty_book(self):
        self.hello("A", "paper", "proj/paper")
        st, r = self.j("POST", "/bridge/show", {"sid": "A", "path": str(Path(self.tmp.name) / "没有这个.png")})
        self.assertEqual(st, 400, r)
        self.assertEqual(self.app.boards(), [])
        self.assertFalse([p for p in (self.app.data / "notebooks").iterdir() if p.is_dir() and p.name.startswith("board")])

    # ---------------------------------------------------------------- 发回推这一页的对话

    def test_ai_on_a_page_goes_back_to_whoever_pushed_it(self):
        self.hello("P1", "paper", "proj/paper")
        self.hello("P2", "paper", "proj/paper")
        self.j("POST", "/bridge/active", {"sid": "P2"})                    # P2 最近打字：不该因此收到 P1 推的页
        nb = self.show("P1", "一")["nb"]
        self.show("P2", "二")
        st, r = self.send(nb, 0)
        self.assertEqual((st, r["target"]), (200, "P1"), r)
        st, r = self.send(nb, 1)
        self.assertEqual((st, r["target"]), (200, "P2"), r)
        self.assertEqual(self.queued(), {"P1": 1, "P2": 1})
        self.assertIsNone(self.app.nb_target(nb))                          # 整本没有记成发往谁
        # 消息里说这一页是你推的
        sub = self.app.load_submission(r["id"])
        msg = (self.app.data / "submissions" / r["id"] / "message.txt").read_text("utf-8")
        self.assertEqual(sub["role"], {"page": "board"})
        self.assertIn("页面：你推送到平板的「二」", msg)
        # 几页一起交：按眼前这一页算（带了 key）
        late = 1_800_000_000_000  # 比上面交过的那两次（mark_seen 记下的时刻，groups_fixture 的 t1）都晚：算新写的
        for i in (0, 1):
            self.put_page(i, [ts.stroke(f"s{i}", late, 100, 100, red=True)], nb=urllib.parse.quote(nb))
        # 别的对话推的页不跟着交（只带上和眼前这一页发往同一个对话的页）：两页都有新字，各按自己那一页只算 1 页
        q = "/api/new-pages?nb=" + urllib.parse.quote(nb)
        self.assertEqual(self.j("GET", q + "&key=p0000")[1]["keys"], ["p0000"])
        self.assertEqual(self.j("GET", q + "&key=p0001")[1]["keys"], ["p0001"])
        st, r = self.j("POST", "/api/send-all", {"nb": nb, "key": "p0000", "only_new": False})
        self.assertEqual((st, r["target"], r["pages"]), (200, "P1", 1), r)
        st, r = self.j("POST", "/api/send-all", {"nb": nb, "key": "p0001", "only_new": False})
        self.assertEqual((st, r["target"], r["pages"]), (200, "P2", 1), r)
        self.show("P1", "四")                                              # P1 又推一页、也写了字：和第 1 页一起交给 P1
        later = late + 60_000  # 上面几页一起交过以后又写的
        self.put_page(0, [ts.stroke("s0", late, 100, 100, red=True), ts.stroke("s5", later, 100, 200, red=True)], nb=urllib.parse.quote(nb))
        self.put_page(1, [ts.stroke("s1", late, 100, 100, red=True), ts.stroke("s6", later, 100, 200, red=True)], nb=urllib.parse.quote(nb))
        self.put_page(2, [ts.stroke("s2", later, 100, 100, red=True)], nb=urllib.parse.quote(nb))
        self.assertEqual(self.j("GET", q + "&key=p0002")[1]["keys"], ["p0000", "p0002"])
        st, r = self.j("POST", "/api/send-all", {"nb": nb, "key": "p0002", "only_new": True})
        self.assertEqual((st, r["target"], r["pages"]), (200, "P1", 2), r)

    def test_gone_pusher_asks_then_moves_every_page_that_should_have_gone_to_it(self):
        self.hello("P1", "paper", "proj/paper")
        self.hello("P2", "paper", "proj/paper")
        self.hello("Q", "idea", "proj/idea")
        nb = self.show("P1", "一")["nb"]
        self.show("P2", "二")
        self.show("P1", "三")
        self.j("POST", "/bridge/bye", {"sid": "P1"})
        st, r = self.send(nb, 2)
        self.assertEqual((st, r.get("gone")), (410, "paper"), r)
        self.assertIn("推这一页的「paper」对话现在不在了", r["error"])
        self.assertEqual(self.queued(), {})
        # 用户在单子里选了 Q（平板先带着这一页的键记下）：P1 推的两页都改发到 Q，P2 推的那页不动；谁推的照旧记着
        st, r = self.j("POST", "/api/notebook/target", {"nb": nb, "sid": "Q", "key": "p0002"})
        self.assertEqual(st, 200, r)
        self.assertEqual({k: (v or {}).get("sid") for k, v in r["pageTo"].items()}, {"p0000": "Q", "p0001": None, "p0002": "Q"})
        pages = self.app.board_index(nb)["pages"]
        self.assertEqual([p["by"]["sid"] for p in pages], ["P1", "P2", "P1"])
        self.assertIsNone(self.app.nb_target(nb))
        for page, want in ((0, "Q"), (1, "P2"), (2, "Q")):
            st, r = self.send(nb, page, target=want)
            self.assertEqual((st, r["target"]), (200, want), r)
        # 收到的消息说这一页是另一个对话推的
        msg = (self.app.data / "submissions" / r["id"] / "message.txt").read_text("utf-8")
        self.assertIn("页面：另一个对话（「paper」文件夹里的）推送到平板的「三」", msg)
        self.assertIn("这一页是另一个对话（「paper」文件夹里的）推送到平板的东西", msg)
        # 平板上改了以后各台都知道（target 事件带 pageTo）
        ev = [e for e in self.j("GET", "/api/events?since=0&wait=0")[1]["events"] if e["type"] == "target"][-1]
        self.assertEqual((ev["nb"], ev["pageTo"]["p0000"]["sid"]), (nb, "Q"))
        info = self.info(nb)
        self.assertEqual([(pi["push"]["sid"], (pi.get("to") or {}).get("sid")) for pi in info["pageInfo"]],
                         [("P1", "Q"), ("P2", None), ("P1", "Q")])
        # 改发到的 Q 也不在了：再问，说的是改发到的那个
        self.j("POST", "/bridge/bye", {"sid": "Q"})
        st, r = self.send(nb, 0)
        self.assertEqual(st, 410, r)
        self.assertIn("这一页改发到的「idea」对话现在不在了", r["error"])

    def test_choosing_in_the_drawer_or_ink_here_moves_the_same_pushers_pages(self):
        self.hello("P1", "paper", "proj/paper")
        self.hello("P2", "paper", "proj/paper")
        self.hello("Q", "idea", "proj/idea")
        nb = self.show("P1", "一")["nb"]
        self.show("P2", "二")
        self.show("P1", "三")
        # 抽屉里在第 1 页上换成 Q（P1 还在）：P1 推的那两页改发到 Q
        self.j("POST", "/api/notebook/target", {"nb": nb, "sid": "Q", "key": "p0000"})
        self.assertEqual([self.app.push_target(nb, k)["sid"] for k in ("p0000", "p0001", "p0002")], ["Q", "P2", "Q"])
        # 再换回 P1：改发到的就是推它的那个，不另记 to
        self.j("POST", "/api/notebook/target", {"nb": nb, "sid": "P1", "key": "p0002"})
        self.assertFalse([p for p in self.app.board_index(nb)["pages"] if "to" in p])
        # /ink here：平板眼前是第 2 页（P2 推的），在 Q 里执行：只改 P2 推的那一页
        self.j("POST", "/api/where", {"nb": nb, "page": 1, "key": "p0001"})
        status = self.j("GET", "/bridge/status?sid=P2")[1]
        self.assertEqual((status["isTarget"], status["targetUnset"]), (True, False))
        self.j("POST", "/bridge/claim", {"sid": "Q"})
        self.assertEqual([self.app.push_target(nb, k)["sid"] for k in ("p0000", "p0001", "p0002")], ["P1", "Q", "P1"])
        self.assertTrue(self.j("GET", "/bridge/status?sid=Q")[1]["isTarget"])
        self.assertIsNone(self.app.nb_target(nb))

    def test_blank_page_in_a_push_book_follows_the_whole_book(self):
        self.hello("P1", "paper", "proj/paper")
        self.hello("Q", "idea", "proj/idea")
        nb = self.show("P1")["nb"]
        self.assertEqual(self.j("POST", "/api/page/insert", {"nb": nb, "after": 0})[0], 200)
        info = self.info(nb)
        self.assertEqual(info["pages"], 2)
        self.assertNotIn("push", info["pageInfo"][1])
        st, r = self.send(nb, 1)                                           # 空白纸没有推它的对话：照整本的，没选过、连着两个 → 先问
        self.assertEqual((st, r.get("pick")), (410, True), r)
        self.assertEqual(self.send(nb, 1, target="Q")[1]["target"], "Q")
        self.assertEqual(self.app.nb_target(nb)["sid"], "Q")
        self.assertEqual(self.send(nb, 0)[1]["target"], "P1")              # 推来的那页照旧发回 P1

    # ---------------------------------------------------------------- 以前那本「Claude 推送」

    def test_the_old_shared_board_still_works_can_be_renamed_and_deleted(self):
        self.hello("A", "paper", "proj/paper")
        self.hello("B", "idea", "proj/idea")
        self.app.add_board_page(self.img())                               # 以前推来的页（没记是谁推的）
        self.app.set_setting("board", "target", {"sid": "B", "label": "idea", "cwd": ""})
        self.assertIn({"id": "board", "title": "Claude 推送"}, self.j("GET", "/api/notebooks")[1])
        self.assertNotIn("push", self.info("board")["pageInfo"][0])
        self.assertEqual(self.send("board", 0)[1]["target"], "B")         # 照旧按整本的发往
        nb = self.show("A")["nb"]                                         # 新的推送不再进它
        self.assertNotEqual(nb, "board")
        self.assertEqual(len(self.app.board_index("board")["pages"]), 1)
        self.assertEqual(self.j("POST", "/api/notebook/rename", {"nb": "board", "title": "旧的推送"})[1]["title"], "旧的推送")
        st, r = self.j("POST", "/api/folders/new", {"name": "以前", "nb": "board"})
        self.assertEqual((st, r["folders"][0]["items"]), (200, ["board"]))
        st, r = self.j("POST", "/api/notebook/delete", {"nb": "board"})
        self.assertEqual((st, r["title"]), (200, "旧的推送"))
        self.assertNotIn("board", self.ids())
        self.assertTrue([x for x in (self.app.data / "notebooks").iterdir() if x.name.startswith("_deleted-") and x.name.endswith("-board")])
        self.assertIn(nb, self.ids())                                      # 各文件夹的推送本子不受影响

    # ---------------------------------------------------------------- 给 AI 看的字

    def test_words_for_the_ai_follow_the_change(self):
        desc = tool_desc("ink_show")
        self.assertIn("推的页进你这个对话所在项目文件夹自己的那本（默认叫「推送 · 文件夹名」，没有就新开一本）", desc)
        self.assertNotIn("Claude 推送", desc)
        src = REGISTER.read_text("utf-8")                                 # 插件里给 AI 看的别的字（ink_scan 的 nb、ink_show 的返回）
        for gone in ("board=Claude 推送", "「Claude 推送」本子", "Claude 推送 第"):
            self.assertNotIn(gone, src)
        self.assertIn("另一个对话", prompt.PAGE_FACTS["board_other"])
        self.assertIn("「paper」文件夹里的", prompt.role_facts({"role": {"page": "board_other", "by": "paper"}}))


if __name__ == "__main__":
    unittest.main()

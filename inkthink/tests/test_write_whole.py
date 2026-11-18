"""小的记录文件（本子设置、自己建的本子的名单、推送本子的页表）写的时候整个换上，不让同时在读的请求读到写了一半的。
起因（2026-11-17）：浏览器测试 push_books 偶发「Expecting value: line 1 column 1」——平板取本子列表时，服务正好把
某个 settings.json 清空了还没写完。这里一边不停地改设置、建本子，一边不停地取本子列表，取的一方一次都不能出错
（读到空文件不行；Windows 上正好碰上文件在换、打不开也不行——读的一方 read_whole 等一等再读）。"""
import json
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server  # noqa: E402
import test_server as ts  # noqa: E402  （不把 HttpTest 这个名字引进来，见 test_target_first.py）


class WriteWholeTest(unittest.TestCase):
    setUp = ts.HttpTest.setUp
    tearDown = ts.HttpTest.tearDown

    def test_readers_never_see_a_half_written_file(self):
        app = self.app
        pad = app.new_pad("值日表")
        stop, bad, seen = threading.Event(), [], [0]

        def read():
            while not stop.is_set():
                try:
                    titles = [n["id"] for n in app.notebooks()]
                    app.setting(pad, "note")
                    seen[0] += 1
                    if "scratch" not in titles or pad not in titles:
                        bad.append(f"列表里少了本子：{titles}")
                except Exception as e:  # noqa: BLE001  读的一方出什么错都算
                    bad.append(repr(e))

        readers = [threading.Thread(target=read) for _ in range(3)]
        for t in readers:
            t.start()
        try:
            for k in range(150):
                app.set_setting(pad, "note", "值日 " * 2000 + str(k))   # 大一点，写的时间长一点
                app.set_setting("scratch", "note", str(k))
                if k % 30 == 0:
                    app.new_pad(f"第 {k} 本")
        finally:
            stop.set()
            for t in readers:
                t.join()
        self.assertEqual(bad[:3], [])
        self.assertGreater(seen[0], 20)                                  # 确实同时读了不少次
        self.assertEqual(app.setting(pad, "note")[-3:], "149")           # 最后一次写的在
        self.assertEqual(len(app.pads()), 6)                             # 建的本子一本没丢
        left = [p.name for p in (app.data / "notebooks").rglob("*.tmp")]
        self.assertEqual(left, [])                                       # 没留下临时文件

    def test_two_writers_do_not_lose_each_others_setting(self):
        """两个请求同时改同一本的两项设置：都读到旧的一份、各改各的再写回，后写的会把前一个的盖掉（比如刚设的「只在本地」没了）。
        这里让头一个写者读完旧的就停住，等第二个整个改完再往下写：set_setting 读改写是一气做完的话，第二个得排在它后面，两项都在。"""
        app = self.app
        app.set_setting("scratch", "flow", False)
        real_read, first_read, go_on = server.read_whole, threading.Event(), threading.Event()

        def slow_read(f):
            text = real_read(f)
            if threading.current_thread().name == "w1" and not first_read.is_set():
                first_read.set()
                go_on.wait(2)          # 读完旧的停一下，让第二个写者有机会插进来
            return text

        server.read_whole = slow_read
        try:
            w1 = threading.Thread(target=lambda: app.set_setting("scratch", "local", True), name="w1")
            w1.start()
            self.assertTrue(first_read.wait(5))
            w2 = threading.Thread(target=lambda: app.set_setting("scratch", "flow", True), name="w2")
            w2.start()
            w2.join(0.5)               # 没有那把锁的话 w2 这时已经写完了；有锁的话它在等 w1
            go_on.set()
            w1.join(5)
            w2.join(5)
        finally:
            server.read_whole = real_read
        self.assertIs(app.setting("scratch", "local"), True)     # 「只在本地」没被盖掉
        self.assertIs(app.setting("scratch", "flow"), True)

    def test_failed_write_leaves_no_temp_file_and_keeps_the_old_text(self):
        f = Path(self.tmp.name) / "y.json"
        server.write_whole(f, "旧的")
        real = server.os.replace
        server.os.replace = lambda a, b: (_ for _ in ()).throw(OSError("盘满了"))
        try:
            with self.assertRaises(OSError):
                server.write_whole(f, "新的")
        finally:
            server.os.replace = real
        self.assertEqual(f.read_text("utf-8"), "旧的")
        self.assertEqual([p.name for p in f.parent.glob("y.json.*")], [])

    def test_unreadable_registry_is_not_overwritten_as_empty(self):
        """推送本子的登记一时读不出来：新开一本时不当成空的写回去（那样登记着的别的本子就没了）。"""
        app = self.app
        first = app.new_push_book({"cwd": str(Path(self.tmp.name) / "paper"), "label": "paper"})
        f = app.data / "notebooks" / "boards.json"
        good = f.read_text("utf-8")
        f.write_text("{ 坏了", "utf-8")
        with self.assertRaises(ValueError):
            app.new_push_book({"cwd": str(Path(self.tmp.name) / "idea"), "label": "idea"})
        self.assertEqual(f.read_text("utf-8"), "{ 坏了")          # 没动它
        self.assertEqual(app.boards(), [])                         # 只是列出来时：坏了当空的，不报错
        f.write_text(good, "utf-8")
        self.assertEqual(["board:" + b["id"] for b in app.boards()], [first])

    def test_write_whole_replaces_and_keeps_text(self):
        f = Path(self.tmp.name) / "x.json"
        server.write_whole(f, json.dumps({"a": 1}))
        server.write_whole(f, json.dumps({"a": "值日表"}, ensure_ascii=False))
        self.assertEqual(json.loads(f.read_text("utf-8")), {"a": "值日表"})
        self.assertEqual([p.name for p in f.parent.glob("x.json.*")], [])


if __name__ == "__main__":
    unittest.main()

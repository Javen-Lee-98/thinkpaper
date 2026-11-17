"""把积压的新文件提示标成已忽略的脚本（tools/ignore_old_offers.py）：试跑不写、--apply 写且留原件、只动待处理的、
--before 的边界、服务在跑时拒绝、再跑一遍没有要处理的，以及标完以后服务自己的代码确实不再把它们当待处理。

文件名、对话名都是编的日常内容。

    .venv\\Scripts\\python.exe -m unittest tests.test_ignore_old_offers -v
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
import ignore_old_offers as ioo  # noqa: E402

NO_SERVICE = 9  # 查「正式服务在不在」时用的端口：这里不会有草稿纸服务


def ms(y, m, d, hh=0, mm=0, ss=0, extra=0):
    """本机时间的那一刻（毫秒），和脚本按本机时间零点算 --before 一致。"""
    return int(datetime(y, m, d, hh, mm, ss).timestamp() * 1000) + extra


def offer(oid, name, label, t, state="new", folder=None):
    folder = folder or Path(tempfile.gettempdir()) / "offers-test-not-there"
    p = Path(folder) / name
    return {"id": oid, "path": str(p), "name": name, "ext": p.suffix.lower(), "size": 120, "mtime": 1_790_000_000_000,
            "sid": "S" + label, "label": label, "t": t, "state": state}


class IgnoreOldOffersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.data = self.base / "data"
        self.data.mkdir()

    # ---- 小工具
    def put(self, items):
        f = self.data / "offers.json"
        f.write_text(json.dumps(items, ensure_ascii=False, indent=1), "utf-8")  # 和服务的 save_offers 一样
        return f

    def get(self):
        return json.loads((self.data / "offers.json").read_text("utf-8"))

    def run_it(self, apply=False, originals=None, before=None, names=False):
        if apply and originals is None:
            originals = self.base / "originals"
        return ioo.run(self.data, apply=apply, originals=originals, before=before, port=NO_SERVICE, names=names)

    def snapshot(self, root=None):
        root = root or self.data
        return {str(f.relative_to(root)): (f.read_bytes(), f.stat().st_mtime_ns) for f in sorted(root.rglob("*")) if f.is_file()}

    def make_mixed(self):
        """待处理 4 条（两个对话、三种类型），已加进草稿纸 1 条，已忽略 1 条，另有一条认不出的。"""
        items = [
            offer("a1", "周末菜单.md", "家里", ms(2026, 11, 11, 9, 30)),
            offer("a2", "旅行照片.png", "家里", ms(2026, 11, 11, 10, 0)),
            offer("b1", "读书笔记.md", "读书会", ms(2026, 11, 12, 20, 15)),
            offer("x1", "搬家清单.pdf", "家里", ms(2026, 11, 12, 8, 0), state="added"),
            offer("x2", "猫的照片.png", "读书会", ms(2026, 11, 12, 8, 5), state="dismissed"),
            "认不出的一条",
            offer("b2", "借书单.pdf", "读书会", ms(2026, 11, 14, 18, 40)),
        ]
        self.put(items)
        return items

    # ---- 试跑
    def test_dry_run_writes_nothing_and_reports_counts(self):
        self.make_mixed()
        snap, outside = self.snapshot(), sorted(p.name for p in self.base.iterdir())
        code, text = self.run_it()
        self.assertEqual(code, 0, text)
        self.assertIn("试跑（什么都没写）", text)
        self.assertIn("一共 7 条：待处理 4，已加进草稿纸 1，已忽略 1，认不出状态的 1（不动）", text)
        self.assertIn("会标成已忽略：4 条", text)
        self.assertIn("按对话（label）：家里 2 条；读书会 2 条", text)
        self.assertIn("按文件类型：.md 2 条；.pdf 1 条；.png 1 条", text)
        self.assertIn("最早 2026-11-11 09:30，最晚 2026-11-14 18:40", text)
        self.assertIn("其中原文件已经不在的 4 条", text)
        for name in ("周末菜单", "旅行照片", "读书笔记", "借书单"):  # 默认不列文件名
            self.assertNotIn(name, text)
        self.assertEqual(self.snapshot(), snap)
        self.assertEqual(sorted(p.name for p in self.base.iterdir()), outside)  # 也没在旁边建原件文件夹

    def test_names_are_listed_only_when_asked(self):
        self.make_mixed()
        code, text = self.run_it(names=True)
        self.assertEqual(code, 0, text)
        for name in ("周末菜单.md", "旅行照片.png", "读书笔记.md", "借书单.pdf"):
            self.assertIn(name, text)
        for name in ("搬家清单", "猫的照片"):  # 不在要标的里面
            self.assertNotIn(name, text)

    # ---- 正式标
    def test_apply_marks_pending_and_keeps_the_original(self):
        self.make_mixed()
        f = self.data / "offers.json"
        orig = f.read_bytes()
        code, text = self.run_it(apply=True)
        self.assertEqual(code, 0, text)
        self.assertEqual((self.base / "originals" / "offers.json").read_bytes(), orig)  # 原件按相同的相对路径留着
        self.assertEqual([p.name for p in (self.base / "originals").rglob("*")], ["offers.json"])
        after = self.get()
        self.assertEqual([o["state"] if isinstance(o, dict) else o for o in after],
                         ["dismissed", "dismissed", "dismissed", "added", "dismissed", "认不出的一条", "dismissed"])
        self.assertEqual(f.read_text("utf-8"), json.dumps(after, ensure_ascii=False, indent=1))  # 和服务的 save_offers 一样
        self.assertIn("周末菜单", f.read_text("utf-8"))  # 中文原样，不转义
        self.assertFalse(list(self.data.glob("*.tmp")))
        self.assertIn("已标 4 条", text)
        self.assertIn("写完从磁盘读回来复查", text)

    def test_only_pending_entries_change(self):
        items = self.make_mixed()
        code, text = self.run_it(apply=True)
        self.assertEqual(code, 0, text)
        after = self.get()
        self.assertEqual(len(after), len(items))
        for a, b in zip(items, after):
            if isinstance(a, dict) and a["state"] == "new":
                self.assertEqual({k: v for k, v in b.items() if k != "state"}, {k: v for k, v in a.items() if k != "state"})
            else:
                self.assertEqual(a, b)  # 已加进的、已忽略的、认不出的一个字不动，顺序也不变

    def test_before_boundary(self):
        cut = ms(2026, 11, 13)
        self.put([offer("p1", "早饭.md", "家里", cut - 1),            # 前一天最后一毫秒：标
                  offer("p2", "午饭.md", "家里", cut),                # 正好零点：不标
                  offer("p3", "晚饭.md", "家里", ms(2026, 11, 14, 7)),  # 之后：不标
                  dict(offer("p4", "夜宵.md", "家里", 0), t=None)])   # 没有时间：用了 --before 分不出先后，不标
        code, text = self.run_it(before="2026-11-13")
        self.assertEqual(code, 0, text)
        self.assertIn("范围：2026-11-13 零点之前记下的待处理提示", text)
        self.assertIn("会标成已忽略：1 条", text)
        self.assertIn("待处理但在 2026-11-13 及以后记下的：2 条（不动）", text)
        self.assertIn("待处理但没有记录时间的：1 条", text)
        code, text = self.run_it(apply=True, before="2026-11-13")
        self.assertEqual(code, 0, text)
        self.assertEqual([o["state"] for o in self.get()], ["dismissed", "new", "new", "new"])
        # 同一个范围再跑：没有要处理的；不写 --before：剩下的都标
        code, text = self.run_it(before="2026-11-13")
        self.assertIn("没有要处理的：待处理的 3 条都不在这个范围里。", text)
        code, text = self.run_it(apply=True, originals=self.base / "o2")
        self.assertEqual(code, 0, text)
        self.assertEqual([o["state"] for o in self.get()], ["dismissed"] * 4)

    def test_bad_before_is_refused(self):
        self.make_mixed()
        snap = self.snapshot()
        for bad in ("2026/11/13", "13-11-2026", "昨天"):
            code, text = self.run_it(apply=True, before=bad)
            self.assertEqual(code, 2, bad)
            self.assertIn("YYYY-MM-DD", text)
        self.assertEqual(self.snapshot(), snap)
        self.assertFalse((self.base / "originals").exists())

    def test_running_twice_has_nothing_to_do(self):
        self.make_mixed()
        code, text = self.run_it(apply=True)
        self.assertEqual(code, 0, text)
        snap = self.snapshot()
        code2, text2 = self.run_it(apply=True, originals=self.base / "originals2")
        self.assertEqual(code2, 0, text2)
        self.assertIn("没有要处理的：没有待处理的提示。", text2)
        self.assertIn("什么都没写", text2)
        self.assertEqual(self.snapshot(), snap)
        self.assertFalse((self.base / "originals2").exists())
        code3, text3 = self.run_it()
        self.assertIn("没有要处理的", text3)

    def test_missing_offers_file(self):
        code, text = self.run_it(apply=True)
        self.assertEqual(code, 0, text)
        self.assertIn("没有 offers.json，没有要处理的", text)
        self.assertEqual(list(self.data.iterdir()), [])
        self.assertFalse((self.base / "originals").exists())

    def test_unreadable_offers_file_is_refused(self):
        for bad in ("{不是 JSON", json.dumps({"id": "a1"})):
            (self.data / "offers.json").write_text(bad, "utf-8")
            code, text = self.run_it(apply=True)
            self.assertEqual(code, 2, text)
            self.assertEqual((self.data / "offers.json").read_text("utf-8"), bad)
            self.assertFalse((self.base / "originals").exists())

    def test_default_originals_folder_is_beside_data(self):
        self.make_mixed()
        code, text = ioo.run(self.data, apply=True, port=NO_SERVICE)
        self.assertEqual(code, 0, text)
        made = [p for p in self.base.iterdir() if p.name.startswith("data-originals-")]
        self.assertEqual(len(made), 1)
        self.assertTrue((made[0] / "offers.json").exists())

    def test_originals_inside_data_is_refused(self):
        self.make_mixed()
        snap = self.snapshot()
        code, text = self.run_it(apply=True, originals=self.data / "keep")
        self.assertEqual(code, 2)
        self.assertIn("必须在数据文件夹外面", text)
        self.assertEqual(self.snapshot(), snap)

    def test_existing_original_stops_before_writing(self):
        self.make_mixed()
        (self.base / "originals").mkdir()
        (self.base / "originals" / "offers.json").write_text("[]", "utf-8")
        snap = self.snapshot()
        code, text = self.run_it(apply=True)
        self.assertEqual(code, 1)
        self.assertIn("原件的位置已经有文件了", text)
        self.assertEqual(self.snapshot(), snap)
        self.assertEqual((self.base / "originals" / "offers.json").read_text("utf-8"), "[]")

    # ---- 服务在跑
    def test_refuses_while_the_service_runs(self):
        self.make_mixed()
        snap = self.snapshot()
        with mock.patch.object(ioo,"service_alive", return_value=True):
            code, text = self.run_it(apply=True)
        self.assertEqual(code, 2)
        self.assertIn("服务正在跑", text)
        self.assertEqual(self.snapshot(), snap)
        self.assertFalse((self.base / "originals").exists())
        with mock.patch.object(ioo,"service_alive", return_value=True):  # 试跑不查服务
            code, text = self.run_it()
        self.assertEqual(code, 0, text)

    def test_service_check_follows_launch_py(self):
        import launch
        self.make_mixed()
        # 不给 --port：照 launch.py 取端口（config.json 里的 port），另外也查 8765；在跑就拒绝
        with mock.patch.object(launch, "port", return_value=8766), mock.patch.object(launch, "alive", return_value=False) as alive:
            code, _ = ioo.run(self.data, apply=True, originals=self.base / "o")
        self.assertEqual(code, 0)
        self.assertEqual(sorted(c.args[0] for c in alive.call_args_list), [8765, 8766])
        self.make_mixed()
        with mock.patch.object(launch, "port", return_value=8766), mock.patch.object(launch, "alive", side_effect=lambda p: p == 8766):
            code, text = ioo.run(self.data, apply=True, originals=self.base / "o2")
        self.assertEqual(code, 2)
        self.assertIn("端口 8766", text)

    # ---- 复查拦得住
    def test_self_check_catches_a_bad_write(self):
        items = self.make_mixed()
        orig = (self.data / "offers.json").read_bytes()
        real = ioo.write_offers

        def broken(f, new):
            new = list(new)
            new[3] = dict(new[3], state="dismissed")  # 不该动的一条被动了
            real(f, new)
        with mock.patch.object(ioo,"write_offers", side_effect=broken):
            code, text = self.run_it(apply=True)
        self.assertEqual(code, 1)
        self.assertIn("写完复查没过", text)
        self.assertIn("第 4 条不该动，变了", text)
        self.assertEqual((self.base / "originals" / "offers.json").read_bytes(), orig)  # 原件留着，能拷回去
        self.assertEqual(ioo.check(items, items, []), [])
        self.assertTrue(ioo.check(items, items[:-1], []))
        self.assertTrue(ioo.check(items, items, [0]))  # 该标的没标

    # ---- 命令行
    def test_command_line_and_report_file(self):
        self.make_mixed()
        rep, out = self.base / "report.txt", io.StringIO()
        with contextlib.redirect_stdout(out):
            code = ioo.main(["--data", str(self.data), "--report", str(rep), "--port", str(NO_SERVICE)])
        self.assertEqual(code, 0)
        self.assertIn("试跑（什么都没写）", rep.read_text("utf-8"))
        self.assertIn("试跑（什么都没写）", out.getvalue())  # 屏幕上也有
        with contextlib.redirect_stdout(io.StringIO()):
            code = ioo.main(["--data", str(self.data), "--report", str(self.data / "r.txt")])
        self.assertEqual(code, 2)
        self.assertFalse((self.data / "r.txt").exists())
        with contextlib.redirect_stdout(io.StringIO()):
            code = ioo.main(["--data", str(self.data), "--apply", "--before", "2026-11-12", "--port", str(NO_SERVICE),
                             "--originals", str(self.base / "o")])
        self.assertEqual(code, 0)
        self.assertEqual([o["state"] for o in self.get() if isinstance(o, dict)], ["dismissed", "dismissed", "new", "added", "dismissed", "new"])


class WithTheServiceTest(unittest.TestCase):
    """用服务自己的代码记提示、列待处理：标完以后不再待处理；同一个文件没改过再报上来不再提示，改过了照旧重新提示。"""

    def test_marked_offers_stay_out_of_the_pending_list(self):
        import server
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            args = SimpleNamespace(host="127.0.0.1", port=0, config=str(tmp / "none.json"),
                                   data=str(tmp / "data"), books=str(tmp / "books"), open=False)
            app = server.App(args)
            src = tmp / "家里的文件"
            src.mkdir()
            files = []
            for name in ("周末菜单.md", "旅行照片.png", "借书单.pdf"):
                (src / name).write_bytes(b"%PDF-1.4\n" if name.endswith(".pdf") else "一点内容".encode("utf-8"))
                files.append({"path": str(src / name), "mtimeMs": 1_790_000_000_000})
            self.assertEqual(len(app.add_offers("S", "家里", files)), 3)
            self.assertEqual(len(app.pending_offers()), 3)

            code, text = ioo.run(app.data, apply=True, originals=tmp / "originals", port=NO_SERVICE)
            self.assertEqual(code, 0, text)
            self.assertIn("会标成已忽略：3 条", text)
            self.assertEqual(app.pending_offers(), [])
            self.assertEqual({o["state"] for o in app.offers()}, {"dismissed"})

            # 同一个文件、同一个修改时间又报上来：不再提示
            self.assertEqual(app.add_offers("S", "家里", files), [])
            self.assertEqual(app.pending_offers(), [])
            # 文件改过了（修改时间变了）：照服务原来的规矩，作为新的一条重新提示
            (src / "周末菜单.md").write_text("改过的菜单", "utf-8")
            os.utime(src / "周末菜单.md", (1_790_000_100, 1_790_000_100))
            again = app.add_offers("S", "家里", [{"path": str(src / "周末菜单.md"), "mtimeMs": 1_790_000_100_000}])
            self.assertEqual([o["name"] for o in again], ["周末菜单.md"])
            self.assertEqual([o["name"] for o in app.pending_offers()], ["周末菜单.md"])
            self.assertEqual(len(app.offers()), 4)  # 旧的那条留着（已忽略），新的是另一条

            # 再跑一遍：只剩这条新的
            code, text = ioo.run(app.data, port=NO_SERVICE)
            self.assertIn("会标成已忽略：1 条", text)


if __name__ == "__main__":
    unittest.main()

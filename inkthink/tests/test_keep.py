"""keep.py：改电脑上的文件之前留底、撤回、另存起名（《产品定义》第 4 节）。
全部在 tempfile 的临时目录里做，测完删掉；不碰真实数据，不拿用户电脑上的文档来试。"""
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import keep  # noqa: E402
from keep import KeepError, Keeper, next_name  # noqa: E402

WINDOWS = os.name == "nt"


def blob(tag, n=3000):
    """一段二进制内容：0–255 每个字节都有，带 \\r\\n、\\0、中文的 UTF-8；tag 不同内容就不同。"""
    t = tag.encode("utf-8")
    return t + "｜中文 内容\r\n".encode("utf-8") + bytes(range(256)) * (n // 256) + b"\x00\r\n\x1a" + t


def same(a, b):
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="keeptest-")
        self.base = Path(os.path.realpath(self._tmp.name))  # 临时目录的 8.3 短名字（像 ABCDEF~1）展开成长名字
        self.k = Keeper(self.base / "data" / "keep")
        self.docs = self.base / "我的 项目" / "子 文件夹"  # 带中文和空格
        self.docs.mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, name, data, folder=None):
        p = (folder or self.docs) / name
        p.write_bytes(data)
        return p

    def two_versions(self, name="报告.pptx"):
        """留了两版（内容 0、1），现在是内容 2。"""
        p = self.write(name, blob("0"))
        self.k.keep(p, "覆盖前 1")
        p.write_bytes(blob("1"))
        self.k.keep(p, "覆盖前 2")
        p.write_bytes(blob("2"))
        return p, Path(self.k.history(p)[0]["copy"]).parent


class KeepUndoTest(Base):
    def test_roundtrip_each_type(self):
        """留一版、改文件、撤回：逐字节回到原样；副本取走；原文件旁边不多出文件。"""
        for ext in (".pptx", ".docx", ".md", ".pdf"):
            with self.subTest(ext=ext):
                p = self.write(f"报告 草稿 第一版{ext}", blob("原" + ext))
                before = p.read_bytes()
                rec = self.k.keep(p, "覆盖前")
                self.assertEqual(rec["kind"], "copy")
                self.assertEqual(rec["note"], "覆盖前")
                self.assertEqual(rec["size"], len(before))
                self.assertEqual(rec["sha256"], sha(before))
                self.assertTrue(same(rec["path"], p))
                self.assertIsNone(rec["saved_as"])
                self.assertIsNone(rec["warning"])
                self.assertFalse(rec["missing"])
                self.assertRegex(rec["t"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$")
                self.assertTrue(rec["copy"].endswith(ext))
                self.assertEqual(Path(rec["copy"]).read_bytes(), before)
                p.write_bytes(blob("改过" + ext, 5000))
                r = self.k.undo(p)
                self.assertTrue(r["ok"], r["message"])
                self.assertEqual(r["action"], "restored")
                self.assertEqual(p.read_bytes(), before)
                self.assertFalse(r["recreated"])
                self.assertEqual(r["left"], 0)
                self.assertEqual(r["record"]["id"], rec["id"])
                self.assertTrue(same(r["path"], p))
                self.assertFalse(Path(rec["copy"]).exists())
                self.assertEqual(self.k.history(p), [])
        self.assertEqual(sorted(os.listdir(self.docs)),
                         sorted(f"报告 草稿 第一版{e}" for e in (".pptx", ".docx", ".md", ".pdf")))

    def test_seven_changes_keep_five(self):
        """连着改 7 次只留最近 5 版，能连撤 5 次，第 6 次说没有了。"""
        p = self.write("进展.pptx", blob("0"))
        contents = [p.read_bytes()]
        for i in range(1, 8):
            self.k.keep(p, f"覆盖前 {i}")
            p.write_bytes(blob(str(i)))
            contents.append(p.read_bytes())
        h = self.k.history(p)
        self.assertEqual([x["note"] for x in h], [f"覆盖前 {i}" for i in (7, 6, 5, 4, 3)])
        self.assertEqual([x["sha256"] for x in h], [sha(contents[i]) for i in (6, 5, 4, 3, 2)])
        folder = Path(h[0]["copy"]).parent
        orig = f"original-{self.k.original(p)['id']}.pptx"  # 挤出去的第一版（内容 0）是原件，永远留着
        # 队列里 5 版 + 原件；挤出去的第二版（内容 1）删了
        self.assertEqual(sorted(f for f in os.listdir(folder) if f != keep.MANIFEST),
                         sorted([Path(x["copy"]).name for x in h] + [orig]))
        for want in (6, 5, 4, 3, 2):
            r = self.k.undo(p)
            self.assertTrue(r["ok"], r["message"])
            self.assertEqual(p.read_bytes(), contents[want])
            self.assertEqual(r["left"], want - 2)
        r = self.k.undo(p)
        self.assertFalse(r["ok"])
        self.assertEqual(r["action"], "nothing")
        self.assertIn("没有可撤回", r["message"])
        self.assertEqual(p.read_bytes(), contents[2])
        self.assertEqual(sorted(os.listdir(folder)), sorted([keep.MANIFEST, orig]))
        self.assertEqual((folder / orig).read_bytes(), contents[0])

    def test_same_content_not_kept_twice(self):
        p = self.write("笔记.md", "# 标题\n内容\n".encode("utf-8"))
        a = self.k.keep(p, "覆盖前")
        b = self.k.keep(p, "存回 PDF 前")
        self.assertEqual(b["id"], a["id"])
        self.assertEqual(b["note"], "覆盖前")  # 返回已有的那条
        self.assertEqual(len(self.k.history(p)), 1)
        p.write_bytes(b"changed")
        c = self.k.keep(p, "覆盖前")
        self.assertNotEqual(c["id"], a["id"])
        self.assertEqual(self.k.keep(p)["id"], c["id"])
        self.assertEqual(len(self.k.history(p)), 2)
        folder = Path(c["copy"]).parent
        self.assertEqual(sorted(os.listdir(folder)), sorted([keep.MANIFEST, Path(a["copy"]).name, Path(c["copy"]).name]))

    def test_undo_when_original_missing(self):
        p = self.write("方案.docx", blob("原"))
        before = p.read_bytes()
        self.k.keep(p, "覆盖前")
        p.write_bytes(b"after")
        moved = self.base / "别处.docx"
        os.replace(p, moved)  # 用户把原文件挪走了
        r = self.k.undo(p)
        self.assertTrue(r["ok"], r["message"])
        self.assertTrue(r["recreated"])
        self.assertIn("重新写了出来", r["message"])
        self.assertEqual(p.read_bytes(), before)
        self.assertEqual(moved.read_bytes(), b"after")  # 挪走的那份不碰

    def test_keep_errors(self):
        with self.assertRaises(KeepError) as cm:
            self.k.keep(self.docs / "没有这个.pptx")
        self.assertIn("找不到", str(cm.exception))
        with self.assertRaises(KeepError) as cm:
            self.k.keep(self.docs)
        self.assertIn("不是文件", str(cm.exception))
        p = self.write("a.docx", b"x")
        with self.assertRaises(KeepError):
            self.k.keep(p, "另存前", saved_as=p)
        self.assertFalse(self.k.root.exists())  # 出错时什么都没建
        r = self.k.undo(p)
        self.assertEqual((r["ok"], r["action"]), (False, "nothing"))
        self.assertIn("没有留底", r["message"])
        self.assertEqual(self.k.history(p), [])

    def test_layout_on_disk(self):
        p = self.write("报告_v47.pptx", blob("a"))
        rec = self.k.keep(p, "覆盖前")
        dirs = os.listdir(self.k.root)
        self.assertEqual(len(dirs), 1)
        self.assertRegex(dirs[0], r"^[0-9a-f]{16}-报告_v47\.pptx$")
        folder = self.k.root / dirs[0]
        self.assertRegex(rec["id"], r"^\d{8}-\d{6}-\d{6}$")
        self.assertEqual(sorted(os.listdir(folder)), sorted([keep.MANIFEST, rec["id"] + ".pptx"]))
        raw = (folder / keep.MANIFEST).read_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        self.assertNotIn(b"\r\n", raw)
        man = json.loads(raw.decode("utf-8"))
        self.assertEqual(man["v"], 1)
        self.assertTrue(same(man["path"], p))
        self.assertEqual(man["key"], os.path.normcase(os.path.realpath(p)))
        self.assertEqual(len(man["versions"]), 1)
        self.assertEqual(man["versions"][0]["file"], rec["id"] + ".pptx")
        self.assertEqual(man["versions"][0]["note"], "覆盖前")
        self.assertIsNone(man["original"])  # 第一版还在撤回队列里，没挪去永久的位置
        self.assertEqual(man["asides"], [])

    def test_long_name_folder(self):
        p = self.write("很长的名字" * 14 + ".pptx", b"x")
        self.k.keep(p)
        (d,) = os.listdir(self.k.root)
        self.assertLessEqual(len(d), 17 + keep.NAME_MAX)
        self.assertTrue(d.endswith(".pptx"))


class SaveAsTest(Base):
    def test_undo_saveas_switches_back_and_keeps_new_file(self):
        a = self.write("报告_v47.pptx", blob("原"))
        a_bytes, a_mtime = a.read_bytes(), a.stat().st_mtime_ns
        new = Path(next_name(a))
        self.assertEqual(new.name, "报告_v48.pptx")
        new.write_bytes(blob("新"))
        rec = self.k.keep(a, "另存前", saved_as=new)
        self.assertEqual(rec["kind"], "saveas")
        self.assertTrue(same(rec["path"], a))
        self.assertTrue(same(rec["saved_as"], new))
        self.assertIsNone(rec["copy"])
        self.assertEqual((rec["size"], rec["sha256"]), (len(a_bytes), sha(a_bytes)))
        self.assertEqual(self.k.history(a), [])  # 记在新文件名下
        self.assertEqual([x["id"] for x in self.k.history(new)], [rec["id"]])
        self.assertEqual(self.k.keep(a, "另存前", saved_as=new)["id"], rec["id"])  # 同一次另存不重复记

        r = self.k.undo(new)
        self.assertTrue(r["ok"], r["message"])
        self.assertEqual(r["action"], "switched")
        self.assertTrue(same(r["path"], a))
        self.assertTrue(same(r["saved_as"], new))
        self.assertIn("没删", r["message"])
        self.assertEqual(a.read_bytes(), a_bytes)  # 原文件没动
        self.assertEqual(a.stat().st_mtime_ns, a_mtime)
        self.assertEqual(new.read_bytes(), blob("新"))  # 新文件留着
        self.assertEqual(sorted(os.listdir(self.docs)), ["报告_v47.pptx", "报告_v48.pptx"])
        self.assertEqual(self.k.history(new), [])
        self.assertEqual(self.k.undo(new)["action"], "nothing")
        self.assertEqual(Path(next_name(a)).name, "报告_v49.pptx")  # v48 还在电脑上：再另存顺延

    def test_chain_through_saveas(self):
        """覆盖原文件 → 另存 → 覆盖新文件，然后一路撤回：新文件回上一版 → 换回原文件 → 原文件回上一版。"""
        a = self.write("方案.docx", blob("A0"))
        self.k.keep(a, "覆盖前")
        a.write_bytes(blob("A1"))
        new = Path(next_name(a))
        self.assertEqual(new.name, "方案 (改1).docx")
        new.write_bytes(blob("B0"))
        self.k.keep(a, "另存前", saved_as=new)
        self.k.keep(new, "覆盖前")
        new.write_bytes(blob("B1"))

        r1 = self.k.undo(new)
        self.assertEqual(r1["action"], "restored")
        self.assertEqual(new.read_bytes(), blob("B0"))
        r2 = self.k.undo(new)
        self.assertEqual(r2["action"], "switched")
        self.assertTrue(same(r2["path"], a))
        self.assertEqual(a.read_bytes(), blob("A1"))
        r3 = self.k.undo(r2["path"])
        self.assertEqual(r3["action"], "restored")
        self.assertEqual(a.read_bytes(), blob("A0"))
        self.assertEqual(new.read_bytes(), blob("B0"))  # 另存出来的文件一直留着


class NextNameTest(Base):
    n_dirs = 0

    def name_after(self, name, *existing, dirs=()):
        """在一个新的空文件夹里放好 existing，算 name 的下一个名字；顺便查没有建文件。"""
        NextNameTest.n_dirs += 1
        d = self.docs / f"例 {NextNameTest.n_dirs}"
        d.mkdir()
        for e in existing:
            (d / e).write_bytes(b"")
        for e in dirs:
            (d / e).mkdir()
        before = sorted(os.listdir(d))
        out = next_name(d / name)
        self.assertEqual(sorted(os.listdir(d)), before)
        self.assertTrue(same(os.path.dirname(out), d))
        return os.path.basename(out)

    def test_version_number(self):
        self.assertEqual(self.name_after("报告_v47.pptx"), "报告_v48.pptx")
        self.assertEqual(self.name_after("报告_v47.pptx", "报告_v47.pptx", "报告_v48.pptx"), "报告_v49.pptx")
        self.assertEqual(self.name_after("稿_v09.pdf"), "稿_v10.pdf")
        self.assertEqual(self.name_after("稿_v007.pdf"), "稿_v008.pdf")
        self.assertEqual(self.name_after("稿_v99.pdf"), "稿_v100.pdf")
        self.assertEqual(self.name_after("报告-V3.pptx"), "报告-V4.pptx")
        self.assertEqual(self.name_after("报告 v2.md"), "报告 v3.md")
        self.assertEqual(self.name_after("报告v2.md"), "报告v3.md")
        self.assertEqual(self.name_after("Report.V12.docx"), "Report.V13.docx")

    def test_gai_number(self):
        self.assertEqual(self.name_after("报告.docx"), "报告 (改1).docx")
        self.assertEqual(self.name_after("报告.docx", "报告 (改1).docx"), "报告 (改2).docx")
        self.assertEqual(self.name_after("报告 (改1).docx"), "报告 (改2).docx")
        self.assertEqual(self.name_after("报告.docx", "报告 (改1).docx", "报告 (改2).docx"), "报告 (改3).docx")
        self.assertEqual(self.name_after("报告_v47 (改1).pptx"), "报告_v47 (改2).pptx")
        self.assertEqual(self.name_after("报告（改9）.docx"), "报告（改10）.docx")
        self.assertEqual(self.name_after("README"), "README (改1)")

    def test_numbers_in_the_middle_count_as_other(self):
        self.assertEqual(self.name_after("进展_v47_按意见修改6.pptx"), "进展_v47_按意见修改6 (改1).pptx")
        self.assertEqual(self.name_after("方案_修订31.pptx"), "方案_修订31 (改1).pptx")

    def test_taken_names_ignore_case(self):
        self.assertEqual(self.name_after("报告_v47.pptx", "报告_V48.PPTX"), "报告_v49.pptx")
        self.assertEqual(self.name_after("Plan.docx", "plan (改1).DOCX", "PLAN (改2).docx"), "Plan (改3).docx")
        self.assertEqual(self.name_after("a_v1.md", dirs=["A_V2.md"]), "a_v3.md")  # 同名的文件夹也算占用

    def test_folder_missing_and_method(self):
        out = next_name(self.base / "没有这个文件夹" / "a_v1.md")
        self.assertEqual(os.path.basename(out), "a_v2.md")
        self.assertFalse((self.base / "没有这个文件夹").exists())
        self.assertEqual(os.path.basename(self.k.next_name(self.docs / "b.md")), "b (改1).md")


class IdentityTest(Base):
    def test_same_name_in_two_folders(self):
        d1, d2 = self.docs / "甲", self.docs / "乙"
        d1.mkdir()
        d2.mkdir()
        a = self.write("报告.pptx", blob("甲0"), d1)
        b = self.write("报告.pptx", blob("乙0"), d2)
        self.k.keep(a, "覆盖前")
        self.k.keep(b, "覆盖前")
        a.write_bytes(blob("甲1"))
        b.write_bytes(blob("乙1"))
        self.assertEqual(len(os.listdir(self.k.root)), 2)
        self.assertTrue(self.k.undo(a)["ok"])
        self.assertEqual(a.read_bytes(), blob("甲0"))
        self.assertEqual(b.read_bytes(), blob("乙1"))
        self.assertEqual(len(self.k.history(b)), 1)
        self.assertEqual(self.k.history(a), [])
        self.assertTrue(self.k.undo(b)["ok"])
        self.assertEqual(b.read_bytes(), blob("乙0"))

    @unittest.skipUnless(WINDOWS, "只有 Windows 上路径不分大小写")
    def test_path_case_is_ignored(self):
        p = self.write("Report_V1.pptx", blob("0"))
        self.k.keep(str(p), "覆盖前")
        up, low = str(p).upper(), str(p).lower()
        self.assertEqual(len(self.k.history(up)), 1)
        self.assertEqual(self.k.keep(low)["id"], self.k.history(p)[0]["id"])  # 同一个文件、内容没变：不重复留
        p.write_bytes(blob("1"))
        self.assertTrue(self.k.undo(low)["ok"])
        self.assertEqual(p.read_bytes(), blob("0"))
        self.assertEqual(len(os.listdir(self.k.root)), 1)
        # 原文件不在、换个大小写来撤回：写回原来的名字，不改成问的那种大小写
        self.k.keep(p, "覆盖前")
        p.write_bytes(blob("2"))
        p.unlink()
        r = self.k.undo(up)
        self.assertTrue(r["ok"], r["message"])
        self.assertTrue(r["recreated"])
        self.assertIn("Report_V1.pptx", os.listdir(self.docs))
        self.assertEqual(p.read_bytes(), blob("0"))


class DamageTest(Base):
    def test_manifest_garbage(self):
        p, folder = self.two_versions()
        junk = b"\xff\xfe not json {{{"
        (folder / keep.MANIFEST).write_bytes(junk)
        h = self.k.history(p)  # 只读：按副本临时拼出来，不写
        self.assertEqual(len(h), 2)
        self.assertIn("清单坏了", h[0]["note"])
        self.assertEqual(Path(h[0]["copy"]).read_bytes(), blob("1"))
        self.assertEqual((folder / keep.MANIFEST).read_bytes(), junk)
        r = self.k.undo(p)
        self.assertTrue(r["ok"], r["message"])
        self.assertEqual(p.read_bytes(), blob("1"))
        self.assertIn("清单读不出来", r["warning"])
        self.assertEqual(len([f for f in os.listdir(folder) if f.startswith(keep.MANIFEST + ".bad-")]), 1)
        self.assertEqual(len(json.loads((folder / keep.MANIFEST).read_text("utf-8"))["versions"]), 1)
        r = self.k.undo(p)
        self.assertTrue(r["ok"], r["message"])
        self.assertIsNone(r["warning"])
        self.assertEqual(p.read_bytes(), blob("0"))

    def test_manifest_wrong_shape_then_keep(self):
        p, folder = self.two_versions()
        (folder / keep.MANIFEST).write_text("[1, 2, 3]", "utf-8")
        rec = self.k.keep(p, "覆盖前 3")
        self.assertIn("清单格式不对", rec["warning"])
        h = self.k.history(p)
        self.assertEqual(len(h), 3)
        self.assertEqual(h[0]["id"], rec["id"])
        self.assertEqual(h[0]["note"], "覆盖前 3")

    def test_manifest_deleted(self):
        p, folder = self.two_versions()
        (folder / keep.MANIFEST).unlink()
        r = self.k.undo(p)
        self.assertTrue(r["ok"], r["message"])
        self.assertIn("清单不见了", r["warning"])
        self.assertEqual(p.read_bytes(), blob("1"))

    def test_bad_record_cannot_point_outside(self):
        """清单被改得指向用户的文件：那一条不认，裁旧版时也不会删到 root 外面去。"""
        p, folder = self.two_versions()
        man = json.loads((folder / keep.MANIFEST).read_text("utf-8"))
        man["versions"][0]["file"] = os.path.relpath(p, folder)
        (folder / keep.MANIFEST).write_text(json.dumps(man, ensure_ascii=False), "utf-8")
        self.assertEqual(len(self.k.history(p)), 1)
        r = self.k.undo(p)
        self.assertTrue(r["ok"], r["message"])
        self.assertIn("不对", r["warning"])
        self.assertEqual(p.read_bytes(), blob("1"))
        for i in range(3, 10):  # 再留很多版，让裁剪跑起来
            self.k.keep(p, f"覆盖前 {i}")
            p.write_bytes(blob(str(i)))
        self.assertTrue(p.is_file())
        self.assertEqual(sorted(os.listdir(self.docs)), ["报告.pptx"])

    def test_copy_deleted(self):
        p, folder = self.two_versions()
        h = self.k.history(p)
        Path(h[0]["copy"]).unlink()
        h = self.k.history(p)
        self.assertEqual([x["missing"] for x in h], [True, False])
        r = self.k.undo(p)
        self.assertFalse(r["ok"])
        self.assertEqual(r["action"], "skipped")
        self.assertIn("不见了", r["message"])
        self.assertEqual(r["left"], 1)
        self.assertEqual(p.read_bytes(), blob("2"))  # 不跳过去写更早的那版
        r = self.k.undo(p)
        self.assertTrue(r["ok"], r["message"])
        self.assertEqual(p.read_bytes(), blob("0"))

    def test_copies_deleted_then_keep(self):
        p, folder = self.two_versions()
        for x in self.k.history(p):
            Path(x["copy"]).unlink()
        rec = self.k.keep(p, "覆盖前 3")
        self.assertIn("副本不见了", rec["warning"])
        self.assertEqual([x["id"] for x in self.k.history(p)], [rec["id"]])

    def test_copy_altered(self):
        p, folder = self.two_versions()
        newest = Path(self.k.history(p)[0]["copy"])
        newest.write_bytes(b"tampered")
        r = self.k.undo(p)
        self.assertFalse(r["ok"])
        self.assertEqual(r["action"], "skipped")
        self.assertIn("不一样", r["message"])
        self.assertEqual(p.read_bytes(), blob("2"))
        self.assertEqual(sorted(os.listdir(self.docs)), ["报告.pptx"])  # 临时文件删掉了
        self.assertTrue(newest.with_name(newest.name + ".bad").is_file())  # 改名留着，不删
        r = self.k.undo(p)
        self.assertTrue(r["ok"], r["message"])
        self.assertEqual(p.read_bytes(), blob("0"))

    def test_replace_fails_midway(self):
        """最后一步换上时出错（打桩）：原文件完好，留底还在，旁边不留临时文件；之后能正常撤回。"""
        p, folder = self.two_versions()
        before = self.k.history(p)
        for err in (PermissionError(13, "拒绝访问"), OSError(28, "磁盘满了")):
            with self.subTest(err=err):
                with mock.patch.object(keep, "_put_in_place", side_effect=err):
                    r = self.k.undo(p)
                self.assertFalse(r["ok"])
                self.assertEqual(r["action"], "failed")
                self.assertIn("留底还在", r["message"])
                self.assertEqual(p.read_bytes(), blob("2"))
                self.assertEqual(self.k.history(p), before)
                self.assertTrue(Path(before[0]["copy"]).is_file())
                self.assertEqual(sorted(os.listdir(self.docs)), ["报告.pptx"])
        r = self.k.undo(p)
        self.assertTrue(r["ok"], r["message"])
        self.assertEqual(p.read_bytes(), blob("1"))

    @unittest.skipUnless(WINDOWS, "Windows 上开着的文件不能被换掉")
    def test_target_open_elsewhere(self):
        """原文件被别的程序开着（这里自己开一个句柄占着）：撤回不成，说明原因，什么都没坏。"""
        p, folder = self.two_versions()
        with open(p, "rb"):
            r = self.k.undo(p)
        self.assertFalse(r["ok"])
        self.assertEqual(r["action"], "failed")
        self.assertIn("占用", r["message"])
        self.assertEqual(p.read_bytes(), blob("2"))
        self.assertEqual(len(self.k.history(p)), 2)
        self.assertEqual(sorted(os.listdir(self.docs)), ["报告.pptx"])
        self.assertTrue(self.k.undo(p)["ok"])
        self.assertEqual(p.read_bytes(), blob("1"))

    def test_parent_folder_gone(self):
        sub = self.docs / "会被删的文件夹"
        sub.mkdir()
        p = self.write("x.md", b"x", sub)
        self.k.keep(p, "覆盖前")
        shutil.rmtree(sub)
        r = self.k.undo(p)
        self.assertFalse(r["ok"])
        self.assertEqual(r["action"], "failed")
        self.assertIn("文件夹不在了", r["message"])
        self.assertFalse(sub.exists())  # 不替用户建文件夹
        self.assertEqual(len(self.k.history(p)), 1)


class OriginalTest(Base):
    """原件：草稿纸第一次改这个文件之前的那份。先在撤回队列里，被挤出队列时挪到永久的位置。"""

    def keep_n(self, p, start, n):
        """连着留 n 次：每次先留底（这时内容是 blob(i)），再把文件改成 blob(i+1)。"""
        for i in range(start, start + n):
            self.assertEqual(p.read_bytes(), blob(str(i)))
            self.k.keep(p, f"覆盖前 {i}")
            p.write_bytes(blob(str(i + 1)))

    def test_moved_to_permanent_place_when_squeezed_out(self):
        p = self.write("报告.pptx", blob("0"))
        self.assertIsNone(self.k.original(p))
        self.keep_n(p, 0, 5)
        o = self.k.original(p)
        self.assertFalse(o["permanent"])  # 还在撤回队列里：就是队列里最旧的那条
        self.assertEqual(o["id"], self.k.history(p)[-1]["id"])
        self.assertEqual(Path(o["copy"]).read_bytes(), blob("0"))

        self.keep_n(p, 5, 1)  # 第 6 次：第一版被挤出队列
        o = self.k.original(p)
        self.assertTrue(o["permanent"])
        self.assertEqual(o["kind"], "original")
        self.assertEqual(o["note"], "覆盖前 0")
        copy = Path(o["copy"])
        self.assertEqual(copy.name, f"original-{o['id']}.pptx")
        self.assertEqual(copy.read_bytes(), blob("0"))
        self.assertEqual((o["size"], o["sha256"]), (len(blob("0")), sha(blob("0"))))
        h = self.k.history(p)
        self.assertEqual([x["note"] for x in h], [f"覆盖前 {i}" for i in (5, 4, 3, 2, 1)])  # 不计入 5 版
        mtime = copy.stat().st_mtime_ns

        self.keep_n(p, 6, 10)  # 之后再留多少次，它都在、不变
        self.assertEqual(self.k.original(p), o)
        self.assertEqual(copy.read_bytes(), blob("0"))
        self.assertEqual(copy.stat().st_mtime_ns, mtime)
        folder = copy.parent
        self.assertEqual(len([f for f in os.listdir(folder) if f != keep.MANIFEST]), 6)

        for _ in range(5):  # 撤回的步数不变，也不碰原件
            self.assertTrue(self.k.undo(p)["ok"])
        self.assertEqual(self.k.undo(p)["action"], "nothing")
        self.assertEqual(p.read_bytes(), blob("11"))
        self.assertEqual(self.k.original(p), o)
        self.assertEqual(sorted(os.listdir(folder)), sorted([keep.MANIFEST, copy.name]))

    def test_undone_original_then_next_keep_is_new_original(self):
        p = self.write("方案.docx", blob("0"))
        self.keep_n(p, 0, 2)
        self.assertEqual(Path(self.k.original(p)["copy"]).read_bytes(), blob("0"))
        self.assertTrue(self.k.undo(p)["ok"])
        self.assertTrue(self.k.undo(p)["ok"])
        self.assertEqual(p.read_bytes(), blob("0"))  # 文件回到了最初的样子：没有要永久留的了
        self.assertIsNone(self.k.original(p))
        p.write_bytes(blob("A"))  # 用户自己改过，草稿纸再来改
        rec = self.k.keep(p, "覆盖前 新一轮")
        o = self.k.original(p)
        self.assertEqual((o["id"], o["permanent"]), (rec["id"], False))
        p.write_bytes(blob("B"))
        for i in range(5):
            self.k.keep(p, f"再改 {i}")
            p.write_bytes(blob(f"再改后 {i}"))
        o = self.k.original(p)
        self.assertTrue(o["permanent"])
        self.assertEqual(o["id"], rec["id"])
        self.assertEqual(Path(o["copy"]).read_bytes(), blob("A"))
        folder = Path(o["copy"]).parent
        self.assertEqual([f for f in os.listdir(folder) if f.startswith(keep.ORIG_PREFIX)], [Path(o["copy"]).name])

    def test_saveas_record_is_not_original(self):
        a = self.write("报告_v1.pptx", blob("A"))
        new = Path(next_name(a))
        new.write_bytes(blob("0"))
        self.k.keep(a, "另存前", saved_as=new)
        self.assertIsNone(self.k.original(new))
        self.assertIsNone(self.k.original(a))
        self.keep_n(new, 0, 1)
        o = self.k.original(new)  # 新文件名下第一次真正留副本的那一版
        self.assertFalse(o["permanent"])
        self.assertEqual(Path(o["copy"]).read_bytes(), blob("0"))
        self.keep_n(new, 1, 5)  # 队列：另存、0…5 共 7 条 → 挤出另存那条和 0
        o = self.k.original(new)
        self.assertTrue(o["permanent"])
        self.assertEqual(Path(o["copy"]).read_bytes(), blob("0"))
        self.assertIsNone(self.k.original(a))

    def test_found_again_after_manifest_rebuilt(self):
        p = self.write("报告.pptx", blob("0"))
        self.keep_n(p, 0, 6)
        o = self.k.original(p)
        folder = Path(o["copy"]).parent
        (folder / keep.MANIFEST).write_text("{坏了", "utf-8")
        ro = self.k.original(p)  # 只读：按文件认回来
        self.assertTrue(ro["permanent"])
        self.assertEqual((ro["copy"], ro["sha256"]), (o["copy"], o["sha256"]))
        self.assertNotIn(o["id"], [x["id"] for x in self.k.history(p)])
        self.assertEqual(len(self.k.history(p)), 5)
        rec = self.k.keep(p, "覆盖前 6")  # 往里写时把清单修好
        self.assertIn("清单读不出来", rec["warning"])
        man = json.loads((folder / keep.MANIFEST).read_text("utf-8"))
        self.assertEqual(man["original"]["file"], Path(o["copy"]).name)
        p.write_bytes(blob("7"))
        self.keep_n(p, 7, 6)
        self.assertEqual(self.k.original(p)["id"], o["id"])
        self.assertEqual(Path(o["copy"]).read_bytes(), blob("0"))
        self.assertEqual([f for f in os.listdir(folder) if f.startswith(keep.ORIG_PREFIX)], [Path(o["copy"]).name])

    def test_nothing_deletes_the_original(self):
        """记录被改得指向原件、原件那一项被改坏、最新副本坏了被去掉、撤回到底、再留很多版：原件一直在。"""
        p = self.write("报告.pptx", blob("0"))
        self.keep_n(p, 0, 6)
        o = self.k.original(p)
        copy = Path(o["copy"])
        folder = copy.parent
        man = json.loads((folder / keep.MANIFEST).read_text("utf-8"))
        man["versions"][0]["file"] = copy.name             # 一条队列记录指向原件：这条不认
        man["original"]["file"] = "..\\..\\别处.pptx"       # 原件那一项被改坏：按文件夹里的文件认回来
        (folder / keep.MANIFEST).write_text(json.dumps(man, ensure_ascii=False), "utf-8")
        self.assertEqual(self.k.original(p)["copy"], o["copy"])
        Path(self.k.history(p)[0]["copy"]).write_bytes(b"tampered")
        self.assertEqual(self.k.undo(p)["action"], "skipped")
        for _ in range(10):
            if self.k.undo(p)["action"] == "nothing":
                break
        p.write_bytes(blob("20"))
        self.keep_n(p, 20, 8)
        self.assertEqual(copy.read_bytes(), blob("0"))
        o2 = self.k.original(p)
        self.assertEqual((o2["id"], o2["copy"], o2["permanent"]), (o["id"], o["copy"], True))
        self.assertEqual([f for f in os.listdir(folder) if f.startswith(keep.ORIG_PREFIX)], [copy.name])
        self.assertEqual(sorted(os.listdir(self.docs)), ["报告.pptx"])
        keep._unlink(copy)  # 最后一道保险：模块里删文件的那一处，碰到 original- 开头的名字也不删
        self.assertTrue(copy.is_file())

    def test_rename_step_missed_still_found_and_healed(self):
        """清单写好了、原件改名那一步没做成（打桩）：照样找得到，下次往里写时补上改名。"""
        p = self.write("报告.pptx", blob("0"))
        self.keep_n(p, 0, 5)
        first = self.k.original(p)
        real_swap = keep._swap

        def swap(src, dst):
            if os.path.basename(dst).startswith(keep.ORIG_PREFIX):
                raise PermissionError(13, "占着")
            return real_swap(src, dst)

        with mock.patch.object(keep, "_swap", side_effect=swap):
            self.keep_n(p, 5, 1)
        o = self.k.original(p)
        self.assertTrue(o["permanent"])
        self.assertEqual(o["copy"], first["copy"])  # 还在原来的名字下
        self.assertEqual(Path(o["copy"]).read_bytes(), blob("0"))
        self.keep_n(p, 6, 1)
        o = self.k.original(p)
        self.assertEqual(Path(o["copy"]).name, f"original-{o['id']}.pptx")
        self.assertEqual(Path(o["copy"]).read_bytes(), blob("0"))
        self.assertFalse(Path(first["copy"]).exists())


class AsideTest(Base):
    """撤回前另留一份：不进撤回队列，undo 永远不写回它。"""

    def test_undo_still_writes_back_the_latest_keep(self):
        p = self.write("报告.docx", blob("0"))
        self.k.keep(p, "覆盖前")
        p.write_bytes(blob("1"))           # Claude 改成 1
        p.write_bytes(blob("1 又手改过"))   # 用户之后又在电脑上改过
        a = self.k.aside(p, "撤回前")
        self.assertEqual(a["kind"], "aside")
        self.assertEqual(a["note"], "撤回前")
        self.assertIsNone(a["warning"])
        self.assertEqual(Path(a["copy"]).parent.name, keep.ASIDE_DIR)
        self.assertEqual(Path(a["copy"]).read_bytes(), blob("1 又手改过"))
        self.assertEqual(len(self.k.history(p)), 1)  # 不占撤回队列
        r = self.k.undo(p)
        self.assertTrue(r["ok"], r["message"])
        self.assertEqual(p.read_bytes(), blob("0"))
        self.assertEqual(self.k.undo(p)["action"], "nothing")
        self.assertEqual(p.read_bytes(), blob("0"))
        got = self.k.asides(p)
        self.assertEqual([x["id"] for x in got], [a["id"]])
        self.assertEqual(Path(got[0]["copy"]).read_bytes(), blob("1 又手改过"))
        self.assertEqual(sorted(os.listdir(self.docs)), ["报告.docx"])

    def test_at_most_five_and_no_duplicates(self):
        p = self.write("笔记.md", b"0")
        ids = []
        for i in range(7):
            p.write_bytes(f"第 {i} 份".encode("utf-8"))
            ids.append(self.k.aside(p, f"另留 {i}")["id"])
        self.assertEqual(self.k.aside(p, "又一次")["id"], ids[-1])  # 和最近一份一样：不重复留
        got = self.k.asides(p)
        self.assertEqual([x["note"] for x in got], [f"另留 {i}" for i in (6, 5, 4, 3, 2)])
        self.assertEqual(Path(got[-1]["copy"]).read_bytes(), "第 2 份".encode("utf-8"))
        self.assertEqual(len(os.listdir(Path(got[0]["copy"]).parent)), 5)  # 丢掉的两份删了
        self.assertEqual(self.k.history(p), [])
        self.assertIsNone(self.k.original(p))  # 另留的不算原件
        self.assertEqual(self.k.undo(p)["action"], "nothing")

    def test_survive_full_undo_and_do_not_count_against_queue(self):
        p = self.write("报告.pptx", blob("0"))
        for i in range(5):
            self.k.keep(p, f"覆盖前 {i}")
            p.write_bytes(blob(str(i + 1)))
        for i in range(3):
            p.write_bytes(blob(f"手改 {i}"))
            self.k.aside(p, "撤回前")
        self.assertEqual(len(self.k.history(p)), 5)
        self.assertFalse(self.k.original(p)["permanent"])  # 没有因为另留的把第一版挤出队列
        for _ in range(5):
            self.assertTrue(self.k.undo(p)["ok"])
        self.assertEqual(p.read_bytes(), blob("0"))
        self.assertEqual(self.k.undo(p)["action"], "nothing")
        got = self.k.asides(p)
        self.assertEqual([Path(x["copy"]).read_bytes() for x in got], [blob(f"手改 {i}") for i in (2, 1, 0)])
        self.assertIsNone(self.k.original(p))  # 第一版被撤回去了

    def test_errors_and_rebuild(self):
        with self.assertRaises(KeepError) as cm:
            self.k.aside(self.docs / "没有这个.md")
        self.assertIn("找不到", str(cm.exception))
        self.assertFalse(self.k.root.exists())
        p = self.write("a.md", b"x")
        self.assertEqual(self.k.asides(p), [])
        self.k.aside(p, "一")
        p.write_bytes(b"y")
        self.k.aside(p, "二")
        folder = Path(self.k.asides(p)[0]["copy"]).parent.parent
        (folder / keep.MANIFEST).write_text("not json", "utf-8")
        got = self.k.asides(p)  # 清单坏了：按 aside 文件夹里的副本找回
        self.assertEqual([Path(x["copy"]).read_bytes() for x in got], [b"y", b"x"])
        self.assertIn("清单坏了", got[0]["note"])
        p.write_bytes(b"z")
        self.assertIn("清单读不出来", self.k.aside(p, "三")["warning"])
        self.assertEqual(len(self.k.asides(p)), 3)


class ConcurrencyTest(Base):
    def run_threads(self, n, fn):
        errors, barrier = [], threading.Barrier(n)

        def work(i):
            try:
                barrier.wait()
                fn(i)
            except Exception as e:  # noqa: BLE001
                errors.append(e)

        ts = [threading.Thread(target=work, args=(i,)) for i in range(n)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(errors, [])

    def test_different_files_in_parallel(self):
        files = [self.write(f"文件 {i}.md", blob(f"{i}-0")) for i in range(8)]

        def fn(i):
            for j in range(1, 4):
                self.k.keep(files[i], f"第 {j} 次")
                files[i].write_bytes(blob(f"{i}-{j}"))

        self.run_threads(8, fn)
        for i, f in enumerate(files):
            h = self.k.history(f)
            self.assertEqual([x["note"] for x in h], ["第 3 次", "第 2 次", "第 1 次"])
            self.assertEqual(Path(h[0]["copy"]).read_bytes(), blob(f"{i}-2"))
        self.assertEqual(len(os.listdir(self.k.root)), 8)

    def test_same_file_in_parallel(self):
        p = self.write("同一个.pptx", blob("x"))
        ids = []
        self.run_threads(10, lambda i: ids.append(self.k.keep(p, "覆盖前")["id"]))
        self.assertEqual(len(set(ids)), 1)
        h = self.k.history(p)
        self.assertEqual(len(h), 1)
        self.assertEqual(sorted(os.listdir(Path(h[0]["copy"]).parent)), sorted([keep.MANIFEST, Path(h[0]["copy"]).name]))

    def test_appends_to_one_list_in_parallel(self):
        """5 个线程同时往同一个文件的清单里加记录（都另存成同一个新文件）：一条不丢。"""
        target = self.docs / "合并 (改1).pptx"
        srcs = [self.write(f"来源 {i}.pptx", blob(f"s{i}")) for i in range(5)]
        self.run_threads(5, lambda i: self.k.keep(srcs[i], "另存前", saved_as=target))
        h = self.k.history(target)
        self.assertEqual(len(h), 5)
        self.assertEqual({os.path.normcase(x["path"]) for x in h}, {os.path.normcase(str(s)) for s in srcs})
        self.assertEqual(len({x["id"] for x in h}), 5)


if __name__ == "__main__":
    unittest.main()

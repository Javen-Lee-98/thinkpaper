"""tools/folder_existing.py：把已有的本子一次放进一个文件夹（默认试跑，--apply 才写；服务在跑时拒绝 --apply）。
只在临时数据上跑；查「服务在不在」用这个测试自己起的服务或一个没有服务的端口，不碰正式服务的端口。"""
import contextlib
import io
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

import pymupdf as fitz  # noqa: E402

import folder_existing as fe  # noqa: E402
import folders  # noqa: E402
import server  # noqa: E402

NO_SERVICE = 9  # 查「正式服务在不在」时用的端口：这里不会有草稿纸服务


def make_pdf(path):
    doc = fitz.open()
    doc.new_page(width=400, height=300).insert_text((40, 60), "x")
    doc.save(str(path))
    doc.close()


class FolderExistingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.data, self.books = base / "data", base / "books"
        self.app = server.App(SimpleNamespace(host="127.0.0.1", port=0, config=str(base / "none.json"),
                                              data=str(self.data), books=str(self.books), open=False))
        self.p1, self.p2, self.p3 = self.app.new_pad("随笔"), self.app.new_pad("想法"), self.app.new_pad("读书笔记")
        make_pdf(self.books / "例会_v47.pdf")
        make_pdf(self.books / "论文.pdf")
        # 「想法」已经在别的文件夹里：不动
        self.app.change_folders(lambda fs: folders.move(fs, self.p2, folders.create(fs, "课题")["id"]))

    def tearDown(self):
        self.tmp.cleanup()

    def snapshot(self):
        nb = self.data / "notebooks"
        return {str(p.relative_to(self.data)): p.read_bytes() for p in nb.rglob("*") if p.is_file()} | \
               {str(p.relative_to(self.books)): p.read_bytes() for p in self.books.rglob("*") if p.is_file()}

    def run_tool(self, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = fe.main(["--data", str(self.data), "--name", "原先", "--port", str(NO_SERVICE), *extra])
        return code, out.getvalue()

    def test_dry_run_writes_nothing(self):
        before = self.snapshot()
        code, text = self.run_tool()
        self.assertEqual(code, 0)
        self.assertIn("试跑（什么都没写）", text)
        self.assertIn("还没有，新建一个（默认折叠）", text)
        self.assertIn("要放进去的：4 本", text)
        for title in ("随笔", "读书笔记", "例会_v47", "论文"):
            self.assertIn(f"  {title}", text)
        self.assertIn("想法（在「课题」里）", text)
        self.assertEqual(self.snapshot(), before)                     # 一个字节都没写

    def test_apply_puts_existing_notebooks_in_once(self):
        before = self.snapshot()
        code, text = self.run_tool("--apply")
        self.assertEqual(code, 0, text)
        got = {f["name"]: f for f in folders.load(self.data)}
        self.assertEqual(sorted(got), ["原先", "课题"])
        self.assertEqual(got["原先"]["items"], [self.p1, self.p3, "book:例会_v47.pdf", "book:论文.pdf"])
        self.assertTrue(got["原先"].get("folded"))                    # 「原先」默认折叠
        self.assertEqual(got["课题"]["items"], [self.p2])              # 已经在别的文件夹里的不动
        self.assertNotIn("scratch", got["原先"]["items"])              # 草稿本、Claude 推送不进
        after = self.snapshot()                                        # 只写了 folders.json：pads.json、本子文件夹、书都没动
        changed = {k for k in after if before.get(k) != after[k]}
        self.assertEqual(changed, {str(Path("notebooks") / "folders.json")})
        # 平板看到的和文件里记的一样
        self.assertEqual([(f["name"], f["items"]) for f in self.app.folder_list()],
                         [("课题", [self.p2]), ("原先", [self.p1, self.p3, "book:例会_v47.pdf", "book:论文.pdf"])])

    def test_twice_is_the_same_and_existing_folder_gets_more(self):
        self.assertEqual(self.run_tool("--apply")[0], 0)
        first = folders.path_of(self.data).read_bytes()
        code, text = self.run_tool("--apply")                         # 跑第二遍：都已经在里面，什么都不写
        self.assertEqual(code, 0)
        self.assertIn("没有要放的，什么都没写", text)
        self.assertEqual(folders.path_of(self.data).read_bytes(), first)
        # 之后又有了新本子、文件夹已经有了：往里加，不新建第二个
        p4 = self.app.new_pad("新的")
        code, text = self.run_tool("--apply")
        self.assertIn("已经有了，往里加", text)
        got = [f for f in folders.load(self.data) if f["name"] == "原先"]
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["items"][-1], p4)

    def test_refuses_apply_while_service_runs(self):
        """服务在跑：拒绝 --apply，什么都没写。用这个测试自己起的服务（一个空端口），不碰正式服务。"""
        server.Handler.app = self.app
        httpd = server.Server(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            before = self.snapshot()
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = fe.main(["--data", str(self.data), "--name", "原先", "--apply", "--port", str(httpd.server_address[1])])
            self.assertEqual(code, 2)
            self.assertIn("草稿纸服务正在跑", out.getvalue())
            self.assertEqual(self.snapshot(), before)
            # 试跑不查服务，照样出报告
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(fe.main(["--data", str(self.data), "--name", "原先", "--port", str(httpd.server_address[1])]), 0)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_bad_arguments(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(fe.main(["--data", str(self.data), "--name", "  ", "--port", str(NO_SERVICE)]), 2)
            self.assertEqual(fe.main(["--data", str(Path(self.tmp.name) / "nope"), "--name", "原先", "--port", str(NO_SERVICE)]), 2)
        folders.path_of(self.data).write_text("{坏了", "utf-8")       # 文件夹的记录坏了：不覆盖
        code, text = self.run_tool("--apply")
        self.assertEqual(code, 2)
        self.assertEqual(folders.path_of(self.data).read_text("utf-8"), "{坏了")


if __name__ == "__main__":
    unittest.main()

"""卡片里的上一条、下一条跨页（2026-11-16 夜用户定，《产品定义》第 2 节）：服务这一侧。

本子信息（/api/notebook）里，有没擦掉的长回答（带圈号的 write）的页，pageInfo 那一项带 ans: 几条——平板靠它知道别的页有没有回答，
不用把每页都载下来。从每页的数据文件只读地算（不写任何文件），按文件的修改时间和大小记着，没改过不再读；擦掉的、没有圈号位置的、
别的种类、还没落到纸上的（待处理文件里的）不算；文件坏了算 0；插页、删页后跟着那一页走（按页的键）。

    .venv\\Scripts\\python.exe -m unittest discover -s tests
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # 单独跑这个文件时也找得到 test_server

from test_server import make_app  # noqa: E402

import server  # noqa: E402


def counts(app, nb="scratch"):
    return [p.get("ans", 0) for p in app.notebook_info(nb)["pageInfo"]]


def write_page(app, nb, i, ai):
    f = app._page_file(nb, i)
    f.write_text(json.dumps({"v": 1, "strokes": [], "ai": ai, "reads": []}, ensure_ascii=False), "utf-8")
    return f


def badge(n, **kw):
    return dict({"id": f"w{n}", "type": "write", "text": f"第 {n} 条", "n": n, "at": [400.0, 100.0 * n]}, **kw)


def snapshot(d):
    """数据文件夹里每个文件的（大小、修改时间、内容）：比一比算之前算之后有没有写过东西。"""
    return {str(p.relative_to(d)): (p.stat().st_size, p.stat().st_mtime_ns, p.read_bytes()) for p in sorted(d.rglob("*")) if p.is_file()}


class AnswerCountTest(unittest.TestCase):
    def test_counts_long_answers_per_page_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            for _ in range(3):
                app.add_page("scratch")
            self.assertEqual(counts(app), [0, 0, 0, 0])
            self.assertNotIn("ans", app.notebook_info("scratch")["pageInfo"][0])  # 没有就不带这一项
            write_page(app, "scratch", 1, [badge(1), badge(2), {"id": "n1", "type": "note", "text": "短批注", "at": [1, 2]}])
            write_page(app, "scratch", 3, [
                badge(1, erasedAt=123),                      # 擦掉的
                {"id": "w9", "type": "write", "text": "没有圈号位置"},  # 老样子、没有 at：纸上点不到
                badge(2, at=[1, "x"]),                       # at 不是两个数
                badge(3, at=[True, 2]),                      # true 不算数
                badge(4, dismissed=True, erasedAt=5),        # 清除本页批注清掉的
                badge(5),
            ])
            # 还没落到纸上的长回答（待处理文件里的）不算
            app.add_pending("scratch", app.page_key("scratch", 2), {"req": "a", "items": [{"type": "write", "text": "长回答"}], "t": 1})
            self.assertEqual(counts(app), [0, 2, 0, 1])
            # 只读：算一遍前后，数据文件夹里没有任何文件变了、多了
            before = snapshot(app.data)
            app.notebook_info("scratch")
            app._ans_cache.clear()
            app.notebook_info("scratch")
            self.assertEqual(snapshot(app.data), before)

    def test_cached_by_mtime_and_size(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            app.add_page("scratch")
            f = write_page(app, "scratch", 1, [badge(1), badge(2)])
            self.assertEqual(counts(app), [0, 2])
            st = f.stat()
            # 内容换了，但大小和修改时间都和原来一样：当没改过，不再读（用记着的数）
            body = f.read_text("utf-8").replace('"write"', '"wrxte"', 1)
            self.assertEqual(len(body.encode("utf-8")), st.st_size)
            f.write_text(body, "utf-8")
            os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns))
            self.assertEqual(counts(app), [0, 2])
            # 平板擦掉了一条、存了（文件变了）：重新读
            write_page(app, "scratch", 1, [badge(1), badge(2, erasedAt=99)])
            os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 10_000_000))
            self.assertEqual(counts(app), [0, 1])
            # 读到半截、坏了：算 0，不出错；修好了又对
            f.write_text('{"ai": [', "utf-8")
            os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 20_000_000))
            self.assertEqual(counts(app), [0, 0])
            f.write_text(json.dumps({"ai": "不是列表"}), "utf-8")
            os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 30_000_000))
            self.assertEqual(counts(app), [0, 0])
            write_page(app, "scratch", 1, [badge(7)])
            os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 40_000_000))
            self.assertEqual(counts(app), [0, 1])

    def test_follows_page_key_and_books(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(tmp)
            app.add_page("scratch")
            write_page(app, "scratch", 1, [badge(1)])
            app.insert_page("scratch", 0)  # 第 1 页后插一页：有回答的那页变成第 3 页
            self.assertEqual(counts(app), [0, 0, 1])
            app.delete_page("scratch", 0)
            self.assertEqual(counts(app), [0, 1])
            import pymupdf as fitz  # 新模块名（import fitz 会往标准输出写一句弃用提醒）
            doc = fitz.open()
            for _ in range(3):
                doc.new_page(width=595, height=842)
            doc.save(str(app.books / "讲义.pdf"))
            nb = "book:讲义.pdf"
            self.assertEqual(counts(app, nb), [0, 0, 0])
            write_page(app, nb, 2, [badge(1), badge(2), badge(3)])
            self.assertEqual(counts(app, nb), [0, 0, 3])

    def test_is_badge_matches_tablet_rule(self):
        self.assertTrue(server.is_badge({"type": "write", "at": [1, 2.5]}))
        for a in (None, [], {"type": "note", "at": [1, 2]}, {"type": "write"}, {"type": "write", "at": [1]},
                  {"type": "write", "at": [1, 2], "erasedAt": 3}, {"type": "write", "at": "1,2"}, {"type": "write", "at": [None, 2]}):
            self.assertFalse(server.is_badge(a), a)


if __name__ == "__main__":
    unittest.main()

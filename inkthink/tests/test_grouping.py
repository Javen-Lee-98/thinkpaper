"""笔迹分组的后两步（同一行接着写、回头补的小笔画）、预识别的语种判断，以及跟着分组变的编号、书写过程、识别对应到哪一组。

夹具都是程序合成的笔画：拉丁字母是一笔弯弯的「字母」，汉字是四笔（横、竖、撇、点），按坐标排成词和行。
平板页面 static/app.js 的 computeGroups 和服务端 pages._cluster 是同一套规则：fixture_cases() 生成的几页笔迹存在
tests/fixtures/grouping.json，这里（FixtureTest）和浏览器测试 tests/browser/grouping.mjs 各读一遍、各分一次组来比。
改了 fixture_cases() 后重新生成那个文件：.venv\\Scripts\\python.exe tests\\test_grouping.py --write-fixture
"""
import json
import math
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import inksheet  # noqa: E402
import pages  # noqa: E402
import prompt  # noqa: E402
import recognize  # noqa: E402
import server  # noqa: E402

T = 1_700_000_000_000
H = 40  # 字高（页面单位）


def _stroke(sid, t0, pts, red=False):
    s = {"id": sid, "t0": t0, "w": 2.1, "pts": [[x, y, 0.5, 20 * k] for k, (x, y) in enumerate(pts)]}
    if red:
        s["c"] = "r"
    return s


def letter(sid, t0, x, y, h=H, red=False):
    """一个拉丁字母：一笔弯的（像 a、e 那样绕一圈），宽约半个字高，(x, y) 是左上角。"""
    pts = [(x + h * 0.25 + h * 0.22 * math.cos(a), y + h * 0.5 + h * 0.3 * math.sin(a)) for a in [k * 0.6 for k in range(12)]]
    return _stroke(sid, t0, pts, red)


def word(prefix, t0, x, y, n, h=H, dt=250, red=False):
    """n 个字母连着写成一个词：每个字母隔 0.55 个字高、隔 dt 毫秒。返回笔迹列表。"""
    return [letter(f"{prefix}{k}", t0 + k * dt, x + k * h * 0.55, y, h, red) for k in range(n)]


def hanzi(prefix, t0, x, y, size=H, red=False):
    """一个汉字样子的四笔（横、竖、撇、点），占 size × size 的方块。"""
    s = size
    strokes = [[(x + 0.1 * s, y + 0.35 * s), (x + 0.9 * s, y + 0.35 * s)],
               [(x + 0.5 * s, y + 0.05 * s), (x + 0.5 * s, y + 0.95 * s)],
               [(x + 0.45 * s, y + 0.5 * s), (x + 0.15 * s, y + 0.85 * s)],
               [(x + 0.65 * s, y + 0.6 * s), (x + 0.8 * s, y + 0.75 * s)]]
    return [_stroke(f"{prefix}{k}", t0 + k * 150, [(px, py) for px, py in st], red) for k, st in enumerate(strokes)]


def dot(sid, t0, x, y, red=False):
    return _stroke(sid, t0, [(x, y), (x + 2, y + 2)], red)


def ids(groups):
    return [sorted(s["id"] for s in g["strokes"]) for g in groups]


def end_of(ss):
    return max(pages.stroke_t1(s) for s in ss)


class JoinLineTest(unittest.TestCase):
    def test_pause_in_the_middle_of_a_word(self):
        """写到一半停了 2 秒：第一步分成两组，第二步并回一个词。"""
        a = word("a", T, 100, 100, 5)
        b = word("b", end_of(a) + 2000, 100 + 5 * H * 0.55, 100, 6)
        self.assertEqual(len(pages._by_time(a + b)), 2)
        self.assertEqual(ids(pages._cluster(a + b)), [sorted(s["id"] for s in a + b)])
        g = pages.compute_groups(a + b)
        self.assertEqual([x["id"] for x in g], ["g1"])
        self.assertEqual(g[0]["n"], 11)

    def test_a_sentence_of_characters_with_pauses(self):
        """一句汉字，字和字之间停了几秒：同一行、挨着，并成一组。"""
        ss, t = [], T
        for k in range(4):
            ss += hanzi(f"h{k}_", t, 100 + k * H * 1.1, 100)
            t = end_of(ss) + 3000
        self.assertEqual(len(pages._by_time(ss)), 4)
        self.assertEqual(len(pages._cluster(ss)), 1)

    def test_two_lines_are_not_joined(self):
        a = word("a", T, 100, 100, 5)
        b = word("b", end_of(a) + 3000, 100, 100 + H * 1.5, 5)
        self.assertEqual(ids(pages._cluster(a + b)), [sorted(s["id"] for s in a), sorted(s["id"] for s in b)])

    def test_two_colors_are_not_joined(self):
        """红笔问题紧挨着黑字写：不并。"""
        a = word("a", T, 100, 100, 5)
        b = word("b", end_of(a) + 2000, 100 + 5 * H * 0.55, 100, 5, red=True)
        g = pages.compute_groups(a + b)
        self.assertEqual([x["red"] for x in g], [False, True])

    def test_far_apart_on_one_line_are_not_joined(self):
        a = word("a", T, 100, 100, 4)
        b = word("b", end_of(a) + 2000, 100 + 4 * H * 0.55 + 3 * H, 100, 4)
        self.assertEqual(len(pages._cluster(a + b)), 2)

    def test_long_pause_is_not_joined(self):
        a = word("a", T, 100, 100, 4)
        b = word("b", end_of(a) + pages.LINE_PAUSE_MS + 1000, 100 + 4 * H * 0.55, 100, 4)
        self.assertEqual(len(pages._cluster(a + b)), 2)

    def test_big_and_small_writing_are_not_joined(self):
        a = word("a", T, 100, 100, 3, h=3 * H)
        b = word("b", end_of(a) + 2000, 100 + 3 * 3 * H * 0.55, 100 + 2 * H, 4)  # 小字写在大字右下，竖直方向有重叠
        self.assertEqual(len(pages._cluster(a + b)), 2)

    def test_brackets_lines_and_arrows_stay_apart_from_text(self):
        """画的东西不和字并：竖得很长的一笔（括号）、很长的直线（箭头杆）。"""
        bracket = [_stroke("br", T, [(92, 94 + 2 * k) for k in range(27)])]          # 一竖，比字高出一半多一点
        text = word("a", T + 2500, 100, 100, 5)
        self.assertEqual(len(pages._cluster(bracket + text)), 2)
        tall = [_stroke("br", T, [(92, 20 + 6 * k) for k in range(30)])]             # 高约 4 个字高的括号
        self.assertEqual(len(pages._cluster(tall + text)), 2)
        shaft = [_stroke("ln", T, [(100 + 10 * k, 120) for k in range(30)])]          # 长约 7 个字高的直线
        text2 = word("b", T + 2500, 100 + 300 + 5, 100, 5)
        self.assertEqual(len(pages._cluster(shaft + text2)), 2)

    def test_numbering_follows_first_stroke(self):
        """编号按每组第一笔的先后：并起来的组占前一组的号，后面的组顺次往前挪。"""
        a = word("a", T, 100, 100, 4)
        b = word("b", end_of(a) + 2000, 100 + 4 * H * 0.55, 100, 4)
        q = word("q", end_of(b) + 5000, 100, 300, 4, red=True)
        g = pages.compute_groups(a + b + q)
        self.assertEqual([x["id"] for x in g], ["g1", "g2"])
        self.assertEqual([x["n"] for x in g], [8, 4])
        self.assertEqual([gid for gid, _ in pages.group_strokes(a + b + q)], ["g1", "g2"])


class LateStrokeTest(unittest.TestCase):
    def setUp(self):
        self.w = word("w", T, 100, 100, 5)                  # 第一行一个词
        self.next = word("n", end_of(self.w) + 3000, 100, 200, 5)  # 接着写下一行

    def test_dot_and_bar_go_back_to_their_word(self):
        """写完下一行，过了 40 秒回头给第一个词补一点、一横：并回那个词，书写过程写明是回头补的。"""
        late_t = end_of(self.next) + 40000
        d = dot("d", late_t, 100 + H * 0.3, 100 - 4)                                    # 点在字母上方一点
        bar = _stroke("bar", late_t + 3000, [(100 + H * 0.6, 102), (100 + H * 0.9, 102)])  # 又过 3 秒，一小横压在字母上
        g = pages.compute_groups(self.w + self.next + [d, bar])
        self.assertEqual([x["n"] for x in g], [7, 5])
        self.assertEqual((g[0]["late"], g[0]["lateAt"]), (2, late_t + 3000))
        self.assertLess(g[0]["tw"], g[1]["t0"])            # 不算补的，它在下一行之前就写完了
        self.assertEqual(g[0]["t1"], max(pages.stroke_t1(s) for s in [d, bar]))  # 「有没有新东西」按补的那一笔算
        tl = prompt.build_timeline(g, late_t + 5000, True)
        self.assertIn("其中 2 笔是 ", tl)
        self.assertIn("回头补的", tl)
        self.assertIn("之前停顿 3 秒", tl)                  # 下一行和第一个词之间的停顿，不被补的笔画打乱
        self.assertNotIn("回头补写（写在较早的笔迹旁边）", tl)

    def test_small_stroke_far_from_the_word_stays_alone(self):
        d = dot("d", end_of(self.next) + 40000, 100 + H, 100 + H * 1.6)  # 在第一行和第二行中间，不贴着字
        self.assertEqual([x["n"] for x in pages.compute_groups(self.w + self.next + [d])], [5, 5, 1])

    def test_other_color_or_big_stroke_is_not_late(self):
        t = end_of(self.next) + 40000
        red = dot("r", t, 100 + H * 0.3, 100 + H * 0.4, red=True)
        big = _stroke("big", t + 1000, [(100, 120), (200, 125)])  # 一长横划过整个词：是删除线之类，不是补的一笔
        self.assertEqual(len(pages.compute_groups(self.w + self.next + [red, big])), 4)

    def test_mark_on_a_drawing_is_not_late(self):
        """压在画的图上的小笔画：那组不像一行字，不并。"""
        ring = [_stroke("o", T, [(300 + 120 * math.cos(a / 10), 300 + 120 * math.sin(a / 10)) for a in range(63)])]
        d = dot("d", T + 60000, 300 + 118, 300)
        self.assertEqual(len(pages._cluster(ring + [d])), 2)


FIXTURE = Path(__file__).resolve().parent / "fixtures" / "grouping.json"


def fixture_cases():
    """平板和服务端都要分对的几页笔迹（存进 tests/fixtures/grouping.json）。每页：name、about（一句话说是什么情形）、
    strokes、expect（按组号排的每一组：groups 是笔迹 id，late 是回头补了几笔，tw 是不算补的、写完的时刻）。"""
    cases = []

    def case(name, about, groups, late=()):
        """groups：按该分成的样子给的几组笔迹；late：其中哪几笔是回头补的。"""
        groups = sorted(groups, key=lambda g: min(s["t0"] for s in g))
        late_ids = {s["id"] for s in late}
        cases.append({"name": name, "about": about, "strokes": sorted((s for g in groups for s in g), key=lambda s: s["t0"]),
                      "expect": {"groups": [sorted(s["id"] for s in g) for g in groups],
                                 "late": [sum(s["id"] in late_ids for s in g) for g in groups],
                                 "tw": [end_of([s for s in g if s["id"] not in late_ids]) for g in groups]}})

    a = word("a", T, 100, 100, 5)
    b = word("b", end_of(a) + 2000, 100 + 5 * H * 0.55, 100, 6)
    case("pause_in_word", "一个英文词写到一半停了 2 秒：并成一组", [a + b])

    p = word("p", T, 100, 100, 4)                                   # 英文一行三个词，词和词之间停 3 秒、空不到半个字高
    q = word("q", end_of(p) + 3000, 100 + 4 * H * 0.55 + 0.35 * H, 100, 5)
    r = word("r", end_of(q) + 3000, 100 + 4 * H * 0.55 + 0.35 * H + 5 * H * 0.55 + 0.35 * H, 100, 3)
    case("english_line", "英文一行三个词，词间停了 3 秒：一行并成一组", [p + q + r])

    ss, t = [], T
    for k in range(4):
        ss += hanzi(f"h{k}_", t, 100 + k * H * 1.1, 100)
        t = end_of(ss) + 3000
    case("chinese_line", "一句汉字，字和字之间停了 3 秒：并成一组", [ss])

    w = word("w", T, 100, 100, 5)
    n = word("n", end_of(w) + 3000, 100, 200, 5)
    late_t = end_of(n) + 40000
    d = dot("d", late_t, 100 + H * 0.3, 100 - 4)
    bar = _stroke("bar", late_t + 3000, [(100 + H * 0.6, 102), (100 + H * 0.9, 102)])
    case("late_dot_and_bar", "写完下一行，40 秒后回头给第一个词补一点、又过 3 秒补一横：并回那个词，记 2 笔回头补的",
         [w + [d, bar], n], late=[d, bar])

    a = word("a", T, 100, 100, 4)
    b = word("b", end_of(a) + 2500, 100 + 4 * H * 0.55, 100, 4)
    n = word("n", end_of(b) + 3000, 100, 200, 5)
    d = dot("d", end_of(n) + 20000, 100 + 5 * H * 0.55 + H * 0.3, 100 - 4)
    case("late_into_joined_word", "停顿过的一个词（第二步并起来的）、下一行，再回头给词的后半截补一点：点并回那个词",
         [a + b + [d], n], late=[d])

    a = word("a", T, 100, 100, 5)
    b = word("b", end_of(a) + 3000, 100, 100 + H * 1.5, 5)
    case("two_lines", "上下两行：不并", [a, b])

    a = word("a", T, 100, 100, 5)
    b = word("b", end_of(a) + 2000, 100 + 5 * H * 0.55, 100, 5, red=True)
    case("two_colors", "红笔紧挨着黑字接着写：不并", [a, b])

    w = word("w", T, 100, 100, 5)
    n = word("n", end_of(w) + 3000, 100, 200, 5)
    t = end_of(n) + 40000
    red = dot("r", t, 100 + H * 0.3, 100 + H * 0.4, red=True)
    big = _stroke("big", t + 1000, [(100, 120), (200, 125)])
    case("not_late_color_or_size", "压在词上的红点（别的颜色）、一长横划过整个词（太大）：都不当回头补的", [w, n, [red], [big]])

    a = word("a", T, 100, 100, 4)
    b = word("b", end_of(a) + 2000, 100 + 4 * H * 0.55 + 3 * H, 100, 4)
    case("far_apart", "同一行上隔得远的两个词：不并", [a, b])

    w = word("w", T, 100, 100, 5)
    n = word("n", end_of(w) + 3000, 100, 200, 5)
    d = dot("d", end_of(n) + 40000, 100 + H, 100 + H * 1.6)
    case("far_small_stroke", "两行中间、不贴着字的一点：自成一组", [w, n, [d]])

    a = word("a", T, 100, 100, 4)
    b = word("b", end_of(a) + LINE_PAUSE_FIXTURE_MS, 100 + 4 * H * 0.55, 100, 4)
    case("long_pause", "同一行接着写，但停了 16 秒：不并", [a, b])

    a = word("a", T, 100, 100, 3, h=3 * H)
    b = word("b", end_of(a) + 2000, 100 + 3 * 3 * H * 0.55, 100 + 2 * H, 4)
    case("big_and_small", "大字右下接着写小字：不并", [a, b])

    br = [_stroke("br", T, [(92, 94 + 2 * k) for k in range(27)])]
    text = word("a", T + 2500, 100, 100, 5)
    case("bracket_and_text", "竖的一笔（括号）后面接着写字：不并", [br, text])

    tall = [_stroke("br", T, [(92, 20 + 6 * k) for k in range(30)])]
    case("tall_bracket_and_text", "高约 4 个字高的括号后面接着写字：不并", [tall, word("a", T + 2500, 100, 100, 5)])

    shaft = [_stroke("ln", T, [(100 + 10 * k, 120) for k in range(30)])]
    case("line_and_text", "一长横（箭头杆）后面接着写字：不并", [shaft, word("b", T + 2500, 100 + 300 + 5, 100, 5)])

    ring = [_stroke("o", T, [(300 + 120 * math.cos(a / 10), 300 + 120 * math.sin(a / 10)) for a in range(63)])]
    label = word("t", end_of(ring) + 3000, 300 + 125 + 10, 300 - 20, 4)
    mark = dot("m", T + 60000, 300 + 118, 300)
    case("drawing_and_text", "画一个圈、圈右边写字，过一分钟在圈上点一点：三样各自一组", [ring, label, [mark]])

    a = word("a", T, 100, 100, 4)
    b = word("b", end_of(a) + 2000, 100 + 4 * H * 0.55, 100, 4)
    q = word("q", end_of(b) + 5000, 100, 300, 4, red=True)
    case("numbering", "停顿过的一个词并成 g1，下面的红笔问题是 g2", [a + b, q])

    e1 = word("e", T, 100, 100, 5)                                   # 一页：英文一行（词中间停过、词间停过）、下一行、回头补的一点、红笔问题
    e2 = word("f", end_of(e1) + 2500, 100 + 5 * H * 0.55, 100, 4)
    e3 = word("g", end_of(e2) + 3000, 100 + 9 * H * 0.55 + 0.35 * H, 100, 3)
    nx = word("k", end_of(e3) + 3000, 100, 100 + H * 1.6, 6)
    nx[5]["erasedAt"] = end_of(nx) + 1000                            # 下一行擦掉了一笔：擦掉的也参加分组
    dt = dot("i", end_of(nx) + 20000, 100 + H * 0.55 + H * 0.3, 100 - 4)
    qq = word("q", end_of([dt]) + 3000, 100, 300, 4, red=True)
    case("page_mix", "一页：英文一行（词中间停过 2.5 秒、词间停过 3 秒）、下一行（擦掉一笔）、回头补的一点、红笔问题",
         [e1 + e2 + e3 + [dt], nx, qq], late=[dt])
    for c in cases:  # 和平板存的一样：坐标留一位小数
        for s in c["strokes"]:
            s["pts"] = [[round(p[0], 1), round(p[1], 1), p[2], p[3]] for p in s["pts"]]
    return cases


LINE_PAUSE_FIXTURE_MS = 16000  # long_pause 那一页停的时间（比 pages.LINE_PAUSE_MS 长；不直接用常数，免得改常数时夹具跟着变、测不出来）


def write_fixture():
    FIXTURE.parent.mkdir(exist_ok=True)
    body = {"about": "笔迹分组夹具：平板 static/app.js 的 computeGroups 和服务端 pages._cluster 都要分成 expect 那样（"
                     "tests/test_grouping.py 的 fixture_cases() 生成，别手改）。笔迹 pts 是 [x, y, 压力, 距第一点的毫秒]。",
            "cases": fixture_cases()}
    one = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
    cases = []
    for c in body["cases"]:  # 一笔一行，好看 diff
        head = ",".join(f"{one(k)}:{one(v)}" for k, v in c.items() if k != "strokes")
        cases.append(f' {{{head},"strokes":[\n' + ",\n".join("  " + one(s) for s in c["strokes"]) + "]}")
    FIXTURE.write_text(f'{{"about":{one(body["about"])},"cases":[\n' + ",\n".join(cases) + "]}\n", encoding="utf-8", newline="\n")


class FixtureTest(unittest.TestCase):
    """两边一致的那份夹具：服务端分组分成它写的样子；浏览器测试 tests/browser/grouping.mjs 再拿它比平板页面的分组。"""

    def setUp(self):
        self.fx = json.loads(FIXTURE.read_text("utf-8"))

    def test_file_is_up_to_date(self):
        """夹具文件就是 fixture_cases() 生成的（改了生成的办法要重新写文件）。"""
        self.assertEqual(self.fx["cases"], fixture_cases())

    def test_server_groups_as_expected(self):
        names = [c["name"] for c in self.fx["cases"]]
        for name in ("pause_in_word", "late_dot_and_bar", "two_lines", "two_colors", "far_apart", "bracket_and_text",
                     "line_and_text", "drawing_and_text", "chinese_line", "english_line"):
            self.assertIn(name, names)
        for c in self.fx["cases"]:
            with self.subTest(c["name"]):
                gs = pages._cluster(c["strokes"])
                self.assertEqual([sorted(s["id"] for s in g["strokes"]) for g in gs], c["expect"]["groups"])
                self.assertEqual([g.get("late", 0) for g in gs], c["expect"]["late"])
                self.assertEqual([g["tw"] for g in gs], c["expect"]["tw"])
                self.assertEqual([g["t1"] for g in gs], [end_of(g["strokes"]) for g in gs])  # t1 连补的笔画在内


class SentGroupsTest(unittest.TestCase):
    """平板和服务端分组规则不一样时（比如平板上开着还没刷新的旧页面，分组只有第一步），识别、字帖按平板发来的笔迹 id 取，还对得上。"""

    def tablet_groups(self, strokes):
        groups = []
        for k, g in enumerate(pages._by_time(strokes)):  # 旧页面的分组：只有第一步
            groups.append({"id": f"g{k + 1}", "bbox": [round(v) for v in g["bbox"]], "ids": [s["id"] for s in g["strokes"]],
                           "inSel": True, "red": g["c"] == "r"})
        return groups

    def test_ids_win_over_server_rules(self):
        a = word("a", T, 100, 100, 5)
        b = word("b", end_of(a) + 2000, 100 + 5 * H * 0.55, 100, 6)
        page = {"strokes": a + b}
        tg = self.tablet_groups(a + b)
        self.assertEqual(len(tg), 2)
        self.assertEqual(len(pages.compute_groups(a + b)), 1)  # 服务端已经并成一组
        got = pages.sent_groups(tg, page)
        self.assertEqual({k: sorted(s["id"] for s in v) for k, v in got.items()},
                         {"g1": sorted(s["id"] for s in a), "g2": sorted(s["id"] for s in b)})
        self.assertEqual([gid for gid, _ in inksheet.pick(tg, page)], ["g1", "g2"])

    def test_unsaved_or_erased_strokes(self):
        a = word("a", T, 100, 100, 5)
        tg = self.tablet_groups(a)
        self.assertEqual(pages.sent_groups(tg, {"strokes": a[:-1]}), {})           # 平板上的这一页还没存好：少了一笔
        moved = dict(tg[0], bbox=[0, 0, 1, 1])
        self.assertEqual(pages.sent_groups([moved], {"strokes": a}), {})            # 外框对不上
        a[0]["erasedAt"] = T + 9000
        self.assertEqual(len(pages.sent_groups(tg, {"strokes": a})["g1"]), 4)      # 擦掉的不认
        old_style = [dict(g, ids=None) for g in pages.compute_groups(a)]            # 不带 id：按服务端分组对
        self.assertEqual(list(pages.sent_groups(old_style, {"strokes": a})), ["g1"])

    def test_reco_lands_on_the_tablet_groups_with_language(self):
        a = word("a", T, 100, 100, 5)
        b = word("b", end_of(a) + 2000, 100 + 5 * H * 0.55, 100, 6)
        tg = self.tablet_groups(a + b)
        seen = {}

        def fake(groups):
            for gid, ss in groups:
                seen[gid] = sorted(s["id"] for s in ss)
            return {"g2": {"text": ["action", "auction"], "lang": "en"}}
        old = (recognize.AVAILABLE, recognize.recognize_lang)
        recognize.AVAILABLE, recognize.recognize_lang = True, fake
        try:
            server.App.attach_reco(SimpleNamespace(), "scratch", 0, tg, page={"strokes": a + b})
        finally:
            recognize.AVAILABLE, recognize.recognize_lang = old
        self.assertEqual(seen, {"g1": sorted(s["id"] for s in a), "g2": sorted(s["id"] for s in b)})
        self.assertNotIn("reco", tg[0])
        self.assertEqual((tg[1]["reco"], tg[1]["reco_lang"]), (["action", "auction"], "en"))
        self.assertEqual(prompt.fmt_reco(tg[1]), "｜电脑识别（按英文认）：「action」（或：auction）")


class LanguageTest(unittest.TestCase):
    def test_english_words(self):
        self.assertTrue(recognize.looks_english(9, [["coffee", "Coffee"]]))
        self.assertTrue(recognize.looks_english(12, [["is", "Is"], ["sunny", "sunny."]]))
        self.assertTrue(recognize.looks_english(5, [["TV:", "Tv:"], ["now"]]))

    def test_what_english_recognizer_makes_of_chinese(self):
        """英文识别器认中文：数字、符号、不成词的字母，或者每个「字母」要好几笔。"""
        self.assertFalse(recognize.looks_english(9, [["3*5", "35"]]))
        self.assertFalse(recognize.looks_english(7, [["Wn:RB"]]))          # 没有 3 个字母以上的词
        self.assertFalse(recognize.looks_english(9, [["(TED", "(TD"]]))     # 9 笔认出 4 个字：每个字两笔多
        self.assertFalse(recognize.looks_english(2, [["ED"]]))
        self.assertFalse(recognize.looks_english(13, [["a"]]))
        self.assertFalse(recognize.looks_english(3, []))

    def test_choose_and_fallbacks(self):
        zh, en = [["今天", "今夭"]], [["coffee", "Coffee", "coffee."]]
        self.assertEqual(recognize.choose(9, zh, en), ("en", ["coffee", "Coffee", "coffee."]))
        self.assertEqual(recognize.choose(9, zh, [["3*5"]]), ("zh", ["今天", "今夭"]))
        self.assertEqual(recognize.choose(9, zh, None), ("zh-only", ["今天", "今夭"]))   # 没装英文识别器：照旧按中文认
        self.assertEqual(recognize.choose(9, None, en)[0], "en-only")
        self.assertEqual(recognize.readings([["a", "b"], [], ["c"]]), ["ac", "bc"])
        self.assertEqual(recognize.readings([]), [])

    def test_recognizer_names(self):
        recs = [SimpleNamespace(name=n) for n in ("Microsoft English (Canada) Handwriting Recognizer",
                                                  "Microsoft English (US) Handwriting Recognizer", "Microsoft 中文(简体)手写识别器")]
        self.assertEqual(recognize._find(recs, "en").name, "Microsoft English (US) Handwriting Recognizer")
        self.assertIn("简体", recognize._find(recs, "zh").name)
        self.assertEqual(recognize._find(recs[:1], "en").name, recs[0].name)   # 没有美国英语：用别的英语
        self.assertIsNone(recognize._find(recs[:2], "zh"))

    def test_retry_and_one_bad_group_does_not_spoil_the_rest(self):
        """识别器偶尔说「来得不是时候」：等一下再试；一组怎么都认不了，只是这一组没有读法（以前整批都没有）。"""
        class Seg:
            def __init__(self, t):
                self.t = t

            def get_text_candidates(self):
                return [self.t]

        class FakeRC:
            def __init__(self, text, fail_first=0, always_fail_on=None):
                self.text, self.left, self.bad, self.calls = text, fail_first, always_fail_on, 0

            async def recognize_async(self, cont, target):
                self.calls += 1
                if self.left or (self.bad is not None and cont.get_strokes().size == self.bad):
                    self.left = max(0, self.left - 1)
                    raise OSError("A method was called at an unexpected time")
                return [Seg(self.text)]
        import asyncio
        rc = FakeRC("coffee", fail_first=2)
        self.assertEqual([s.get_text_candidates() for s in asyncio.run(recognize._recognize(rc, None))], [["coffee"]])
        self.assertEqual(rc.calls, 3)
        if not recognize.AVAILABLE:
            self.skipTest("这台机器没有 winrt：分组隔离那一半不测")
        old = recognize._recognizers
        recognize._recognizers = {"zh": FakeRC("今天", always_fail_on=3), "en": FakeRC("3*5")}
        try:
            got = recognize.recognize_lang([("g1", hanzi("a", T, 100, 100)), ("g2", word("b", T, 100, 200, 3)), ("g3", hanzi("c", T, 300, 100))])
        finally:
            recognize._recognizers = old
        self.assertEqual(sorted(got), ["g1", "g3"])          # 3 笔的那组认不了，另外两组照常
        self.assertEqual(got["g1"], {"text": ["今天"], "lang": "zh"})

    def test_message_says_how_it_was_read(self):
        self.assertEqual(prompt.fmt_reco({"reco": ["今天"], "reco_lang": "zh-only"}), "｜电脑识别（只按中文认）：「今天」")
        self.assertEqual(prompt.fmt_reco({"reco": ["coffee"], "reco_lang": "en", "ocr": "coffee"}),
                         "｜电脑识别：Windows（按英文认）「coffee」；PP-OCR「coffee」")
        self.assertEqual(prompt.fmt_reco({"reco": ["今天"]}), "｜电脑识别：「今天」")     # 旧的投递没有语种：照旧
        # 「只按中文认」是什么意思：2026-11-16 规则瘦身起只在书写过程里真出现时带一句（prompt.timeline_hints），固定说明里没有
        g = {"id": "g1", "t0": 0, "t1": 1000, "n": 2, "bbox": [0, 0, 10, 10], "reco": ["今天"], "reco_lang": "zh-only"}
        self.assertIn(prompt.RECO_ONLY["zh-only"], prompt.build_timeline([g], 2000, True))
        self.assertNotIn("只按中文认", prompt.protocol())


if __name__ == "__main__":
    if sys.argv[1:] == ["--write-fixture"]:
        write_fixture()
        print(f"写好了：{FIXTURE.name}（{len(fixture_cases())} 页）")
    else:
        unittest.main()

"""在服务器上处理草稿纸页面：笔迹分组（_cluster；和平板 app.js 的 computeGroups 是同一套规则，tests/browser/grouping.mjs 拿
tests/fixtures/grouping.json 比两边），把任意一页连同笔迹画成图。

用于「整本检测」和「确认字迹」：平板没开着时，也能看到任何一页写了什么、某组笔迹在哪。
"""
import math
import os
import re
import threading
from pathlib import Path

try:
    import pymupdf as fitz
except ImportError:
    try:
        import fitz  # 1.24.3 以前的 PyMuPDF 只有这个旧名字
    except ImportError:
        fitz = None

# PyMuPDF 不能在几个线程里同时用（会让整个进程崩掉）：服务里所有用到它的地方都先拿这把锁
FITZ_LOCK = threading.RLock()

# Claude 批注用的字：平板上是小赖手写体（woff2，PyMuPDF 读不了），这里用本机楷体代替；都没有时用内置宋体
_FONTS = [Path(r"C:\Windows\Fonts\simkai.ttf"), Path(r"C:\Windows\Fonts\STKAITI.TTF"), Path(r"C:\Windows\Fonts\msyh.ttc")]
NOTE_FONT = next((str(p) for p in _FONTS if p.is_file()), None)
NOTE_KW = {"fontname": "note", "fontfile": NOTE_FONT} if NOTE_FONT else {"fontname": "china-s"}  # insert_text 写蓝字用
FIG_DIR = None  # Claude 放上来的图（figure）存在哪：服务启动时设成 data/figures
FIG_NAME = re.compile(r"^[0-9a-f]{16}\.png$")  # 图的文件名只认服务自己起的这种；页面数据里写别的路径不去读

PAGE_W, MARGIN_W = 1000, 380
TW = PAGE_W + MARGIN_W
GROUP_GAP_MS, GROUP_DIST = 1800, 60
# 分组的后两步（2026-11-14，见 _cluster）。量过的依据记在 _join_line、_late_target 的说明里。
# 平板 static/app.js 里有同名的一组常数和同样的判据：改一边要两边一起改（tests/browser/grouping.mjs 会报两边不一致）
LINE_PAUSE_MS = 15000  # 同一行接着写：前后两组之间停顿不到这么久
LINE_GAP = 0.6         # 同一行接着写：横向间距不到这么多个字高
LINE_RATIO = 2.2       # 两组的字高相差不到这么多倍（大字旁边的小字不并）
TALL, LONG = 1.5, 2.5  # 一组里有高过 TALL 个字高的一笔（括号、竖线）或长过 LONG 个字高的直线（横线、箭头杆）：不当一行字
LATE_SMALL = 0.6       # 回头补的小笔画：一两笔、不超过这么多个字高
LATE_NEAR = 0.25       # 回头补的小笔画：离那组里某一笔不到这么多个字高
INK = (0.106, 0.106, 0.106)
RED = (0.824, 0.235, 0.18)
AI = (0.184, 0.373, 0.682)
LABEL = (0.54, 0.54, 0.54)
HIGHLIGHT = (1, 0.898, 0.416)
ADOPTED = (0.12, 0.24, 0.48)    # 采纳的蓝字


def stroke_box(s):
    xs = [p[0] for p in s["pts"]]
    ys = [p[1] for p in s["pts"]]
    w = s.get("w", 2.1)
    return [min(xs) - w, min(ys) - w, max(xs) + w, max(ys) + w]


def stroke_t1(s):
    return s["t0"] + (s["pts"][-1][3] if s["pts"] else 0)


def box_dist(a, b):
    dx = max(0, a[0] - b[2], b[0] - a[2])
    dy = max(0, a[1] - b[3], b[1] - a[3])
    return math.hypot(dx, dy)


def union(a, b):
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def _by_time(strokes):
    """第一步（原来的规则）：按落笔先后，同色、和上一组相隔不到 GROUP_GAP_MS、相距不到 GROUP_DIST 的笔接进上一组。"""
    ss = sorted((s for s in strokes if s.get("pts")), key=lambda s: s["t0"])
    groups = []
    g = None
    for s in ss:
        bb, t1, c = stroke_box(s), stroke_t1(s), s.get("c", "")
        if g and c == g["c"] and s["t0"] - g["t1"] < GROUP_GAP_MS and box_dist(bb, g["bbox"]) < GROUP_DIST:
            g["bbox"] = union(g["bbox"], bb)
            g["t1"] = max(g["t1"], t1)
            g["strokes"].append(s)
        else:
            g = {"t0": s["t0"], "t1": t1, "bbox": bb, "strokes": [s], "c": c}
            groups.append(g)
    for g in groups:
        g["tw"] = g["t1"]  # 这组「写」完的时刻；回头补的笔画不算（书写过程按它说停顿和写了多久）
    return groups


def char_h(strokes):
    """一组笔迹的字高：较高那几笔（第 75 百分位）的高度 ×1.3，和 inksheet 的算法一样。不到 3 笔说不准，返回 None。"""
    if len(strokes) < 3:
        return None
    hs = sorted(stroke_box(s)[3] - stroke_box(s)[1] for s in strokes)
    return max(8.0, hs[int(len(hs) * 0.75)]) * 1.3


def _straight(s):
    """这一笔差不多是直的（走过的路不到外框对角线的 1.25 倍）。"""
    p = s["pts"]
    length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(p, p[1:]))
    b = stroke_box(s)
    return length <= 1.25 * math.hypot(b[2] - b[0], b[3] - b[1])


def _one_line_of_text(g, ch):
    """按字高 ch 看，这组像一行字：没有竖得很长的一笔（括号、竖线）、没有很长的直线（横线、箭头杆），整组不比一行高。"""
    for s in g["strokes"]:
        b = stroke_box(s)
        if b[3] - b[1] > TALL * ch or (b[2] - b[0] > LONG * ch and _straight(s)):
            return False
    return g["bbox"][3] - g["bbox"][1] <= 1.6 * ch


def _join_line(a, b):
    """第二步的判据：b 是不是 a 在同一行上接着写的（b 紧接在 a 后面写）。都要满足：
    同色、停顿不到 LINE_PAUSE_MS；两组都像一行字、字高相差不到 LINE_RATIO 倍；竖直方向对齐（重叠过半、中线差不到半个字高）；
    b 在 a 的右边（起点过了 a 的一半）、横向间距不到 LINE_GAP 个字高。
    依据（2026-11-14，在 41 页真实笔迹的副本上量的）：时间上相邻、同一行的组，间距绝大多数不到半个字高，停顿多在 15 秒以内；
    这样并出 61 组，逐个看过图，没有把两行、两种颜色、括号和字并在一起的。"""
    if a["c"] != b["c"] or b["t0"] - a["t1"] >= LINE_PAUSE_MS:
        return False
    ha, hb = char_h(a["strokes"]), char_h(b["strokes"])
    if ha is None and hb is None:
        return False
    if ha and hb and max(ha, hb) > LINE_RATIO * min(ha, hb):
        return False
    ch = max(h for h in (ha, hb) if h)
    if not (_one_line_of_text(a, ch) and _one_line_of_text(b, ch)):
        return False
    A, B = a["bbox"], b["bbox"]
    if min(A[3], B[3]) - max(A[1], B[1]) < 0.5 * min(A[3] - A[1], B[3] - B[1]):
        return False
    if abs((A[1] + A[3]) / 2 - (B[1] + B[3]) / 2) > 0.5 * ch:
        return False
    return B[0] - A[2] <= LINE_GAP * ch and B[0] >= A[0] + 0.5 * (A[2] - A[0])


def _late_target(g, earlier):
    """第三步的判据：g 是不是回头补在之前某一组上的小笔画（i 的点、t 的横、漏写的一点一横）。返回那一组，不是就 None。
    要求：g 只有一两笔、不超过 LATE_SMALL 个字高；那一组同色、像一行字；g 的中心落在那组的框里（上方可以高出半个字高，
    给 i 的点）；离那组里最近的一笔不到 LATE_NEAR 个字高。几组都合适时取最近的。不看隔了多久。"""
    if len(g["strokes"]) > 2:
        return None
    b = g["bbox"]
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    best = None
    for t in earlier:
        ch = char_h(t["strokes"])
        if t["c"] != g["c"] or ch is None or max(b[2] - b[0], b[3] - b[1]) > LATE_SMALL * ch or not _one_line_of_text(t, ch):
            continue
        T = t["bbox"]
        if not (T[0] <= cx <= T[2] and T[1] - 0.5 * ch <= cy <= T[3]):
            continue
        d = min(box_dist(b, stroke_box(s)) for s in t["strokes"])
        if d <= LATE_NEAR * ch and (best is None or d < best[0]):
            best = (d, t)
    return best[1] if best else None


def _absorb(g, h, late=False):
    g["bbox"] = union(g["bbox"], h["bbox"])
    g["t1"] = max(g["t1"], h["t1"])
    g["strokes"].extend(h["strokes"])
    if late:
        g["late"] = g.get("late", 0) + len(h["strokes"])
        g["lateAt"] = max(g.get("lateAt") or 0, h["t0"])
    else:
        g["tw"] = max(g["tw"], h["tw"])


def _cluster(strokes):
    """笔迹分组，三步：
    1. 按时间：同色、相隔不到 GROUP_GAP_MS、相距不到 GROUP_DIST 的笔归一组（原来的规则）；
    2. 同一行接着写：写到一半停了一会儿的词、一句话，并成一组（_join_line）；
    3. 回头补的小笔画并回它压着的那一组（_late_target），这组记下 late（补了几笔）、lateAt（最后一次补的时刻）。
    组按第一笔的时刻排，编号 g1、g2…… 照这个顺序。擦掉的笔迹也参加分组（编号不因擦除而变）。
    平板 app.js 的 computeGroups 一步步照这里做（groupsByTime、joinsLine、lateTarget），同一页两边分出的组号和每组的笔迹一样。"""
    out = []
    for g in _by_time(strokes):
        if out and _join_line(out[-1], g):
            _absorb(out[-1], g)
        else:
            out.append(g)
    groups = []
    for g in out:
        t = _late_target(g, groups)
        if t is not None:
            _absorb(t, g, late=True)
        else:
            groups.append(g)
    return groups


def group_strokes(strokes):
    """[(组编号, 这组没擦掉的笔迹)]，编号与 compute_groups 一致。"""
    out = []
    for i, g in enumerate(_cluster(strokes)):
        vis = [s for s in g["strokes"] if not s.get("erasedAt")]
        if vis:
            out.append((f"g{i + 1}", vis))
    return out


def sent_groups(groups, page):
    """交上来的分组（平板发来的，或服务端算的）→ {组编号: 这组没擦掉的笔迹}，只要和服务器上存的这一页对得上的组。
    带笔迹 id（ids）的按 id 取：这些笔都在、合起来的外框和交上来的差不到 3 才算——两边规则现在一样，但平板上可能还开着没刷新的旧页面
    （分组只有第一步），按 id 取就不会对错组；
    不带 id 的（服务端自己算的）按服务端分组的编号和外框对。对不上多半是平板上的这一页还没存到服务器。"""
    by_id = {s.get("id"): s for s in ink(page) if s.get("pts")}
    mine = boxes = None
    out = {}
    for g in groups:
        gid, want = g.get("id"), g.get("bbox") or []
        if g.get("ids"):
            ss = [by_id.get(i) for i in g["ids"]]
            if not ss or any(s is None for s in ss):
                continue
            bb = stroke_box(ss[0])
            for s in ss[1:]:
                bb = union(bb, stroke_box(s))
            if any(abs(round(a) - b) > 3 for a, b in zip(bb, want)):
                continue
            vis = [s for s in ss if not s.get("erasedAt")]
        else:
            if mine is None:
                mine = dict(group_strokes(ink(page)))
                boxes = {x["id"]: x["bbox"] for x in compute_groups(ink(page))}
            if gid not in mine or any(abs(a - b) > 3 for a, b in zip(boxes.get(gid, []), want)):
                continue
            vis = mine[gid]
        if vis:
            out[gid] = vis
    return out


def compute_groups(strokes):
    """笔迹分组（_cluster）；返回的字段与前端发来的 groups 一致。有回头补的笔画的组另带 late（补了几笔）、lateAt（最后一次补的
    时刻）、tw（不算补的、写完的时刻）；t1 是连补的笔画在内最后一笔的时刻（「这组有没有新东西」按它算）。"""
    groups = _cluster(strokes)
    out = []
    for i, gr in enumerate(groups):
        erased = [s for s in gr["strokes"] if s.get("erasedAt")]
        g = {
            "id": f"g{i + 1}", "t0": gr["t0"], "t1": gr["t1"], "bbox": [round(v) for v in gr["bbox"]],
            "n": len(gr["strokes"]), "erased": len(erased),
            "erasedAt": max((s["erasedAt"] for s in erased), default=None),
            "revisit": any(o["tw"] < gr["t0"] - 30000 and box_dist(o["bbox"], gr["bbox"]) < 24 for o in groups[:i]),
            "red": gr["c"] == "r",
        }
        if gr.get("late"):
            g.update(late=gr["late"], lateAt=gr["lateAt"], tw=gr["tw"])
        out.append(g)
    return out


def last_touch(page):
    """这一页最后一次落笔或擦除的时刻（平板的时钟）。"""
    t = 0
    for s in page.get("strokes") or []:
        if s.get("pts"):
            t = max(t, stroke_t1(s), s.get("erasedAt") or 0)
    return t


def origin(page):
    """纸向左、向上扩出去多少（ox, oy ≥ 0）：纸从 (-ox, -oy) 开始，原来的内容坐标不变。"""
    return max(0.0, float(page.get("ox") or 0)), max(0.0, float(page.get("oy") or 0))


def widths(page):
    """（正文区宽度, 连页边的总宽度）：页面拉宽过的话正文区更宽，页边接在它右边。"""
    w = PAGE_W + max(0, float(page.get("xw") or 0))
    return w, w + MARGIN_W


def paper_rect(page, base_h, blank=False):
    """整张纸的范围 [x0, y0, x1, y1]（页面坐标，x0、y0 可能是负数）。blank：空白本子（见 blank_rect）。"""
    if blank:
        return blank_rect(page, base_h)
    ox, oy = origin(page)
    return [-ox, -oy, widths(page)[1], max(base_h, page.get("h") or 0)]


# -- 空白本子（草稿本、自己新建的本子）的图（阶段 E，2026-11-15）：平板上阶段 D1 起整屏是纸，没有右边那一栏的底色和分隔线，
#    原来那一栏的地方也是纸（数据不变：纸照旧宽 PAGE_W + MARGIN_W，以前排在那一栏里的旧批注留在原处，x 大于 1000）。
#    服务端画的图跟着这样：图里就是纸；范围把这一页上所有的东西都包进去——笔迹、Claude 的批注、圈号、小蓝点、图和公式，
#    万一有东西在纸外面也把纸扩到包住它。书页、「Claude 推送」的页不变（有批注时右边照旧一栏），见 _draw_page。

def _path_box(d):
    """批注路径（只有绝对坐标的 M / L / Q / C，数字两两成对）的外框；读不出来返回 None。"""
    nums = re.findall(r"-?\d*\.?\d+(?:[eE][-+]?\d+)?", str(d or ""))
    xs, ys = [float(v) for v in nums[0::2]], [float(v) for v in nums[1::2]]
    n = min(len(xs), len(ys))
    return [min(xs[:n]), min(ys[:n]), max(xs[:n]), max(ys[:n])] if n else None


def _box4(b):
    return [float(v) for v in b] if isinstance(b, (list, tuple)) and len(b) == 4 and all(
        isinstance(v, (int, float)) and not isinstance(v, bool) for v in b) else None


def ai_box(it, struck="skip"):
    """一条 Claude 的东西在纸上画出来占的框（页面坐标），和 _draw_page 画的一样：长回答只有圈号；收成小蓝点的短批注
    在给 Claude 的图、缩略图里只有那个点（struck="faded" 的往来稿照旧写字）；别的是字（lay）、整块（hit）、图（fig）、
    示意图里的字（labels）和线（paths）的并。什么都没有返回 None。"""
    at = badge_at(it)
    op = open_of(it)
    if op:  # 摊在纸上的长回答（2026-11-17）：那一段字连同连过去的细线；圈号不画
        out = [op["x"], op["y"], op["x"] + op["w"], op["y"] + op["h"]]
        lb = _path_box(op.get("lead")) if op.get("lead") else None
        return union(out, lb) if lb else out
    if it.get("type") == "write":
        return [at[0] - BADGE_R, at[1] - BADGE_R, at[0] + BADGE_R, at[1] + BADGE_R] if at else None
    dot = dot_at(it)
    if dot and struck != "faded":
        return [dot[0] - DOT_R, dot[1] - DOT_R, dot[0] + DOT_R, dot[1] + DOT_R]
    boxes = []
    lay = it.get("lay")
    if isinstance(lay, dict) and all(isinstance(lay.get(k), (int, float)) for k in ("x", "y")):
        h = lay.get("h") or (len(lay.get("lines") or []) * (lay.get("lh") or 0) + (lay.get("fs") or 0) * 0.3)
        boxes.append([lay["x"], lay["y"], lay["x"] + (lay.get("w") or 0), lay["y"] + (h or 0)])
    hit = _box4(it.get("hit"))
    if hit:
        boxes.append(hit)
    fig = it.get("fig")
    if isinstance(fig, dict) and all(isinstance(fig.get(k), (int, float)) for k in ("x", "y", "w", "h")):
        boxes.append([fig["x"], fig["y"], fig["x"] + fig["w"], fig["y"] + fig["h"]])
    for lb in it.get("labels") or []:
        if isinstance(lb, dict) and all(isinstance(lb.get(k), (int, float)) for k in ("x", "y")):
            boxes.append([lb["x"], lb["y"], lb["x"] + (lb.get("w") or 0), lb["y"] + (lb.get("fs") or 0)])
    for p in it.get("paths") or []:
        b = _path_box(p.get("d")) if isinstance(p, dict) else None
        if b:
            boxes.append(b)
    if not boxes:
        return None
    out = boxes[0]
    for b in boxes[1:]:
        out = union(out, b)
    return out


def ai_shown(page, struck="skip"):
    """这一页图里画出来的 Claude 的东西：没擦掉、没落空；横划掉的只在往来稿（struck="faded"）里画（画淡）。和 _draw_page 挑的一样。"""
    live = live_ids(page)
    return [it for it in page.get("ai") or [] if isinstance(it, dict) and not it.get("erasedAt") and not ai_gone(it, live)
            and (struck == "faded" or not it.get("dismissed"))]


def blank_rect(page, base_h=0, struck="skip"):
    """空白本子这一页的图画多大 [x0, y0, x1, y1]（页面坐标）：整张纸（PAGE_W + MARGIN_W 宽，原来那一栏也是纸），
    有东西出了纸（不该有：平板写到纸外会把纸扩出去）就再扩到包住它，四周留 30。base_h：纸的底图高度（只管下边）。"""
    ox, oy = origin(page)
    r = [-ox, -oy, widths(page)[1], max(base_h, page.get("h") or 0)]
    boxes = [stroke_box(s) for s in ink(page) if s.get("pts") and not s.get("erasedAt")]
    boxes += [b for b in (ai_box(it, struck) for it in ai_shown(page, struck)) if b]
    for b in boxes:
        r = [min(r[0], b[0] - 30), min(r[1], b[1] - 30), max(r[2], b[2] + 30), max(r[3], b[3] + 30)]
    return r


def content_origin(page, blank=False):
    """有内容的范围的左上角：向左、向上扩出来的纸上写了东西才往负方向扩，否则是 (0, 0)。
    blank（空白本子）：Claude 的东西（批注、圈号、图……）也算，免得放在笔迹左边、上边的批注被裁掉。"""
    if blank:
        r = blank_rect(page)  # 只用左上角，和纸的高度无关
        left = top = 0.0
        boxes = [stroke_box(s) for s in ink(page) if s.get("pts") and not s.get("erasedAt")]
        boxes += [b for b in (ai_box(it) for it in ai_shown(page)) if b]
        for b in boxes:
            left, top = min(left, b[0] - 30), min(top, b[1] - 30)
        return max(r[0], left), max(r[1], top)
    ox, oy = origin(page)
    left = top = 0.0
    for s in ink(page):
        if s.get("pts") and not s.get("erasedAt"):
            b = stroke_box(s)
            left, top = min(left, b[0] - 30), min(top, b[1] - 30)
    return max(-ox, left), max(-oy, top)


def turned_h(page, base_h):
    """这一页底图转了 90°/270° 时在页面上的高度：宽度总是 PAGE_W，长宽对调后按宽度缩放。"""
    return PAGE_W * PAGE_W / base_h if (page.get("rot") or 0) % 180 else base_h


def turn_between(frm, to, h0):
    """转角 frm 的页面坐标 → 转角 to 的（顺时针一步步转过去；h0 为没转时的底图高度）。
    返回 (a, b, c, d, e, f)：x' = a·x + c·y + e，y' = b·x + d·y + f（和平板 static/turn.js 一样）。"""
    m, r = (1, 0, 0, 1, 0, 0), frm % 360
    while r != to % 360:
        hc = turned_h({"rot": r}, h0)
        k = PAGE_W / hc
        s = (0, k, -k, 0, k * hc, 0)
        m = (s[0] * m[0] + s[2] * m[1], s[1] * m[0] + s[3] * m[1], s[0] * m[2] + s[2] * m[3], s[1] * m[2] + s[3] * m[3],
             s[0] * m[4] + s[2] * m[5] + s[4], s[1] * m[4] + s[3] * m[5] + s[5])
        r = (r + 90) % 360
    return m


def turn_box(m, b):
    """框 [x0, y0, x1, y1] 按 turn_between 的结果换算（转 90° 的倍数，矩形还是矩形）。"""
    x0, y0 = m[0] * b[0] + m[2] * b[1] + m[4], m[1] * b[0] + m[3] * b[1] + m[5]
    x1, y1 = m[0] * b[2] + m[2] * b[3] + m[4], m[1] * b[2] + m[3] * b[3] + m[5]
    return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]


def ink(page):
    """这一页的笔迹（擦掉的也在里面，分组要算）。和平板的 inkStrokes 一致，组号才对得上。"""
    return list(page.get("strokes") or [])


def live_ids(page):
    """这一页看得见、没擦掉的笔迹 id。"""
    return {s.get("id") for s in ink(page) if s.get("pts") and not s.get("erasedAt")}


def ai_gone(it, live):
    """Claude 的标注「落空」：它指着的笔迹（on，箭头另有起点 on2）都擦掉了或不在页面上，和平板一样不画。
    长回答（圈号）不算：所答的红笔问题擦掉了，圈号照样留在原处。"""
    if it.get("type") == "write":
        return False

    def dead(ids):
        return isinstance(ids, list) and bool(ids) and not any(i in live for i in ids)

    return dead(it.get("on")) or dead(it.get("on2"))


BADGE_R = 13    # 长回答的圈号：半径（页面单位），和平板 app.js 的 BADGE_R 一样
BADGE_FS = 17   # 圈里数字的字号


def badge_at(it):
    """长回答（write）的圈号圆心 (x, y)；不是长回答、或没有圈号位置的条目为 None。"""
    at = it.get("at") if it.get("type") == "write" else None
    if isinstance(at, list) and len(at) == 2 and all(isinstance(v, (int, float)) for v in at):
        return float(at[0]), float(at[1])
    return None


OPEN_FS, OPEN_LH = 21, 29  # 摊在纸上的长回答：字号、行高（和平板 app.js 的 NOTE_FS、NOTE_LH 一样）


def open_of(it):
    """摊在纸上的长回答（2026-11-17，平板 app.js 的 isOpen）：write 上的 spread = {x, y, w, h, rows, lead?, …}，
    rows 是 [{y（相对 spread.y）, h, w, t（一行字）| tex（公式的 LaTeX）}]。不是的（收着的、别的类型）返回 None。"""
    p = it.get("spread") if isinstance(it, dict) and it.get("type") == "write" else None
    if not isinstance(p, dict) or not all(isinstance(p.get(k), (int, float)) and not isinstance(p.get(k), bool) for k in ("x", "y", "w", "h")):
        return None
    rows = [r for r in p.get("rows") or [] if isinstance(r, dict) and isinstance(r.get("y"), (int, float))
            and (isinstance(r.get("t"), str) or isinstance(r.get("tex"), str))]
    return dict(p, rows=rows) if rows else None


def answers_of(page):
    """这一页没擦掉的长回答，按圈号排：[{n, q, text}]（存回 PDF、往来稿、整本消息都用）。"""
    out = [a for a in page.get("ai") or [] if badge_at(a) and not a.get("erasedAt") and not a.get("dismissed")
           and str(a.get("text") or "").strip()]
    return sorted(out, key=lambda a: a.get("n") or 0)


# -- 长回答卡片上的红字（2026-11-14）：用户在浮出的卡片上用红笔批注、追问；Claude 的回应接在同一张卡片下面（more）。
#    数据都在那条长回答里，见 static/app.js 的「长回答的卡片」一节：marks 的坐标相对它所在那一块（主回答 a、某一段回应的 id、
#    之前的版本 o0、o1……）的左上角，单位是卡片的固定排版宽度下的单位；sheet 是平板量下的排版快照（服务端排不出一样的换行）

CARD_W = 440                      # 卡片的固定排版宽度（和平板 app.js 的 CARD_W 一样）
MQ_COLOR = (0.85, 0.56, 0.52)     # 「红字：……」那一行：淡一些的红（比红字淡，图里分得开）


def more_of(it):
    """长回答下面接着回的各段（有字的）：[{id, t, req, q, text, on, redo?}]。"""
    return [m for m in it.get("more") or [] if isinstance(m, dict) and str(m.get("text") or "").strip()]


def redo_head(m):
    """接着的一段是点「再短点」「展开讲」请 AI 重写的（redo，2026-11-17）：那一段前面写的一行（和平板卡片上的一样）；不是返回空串。"""
    return {"brief": "按「再短点」重写：", "full": "按「展开讲」重写："}.get(m.get("redo") if isinstance(m, dict) else None, "")


def marks_of(it):
    """卡片上的红字（有点的）。"""
    return [m for m in it.get("marks") or [] if isinstance(m, dict) and isinstance(m.get("pts"), list) and m["pts"]]


def dot_at(it):
    """空白本子里收成小蓝点的短批注（阶段 D1，平板 app.js 的 isDot）：小蓝点的圆心 (x, y)；展开着的、不是短批注的为 None。
    收起的状态记在那条批注的 dot 里（{at, t, why, by?}），lay 照旧是那几行字在纸上的排版。"""
    d = it.get("dot") if it.get("type") in ("note", "question") else None
    at = d.get("at") if isinstance(d, dict) else None
    if isinstance(at, list) and len(at) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in at):
        return float(at[0]), float(at[1])
    return None


DOT_R = 7  # 小蓝点的半径（页面单位），和平板 app.js 的 DOT_R 一样


def dot_items(page):
    """这一页收成小蓝点的短批注（纸上看得见的：没擦掉、没横划掉、指着的字还在、有字），按先后。"""
    live = live_ids(page)
    return [a for a in page.get("ai") or [] if isinstance(a, dict) and dot_at(a)
            and not a.get("erasedAt") and not a.get("dismissed") and not ai_gone(a, live) and str(a.get("text") or "").strip()]


def dot_notes(page):
    """这一页收成小蓝点的短批注的原话，按先后。整本消息里说明图里那几个点是什么。"""
    return [str(a.get("text")).strip() for a in dot_items(page)]


# 红笔写在纸上的短批注上（2026-11-18 用户改的：《产品定义》第 2 节「红笔批过的短批注留在纸上」）：那条蓝字和红字都留在纸上，
# 交上去时书写过程里那组红笔写明写在哪条批注上（prompt.red_label），AI 照别的红笔问题回在红字旁边。
# 「写在上面」的判法和平板以前收成卡片时一样（app.js 原来的 noteFollowups）：那组红笔里这条批注到了之后写的笔，有一点压到批注的字
# 四周放宽 NOTE_PAD 的那一块，就算冲着它；压到两条的归压得多的那条。字宽按写蓝字的字体量（和平板的 noteTextBox 差一点，放宽的一圈够了）
NOTE_PAD = 10  # 和平板 app.js 的 NOTE_PAD 一样


def note_text_box(it):
    """短批注在纸上的字占的那一块（页面坐标）：每行按字体量宽，高从第一行字顶到最后一行字底（平板 app.js 的 noteTextBox）。"""
    lay = it.get("lay") or {}
    lines = [str(ln) for ln in lay.get("lines") or []]
    fs, lh = float(lay.get("fs") or 21), float(lay.get("lh") or 28)
    tw = max([fs] + [_font().text_length(ln, fontsize=fs) for ln in lines])
    x, y = float(lay["x"]), float(lay["y"])
    return [x, y + 2, x + tw, y + (max(1, len(lines)) - 1) * lh + fs * 1.2]


def paper_notes(page):
    """纸上看得见的、展开着的短批注（note、question）：有字、有排版、没擦掉、没横划掉、指着的字还在、没收成小蓝点。"""
    live = live_ids(page)
    out = []
    for a in page.get("ai") or []:
        lay = a.get("lay") if isinstance(a, dict) else None
        if (isinstance(lay, dict) and a.get("type") in ("note", "question") and str(a.get("text") or "").strip() and lay.get("lines")
                and all(isinstance(lay.get(k), (int, float)) for k in ("x", "y")) and not a.get("erasedAt") and not a.get("dismissed")
                and not ai_gone(a, live) and not dot_at(a)):
            out.append(a)
    return out


def _pts_in(s, b):
    """一笔压到框 b 里的长度（沿笔画每 3 个单位数一点；平板 app.js 的 inkInBox）。"""
    p = s.get("pts") or []
    if not p:
        return 0
    inside = lambda x, y: b[0] <= x <= b[2] and b[1] <= y <= b[3]  # noqa: E731
    if len(p) == 1:
        return 1 if inside(p[0][0], p[0][1]) else 0
    n = 0
    for i in range(1, len(p)):
        x0, y0, x1, y1 = p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]
        k = max(1, math.ceil(math.hypot(x1 - x0, y1 - y0) / 3))
        for j in range(0 if i == 1 else 1, k + 1):
            if inside(x0 + (x1 - x0) * j / k, y0 + (y1 - y0) * j / k):
                n += 1
    return n


NOTE_FIT_W = 510   # 那组红字连同批注的字一共宽过这么多（平板以前收成卡片时要缩到 0.8 以下：440 宽的卡片排 408，408 / 0.8）……
NOTE_FIT_GROW = 240  # ……或比批注的字高出这么多：是从别处写过来、顺带压到批注的，不算冲着它（平板以前的 noteFits，2026-11-14 第二轮）


def _ink_box(strokes):
    """几笔的外框（点的外框四周加半个笔宽，和平板的 strokeBox 一样）。"""
    xs = [p[0] for s in strokes for p in s.get("pts") or []]
    ys = [p[1] for s in strokes for p in s.get("pts") or []]
    h = max([float(s.get("w") or 2) / 2 for s in strokes] or [1])
    return [min(xs) - h, min(ys) - h, max(xs) + h, max(ys) + h]


def red_on_notes(page, groups):
    """红笔那几组各写在哪条短批注上：{组号: 那条批注}。groups：[(组号, 那组的笔迹)]，只给要看的（红笔、还要回答的）。
    一组压到两条的归压得多的那条；连同那条批注的字一共太宽、太高的（NOTE_FIT_W、NOTE_FIT_GROW）整组不算冲着它。"""
    notes = paper_notes(page)
    if not notes:
        return {}
    tbs = [note_text_box(a) for a in notes]
    boxes = [[b[0] - NOTE_PAD, b[1] - NOTE_PAD, b[2] + NOTE_PAD, b[3] + NOTE_PAD] for b in tbs]
    out = {}
    for gid, strokes in groups:
        best = None
        for a, tb, b in zip(notes, tbs, boxes):
            ss = [s for s in strokes if not s.get("erasedAt") and s.get("pts") and (s.get("t0") or 0) > (a.get("t") or 0)]
            hit = sum(_pts_in(s, b) for s in ss)
            if hit and (best is None or hit > best[0]):
                best = (hit, a, tb, ss)
        if not best:
            continue
        _, a, tb, ss = best
        g = _ink_box(ss)
        e = [min(tb[0], g[0]), min(tb[1], g[1]), max(tb[2], g[2]), max(tb[3], g[3])]
        if e[2] - e[0] + 8 <= NOTE_FIT_W and e[3] - e[1] <= tb[3] - tb[1] + NOTE_FIT_GROW:
            out[gid] = a
    return out


def unsent_on_page(page):
    """这一页上有还没交的红字、图里却看不到的：(长回答卡片的张数, 小蓝点的个数)。
    服务端画的图（整本检测）、平板交的快照图里，长回答只画圈号、收起的短批注只画小蓝点，写在卡片上、浮出来的小卡片上的红字都不画
    （阶段 E 查清的；整本检测另把长回答的卡片连同红字各画一张图交上去，见 server.card_images）。小蓝点要「指着的字还在」才算，
    和平板点「AI」时把它收成卡片的条件一样（app.js 的 followupsToCards）。"""
    cards = sum(1 for a in page.get("ai") or [] if isinstance(a, dict) and a.get("type") == "write" and unsent_marks(a))
    return cards, sum(1 for a in dot_items(page) if unsent_marks(a))


def unsent_marks(it):
    """还没交给 Claude 的红字（没有 req、没擦掉）：平板上圈号带红点的就是这些；有它们的页算「有新东西」。
    收成小蓝点的短批注浮出来时上面写的红字也算（平板点「AI」时把它变成卡片再交，见 app.js 的 dotToCard）。"""
    if it.get("erasedAt") or it.get("dismissed") or not (badge_at(it) if it.get("type") == "write" else dot_at(it)):
        return []
    return [m for m in marks_of(it) if not m.get("erasedAt") and not m.get("req")]


def card_marks(it):
    """这次要连同卡片交给 Claude 的红字：没擦掉的、还没被回应的（不在任何一段回应的 on 里）——还没交的，和交了还没被回应的
    （和纸上没被回答的红笔问题再交一次一个道理）。卡片擦掉了的不交。"""
    if it.get("type") != "write" or it.get("erasedAt") or it.get("dismissed") or not badge_at(it):
        return []
    answered = {x for m in more_of(it) for x in m.get("on") or []}
    return [m for m in marks_of(it) if not m.get("erasedAt") and m.get("id") not in answered]


def cards_to_send(page):
    """这一页上要连同红字一起交的卡片，按圈号排：[(长回答, [红字])]。"""
    out = [(a, card_marks(a)) for a in page.get("ai") or [] if isinstance(a, dict)]
    return sorted([(a, ms) for a, ms in out if ms], key=lambda x: x[0].get("n") or 0)


def from_note(it):
    """这张卡片是不是纸上的短批注收成的（2026-11-14）：用户在一条短批注上写了红字，平板点「AI」交稿时把它收成了圈号，
    原来那条批注原样留在 from 里（平板 app.js 的 noteToCard）。卡片的图照旧按 sheet 画，消息里说明它原来是短批注。"""
    if not isinstance(it, dict):
        return False
    f = it.get("from")
    return it.get("type") == "write" and isinstance(f, dict) and f.get("type") in ("note", "question")


def _rough_sheet(it):
    """没有平板量下的排版快照时（不该出现：平板每改一次红字都记一份）：用服务端的字体粗排一份。换行和平板不完全一样，红字可能对不准。"""
    blocks, y = [], 12.0

    def block(bid, parts):
        nonlocal y
        rows, yy = [], 0.0
        for text, fs, kind in parts:
            for ln in wrap_text(text, CARD_W - 32, fs) or [""]:
                if ln:
                    rows.append({"x": 16, "y": yy, "w": _font().text_length(ln, fontsize=fs), "h": fs * 1.3, "fs": fs, "t": ln, "k": kind})
                yy += fs * 1.55
        blocks.append({"id": bid, "y": y, "h": yy, "rows": rows})
        y += yy + 20

    block("a", ([("问：" + str(it["q"]), 18, "q")] if it.get("q") else []) + [(it.get("text") or "", 20, "")])
    for m in more_of(it):
        head = redo_head(m)  # 点「再短点」「展开讲」请重写的那一段：写明按哪个钮重写（和平板卡片上一样占一行），不是「红字：」
        block(str(m.get("id")), ([(head, 18, "q")] if head else [("红字：" + str(m["q"]), 18, "mq")] if m.get("q") else []) + [(m["text"], 20, "")])
    for k, o in enumerate(it.get("older") or []):
        if isinstance(o, dict) and str(o.get("text") or "").strip():
            block(f"o{k}", [(o["text"], 20, "old")])
    return {"w": CARD_W, "h": y, "blocks": blocks}


def _num(v, d=0.0):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else d


def _render_card(it, marks, out_png, scale=2.0):
    sheet = it.get("sheet")
    if not (isinstance(sheet, dict) and isinstance(sheet.get("blocks"), list) and sheet["blocks"]):
        sheet = _rough_sheet(it)
    w = _num(sheet.get("w"), CARD_W) or CARD_W
    blocks = {str(b.get("id")): b for b in sheet["blocks"] if isinstance(b, dict)}
    top = lambda m: _num((blocks.get(str(m.get("blk"))) or blocks.get("a") or {}).get("y"))  # noqa: E731 - 这一笔所在那一块的顶
    bottom = max([_num(sheet.get("h"))] + [_num(b.get("y")) + _num(b.get("h")) for b in blocks.values()]
                 + [top(m) + _num(p[1]) for m in marks for p in m["pts"] if isinstance(p, list) and len(p) >= 2]) + 12
    doc = fitz.open()
    try:
        pg = doc.new_page(width=w, height=max(60.0, bottom))
        pg.draw_rect(pg.rect, color=(0.72, 0.79, 0.9), fill=(1, 1, 1), width=1)  # 白底细框：卡片
        font = _font()
        for b in blocks.values():
            by = _num(b.get("y"))
            for r in b.get("rows") or []:
                if not isinstance(r, dict):
                    continue
                x, y, rh = _num(r.get("x")), by + _num(r.get("y")), _num(r.get("h"), 20)
                if "tex" in r:  # 公式：写它的 TeX 源码（这张图只是让 Claude 看出红字批在哪句话上）
                    t, fs, color = "公式：" + str(r.get("tex") or ""), 12.0, AI
                else:
                    t, fs = str(r.get("t") or ""), _num(r.get("fs"), 20) or 20
                    color = {"q": Q_COLOR, "mq": MQ_COLOR, "old": Q_COLOR}.get(r.get("k"), AI)
                if not t.strip():
                    continue
                # 平板用的手写体和这里的楷体字宽不一样：横向缩放到平板上那一行的宽度，红字压着的是同一个字
                tw = font.text_length(t, fontsize=fs) or 1.0
                sx = max(0.5, min(2.0, (_num(r.get("w")) or tw) / tw))
                base = fitz.Point(x, y + rh / 2 + fs * 0.35)
                pg.insert_text(base, t, fontsize=fs, color=color, morph=(base, fitz.Matrix(sx, 1)), **NOTE_KW)
        for m in marks:
            pts = [fitz.Point(_num(p[0]), top(m) + _num(p[1])) for p in m["pts"] if isinstance(p, list) and len(p) >= 2]
            if not pts:
                continue
            sw = _num(m.get("w"), 2.1) or 2.1
            shape = pg.new_shape()
            if len(pts) == 1:
                shape.draw_circle(pts[0], sw * 0.6)
                shape.finish(color=None, fill=RED)
            else:
                avg_p = sum(_num(p[2], 0.5) if len(p) > 2 else 0.5 for p in m["pts"]) / len(m["pts"])
                shape.draw_polyline(pts)
                shape.finish(color=RED, width=sw * (0.45 + 0.9 * avg_p), lineCap=1, lineJoin=1, closePath=False)
            shape.commit()
        pg.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).save(out_png)
    finally:
        doc.close()


def render_card(*args, **kwargs):
    """把一张长回答的卡片画成 PNG 给 Claude：按平板量下的排版（sheet）把每行蓝字画在原位，叠上这次交的红字（marks）。
    卡片宽 CARD_W，scale 倍（默认 2 倍，440 → 880 像素宽）。"""
    with FITZ_LOCK:
        return _render_card(*args, **kwargs)


def center_in(q, b):
    cx, cy = (q[0] + q[2]) / 2, (q[1] + q[3]) / 2
    return b[0] <= cx <= b[2] and b[1] <= cy <= b[3]


def group_on(page, bbox, base_h, has_bg):
    """一组笔迹写在什么上面（和平板 groupOn 一样）：doc 书页印刷内容上、paper 纸上。"""
    if has_bg and center_in(bbox, [0, 0, PAGE_W, base_h]):
        return "doc"
    return "paper"


def content_extent(page, base_h, blank=False):
    """有内容的范围（右边界、下边界）：页边没写东西就不要页边，加长出来的空白不要。
    blank（空白本子）：没有页边那一栏，右边到最右的东西为止（以前排在那一栏位置的旧批注也包进来），不再一写过 PAGE_W 就带上整栏；
    Claude 的东西按它画出来占的地方算（ai_box：批注、圈号、小蓝点、图、公式、示意图）。"""
    if blank:
        r = blank_rect(page, base_h)
        right, bottom = PAGE_W, base_h
        for s in ink(page):
            if s.get("pts") and not s.get("erasedAt"):
                b = stroke_box(s)
                right, bottom = max(right, b[2] + 30), max(bottom, b[3] + 60)
        for b in (ai_box(it) for it in ai_shown(page)):
            if b:
                right, bottom = max(right, b[2] + 10), max(bottom, b[3] + 40)
        return min(right, r[2]), min(bottom, r[3])
    w, tw = widths(page)
    right, bottom = PAGE_W, base_h
    for s in ink(page):
        if s.get("pts") and not s.get("erasedAt"):
            b = stroke_box(s)
            bottom = max(bottom, b[3] + 60)
            right = max(right, min(tw, b[2] + 30))
    live = live_ids(page)
    for it in page.get("ai") or []:
        lay, at, dot, op = it.get("lay"), badge_at(it), dot_at(it), open_of(it)
        if op and not it.get("erasedAt") and not it.get("dismissed"):  # 摊在纸上的长回答（只在空白本子里有，这里是以防万一）
            bottom = max(bottom, op["y"] + op["h"] + 40)
            right = max(right, min(tw, op["x"] + op["w"] + 10))
        elif at and not it.get("erasedAt"):  # 长回答的圈号
            bottom = max(bottom, at[1] + BADGE_R + 40)
            right = max(right, min(tw, at[0] + BADGE_R + 10))
        elif dot and not it.get("erasedAt") and not it.get("dismissed") and not ai_gone(it, live):  # 收成小蓝点的短批注：图里只有那个点
            bottom = max(bottom, dot[1] + DOT_R + 40)
            right = max(right, min(tw, dot[0] + DOT_R + 10))
        elif lay and not it.get("dismissed") and not ai_gone(it, live):
            bottom = max(bottom, lay["y"] + lay.get("h", 0) + 40)
            right = max(right, min(tw, lay["x"] + lay.get("w", 0) + 10))
        elif it.get("type") == "sketch" and it.get("hit") and not it.get("dismissed"):  # 示意图：没有 lay，看它占的地方
            bottom = max(bottom, it["hit"][3] + 40)
            right = max(right, min(tw, it["hit"][2] + 10))
    if right > w:
        right = tw  # 写到了页边：整个页边都带上
    return right, min(bottom, max(base_h, page.get("h") or 0))


def fit_scale(w, h, cap=1.0):
    """让图片不超过约 115 万像素、长边不超过 1568（模型看图时不会再被缩小）。"""
    return min(cap, math.sqrt(1.15e6 / (w * h)), 1568 / max(w, h))


def has_ink(page):
    return any(s.get("pts") and not s.get("erasedAt") for s in ink(page))


def draw_svg_path(shape, d, off=(0, 0)):
    """画前端生成的批注路径：只有绝对坐标的 M / L / Q / C；off 为整体平移。"""
    toks = d.replace(",", " ").split()
    cur, cmd, i = None, None, 0

    def num():
        nonlocal i
        v = float(toks[i])
        i += 1
        return v

    def pt():
        x = num()
        return fitz.Point(x + off[0], num() + off[1])

    while i < len(toks):
        if toks[i][0].isalpha():
            cmd, toks[i] = toks[i][0], toks[i][1:]
            if not toks[i]:
                i += 1
                continue
        try:
            if cmd == "M":
                cur = pt()
            elif cmd == "L" and cur:
                p = pt()
                shape.draw_line(cur, p)
                cur = p
            elif cmd == "Q" and cur:
                c, p = pt(), pt()
                shape.draw_bezier(cur, cur + (c - cur) * (2 / 3), p + (c - p) * (2 / 3), p)  # 二次换成三次
                cur = p
            elif cmd == "C" and cur:
                c1, c2, p = pt(), pt(), pt()
                shape.draw_bezier(cur, c1, c2, p)
                cur = p
            else:
                i += 1
        except (ValueError, IndexError):
            return


def draw_badge(pg, c, num, col, seen, op=1):
    """在 PDF 页面上画一个圈号：圆心 c（PDF 坐标），没看过的实心（蓝底白字），看过的空心（白底蓝圈蓝字）。"""
    o = {"fill_opacity": op, "stroke_opacity": op} if op < 1 else {}
    shape = pg.new_shape()
    shape.draw_circle(c, BADGE_R)
    shape.finish(color=col, fill=(1, 1, 1) if seen else col, width=1.8, **o)
    shape.commit()
    if num:
        fs = BADGE_FS * 0.9
        w = fs * 0.5 * len(num)  # 数字约半个字宽
        pg.insert_text(fitz.Point(c.x - w / 2, c.y + fs * 0.36), num, fontsize=fs, color=col if seen else (1, 1, 1), **NOTE_KW, **o)


_FONT_OBJ = []


def _font():
    """量字宽用的字体（和写蓝字的同一个）；第一次用时才载入。"""
    if not _FONT_OBJ:
        _FONT_OBJ.append(fitz.Font(fontfile=NOTE_FONT) if NOTE_FONT else fitz.Font("cjk"))
    return _FONT_OBJ[0]


_TOKEN = re.compile(r"[A-Za-z0-9.,'+\-*/^=_()\[\]]+|\s+|.")
_NO_HEAD = set("，。、；：？！）》」』,.;:?!)")  # 不放在行首的标点


def wrap_text(text, width, fs):
    """按宽度折行（用写蓝字的那个字体量宽度）：英文单词、数字串不从中间断开（比一行还长的才断）；
    段落之间的空行留成 ""。返回行的列表。"""
    font = _font()

    def w(s):
        return font.text_length(s, fontsize=fs)

    out = []
    for para in str(text).replace("\r\n", "\n").split("\n"):
        if not para.strip():
            if out and out[-1] != "":
                out.append("")
            continue
        line = ""
        for tok in _TOKEN.findall(para):
            if tok.isspace():
                if line and w(line + " ") <= width:
                    line += " "
                elif line:
                    out.append(line.rstrip())
                    line = ""
                continue
            if w(line + tok) <= width:
                line += tok
                continue
            if line and tok in _NO_HEAD:  # 标点跟着上一行，宁可略出一点
                line += tok
                continue
            if line.strip():
                out.append(line.rstrip())
            while w(tok) > width and len(tok) > 1:  # 一个词比一行还长：硬断
                k = len(tok) - 1
                while k > 1 and w(tok[:k]) > width:
                    k -= 1
                out.append(tok[:k])
                tok = tok[k:]
            line = tok
        if line.strip():
            out.append(line.rstrip())
    while out and out[-1] == "":
        out.pop()
    return out


ANSWER_FS = 20
Q_COLOR = (0.45, 0.55, 0.72)  # 「问：」那一行：淡一些的蓝，和平板卡片上一样


def _answer_pages(doc, answers, no, width):
    """往来稿里紧跟在一页后面的「第 N 页的回答」：按圈号列出问和全文（之前的版本附在后面），
    用写蓝字的字体、自动换行，一页放不下就再加一页（标「续」）。"""
    width = max(800.0, min(float(width), 1400.0))
    height, m = round(width * 1.414), 70
    inner, pg, y = width - 2 * m, None, 0.0

    def new_page():
        nonlocal pg, y
        cont = pg is not None
        pg = doc.new_page(width=width, height=height)
        pg.draw_rect(pg.rect, color=None, fill=(1, 1, 1))
        pg.insert_text((m, m + 26), f"第 {no} 页的回答" + ("（续）" if cont else ""), fontsize=28, color=AI, **NOTE_KW)
        y = m + 26 + 34

    def put(line, fs, color):
        nonlocal y
        lh = fs * 1.55
        if y + lh > height - m:
            new_page()
        if line:
            pg.insert_text((m, y + fs), line, fontsize=fs, color=color, **NOTE_KW)
        y += lh

    new_page()
    for k, a in enumerate(answers):
        if k:
            y += 24
        put(f"圈号 {a.get('n') or ''}", 24, ADOPTED if a.get("adopted") else AI)
        if a.get("q"):
            for ln in wrap_text("问：" + str(a["q"]), inner, ANSWER_FS):
                put(ln, ANSWER_FS, Q_COLOR)
        for ln in wrap_text(a.get("text") or "", inner, ANSWER_FS):
            put(ln, ANSWER_FS, AI)
        for seg in more_of(a):  # 接在卡片下面的各段回应（回应卡片上的红字），前面写着它回应的那句红字；红字本身这里不画
            put("", ANSWER_FS, AI)
            if redo_head(seg):  # 点「再短点」「展开讲」请重写的那一段（2026-11-17）
                put(redo_head(seg), ANSWER_FS - 2, Q_COLOR)
            elif seg.get("q"):
                for ln in wrap_text("红字：" + str(seg["q"]), inner, ANSWER_FS - 2):
                    put(ln, ANSWER_FS - 2, MQ_COLOR)
            for ln in wrap_text(seg["text"], inner, ANSWER_FS):
                put(ln, ANSWER_FS, AI)
        older = [o for o in a.get("older") or [] if isinstance(o, dict) and str(o.get("text") or "").strip()]
        if older:
            put("", ANSWER_FS, AI)
            put("之前的版本：", ANSWER_FS - 2, Q_COLOR)
        for j, o in enumerate(older):
            if j:
                put("", ANSWER_FS - 2, Q_COLOR)
            for ln in wrap_text(o["text"], inner, ANSWER_FS - 2):
                put(ln, ANSWER_FS - 2, Q_COLOR)


def _draw_open(pg, sp, P, ox, oy, col, tx, op):
    """画摊在纸上的一段长回答（open_of 的结果）：细线（lead），每一行字照平板上的位置写（基线在行顶 + 字号，和短批注一样），
    公式那一行写它的 LaTeX 源码（小一号；PDF 里排不出 KaTeX 的样子，照实写出来，不编一个看着像的）。"""
    if sp.get("lead"):
        shape = pg.new_shape()
        draw_svg_path(shape, str(sp["lead"]), (ox, oy))
        shape.finish(color=col, width=1.3, lineCap=1, lineJoin=1, closePath=False, stroke_opacity=op)
        shape.commit()
    for r in sp["rows"]:
        y = sp["y"] + _num(r.get("y"))
        if isinstance(r.get("tex"), str):
            h = _num(r.get("h"), OPEN_LH)
            pg.insert_text(P(sp["x"], y + h / 2 + 6), r["tex"], fontsize=15, color=col, **NOTE_KW, **tx)
        elif r.get("t"):
            pg.insert_text(P(sp["x"], y + OPEN_FS), r["t"], fontsize=OPEN_FS * 0.9, color=col, **NOTE_KW, **tx)


def _draw_page(doc, page, base_h, bg=None, ai=True, struck="skip", blank=False):
    """在 doc 里新开一页，画底图（书页/推送页）、笔迹（黑/红）、Claude 写回的批注；返回 (pg, P, R, ox, oy)。

    ai=False：只画我自己写的（原稿）。struck：横划掉的蓝字怎么画——"skip" 不画（发给 Claude 的图、缩略图，照旧），
    "faded" 画淡（导出的往来稿，同平板）。橡皮擦掉的蓝字（erasedAt）一律不画。
    blank：空白本子（草稿本、自己新建的本子）——整页是纸，没有右边那一栏的底色和分隔线；这一页的大小是 blank_rect
    （整张纸，有东西出了纸就扩到包住它）。原稿和往来稿用同一个大小（都按往来稿里画的东西算），两份的页对得齐。
    返回的 ox、oy：页面坐标的原点在这一页 PDF 里的位置（页面坐标 + (ox, oy) = PDF 坐标）。
    """
    h = max(base_h, page.get("h") or 0)
    w, tw = widths(page)
    if blank:
        x0, y0, x1, y1 = blank_rect(page, base_h, "faded" if struck == "faded" else "skip")
        ox, oy = -x0, -y0
    else:
        ox, oy = origin(page)
        x1, y1 = tw, h
    P = lambda x, y: fitz.Point(x + ox, y + oy)  # noqa: E731 - 页面坐标 → PDF 坐标（纸可能向左、向上扩过）
    R = lambda x0, y0, x1, y1: fitz.Rect(x0 + ox, y0 + oy, x1 + ox, y1 + oy)  # noqa: E731
    pg = doc.new_page(width=x1 + ox, height=y1 + oy)
    pg.draw_rect(pg.rect, color=None, fill=(1, 1, 1))
    if not blank:  # 书页、推送页：右边一栏（平板上也只在这两种页上有）
        pg.draw_rect(R(w, -oy, tw, h), color=None, fill=(0.98, 0.973, 0.953))
    if bg:  # base_h 是转后的高度；PyMuPDF 的 rotate 正角是逆时针
        pg.insert_image(R(0, 0, PAGE_W, base_h), stream=bg, rotate=(360 - (page.get("rot") or 0)) % 360)
    if not blank:
        pg.draw_line(P(w, -oy), P(w, h), color=(0.89, 0.86, 0.8), width=1.5)

    for s in ink(page):
        if not s.get("pts") or s.get("erasedAt"):
            continue
        color = RED if s.get("c") == "r" else INK  # 回答过的红笔问题不变淡
        pts, sw = s["pts"], s.get("w", 2.1)
        shape = pg.new_shape()
        if len(pts) == 1:
            shape.draw_circle(P(pts[0][0], pts[0][1]), sw * 0.6)
            shape.finish(color=None, fill=color)
        else:
            avg_p = sum(p[2] for p in pts) / len(pts)
            shape.draw_polyline([P(p[0], p[1]) for p in pts])
            shape.finish(color=color, width=sw * (0.45 + 0.9 * avg_p), lineCap=1, lineJoin=1, closePath=False)
        shape.commit()
    if not ai:
        return pg, P, R, ox, oy

    live = live_ids(page)
    font = NOTE_KW
    for it in page.get("ai") or []:
        if it.get("erasedAt") or ai_gone(it, live):
            continue
        if it.get("dismissed") and struck != "faded":
            continue
        op = 0.25 if it.get("dismissed") else 1  # 横划掉的：同平板，画淡
        tx = {"fill_opacity": op, "stroke_opacity": op} if op < 1 else {}
        lay = it.get("lay")
        col = ADOPTED if it.get("adopted") else AI  # 采纳的深蓝
        at = badge_at(it)
        sp = open_of(it)
        if sp:  # 摊在纸上的长回答（2026-11-17）：和平板一样画那一段字（连到所答笔迹的细线照画）；公式画不出排好的样子，写它的 LaTeX 源码
            _draw_open(pg, sp, P, ox, oy, col, tx, op)
            continue
        if it.get("type") == "write":  # 收着的长回答：纸上只有圈号（蓝圈加数字），不画回答文字；和平板一样，没看过的实心、看过的空心
            if at:
                draw_badge(pg, P(*at), str(it.get("n") or ""), col, bool(it.get("seen")), op)
            continue
        dot = dot_at(it)
        if dot and struck != "faded":  # 收成小蓝点的短批注：给 Claude 的图、缩略图里和平板上一样只画那个点；往来稿照旧写字（在 lay 那里）
            shape = pg.new_shape()
            shape.draw_circle(P(*dot), DOT_R)
            shape.finish(color=None, fill=col, fill_opacity=op)
            shape.commit()
            continue
        fig = it.get("fig")
        if fig and FIG_DIR and FIG_NAME.match(str(it.get("img") or "")) and (FIG_DIR / it["img"]).is_file():  # Claude 放上来的图
            pg.insert_image(R(fig["x"], fig["y"], fig["x"] + fig["w"], fig["y"] + fig["h"]), filename=str(FIG_DIR / it["img"]))
        for path in it.get("paths") or []:
            shape = pg.new_shape()
            draw_svg_path(shape, path.get("d", ""), (ox, oy))
            if path.get("cls") == "hl":  # 荧光笔：黄色半透明底
                shape.finish(color=None, fill=HIGHLIGHT, fill_opacity=0.45 * op, closePath=True)
            else:
                dash = path.get("cls") in ("sbox", "dash") and it.get("verdict") != "yes"  # 还没同意的建议：虚线
                shape.finish(color=col, width=path.get("w") or 2.2, lineCap=1, lineJoin=1, closePath=False,
                             dashes="[7 5] 0" if dash else None, stroke_opacity=(0.35 if it.get("verdict") == "no" else 1) * op)
            shape.commit()
        if lay:
            for k, line in enumerate(lay.get("lines") or []):
                pg.insert_text(P(lay["x"], lay["y"] + lay["fs"] + k * lay["lh"]), line,
                               fontsize=lay["fs"] * 0.9, color=col, **font, **tx)
        for lb in it.get("labels") or []:  # 示意图里的字
            pg.insert_text(P(lb["x"], lb["y"] + lb["fs"]), lb["text"], fontsize=lb["fs"] * 0.9, color=col, **font, **tx)
    return pg, P, R, ox, oy


def _render_page(page, out_png, base_h, bg=None, label_groups=(), scale=0.8, clip=None, mark=None, blank=False):
    """把一页画成 PNG：底图（书页/推送页）、笔迹（黑/红）、Claude 写回的批注、笔迹分组编号。

    page：页面 JSON（strokes、ai、h、rot）；base_h：底图高度（页面坐标；页面转过时为转后的高度）；bg：底图字节；
    clip：只画 [x0,y0,x1,y1] 这一块（页面坐标）；mark：在这个框外画一圈虚线；blank：空白本子（见 _draw_page）。
    图里的像素 (px, py) 对应页面坐标 (clip[0] + px / scale, clip[1] + py / scale)——clip 在这一页里面时（调用的地方都按
    content_origin / content_extent / paper_rect 取，都在里面）；Claude 回的 box 就按这个换回页面坐标（整本检测记下的 crop）。
    """
    doc = fitz.open()
    pg, P, R, ox, oy = _draw_page(doc, page, base_h, bg, blank=blank)

    if mark:
        pg.draw_rect(R(mark[0] - 8, mark[1] - 8, mark[2] + 8, mark[3] + 8), color=(0.118, 0.42, 1), width=2.5, dashes="[8 5] 0")

    fs = 13 / scale
    for g in label_groups:
        x, y = max(-ox, g["bbox"][0]), max(-oy + fs + 2, g["bbox"][1] - 2)
        pg.draw_rect(R(x, y - fs, x + fs * 0.62 * len(g["id"]) + 4, y + 2), color=None, fill=(1, 1, 1), fill_opacity=0.85)
        pg.insert_text(P(x + 2, y), g["id"], fontsize=fs, color=LABEL)

    area = (R(*clip) & pg.rect) if clip else pg.rect
    pg.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=area, alpha=False).save(out_png)
    doc.close()


def render_page(*args, **kwargs):
    with FITZ_LOCK:
        return _render_page(*args, **kwargs)


def export_pdf(items, out_pdf, ai=True, blank=False):
    """把几页画成一份矢量 PDF。items：[(page, base_h, bg, 页码)]（页码从 1 起，可以不给，不给就按顺序数）。
    ai=False 是原稿（只有我写的：黑字、红字），ai=True 是往来稿（再加上 Claude 的蓝字；横划掉的画淡，橡皮擦掉的不画）：
    纸面照平板上的样子画（长回答只有圈号），这一页有长回答时紧跟着加一页「第 N 页的回答」，按圈号列出问和全文。
    blank：这是一本空白本子（草稿本、自己新建的本子），页面整页是纸、没有右边那一栏（见 _draw_page）。
    先写临时文件再换上；文件正被别的程序占着时抛错（调用方下次再试）。返回导出了几页纸（不算加在后面的回答页）。"""
    out_pdf = Path(out_pdf)
    tmp = out_pdf.with_name(out_pdf.stem + ".tmp.pdf")
    with FITZ_LOCK:
        doc = fitz.open()
        try:
            for k, it in enumerate(items):
                page, base_h, bg = it[:3]
                pg = _draw_page(doc, page, base_h, bg, ai=ai, struck="faded", blank=blank)[0]
                answers = answers_of(page) if ai else []
                if answers:
                    _answer_pages(doc, answers, it[3] if len(it) > 3 else k + 1, pg.rect.width)
            try:
                doc.subset_fonts()  # 楷体只留用到的字：一页往来稿从约 7 MB 降到几十 KB
            except Exception:  # noqa: BLE001 - 缩不了就整个嵌着，照样能用
                pass
            doc.save(str(tmp), garbage=3, deflate=True)
        finally:
            doc.close()
    os.replace(tmp, out_pdf)
    return len(items)

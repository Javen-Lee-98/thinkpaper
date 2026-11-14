"""在服务器上处理草稿纸页面：笔迹分组（规则与前端 computeGroups 一致），把任意一页连同笔迹画成图。

用于「整本检测」和「确认字迹」：平板没开着时，也能看到任何一页写了什么、某组笔迹在哪。
"""
import math
import os
import re
import threading
from pathlib import Path

try:
    import fitz
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


def _cluster(strokes):
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
    return groups


def group_strokes(strokes):
    """[(组编号, 这组没擦掉的笔迹)]，编号与 compute_groups 一致。"""
    out = []
    for i, g in enumerate(_cluster(strokes)):
        vis = [s for s in g["strokes"] if not s.get("erasedAt")]
        if vis:
            out.append((f"g{i + 1}", vis))
    return out


def compute_groups(strokes):
    """时间相近、位置相近、颜色相同的笔迹归为一组；返回的字段与前端发来的 groups 一致。"""
    groups = _cluster(strokes)
    out = []
    for i, gr in enumerate(groups):
        erased = [s for s in gr["strokes"] if s.get("erasedAt")]
        out.append({
            "id": f"g{i + 1}", "t0": gr["t0"], "t1": gr["t1"], "bbox": [round(v) for v in gr["bbox"]],
            "n": len(gr["strokes"]), "erased": len(erased),
            "erasedAt": max((s["erasedAt"] for s in erased), default=None),
            "revisit": any(o["t1"] < gr["t0"] - 30000 and box_dist(o["bbox"], gr["bbox"]) < 24 for o in groups[:i]),
            "red": gr["c"] == "r",
        })
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


def paper_rect(page, base_h):
    """整张纸的范围 [x0, y0, x1, y1]（页面坐标，x0、y0 可能是负数）。"""
    ox, oy = origin(page)
    return [-ox, -oy, widths(page)[1], max(base_h, page.get("h") or 0)]


def content_origin(page):
    """有内容的范围的左上角：向左、向上扩出来的纸上写了东西才往负方向扩，否则是 (0, 0)。"""
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
    """长回答下面接着回的各段（有字的）：[{id, t, req, q, text, on}]。"""
    return [m for m in it.get("more") or [] if isinstance(m, dict) and str(m.get("text") or "").strip()]


def marks_of(it):
    """卡片上的红字（有点的）。"""
    return [m for m in it.get("marks") or [] if isinstance(m, dict) and isinstance(m.get("pts"), list) and m["pts"]]


def unsent_marks(it):
    """还没交给 Claude 的红字（没有 req、没擦掉）：平板上圈号带红点的就是这些；有它们的页算「有新东西」。"""
    if it.get("type") != "write" or it.get("erasedAt") or it.get("dismissed") or not badge_at(it):
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
        block(str(m.get("id")), ([("红字：" + str(m["q"]), 18, "mq")] if m.get("q") else []) + [(m["text"], 20, "")])
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


def content_extent(page, base_h):
    """有内容的范围（右边界、下边界）：页边没写东西就不要页边，加长出来的空白不要。"""
    w, tw = widths(page)
    right, bottom = PAGE_W, base_h
    for s in ink(page):
        if s.get("pts") and not s.get("erasedAt"):
            b = stroke_box(s)
            bottom = max(bottom, b[3] + 60)
            right = max(right, min(tw, b[2] + 30))
    live = live_ids(page)
    for it in page.get("ai") or []:
        lay, at = it.get("lay"), badge_at(it)
        if at and not it.get("erasedAt"):  # 长回答的圈号
            bottom = max(bottom, at[1] + BADGE_R + 40)
            right = max(right, min(tw, at[0] + BADGE_R + 10))
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
            if seg.get("q"):
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


def _draw_page(doc, page, base_h, bg=None, ai=True, struck="skip"):
    """在 doc 里新开一页，画底图（书页/推送页）、笔迹（黑/红）、Claude 写回的批注；返回 (pg, P, R, ox, oy)。

    ai=False：只画我自己写的（原稿）。struck：横划掉的蓝字怎么画——"skip" 不画（发给 Claude 的图、缩略图，照旧），
    "faded" 画淡（导出的往来稿，同平板）。橡皮擦掉的蓝字（erasedAt）一律不画。
    """
    h = max(base_h, page.get("h") or 0)
    w, tw = widths(page)
    ox, oy = origin(page)
    P = lambda x, y: fitz.Point(x + ox, y + oy)  # noqa: E731 - 页面坐标 → PDF 坐标（纸可能向左、向上扩过）
    R = lambda x0, y0, x1, y1: fitz.Rect(x0 + ox, y0 + oy, x1 + ox, y1 + oy)  # noqa: E731
    pg = doc.new_page(width=tw + ox, height=h + oy)
    pg.draw_rect(pg.rect, color=None, fill=(1, 1, 1))
    pg.draw_rect(R(w, -oy, tw, h), color=None, fill=(0.98, 0.973, 0.953))
    if bg:  # base_h 是转后的高度；PyMuPDF 的 rotate 正角是逆时针
        pg.insert_image(R(0, 0, PAGE_W, base_h), stream=bg, rotate=(360 - (page.get("rot") or 0)) % 360)
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
        if it.get("type") == "write":  # 长回答：纸上只有圈号（蓝圈加数字），不画回答文字；和平板一样，没看过的实心、看过的空心
            if at:
                draw_badge(pg, P(*at), str(it.get("n") or ""), col, bool(it.get("seen")), op)
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


def _render_page(page, out_png, base_h, bg=None, label_groups=(), scale=0.8, clip=None, mark=None):
    """把一页画成 PNG：底图（书页/推送页）、笔迹（黑/红）、Claude 写回的批注、笔迹分组编号。

    page：页面 JSON（strokes、ai、h、rot）；base_h：底图高度（页面坐标；页面转过时为转后的高度）；bg：底图字节；
    clip：只画 [x0,y0,x1,y1] 这一块（页面坐标）；mark：在这个框外画一圈虚线。
    """
    doc = fitz.open()
    pg, P, R, ox, oy = _draw_page(doc, page, base_h, bg)

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


def export_pdf(items, out_pdf, ai=True):
    """把几页画成一份矢量 PDF。items：[(page, base_h, bg, 页码)]（页码从 1 起，可以不给，不给就按顺序数）。
    ai=False 是原稿（只有我写的：黑字、红字），ai=True 是往来稿（再加上 Claude 的蓝字；横划掉的画淡，橡皮擦掉的不画）：
    纸面照平板上的样子画（长回答只有圈号），这一页有长回答时紧跟着加一页「第 N 页的回答」，按圈号列出问和全文。
    先写临时文件再换上；文件正被别的程序占着时抛错（调用方下次再试）。返回导出了几页纸（不算加在后面的回答页）。"""
    out_pdf = Path(out_pdf)
    tmp = out_pdf.with_name(out_pdf.stem + ".tmp.pdf")
    with FITZ_LOCK:
        doc = fitz.open()
        try:
            for k, it in enumerate(items):
                page, base_h, bg = it[:3]
                pg = _draw_page(doc, page, base_h, bg, ai=ai, struck="faded")[0]
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

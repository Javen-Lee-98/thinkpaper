"""「字帖」：把每组手写笔迹裁出来、统一字高，标上 g 编号排成一张图（阶段 3「认字」）。

比整块圈选处的「只有笔迹」图字更大、token 更少；每一块也单独交给本机的识别器（PP-OCRv5）当旁证。
评测集（tools/evalset.py）也用这里的画法，评测和实际发送看到的是同一种图。
"""
from PIL import Image, ImageDraw, ImageFont

import pages

CHAR_H = 48      # 每组缩放到一个字大约这么高（像素）
CELL_MAX_W = 1100
CELL_MAX_H = 360  # 一组太高（整段多行）时整体再缩
LABEL_W = 56
PAD = 10
MAX_GROUPS = 16
RED = (200, 40, 30)
BLACK = (20, 20, 20)


def _union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def cell(strokes, char_h=CHAR_H, max_w=CELL_MAX_W, max_h=CELL_MAX_H, pad=12):
    """一组笔迹画成白底图：字高缩放到约 char_h 像素（太宽、太高时整体再缩），红笔红色、黑笔黑色。"""
    boxes = [pages.stroke_box(s) for s in strokes if s.get("pts")]
    if not boxes:
        return None
    heights = sorted(b[3] - b[1] for b in boxes)
    ch = max(8.0, heights[int(len(heights) * 0.75)]) * 1.3  # 一个字大约是较高那几笔的高度
    k = max(0.3, min(4.0, char_h / ch))
    b = _union(boxes)
    bw, bh = b[2] - b[0], b[3] - b[1]
    k = min(k, (max_w - 2 * pad) / max(bw, 1), (max_h - 2 * pad) / max(bh, 1))
    W, H = max(8, int(bw * k) + 2 * pad), max(8, int(bh * k) + 2 * pad)
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    for s in strokes:
        if not s.get("pts"):
            continue
        col = RED if s.get("c") == "r" else BLACK
        pts = [((p[0] - b[0]) * k + pad, (p[1] - b[1]) * k + pad) for p in s["pts"]]
        w = max(2, round((s.get("w") or 2.1) * k * 0.9))
        if len(pts) == 1:
            x, y = pts[0]
            d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=col)
        else:
            d.line(pts, fill=col, width=w, joint="curve")
    return im


def lines(strokes):
    """一组笔迹按行分开（识别器一次只认一行）：笔画中心的高度和某一行的平均高度差不到 0.6 个字高就归那一行。
    我们有笔画的位置，比让识别器在图上找文字行（它在手写上常找不到）可靠。返回 [[笔迹]]，从上到下。"""
    ss = [s for s in strokes if s.get("pts")]
    if not ss:
        return []
    boxes = {id(s): pages.stroke_box(s) for s in ss}
    heights = sorted(b[3] - b[1] for b in boxes.values())
    ch = max(8.0, heights[int(len(heights) * 0.75)]) * 1.3
    cy = {id(s): (boxes[id(s)][1] + boxes[id(s)][3]) / 2 for s in ss}
    tall = [s for s in ss if boxes[id(s)][3] - boxes[id(s)][1] > 1.6 * ch]  # 竖得很长的一笔（括号、竖线）：先不定，最后跟最近的一行
    rows = []  # [中心高度之和, 笔数, 笔迹]
    tall_ids = {id(s) for s in tall}
    for s in sorted((s for s in ss if id(s) not in tall_ids), key=lambda s: cy[id(s)]):
        row = next((r for r in rows if abs(r[0] / r[1] - cy[id(s)]) < 0.6 * ch), None)
        if row is None:
            rows.append([cy[id(s)], 1, [s]])
        else:
            row[0] += cy[id(s)]
            row[1] += 1
            row[2].append(s)
    for s in tall:
        if rows:
            min(rows, key=lambda r: abs(r[0] / r[1] - cy[id(s)]))[2].append(s)
        else:
            rows.append([cy[id(s)], 1, [s]])
    rows.sort(key=lambda r: r[0] / r[1])
    return [r[2] for r in rows]


def _font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # 老版本 Pillow
        return ImageFont.load_default()


def sheet(cells):
    """cells：[(编号, 图)]。一组一行，左边灰色编号；返回整张图。"""
    if not cells:
        return None
    w = LABEL_W + max(im.width for _, im in cells) + PAD
    h = sum(im.height for _, im in cells) + PAD * (len(cells) + 1)
    out = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(out)
    font = _font(20)
    y = PAD
    for gid, im in cells:
        out.paste(im, (LABEL_W, y))
        d.text((8, y + im.height / 2), gid, fill=(120, 120, 120), font=font, anchor="lm")
        y += im.height + PAD
        d.line([(8, y - PAD / 2), (w - 8, y - PAD / 2)], fill=(232, 232, 232), width=1)
    return out


def pick(groups, page):
    """要上字帖的组：圈选范围内的和红笔的，没全擦掉，和服务器上存的这一页对得上的（pages.sent_groups）。
    返回 [(编号, 笔迹)]，红笔在前，最多 MAX_GROUPS 组。"""
    mine = pages.sent_groups([g for g in groups if g.get("inSel") or (g.get("red") and not g.get("answered"))], page)
    out = []
    for g in groups:
        gid = g.get("id")
        if gid not in mine:
            continue
        out.append((gid, mine[gid], bool(g.get("red"))))
    out.sort(key=lambda x: not x[2])  # 太多时红笔优先留下
    return sorted(((gid, ss) for gid, ss, _ in out[:MAX_GROUPS]), key=lambda x: int(x[0][1:]))

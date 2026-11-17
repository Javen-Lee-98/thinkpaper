"""文档更新：新旧两版 PDF 逐页对齐（插页、删页后手写仍跟着原来那一页），找出每页改动的区域。"""
import difflib
import hashlib

import numpy as np

try:
    import pymupdf as fitz
except ImportError:
    try:
        import fitz  # 1.24.3 以前的 PyMuPDF 只有这个旧名字
    except ImportError:
        fitz = None

PAGE_W = 1000
DIFF_PX = 600        # 比较时渲染的宽度（像素）
CELL = 12            # 改动按 12×12 像素的格子统计
CELL_FRAC = 0.03     # 格子里超过 3% 的像素变了，算这一格改过


def page_sig(page):
    """一页的指纹：有足够文字就用文字，否则（纯图的页）用缩略图。"""
    text = "".join(page.get_text("text").split())
    if len(text) >= 12:
        return "t:" + text
    pix = page.get_pixmap(matrix=fitz.Matrix(48 / max(1, page.rect.width), 48 / max(1, page.rect.width)),
                          colorspace=fitz.csGRAY, alpha=False)
    return "i:" + hashlib.sha1(bytes(b // 32 for b in pix.samples)).hexdigest()


def _similar(a, b):
    if a[:2] != b[:2]:
        return 0.0
    return difflib.SequenceMatcher(None, a[2:], b[2:], autojunk=False).ratio()


def align(old_doc, new_doc):
    """返回列表 m：m[新页号] = 对应的旧页号（新加的页为 None）。顺序不变：只对齐，不交换页的先后。"""
    olds = [page_sig(p) for p in old_doc]
    news = [page_sig(p) for p in new_doc]
    m = [None] * len(news)
    sm = difflib.SequenceMatcher(None, olds, news, autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            for k in range(i2 - i1):
                m[j1 + k] = i1 + k
        elif op == "replace":
            # 改过的页：同样多就按位置一一对应（改得再多，旧批注也留在原位，方便核对改了没有）；
            # 页数变了（有插页或删页）就找总相似度最高的保序配对，配不上的算新页或删掉的页
            if i2 - i1 == j2 - j1:
                for k in range(j2 - j1):
                    m[j1 + k] = i1 + k
            else:
                for i, j in _best_pairs(olds[i1:i2], news[j1:j2]):
                    m[j1 + j] = i1 + i
    return m


def _best_pairs(olds, news, floor=0.4):
    n, k = len(olds), len(news)
    sim = [[_similar(a, b) for b in news] for a in olds]
    best = [[0.0] * (k + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(k - 1, -1, -1):
            take = sim[i][j] + best[i + 1][j + 1] if sim[i][j] >= floor else -1
            best[i][j] = max(best[i + 1][j], best[i][j + 1], take)
    pairs, i, j = [], 0, 0
    while i < n and j < k:
        if sim[i][j] >= floor and best[i][j] == sim[i][j] + best[i + 1][j + 1]:
            pairs.append((i, j))
            i, j = i + 1, j + 1
        elif best[i][j] == best[i + 1][j]:
            i += 1
        else:
            j += 1
    return pairs


def _gray(page, w):
    z = w / max(1, page.rect.width)
    pix = page.get_pixmap(matrix=fitz.Matrix(z, z), colorspace=fitz.csGRAY, alpha=False)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.stride)[:, :pix.width]


def diff_boxes(old_page, new_page):
    """新旧两页的改动区域（页面坐标，宽 1000），没有改动返回 []。"""
    a, b = _gray(old_page, DIFF_PX), _gray(new_page, DIFF_PX)
    h = min(a.shape[0], b.shape[0])
    if abs(a.shape[0] - b.shape[0]) > 2:  # 页面比例变了：整页算改过
        return [[0, 0, PAGE_W, round(PAGE_W * new_page.rect.height / new_page.rect.width)]]
    changed = np.abs(a[:h].astype(np.int16) - b[:h].astype(np.int16)) > 40
    gh, gw = -(-h // CELL), -(-DIFF_PX // CELL)
    pad = np.zeros((gh * CELL, gw * CELL), dtype=bool)
    pad[:h, :changed.shape[1]] = changed
    cells = pad.reshape(gh, CELL, gw, CELL).mean(axis=(1, 3)) > CELL_FRAC
    if not cells.any():
        return []
    # 相邻（含隔一格）的改动格子连成一块
    seen = np.zeros_like(cells)
    boxes = []
    for y, x in zip(*np.nonzero(cells)):
        if seen[y, x]:
            continue
        stack, y0, x0, y1, x1 = [(y, x)], y, x, y, x
        seen[y, x] = True
        while stack:
            cy, cx = stack.pop()
            y0, x0, y1, x1 = min(y0, cy), min(x0, cx), max(y1, cy), max(x1, cx)
            for ny in range(max(0, cy - 2), min(gh, cy + 3)):
                for nx in range(max(0, cx - 2), min(gw, cx + 3)):
                    if cells[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
        k = PAGE_W / DIFF_PX
        boxes.append([round(x0 * CELL * k) - 6, round(y0 * CELL * k) - 6, round((x1 + 1) * CELL * k) + 6,
                      round((y1 + 1) * CELL * k) + 6])
    return boxes


def compare(old_bytes, new_bytes):
    """返回 (对齐表, {新页号: {"old": 旧页号或 None, "status": same/changed/new, "boxes": [...]}}, 没对上的旧页号)。"""
    old_doc = fitz.open(stream=old_bytes, filetype="pdf")
    new_doc = fitz.open(stream=new_bytes, filetype="pdf")
    try:
        m = align(old_doc, new_doc)
        pages = {}
        for j, i in enumerate(m):
            if i is None:
                pages[j] = {"old": None, "status": "new", "boxes": []}
                continue
            boxes = diff_boxes(old_doc[i], new_doc[j])
            pages[j] = {"old": i, "status": "changed" if boxes else "same", "boxes": boxes}
        removed = sorted(set(range(len(old_doc))) - {i for i in m if i is not None})
        return m, pages, removed
    finally:
        old_doc.close()
        new_doc.close()

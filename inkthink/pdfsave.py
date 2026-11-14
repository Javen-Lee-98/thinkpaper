"""把一本书上的手写和 Claude 的批注写回原 PDF（标准 PDF 批注：手写和标记是墨迹批注，文字批注是便签；
长回答是一个圈号（圆圈批注加数字），全文是挂在圈号位置的便签）。

写进去的批注作者（/T）都以「InkThink」开头：再存一次时先删掉它们再写，不会越叠越多；导入 PDF 时也靠它
把这些批注去掉，书页底图里不会把字再画一遍。PDF 里别人加的批注不动。
"""
import os
import re
import shutil
import uuid
from pathlib import Path

import pages

try:
    import fitz
except ImportError:
    fitz = None

TAG = "InkThink"
ME, CLAUDE = TAG, TAG + " · Claude"
PAGE_W = pages.PAGE_W
SUBJECT = {"underline": "下划线", "circle": "圈", "arrow": "箭头", "note": "页边批注", "question": "提问", "write": "长回答",
           "suggest": "修改建议", "tick": "打勾", "cross": "打叉", "strike": "删除线", "insert": "插入", "wavy": "存疑",
           "highlight": "荧光笔", "brace": "括号", "number": "编号", "label": "关系词", "node": "建议的概念", "link": "建议的连线",
           "group": "建议的分组", "sketch": "示意图", "formula": "公式", "figure": "图"}
MARKS = {"underline", "circle", "arrow", "tick", "cross", "strike", "insert", "wavy", "brace", "number",
         "node", "link", "group", "sketch"}  # 画成墨迹批注的
ICON = {"note": "Note", "question": "Help", "write": "Comment", "suggest": "Comment", "label": "Comment", "formula": "Comment"}
VERDICT = {"yes": "同意", "no": "不同意"}
DECOR = {"leader"}  # 页边批注的引线：PDF 里便签自己有图标，不画


OWNER_KEY = "InkThinkOwner"  # 写进批注字典的自定义键：哪本本子写的（存回时随机生成、记在 _sources.json）


def is_own(annot):
    return (annot.info.get("title") or "").startswith(TAG)


def owner_of(doc, annot):
    """这条批注是哪本本子写的；改版前写的、或不是 InkThink 写的返回 None。"""
    kind, val = doc.xref_get_key(annot.xref, OWNER_KEY)
    return val if kind == "string" else None


def mine(doc, annot, owners, legacy=False):
    """这条批注是不是这些本子写的：看归属标记；legacy 时，改版前写的（作者是 InkThink、没有标记）也算。
    别的电脑、别人用 InkThink 写的（标记不在 owners 里）不算，留着。"""
    if not is_own(annot):
        return False
    o = owner_of(doc, annot)
    return o in owners if o is not None else legacy


def flatten(d, steps=8):
    """前端生成的批注路径（只有绝对坐标的 M / L / Q / C）→ 折线，每个 M 起一笔。"""
    toks = re.findall(r"[MLQC]|-?\d*\.?\d+(?:e-?\d+)?", d or "")
    lines, cmd, i = [], None, 0

    def pt():
        nonlocal i
        p = (float(toks[i]), float(toks[i + 1]))
        i += 2
        return p

    while i < len(toks):
        if toks[i] in "MLQC":
            cmd = toks[i]
            i += 1
            continue
        try:
            if cmd == "M":
                lines.append([pt()])
            elif cmd == "L" and lines:
                lines[-1].append(pt())
            elif cmd == "Q" and lines:
                p0, c, p1 = lines[-1][-1], pt(), pt()
                for k in range(1, steps + 1):
                    t = k / steps
                    lines[-1].append(tuple((1 - t) ** 2 * p0[j] + 2 * (1 - t) * t * c[j] + t * t * p1[j] for j in (0, 1)))
            elif cmd == "C" and lines:
                p0, c1, c2, p1 = lines[-1][-1], pt(), pt(), pt()
                for k in range(1, steps + 1):
                    t = k / steps
                    lines[-1].append(tuple((1 - t) ** 3 * p0[j] + 3 * (1 - t) ** 2 * t * c1[j] + 3 * (1 - t) * t * t * c2[j]
                                           + t ** 3 * p1[j] for j in (0, 1)))
            else:
                i += 1
        except (IndexError, ValueError):
            break
    return [ln for ln in lines if len(ln) > 1]


def _union(boxes):
    boxes = list(boxes)
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def marks_of(page, h0):
    """一页上要写进 PDF 的东西，坐标都换成没转时的页面坐标（0–1000 × h0）。

    返回 {"ink": [{title, subject, color, width, strokes, content}], "notes": [{at, text, icon, subject}],
          "badges": [{rect, n, color}]（长回答的圈号，全文是挂在圈号位置的那条便签）,
          "outside": 页面外跳过的手写组数, "outside_ai": 页面外跳过的 Claude 批注数}。
    """
    rot = page.get("rot") or 0
    m = pages.turn_between(rot, 0, h0) if rot else (1, 0, 0, 1, 0, 0)

    def P(x, y):
        return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])

    def B(b):
        return pages.turn_box(m, b)

    def inside(b):
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        return 0 <= cx <= PAGE_W and 0 <= cy <= h0

    out = {"ink": [], "notes": [], "hl": [], "figs": [], "badges": [], "outside": 0, "outside_ai": 0}
    for _, ss in pages.group_strokes(pages.ink(page)):
        if not inside(B(_union(map(pages.stroke_box, ss)))):
            out["outside"] += 1
            continue
        strokes, widths = [], []
        for s in ss:
            pts = [P(p[0], p[1]) for p in s["pts"]]
            if len(pts) == 1:  # 点一下：补成一小段，PDF 里才看得见
                pts.append((pts[0][0] + 0.6, pts[0][1] + 0.6))
            strokes.append(pts)
            widths.append(s.get("w", 2.1) * (0.45 + 0.9 * sum(p[2] for p in s["pts"]) / len(s["pts"])))
        red = any(s.get("c") == "r" for s in ss)
        out["ink"].append({"title": ME, "subject": "红笔" if red else "手写", "color": pages.RED if red else pages.INK,
                           "width": sum(widths) / len(widths), "strokes": strokes, "content": ""})

    live = pages.live_ids(page)
    for it in page.get("ai") or []:
        kind = it.get("type")
        if it.get("dismissed") or kind not in SUBJECT or pages.ai_gone(it, live):
            continue
        if kind == "highlight":  # 荧光笔：写成 PDF 的高亮批注
            if it.get("box") and inside(B(it["box"])):
                out["hl"].append({"rect": B(it["box"]), "subject": SUBJECT[kind]})
            elif it.get("box"):
                out["outside_ai"] += 1
            continue
        if kind in ("node", "link", "group") and it.get("verdict") == "no":  # 概念图上没同意的建议不写
            continue
        if kind == "figure":  # Claude 放上来的图：写成图章批注，内容里是图注
            fig, f = it.get("fig"), pages.FIG_DIR / (it.get("img") or "") if pages.FIG_DIR else None
            if not fig or not f or not f.is_file():
                continue
            b = B([fig["x"], fig["y"], fig["x"] + fig["w"], fig["y"] + fig["h"]])
            if not inside(b):
                out["outside_ai"] += 1
                continue
            text = "图（Claude 生成）" + (f"：{it['text']}" if it.get("text") else "")
            out["figs"].append({"rect": b, "file": str(f), "content": ("（AI 提供、已采纳）" if it.get("adopted") else "") + text})
            continue
        if kind in MARKS:
            lines = [[P(x, y) for x, y in ln] for p in it.get("paths") or [] if p.get("cls") not in DECOR
                     for ln in flatten(p.get("d"))]
            if not lines:
                continue
            box = B(it["box"]) if it.get("box") else _union((x, y, x, y) for ln in lines for x, y in ln)
            if not inside(box):
                out["outside_ai"] += 1
                continue
            w = max((p.get("w") or 2.2) for p in it.get("paths") or [{}])
            content = it.get("text") or ""
            if it.get("adopted"):  # 采纳的：写明来源
                content = "（AI 提供、已采纳）" + content
            if kind == "sketch":  # 示意图：图注和图里的字写进批注内容
                words = "、".join(lb.get("text") or "" for lb in it.get("labels") or [] if lb.get("text"))
                content = "示意图" + (f"：{content}" if content else "") + (f"（图中的字：{words}）" if words else "")
            if kind in ("node", "link", "group"):
                content = f"{SUBJECT[kind]}（{VERDICT.get(it.get('verdict'), '未定')}）：{content}"
            out["ink"].append({"title": CLAUDE, "subject": SUBJECT[kind], "color": pages.AI, "width": w, "strokes": lines,
                               "content": content})
            continue
        text = (it.get("text") or "").strip()
        if not text:
            continue
        if kind == "write":  # 长回答：圈号画进 PDF，全文作为一条便签挂在圈号的位置（右上角，不压着数字）
            at = pages.badge_at(it)
            if not at:
                continue
            r = pages.BADGE_R
            b = B([at[0] - r, at[1] - r, at[0] + r, at[1] + r])
            if not inside(b):
                out["outside_ai"] += 1
                continue
            head = f"圈号 {it.get('n')}" if it.get("n") else "长回答"
            text = f"{head}\n" + (f"问：{it['q']}\n" if it.get("q") else "") + text
            if it.get("adopted"):
                text = "（AI 提供、已采纳）" + text
            for m in pages.more_of(it):  # 接在卡片下面的各段回应（回应卡片上的红字）；红字本身不写进 PDF
                text += "\n\n" + (f"红字：{m['q']}\n" if m.get("q") else "") + str(m["text"]).strip()
            older = [o["text"].strip() for o in it.get("older") or [] if isinstance(o, dict) and str(o.get("text") or "").strip()]
            if older:
                text += "\n\n之前的版本：\n" + "\n\n".join(older)
            col = pages.ADOPTED if it.get("adopted") else pages.AI
            out["badges"].append({"rect": b, "n": str(it.get("n") or ""), "color": col})
            out["notes"].append({"at": (b[2], b[1]), "text": text, "icon": ICON[kind], "subject": SUBJECT[kind]})
            continue
        if kind == "formula":  # 公式：便签里是 LaTeX 源码
            text = f"公式：{text}"
        if it.get("adopted"):
            text = "（AI 提供、已采纳）" + text
        if kind == "suggest":  # 修改建议：带上我的决定
            text = f"修改建议（{VERDICT.get(it.get('verdict'), '未定')}）：{text}"
        if not it.get("box"):
            continue
        b = B(it["box"])
        if not inside(b):
            out["outside_ai"] += 1
            continue
        out["notes"].append({"at": (b[2], b[1]), "text": text, "icon": ICON[kind], "subject": SUBJECT[kind]})
    return out


def strip_own(doc, owners, legacy=False):
    """删掉文档里这些本子写过的批注（见 mine），返回条数。"""
    n = 0
    for pg in doc:
        for a in [a for a in pg.annots() if mine(doc, a, owners, legacy)]:
            pg.delete_annot(a)
            n += 1
    return n


def strip_own_file(path, owners, legacy=False):
    """文件里有这些本子写过的批注就去掉（导入 PDF 时用：平板上本来就画着）；返回去掉的条数。调用方持有 pages.FITZ_LOCK。"""
    path = Path(path)
    doc = fitz.open(str(path))
    try:
        if doc.needs_pass or not any(mine(doc, a, owners, legacy) for pg in doc for a in pg.annots()):
            return 0
        n = strip_own(doc, owners, legacy)
        tmp = path.with_name(path.stem + f".strip-{uuid.uuid4().hex[:6]}.pdf")
        doc.save(str(tmp), garbage=1, deflate=True)
    finally:
        doc.close()
    os.replace(tmp, path)
    return n


def _write_page(pg, page, stats, owner):
    k = pg.rect.width / PAGE_W
    h0 = round(PAGE_W * pg.rect.height / pg.rect.width, 1)
    dm = pg.derotation_matrix  # PDF 本身带 /Rotate 时，批注坐标按没转的页算

    def P(x, y):
        return tuple(fitz.Point(x * k, y * k) * dm)

    mk = marks_of(page, h0)
    for ink in mk["ink"]:
        a = pg.add_ink_annot([[P(x, y) for x, y in s] for s in ink["strokes"]])
        a.set_border(width=max(0.4, ink["width"] * k))
        a.set_colors(stroke=ink["color"])
        a.set_info(title=ink["title"], subject=ink["subject"], content=ink["content"])
        a.set_flags(fitz.PDF_ANNOT_IS_PRINT)
        a.update()
        _tag(pg, a, owner)
        stats["ink" if ink["title"] == ME else "marks"] += 1
    for h in mk["hl"]:
        q = [P(x, y) for x, y in ((h["rect"][0], h["rect"][1]), (h["rect"][2], h["rect"][3]))]
        a = pg.add_highlight_annot(fitz.Rect(min(q[0][0], q[1][0]), min(q[0][1], q[1][1]), max(q[0][0], q[1][0]), max(q[0][1], q[1][1])))
        a.set_colors(stroke=pages.HIGHLIGHT)
        a.set_info(title=CLAUDE, subject=h["subject"])
        a.set_flags(fitz.PDF_ANNOT_IS_PRINT)
        a.update()
        _tag(pg, a, owner)
        stats["hl"] += 1
    for fg in mk["figs"]:
        q = [P(x, y) for x, y in ((fg["rect"][0], fg["rect"][1]), (fg["rect"][2], fg["rect"][3]))]
        a = pg.add_stamp_annot(fitz.Rect(min(q[0][0], q[1][0]), min(q[0][1], q[1][1]), max(q[0][0], q[1][0]), max(q[0][1], q[1][1])),
                               stamp=fg["file"])
        a.set_info(title=CLAUDE, subject=SUBJECT["figure"], content=fg["content"])
        a.set_flags(fitz.PDF_ANNOT_IS_PRINT)
        _tag(pg, a, owner)
        stats["marks"] += 1
    for bd in mk["badges"]:  # 长回答的圈号：一个圆圈批注，里面一条写着数字的文字批注（全文在旁边那条便签里）
        q = [P(x, y) for x, y in ((bd["rect"][0], bd["rect"][1]), (bd["rect"][2], bd["rect"][3]))]
        rect = fitz.Rect(min(q[0][0], q[1][0]), min(q[0][1], q[1][1]), max(q[0][0], q[1][0]), max(q[0][1], q[1][1]))
        a = pg.add_circle_annot(rect)
        a.set_border(width=max(0.8, 1.8 * k))
        a.set_colors(stroke=bd["color"])
        a.set_info(title=CLAUDE, subject="圈号", content=f"圈号 {bd['n']}")
        a.set_flags(fitz.PDF_ANNOT_IS_PRINT)
        a.update()
        _tag(pg, a, owner)
        if bd["n"]:
            fs = max(5.0, pages.BADGE_FS * 0.8 * k)
            t = pg.add_freetext_annot(rect, bd["n"], fontsize=fs, fontname="helv", text_color=bd["color"], align=fitz.TEXT_ALIGN_CENTER,
                                      rotate=pg.rotation)
            t.set_info(title=CLAUDE, subject="圈号", content=bd["n"])
            t.set_flags(fitz.PDF_ANNOT_IS_PRINT)
            t.update()
            _tag(pg, t, owner)
    pad = 22 / k  # 便签图标约 20pt：整个放进页面里
    for n in mk["notes"]:
        x, y = n["at"]
        x, y = min(max(x, pad), PAGE_W - pad), min(max(y, pad), h0 - pad)
        a = pg.add_text_annot(fitz.Point(*P(x, y)), n["text"], icon=n["icon"])
        a.set_colors(stroke=pages.AI)
        a.set_info(title=CLAUDE, subject=n["subject"], content=n["text"])
        a.set_flags(fitz.PDF_ANNOT_IS_PRINT)
        a.update()
        _tag(pg, a, owner)
        stats["notes"] += 1
    stats["outside"] += mk["outside"]
    stats["outside_ai"] += mk["outside_ai"]


def _tag(pg, annot, owner):
    pg.parent.xref_set_key(annot.xref, OWNER_KEY, fitz.get_pdf_str(owner))


def save(src, items, keeper, work_dir, owner="local", legacy=False):
    """把 items（[(PDF 页号, 页面数据)]）写进 src：先删掉这本本子（owner）上次写的，再写这次的，都标上 owner。
    legacy：这份文件在改版前存回过，那时写的批注没有归属标记，也一起换掉。调用方持有 pages.FITZ_LOCK。

    换上之前先用 keeper（keep.Keeper，和改文件同一个留底文件夹）把原文件留底，能在平板上撤回；留底没做成就不写原文件
    （2026-11-14 起；以前的办法是在 data/backups 里另存几份，那些旧备份留着不动）。

    返回 {ink, marks, notes, outside, outside_ai, removed, kept（这次留底的记录，见 keep.Keeper.keep）}。文件被别的程序占用、
    带密码、存的过程中被别的程序改了、留底没做成时抛 ValueError，原文件不动。
    """
    src, work_dir = Path(src), Path(work_dir)
    busy = ValueError("文件正被别的程序占用（比如 Acrobat 开着它）：关掉后再存")
    try:
        with open(src, "r+b"):
            pass
    except PermissionError:
        raise busy from None
    st0 = src.stat()
    work_dir.mkdir(parents=True, exist_ok=True)
    work = work_dir / f"savepdf-{uuid.uuid4().hex[:8]}.pdf"
    full = work.with_name(work.stem + "-full.pdf")
    shutil.copyfile(src, work)
    stats = {"ink": 0, "marks": 0, "notes": 0, "hl": 0, "outside": 0, "outside_ai": 0}
    try:
        doc = fitz.open(str(work))
        try:
            if doc.needs_pass:
                raise ValueError("这份 PDF 有密码，存不进去")
            stats["removed"] = strip_own(doc, {owner}, legacy)
            for i, page in items:
                if 0 <= i < len(doc):
                    _write_page(doc[i], page, stats, owner)
            if doc.can_save_incrementally():  # 原有字节不动，只在末尾追加
                doc.saveIncr()
                out = work
            else:
                doc.save(str(full), garbage=1, deflate=True)
                out = full
            pages_n = len(doc)
        finally:
            doc.close()
        # 写好的先复制到原件旁边（同一个文件夹、同一个盘），确认打得开、页数对，再一步换上：中途出事原件不会只写一半
        stage = src.with_name(f".~inkthink-{uuid.uuid4().hex[:8]}.pdf")  # .~ 开头：新文件提示里不列
        try:
            shutil.copyfile(out, stage)
            with fitz.open(str(stage)) as chk:
                if len(chk) != pages_n:
                    raise ValueError("写出来的 PDF 校验没通过，原文件没动")
            st1 = src.stat()
            if (st1.st_mtime_ns, st1.st_size) != (st0.st_mtime_ns, st0.st_size):
                raise ValueError("存的过程中原文件被别的程序改了（比如同步盘刚更新它），这次没写进去，原文件没动：再存一次")
            try:
                stats["kept"] = keeper.keep(src, "存回 PDF 前")
            except ValueError as e:  # keep.KeepError：留底没做成，不写原文件
                raise ValueError(f"存之前没能把原文件留底（{e}），这次没写进去，原文件没动") from None
            try:
                os.replace(stage, src)
            except PermissionError:
                raise busy from None
        finally:
            if stage.exists():
                stage.unlink()
    finally:
        for f in (work, full):
            if f.exists():
                f.unlink()
    return stats

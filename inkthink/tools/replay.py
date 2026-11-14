"""按现在的规则把真实投递重拼一遍，比较每次投递有多胖（阶段 3「投递瘦身」的测量）。

数据来源（只读）：data/submissions/<投递编号>/ 的 meta.json、message.txt 和图片。
页面名、书本原文从原来的 message.txt 里取回（服务当时拼进去的），书写过程和识别结果在 meta.json 里。
重拼出来的消息只有这一页的内容（固定说明在系统提示里，每个对话一次）、只列这一页的图和字帖；字帖按投递时每组的笔迹 id
从 data/notebooks 找回笔迹现画（只读）；这一页的图按平板现在的尺寸上限折算（以前存下的更大）。

token 是估计，算法和 tools/timing.py 一样：文字每字约 1 个 token，图片每 28×28 像素 1 个。

用法：
    .venv\\Scripts\\python.exe tools\\replay.py [--data data] [--since 20261020] [--n 60]

只输出数字，不输出投递内容。
"""
import argparse
import json
import re
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

import inksheet  # noqa: E402
import prompt  # noqa: E402
from timing import IMG_EXT, image_tokens  # noqa: E402

PATH_RE = re.compile(r"[A-Za-z]:\\[^\s（）()，,]+?\.(?:jpg|jpeg|png)", re.I)


def paragraphs(text):
    return text.split("\n\n")


def old_parts(text):
    """从原来的消息里取回页面名、书本原文（以前框选时放的是「圈选范围内的书本原文」，也算）。"""
    label, book = "", ""
    for p in paragraphs(text):
        if p.startswith("页面：") and not label:
            label = p[3:].rstrip("。")
        elif p.startswith(("这一页的书本原文：\n", "这一页的书本原文（节选）：\n", "圈选范围内的书本原文：\n")) and not book:
            book = p.split("\n", 1)[1]
    return label, book


def referenced_images(text, d):
    """消息里让 Claude 读的图（只算这次投递目录里的）。"""
    out = []
    for m in PATH_RE.finditer(text):
        p = Path(m.group(0))
        if p.parent.name == d.name and p.suffix.lower() in IMG_EXT and (d / p.name).is_file():
            out.append(d / p.name)
    return list(dict.fromkeys(out))


def stroke_index(data):
    """data/notebooks 里所有笔迹，按 id 查（只读）。"""
    out = {}
    for f in (data / "notebooks").glob("*/*.json"):
        if f.name.endswith(".pending.json"):
            continue
        try:
            page = json.loads(f.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(page, dict):
            for s in page.get("strokes") or []:
                if isinstance(s, dict) and s.get("pts"):
                    out[s.get("id")] = s
    return out


def sheet_tokens(meta, strokes):
    """按现在的做法给这次投递画字帖（当时范围内的和红笔的组，用投递时每组的笔迹 id 找回笔迹），返回它的 token；画不出来是 None。"""
    cells = []
    for g in meta.get("groups") or []:
        if not (g.get("inSel") or (g.get("red") and not g.get("answered"))) or not g.get("ids"):
            continue
        ss = [strokes[i] for i in g["ids"] if i in strokes and not strokes[i].get("erasedAt")]
        im = inksheet.cell(ss) if ss else None
        if im is not None:
            cells.append((g["id"], im))
    if not cells:
        return None
    im = inksheet.sheet(cells[:inksheet.MAX_GROUPS])
    k = min(1.0, 2576 / max(im.size))
    return round(im.size[0] * k * im.size[1] * k / 784)


CROP_MAX = 1200   # 平板现在画的这一页的图长边最多这么多（static/app.js 的 renderForAI）


def now_tokens(p):
    """这张图按平板现在的尺寸画会是多少 token（以前存下的可能更大）。"""
    from PIL import Image
    if p.name != "crop.jpg":
        return image_tokens(p)
    with Image.open(p) as im:
        w, h = im.size
    k = min(1.0, CROP_MAX / max(w, h))
    return round(w * k * h * k / 784)


def replay(d, strokes):
    meta = json.loads((d / "meta.json").read_text("utf-8"))
    if meta.get("kind") in ("reply", "scan") or "groups" not in meta:
        return None
    old = (d / "message.txt").read_text("utf-8")
    label, book = old_parts(old)
    paths = {"crop": str(d / "crop.jpg")}
    sheet = sheet_tokens(meta, strokes)
    if sheet is not None:
        paths["sheet"] = str(d / "sheet.png")
    new = prompt.build_message(meta, paths, label, book, meta.get("id") or d.name, bool(meta.get("snapshot")))
    old_imgs = [p for p in d.iterdir() if p.suffix.lower() in IMG_EXT]
    new_imgs = referenced_images(new, d)
    return {
        "old_chars": len(old), "new_chars": len(new),
        "old_images": len(old_imgs), "new_images": len(new_imgs) + (sheet is not None),
        "old_tokens": len(old) + sum(image_tokens(p) for p in old_imgs),
        "new_tokens": len(new) + sum(now_tokens(p) for p in new_imgs) + (sheet or 0),
        "sheet": sheet,
    }


def med(rows, k):
    return round(statistics.median(r[k] for r in rows))


def main():
    ap = argparse.ArgumentParser(description="按现在的规则重拼真实投递，比较字数和 token")
    ap.add_argument("--data", default=str(ROOT / "data"))
    ap.add_argument("--since", default="", help="只看这个日期（YYYYMMDD）之后的投递")
    ap.add_argument("--n", type=int, default=60, help="最多看最近的多少条")
    a = ap.parse_args()
    subs = sorted(p for p in (Path(a.data) / "submissions").iterdir()
                  if (p / "meta.json").is_file() and (p / "message.txt").is_file() and p.name[:8] >= a.since)
    rows, skipped = [], 0
    strokes = stroke_index(Path(a.data))
    for d in reversed(subs):
        try:
            r = replay(d, strokes)
        except (OSError, ValueError, KeyError):  # 早期格式的投递（分组里没有时间等）
            skipped += 1
            continue
        if r:
            rows.append(r)
        if len(rows) >= a.n:
            break
    if not rows:
        print("没有可重拼的投递。")
        return
    print(f"重拼最近 {len(rows)} 条页面投递（中位数；另有 {skipped} 条早期格式的跳过）：")
    print(f"  文字：{med(rows, 'old_chars')} → {med(rows, 'new_chars')} 字")
    print(f"  图：{med(rows, 'old_images')} → {med(rows, 'new_images')} 张")
    print(f"  token（估计）：{med(rows, 'old_tokens')} → {med(rows, 'new_tokens')}，"
          f"范围 {min(r['new_tokens'] for r in rows)}–{max(r['new_tokens'] for r in rows)}")
    p = prompt.protocol()
    print(f"  另：系统提示里的固定说明 {len(p)} 字，每个对话一次（走缓存），不随投递累积。")


if __name__ == "__main__":
    main()

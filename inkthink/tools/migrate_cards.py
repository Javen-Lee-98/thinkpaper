"""把重构前的长回答迁成「圈号加卡片」（阶段 B 的迁移，细则见 docs/plans/2026-11-12-refactor-plan.md
「迁移旧数据的细则」，产品上以 docs/PRODUCT.md 第 3 节为准）。

用法（在 inkthink\\ 下）：
    .venv\\Scripts\\python.exe tools\\migrate_cards.py --data data                 试跑：只出报告，什么都不写
    .venv\\Scripts\\python.exe tools\\migrate_cards.py --data data --apply         真的迁（服务要停着）
其他参数：
    --originals <文件夹>  --apply 时改动前的原件按相同的相对路径存到这里；必须在数据文件夹外面，
                          默认是数据文件夹旁边的 data-originals-<日期时间>
    --report <文件>       报告另存成文本（UTF-8），同时照样打印到屏幕
    --port <端口>         正式服务的端口；不写就照 launch.py 的办法（config.json 里的 port，没有就是 8765），另外也查 8765

做什么（以 data/notebooks 下每一本为单位，活着的本子和 _deleted 开头的已删本子都迁）：
- 页面文件（page-NNNN.json，以及插入的空白纸 blank-xxxxxxxx.json）里每一条旧的长回答（type 'write'，
  带着 lay、hit、fold、shut、notes、revises、revisedBy、dock、home、placed 这些旧字段，或者没有圈号位置 at）
  变成一个圈号加一张卡片：{id, type:'write', t, req, text, q, on, n, at, seen, older, adopted, erasedAt, dismissed}。
  - 被改写过的一串（revises / revisedBy）只留最新那一版，旧版并进它的 older（新的在前）；
    画在回答文字上的修改建议（带 ans 的 suggest）也并进那一张卡片的 older，页面上去掉。
  - 圈号位置：所指的笔迹（红笔问题）还在的，放在它最后一行的右边，和平板 app.js 的 answerSpot 同一个算法
    （改写过的，「所指的」是最新一版的 on 加上被它改写的上一版上写的批注）；
    红笔问题已经擦掉的、本来没指着哪句的，放在那段回答原来在纸上的左上角（一串改写取最上面那一版）；
    原来收在回答栏（dock）、纸上没有位置的，从页面右上角往下依次排（纸加宽或往上加长过的页，纸角离字很远，
    改从字迹范围的右上角旁边往下排）。压着字或别的圈号时照平板的办法往旁边让。
  - 编号：每页从 1 起，按 Claude 回的先后（一串改写按第一版到达的时间）；页面上已经有新格式的圈号时接在它们后面。
  - 写在回答上的批注笔迹本来就是普通笔迹，删掉回答上的 notes、shut 以后，以前随收起的回答藏着的就重新露出来，留在原处。
  - on（所答的笔迹）合起每一版的 on、后来被改写过的那几版上的批注（改写就是在回答它们）、并进来的建议的 on，
    这些红笔照旧算「回答过」；最新一版上的批注不记进去（旧页面里它们下次发送时照样会发出去）。
- judged（以前「文档更新后收起」的旧笔迹和批注）原样留在页面文件里：页面不画、不发给 Claude、没有放回的按钮，
  就是细则说的「不再使用的位置」。短批注和别的标注一个字不动。
- 排队文件（*.pending.json，内容是列表）：Claude 的回复（items）照旧留着，平板打开那一页时按新格式落下；
  以前「对旧批注的判断」（relocate）和「回答上的批注发过了」（notesSent）这两种条目功能已删，去掉；
  排队的长回答上的 revises 去掉。去掉以后文件空了就删掉（和服务取走排队条目时一样）。
- --apply 时：每个要改的页面文件 rev 加一、by 记成 "migrate"（平板手里如果还有迁移前的旧页面，存的时候会被当成冲突
  另存，不会把旧格式写回来）；JSON 的写法和服务存页面、排队文件时一样；先写临时文件再替换。

末尾自己复查一遍：所有页面里不能再有旧字段的长回答（judged 里面除外）、不能再有带 ans 的建议，排队文件里不能再有
relocate / notesSent / revises。复查不过就报错退出（退出码 1）。被拒绝执行（服务在跑、参数不对）退出码 2。
"""
import argparse
import json
import math
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 和平板 static/app.js 一样的常数
PAGE_W, MARGIN_W, SCRATCH_H = 1000, 380, 1414
BADGE_R, BADGE_GAP = 13, 16
MIN_DOC_H = 562.5  # 书页的高度不知道时（不打开 PDF）：按最矮的 16:9 幻灯片算，圈号不会落到纸外
CLASH_GAP_MS = 60_000  # 报告里「露出来的批注和别的笔迹叠在一起」：两笔写的时间隔一分钟以上才算

# more、marks、sheet：卡片上的红字和接在下面的回应（2026-11-14 加的，迁移之后才有），复查时不算旧字段
NEW_KEYS = ("id", "type", "t", "req", "text", "q", "on", "n", "at", "seen", "older", "adopted", "erasedAt", "dismissed",
            "more", "marks", "sheet")
NEED_KEYS = ("id", "type", "t", "text", "on", "n", "at", "seen")
OLD_KEYS = {"lay", "hit", "fold", "shut", "notes", "revises", "revisedBy", "dock", "home", "placed", "placedAt",
            "paths", "notesSentAt", "level", "faded"}
DELETED_RE = re.compile(r"^_deleted-\d{8}-\d{6}-")
PAGE_RE = re.compile(r"^(page-\d{4}|blank-[0-9a-f]{8})\.json$")
PENDING_RE = re.compile(r"^(page-\d{4}|blank-[0-9a-f]{8})\.pending\.json$")


# ------------------------------------------------------------ 和平板一样的几何

def n1(v):
    """保留一位小数（和 JS 的 Math.round(v * 10) / 10 一样，.5 往大里进；整数写成整数，和 JSON.stringify 一样）。"""
    v = math.floor(v * 10 + 0.5) / 10
    return int(v) if v == int(v) else v


def clamp(v, a, b):
    return max(a, min(b, v))


def stroke_box(s):
    xs = [p[0] for p in s["pts"]]
    ys = [p[1] for p in s["pts"]]
    w = s.get("w") or 0
    return [min(xs) - w, min(ys) - w, max(xs) + w, max(ys) + w]


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def stroke_rows(strokes):
    """一组笔迹按行分开（和 app.js 的 strokeRows 一样），从上到下。"""
    ss = [s for s in strokes if s.get("pts")]
    if not ss:
        return []
    box = {id(s): stroke_box(s) for s in ss}
    hs = sorted(box[id(s)][3] - box[id(s)][1] for s in ss)
    ch = max(8, hs[int(len(hs) * 0.75)]) * 1.3

    def cy(s):
        return (box[id(s)][1] + box[id(s)][3]) / 2

    tall = [s for s in ss if box[id(s)][3] - box[id(s)][1] > 1.6 * ch]
    tall_ids = {id(s) for s in tall}
    rows = []
    for s in sorted((x for x in ss if id(x) not in tall_ids), key=cy):
        row = next((r for r in rows if abs(r["sum"] / r["n"] - cy(s)) < 0.6 * ch), None)
        if row:
            row["sum"] += cy(s)
            row["n"] += 1
            row["ss"].append(s)
        else:
            rows.append({"sum": cy(s), "n": 1, "ss": [s]})
    for s in tall:
        if rows:
            best = rows[0]
            for q in rows[1:]:
                if abs(q["sum"] / q["n"] - cy(s)) < abs(best["sum"] / best["n"] - cy(s)):
                    best = q
            best["ss"].append(s)
        else:
            rows.append({"sum": cy(s), "n": 1, "ss": [s]})
    rows.sort(key=lambda r: r["sum"] / r["n"])
    return [r["ss"] for r in rows]


def is_badge(a):
    at = a.get("at") if isinstance(a, dict) and a.get("type") == "write" else None
    return isinstance(at, list) and len(at) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in at)


def badge_box(at, pad=0):
    r = BADGE_R + pad
    return [at[0] - r, at[1] - r, at[0] + r, at[1] + r]


def free(x, y, obs, pad=4):
    R = BADGE_R
    return all(x + R + pad <= o[0] or x - R - pad >= o[2] or y + R + pad <= o[1] or y - R - pad >= o[3] for o in obs)


def spot_right_down(x0, y0, g, obs):
    """从 (x0, y0) 起找不压东西的地方：先往右，到了纸边再往下一行（和 app.js 的 answerSpot 一样）。"""
    R = BADGE_R
    max_x = g["TW"] - R - 6
    top = g["Y0"] + R + 4
    bottom = max(top, g["pageH"] - R - 4)
    for k in range(40):
        y = clamp(y0 + k * 32, top, bottom)
        x = min(x0, max_x)
        while x <= max_x:
            if free(x, y, obs):
                return [n1(x), n1(y)]
            x += 10
        if y >= bottom:
            break
    return [n1(min(x0, max_x)), n1(clamp(y0, top, bottom))]


def spot_top_right(g, obs, ink=None):
    """页面右上角：贴着纸的右边从上往下依次排（一个挨一个）；右边一路都被占着，再往左挪一点（最多 200）试。
    ink 是这一页看得见的字迹的外框，只在纸加大过的页上给（用户 2026-11-13 定）：这种纸的角离字很远，
    圈号改放在字迹外框的右上角旁边，同样从上往下排。"""
    R = BADGE_R
    x0 = g["W"] - R - 8
    top = g["Y0"] + R + 8
    bottom = max(top, g["pageH"] - R - 4)
    if ink:
        x0 = min(x0, ink[2] + BADGE_GAP + R)
        top = clamp(ink[1] + R, top, bottom)
    for dx in range(0, 210, 10):
        y = top
        while y <= bottom:
            if free(x0 - dx, y, obs):
                return [n1(x0 - dx), n1(y)]
            y += 2 * R + 8
    return [n1(x0), n1(top)]


# ------------------------------------------------------------ 本子、页

def nb_kind(dirname):
    name = DELETED_RE.sub("", dirname)
    if name in ("scratch", "board"):
        return name
    if name.startswith("pad-"):
        return "pad"
    if name.startswith("book-"):
        return "book"
    return "other"


def read_json(f, default=None):
    try:
        return json.loads(f.read_text("utf-8"))
    except (OSError, ValueError):
        return default


def nb_title(nbdir, data):
    kind, name = nb_kind(nbdir.name), DELETED_RE.sub("", nbdir.name)
    if kind == "book":
        meta = read_json(nbdir / "meta.json", {}) or {}
        return Path(meta["book"]).stem if meta.get("book") else name
    if kind == "pad":
        pads = read_json(data / "notebooks" / "pads.json", []) or []
        pid = name[4:]
        return next((p.get("title") for p in pads if isinstance(p, dict) and p.get("id") == pid), "（名字查不到的本子）")
    return {"scratch": "草稿本", "board": "Claude 推送"}.get(kind, name)


def key_of(fname):
    stem = fname.split(".")[0]
    return ("p" + stem[5:]) if stem.startswith("page-") else ("b" + stem[6:])


def page_place(nbdir, key):
    """（排序用的序号, 「第 N 页」, 页序里的那一项）。"""
    lay = read_json(nbdir / "layout.json")
    if isinstance(lay, dict):
        for i, e in enumerate(lay.get("pages") or []):
            if e.get("key") == key:
                return i, f"第 {i + 1} 页", e
        for h in lay.get("hidden") or []:
            e = h.get("entry") or {}
            if e.get("key") == key:
                return 10 ** 6, "删掉的页（抽屉里能恢复）", e
        return 10 ** 7, "不在页序里的页", {"key": key}
    if key.startswith("p"):
        i = int(key[1:])
        e = {"key": key}
        if nb_kind(nbdir.name) == "book":
            e["pdf"] = i
        elif nb_kind(nbdir.name) == "board":
            e["board"] = i
        return i, f"第 {i + 1} 页", e
    return 10 ** 7, "不在页序里的页", {"key": key}


def page_geom(nbdir, entry, page, data):
    """一页的纸：正文宽 W、连页边的宽 TW、上边 Y0、高 pageH（和 app.js 的 geomOf 一样，书页的底图高度不知道时见 MIN_DOC_H）。"""
    kind = nb_kind(nbdir.name)
    W = PAGE_W + (page.get("xw") or 0)
    base = None
    if "board" in entry:
        idx = read_json(data / "notebooks" / "board" / "index.json", {}) or {}
        try:
            base = float(idx["pages"][entry["board"]]["h"])
        except (KeyError, IndexError, TypeError, ValueError):
            base = None
    elif "pdf" not in entry:  # 空白纸（草稿本、自己建的本子、书里插的空白页）：和 server.blank_height 一样
        paper = (read_json(nbdir / "settings.json", {}) or {}).get("paper", "portrait")
        base = SCRATCH_H if (entry.get("orient") or paper) != "landscape" else round(PAGE_W / 1.414, 1)
    if base and (page.get("rot") or 0) % 180:
        base = PAGE_W * PAGE_W / base
    strokes = [s for s in page.get("strokes") or [] if s.get("pts") and not s.get("erasedAt")]
    margin = (kind in ("scratch", "pad") or page.get("mg") is True
              or any(stroke_box(s)[2] > W for s in strokes)
              or any((a.get("lay") or {}).get("x", -1e9) >= W - 1 for a in page.get("ai") or [] if a.get("type") != "write")
              or any(is_badge(a) and not a.get("erasedAt") and a["at"][0] + BADGE_R > W for a in page.get("ai") or []))
    h = page.get("h") or 0
    if base:
        page_h = max(base, h)
    else:
        bottom = max([stroke_box(s)[3] for s in strokes] + [a["hit"][3] for a in page.get("ai") or []
                                                           if isinstance(a.get("hit"), list) and len(a["hit"]) == 4] + [0])
        page_h = max(h, bottom + 40, MIN_DOC_H)
    return {"W": W, "TW": W + (MARGIN_W if margin else 0), "Y0": -(page.get("oy") or 0), "pageH": page_h,
            "known": bool(base)}


# ------------------------------------------------------------ 旧的长回答 → 圈号加卡片

def is_old_write(a):
    return isinstance(a, dict) and a.get("type") == "write" and (bool(OLD_KEYS & set(a)) or not is_badge(a))


def snippet(text, k=20):
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    return s[:k] + ("…" if len(s) > k else "")


def chains_of(writes):
    """按 revises / revisedBy 把改写过的连成串，每串从旧到新。"""
    by = {a["id"]: a for a in writes if a.get("id")}
    succ = {}
    for a in writes:
        nxt = a.get("revisedBy")
        if nxt in by and nxt != a.get("id"):
            succ[a["id"]] = nxt
    for a in writes:
        prv = a.get("revises")
        if prv in by and prv != a.get("id"):
            succ.setdefault(prv, a["id"])
    has_pred = set(succ.values())
    out, seen = [], set()
    for a in writes:
        if a.get("id") in has_pred or id(a) in seen:
            continue
        ch, cur = [], a
        while cur is not None and id(cur) not in seen:
            seen.add(id(cur))
            ch.append(cur)
            cur = by.get(succ.get(cur.get("id")))
        out.append(ch)
    for a in writes:  # 首尾相接成环的（不该有）：各自成一串
        if id(a) not in seen:
            seen.add(id(a))
            out.append([a])
    return out


def hidden_ids(page):
    """以前随收起的回答藏着的批注笔迹（和旧 pages.hidden_ids 一样）。"""
    out = set()
    for a in page.get("ai") or []:
        if a.get("type") == "write" and a.get("shut") and isinstance(a.get("notes"), list):
            out.update(a["notes"])
    return out


def answer_box(a):
    L = a["lay"]
    return [L["x"] - 28, L["y"] - 8, L["x"] + L["w"] + 8, L["y"] + L["h"] + 6]


def center_in(q, b):
    cx, cy = (q[0] + q[2]) / 2, (q[1] + q[3]) / 2
    return b[0] <= cx <= b[2] and b[1] <= cy <= b[3]


def visible_notes(a, page, hid):
    """展开着的旧回答上看得见的批注笔迹（和旧 app.js 的 noteIdsOf 一样；只为报告数一数，迁移不动它们）。"""
    if not a.get("lay") or a.get("shut"):
        return []
    b, on, carried = answer_box(a), set(a.get("on") or []), set(a.get("notes") or [])
    since = max(a.get("t") or 0, a.get("placedAt") or 0)
    return [s["id"] for s in page.get("strokes") or [] if s.get("pts") and not s.get("erasedAt") and s.get("id") not in hid
            and ((s.get("t0") or 0) > since or s.get("id") in carried) and s.get("id") not in on
            and center_in(stroke_box(s), b)]


def overlap(a, b, frac=0.25):
    w, h = min(a[2], b[2]) - max(a[0], b[0]), min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return False
    small = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return small > 0 and w * h >= frac * small


def older_of(chain, sugs, newest_q):
    out = []
    for v in chain[:-1]:
        text = str(v.get("text") or "").strip()
        if not text:
            continue
        if v.get("q") and v.get("q") != newest_q:
            text = "问：" + str(v["q"]) + "\n" + text
        if v.get("adopted"):
            text += "\n（这一版你采纳过 ★）"
        out.append({"text": text, "t": v.get("t") or 0})
    for s in sugs:
        text = "修改建议：" + str(s.get("text") or "").strip()
        if s.get("verdict") == "yes":
            text += "（你同意了这条）"
        elif s.get("verdict") == "no":
            text += "（你没同意这条）"
        res = s.get("result")
        if isinstance(res, dict):
            text += "（改成了）" if res.get("ok") else "（没改成" + ("：" + str(res.get("text")) if res.get("text") else "") + "）"
        out.append({"text": text, "t": s.get("t") or 0})
    out.sort(key=lambda o: -o["t"])  # 新的在前（和卡片里「之前的版本」的顺序一样）
    return out


def migrate_page(page, nbdir, entry, data):
    """迁一页。返回（新页面或 None（不用改）, 这一页的报告条目）。page 不改动。"""
    ai = page.get("ai") or []
    rec = {"answers": [], "judged_strokes": 0, "judged_ai": 0, "reshown_ai": 0, "warnings": [], "old_writes": 0}
    for r in page.get("judged") or []:
        if isinstance(r, dict) and not r.get("restored"):
            fo = r.get("folded") or {}
            rec["judged_strokes"] += len(fo.get("strokes") or [])
            rec["judged_ai"] += len(fo.get("ai") or [])
    old = [a for a in ai if is_old_write(a)]
    stray = [a for a in ai if isinstance(a, dict) and a.get("ans") and a.get("type") != "write"]
    if not old and not stray:
        return None, rec
    rec["old_writes"] = len(old)

    new = json.loads(json.dumps(page, ensure_ascii=False))  # 深拷贝，原来的不动
    nai = new.get("ai") or []
    nold = [a for a in nai if is_old_write(a)]
    hid = hidden_ids(new)
    live_before = {s["id"] for s in new.get("strokes") or [] if s.get("pts") and not s.get("erasedAt") and s.get("id") not in hid}
    live_after = {s["id"] for s in new.get("strokes") or [] if s.get("pts") and not s.get("erasedAt")}
    st_by = {s["id"]: s for s in new.get("strokes") or [] if s.get("pts")}

    chains = chains_of(nold)
    chain_of = {}
    for ch in chains:
        for v in ch:
            chain_of[v.get("id")] = ch
    # 画在回答文字上的修改建议：跟着那一串
    sugs = {id(ch): [] for ch in chains}
    drop = set()
    for a in nai:
        if isinstance(a, dict) and a.get("ans") and a.get("type") != "write":
            ch = chain_of.get(a["ans"])
            if ch is not None:
                sugs[id(ch)].append(a)
                drop.add(id(a))
            else:
                del a["ans"]  # 指着的回答已经不在了：当普通建议留着
                rec["warnings"].append(f"一条修改建议指着的回答不在这一页上，去掉了它的 ans，当普通建议留着：「{snippet(a.get('text'))}」")

    # 编号：已有新格式圈号的接在后面；按 Claude 回的先后（一串按第一版的时间）
    base_n = max([a.get("n") for a in nai if is_badge(a) and not is_old_write(a) and isinstance(a.get("n"), int)] + [0])
    pos = {id(a): i for i, a in enumerate(nai)}
    order = sorted(range(len(chains)), key=lambda k: (chains[k][0].get("t") or 0, pos[id(chains[k][0])]))

    # 迁完以后纸上占着的地方：看得见的笔迹（连重新露出来的）、别的蓝字、已有的圈号
    obs = [stroke_box(s) for s in new.get("strokes") or [] if s.get("pts") and not s.get("erasedAt")]
    content = list(obs)  # 这一页看得见的内容：字迹，加上下面的短批注和图（不算圈号）
    for a in nai:
        if not isinstance(a, dict) or a.get("erasedAt") or a.get("dismissed") or id(a) in drop or is_old_write(a):
            continue
        if is_badge(a):
            obs.append(badge_box(a["at"]))
        elif a.get("type") != "write" and isinstance(a.get("hit"), list) and len(a["hit"]) == 4:
            obs.append(a["hit"])
            content.append(a["hit"])
    ink_box = union(content) if content else None  # 内容的外框：纸加大过的页，只在回答栏里的回答放在它的右上角旁边
    tmp = dict(new, ai=[a for a in nai if not is_old_write(a) and id(a) not in drop])
    g = page_geom(nbdir, entry, tmp, data)

    replace = {}
    for k, ci in enumerate(order):
        ch = chains[ci]
        newest = ch[-1]
        q = next((v.get("q") for v in reversed(ch) if v.get("q")), None)
        # 所答的笔迹：每一版的 on，后来被改写过的那几版上写的批注（改写就是在回答它们），画在回答上的建议的 on。
        # 都记进来，平板就照旧把它们当「回答过」，下次「检查」不会把这些红笔当新问题再交一遍
        on = []
        for v in list(reversed(ch)) + sugs[id(ch)]:
            ids = list(v.get("on") or [])
            if any(v is w for w in ch[:-1]) and isinstance(v.get("notes"), list):
                ids += v["notes"]
            for x in ids:
                if x not in on:
                    on.append(x)
        # 圈号放哪：从最新一版往前找它答的笔迹——这一版的 on，加上它改写的上一版上写的批注（改写答的就是那些批注；
        # 一句红笔问题常常一半记在 on 里、一半是上一版上的批注），还有看得见的就放在它们最后一行的右边
        target = None
        for j in range(len(ch) - 1, -1, -1):
            ids = list(ch[j].get("on") or [])
            if j and isinstance(ch[j - 1].get("notes"), list):
                ids += ch[j - 1]["notes"]
            ss, seen_ids = [], set()
            for x in ids:
                if x in st_by and not st_by[x].get("erasedAt") and x not in seen_ids:
                    seen_ids.add(x)
                    ss.append(st_by[x])
            if ss:
                target = ss
                break
        if target:
            row = union([stroke_box(s) for s in stroke_rows(target)[-1]])
            start = [row[2] + BADGE_GAP + BADGE_R, (row[1] + row[3]) / 2]
            at = spot_right_down(start[0], start[1], g, obs)
            where = "红笔问题旁边" if any(s.get("c") == "r" for s in target) else "所指的笔迹旁边（黑笔）"
        else:
            lays = [v["lay"] for v in ch if isinstance(v.get("lay"), dict) and not v.get("dock")]
            if lays:
                L = min(lays, key=lambda l: l.get("y", 0))
                start = [L["x"] + BADGE_R, L["y"] + BADGE_R]
                at = spot_right_down(start[0], start[1], g, obs)
                where = "原来纸上的左上角"
            else:
                start = [g["W"] - BADGE_R - 8, g["Y0"] + BADGE_R + 8]
                at = spot_top_right(g, obs)
                where = "页面右上角"
                if ink_box and (new.get("xw") or new.get("oy")):  # 纸加宽或往上加长过：放在字迹范围的右上角
                    start = [min(start[0], ink_box[2] + BADGE_GAP + BADGE_R), max(start[1], ink_box[1] + BADGE_R)]
                    at = spot_top_right(g, obs, ink_box)
                    where = "字迹范围的右上角（纸加大过）"
        if not newest.get("erasedAt"):
            obs.append(badge_box(at))
        on_paper = any(isinstance(v.get("lay"), dict) or isinstance(v.get("home"), dict) for v in ch)
        item = {"id": newest.get("id"), "type": "write", "t": newest.get("t")}
        if newest.get("req") is not None:
            item["req"] = newest["req"]
        item["text"] = str(newest.get("text") or "")
        if q:
            item["q"] = q
        item["on"] = on
        item["n"] = base_n + k + 1
        item["at"] = at
        item["seen"] = on_paper  # 在纸上展开过、收起过的看过；只进过回答栏、没有点开记录的算没看过（实心）
        older = older_of(ch, sugs[id(ch)], q)
        if older:
            item["older"] = older
        for key in ("adopted", "erasedAt", "dismissed"):
            if newest.get(key):
                item[key] = newest[key]
        replace[id(newest)] = item
        # 报告
        reshown, clash = [], 0
        for v in ch:  # 每一版上藏着的批注各自和别的笔迹（连同别的版上露出来的）比，看叠不叠
            if not (v.get("shut") and isinstance(v.get("notes"), list)):
                continue
            mine = [x for x in v["notes"] if x in st_by and not st_by[x].get("erasedAt")]
            own = set(mine)
            others = [st_by[x] for x in live_after if x not in own and x in st_by]
            # 同一个字常常一半被当成批注藏起来、一半留在纸上：前后一分钟内写的不算「叠在别的字上」，只数隔了一阵又写在那里的
            clash += sum(1 for x in mine if any(abs((st_by[x].get("t0") or 0) - (o.get("t0") or 0)) > CLASH_GAP_MS
                                                and overlap(stroke_box(st_by[x]), stroke_box(o)) for o in others))
            reshown += mine
        shown = [x for v in ch if not v.get("shut") for x in visible_notes(v, page, hid)]
        rec["answers"].append({
            "n": item["n"], "snippet": snippet(item["text"]), "where": where, "at": at,
            "moved": [n1(at[0] - start[0]), n1(at[1] - start[1])], "versions": len(ch) - 1,
            "suggestions": len(sugs[id(ch)]), "reshown": len(reshown), "clash": clash, "shown": len(set(shown)),
            "seen": item["seen"], "dock": any(v.get("dock") for v in ch), "erased": bool(newest.get("erasedAt")),
            "id": item["id"], "_reshown": reshown})

    # 换掉：最新那一版的位置放新的一条，旧版和并进去的建议去掉
    gone_ids = {id(v) for ch in chains for v in ch[:-1]} | drop
    out = []
    for a in nai:
        if id(a) in gone_ids:
            continue
        out.append(replace.get(id(a), a))
    new["ai"] = out
    # 重新露出来的红笔里，没有哪一条标注指着的（平板据此当作「还没回答的红笔问题」，下次「检查」会交给 Claude）
    answered = {x for a in out if isinstance(a, dict) and not a.get("dismissed") for x in (a.get("on") or []) + (a.get("on2") or [])}
    for r in rec["answers"]:
        r["open_red"] = sum(1 for x in r.pop("_reshown") if st_by[x].get("c") == "r" and x not in answered)
    # 指着重新露出来的笔迹、以前因此不画的 Claude 的标注，现在也会画出来
    for a in out:
        if not isinstance(a, dict) or a.get("type") == "write" or a.get("erasedAt"):
            continue
        refs = [x for x in (a.get("on") or []) + (a.get("on2") or []) if isinstance(x, str)]
        if refs and not any(x in live_before for x in refs) and any(x in live_after for x in refs):
            rec["reshown_ai"] += 1
    new["rev"] = int(new.get("rev") or 0) + 1
    new["by"] = "migrate"
    return new, rec


def migrate_pending(items):
    """排队文件。返回（新列表或 None（不用改）, 报告条目）。"""
    rec = {"replies": 0, "writes": 0, "vsent": 0, "relocate": 0, "notesSent": 0, "revises": 0, "other": 0}
    if not isinstance(items, list):
        rec["other"] += 1
        return None, rec
    out, changed = [], False
    for e in items:
        if not isinstance(e, dict):
            rec["other"] += 1
            out.append(e)
            continue
        if "relocate" in e:
            rec["relocate"] += 1
            changed = True
            continue
        if "notesSent" in e:
            rec["notesSent"] += 1
            changed = True
            continue
        if isinstance(e.get("vsent"), list):
            rec["vsent"] += 1
        elif isinstance(e.get("items"), list):
            rec["replies"] += 1
            e = json.loads(json.dumps(e, ensure_ascii=False))
            for it in e["items"]:
                if isinstance(it, dict) and it.get("type") == "write":
                    rec["writes"] += 1
                    if "revises" in it:
                        del it["revises"]
                        rec["revises"] += 1
                        changed = True
        else:
            rec["other"] += 1
        out.append(e)
    return (out if changed else None), rec


# ------------------------------------------------------------ 复查

def check_page(page):
    """迁完的一页还有没有旧东西（judged 里面不查）。返回问题列表。"""
    bad = []
    for a in page.get("ai") or []:
        if not isinstance(a, dict):
            continue
        if a.get("ans") and a.get("type") != "write":
            bad.append(f"还有画在回答上的修改建议 {a.get('id')}")
        if a.get("type") != "write":
            continue
        extra = sorted(set(a) - set(NEW_KEYS))
        if extra:
            bad.append(f"长回答 {a.get('id')} 还有旧字段 {extra}")
        miss = [k for k in NEED_KEYS if k not in a]
        if miss:
            bad.append(f"长回答 {a.get('id')} 缺 {miss}")
        if not is_badge(a):
            bad.append(f"长回答 {a.get('id')} 没有圈号位置")
    return bad


def check_pending(items):
    bad = []
    for e in items if isinstance(items, list) else []:
        if isinstance(e, dict) and ("relocate" in e or "notesSent" in e):
            bad.append("还有以前「对旧批注的判断」或「回答上的批注发过了」的条目")
        for it in (e.get("items") if isinstance(e, dict) and isinstance(e.get("items"), list) else []):
            if isinstance(it, dict) and "revises" in it:
                bad.append("排队的回复里还有 revises")
    return bad


# ------------------------------------------------------------ 写文件（和服务一样的写法）

def page_text(page):
    return json.dumps(page, ensure_ascii=False, separators=(",", ":"))  # server.py 的 save_page


def pending_text(items):
    return json.dumps(items, ensure_ascii=False)  # server.py 的 add_pending


def write_atomic(f, text):
    tmp = f.with_suffix(".tmp")
    tmp.write_bytes(text.encode("utf-8"))
    os.replace(tmp, f)


# ------------------------------------------------------------ 服务在不在跑（照 launch.py）

def service_ports(port=None):
    if port:
        return [int(port)]
    ports = [8765]
    try:
        sys.path.insert(0, str(ROOT))
        import launch  # noqa: E402
        p = launch.port([])
        if p not in ports:
            ports.insert(0, p)
    except Exception:  # noqa: BLE001 - 读不到配置就只查默认端口
        pass
    return ports


def service_alive(port):
    sys.path.insert(0, str(ROOT))
    import launch  # noqa: E402
    return launch.alive(port)


# ------------------------------------------------------------ 主流程

def scan(data):
    """读出要处理的东西：[(本子文件夹, [页面文件], [排队文件])]，活着的在前、已删的在后。"""
    nbroot = data / "notebooks"
    out = []
    for d in sorted((p for p in nbroot.iterdir() if p.is_dir()), key=lambda p: (p.name.startswith("_deleted"), p.name)):
        files = sorted(f for f in d.iterdir() if f.is_file())
        out.append((d, [f for f in files if PAGE_RE.match(f.name)], [f for f in files if PENDING_RE.match(f.name)]))
    return out


def run(data, apply=False, originals=None, port=None, now=None):
    """迁一遍。返回（退出码, 报告文字）。"""
    data = Path(data).resolve()
    now = now or datetime.now()
    if not (data / "notebooks").is_dir():
        return 2, f"数据文件夹里没有 notebooks：{data}"
    if apply:
        originals = Path(originals).resolve() if originals else data.parent / f"data-originals-{now:%Y%m%d-%H%M%S}"
        if originals == data or data in originals.parents:
            return 2, f"--originals 必须在数据文件夹外面：{originals}"
        for p in service_ports(port):
            if service_alive(p):
                return 2, (f"草稿纸服务正在跑（端口 {p}）。迁移要在服务停着时做：平板上的页面会和迁移同时改同一个文件。"
                           "请先停服务（/bridge/stop），再加 --apply 跑一次。什么都没写。")

    plans = []  # (类别, 文件, 新内容或 None（删掉）, 报告)
    report_nbs = []
    problems = []
    for nbdir, page_files, pend_files in scan(data):
        deleted = nbdir.name.startswith("_deleted")
        nb_rep = {"dir": nbdir.name, "title": nb_title(nbdir, data), "deleted": deleted, "pages": [], "pending": []}
        for f in page_files:
            page = read_json(f)
            key = key_of(f.name)
            idx, label, entry = page_place(nbdir, key)
            if not isinstance(page, dict):
                nb_rep["pages"].append({"idx": idx, "label": label, "file": f.name, "error": "读不出来（不是 JSON），跳过"})
                continue
            new, rec = migrate_page(page, nbdir, entry, data)
            rec.update(idx=idx, label=label, file=f.name, changed=new is not None)
            if new is not None or rec["judged_strokes"] or rec["judged_ai"]:
                nb_rep["pages"].append(rec)
            final = new if new is not None else page
            problems += [f"{nbdir.name}/{f.name}：{p}" for p in check_page(final)]
            if new is not None:
                plans.append(("page", f, page_text(new), rec))
        for f in pend_files:
            items = read_json(f)
            new, rec = migrate_pending(items)
            idx, label, _ = page_place(nbdir, key_of(f.name))
            rec.update(idx=idx, label=label, file=f.name, changed=new is not None, delete=new is not None and not new)
            nb_rep["pending"].append(rec)
            problems += [f"{nbdir.name}/{f.name}：{p}" for p in check_pending(new if new is not None else items)]
            if new is not None:
                plans.append(("pending", f, pending_text(new) if new else None, rec))
        nb_rep["pages"].sort(key=lambda r: (r["idx"], r["file"]))
        nb_rep["pending"].sort(key=lambda r: (r["idx"], r["file"]))
        if nb_rep["pages"] or nb_rep["pending"]:
            report_nbs.append(nb_rep)

    lines = [("草稿纸旧数据迁移：" + ("正式迁（--apply）" if apply else "试跑（什么都没写）")),
             f"数据文件夹：{data}", f"时间：{now:%Y-%m-%d %H:%M:%S}", ""]
    if problems:
        lines += ["复查没过（迁完的结果里还有旧东西），什么都没写：", *("  " + p for p in problems)]
        return 1, "\n".join(lines)
    lines += render(report_nbs, plans)

    if apply and plans:
        written = []
        for kind, f, text, _ in plans:
            dst = originals / f.relative_to(data)
            if dst.exists():
                return 1, "\n".join(lines + ["", f"原件的位置已经有文件了，停下：{dst}（已经改了 {len(written)} 个文件）"])
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dst)
            if text is None:
                f.unlink()
            else:
                write_atomic(f, text)
            written.append(f)
        # 写完再从磁盘读一遍复查
        again = []
        for nbdir, page_files, pend_files in scan(data):
            for f in page_files:
                p = read_json(f)
                again += [f"{nbdir.name}/{f.name}：{x}" for x in (check_page(p) if isinstance(p, dict) else [])]
            for f in pend_files:
                again += [f"{nbdir.name}/{f.name}：{x}" for x in check_pending(read_json(f))]
        lines += ["", f"已改 {sum(1 for p in plans if p[2] is not None)} 个文件、删 {sum(1 for p in plans if p[2] is None)} 个排队文件；"
                  f"原件存在 {originals}"]
        if again:
            lines += ["写完复查没过：", *("  " + p for p in again)]
            return 1, "\n".join(lines)
        lines.append("写完从磁盘读回来复查：页面里没有旧字段的长回答、没有画在回答上的建议，排队文件里没有旧条目。")
    elif apply:
        lines += ["", "没有要迁的，什么都没写。"]
    else:
        lines += ["", "复查：迁完的结果里没有旧字段的长回答、没有画在回答上的建议，排队文件里没有旧条目。"]
    return 0, "\n".join(lines)


def render(nbs, plans):
    lines = []
    if not plans:
        lines.append("没有要迁的：所有页面的长回答都已经是圈号加卡片，排队文件里也没有旧条目。")
    tot = {False: dict(nbs=0, pages=0, old=0, badges=0, pend_mod=0, pend_del=0, judged_pages=0),
           True: dict(nbs=0, pages=0, old=0, badges=0, pend_mod=0, pend_del=0, judged_pages=0)}
    for deleted in (False, True):
        group = [nb for nb in nbs if nb["deleted"] == deleted]
        if not group:
            continue
        lines += ["", "== 已删的本子（_deleted 开头的文件夹） ==" if deleted else "== 活着的本子 =="]
        for nb in group:
            t = tot[deleted]
            if any(p.get("changed") for p in nb["pages"]) or any(p.get("changed") for p in nb["pending"]):
                t["nbs"] += 1
            lines.append(f"《{nb['title']}》（{nb['dir']}）")
            for p in nb["pages"]:
                head = f"  {p['label']}（{p['file']}）："
                if p.get("error"):
                    lines.append(head + p["error"])
                    continue
                parts = []
                if p["changed"]:
                    t["pages"] += 1
                    t["old"] += p["old_writes"]
                    t["badges"] += len(p["answers"])
                    parts.append(f"旧的长回答 {p['old_writes']} 条 → 圈号 {len(p['answers'])} 个")
                else:
                    parts.append("没有旧的长回答，文件不用改")
                if p["judged_strokes"] or p["judged_ai"]:
                    t["judged_pages"] += 1
                    parts.append(f"以前收起的旧笔迹 {p['judged_strokes']} 笔、收起的批注 {p['judged_ai']} 条照旧不显示（留在 judged 里）")
                lines.append(head + "；".join(parts))
                for a in p["answers"]:
                    s = f"    圈号 {a['n']}「{a['snippet']}」：{a['where']}（{a['at'][0]:g}, {a['at'][1]:g}）"
                    if a["moved"] != [0, 0]:
                        s += f"，为了不压东西挪了（{a['moved'][0]:g}, {a['moved'][1]:g}）"
                    s += "；" + ("空心（看过）" if a["seen"] else "实心（只在回答栏里、没有看过的记录）")
                    if a["versions"]:
                        s += f"；并进 {a['versions']} 个旧版"
                    if a["suggestions"]:
                        s += f"；并进画在回答上的修改建议 {a['suggestions']} 条"
                    if a["reshown"]:
                        s += f"；以前藏着的批注笔迹 {a['reshown']} 笔重新露出来"
                        if a["clash"]:
                            s += f"（其中 {a['clash']} 笔和后来写在那里的别的笔迹叠在一起）"
                        if a.get("open_red"):
                            s += f"，其中红笔 {a['open_red']} 笔没有回答指着，下次「检查」会当红笔问题交给 Claude"
                    if a["shown"]:
                        s += f"；回答上本来看得见的批注笔迹 {a['shown']} 笔照旧"
                    if a["erased"]:
                        s += "；这条以前被橡皮擦掉了，照旧不画"
                    lines.append(s)
                if p.get("reshown_ai"):
                    lines.append(f"    另有 {p['reshown_ai']} 条 Claude 的批注、符号指着重新露出来的笔迹，以前不画，迁完会画出来")
                for w in p.get("warnings") or []:
                    lines.append("    注意：" + w)
            for q in nb["pending"]:
                desc = []
                if q["replies"]:
                    desc.append(f"Claude 的回复 {q['replies']} 份（其中长回答 {q['writes']} 条，格式没变，打开那一页时落成新圈号）")
                if q["vsent"]:
                    desc.append(f"✓× 已发的记录 {q['vsent']} 条（照旧）")
                if q["relocate"]:
                    desc.append(f"以前「对旧批注的判断」{q['relocate']} 条（功能已删，去掉）")
                if q["notesSent"]:
                    desc.append(f"以前「回答上的批注发过了」{q['notesSent']} 条（功能已删，去掉）")
                if q["revises"]:
                    desc.append(f"排队的长回答上的 revises {q['revises']} 处（去掉；新版到了是一个新圈号）")
                if q["other"]:
                    desc.append(f"不认识的条目 {q['other']} 条（不动）")
                act = "文件空了，删掉" if q.get("delete") else ("改写" if q["changed"] else "不动")
                if q["changed"]:
                    t["pend_del" if q.get("delete") else "pend_mod"] += 1
                lines.append(f"  排队文件 {q['file']}（{q['label']}）：" + "；".join(desc or ["空的"]) + f" → {act}")
    lines += ["", "== 合计 =="]
    for deleted in (False, True):
        t = tot[deleted]
        name = "已删的本子" if deleted else "活着的本子"
        lines.append(f"{name}：改 {t['nbs']} 本、{t['pages']} 页，旧的长回答 {t['old']} 条 → 圈号 {t['badges']} 个；"
                     f"排队文件改 {t['pend_mod']} 个、删 {t['pend_del']} 个；"
                     f"带以前收起的旧笔迹的页 {t['judged_pages']} 页（收起的部分照旧不动，其中只有这一样的页文件不用改）")
    return lines


def main(argv=None):
    ap = argparse.ArgumentParser(description="把旧的长回答迁成圈号加卡片（默认只试跑）")
    ap.add_argument("--data", required=True, help="数据文件夹（里面有 notebooks）")
    ap.add_argument("--apply", action="store_true", help="真的写；不加只出报告")
    ap.add_argument("--originals", help="--apply 时原件存到这里（必须在数据文件夹外面）")
    ap.add_argument("--report", help="报告另存成这个文本文件")
    ap.add_argument("--port", type=int, help="正式服务的端口（默认照 launch.py）")
    args = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass
    data = Path(args.data).resolve()
    if args.report:
        rp = Path(args.report).resolve()
        if rp == data or data in rp.parents:
            print(f"--report 不能放在数据文件夹里：{rp}")
            return 2
    code, text = run(data, apply=args.apply, originals=args.originals, port=args.port)
    print(text)
    if args.report:
        Path(args.report).write_text(text + "\n", "utf-8")
    return code


if __name__ == "__main__":
    sys.exit(main())

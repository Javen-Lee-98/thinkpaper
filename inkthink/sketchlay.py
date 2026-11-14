"""示意图排版：Claude 只给结构（节点、连线、分组），这里算出坐标，换成平板认得的形状（shapes），平板按手绘风格画。

分层：沿连线方向按最长路径分层（有环时不算回头的那几条）；同一层里按相邻层的平均位置排顺序，同一组的挨在一起。
四层以内从左往右排，更多层从上往下排；只有一层时排成一行。
"""
import math

FS = 20           # 和平板上示意图的字号一致（app.js 的 SKETCH_FS）
NODE_H = 46
GAP_RANK = 80     # 相邻两层之间
GAP_NODE = 28     # 同一层里相邻两个之间
PAD = 24          # 四周留白
TITLE = 30        # 分组名写在框上方，占的高度
MAX_NODES, MAX_EDGES, MAX_GROUPS, MAX_TEXT = 24, 40, 6, 16


def text_w(s, fs=FS):
    """一行字大约多宽：汉字一个字宽，西文半个多。"""
    return sum(fs if ord(c) > 0x2E80 else fs * 0.56 for c in s)


def _short(s, n):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[:n - 1] + "…"


def clean(obj):
    """{nodes, edges, groups, dir} → (nodes, edges, groups, dir)；没有能画的节点返回 None。
    nodes 每项是字符串或 {id, text, shape: box|round}；edges 的 from/to 可以写节点的 id 或文字。"""
    nodes, ids, by_text = [], set(), {}
    for n in obj.get("nodes") if isinstance(obj.get("nodes"), list) else []:
        if isinstance(n, str):
            n = {"text": n}
        if not isinstance(n, dict) or not isinstance(n.get("text"), str) or not n["text"].strip():
            continue
        nid = str(n.get("id") or n["text"]).strip()[:40]
        if nid in ids:
            continue
        ids.add(nid)
        node = {"id": nid, "text": _short(n["text"], MAX_TEXT)}
        if n.get("shape") == "round":
            node["shape"] = "round"
        nodes.append(node)
        by_text.setdefault(n["text"].strip(), nid)
        if len(nodes) >= MAX_NODES:
            break
    if not nodes:
        return None
    ref = lambda v: (v if v in ids else by_text.get(v)) if isinstance(v, str) else None  # noqa: E731
    edges = []
    for e in obj.get("edges") if isinstance(obj.get("edges"), list) else []:
        if not isinstance(e, dict):
            continue
        a, b = ref(e.get("from")), ref(e.get("to"))
        if not a or not b or a == b:
            continue
        edge = {"from": a, "to": b}
        if isinstance(e.get("text"), str) and e["text"].strip():
            edge["text"] = _short(e["text"], 10)
        if e.get("dash") is True:
            edge["dash"] = True
        edges.append(edge)
        if len(edges) >= MAX_EDGES:
            break
    groups = []
    for g in obj.get("groups") if isinstance(obj.get("groups"), list) else []:
        if not isinstance(g, dict):
            continue
        members = [x for x in (ref(v) for v in g.get("nodes") or []) if x]
        if members:
            group = {"nodes": list(dict.fromkeys(members))}
            if isinstance(g.get("text"), str) and g["text"].strip():
                group["text"] = _short(g["text"], MAX_TEXT)
            groups.append(group)
        if len(groups) >= MAX_GROUPS:
            break
    direction = obj.get("dir") if obj.get("dir") in ("LR", "TB") else None
    return nodes, edges, groups, direction


def _ranks(ids, edges):
    """按最长路径分层；回头的连线（成环的那几条）不算。返回 ({id: 层号}, 回头的连线下标)。"""
    out = {i: [] for i in ids}
    for k, e in enumerate(edges):
        out[e["from"]].append((e["to"], k))
    state, back = {}, set()

    def dfs(u):
        state[u] = 1
        for v, k in out[u]:
            if state.get(v) == 1:
                back.add(k)
            elif not state.get(v):
                dfs(v)
        state[u] = 2

    for i in ids:
        if not state.get(i):
            dfs(i)
    rank = {i: 0 for i in ids}
    for _ in ids:  # 最多走 节点数 遍就稳定了（没有环）
        changed = False
        for k, e in enumerate(edges):
            if k not in back and rank[e["to"]] < rank[e["from"]] + 1:
                rank[e["to"]] = rank[e["from"]] + 1
                changed = True
        if not changed:
            break
    return rank, back


def _order(layers, edges, group_of):
    """同一层里的顺序：上下各扫几遍，按相邻层的平均位置排；同一组的挨在一起。"""
    pos = {n: k for layer in layers for k, n in enumerate(layer)}
    nbr = {}
    for e in edges:
        nbr.setdefault(e["from"], []).append(e["to"])
        nbr.setdefault(e["to"], []).append(e["from"])
    for sweep in range(4):
        seq = range(1, len(layers)) if sweep % 2 == 0 else range(len(layers) - 2, -1, -1)
        for li in seq:
            layer = layers[li]
            bary = {}
            for n in layer:
                ps = [pos[m] for m in nbr.get(n, []) if m in pos and m not in layer]
                bary[n] = sum(ps) / len(ps) if ps else pos[n]
            gmin = {}
            for n in layer:
                g = group_of.get(n)
                if g is not None:
                    gmin[g] = min(gmin.get(g, math.inf), bary[n])
            layer.sort(key=lambda n: (gmin.get(group_of.get(n), bary[n]), group_of.get(n, -1), bary[n]))
            for k, n in enumerate(layer):
                pos[n] = k
    return layers


def _clip(c, w, h, toward, gap=4):
    """从节点中心 c 朝 toward 方向，到框边（再留 gap）的那一点。"""
    dx, dy = toward[0] - c[0], toward[1] - c[1]
    if dx == 0 and dy == 0:
        return list(c)
    t = min((w / 2 + gap) / abs(dx) if dx else math.inf, (h / 2 + gap) / abs(dy) if dy else math.inf)
    return [c[0] + dx * t, c[1] + dy * t]


def layout(nodes, edges, groups, direction=None):
    """返回 {"shapes": [...], "w": ..., "h": ...}，坐标从左上角起。"""
    ids = [n["id"] for n in nodes]
    rank, back = _ranks(ids, edges)
    n_layers = max(rank.values()) + 1
    if direction is None:
        direction = "LR" if 2 <= n_layers <= 4 else "TB"
    group_of = {}
    for gi, g in enumerate(groups):
        for n in g["nodes"]:
            group_of.setdefault(n, gi)
    layers = [[i for i in ids if rank[i] == L] for L in range(n_layers)]
    layers = _order(layers, edges, group_of)

    size = {n["id"]: (max(84.0, text_w(n["text"]) + 30), float(NODE_H)) for n in nodes}
    top = PAD + (TITLE if groups else 0)
    center = {}
    if direction == "LR":
        # 同一列里换组的地方多留出写组名的地方
        gap = lambda layer, k: GAP_NODE + (TITLE if groups and group_of.get(layer[k]) != group_of.get(layer[k + 1]) else 0)  # noqa: E731
        cw = [max(size[n][0] for n in layer) for layer in layers]
        col_h = [sum(size[n][1] for n in layer) + sum(gap(layer, k) for k in range(len(layer) - 1)) for layer in layers]
        H = max(col_h)
        x = PAD
        for li, layer in enumerate(layers):
            y = top + (H - col_h[li]) / 2
            for k, n in enumerate(layer):
                center[n] = (x + cw[li] / 2, y + size[n][1] / 2)
                y += size[n][1] + (gap(layer, k) if k < len(layer) - 1 else 0)
            x += cw[li] + GAP_RANK
    else:
        row_w = [sum(size[n][0] for n in layer) + GAP_NODE * (len(layer) - 1) for layer in layers]
        Wm = max(row_w)
        y = top
        for li, layer in enumerate(layers):
            x = PAD + (Wm - row_w[li]) / 2
            for n in layer:
                center[n] = (x + size[n][0] / 2, y + NODE_H / 2)
                x += size[n][0] + GAP_NODE
            y += NODE_H + GAP_RANK + (TITLE if groups else 0)

    shapes = []
    for gi, g in enumerate(groups):  # 分组：虚线框，组名写在框上方
        xs = [v for n in g["nodes"] for v in (center[n][0] - size[n][0] / 2, center[n][0] + size[n][0] / 2)]
        ys = [v for n in g["nodes"] for v in (center[n][1] - size[n][1] / 2, center[n][1] + size[n][1] / 2)]
        x0, y0, x1, y1 = min(xs) - 14, min(ys) - 14, max(xs) + 14, max(ys) + 14
        shapes.append({"type": "rect", "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0, "dash": True})
        if g.get("text"):
            shapes.append({"type": "text", "x": x0 + 4, "y": y0 - TITLE / 2, "text": g["text"]})
    for n in nodes:
        (cx, cy), (w, h) = center[n["id"]], size[n["id"]]
        if n.get("shape") == "round":
            shapes.append({"type": "ellipse", "cx": cx, "cy": cy, "rx": w / 2 + 4, "ry": h / 2 + 2, "text": n["text"]})
        else:
            shapes.append({"type": "rect", "x": cx - w / 2, "y": cy - h / 2, "w": w, "h": h, "text": n["text"]})
    for k, e in enumerate(edges):
        a, b = center[e["from"]], center[e["to"]]
        sa, sb = size[e["from"]], size[e["to"]]
        bend = k in back or rank[e["from"]] == rank[e["to"]] or abs(rank[e["to"]] - rank[e["from"]]) > 1
        if bend:  # 回头的、同一层的、跨层的：弯一点，不穿过别的节点
            mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            dx, dy = b[0] - a[0], b[1] - a[1]
            L = math.hypot(dx, dy) or 1
            bow = min(120, max(40, L * 0.2)) if k in back else min(90, max(30, L * 0.15))  # 越长弯得越开
            mid = [mx - dy / L * bow, my + dx / L * bow]
            p0, p1 = _clip(a, *sa, mid), _clip(b, *sb, mid)
            shape = {"type": "curve", "pts": [p0, mid, p1], "arrow": "end"}
        else:
            p0, p1 = _clip(a, *sa, b), _clip(b, *sb, a)
            shape = {"type": "line", "pts": [p0, p1], "arrow": "end"}
        if e.get("text"):
            shape["text"] = e["text"]
        if e.get("dash"):
            shape["dash"] = True
        shapes.append(shape)

    # 整体挪到从 PAD 起，算出宽高（字的宽度也算进去）
    xs, ys = [], []
    for s in shapes:
        if s["type"] == "rect":
            xs += [s["x"], s["x"] + s["w"]]
            ys += [s["y"], s["y"] + s["h"]]
        elif s["type"] == "ellipse":
            xs += [s["cx"] - s["rx"], s["cx"] + s["rx"]]
            ys += [s["cy"] - s["ry"], s["cy"] + s["ry"]]
        elif s["type"] == "text":
            xs += [s["x"], s["x"] + text_w(s["text"])]
            ys += [s["y"] - FS * 0.7, s["y"] + FS * 0.7]
        else:
            xs += [p[0] for p in s["pts"]]
            ys += [p[1] for p in s["pts"]]
            if s.get("text"):
                i = (len(s["pts"]) - 1) // 2
                mx = (s["pts"][i][0] + s["pts"][i + 1][0]) / 2
                xs += [mx - text_w(s["text"]) / 2, mx + text_w(s["text"]) / 2]
                ys.append(min(s["pts"][i][1], s["pts"][i + 1][1]) - FS * 1.5)
    dx, dy = PAD - min(xs), PAD - min(ys)
    r = lambda v: round(v, 1)  # noqa: E731
    for s in shapes:
        for kx, ky in (("x", "y"), ("cx", "cy")):
            if kx in s:
                s[kx], s[ky] = r(s[kx] + dx), r(s[ky] + dy)
        for k in ("w", "h", "rx", "ry"):
            if k in s:
                s[k] = r(s[k])
        if "pts" in s:
            s["pts"] = [[r(p[0] + dx), r(p[1] + dy)] for p in s["pts"]]
    return {"shapes": shapes, "w": r(max(xs) + dx + PAD), "h": r(max(ys) + dy + PAD)}

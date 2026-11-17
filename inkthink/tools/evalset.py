"""手写评测集（路线图阶段 0）：从真实笔迹里挑约 50 组，裁成图、预填已有读法，网页上逐条核对标准答案，再算识别的字错误率。

    .venv\\Scripts\\python.exe tools\\evalset.py build  [--n 50]      生成候选（不覆盖已核对的答案）
    .venv\\Scripts\\python.exe tools\\evalset.py serve  [--port 8790] 本机网页 http://127.0.0.1:8790/ ，核对后存 labels.json
    .venv\\Scripts\\python.exe tools\\evalset.py score  [--confirmed] Windows 识别相对标准答案的 CER
    .venv\\Scripts\\python.exe tools\\evalset.py cells               按发送时的字帖画法重画每组（cells/*.png）
    .venv\\Scripts\\python.exe tools\\evalset.py ocr    [--variants PP-OCRv5:server ...]  PP-OCR 识别各组，算 CER 和用时
    .venv\\Scripts\\python.exe tools\\evalset.py score  --hyp 文件.json  别的读法（{编号: 文字}，如 Claude 读图的结果）的 CER
    .venv\\Scripts\\python.exe tools\\evalset.py reco   [--data 目录]  用现在的 Windows 识别（先判断中文还是英文）重新认一遍，算 CER

分数按红笔 / 黑笔 / 含公式或符号，以及标准答案的语种（中文 / 英文 / 中英混写）分开列。

读法来源，按可信度排：
1. confirm：对话记录里 ink_confirm 的回答（用户在平板上亲手确认或更正的），标「已确认」；
2. q / read：Claude 对红笔问题的转写（整段回答的 q）、写回的 read；
3. reco：Windows 本机手写识别（recognize.py）。

只读 data/notebooks、data/submissions 和 Claude Code 对话记录；输出都在 data/evalset/（不进仓库）。
"""
import argparse
import json
import os
import re
import sys
import threading
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import inksheet  # noqa: E402
import pages  # noqa: E402
import recognize  # noqa: E402

SOURCES = ("confirm", "q", "read", "reco")
SOURCE_LABEL = {"confirm": "已确认（确认卡片）", "q": "Claude 转写的问题", "read": "Claude 的转写", "reco": "Windows 识别", "": "没有读法"}
SKIP_FILES = ("meta.json", "doc.json", "layout.json", "changes.json", "settings.json", "index.json", "pads.json")


# ---------------------------------------------------------------- 读真实数据

def page_files(data):
    """data/notebooks 下所有存着笔迹的页面文件：[(本子目录名, 文件, 页面)]。"""
    out = []
    for f in sorted((data / "notebooks").glob("*/*.json")):
        if f.name.endswith(".pending.json") or f.name in SKIP_FILES:
            continue
        try:
            page = json.loads(f.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(page, dict) and isinstance(page.get("strokes"), list) and page["strokes"]:
            out.append((f.parent.name, f, page))
    return out


def transcripts(projects):
    for root in projects:
        yield from sorted(Path(root).glob("*/*.jsonl"))


def tool_calls(path, name):
    """一份对话记录里某个工具的调用和结果：[(输入, 结果文字)]。"""
    try:
        lines = Path(path).read_text("utf-8", errors="ignore").splitlines()
    except OSError:
        return []
    uses, results = {}, {}
    for line in lines:
        if name in line and '"tool_use"' in line:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            for x in (d.get("message") or {}).get("content") or []:
                if isinstance(x, dict) and x.get("type") == "tool_use" and str(x.get("name", "")).endswith(name):
                    uses[x["id"]] = x.get("input") or {}
    if not uses:
        return []
    for line in lines:
        if '"tool_result"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        for x in (d.get("message") or {}).get("content") or []:
            if isinstance(x, dict) and x.get("type") == "tool_result" and x.get("tool_use_id") in uses:
                c = x.get("content")
                results[x["tool_use_id"]] = c if isinstance(c, str) else "".join(
                    y.get("text", "") for y in c or [] if isinstance(y, dict))
    return [(uses[k], results.get(k, "")) for k in uses]


def confirm_answers(path):
    """一份对话记录里每次 ink_confirm 的（输入, {组编号: 用户的读法}）。等太久没回答的，用户之后在平板上答了，
    会作为一条「【草稿纸·确认】」消息进对话：接到它之前最近一次还没回答的那次调用上。"""
    try:
        lines = Path(path).read_text("utf-8", errors="ignore").splitlines()
    except OSError:
        return []
    order, uses = [], {}
    for line in lines:
        is_use = "ink_confirm" in line and '"tool_use"' in line
        is_res = '"tool_result"' in line and uses
        is_late = "【草稿纸·确认】" in line and order
        if not (is_use or is_res or is_late):
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        content = (d.get("message") or {}).get("content")
        for x in content if isinstance(content, list) else []:
            if not isinstance(x, dict):
                continue
            if x.get("type") == "tool_use" and str(x.get("name", "")).endswith("ink_confirm"):
                rec = {"inp": x.get("input") or {}, "ans": {}}
                uses[x["id"]] = rec
                order.append(rec)
            elif x.get("type") == "tool_result" and x.get("tool_use_id") in uses:
                c = x.get("content")
                text = c if isinstance(c, str) else "".join(y.get("text", "") for y in c or [] if isinstance(y, dict))
                rec = uses[x["tool_use_id"]]
                rec["ans"] = parse_confirm(rec["inp"], text)
        if d.get("type") == "user" and is_late:
            text = content if isinstance(content, str) else "".join(
                y.get("text", "") for y in content or [] if isinstance(y, dict) and y.get("type") == "text")
            if text.lstrip().startswith("【草稿纸·确认】"):
                rec = next((r for r in reversed(order) if not r["ans"]), None)
                if rec:
                    ans = parse_confirm(rec["inp"], text)
                    anchors = {str(q.get("anchor")) for q in rec["inp"].get("questions") or []}
                    if ans and set(ans) <= anchors:
                        rec["ans"] = ans
    return [(r["inp"], r["ans"]) for r in order]


LINE_RE = re.compile(r"^\s*\d+\.\s*(g\d+)\s*[：:](.*)$")


def parse_confirm(inp, result):
    """ink_confirm 的结果文字 → {组编号: 用户的读法}。每行「k. gN：…（你读成「猜的」）→ 是「答」。」，取箭头后最后一个「」；
    只写了「对」的，用 Claude 猜的那个。"""
    guess = {str(q.get("anchor")): q.get("guess") for q in inp.get("questions") or [] if q.get("anchor")}
    out = {}
    for line in result.splitlines():
        m = LINE_RE.match(line)
        if not m or "→" not in m.group(2):
            continue
        gid, tail = m.group(1), m.group(2).rsplit("→", 1)[1]
        quoted = re.findall(r"「(.+?)」", tail)
        if quoted:
            out[gid] = quoted[-1]
        elif tail.strip().startswith("对") and guess.get(gid):
            out[gid] = guess[gid]
    return out


class Strokes:
    """所有页面的笔迹，按 id 和落笔时刻查。"""

    def __init__(self, files):
        self.by_id, self.where = {}, {}
        self.all = []
        for nb, f, page in files:
            for s in page["strokes"]:
                if s.get("pts"):
                    self.by_id[s.get("id")] = s
                    self.where[s.get("id")] = (nb, f.name)
                    self.all.append(s)

    def of_group(self, meta, gid, page_no=None):
        """投递里的一组 → 当时看得见的笔迹。新的投递带着每组的笔迹 id；旧的只有时间和颜色，按落笔时刻找。"""
        if page_no and meta.get("pages"):
            ent = meta["pages"].get(str(page_no)) or {}
            ids = ((ent.get("gx") or {}).get(gid) or {}).get("ids")
            return [self.by_id[i] for i in ids or [] if i in self.by_id]
        g = next((x for x in meta.get("groups") or [] if isinstance(x, dict) and x.get("id") == gid), None)
        if not g:
            gx = (meta.get("gx") or {}).get(gid) or {}
            return [self.by_id[i] for i in gx.get("ids") or [] if i in self.by_id]
        if g.get("ids"):
            return [self.by_id[i] for i in g["ids"] if i in self.by_id]
        t0, t1, now = g.get("t0"), g.get("t1"), meta.get("now") or meta.get("created") or 0
        if t0 is None or t1 is None:
            return []
        red = bool(g.get("red"))
        out = [s for s in self.all if t0 <= (s.get("t0") or 0) <= t1 and (s.get("c") == "r") == red]
        live = [s for s in out if not s.get("erasedAt") or (now and s["erasedAt"] > now)]
        return live if len(out) == g.get("n", len(out)) else []  # 笔数对不上：页面后来改过，不用


def load_meta(data, sub):
    f = data / "submissions" / str(sub) / "meta.json"
    try:
        return json.loads(f.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def gather(data, projects, strokes):
    """有读法的组：[{key, strokes, draft, source}]，key 是笔迹 id 排序后连起来（去重用）。"""
    found = {}

    def add(ss, text, source):
        ss = [s for s in ss if s.get("pts")]
        text = (text or "").strip()
        if not ss or not text:
            return
        key = "|".join(sorted(str(s.get("id")) for s in ss))
        old = found.get(key)
        if old is None or SOURCES.index(source) < SOURCES.index(old["source"]):
            found[key] = {"key": key, "strokes": ss, "draft": text, "source": source}

    for path in transcripts(projects):
        for inp, answers in confirm_answers(path):
            meta = load_meta(data, inp.get("submission")) if inp.get("submission") else None
            if not meta:
                continue
            for gid, text in answers.items():
                add(strokes.of_group(meta, gid, inp.get("page")), text, "confirm")
        for inp, _ in tool_calls(path, "ink_reply"):
            meta = load_meta(data, inp.get("submission")) if inp.get("submission") else None
            if not meta:
                continue
            for it in inp.get("items") or []:
                if isinstance(it, dict) and it.get("type") == "read" and re.fullmatch(r"g\d+", str(it.get("anchor") or "")):
                    add(strokes.of_group(meta, it["anchor"], inp.get("page")), it.get("text"), "read")
    for _, _, page in page_files(data):  # 整段回答的 q：Claude 对它回答的那条红笔问题的转写
        by_id = {s.get("id"): s for s in page["strokes"]}
        for a in page.get("ai") or []:
            if a.get("type") == "write" and a.get("q") and a.get("on"):
                add([by_id[i] for i in a["on"] if i in by_id and not by_id[i].get("erasedAt")], a["q"], "q")
    return list(found.values())


# ---------------------------------------------------------------- 挑选、画图、识别

def looks_like_mark(ss):
    """一两笔的圈、横线、箭头：是标记不是字。"""
    if len(ss) >= 3:
        return False
    b = union([pages.stroke_box(s) for s in ss])
    w, h = b[2] - b[0], b[3] - b[1]
    return max(w, h) > 6 * max(1, min(w, h)) or len(ss) == 1 and max(w, h) > 120


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def has_formula(text):
    return bool(re.search(r"[=+\-*/^_()（）\[\]<>≈≤≥∂∫∑√αβγδεθλμνπρσφωΩΦΔ0-9]", text or ""))


def pick(cands, fill, n):
    """先要有读法的（已确认的全要），再从其余组里补够 n 组：红黑、各本子轮着挑。"""
    chosen = [c for c in cands if c["source"] == "confirm"]
    rest = sorted((c for c in cands if c["source"] != "confirm"), key=lambda c: SOURCES.index(c["source"]))
    for c in rest:
        if len(chosen) >= n:
            break
        chosen.append(c)
    have = {c["key"] for c in chosen}
    pools = {}
    for c in fill:
        if c["key"] not in have:
            pools.setdefault((c["nb"], c["red"]), []).append(c)
    while len(chosen) < n and any(pools.values()):  # 红黑哪种少补哪种；同色的各本子轮着来
        reds = sum(1 for c in chosen if c["red"])
        want = reds * 2 < len(chosen) or not any(v for k, v in pools.items() if not k[1])
        keys = [k for k in sorted(pools) if pools[k] and k[1] == want] or [k for k in sorted(pools) if pools[k]]
        k = keys[len(chosen) % len(keys)]
        chosen.append(pools[k].pop(0))
    return chosen[:n]


def render(ss, out, char_h=60):
    """只画笔迹、白底，字高缩放到约 char_h 像素，存 PNG。返回 (宽, 高)。"""
    from PIL import Image, ImageDraw
    heights = sorted(pages.stroke_box(s)[3] - pages.stroke_box(s)[1] for s in ss)
    ch = max(8.0, heights[int(len(heights) * 0.75)] if heights else 30) * 1.3  # 一个字大约是较高那几笔的高度
    k = max(0.3, min(4.0, char_h / ch))
    b = union([pages.stroke_box(s) for s in ss])
    pad = 12
    W, H = int((b[2] - b[0]) * k) + 2 * pad, int((b[3] - b[1]) * k) + 2 * pad
    if W > 1600:  # 太宽：整体再缩
        k *= 1600 / W
        W, H = int((b[2] - b[0]) * k) + 2 * pad, int((b[3] - b[1]) * k) + 2 * pad
    im = Image.new("RGB", (max(W, 8), max(H, 8)), "white")
    d = ImageDraw.Draw(im)
    for s in ss:
        col = (200, 40, 30) if s.get("c") == "r" else (20, 20, 20)
        pts = [((p[0] - b[0]) * k + pad, (p[1] - b[1]) * k + pad) for p in s["pts"]]
        w = max(2, round((s.get("w") or 2.1) * k * 0.9))
        if len(pts) == 1:
            x, y = pts[0]
            d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=col)
        else:
            d.line(pts, fill=col, width=w, joint="curve")
    im.save(out)
    return im.size


def build(data, projects, n=50, reco=None):
    """生成 data/evalset/items.json 和 img/*.png。已有的 labels.json 不动（按 key 对回去）。返回各来源的条数。"""
    reco = reco or recognize.recognize
    files = page_files(data)
    strokes = Strokes(files)
    cands = gather(data, projects, strokes)
    for c in cands:
        c["nb"], _ = strokes.where.get(c["strokes"][0].get("id"), ("?", "?"))
        c["red"] = any(s.get("c") == "r" for s in c["strokes"])
    fill = []
    for nb, f, page in files:
        for gid, ss in pages.group_strokes(pages.ink(page)):
            if len(ss) >= 2 and not looks_like_mark(ss):
                fill.append({"key": "|".join(sorted(str(s.get("id")) for s in ss)), "strokes": ss, "draft": "",
                             "source": "", "nb": nb, "red": any(s.get("c") == "r" for s in ss)})
    chosen = pick(cands, fill, n)
    out = data / "evalset"
    (out / "img").mkdir(parents=True, exist_ok=True)
    got = reco([(f"e{i + 1:02d}", c["strokes"]) for i, c in enumerate(chosen)]) or {}
    items = []
    for i, c in enumerate(chosen):
        iid = f"e{i + 1:02d}"
        w, h = render(c["strokes"], out / "img" / f"{iid}.png")
        r = got.get(iid) or []
        draft, source = (c["draft"], c["source"]) if c["source"] else ((r[0], "reco") if r else ("", ""))
        items.append({"id": iid, "key": c["key"], "img": f"img/{iid}.png", "w": w, "h": h, "nb": c["nb"], "red": c["red"],
                      "strokes": len(c["strokes"]), "draft": draft, "source": source,
                      "formula": has_formula(draft), "reco": r})
    for f in (out / "img").glob("*.png"):  # 上次多出来的图
        if f.stem not in {it["id"] for it in items}:
            f.unlink()
    tmp = out / "items.json.tmp"
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, out / "items.json")
    counts = {s: sum(1 for it in items if it["source"] == s) for s in SOURCES}
    counts["none"] = sum(1 for it in items if not it["source"])
    counts["with_reco"] = sum(1 for it in items if it["reco"])
    counts.update(total=len(items), red=sum(1 for it in items if it["red"]), formula=sum(1 for it in items if it["formula"]),
                  notebooks=len({it["nb"] for it in items}))
    return counts


# ---------------------------------------------------------------- 核对网页

def load_items(out):
    return json.loads((out / "items.json").read_text("utf-8"))


def load_labels(out):
    f = out / "labels.json"
    try:
        return json.loads(f.read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def save_labels(out, labels):
    """{key: {truth, checked}}：按笔迹 key 存，重新 build 换了编号也对得上。"""
    tmp = out / "labels.json.tmp"
    tmp.write_text(json.dumps(labels, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, out / "labels.json")


PAGE = r"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>手写评测集核对</title><style>
body{font:15px/1.5 -apple-system,"Microsoft YaHei",sans-serif;margin:0;background:#f6f4ef;color:#222}
header{position:sticky;top:0;background:#fffdf8;border-bottom:1px solid #d9d3c6;padding:10px 16px;z-index:2}
header b{font-size:17px}#prog{margin-left:12px;color:#555}#msg{margin-left:12px;color:#2f7a3e}
main{padding:12px 16px 80px;max-width:1200px}
.row{display:grid;grid-template-columns:44px minmax(200px,1fr) minmax(260px,1fr);gap:12px;align-items:center;background:#fff;
border:1px solid #e3ddd0;border-radius:10px;padding:10px;margin-bottom:10px}
.row.done{border-color:#7fb58a;background:#f4fbf5}.row.cur{outline:2px solid #2f5fae}
.id{color:#888;font-size:13px}.img img{max-width:100%;max-height:220px;background:#fff}
.src{font-size:12px;color:#777;margin:2px 0 6px}.draft{color:#555;font-size:13px}
input[type=text]{width:100%;box-sizing:border-box;font-size:17px;padding:6px 8px;border:1px solid #bbb;border-radius:6px}
label{display:inline-flex;gap:6px;align-items:center;margin-top:6px;font-size:14px}
.help{color:#666;font-size:13px;margin:6px 0 0}
</style></head><body>
<header><b>手写评测集核对</b><span id="prog"></span><span id="msg"></span>
<div class="help">在输入框里写出图中手写的标准答案（照写的原样，公式用普通文本或 LaTeX 都行）；回车＝勾上「已核对」并跳到下一条。改动自动保存到 labels.json。</div></header>
<main id="list"></main>
<script>
let items = [], labels = {};
const $ = (s, e = document) => e.querySelector(s);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function load() {
  const r = await (await fetch('/data')).json();
  items = r.items; labels = r.labels; draw();
}
function draw() {
  $('#list').innerHTML = items.map((it, i) => {
    const l = labels[it.key] || {}, v = l.truth != null ? l.truth : it.draft;
    const reco = it.reco && it.reco.length ? `　Windows 识别：${esc(it.reco[0])}` : '';
    return `<div class="row${l.checked ? ' done' : ''}" data-i="${i}"><div class="id">${it.id}<br>${it.red ? '红' : '黑'}</div>
      <div class="img"><img src="/${it.img}" alt="${it.id}"></div>
      <div><div class="src">预填来源：${esc(r_src(it.source))}${reco}</div>
      <input type="text" value="${esc(v)}" data-i="${i}">
      <label><input type="checkbox" ${l.checked ? 'checked' : ''} data-i="${i}"> 已核对</label></div></div>`;
  }).join('');
  prog();
}
const SRC = %SRC%;
const r_src = (s) => SRC[s || ''] || s;
function prog() {
  const n = items.filter((it) => (labels[it.key] || {}).checked).length;
  $('#prog').textContent = `已核对 ${n} / ${items.length}`;
}
let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const r = await fetch('/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(labels) });
    $('#msg').textContent = r.ok ? '已保存' : '没存上：' + r.status;
    setTimeout(() => { $('#msg').textContent = ''; }, 1500);
  }, 300);
}
function setL(i, patch) {
  const it = items[i]; labels[it.key] = Object.assign({ truth: it.draft, checked: false }, labels[it.key], patch);
  const row = document.querySelector(`.row[data-i="${i}"]`);
  row.classList.toggle('done', !!labels[it.key].checked);
  prog(); save();
}
document.addEventListener('input', (e) => { if (e.target.type === 'text') setL(+e.target.dataset.i, { truth: e.target.value }); });
document.addEventListener('change', (e) => { if (e.target.type === 'checkbox') setL(+e.target.dataset.i, { checked: e.target.checked }); });
document.addEventListener('focusin', (e) => {
  document.querySelectorAll('.row.cur').forEach((r) => r.classList.remove('cur'));
  const row = e.target.closest('.row'); if (row) row.classList.add('cur');
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.type !== 'text' || e.isComposing) return;
  e.preventDefault();
  const i = +e.target.dataset.i;
  setL(i, { truth: e.target.value, checked: true });
  document.querySelector(`.row[data-i="${i}"] input[type=checkbox]`).checked = true;
  const next = document.querySelector(`input[type=text][data-i="${i + 1}"]`);
  if (next) { next.focus(); next.select(); next.scrollIntoView({ block: 'center' }); }
});
load().then(() => {
  const first = items.findIndex((it) => !(labels[it.key] || {}).checked);
  const el = document.querySelector(`input[type=text][data-i="${first < 0 ? 0 : first}"]`);
  if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
});
</script></body></html>"""


def make_handler(out):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                html = PAGE.replace("%SRC%", json.dumps(SOURCE_LABEL, ensure_ascii=False))
                return self.send(200, html.encode("utf-8"), "text/html; charset=utf-8")
            if self.path == "/data":
                body = json.dumps({"items": load_items(out), "labels": load_labels(out)}, ensure_ascii=False)
                return self.send(200, body.encode("utf-8"), "application/json; charset=utf-8")
            m = re.fullmatch(r"/img/(e\d+\.png)", self.path)
            if m and (out / "img" / m.group(1)).is_file():
                return self.send(200, (out / "img" / m.group(1)).read_bytes(), "image/png")
            self.send(404, b"not found", "text/plain")

        def do_POST(self):
            if self.path != "/save":
                return self.send(404, b"not found", "text/plain")
            n = int(self.headers.get("Content-Length") or 0)
            try:
                labels = json.loads(self.rfile.read(n).decode("utf-8"))
                if not isinstance(labels, dict):
                    raise ValueError
            except ValueError:
                return self.send(400, b"bad json", "text/plain")
            keys = {it["key"] for it in load_items(out)}
            clean = {k: {"truth": str(v.get("truth") or "")[:500], "checked": bool(v.get("checked"))}
                     for k, v in labels.items() if k in keys and isinstance(v, dict)}
            keep = {k: v for k, v in load_labels(out).items() if k not in keys}  # 以前的、这次没选上的答案留着
            save_labels(out, {**keep, **clean})
            self.send(200, b'{"ok":true}', "application/json")
    return H


def serve(out, port):
    srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(out))
    return srv


# ---------------------------------------------------------------- 打分

def norm(t):
    """比较前统一：全角半角（NFKC）、去掉空白。"""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", t or ""))


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def truths(out, confirmed=False):
    """{编号: 标准答案}：核对过的（labels.json 里勾了「已核对」的）；confirmed 时另把「已确认」来源的预填读法直接当答案。"""
    labels, res = load_labels(out), {}
    for it in load_items(out):
        lab = labels.get(it["key"]) or {}
        truth = lab.get("truth") if lab.get("checked") else (it["draft"] if confirmed and it["source"] == "confirm" else None)
        if truth and norm(truth):
            res[it["id"]] = truth
    return res


def score(out, confirmed=False, hyp=None):
    """读法相对标准答案的字错误率。hyp：{编号: 读法}（几个读法时取每组编辑最少的，即「取优」上限）；
    不给就是 Windows 识别。返回 {n, chars, edits, cer, mean, by: {红/黑/公式}}。"""
    tr = truths(out, confirmed)
    rows = []
    for it in load_items(out):
        truth = tr.get(it["id"])
        if not truth:
            continue
        t = norm(truth)
        cands = (hyp or {}).get(it["id"]) if hyp is not None else (it.get("reco") or [""])[0]
        cands = cands if isinstance(cands, list) else [cands or ""]
        rows.append({"id": it["id"], "red": it["red"], "formula": has_formula(truth), "chars": len(t), "lang": lang_of(truth),
                     "edits": min(edit_distance(norm(h), t) for h in cands)})

    def agg(rs):
        if not rs:
            return {"n": 0}
        c, e = sum(r["chars"] for r in rs), sum(r["edits"] for r in rs)
        return {"n": len(rs), "chars": c, "edits": e, "cer": round(e / c, 3), "mean": round(sum(r["edits"] / r["chars"] for r in rs) / len(rs), 3)}

    res = agg(rows)
    res["by"] = {"红笔": agg([r for r in rows if r["red"]]), "黑笔": agg([r for r in rows if not r["red"]]),
                 "含公式或符号": agg([r for r in rows if r["formula"]])}
    for name in ("中文", "英文", "中英混写"):  # 按标准答案里的字分（2026-11-14 加语种判断时加的）
        res["by"][name] = agg([r for r in rows if r["lang"] == name])
    return res


def lang_of(text):
    """标准答案是什么语种：有汉字也有拉丁字母是「中英混写」，只有汉字「中文」，只有拉丁字母「英文」，都没有「符号」。"""
    han = bool(re.search(r"[㐀-鿿]", text or ""))
    lat = bool(re.search(r"[A-Za-z]", text or ""))
    return "中英混写" if han and lat else "中文" if han else "英文" if lat else "符号"


def run_reco(data, out, reco=None):
    """用现在的 Windows 识别（先判断中文还是英文，recognize.recognize_lang）重新认评测集的每组。
    返回 ({编号: 最可能的读法}, {编号: 判出的语种})；笔迹找不到全的组（页删了）不在里面。"""
    reco = reco or recognize.recognize_lang
    got = reco(list(item_strokes(data, out).items()))
    return {k: v["text"][0] for k, v in got.items()}, {k: v["lang"] for k, v in got.items()}


def item_strokes(data, out):
    """{编号: 这组的笔迹}；笔迹找不到全（页删了）的不在里面。"""
    by_id = Strokes(page_files(data)).by_id
    res = {}
    for it in load_items(out):
        ss = [by_id[i] for i in it["key"].split("|") if i in by_id]
        if len(ss) == it["strokes"]:
            res[it["id"]] = ss
    return res


def cells(data, out):
    """按发送时的字帖画法（inksheet.cell）重画评测集的每组，存到 cells/。笔迹找不到的（页删了）沿用原来的图。返回重画了几组。"""
    strokes = item_strokes(data, out)
    (out / "cells").mkdir(exist_ok=True)
    n = 0
    for it in load_items(out):
        ss = strokes.get(it["id"])
        im = inksheet.cell(ss) if ss else None
        dst = out / "cells" / f"{it['id']}.png"
        if im is None:
            from PIL import Image
            Image.open(out / it["img"]).save(dst)
            continue
        im.save(dst)
        n += 1
    return n


def run_ocr(data, out, variants):
    """PP-OCR 各版本、各档识别每组（和发送时一样：按笔画分行、每行只用识别模型）：存 ocr-版本-档.json，
    返回 {变体: (结果, 每组平均用时秒)}。"""
    import time
    import ocr
    res = {}
    strokes = item_strokes(data, out)
    for v in variants:
        version, model = v.split(":")
        eng = ocr.engine(version, model)
        ocr.read_strokes(next(iter(strokes.values())), eng)  # 预热
        got, t0 = {}, time.perf_counter()
        for iid, ss in strokes.items():
            got[iid] = ocr.read_strokes(ss, eng)
        res[v] = (got, (time.perf_counter() - t0) / max(1, len(strokes)))
        (out / f"ocr-{version}-{model}.json").write_text(json.dumps(got, ensure_ascii=False, indent=1), "utf-8")
    return res


def print_score(name, r):
    if not r["n"]:
        print(f"{name}：没有核对过的答案")
        return
    by = "，".join(f"{k} {v['cer']}（{v['n']}）" for k, v in r["by"].items() if v["n"])
    print(f"{name} CER：{r['cer']}（{r['n']} 组、{r['chars']} 字；{by}）")


def main():
    ap = argparse.ArgumentParser(description="手写评测集：build / serve / score")
    ap.add_argument("cmd", choices=["build", "serve", "score", "cells", "ocr", "reco"])
    ap.add_argument("--data", default=str(ROOT / "data"))
    ap.add_argument("--projects", nargs="*", default=[str(Path.home() / ".claude" / "projects")])
    ap.add_argument("--n", type=int, default=50)
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--confirmed", action="store_true", help="score：「已确认」来源的读法不用核对，直接当答案")
    ap.add_argument("--hyp", nargs="*", help="score：别的读法文件（{编号: 文字}）；给几个时取每组最好的")
    ap.add_argument("--variants", nargs="*", default=["PP-OCRv5:mobile", "PP-OCRv5:server", "PP-OCRv6:small", "PP-OCRv6:medium"],
                    help="ocr：要比的 PP-OCR 版本:档位")
    a = ap.parse_args()
    data, out = Path(a.data), Path(a.data) / "evalset"
    if a.cmd == "build":
        c = build(data, a.projects, a.n)
        print(f"生成 {c['total']} 组（红笔 {c['red']}，含公式或符号 {c['formula']}，来自 {c['notebooks']} 本）："
              f"已确认 {c['confirm']}、Claude 转写的问题 {c['q']}、Claude 的转写 {c['read']}、"
              f"只有 Windows 识别 {c['reco']}、没有读法 {c['none']}；有 Windows 识别结果的 {c['with_reco']} 组。\n输出：{out}")
    elif a.cmd == "serve":
        srv = serve(out, a.port)
        print(f"核对网页：http://127.0.0.1:{a.port}/ （Ctrl+C 停止）")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
    elif a.cmd == "cells":
        print(f"按字帖画法重画了 {cells(data, out)} 组：{out / 'cells'}")
    elif a.cmd == "reco":
        print_score("Windows 识别（生成评测集时存下的）", score(out, a.confirmed))
        hyp, langs = run_reco(data, out)
        print_score("Windows 识别（现在，先判断语种）", score(out, a.confirmed, hyp))
        print("判出的语种：" + "，".join(f"{k} {sum(1 for v in langs.values() if v == k)} 组" for k in sorted(set(langs.values()))))
    elif a.cmd == "ocr":
        win = {it["id"]: (it.get("reco") or [""])[0] for it in load_items(out)}
        print_score("Windows 识别", score(out, a.confirmed))
        for v in a.variants:  # 一个一个跑、跑完就打印（模型第一次用要下载）
            got, sec = run_ocr(data, out, [v])[v]
            print_score(f"{v}（每组 {sec:.2f} 秒）", score(out, a.confirmed, got))
            print_score(f"  和 Windows 取优（上限）", score(out, a.confirmed, {k: [win.get(k, ""), got.get(k, "")] for k in got}))
    elif a.hyp:
        hyps = [json.loads(Path(p).read_text("utf-8")) for p in a.hyp]
        merged = {k: [h.get(k, "") for h in hyps] for k in set().union(*hyps)}
        print_score("、".join(Path(p).stem for p in a.hyp), score(out, a.confirmed, merged))
    else:
        r = score(out, a.confirmed)
        if not r["n"]:
            print("还没有核对过的答案（或加 --confirmed 用已确认的读法）")
            return 0
        print(f"Windows 识别 CER：{r['cer']}（{r['n']} 组、{r['chars']} 字、{r['edits']} 处编辑；逐组平均 {r['mean']}）")
        for k, v in r["by"].items():
            if v["n"]:
                print(f"  {k}：{v['cer']}（{v['n']} 组）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

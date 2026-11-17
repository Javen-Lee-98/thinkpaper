"""阶段 0 的计时脚本：每次投递从「平板发出」到「第一笔蓝字写回」用了多久，一轮多长，投递有多胖。

数据来源（只读）：
- data/submissions/<投递编号>/：message.txt 的字数、图片的像素；编号里带着平板发出的本地时间；
- Claude Code 的对话记录（~/.claude/projects/*/*.jsonl）：投递作为用户消息进入对话的时间、
  第一次调用 mcp__inkpad__ink_reply 的时间、这一轮最后一条回复的时间。

token 是估计：文字按每字约 1 个 token；图片按每 28×28 像素 1 个视觉 token（长边超过 2576 时先按比例缩到 2576），
和 docs/archive/research/2026-10-25-recognition-and-speed.md 的算法一样。

用法：
    .venv\\Scripts\\python.exe tools\\timing.py [--data data] [--projects 目录 ...] [--since 2026-10-20] [--csv 输出.csv]

只输出编号和数字，不输出投递内容。
"""
import argparse
import csv
import json
import re
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SUB_RE = re.compile(r'submission="(\d{8}-\d{6}-[0-9a-f]{4})"')
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp"}


def image_tokens(path):
    with Image.open(path) as im:
        w, h = im.size
    k = min(1.0, 2576 / max(w, h))
    return round(w * k * h * k / 784)


def load_submissions(data):
    """{编号: {sent: 平板发出的时刻（UTC）, chars, images, tokens}}"""
    out = {}
    for d in sorted((data / "submissions").iterdir()):
        msg = d / "message.txt"
        if not msg.is_file():
            continue
        try:
            sent = datetime.strptime(d.name[:15], "%Y%m%d-%H%M%S").astimezone().astimezone(timezone.utc)
        except ValueError:
            continue
        chars = len(msg.read_text("utf-8"))
        imgs = [p for p in d.iterdir() if p.suffix.lower() in IMG_EXT]
        itok = sum(image_tokens(p) for p in imgs)
        out[d.name] = {"sent": sent, "chars": chars, "images": len(imgs), "tokens": chars + itok}
    return out


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(x.get("text", "") for x in content if isinstance(x, dict) and x.get("type") == "text")
    return ""


def is_prompt(entry):
    """用户新发起的一轮（不是工具结果）。"""
    c = (entry.get("message") or {}).get("content")
    if isinstance(c, str):
        return True
    return isinstance(c, list) and any(isinstance(x, dict) and x.get("type") == "text" for x in c) \
        and not any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c)


def scan_transcript(path, subs):
    """在一份对话记录里找投递：{编号: {arrived, first_reply, turn_end, file}}"""
    entries = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if '"type":"user"' not in line and '"type":"assistant"' not in line and '"type": "user"' not in line \
                    and '"type": "assistant"' not in line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("type") in ("user", "assistant") and e.get("timestamp"):
                entries.append(e)
    found = {}
    for i, e in enumerate(entries):
        if e["type"] != "user" or not is_prompt(e):
            continue
        m = SUB_RE.search(text_of((e.get("message") or {}).get("content")))
        if not m or m.group(1) not in subs or "【草稿纸" not in text_of((e.get("message") or {}).get("content")):
            continue
        sid = m.group(1)
        first, end = None, None
        for e2 in entries[i + 1:]:
            if e2["type"] == "user" and is_prompt(e2):
                break
            if e2["type"] == "assistant":
                end = ts(e2["timestamp"])
                c = (e2.get("message") or {}).get("content")
                if first is None and isinstance(c, list) and any(
                        isinstance(x, dict) and x.get("type") == "tool_use" and str(x.get("name", "")).endswith("ink_reply") for x in c):
                    first = ts(e2["timestamp"])
        found.setdefault(sid, {"arrived": ts(e["timestamp"]), "first_reply": first, "turn_end": end, "file": path.name})
    return found


def load_rounds(data):
    """第 3 阶段起服务记下的每一轮进展（data/metrics/rounds.jsonl）：{投递编号: {这一步: 毫秒时刻}}，每步取第一次。"""
    f = data / "metrics" / "rounds.jsonl"
    out = {}
    if not f.is_file():
        return out
    for line in f.read_text("utf-8").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        out.setdefault(r.get("id"), {}).setdefault(r.get("stage"), r.get("t"))
    return out


def summary(name, vals, unit):
    vals = [v for v in vals if v is not None]
    if not vals:
        return f"| {name} | — | — | — | 0 |"
    q = sorted(vals)
    return f"| {name} | {statistics.median(q):.0f} {unit} | {q[0]:.0f}–{q[-1]:.0f} {unit} | {statistics.mean(q):.0f} {unit} | {len(q)} |"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", default=str(ROOT / "data"))
    ap.add_argument("--projects", nargs="*", default=[str(Path.home() / ".claude" / "projects")])
    ap.add_argument("--since", help="只算这一天之后的投递，如 2026-10-20")
    ap.add_argument("--csv", help="逐条结果写到这个 CSV（只有编号和数字）")
    a = ap.parse_args()

    subs = load_submissions(Path(a.data))
    if a.since:
        t0 = datetime.fromisoformat(a.since).astimezone().astimezone(timezone.utc)
        subs = {k: v for k, v in subs.items() if v["sent"] >= t0}
    hits = {}
    for root in a.projects:
        for p in Path(root).glob("*/*.jsonl"):
            try:
                if "【草稿纸" not in p.read_text("utf-8", errors="ignore"):
                    continue
            except OSError:
                continue
            for sid, r in scan_transcript(p, subs).items():
                hits.setdefault(sid, r)

    rows = []
    for sid, s in sorted(subs.items()):
        h = hits.get(sid) or {}
        sec = lambda t: (t - s["sent"]).total_seconds() if t else None  # noqa: E731
        rows.append({"id": sid, "chars": s["chars"], "images": s["images"], "tokens": s["tokens"],
                     "to_conversation_s": sec(h.get("arrived")), "first_reply_s": sec(h.get("first_reply")),
                     "turn_s": sec(h.get("turn_end")), "transcript": h.get("file", "")})

    matched = [r for r in rows if r["first_reply_s"] is not None]
    print(f"投递 {len(rows)} 条；在对话记录里找到且有写回的 {len(matched)} 条。\n")
    print("| 指标 | 中位数 | 范围 | 平均 | 条数 |\n|---|---|---|---|---|")
    print(summary("发出 → 进入对话", [r["to_conversation_s"] for r in matched], "秒"))
    print(summary("发出 → 第一笔蓝字", [r["first_reply_s"] for r in matched], "秒"))
    print(summary("发出 → 这一轮结束", [r["turn_s"] for r in matched], "秒"))
    pages = [r for r in rows if r["images"]]  # 带图的才是草稿纸投递（不含平板上回的纯文字）
    print(summary("每次投递 token（估计，带图的）", [r["tokens"] for r in pages], ""))
    print(summary("其中文字（字）", [r["chars"] for r in pages], ""))
    rounds = load_rounds(Path(a.data))
    if a.since:
        day = a.since.replace("-", "")
        rounds = {k: v for k, v in rounds.items() if k and k[:8] >= day}
    timed = [r for r in rounds.values() if "sent" in r]
    if timed:  # 服务自己记的时刻，比从对话记录里对更准；第 3 阶段之后的投递才有
        gap = lambda r, k: (r[k] - r["sent"]) / 1000 if k in r else None  # noqa: E731
        print(f"\n轮次日志（data/metrics/rounds.jsonl）：{len(timed)} 次投递。\n")
        print("| 指标 | 中位数 | 范围 | 平均 | 条数 |\n|---|---|---|---|---|")
        print(summary("发出 → 进入对话", [gap(r, "delivered") for r in timed], "秒"))
        print(summary("发出 → Claude 读图", [gap(r, "reading") for r in timed], "秒"))
        print(summary("发出 → 第一笔蓝字", [gap(r, "replied") for r in timed], "秒"))
        print(summary("发出 → 这一轮结束", [gap(r, "done") for r in timed], "秒"))
        print(f"其中对话正忙、排了队的 {sum(1 for r in timed if 'queued' in r)} 次，改了文件的 {sum(1 for r in timed if 'working' in r)} 次。")
    if a.csv:
        with open(a.csv, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ["id"])
            w.writeheader()
            w.writerows(rows)
        print(f"\n逐条结果：{a.csv}")


if __name__ == "__main__":
    sys.exit(main())

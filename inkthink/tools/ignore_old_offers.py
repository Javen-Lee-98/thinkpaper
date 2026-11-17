"""把积压的旧「新文件提示」一次标成已忽略（阶段 D2 的一次性整理）。

电脑上的对话生成了图片、PDF、Word、PPT 等文件时，服务在数据文件夹的 offers.json 里记一条「新文件提示」：
{id, path, name, ext, size, mtime, sid, label, t, state}。state 是 "new"（待处理）、"added"（已加进草稿纸）
或 "dismissed"（已忽略）；label 是报上来的那个对话的名字（一般是它所在的文件夹名）；t 是记下这一条的时刻
（毫秒；还没处理时同一文件又生成了一次，服务更新这一条，t 也跟着更新）。

用法（在 inkthink\\ 下）：
    .venv\\Scripts\\python.exe tools\\ignore_old_offers.py --data data                 试跑：只出报告，什么都不写
    .venv\\Scripts\\python.exe tools\\ignore_old_offers.py --data data --apply         真的标（服务要停着）
其他参数：
    --before YYYY-MM-DD   只处理这一天（本机时间零点）之前记下的；不写就处理全部待处理的
    --originals <文件夹>  --apply 时原来的 offers.json 先存到这里；必须在数据文件夹外面，
                          默认是数据文件夹旁边的 data-originals-<日期时间>
    --names               报告里逐条列出文件名（默认不列，只给数目）
    --report <文件>       报告另存成文本（UTF-8），同时照样打印到屏幕
    --port <端口>         正式服务的端口；不写就照 launch.py 的办法（config.json 里的 port，没有就是 8765），另外也查 8765

做什么：只把待处理（state 为 "new"）的条目改成 "dismissed"，和平板上「全部忽略」（/api/offer-dismiss 带 all）
是同一种表示；已加进草稿纸的、已忽略的、认不出的条目一个字不动，条目的顺序和别的字段也不动。标完以后：
- 它们不再出现在待处理列表里（server.App.pending_offers 只列 state 为 "new" 的）。
- 同一个文件没改过、又被报上来，不会再提示（server.App.add_offers 按「路径 + 修改时间」认记过的，不管状态）；
  文件改过（修改时间变了）会作为一条新的提示出现——这是服务原来的规矩，这里不改。
写法和服务存 offers.json 一样（ensure_ascii=False、indent=1，按本机的换行），先写临时文件再替换；
条目一条不删（服务存的时候只留最后 60 条，这里不截）。写完从磁盘读回来复查：条数不变，要标的都成了 "dismissed"，
其余每条和原来一样。复查不过退出码 1；被拒绝执行（服务在跑、参数不对、文件读不出来）退出码 2。
"""
import argparse
import json
import os
import shutil
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OFFERS = "offers.json"


# ------------------------------------------------------------ 服务在不在跑（照 launch.py，和 migrate_cards.py 一样）

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


# ------------------------------------------------------------ 读、挑、写

def day_start_ms(day):
    """「YYYY-MM-DD」那一天本机时间零点的毫秒数；格式不对抛 ValueError。"""
    return int(datetime.strptime(day, "%Y-%m-%d").timestamp() * 1000)


def is_pending(o):
    return isinstance(o, dict) and o.get("state") == "new"


def has_time(o):
    return isinstance(o.get("t"), (int, float)) and not isinstance(o.get("t"), bool)


def pick(items, before_ms=None):
    """要标的条目的下标；另外返回待处理里因为 --before 留着的（时间在那天及以后的、没有记录时间的）。"""
    marked, later, untimed = [], [], []
    for i, o in enumerate(items):
        if not is_pending(o):
            continue
        if before_ms is None:
            marked.append(i)
        elif not has_time(o):
            untimed.append(i)
        elif o["t"] < before_ms:
            marked.append(i)
        else:
            later.append(i)
    return marked, later, untimed


def offers_text(items):
    return json.dumps(items, ensure_ascii=False, indent=1)  # server.py 的 save_offers（不截最后 60 条）


def write_offers(f, items):
    tmp = f.with_name(f.name + ".tmp")
    tmp.write_text(offers_text(items), "utf-8")  # 和服务一样用文本方式写：换行按本机的
    os.replace(tmp, f)


def check(before, after, marked):
    """写完读回来的和原来比。返回问题列表。"""
    if not isinstance(after, list):
        return ["读回来的不是列表"]
    if len(after) != len(before):
        return [f"条数变了：原来 {len(before)} 条，现在 {len(after)} 条"]
    bad = []
    want = set(marked)
    for i, (a, b) in enumerate(zip(before, after)):
        if i in want:
            if not isinstance(b, dict) or b.get("state") != "dismissed":
                bad.append(f"第 {i + 1} 条该标成已忽略，没有标上")
            elif {k: v for k, v in b.items() if k != "state"} != {k: v for k, v in a.items() if k != "state"}:
                bad.append(f"第 {i + 1} 条除了状态还有别的字段变了")
        elif a != b:
            bad.append(f"第 {i + 1} 条不该动，变了")
    return bad


# ------------------------------------------------------------ 报告

def when(ms):
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M")


def summary(items, idx, names=False):
    """一组条目的数目：按对话、按文件类型、最早和最晚、原文件已经不在的。"""
    sel = [items[i] for i in idx]
    lines = []
    by_label = Counter(str(o.get("label") or "（没有名字的对话）") for o in sel)
    lines.append("  按对话（label）：" + "；".join(f"{k} {v} 条" for k, v in sorted(by_label.items(), key=lambda x: (-x[1], x[0]))))
    by_ext = Counter(str(o.get("ext") or Path(str(o.get("name") or "")).suffix.lower() or "（没有扩展名）") for o in sel)
    lines.append("  按文件类型：" + "；".join(f"{k} {v} 条" for k, v in sorted(by_ext.items(), key=lambda x: (-x[1], x[0]))))
    ts = [o["t"] for o in sel if has_time(o)]
    if ts:
        lines.append(f"  记下的时间：最早 {when(min(ts))}，最晚 {when(max(ts))}")
    if len(ts) < len(sel):
        lines.append(f"  没有记录时间的 {len(sel) - len(ts)} 条")
    gone = sum(1 for o in sel if not Path(str(o.get("path") or "")).is_file())
    if gone:
        lines.append(f"  其中原文件已经不在的 {gone} 条（这些本来就不会在平板上列出来）")
    if names:
        lines.append("  逐条（按记下的时间）：")
        for o in sorted(sel, key=lambda o: o["t"] if has_time(o) else 0):
            t = when(o["t"]) if has_time(o) else "（没有时间）"
            lines.append(f"    {t}　{o.get('label') or ''}　{o.get('name') or Path(str(o.get('path') or '')).name}")
    return lines


# ------------------------------------------------------------ 主流程

def run(data, apply=False, originals=None, before=None, port=None, names=False, now=None):
    """标一遍。返回（退出码, 报告文字）。"""
    data = Path(data).resolve()
    now = now or datetime.now()
    if not data.is_dir():
        return 2, f"没有这个数据文件夹：{data}"
    before_ms = None
    if before is not None:
        try:
            before_ms = day_start_ms(before)
        except ValueError:
            return 2, f"--before 要写成 YYYY-MM-DD（例如 2026-11-14），现在是：{before}"
    if apply:
        originals = Path(originals).resolve() if originals else data.parent / f"data-originals-{now:%Y%m%d-%H%M%S}"
        if originals == data or data in originals.parents:
            return 2, f"--originals 必须在数据文件夹外面：{originals}"
        for p in service_ports(port):
            if service_alive(p):
                return 2, (f"草稿纸服务正在跑（端口 {p}）。要在服务停着时标：服务会同时改 offers.json。"
                           "请先停服务（/bridge/stop），再加 --apply 跑一次。什么都没写。")

    head = [("积压的新文件提示标成已忽略：" + ("正式标（--apply）" if apply else "试跑（什么都没写）")),
            f"数据文件夹：{data}", f"时间：{now:%Y-%m-%d %H:%M:%S}",
            "范围：" + (f"{before} 零点之前记下的待处理提示" if before is not None else "全部待处理的提示"), ""]
    f = data / OFFERS
    if not f.exists():
        return 0, "\n".join(head + [f"没有 {OFFERS}，没有要处理的。"])
    try:
        items = json.loads(f.read_text("utf-8"))
    except (OSError, ValueError) as e:
        return 2, "\n".join(head + [f"{OFFERS} 读不出来（{type(e).__name__}），什么都没写。"])
    if not isinstance(items, list):
        return 2, "\n".join(head + [f"{OFFERS} 里不是一个列表，认不出来，什么都没写。"])

    states = Counter(o.get("state") if isinstance(o, dict) else None for o in items)
    other = len(items) - states["new"] - states["added"] - states["dismissed"]
    marked, later, untimed = pick(items, before_ms)
    lines = head + [f"一共 {len(items)} 条：待处理 {states['new']}，已加进草稿纸 {states['added']}，已忽略 {states['dismissed']}"
                    + (f"，认不出状态的 {other}（不动）" if other else "")]
    if not marked:
        lines.append("没有要处理的：" + ("没有待处理的提示。" if not states["new"] else
                                         f"待处理的 {states['new']} 条都不在这个范围里。"))
        if apply:
            lines.append("什么都没写。")
        return 0, "\n".join(lines)
    lines.append(f"会标成已忽略：{len(marked)} 条")
    lines += summary(items, marked, names)
    if later:
        lines.append(f"待处理但在 {before} 及以后记下的：{len(later)} 条（不动）")
    if untimed:
        lines.append(f"待处理但没有记录时间的：{len(untimed)} 条（用了 --before，分不出先后，不动）")
    lines += ["", "标成已忽略以后：这些不再出现在待处理列表里；同一个文件没改过、再报上来不会再提示；"
              "文件改过（修改时间变了）会作为新的提示出现（服务原来的规矩，没改）。"]

    if not apply:
        return 0, "\n".join(lines)

    new = json.loads(json.dumps(items, ensure_ascii=False))  # 深拷贝，原来的留着复查用
    for i in marked:
        new[i]["state"] = "dismissed"
    dst = originals / OFFERS
    if dst.exists():
        return 1, "\n".join(lines + ["", f"原件的位置已经有文件了，停下：{dst}（什么都没写）"])
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(f, dst)
    write_offers(f, new)
    try:
        again = json.loads(f.read_text("utf-8"))
    except (OSError, ValueError) as e:
        again = e
    bad = check(items, again if isinstance(again, list) else None, marked)
    lines += ["", f"已标 {len(marked)} 条；原来的 {OFFERS} 存在 {dst}"]
    if bad:
        lines += ["写完复查没过（原件在上面那个位置，可以拷回去）：", *("  " + b for b in bad)]
        return 1, "\n".join(lines)
    left = len(pick(again, before_ms)[0])
    if left:
        lines.append(f"写完复查没过：读回来还有 {left} 条在范围里的待处理提示。")
        return 1, "\n".join(lines)
    lines.append("写完从磁盘读回来复查：条数不变，要标的都是已忽略，其余每条和原来一样；范围里没有待处理的了。")
    return 0, "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="把积压的新文件提示标成已忽略（默认只试跑）")
    ap.add_argument("--data", required=True, help="数据文件夹（里面有 offers.json）")
    ap.add_argument("--apply", action="store_true", help="真的写；不加只出报告")
    ap.add_argument("--before", help="只处理这一天（YYYY-MM-DD，本机时间零点）之前记下的")
    ap.add_argument("--originals", help="--apply 时原来的 offers.json 存到这里（必须在数据文件夹外面）")
    ap.add_argument("--names", action="store_true", help="报告里逐条列出文件名")
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
    code, text = run(data, apply=args.apply, originals=args.originals, before=args.before, port=args.port, names=args.names)
    print(text)
    if args.report:
        Path(args.report).write_text(text + "\n", "utf-8")
    return code


if __name__ == "__main__":
    sys.exit(main())

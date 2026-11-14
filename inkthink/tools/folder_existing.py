"""把当时已有的本子一次放进一个文件夹（《产品定义》第 2 节：「做好后把当时已有的本子一次放进一个叫『原先』的文件夹，默认折叠」）。

用法（在 inkthink\\ 下）：
    .venv\\Scripts\\python.exe tools\\folder_existing.py --data data --name 原先            试跑：只报告会放进去哪几本，什么都不写
    .venv\\Scripts\\python.exe tools\\folder_existing.py --data data --name 原先 --apply    真的写（服务要停着）
其他参数：
    --books <文件夹>  导入的书（PDF）在哪；默认是数据文件夹旁边的 books（和 server.py 的默认一样）
    --port <端口>     正式服务的端口；不写就照 launch.py 的办法（config.json 里的 port，没有就是 8765），另外也查 8765

做什么：
- 「能进文件夹的本子」是自己建的空白本子（notebooks/pads.json 里的）和导入的书（books 下的 PDF）；
  草稿本和「Claude 推送」不进文件夹。
- 已经在别的文件夹里的本子不动；这个名字的文件夹已经有了就往里加，没有就新建一个（新建的默认折叠）。
- 只写 notebooks/folders.json 这一个文件（先写临时文件再替换）；不改 pads.json、任何本子的文件夹和书。
- 跑两遍结果一样：第二遍时要放的都已经在里面，什么都不写。
- 服务在跑时拒绝 --apply（平板上可能正同时改文件夹），退出码 2；什么都没写。
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import folders  # noqa: E402


# ------------------------------------------------------------ 服务在不在跑（照 tools/migrate_cards.py，也就是照 launch.py）

def service_ports(port=None):
    if port:
        return [int(port)]
    ports = [8765]
    try:
        import launch  # noqa: E402
        p = launch.port([])
        if p not in ports:
            ports.insert(0, p)
    except Exception:  # noqa: BLE001 - 读不到配置就只查默认端口
        pass
    return ports


def service_alive(port):
    import launch  # noqa: E402
    return launch.alive(port)


# ------------------------------------------------------------ 有哪些本子

def notebooks(data, books):
    """能进文件夹的本子，按抽屉里的顺序（自己建的在前、书在后）：[(id, 名字)]。只读。"""
    out = []
    f = data / "notebooks" / "pads.json"
    if f.exists():
        for p in json.loads(f.read_text("utf-8")):
            if isinstance(p, dict) and p.get("id"):
                out.append(("pad:" + str(p["id"]), str(p.get("title") or "本子")))
    if books.is_dir():
        for p in sorted(x for x in books.iterdir() if x.is_file() and x.suffix.lower() == ".pdf"):
            out.append(("book:" + p.name, p.stem))
    return out


def run(data, name, books=None, apply=False, port=None):
    """返回（退出码, 报告文字）。"""
    data = Path(data).resolve()
    books = Path(books).resolve() if books else data.parent / "books"
    if not (data / "notebooks").is_dir():
        return 2, f"数据文件夹里没有 notebooks：{data}"
    try:
        name = folders.clean_name(name)
    except ValueError:
        return 2, "--name 不能是空的"
    if apply:
        for p in service_ports(port):
            if service_alive(p):
                return 2, (f"草稿纸服务正在跑（端口 {p}）。要在服务停着时做：平板上可能正同时改文件夹。"
                           "请先停服务（/bridge/stop），再加 --apply 跑一次。什么都没写。")
    try:
        items = folders.load(data, strict=True)
        have = notebooks(data, books)
    except (OSError, ValueError) as e:
        return 2, f"读不出来：{e}。什么都没写。"
    target = folders.by_name(items, name)
    put, kept, already = [], [], []
    for nb, title in have:
        holder = folders.folder_of(items, nb)
        if holder is None:
            put.append((nb, title))
        elif holder is target:
            already.append(title)
        else:
            kept.append((title, holder["name"]))

    lines = [f"把已有的本子放进文件夹「{name}」：" + ("正式写（--apply）" if apply else "试跑（什么都没写）"),
             f"数据文件夹：{data}", f"书的文件夹：{books}", ""]
    lines.append(f"文件夹「{name}」" + ("已经有了，往里加" if target else "还没有，新建一个（默认折叠）"))
    lines.append(f"要放进去的：{len(put)} 本")
    lines += [f"  {t}" for _, t in put]
    if already:
        lines.append(f"已经在「{name}」里的：{len(already)} 本（不动）")
        lines += [f"  {t}" for t in already]
    if kept:
        lines.append(f"已经在别的文件夹里的：{len(kept)} 本（不动）")
        lines += [f"  {t}（在「{f}」里）" for t, f in kept]
    if not put and target:
        lines += ["", "没有要放的，什么都没写。"]
        return 0, "\n".join(lines)
    if not apply:
        lines += ["", "这是试跑。加 --apply 才会写进 notebooks/folders.json（服务要停着）。"]
        return 0, "\n".join(lines)
    if target is None:
        target = folders.create(items, name, folded=True)
    for nb, _ in put:
        folders.move(items, nb, target["id"])
    folders.save(data, items)
    lines += ["", f"已写进 {folders.path_of(data)}：「{name}」里现在 {len(target['items'])} 本。"]
    return 0, "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="把已有的本子一次放进一个文件夹（默认只试跑）")
    ap.add_argument("--data", required=True, help="数据文件夹（里面有 notebooks）")
    ap.add_argument("--name", required=True, help="文件夹的名字，比如：原先")
    ap.add_argument("--books", help="导入的书在哪（默认是数据文件夹旁边的 books）")
    ap.add_argument("--apply", action="store_true", help="真的写；不加只出报告")
    ap.add_argument("--port", type=int, help="正式服务的端口（默认照 launch.py）")
    args = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass
    code, text = run(args.data, args.name, books=args.books, apply=args.apply, port=args.port)
    print(text)
    return code


if __name__ == "__main__":
    sys.exit(main())

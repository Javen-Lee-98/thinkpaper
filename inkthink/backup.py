"""每天自动备份最难重建的数据：笔迹和 Claude 的回写（页面文件）、版式、本子设置、状态文件、原文件登记，
Claude 放上来的图（data/figures）、冲突时另存的那份（data/conflicts）。

一天一份 zip，放 data/backups/daily/，留最近 KEEP 份。不备份能重新得到的：导入的书（原件还在电脑上，
另有 books/_原件/）、渲染缓存、投递截图。一份大约几 MB。

恢复：先停掉服务，再运行
    .venv\\Scripts\\python.exe backup.py restore data\\backups\\daily\\inkthink-YYYYMMDD.zip
现在的 data/notebooks 和状态文件会先挪到 data/before-restore-<时间>/，不删。图和另存的那份并回去：
备份里的放回原处，后来才有的留着（图按内容起名、另存的那份名字带时间，不会撞名）。
"""
import os
import shutil
import sys
import threading
import time
import zipfile
from datetime import datetime
from pathlib import Path

KEEP = 7
STATE_SUFFIXES = (".json", ".txt")
DIRS = ("notebooks", "figures", "conflicts")  # data 下整个收进备份的文件夹：页面文件、Claude 放上来的图、冲突时另存的那份


def daily(data, books, now=None):
    """今天还没有就做一份，返回新文件；今天已有返回 None。"""
    now = now or datetime.now()
    data, books = Path(data), Path(books)
    d = data / "backups" / "daily"
    d.mkdir(parents=True, exist_ok=True)
    out = d / f"inkthink-{now:%Y%m%d}.zip"
    if out.exists():
        return None
    tmp = out.with_suffix(".part")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for sub in DIRS:
            if not (data / sub).is_dir():
                continue
            for p in sorted((data / sub).rglob("*")):
                if p.is_file() and p.suffix not in (".tmp", ".part"):
                    z.write(p, "data/" + p.relative_to(data).as_posix())
        for p in sorted(data.iterdir()):
            if p.is_file() and p.suffix in STATE_SUFFIXES:
                z.write(p, "data/" + p.name)
        src = books / "_sources.json"
        if src.exists():
            z.write(src, "books/_sources.json")
        z.writestr("README.txt", f"InkThink 每日备份 {now:%Y-%m-%d %H:%M}。恢复：停掉服务后运行 backup.py restore 这个文件。\n")
    os.replace(tmp, out)
    for old in sorted(d.glob("inkthink-*.zip"))[:-KEEP]:
        old.unlink()
    return out


def start_loop(data, books, every=3600):
    """后台每小时看一次：过了零点就做当天那份。出错只打印，不影响服务。"""
    def loop():
        while True:
            try:
                out = daily(data, books)
                if out:
                    print(f"[备份] {out.name}", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"[备份] 没做成：{e}", flush=True)
            time.sleep(every)
    t = threading.Thread(target=loop, name="daily-backup", daemon=True)
    t.start()
    return t


def restore(zip_path, data, books, now=None):
    """把一份备份放回去。现在的 notebooks 和状态文件先挪到 data/before-restore-<时间>/；
    figures、conflicts 不挪：备份里的放回去，后来才有的留着（以前的备份里没有这两样，恢复它们也不会把现有的图弄丢）。返回那个目录。"""
    now = now or datetime.now()
    data, books = Path(data), Path(books)
    aside = data / f"before-restore-{now:%Y%m%d-%H%M%S}"
    aside.mkdir(parents=True)
    if (data / "notebooks").exists():
        shutil.move(str(data / "notebooks"), str(aside / "notebooks"))
    for p in list(data.iterdir()):
        if p.is_file() and p.suffix in STATE_SUFFIXES:
            shutil.move(str(p), str(aside / p.name))
    if (books / "_sources.json").exists():
        shutil.copy2(books / "_sources.json", aside / "_sources.json")
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            if name == "README.txt" or name.endswith("/"):
                continue
            if name.startswith("data/"):
                dest = data / name[len("data/"):]
            elif name == "books/_sources.json":
                dest = books / "_sources.json"
            else:
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            with z.open(name) as src, open(dest, "wb") as f:
                shutil.copyfileobj(src, f)
    return aside


def main(argv):
    root = Path(__file__).resolve().parent
    data, books = root / "data", root / "books"  # 和 server.py 的默认一样
    if len(argv) >= 2 and argv[0] == "restore":
        aside = restore(argv[1], data, books)
        print(f"已恢复 {argv[1]}；原来的挪到了 {aside}")
        return 0
    if argv and argv[0] == "now":
        out = daily(data, books)
        print(out or "今天已经有一份了")
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

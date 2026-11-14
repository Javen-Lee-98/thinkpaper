"""抽屉里的文件夹（《产品定义》第 2 节，2026-11-14 用户定）：只是本子在抽屉里的归类。

记在草稿纸数据文件夹里的一个小文件 notebooks/folders.json：
    {"v": 1, "folders": [{"id": "f-1a2b3c4d", "name": "原先", "items": ["pad:…", "book:….pdf"], "folded": true}]}
- 只有一层，不套文件夹；一本最多在一个文件夹里。
- items 是本子的 id（和 /api/notebooks 里的一样）；草稿本（scratch）和「Claude 推送」（board）不进文件夹。
- folded：文件夹默认折叠（「原先」那个由 tools/folder_existing.py 建，默认折叠）；每台设备自己点过的折叠状态记在设备上，
  不写这里。
- 不挪动、不改任何本子的数据（pads.json、本子文件夹、书）和电脑上的文件。本子被删、或 items 里有已经不在的本子，都不出错：
  读的时候照样读出来，给平板之前由服务滤掉不在的。

服务（server.py）和一次性的小工具（tools/folder_existing.py）都用这里的读写。
"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

FILE = "folders.json"
FIXED = ("scratch", "board")  # 草稿本、Claude 推送：不进文件夹
NAME_MAX = 40


def path_of(data):
    return Path(data) / "notebooks" / FILE


def load(data, strict=False):
    """读出文件夹列表（按建立的先后）。文件不在是空列表。
    文件坏了：strict 时报错（要往里写时用，免得把读不出来的记录盖掉），否则当作没有。"""
    f = path_of(data)
    if not f.exists():
        return []
    try:
        raw = json.loads(f.read_text("utf-8"))
    except (OSError, ValueError) as e:
        if strict:
            raise ValueError(f"文件夹的记录读不出来（{f.name}）：{e}") from None
        return []
    out, taken = [], set()
    for x in (raw.get("folders") if isinstance(raw, dict) else None) or []:
        if not isinstance(x, dict) or not isinstance(x.get("id"), str) or not x["id"]:
            continue
        items = []
        for i in x.get("items") or []:
            if isinstance(i, str) and i and i not in FIXED and i not in taken:  # 一本只算在第一个文件夹里
                items.append(i)
                taken.add(i)
        fd = {"id": x["id"], "name": str(x.get("name") or "文件夹")[:NAME_MAX], "items": items}
        if x.get("folded") is True:
            fd["folded"] = True
        out.append(fd)
    return out


def save(data, folders):
    """整个写回（先写临时文件再替换）。"""
    f = path_of(data)
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps({"v": 1, "folders": folders}, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, f)


def clean_name(name):
    name = "".join(c for c in str(name or "") if c.isprintable())
    name = " ".join(name.split())[:NAME_MAX]
    if not name:
        raise ValueError("名字是空的")
    return name


def find(folders, fid):
    hit = next((f for f in folders if f["id"] == fid), None)
    if hit is None:
        raise KeyError("没有这个文件夹")
    return hit


def by_name(folders, name):
    return next((f for f in folders if f["name"] == name), None)


def folder_of(folders, nb):
    return next((f for f in folders if nb in f["items"]), None)


def create(folders, name, folded=False):
    """新建一个空文件夹（排在最后），返回它。重名不行。"""
    name = clean_name(name)
    if by_name(folders, name):
        raise ValueError(f"已经有一个叫「{name}」的文件夹了")
    fd = {"id": "f-" + uuid.uuid4().hex[:8], "name": name, "items": []}
    if folded:
        fd["folded"] = True
    folders.append(fd)
    return fd


def rename(folders, fid, name):
    fd = find(folders, fid)
    name = clean_name(name)
    other = by_name(folders, name)
    if other and other is not fd:
        raise ValueError(f"已经有一个叫「{name}」的文件夹了")
    fd["name"] = name
    return fd


def delete(folders, fid):
    """删掉文件夹：里面的本子回到外面（本子本身不动）。返回删掉的那个。"""
    fd = find(folders, fid)
    folders.remove(fd)
    return fd


def forget(folders, nb):
    """这本不在任何文件夹里了（移出、本子被删、新导入的本子用了以前的名字）。改了返回 True。"""
    hit = False
    for f in folders:
        if nb in f["items"]:
            f["items"] = [i for i in f["items"] if i != nb]
            hit = True
    return hit


def move(folders, nb, fid):
    """把这本放进 fid 那个文件夹（先从别的文件夹里拿出来）；fid 为空就是移出文件夹。"""
    if nb in FIXED:
        raise ValueError("草稿本和「Claude 推送」不能放进文件夹")
    target = find(folders, fid) if fid else None
    forget(folders, nb)
    if target is not None:
        target["items"].append(nb)
    return target


def rename_member(folders, old, new):
    """本子的 id 变了（导入的书改名、换成新版时跟着改名）：文件夹里记的也跟着换。改了返回 True。"""
    holder = folder_of(folders, old)
    if old == new or holder is None:
        return False
    forget(folders, new)  # 新名字以前留下的记录（不该有）：去掉，免得一本出现两次
    holder["items"] = [new if i == old else i for i in holder["items"]]
    return True

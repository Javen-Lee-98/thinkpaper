"""抽屉里的文件夹（《产品定义》第 2 节，2026-11-14 用户定）：只是本子在抽屉里的归类。

记在草稿纸数据文件夹里的一个小文件 notebooks/folders.json：
    {"v": 1, "folders": [{"id": "f-1a2b3c4d", "name": "原先", "items": ["pad:…", "book:….pdf"], "folded": true}],
     "top": ["f-1a2b3c4d", "pad:…", …]}
- 只有一层，不套文件夹；一本最多在一个文件夹里。
- items 是本子的 id（和 /api/notebooks 里的一样）；草稿本（scratch）不进文件夹。推送本子（以前那本「Claude 推送」board、
  2026-11-17 起各文件夹的 board:<编号>）和别的本子一样能放进来。
- folded：文件夹默认折叠（「原先」那个由 tools/folder_existing.py 建，默认折叠）；每台设备自己点过的折叠状态记在设备上，
  不写这里。
- 不挪动、不改任何本子的数据（pads.json、本子文件夹、书）和电脑上的文件。本子被删、或 items 里有已经不在的本子，都不出错：
  读的时候照样读出来，给平板之前由服务滤掉不在的。

上下顺序（2026-11-18 用户定：拖动、「⋯」里的上移下移改文件夹和本子的上下顺序，记在电脑上，各台设备一样）：
- top：抽屉最外层从上到下的顺序，文件夹的 id 和不在文件夹里的本子的 id 混排；草稿本不在里面，它总在最上面。
  没有 top（没排过）就是原来的顺序：文件夹按建立的先后在前，接着是不在文件夹里的本子（按 /api/notebooks 的先后）。
  排过以后才有的（新建、新导入的本子，新的推送本子，新建的文件夹，移出文件夹的本子）不记在 top 里，排在「没排过时排在它
  前面、又记在 top 里的那一个」后面——还是挨着原来的邻居；前面一个都没有的排在最前（top_order）。
- 文件夹里的顺序就是 items 的先后，但只在 ordered 为 true 时算数（在文件夹里排过）；没排过的文件夹里照原来按
  /api/notebooks 的先后列（folder_items），放进来的本子也照这个先后。
- 排好的顺序和原来的顺序一样时不记（top 拿掉、ordered 拿掉）：以后照原来的规矩排。
- 本子删掉、改名（书改名、换成新版时 id 会变）、放进文件夹时，top 里记的跟着拿掉或换名字（forget、rename_member），不留下
  对不上的记录。

服务（server.py）和一次性的小工具（tools/folder_existing.py）都用这里的读写。
"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

FILE = "folders.json"
FIXED = ("scratch",)  # 草稿本：不进文件夹（「Claude 推送」2026-11-17 起能进，和普通本子一样）
NAME_MAX = 40


def path_of(data):
    return Path(data) / "notebooks" / FILE


class Folders(list):
    """文件夹列表（按建立的先后），另带 top：抽屉最外层排过的顺序（没排过是 None）。
    是 list，原来按列表用的地方（tools/folder_existing.py、测试）照旧；load 读出来、save 写回时 top 跟着走。"""
    top = None


def load(data, strict=False):
    """读出文件夹列表（按建立的先后）。文件不在是空列表。
    文件坏了：strict 时报错（要往里写时用，免得把读不出来的记录盖掉），否则当作没有。"""
    f = path_of(data)
    out = Folders()
    if not f.exists():
        return out
    try:
        raw = json.loads(f.read_text("utf-8"))
    except (OSError, ValueError) as e:
        if strict:
            raise ValueError(f"文件夹的记录读不出来（{f.name}）：{e}") from None
        return out
    taken = set()
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
        if x.get("ordered") is True:
            fd["ordered"] = True
        out.append(fd)
    top = raw.get("top") if isinstance(raw, dict) else None
    if isinstance(top, list):
        out.top = list(dict.fromkeys(i for i in top if isinstance(i, str) and i and i not in FIXED))
    return out


def save(data, folders):
    """整个写回（先写临时文件再替换）。排过的最外层顺序（top）跟着写。"""
    f = path_of(data)
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    payload = {"v": 1, "folders": list(folders)}
    top = getattr(folders, "top", None)
    if top:
        payload["top"] = top
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), "utf-8")
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


def delete(folders, fid, seq=None):
    """删掉文件夹：里面的本子回到外面（本子本身不动）。返回删掉的那个。
    最外层排过顺序（top 里记着这个文件夹）的：里面的本子按在文件夹里的先后排在文件夹原来的位置上（seq 是全部本子按
    /api/notebooks 的先后，没在文件夹里排过的照它排）；没排过的照原来的规矩排。"""
    fd = find(folders, fid)
    folders.remove(fd)
    top = getattr(folders, "top", None)
    if top and fid in top:
        k = top.index(fid)
        inside = [i for i in (folder_items(fd, seq) if seq is not None else fd["items"]) if i not in top]
        folders.top = top[:k] + inside + top[k + 1:]
    return fd


def forget(folders, nb):
    """这本不在任何文件夹里了（移出、本子被删、新导入的本子用了以前的名字），最外层的顺序里也不再记它。改了返回 True。"""
    hit = False
    for f in folders:
        if nb in f["items"]:
            f["items"] = [i for i in f["items"] if i != nb]
            hit = True
    top = getattr(folders, "top", None)
    if top and nb in top:
        folders.top = [i for i in top if i != nb]
        hit = True
    return hit


def move(folders, nb, fid):
    """把这本放进 fid 那个文件夹（先从别的文件夹里拿出来）；fid 为空就是移出文件夹。"""
    if nb in FIXED:
        raise ValueError("草稿本不能放进文件夹")
    target = find(folders, fid) if fid else None
    forget(folders, nb)
    if target is not None:
        target["items"].append(nb)
    return target


def rename_member(folders, old, new):
    """本子的 id 变了（导入的书改名、换成新版时跟着改名）：文件夹里记的、最外层顺序里记的也跟着换。改了返回 True。"""
    holder = folder_of(folders, old)
    top = getattr(folders, "top", None)
    in_top = bool(top) and old in top
    if old == new or (holder is None and not in_top):
        return False
    forget(folders, new)  # 新名字以前留下的记录（不该有）：去掉，免得一本出现两次
    if holder is not None:
        holder["items"] = [new if i == old else i for i in holder["items"]]
    if in_top:
        folders.top = [new if i == old else i for i in folders.top]
    return True


# -- 上下顺序（2026-11-18）。seq：现在全部本子的 id，按 /api/notebooks 的先后（服务的 nb_seq），就是「原来的顺序」

def folder_items(fd, seq):
    """这个文件夹里现在还在的本子，按抽屉里从上到下的先后：排过的（ordered）按 items，没排过的按 seq。"""
    known = set(seq)
    if fd.get("ordered"):
        return [i for i in fd["items"] if i in known]
    mine = set(fd["items"])
    return [i for i in seq if i in mine]


def natural_top(folders, seq):
    """没排过时最外层的顺序：文件夹按建立的先后，接着是不在文件夹里的本子（按 seq）。"""
    inside = {i for f in folders for i in f["items"]}
    return [f["id"] for f in folders] + [i for i in seq if i not in FIXED and i not in inside]


def top_order(folders, seq):
    """抽屉最外层现在从上到下的顺序（不含草稿本）：top 里记着的按记着的先后；没记着的跟在「原来的顺序里排在它前面、
    又记着的那一个」后面，前面一个都没有的排在最前。"""
    nat = natural_top(folders, seq)
    have = set(nat)
    rec = [i for i in (getattr(folders, "top", None) or []) if i in have]
    recset, head, after, last = set(rec), [], {}, None
    for i in nat:
        if i in recset:
            last = i
        elif last is None:
            head.append(i)
        else:
            after.setdefault(last, []).append(i)
    out = head
    for i in rec:
        out.append(i)
        out += after.get(i, [])
    return out


def settle(folders, seq):
    """排过顺序的（有 top）：先把现在看到的整个最外层记下来，再改。没记着的本子跟着「原来顺序里它前面那一个」走，
    那一个被删、被放进文件夹、改了名时，它会跳到别处去；先记下就不跳。seq 要是改之前的（删掉的本子还在里面）。"""
    if getattr(folders, "top", None):
        folders.top = top_order(folders, seq)


def _insert(lst, x, after, before):
    """lst（不含 x）里给 x 找位置：after 为空排在最前；after 在里面就排在它后面；不在就排在 before 前面；都不在排在最后。"""
    if not after:
        k = 0
    elif after in lst:
        k = lst.index(after) + 1
    elif before and before in lst:
        k = lst.index(before)
    else:
        k = len(lst)
    return lst[:k] + [x] + lst[k:]


def place(folders, seq, x, into="", after=None, before=None):
    """把 x（一本的 id 或一个文件夹的 id）排到 into 这一层：into 为空是最外层，是文件夹的 id 就是那个文件夹里；
    位置见 _insert。本子换了层的顺带放进、移出文件夹（只放进、不挪位置的照旧用 move）。返回 into 那个文件夹（最外层是 None）。
    排出来和原来的顺序一样时不记（见文件开头）。"""
    if x in FIXED:
        raise ValueError("草稿本不能挪")
    is_folder = any(f["id"] == x for f in folders)
    if not is_folder and x not in seq:
        raise KeyError(f"没有这个本子：{x}")
    if into:
        if is_folder:
            raise ValueError("文件夹里不能再放文件夹")
        target = find(folders, into)
        if x not in target["items"]:
            move(folders, x, into)
        known = set(seq)
        cur = [i for i in folder_items(target, seq) if i != x]
        new = _insert(cur, x, after, before)
        members = set(new)
        nat = [i for i in seq if i in members]
        target["items"] = new + [i for i in target["items"] if i not in known and i != x]  # 不认得的（以前就记着的）留在后面，不丢
        if new == nat:
            target.pop("ordered", None)
        else:
            target["ordered"] = True
        return target
    if not is_folder:
        forget(folders, x)  # 在文件夹里的先移出来（最外层记着的也先拿掉，下面重新排）
    cur = [i for i in top_order(folders, seq) if i != x]
    new = _insert(cur, x, after, before)
    folders.top = None if new == natural_top(folders, seq) else new
    return None

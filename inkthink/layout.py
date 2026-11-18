"""本子的页面顺序：显示的第几页是什么（原文件的第几页 / 推送的第几页 / 一张空白纸），
插空白页、删页、恢复、挪页，原文件更新后重排。

每页有一个不变的键：原文件或推送的页是 p0003（笔迹文件 page-0003.json，和以前一样），
插入的空白纸是 b<随机串>（blank-<随机串>.json）。页码会因插页、删页而变，键不变。
"""
import json
import os
import re
import time
import uuid

KEY_RE = re.compile(r"^(p\d{4}|b[0-9a-f]{8})$")


def file_stem(key):
    if not KEY_RE.match(key or ""):
        raise KeyError(f"页的键不对：{key}")
    return ("page-" + key[1:]) if key[0] == "p" else ("blank-" + key[1:])


def new_blank(orient=None):
    """一张空白纸；orient 为 landscape / portrait，不写就按本子的纸张方向。"""
    e = {"key": "b" + uuid.uuid4().hex[:8]}
    if orient in ("landscape", "portrait"):
        e["orient"] = orient
    return e


class Layout:
    """kind：book（原文件的页）、board（推送的页）、scratch / pad（空白本子）；n：来源的页数。"""

    def __init__(self, path, kind, n):
        self.path, self.kind = path, kind
        data = json.loads(path.read_text("utf-8")) if path.exists() else None
        if data:
            self.pages, self.hidden = data.get("pages") or [], data.get("hidden") or []
        else:
            self.pages, self.hidden = self._default(n), []
        self._sync(n)

    def _default(self, n):
        if self.kind == "book":
            return [{"key": f"p{i:04d}", "pdf": i} for i in range(n)]
        if self.kind == "board":
            return [{"key": f"p{i:04d}", "board": i} for i in range(n)]
        return [{"key": f"p{i:04d}"} for i in range(max(1, n))]

    def _sync(self, n):
        """书：去掉超出页数的原文件页、补上缺的；推送：补上新推送的页。"""
        field = {"book": "pdf", "board": "board"}.get(self.kind)
        if not field:
            if not self.pages:
                self.pages = [new_blank()]
            return
        self.pages = [e for e in self.pages if e.get(field, 0) < n]
        self.hidden = [h for h in self.hidden if h["entry"].get(field, 0) < n]
        have = {e[field] for e in self.pages if field in e} | {h["entry"][field] for h in self.hidden if field in h["entry"]}
        for i in range(n):
            if i not in have:
                entry = {"key": f"p{i:04d}", field: i}
                # 插到前一个原文件页（以及跟着它的空白纸）后面
                pos = len(self.pages)
                for k, e in enumerate(self.pages):
                    if field in e and e[field] > i:
                        pos = k
                        break
                self.pages.insert(pos, entry)

    def save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"pages": self.pages, "hidden": self.hidden}, ensure_ascii=False), "utf-8")
        os.replace(tmp, self.path)

    def entry(self, i):
        if not 0 <= i < len(self.pages):
            raise KeyError(f"没有第 {i + 1} 页")
        return self.pages[i]

    def index_of(self, key):
        return next((k for k, e in enumerate(self.pages) if e["key"] == key), None)

    def is_blank(self, i):
        e = self.entry(i)
        return "pdf" not in e and "board" not in e

    def insert_blank(self, after, orient=None):
        """在显示页 after 后插一张空白纸（after = -1 插在最前），返回新页的页码。"""
        pos = max(0, min(after + 1, len(self.pages)))
        self.pages.insert(pos, new_blank(orient))
        return pos

    def move(self, i, j):
        """把显示的第 i 页挪到第 j 页（j 按挪完以后的位置算；抽屉里拖缩略图），返回 j。
        只改页的先后：页的键不变，笔迹文件不用动；删掉的页记的「原来跟在哪一页后面」按键记，也不用改。"""
        n = len(self.pages)
        for k in (i, j):
            if not 0 <= k < n:
                raise KeyError(f"没有第 {k + 1} 页")
        self.pages.insert(j, self.pages.pop(i))
        return j

    def delete(self, i):
        if len(self.pages) <= 1:
            raise ValueError("最后一页不能删")
        e = self.entry(i)
        self.hidden.append({"entry": e, "after": self.pages[i - 1]["key"] if i > 0 else None, "t": int(time.time())})
        del self.pages[i]
        return e

    def restore(self, key):
        """恢复删掉的页：放回原来那一页后面；那一页也不在了就放到最后。返回页码。"""
        h = next((h for h in self.hidden if h["entry"]["key"] == key), None)
        if not h:
            raise KeyError("没有这张删掉的页")
        self.hidden.remove(h)
        if h["after"] is None:
            pos = 0
        else:
            k = self.index_of(h["after"])
            pos = len(self.pages) if k is None else k + 1
        self.pages.insert(pos, h["entry"])
        return pos

    def moved(self):
        """原文件的页在这本里的先后（不算空白纸、删掉的页）不是原文件自己的先后：用户在草稿纸里挪过页序。
        挪了又挪回原样的不算。"""
        seq = [e["pdf"] for e in self.pages if "pdf" in e]
        return any(a > b for a, b in zip(seq, seq[1:]))

    def remap_pdf(self, mapping, n_new):
        """原文件换成新版后重排。mapping[新页号] = 旧页号（新增的页为 None）。

        没挪过页序的书（moved() 为假）：原文件的页按新版里的先后排，和 2026-11-17 以前完全一样。
        挪过的（2026-11-17 用户定，尽量保留用户排的先后）：新版里还在的页按更新前这本里的先后排（原文件自己换了先后也不跟）；
        新版里新加的页跟在新版里它前面那一页后面（连同那一页带着的空白纸），那一页是用户删掉的就再往前找，前面没有页就放最前
        （排在最前面的空白纸后面）。没挪过的书照这条规矩排出来也正是新版里的先后。
        空白纸跟着它前面那一页走；那一页在新版里没了，就跟到这本里再往前最近的、还在的那一页（都没有就放最前）；
        用户删掉的页如果新版里还在，仍然是删除状态。
        """
        old_to_new = {i: j for j, i in enumerate(mapping) if i is not None}
        moved = self.moved()
        # 按这本里的先后分组：最前面的空白纸；每一张原文件页带着它后面的空白纸
        leading, groups = [], []
        for e in self.pages:
            if "pdf" in e:
                groups.append((e["pdf"], []))
            elif groups:
                groups[-1][1].append(e)
            else:
                leading.append(e)
        # 新版里还在的页（换成新页号）；没了的旧页：它后面的空白纸交给这本里排在它前面、还在的那一页
        kept = []
        for i, blanks in groups:
            if i in old_to_new:
                kept.append((old_to_new[i], blanks))
            else:
                (kept[-1][1] if kept else leading).extend(blanks)
        if not moved:
            kept.sort(key=lambda g: g[0])  # 跟原文件（新版）的先后
        # 新加的页挂在新版里它前面最近的、这本里看得见的那一页后面（None：放最前）；连着几张新页按新版的先后挂在同一页后面
        shown, after, anchor = {j for j, _ in kept}, {}, None
        for j in range(n_new):
            i = mapping[j] if j < len(mapping) else None
            if i is None:
                after.setdefault(anchor, []).append(j)
            elif j in shown:
                anchor = j
        entry = lambda j: {"key": f"p{j:04d}", "pdf": j}  # noqa: E731
        pages = list(leading) + [entry(j) for j in after.get(None, [])]
        for j, blanks in kept:
            pages.append(entry(j))
            pages.extend(blanks)
            pages.extend(entry(k) for k in after.get(j, []))
        # 删掉的页：新版里还在的换成新页号；新版里没了的就不用再留着
        new_key = {f"p{i:04d}": f"p{j:04d}" for i, j in old_to_new.items()}
        hidden = []
        for h in self.hidden:
            e = h["entry"]
            if "pdf" in e:
                if e["pdf"] not in old_to_new:
                    continue
                j = old_to_new[e["pdf"]]
                h = dict(h, entry={"key": f"p{j:04d}", "pdf": j})
            if h["after"] and h["after"].startswith("p"):
                h = dict(h, after=new_key.get(h["after"]))
            hidden.append(h)
        self.hidden = hidden
        self.pages = pages

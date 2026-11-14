r"""改电脑上的文件之前留底、撤回，另存时起名字（《产品定义》第 4 节「改电脑上的文件」）。

这个模块只碰两样东西：留底文件夹（root），和撤回时写回的那一个文件。问用户覆盖还是另存、平板上那本
怎么换、纸上怎么标「改成了 / 已撤回」，都是服务的事。不依赖 server.py，不打印；一把锁，服务的多个线程
可以共用一个 Keeper。

服务里怎么用（整个进程共用一个）：

    keeper = Keeper(数据文件夹 / "keep")
    覆盖前：    keeper.keep(原文件, "覆盖前")          抛 KeepError 就别动原文件
    存回 PDF：  keeper.keep(原 PDF, "存回 PDF 前")
    另存：      新 = next_name(原文件)；写出新文件（用独占方式新建，免得盖掉刚好同时出现的同名文件）；
                keeper.keep(原文件, "另存前", saved_as=新)
    撤回：      （文件在那次修改之后又被改过的话，先 keeper.aside(文件, "撤回前") 把现在这份另留一份）
                r = keeper.undo(平板上那本现在对着的文件)
                r["action"] == "restored"：文件已写回上一版，重新转换这本
                r["action"] == "switched"：撤回的是另存，平板上那本换回 r["path"]；r["saved_as"] 留在电脑上，不删
                r["ok"] 为 False：文件没改，把 r["message"] 给用户看
    找原件：    keeper.original(文件)["copy"]           草稿纸第一次改它之前的那份

认文件：按规范化后的绝对路径（解开符号链接；Windows 上不分大小写）。

每个文件留三样，互不占名额：
- 撤回队列：最近 KEEP 版，undo 从新到旧一版版写回去，超了丢最旧的。
- 原件：草稿纸第一次改这个文件之前的那份。它先照常在撤回队列里（是队列里最旧的一条副本）；被挤出队列时
  不删，改名为 original-<编号>.<扩展名> 永远留着，之后不再变，undo 也不碰它。它还在队列里时被撤回了
  （文件回到了最初的样子），就没有要永久留的了，之后再留底的那一版重新算原件。另存那种记录不算原件。
- 另留（aside）：撤回前把「现在这份」另留一份，最多 ASIDES 份。不进撤回队列，undo 永远不会写回它。

另存那一种记在「新文件」名下：另存之后平板上那本对着的是新文件，撤回时拿新文件来问。先撤回的是新文件
后来被覆盖的那几次，再往前一次就是「换回原文件」，之后接着撤回原文件自己的各版。另存时原文件没动，
这条记录不留副本，只记原文件当时的大小和 SHA-256。

留底文件夹的样子：

    keep\
      3f2a9c0d1e4b5a67-报告_v47.pptx\         一个文件一个子文件夹：规范化路径的 SHA-256 前 16 位 + 原文件名
        keep.json                             清单（先写临时文件再替换）
        20261114-153012-123456.pptx           撤回队列里的各版：留底的时刻（到微秒）+ 原扩展名
        20261114-160301-004211.pptx
        original-20261110-090000-000001.pptx  原件，永远留着
        aside\
          20261114-170000-000000.pptx         撤回前另留的
      9b8c7d6e5f4a3b2c-报告_v48.pptx\
        keep.json                             另存出来的新文件：队列里一条「从 报告_v47.pptx 另存」，没有副本

keep.json（各列表都是旧的在前）：
    {"v": 1, "path": "E:\\…\\报告_v47.pptx", "key": "e:\\…\\报告_v47.pptx",
     "versions": [{"id": "20261114-153012-123456", "t": "2026-11-14T15:30:12", "kind": "copy",
                   "path": "E:\\…\\报告_v47.pptx", "saved_as": null, "size": 81234, "sha256": "…",
                   "note": "覆盖前", "file": "20261114-153012-123456.pptx"}],
     "original": {"id": "20261110-090000-000001", "kind": "original", …, "file": "original-20261110-090000-000001.pptx"},
     "asides": [{"id": "20261114-170000-000000", "kind": "aside", …, "file": "20261114-170000-000000.pptx"}]}
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

KEEP = 5                    # 撤回队列：每个文件最多留几版
ASIDES = 5                  # 撤回前另留的：每个文件最多几份
MANIFEST = "keep.json"      # 每个子文件夹里的清单
ASIDE_DIR = "aside"         # 另留的放在这个子文件夹里
ORIG_PREFIX = "original-"   # 原件的文件名开头；这种名字的文件，这个模块从来不删
TMP_PREFIX = ".~inkthink-"  # 撤回时先写在原文件旁边的临时文件；服务的「新文件」提示不列 .~ 开头的
NAME_MAX = 50               # 子文件夹名里，原文件名最多留几个字
CHUNK = 1 << 20

_ID = re.compile(r"^(\d{8}-\d{6}-\d{6})(?:-(\d+))?$")
_COPY = re.compile(r"^(\d{8}-\d{6}-\d{6}(?:-\d+)?)(\.[^.\\/:*?\"<>|]{1,16})?$")  # 副本的名字：只能是这个样子
_ORIG = re.compile(r"^original-(\d{8}-\d{6}-\d{6}(?:-\d+)?)(\.[^.\\/:*?\"<>|]{1,16})?$")
_EXT = re.compile(r"^\.[^.\\/:*?\"<>|]{1,16}$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_BAD = '<>:"/\\|?*'
_VER = re.compile(r"^(.*?)([vV])([0-9]+)$", re.S)              # 末尾的版本号：v47、V09
_GAI = re.compile(r"^(.*?)(\s*[(（]改)([0-9]+)([)）])$", re.S)  # 末尾的「 (改N)」，全角括号也认
_REBUILT = "（清单坏了，按副本找回的）"


class KeepError(ValueError):
    """留底没做成（找不到文件、读不了、留底文件夹写不进去……）。消息是给人看的中文。"""


class _SrcError(Exception):
    """抄文件时读的那一头出错（和写的那一头分开，好说清楚是哪个文件的问题）。"""

    def __init__(self, err):
        super().__init__(str(err))
        self.err = err


# -- 另存起名


def _plus1(digits):
    return str(int(digits) + 1).zfill(len(digits))  # 位数不变少：09 → 10，99 → 100


def _bump(stem):
    m = _GAI.match(stem)
    if m:
        return m.group(1) + m.group(2) + _plus1(m.group(3)) + m.group(4)
    m = _VER.match(stem)
    if m:
        return m.group(1) + m.group(2) + _plus1(m.group(3))
    return stem + " (改1)"


def next_name(path):
    """另存时的新文件（完整路径，放在原文件旁边）。不建文件，只算名字。

    - 文件名（不含扩展名）末尾是版本号：v 或 V 加数字，前面是 _、-、空格或直接连着都行 → 数字加一，
      位数不变少：报告_v47.pptx → 报告_v48.pptx，报告-V09.docx → 报告-V10.docx
    - 末尾是「 (改N)」（全角括号也认）→ N 加一：报告 (改1).docx → 报告 (改2).docx
    - 其余加「 (改1)」：报告.docx → 报告 (改1).docx；进展_v47_按意见修改6.pptx、方案_修订31.pptx 也算这一种
      （2026-11-14 用户定：只认 v 加数字）
    算出来的名字在那个文件夹里已经有了（文件或文件夹，不分大小写），就照同样的规则往后顺延，直到没有重名。
    """
    p = os.path.abspath(os.fspath(path))
    folder, name = os.path.split(p)
    stem, ext = os.path.splitext(name)
    try:
        taken = {n.casefold() for n in os.listdir(folder)}
    except OSError:  # 文件夹不在：没有重名可言
        taken = set()
    cand = stem
    for _ in range(100000):
        cand = _bump(cand)
        new = cand + ext
        if new.casefold() not in taken and not os.path.lexists(os.path.join(folder, new)):
            return os.path.join(folder, new)
    raise KeepError(f"给 {name} 找不到没被占用的新名字")


# -- 小工具


def _real(path):
    """绝对路径，解开符号链接（文件不在也行）。"""
    p = os.fspath(path)
    if not p:
        raise KeepError("没给文件路径")
    p = os.path.abspath(p)
    try:
        return os.path.realpath(p)
    except (OSError, ValueError):
        return p


def _key(real):
    return os.path.normcase(real)  # Windows：转小写、斜杠统一成反斜杠


def _hash(key):
    return hashlib.sha256(key.encode("utf-8", "surrogatepass")).hexdigest()[:16]


def _ext(path):
    ext = os.path.splitext(os.fspath(path))[1]
    return ext if _EXT.match(ext) else ""


def _dir_name(key, real):
    name = "".join("_" if c in _BAD or ord(c) < 32 else c for c in os.path.basename(real))
    if len(name) > NAME_MAX:
        stem, ext = os.path.splitext(name)
        ext = ext if len(ext) <= 16 else ""
        name = stem[:NAME_MAX - len(ext)] + ext
    return f"{_hash(key)}-{name.rstrip(' .') or '文件'}"


def _id_order(i):
    m = _ID.match(i)
    return m.group(1), int(m.group(2) or 1)


def _t_of(i):
    try:
        return datetime.strptime(i[:15], "%Y%m%d-%H%M%S").isoformat(timespec="seconds")
    except ValueError:
        return ""


def _when(r):
    return (r.get("t") or "").replace("T", " ") or r["id"]


def _sha_file(path):
    h, n = hashlib.sha256(), 0
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(CHUNK), b""):
            h.update(b)
            n += len(b)
    return n, h.hexdigest()


def _copy(src, dst):
    """把 src 抄成 dst（dst 必须还不存在），边抄边算。返回 (大小, SHA-256)：记下的就是抄下来的那些字节。
    读 src 出错抛 _SrcError，写 dst 出错照常抛 OSError（调用方删掉写了一半的 dst）。"""
    h, n = hashlib.sha256(), 0
    try:
        fi = open(src, "rb")
    except OSError as e:
        raise _SrcError(e) from None
    with fi, open(dst, "xb") as fo:
        while True:
            try:
                b = fi.read(CHUNK)
            except OSError as e:
                raise _SrcError(e) from None
            if not b:
                break
            h.update(b)
            fo.write(b)
            n += len(b)
        fo.flush()
        os.fsync(fo.fileno())
    return n, h.hexdigest()


def _unlink(p):
    """删留底文件夹里的东西（和撤回时自己写的临时文件）。原件（original- 开头）无论如何不删。"""
    if os.path.basename(p).startswith(ORIG_PREFIX):
        return
    try:
        os.remove(p)
    except OSError:
        pass


def _swap(src, dst):
    """留底文件夹里的改名。杀毒、索引程序偶尔会短暂占着刚写好的文件：稍等再试两次。"""
    for i in range(3):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == 2:
                raise
            time.sleep(0.05 * (i + 1))


def _put_in_place(tmp, target):
    """撤回的最后一步：同一个文件夹里改名换上，要么换成，要么原文件原样不动。单独一个函数，测试里好打桩。"""
    os.replace(tmp, target)


def _clean(x, kinds):
    """清单里的一条记录：对就整理好返回，不对返回 None。副本的名字只能是「时刻 + 扩展名」（原件另有
    original- 开头的名字），指不到别处去。"""
    if not isinstance(x, dict):
        return None
    i, kind, size, sha, path = x.get("id"), x.get("kind"), x.get("size"), x.get("sha256"), x.get("path")
    if not (isinstance(i, str) and _ID.match(i) and kind in kinds and type(size) is int and size >= 0
            and isinstance(sha, str) and _SHA.match(sha) and isinstance(path, str) and path):
        return None
    note = x.get("note")
    r = {"id": i, "t": x["t"] if isinstance(x.get("t"), str) else _t_of(i), "kind": kind, "path": path,
         "saved_as": None, "size": size, "sha256": sha, "note": note if isinstance(note, str) else "", "file": None}
    if kind == "saveas":
        sa = x.get("saved_as")
        if not (isinstance(sa, str) and sa):
            return None
        r["saved_as"] = sa
        return r
    f = x.get("file")
    m = (_COPY.match(f) or (_ORIG.match(f) if kind == "original" else None)) if isinstance(f, str) else None
    if not m or m.group(1) != i:
        return None
    r["file"] = f
    return r


def _scan(d, real, kind):
    """清单坏了时，按文件夹 d 里的副本拼出记录（旧的在前）。"""
    found = []
    try:
        entries = list(os.scandir(d))
    except OSError:
        return []
    for e in entries:
        m = _COPY.match(e.name)
        if not m or not e.is_file():
            continue
        try:
            size, sha = _sha_file(e.path)
        except OSError:
            continue
        i = m.group(1)
        found.append({"id": i, "t": _t_of(i), "kind": kind, "path": real, "saved_as": None,
                      "size": size, "sha256": sha, "note": _REBUILT, "file": e.name})
    found.sort(key=lambda r: _id_order(r["id"]))
    return found


def _orig_names(o):
    """原件的两个可能的名字：(original-编号.扩展名, 编号.扩展名)。后者是挪名字那一步没做成时留下的。"""
    m = _ORIG.match(o["file"]) or _COPY.match(o["file"])
    ext = m.group(2) or ""
    return f"{ORIG_PREFIX}{o['id']}{ext}", f"{o['id']}{ext}"


def _orig_path(folder, o):
    for name in (o["file"], *_orig_names(o)):
        if (folder / name).is_file():
            return folder / name
    return folder / o["file"]


def _public(folder, r, warns=None):
    """给调用方的记录：不带清单里的内部字段 file，换成副本的完整路径 copy；missing：副本不见了。"""
    out = {k: r[k] for k in ("id", "t", "kind", "path", "saved_as", "size", "sha256", "note")}
    if r["file"]:
        p = _orig_path(folder, r) if r["kind"] == "original" else folder / r["file"]
        out["copy"], out["missing"] = str(p), not p.is_file()
    else:
        out["copy"], out["missing"] = None, False
    if warns is not None:
        out["warning"] = "；".join(warns) or None
    return out


def _result(ok, action, path, message, record=None, saved_as=None, recreated=False, left=0, warning=None):
    return {"ok": ok, "action": action, "path": path, "saved_as": saved_as, "record": record,
            "recreated": recreated, "left": left, "message": message, "warning": warning}


def _empty():
    return {"versions": [], "original": None, "asides": []}


# -- 留底


class Keeper:
    """留底文件夹 root（以后是 <数据文件夹>\\keep）。除了 undo 写回的那一个文件，不碰 root 外面的任何东西。"""

    next_name = staticmethod(next_name)

    def __init__(self, root):
        self.root = Path(root)
        self._lock = threading.RLock()

    # 公开的

    def keep(self, path, note="", saved_as=None):
        """把 path 现在的内容留一份，放进撤回队列。返回这条记录（字段见 history），另带 warning：留底文件夹里
        有不对劲的地方（清单坏了已重建、有副本不见了）时是一句说明，否则 None。

        和撤回队列里最近一版的内容一样（逐字节）就不重复留，返回已有的那条。
        saved_as：这次是另存，原文件不动，新文件是 saved_as。记在新文件名下，不留副本，只记原文件当时的大小
        和 SHA-256；撤回这条时不改任何文件，只告诉调用方平板上那本该换回原文件。
        做不成时抛 KeepError（中文说明）：这时不要去动原文件。
        """
        real = _real(path)
        key = _key(real)
        self._need_file(real)
        note = "" if note is None else str(note)
        if saved_as is None:
            chain_real, chain_key = real, key
        else:
            chain_real = _real(saved_as)
            chain_key = _key(chain_real)
            if chain_key == key:
                raise KeepError("另存的新文件和原文件是同一个文件")
        with self._lock:
            folder, m, warns = self._open(chain_key, chain_real)
            versions = m["versions"]
            gone = {r["id"] for r in versions if r["file"] and not (folder / r["file"]).is_file()}
            if gone:  # 副本被人删了的记录撤不回，留着没用
                m["versions"] = versions = [r for r in versions if r["id"] not in gone]
                warns.append(f"有 {len(gone)} 版的副本不见了（可能被手动删了），这几条记录去掉了")
            last = versions[-1] if versions else None
            now = datetime.now().isoformat(timespec="seconds")
            if saved_as is None:
                ext = _ext(real)
                new_id = self._new_id(folder, versions, ext)
                size, sha, final = self._take(real, folder, new_id, ext)
                if last and last["kind"] == "copy" and (last["size"], last["sha256"]) == (size, sha):
                    _unlink(final)
                    if gone:
                        self._save(folder, chain_key, chain_real, m)
                    return _public(folder, last, warns)
                rec = {"id": new_id, "t": now, "kind": "copy", "path": real, "saved_as": None,
                       "size": size, "sha256": sha, "note": note, "file": final.name}
            else:
                try:
                    size, sha = _sha_file(real)
                except OSError as e:
                    raise KeepError(f"读不了要留底的文件（{real}）：{e}") from None
                if last and last["kind"] == "saveas" and _key(last["path"]) == key and last["sha256"] == sha:
                    if gone:
                        self._save(folder, chain_key, chain_real, m)
                    return _public(folder, last, warns)
                rec = {"id": self._new_id(folder, versions, ""), "t": now, "kind": "saveas", "path": real,
                       "saved_as": chain_real, "size": size, "sha256": sha, "note": note, "file": None}
            versions.append(rec)
            try:
                self._save(folder, chain_key, chain_real, m)
            except KeepError:
                if rec["file"]:
                    _unlink(folder / rec["file"])
                raise
            return _public(folder, rec, warns)

    def aside(self, path, note=""):
        """撤回前把 path 现在的内容另留一份（调用方发现文件在那次修改之后又被改过时用）。返回这条记录
        （kind 为 "aside"，字段同 history，另带 warning）。

        不进撤回队列、不占它的名额，undo 永远不会写回它；每个文件最多留 ASIDES 份，超了丢最旧的；
        和最近一份另留的内容一样就不重复留，返回已有的那条。出错和 keep 一样抛 KeepError。
        """
        real = _real(path)
        key = _key(real)
        self._need_file(real)
        note = "" if note is None else str(note)
        with self._lock:
            folder, m, warns = self._open(key, real)
            d = folder / ASIDE_DIR
            try:
                d.mkdir(exist_ok=True)
            except OSError as e:
                raise KeepError(f"留底文件夹建不起来（{d}）：{e}") from None
            asides = m["asides"]
            gone = {r["id"] for r in asides if not (d / r["file"]).is_file()}
            if gone:
                m["asides"] = asides = [r for r in asides if r["id"] not in gone]
                warns.append(f"另留的有 {len(gone)} 份不见了（可能被手动删了），这几条记录去掉了")
            ext = _ext(real)
            new_id = self._new_id(d, asides, ext)
            size, sha, final = self._take(real, d, new_id, ext)
            last = asides[-1] if asides else None
            if last and (last["size"], last["sha256"]) == (size, sha):
                _unlink(final)
                if gone:
                    self._save(folder, key, real, m)
                return _public(d, last, warns)
            rec = {"id": new_id, "t": datetime.now().isoformat(timespec="seconds"), "kind": "aside", "path": real,
                   "saved_as": None, "size": size, "sha256": sha, "note": note, "file": final.name}
            asides.append(rec)
            try:
                self._save(folder, key, real, m)
            except KeepError:
                _unlink(final)
                raise
            return _public(d, rec, warns)

    def history(self, path):
        """这个文件撤回队列里现在留着的各版，新的在前（undo 先取第一条）。没有留底返回 []。只读，不改任何文件。
        不含永久的原件（见 original）和另留的（见 asides）。

        每条是一个字典：
            id        编号（留底的时刻，到微秒；同一组里不重复）
            t         留底的时刻，如 "2026-11-14T15:30:12"
            kind      "copy"：留了原文件的副本；"saveas"：另存（原文件没动，没有副本）；
                      original 和 asides 返回的分别是 "original"、"aside"
            path      原文件
            saved_as  另存出来的新文件；别的是 None
            size、sha256   原文件当时的大小和内容的 SHA-256
            note      留底时给的说明（「覆盖前」「存回 PDF 前」「另存前」……）
            copy      副本的完整路径；saveas 那种是 None
            missing   副本不见了（被手动删了）：这一版撤不回
        清单读不出来时，按文件夹里的副本临时拼出各版（说明写着「清单坏了」），不写回。
        """
        folder, m = self._peek(path)
        return [_public(folder, r) for r in reversed(m["versions"][-KEEP:])] if folder else []

    def original(self, path):
        """原件：草稿纸第一次改这个文件之前的那份。没有返回 None。只读。

        返回的记录（字段同 history）另带 permanent：
            True   已被挤出撤回队列，放在留底文件夹里 original- 开头的那个文件，永远留着、不再变
            False  还在撤回队列里（是队列里最旧的那条副本）：被撤回的话它就没了（文件本身回到了原件的样子），
                   被挤出队列时挪到永久的位置
        copy 是它现在的完整路径。
        """
        folder, m = self._peek(path)
        if not folder:
            return None
        if m["original"]:
            out = _public(folder, m["original"])
            out["permanent"] = True
            return out
        cand = next((r for r in m["versions"] if r["file"]), None)
        if cand is None:
            return None
        out = _public(folder, cand)
        out["permanent"] = False
        return out

    def asides(self, path):
        """撤回前另留的各份，新的在前（字段同 history，kind 为 "aside"，copy 是完整路径）。没有返回 []。只读。"""
        folder, m = self._peek(path)
        return [_public(folder / ASIDE_DIR, r) for r in reversed(m["asides"][-ASIDES:])] if folder else []

    def undo(self, path):
        """撤回一次：取走这个文件撤回队列里最近的那一条。永久的原件和另留的都不碰。返回一个字典：

            ok         这次撤回成了没有
            action     "restored"  把那一版写回了 path（逐字节相同）；原文件不在时照样写出来，recreated 为 True
                       "switched"  撤回的是另存：没改任何文件；path 是平板上那本该换回的原文件，
                                   saved_as 是另存出来的新文件（留在电脑上，不删）
                       "nothing"   没有可撤回的，什么都没动
                       "skipped"   最近那一版的副本不见了或和记下的不一样：文件没动，这条用不了的记录去掉了，
                                   再撤一次就是再往前那一版
                       "failed"    写不回去（文件被别的程序占着、所在文件夹没了……）：文件没动，留底还在
            path       写回的文件（switched 时是原文件）
            saved_as   switched 时另存出来的新文件，否则 None
            record     取走（或去掉）的那条记录，字段同 history
            recreated  原文件刚才不在、按留底重新写了出来
            left       这个文件的撤回队列里还剩几条
            message    给用户看的一句话
            warning    留底文件夹里有不对劲的地方（清单坏了已重建……）时的说明，否则 None

        写回之前不自动另留（要留由调用方先调 aside）：撤回不能再「重做」。写回时先在原文件旁边写一个
        .~inkthink- 开头的临时文件，核对内容后一步换上；中途出错临时文件删掉，原文件不动。
        """
        real = _real(path)
        key = _key(real)
        with self._lock:
            folder = self._find(key)
            if folder is None:
                return _result(False, "nothing", real, "这个文件没有留底，没有可撤回的。")
            try:
                m, warn = self._load(folder, key, real, repair=True)
            except KeepError as e:
                return _result(False, "failed", real, f"{e}。文件没动。")
            versions = m["versions"]
            if not versions:
                return _result(False, "nothing", real, f"没有可撤回的了（每个文件最多往回撤 {KEEP} 版）。", warning=warn)
            rec = versions[-1]
            pub = _public(folder, rec)
            if rec["kind"] == "saveas":
                return self._undo_saveas(folder, key, real, m, pub, warn)
            label = f"{_when(rec)} 留的那一版" + (f"（{rec['note']}）" if rec["note"] else "")
            src = folder / rec["file"]
            if not src.is_file():
                return self._drop(folder, key, real, m, pub, warn,
                                  f"{label}的留底副本不见了（可能被手动删了），撤不回这一版", bad=None)
            # 原文件不在、换个大小写来问时，按当初留底时的写法写回去，名字不变样
            target = real if os.path.lexists(real) or _key(rec["path"]) != key else rec["path"]
            parent = os.path.dirname(target)
            if not os.path.isdir(parent):
                return _result(False, "failed", target, f"原文件所在的文件夹不在了（{parent}），没写回；留底还在。",
                               record=pub, left=len(versions), warning=warn)
            if os.path.lexists(target) and not os.path.isfile(target):
                return _result(False, "failed", target, f"{target} 现在不是一个文件，没写回；留底还在。",
                               record=pub, left=len(versions), warning=warn)
            existed = os.path.isfile(target)
            tmp = os.path.join(parent, f"{TMP_PREFIX}{uuid.uuid4().hex[:8]}{_ext(target)}")
            try:
                try:
                    size, sha = _copy(src, tmp)
                except _SrcError as e:
                    return _result(False, "failed", target, f"{label}的留底副本读不出来（{e.err}），没写回；留底还在。",
                                   record=pub, left=len(versions), warning=warn)
                if (size, sha) != (rec["size"], rec["sha256"]):
                    return self._drop(folder, key, real, m, pub, warn,
                                      f"{label}的留底副本和当初记下的不一样（被改过或坏了），没写回", bad=src)
                _put_in_place(tmp, target)
            except PermissionError:
                return _result(False, "failed", target,
                               "文件正被别的程序占用（比如 Word、PowerPoint 开着它），或者是只读的、没有权限写，"
                               "没写回：关掉后再撤回。文件没动，留底还在。", record=pub, left=len(versions), warning=warn)
            except OSError as e:
                return _result(False, "failed", target, f"写回没成（{e}）。文件没动，留底还在。",
                               record=pub, left=len(versions), warning=warn)
            finally:
                _unlink(tmp)
            versions.pop()
            warns = [warn] if warn else []
            try:
                self._save(folder, key, real, m)
            except KeepError as e:
                warns.append(f"文件已写回，但留底清单没更新（{e}）：下次撤回会再写一遍同一版")
            else:
                _unlink(src)
            msg = f"已撤回到 {label}。"
            if not existed:
                msg += "原文件刚才不在，已按留底重新写了出来。"
            msg += f"还能再往回撤 {len(versions)} 次。" if versions else "再往前没有留底了。"
            return _result(True, "restored", target, msg, record=pub, recreated=not existed, left=len(versions),
                           warning="；".join(warns) or None)

    # 内部

    @staticmethod
    def _need_file(real):
        if not os.path.isfile(real):
            raise KeepError(f"{real} 不是文件，不能留底" if os.path.exists(real) else f"找不到要留底的文件：{real}")

    def _open(self, key, real):
        """要往里写时用：找到（没有就建）这个文件的子文件夹，读清单（坏了就修）。返回 (文件夹, 清单, 说明列表)。"""
        folder = self._find(key)
        if folder is None:
            folder = self.root / _dir_name(key, real)
            try:
                folder.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                raise KeepError(f"留底文件夹建不起来（{folder}）：{e}") from None
            return folder, _empty(), []
        m, w = self._load(folder, key, real, repair=True)
        return folder, m, [w] if w else []

    def _peek(self, path):
        """只读时用：(文件夹, 清单)；没有留底或清单记的是别的文件时 (None, None)。"""
        real = _real(path)
        key = _key(real)
        with self._lock:
            folder = self._find(key)
            if folder is None:
                return None, None
            try:
                m, _ = self._load(folder, key, real, repair=False)
            except KeepError:
                return None, None
            return folder, m

    @staticmethod
    def _take(real, d, new_id, ext):
        """把 real 抄进 d，名字是「编号 + 扩展名」（先抄成 .part 再改名）。返回 (大小, SHA-256, 副本路径)。"""
        part = d / f"{new_id}{ext}.part"
        final = d / f"{new_id}{ext}"
        try:
            size, sha = _copy(real, part)
        except _SrcError as e:
            _unlink(part)
            raise KeepError(f"读不了要留底的文件（{real}）：{e.err}") from None
        except OSError as e:
            _unlink(part)
            raise KeepError(f"留底的副本写不进去（{d}）：{e}") from None
        try:
            _swap(part, final)
        except OSError as e:
            _unlink(part)
            raise KeepError(f"留底的副本写不进去（{final}）：{e}") from None
        return size, sha, final

    def _undo_saveas(self, folder, key, real, m, pub, warn):
        rec = m["versions"].pop()
        try:
            self._save(folder, key, real, m)
        except KeepError as e:
            return _result(False, "failed", rec["path"], f"撤回另存没做成：{e}", record=pub,
                           left=len(m["versions"]) + 1, warning=warn)
        msg = (f"已撤回另存：平板上那本该换回原文件 {rec['path']}；"
               f"另存出来的 {rec['saved_as']} 留在电脑上，没删。")
        if not os.path.isfile(rec["path"]):
            msg += "注意：原文件现在不在那个位置了。"
        return _result(True, "switched", rec["path"], msg, record=pub, saved_as=rec["saved_as"],
                       left=len(m["versions"]), warning=warn)

    def _drop(self, folder, key, real, m, pub, warn, why, bad):
        """最近那一版用不了：去掉这条记录，文件不动。不跳过它去写更早的一版——那会一下子退回好几次修改。"""
        versions = m["versions"]
        versions.pop()
        try:
            self._save(folder, key, real, m)
        except KeepError as e:
            return _result(False, "failed", real, f"{why}；这条记录也没能去掉（{e}）。文件没动。",
                           record=pub, left=len(versions) + 1, warning=warn)
        if bad is not None:  # 内容不对的副本改个名留着（不再算作副本），不删
            try:
                os.replace(bad, bad.with_name(bad.name + ".bad"))
            except OSError:
                pass
        nxt = versions[-1] if versions else None
        msg = f"{why}；文件没动。这条记录已去掉，"
        msg += (f"再点撤回会接着撤 {_when(nxt)} 那一次" + (f"（{nxt['note']}）。" if nxt["note"] else "。")) if nxt \
            else "再往前没有留底了。"
        return _result(False, "skipped", real, msg, record=pub, left=len(versions), warning=warn)

    def _find(self, key):
        """这个文件的子文件夹（按哈希前缀找，文件名换了大小写也认得），没有返回 None。"""
        prefix = _hash(key) + "-"
        try:
            with os.scandir(self.root) as it:
                hits = sorted(e.name for e in it if e.name.startswith(prefix) and e.is_dir())
        except OSError:
            return None
        return self.root / hits[0] if hits else None

    def _load(self, folder, key, real, repair):
        """读清单。返回 ({"versions", "original", "asides"}，说明或 None)。

        清单不见了或读不出来：按文件夹里的副本重建（说明文字和另存记录找不回来）；repair 时把坏清单改名留着、
        写下重建的。单条记录不对：去掉那一条（它的文件不删）。清单里没记原件、文件夹里却有 original- 开头的
        文件（重建时、那一项坏了时）：认回来。清单记的是另一个文件：抛 KeepError，不碰它。
        """
        f = folder / MANIFEST
        raw, broken = None, None
        try:
            raw = json.loads(f.read_text("utf-8"))
            if not isinstance(raw, dict) or not isinstance(raw.get("versions"), list):
                broken = "格式不对"
        except FileNotFoundError:
            broken = "不见了"
        except (OSError, ValueError) as e:
            broken = f"读不出来（{e.__class__.__name__}）"
        notes, changed = [], False
        if broken is None:
            if isinstance(raw.get("key"), str) and raw["key"] != key:
                raise KeepError(f"留底文件夹 {folder} 记的是另一个文件（{raw.get('path')}），没动它")
            raw_a = raw.get("asides") if isinstance(raw.get("asides"), list) else []
            raw_o = raw.get("original")
            m = {"versions": [r for r in (_clean(x, ("copy", "saveas")) for x in raw["versions"]) if r],
                 "asides": [r for r in (_clean(x, ("aside",)) for x in raw_a) if r],
                 "original": _clean(raw_o, ("original",)) if raw_o is not None else None}
            bad = (len(raw["versions"]) - len(m["versions"]) + len(raw_a) - len(m["asides"])
                   + (raw_o is not None and m["original"] is None))
            if bad:
                notes.append(f"留底清单里有 {bad} 条记录不对，去掉了")
                changed = True
        else:
            m = {"versions": _scan(folder, real, "copy"), "original": None,
                 "asides": _scan(folder / ASIDE_DIR, real, "aside")}
            changed = True
        if m["original"] is None:
            o = self._found_original(folder, real)
            if o is not None:
                m["original"] = o
                m["versions"] = [r for r in m["versions"] if r["id"] != o["id"]]
                changed = True
        elif repair:
            changed = self._heal_original(folder, m["original"]) or changed
        if broken is not None:
            if broken == "不见了" and not (m["versions"] or m["asides"] or m["original"]):
                return m, None
            notes.insert(0, f"这个文件的留底清单{broken}，按文件夹里留着的副本重建了（原来写的说明和另存的记录找不回来）")
        if repair and changed:
            if broken not in (None, "不见了"):
                aside = folder / f"{MANIFEST}.bad-{datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:4]}"
                try:
                    _swap(f, aside)
                    notes.append(f"坏的清单改名为 {aside.name} 留着")
                except OSError:
                    pass
            self._save(folder, key, real, m)
        return m, "；".join(notes) or None

    @staticmethod
    def _found_original(folder, real):
        """文件夹里 original- 开头的文件（不止一个时取最早的），认作原件；没有返回 None。"""
        best = None
        try:
            entries = list(os.scandir(folder))
        except OSError:
            return None
        for e in entries:
            mo = _ORIG.match(e.name)
            if mo and e.is_file() and (best is None or _id_order(mo.group(1)) < _id_order(best[0])):
                best = (mo.group(1), e)
        if best is None:
            return None
        try:
            size, sha = _sha_file(best[1].path)
        except OSError:
            return None
        i = best[0]
        return {"id": i, "t": _t_of(i), "kind": "original", "path": real, "saved_as": None,
                "size": size, "sha256": sha, "note": "（按文件认回的原件）", "file": best[1].name}

    @staticmethod
    def _heal_original(folder, o):
        """原件挪到永久名字那一步上次没做成（文件还叫「编号.扩展名」）：补上。改了清单返回 True。"""
        want, plain = _orig_names(o)
        if (folder / want).is_file():
            if o["file"] != want:
                o["file"] = want
                return True
            return False
        if (folder / plain).is_file():
            try:
                _swap(folder / plain, folder / want)
                o["file"] = want
                return True
            except OSError:
                if o["file"] != plain:
                    o["file"] = plain
                    return True
        return False

    def _save(self, folder, key, real, m):
        """写清单（先写临时文件再替换）。撤回队列超过 KEEP 版、另留的超过 ASIDES 份时丢最旧的（列表就地截短）。

        被挤出队列的最旧一条副本，如果这个文件还没有永久的原件，它就是原件：不删，改名为 original-<编号>，
        记到 original 里。清单先写好再改名；改名没做成时文件还叫原来的名字，下次读清单时补上，也照样找得到。
        """
        versions, asides = m["versions"], m["asides"]
        drop = versions[:-KEEP] if len(versions) > KEEP else []
        del versions[:len(drop)]
        drop_a = asides[:-ASIDES] if len(asides) > ASIDES else []
        del asides[:len(drop_a)]
        move = None
        if m["original"] is None:
            cand = next((r for r in drop if r["file"]), None)
            if cand is not None:
                want, plain = _orig_names({**cand, "kind": "original"})
                name = plain if (folder / want).exists() else want  # 已有同名的永久文件：不盖它，原件就留在原名字下
                m["original"] = {**cand, "kind": "original", "file": name}
                if name == want:
                    move = (folder / cand["file"], folder / want)
        f = folder / MANIFEST
        tmp = folder / f"{MANIFEST}.{uuid.uuid4().hex[:8]}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
                json.dump({"v": 1, "path": real, "key": key, "versions": versions, "original": m["original"],
                           "asides": asides}, fh, ensure_ascii=False, indent=1)
                fh.flush()
                os.fsync(fh.fileno())
            _swap(tmp, f)
        except OSError as e:
            _unlink(tmp)
            raise KeepError(f"留底清单写不进去（{f}）：{e}") from None
        if move:
            try:
                _swap(*move)
            except OSError:
                pass
        keep_name = m["original"]["file"] if m["original"] else None
        for r in drop:
            if r["file"] and r["file"] != keep_name and (move is None or folder / r["file"] != move[0]):
                _unlink(folder / r["file"])
        for r in drop_a:
            _unlink(folder / ASIDE_DIR / r["file"])

    @staticmethod
    def _new_id(folder, records, ext):
        """新记录的编号：留底的时刻，到微秒；总比这一组已有的大（钟往回拨了也一样），副本名不撞。"""
        now = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        last = max((_id_order(r["id"]) for r in records), default=None)
        base, n = now, 1
        if last is not None and (now, 1) <= last:
            base, n = last[0], last[1] + 1
        while True:
            i = base if n == 1 else f"{base}-{n}"
            if not (folder / f"{i}{ext}").exists() and not (folder / f"{i}{ext}.part").exists():
                return i
            n += 1

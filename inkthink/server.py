"""InkThink 中转服务：平板草稿纸 ↔ 电脑上正在进行的 Claude Code 对话。

平板浏览器打开草稿纸页面写写画画，点「AI」；Claude Code 里的 inkpad 插件
从本服务取到这次投递，作为一条消息送进对应的对话。Claude 用插件提供的工具把批注写回
草稿纸、往平板推一页图，或者取当前页面的快照。本服务不调用任何模型 API。

    python server.py            # 启动（inkpad 插件找不到服务时也会自己启动它）
    python server.py --open     # 启动后在电脑浏览器里打开二维码页
"""
from __future__ import annotations

import argparse
import atexit
import base64
import difflib
import faulthandler
import hashlib
from html import escape as escape_html
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import unicodedata
import uuid
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import backup
import folders
from keep import Keeper, KeepError, next_name
import layout
import pages
import pdfsave
import prompt
import inksheet
import ocr
import sketchlay
import vocab
import recognize
import versions
import zotero

try:
    import pymupdf as fitz  # PyMuPDF：渲染 PDF / 图片 / SVG，提取原文
except ImportError:
    try:
        import fitz  # 1.24.3 以前的 PyMuPDF 只有这个旧名字
    except ImportError:
        fitz = None

try:
    import qrcode
    import qrcode.image.svg
except ImportError:
    qrcode = None

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

PAGE_W, MARGIN_W, SCRATCH_H = 1000, 380, 1414
TW = PAGE_W + MARGIN_W
RENDER_PX = 2000          # 书页、推送页渲染宽度（像素），对应页面坐标 0–1000
SESSION_ALIVE_S = 20      # 插件每 1.5 秒来取一次；这么久没来就当对话已关
TABLET_ALIVE_S = 30
ITEM_TYPES = {"read", "note", "question", "underline", "circle", "arrow", "write", "suggest",
              "tick", "cross", "strike", "insert", "wavy", "highlight", "brace", "number",  # 批改符号
              "label", "node", "link", "group",  # 概念图上的互动
              "sketch", "formula", "figure",  # 示意图、方框图；排好的公式；电脑上生成的图
              "result"}  # 采纳的修改改完了没有
VOTE_TYPES = {"suggest", "label", "node", "link", "group"}  # 要我采纳 / 不采纳的建议
SHAPE_NEEDS = {"line": ("pts",), "curve": ("pts",), "rect": ("x", "y", "w", "h"), "ellipse": ("cx", "cy", "rx", "ry"),
               "text": ("x", "y", "text"), "axes": ("x", "y", "w", "h")}  # sketch 里的形状和必填的参数


def clean_shapes(v):
    """sketch 的 shapes：只留认得的形状和参数，数字转成 float，最多 80 个。"""
    out = []
    num = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool)
    for s in v if isinstance(v, list) else []:
        if not isinstance(s, dict) or s.get("type") not in SHAPE_NEEDS:
            continue
        c = {"type": s["type"]}
        for k in ("x", "y", "w", "h", "cx", "cy", "rx", "ry", "size"):
            if num(s.get(k)):
                c[k] = float(s[k])
        if isinstance(s.get("pts"), list):
            pts = [[float(p[0]), float(p[1])] for p in s["pts"] if isinstance(p, (list, tuple)) and len(p) >= 2 and num(p[0]) and num(p[1])]
            if len(pts) >= 2:
                c["pts"] = pts[:60]
        for k in ("text", "xlabel", "ylabel"):
            if isinstance(s.get(k), str) and s[k].strip():
                c[k] = s[k].strip()[:40]
        if s.get("arrow") in ("end", "start", "both"):
            c["arrow"] = s["arrow"]
        if s.get("dash") is True:
            c["dash"] = True
        if all(k in c for k in SHAPE_NEEDS[c["type"]]):
            out.append(c)
        if len(out) >= 80:
            break
    return out
EDITABLE_EXT = {".md", ".txt", ".tex", ".doc", ".docx", ".rtf", ".odt", ".ppt", ".pptx", ".odp"}  # 原文件是这些的书：Claude 能改
IMAGE_EXT = {".png", ".jpg", ".jpeg"}
LINE_ANCHOR = re.compile(r"g\d+:\d+")  # 一组里的第几行
FIG_EXT = {".png", ".jpg", ".jpeg", ".svg"}  # figure 收的图
FIG_NAME = re.compile(r"^[0-9a-f]{16}\.png$")
# /static/ 后面只收普通的相对路径（字母、数字、_ . -，用 / 分段）。这个接口不需要访问码，所以先按字面检查、再碰文件系统：
# 像 //server/share/x 这样的网络路径一旦拿去 resolve，Windows 会去连那台机器，可能把登录凭据带过去
STATIC_REL = re.compile(r"^[A-Za-z0-9_.\-]+(/[A-Za-z0-9_.\-]+)*$")


def static_rel_ok(rel):
    return bool(STATIC_REL.match(rel)) and ".." not in rel.split("/")
RENDER_EXT = {".pdf", ".svg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".xps", ".epub"}
WORD_EXT = {".doc", ".docx", ".rtf", ".odt"}
SLIDE_EXT = {".ppt", ".pptx", ".odp"}
TEXT_EXT = {".md", ".txt"}
IMPORT_EXT = {".pdf"} | WORD_EXT | SLIDE_EXT | RENDER_EXT | IMAGE_EXT | TEXT_EXT
# 能导入哪几种，说给用户听的那一串（阶段 E：以前三处说法不一）。上传出错的提示、导入面板「这里没有能导入的文件」那一句（app.js）、
# 文件选择框收的扩展名（index.html 的 accept）都照 IMPORT_EXT 说成一样；tests/test_server.py 的 ImportKindsTest 守着
IMPORT_KINDS = "PDF、PPT、Word、EPUB、图片、Markdown 和纯文本"
SCAN_MAX_PAGES = 40
# 图里看不到的、还没交的红字（阶段 E）：收成小蓝点的短批注浮出来时写在小卡片上的红字，服务端画的图里只有那个点。整本检测（Claude 自己取的）
# 时在「这一页收起来的是」那一条后面写明；用户点「AI」时平板先把它收成卡片、连同红字交上去（app.js 的 dotToCard），所以那时不写。
# 快照（平板画的图）里长回答的卡片、小蓝点上的红字都看不到、也不附卡片的图：消息里如实说一句（snapshot_unsent）。
# 这两句本该和别的消息文字一起放在 prompt.py；这次那个文件另有人在改，先放在这里
SCAN_DOT_UNSENT = "（这个小蓝点浮出来时我在上面写了红字，还没交：图里只有这个点，看不到红字；我在平板上点「AI」时它会收成圈号，连同红字一起交给你）"


def snapshot_unsent(cards, dots):
    """快照消息里的一句：这一页有几张卡片、几个小蓝点上有还没交的红字，快照的图里看不到。都没有返回 None。"""
    what = "、".join(x for x in (f"{cards} 张卡片" if cards else "", f"{dots} 个小蓝点" if dots else "") if x)
    if not what:
        return None
    shown = "和".join(x for x in ("圈号" if cards else "", "小蓝点" if dots else "") if x)
    return (f"这一页有 {what}上有我还没交的红字：快照的图里只有{shown}，看不到这些红字；"
            "我在平板上点「AI」时会连同红字一起交给你。")
# 平板浏览电脑文件夹时不进去的文件夹（另外跳过 . 和 $ 开头的）
BROWSE_SKIP = {"node_modules", "__pycache__", "venv", "env", "site-packages", "system volume information"}       # 整本检测一次最多交几页
CONFIRM_WAIT_S = 25       # 等用户回答确认卡片时，一次长轮询最多挂这么久
ASK_WAIT_S = 25           # 等用户回答问话卡片时，一次长轮询最多挂这么久（插件连着问几次，共约一分半）
ASK_KEEP_S = 3600         # 答过的问话卡片在内存里再留这么久（等着的那一方来取答案），之后清掉；平板上答过就不显示
ASK_IMG_MAX = 4 * 1024 * 1024  # 手写回答的图最大多少字节
# 改电脑上的文件（2026-11-14，阶段 C；《产品定义》第 4 节）：动手前在平板上问覆盖还是另存，留底，平板上能撤回
EDIT_CHOICES = {"覆盖": "overwrite", "另存": "saveas"}  # 问话卡片上的两个选项 → ink_edit 的 mode
NOTE_OVERWRITE, NOTE_SAVEAS, NOTE_SAVEPDF, NOTE_ASIDE = "覆盖前", "另存前", "存回 PDF 前", "撤回前"  # 留底时记下的说明
EDITS_KEEP = 300          # data/edits.json 里最多记多少次修改（旧的丢掉；留底本身由 keep.py 管）

# 用本机 Office 把 Word / PowerPoint 转成 PDF（路径经环境变量传入，避免引号问题）。
# PowerPoint 只有一个实例：用户本来开着就不退出它。
PS_WORD = (
    "$ErrorActionPreference='Stop'; $w = New-Object -ComObject Word.Application; $w.Visible = $false; "
    "$w.DisplayAlerts = 0; try { $d = $w.Documents.Open($env:INK_IN, $false, $true); "
    "$d.ExportAsFixedFormat($env:INK_OUT, 17); $d.Close(0) } finally { $w.Quit() }"
)
# PPT 另存 PDF 默认跳过隐藏页：先记下哪几页隐藏（输出 HIDDEN:10,18），在副本里取消隐藏再另存
PS_SLIDES = (
    "$ErrorActionPreference='Stop'; $running = [bool](Get-Process POWERPNT -ErrorAction SilentlyContinue); "
    "$p = New-Object -ComObject PowerPoint.Application; try { $pr = $p.Presentations.Open($env:INK_IN, -1, 0, 0); "
    "$h = @(); foreach ($s in $pr.Slides) { if ($s.SlideShowTransition.Hidden) { $h += $s.SlideIndex; $s.SlideShowTransition.Hidden = 0 } }; "
    "Write-Output ('HIDDEN:' + ($h -join ',')); "
    "$pr.SaveAs($env:INK_OUT, 32); $pr.Close() } finally { if (-not $running) { $p.Quit() } }"
)
CONVERTER = 2  # 转换方式的版本：2 起 PPT 的隐藏页也转进来


def office_pids():
    """当前在运行的 Word / PowerPoint 进程号。"""
    if sys.platform != "win32":
        return set()
    r = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, errors="replace")
    pids = set()
    for line in r.stdout.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) > 1 and parts[0].upper() in ("WINWORD.EXE", "POWERPNT.EXE") and parts[1].isdigit():
            pids.add(int(parts[1]))
    return pids


def find_soffice():
    for c in (shutil.which("soffice"), r"C:\Program Files\LibreOffice\program\soffice.exe",
              r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"):
        if c and Path(c).is_file() and "codex-tools" not in c:
            return c
    return None


def pptx_hidden(path):
    """.pptx 里哪几页是隐藏页（从 1 起），直接读文件里的 XML，不用打开 PowerPoint。读不了返回 []。"""
    import re
    import zipfile
    try:
        with zipfile.ZipFile(path) as z:
            pres = z.read("ppt/presentation.xml").decode("utf-8", "replace")
            rels = z.read("ppt/_rels/presentation.xml.rels").decode("utf-8", "replace")
            target = {}
            for rel in re.findall(r"<Relationship\b[^>]*>", rels):
                rid, tgt = re.search(r'Id="([^"]+)"', rel), re.search(r'Target="([^"]+)"', rel)
                if rid and tgt:
                    target[rid.group(1)] = tgt.group(1)
            hidden = []
            for k, rid in enumerate(re.findall(r'<p:sldId\b[^>]*r:id="([^"]+)"', pres), 1):
                name = "ppt/" + target.get(rid, "").replace("../", "").lstrip("/").removeprefix("ppt/")
                head = z.read(name)[:2000].decode("utf-8", "replace")
                if re.search(r'<p:sld\b[^>]*\bshow="(0|false)"', head):
                    hidden.append(k)
            return hidden
    except (OSError, KeyError, zipfile.BadZipFile):
        return []


def convert_to_pdf(src, out, owners=(), legacy=False):
    """把文档、幻灯片、图片、EPUB 等转成 PDF，写到 out。返回 PPT 里隐藏页的页号（从 0 起；其他文件为 []）。
    owners、legacy：PDF 里这些本子「存回 PDF」写进去的批注去掉（见 pdfsave.mine），别处写的留着。"""
    src, out = Path(src), Path(out)
    ext = src.suffix.lower()
    if ext == ".pdf":
        shutil.copyfile(src, out)
        if fitz is not None and (owners or legacy):  # 自己存回写进去的批注不当书页内容：平板上本来就画着
            try:
                with pages.FITZ_LOCK:
                    pdfsave.strip_own_file(out, set(owners), legacy)
            except (RuntimeError, ValueError):  # 打不开的 PDF：照原样导入，和以前一样
                pass
        return []
    if ext in RENDER_EXT or ext in IMAGE_EXT:
        if fitz is None:
            raise ValueError("没有安装 PyMuPDF")
        with pages.FITZ_LOCK:
            doc = fitz.open(str(src))
            out.write_bytes(doc.convert_to_pdf())
            doc.close()
        return []
    if ext in TEXT_EXT:
        with pages.FITZ_LOCK:
            text_to_pdf(src, out)
        return []
    if ext not in WORD_EXT | SLIDE_EXT:
        raise ValueError(f"不支持的文件类型：{ext}（可以导入 {IMPORT_KINDS}）")
    # 只转换副本：原文件可能正开在用户的 Word / PowerPoint 里，按原路径打开再关闭会连带关掉用户那份
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / f"inkthink-import{ext}"
        shutil.copyfile(src, copy)
        return _office_to_pdf(copy, out, ext)


def text_to_pdf(src, out):
    """Markdown / 纯文本按原样排成 A4 页（等宽换行，不渲染 Markdown 语法）。"""
    if fitz is None:
        raise ValueError("没有安装 PyMuPDF")
    font = fitz.Font("china-s")
    fs, lh, width, top = 10.5, 15.5, 515, 40
    lines = []
    for raw in src.read_text("utf-8", errors="replace").splitlines() or [""]:
        cur = ""
        for ch in raw.expandtabs(4):
            if cur and font.text_length(cur + ch, fs) > width:
                lines.append(cur)
                cur = ch
            else:
                cur += ch
        lines.append(cur)
    per = int((842 - 2 * top) / lh)
    doc = fitz.open()
    for k in range(0, len(lines), per):
        pg = doc.new_page(width=595, height=842)
        for n, line in enumerate(lines[k:k + per]):
            if line:
                pg.insert_text((40, top + fs + n * lh), line, fontsize=fs, fontname="china-s")
    out.write_bytes(doc.tobytes())
    doc.close()


BOARD_TEXT_FS = (9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6)  # 推送的文本页：从 9.5 号字往小试，放得下为止


def _clip_text_line(line, width, fs):
    """一行截到 width 宽，排不下的部分去掉、以「…」结尾。"""
    line = line.expandtabs(4)[:1000]
    if fitz.get_text_length(line, fontname="china-s", fontsize=fs) <= width:
        return line
    lo, hi = 0, len(line)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if fitz.get_text_length(line[:mid] + "…", fontname="china-s", fontsize=fs) <= width:
            lo = mid
        else:
            hi = mid - 1
    return line[:lo] + "…"


def fit_board_text(pg, rect, head, lines):
    """把推送的一段文本（最多 70 行）排进 rect。insert_textbox 放不下时一个字都不画（以前满 70 行的一段推过去是白页），
    所以先照原样（长行折行）从 9.5 号字往小试；6 号字还放不下（有特别长的行），每行只排一行、排不下的截掉标「…」，
    再从 9.5 号往小试。返回用的字号（都放不下是 None）。"""
    body = "\n".join(lines) or "（空）"
    for fs in BOARD_TEXT_FS:
        if pg.insert_textbox(rect, f"{head}\n\n{body}", fontsize=fs, fontname="china-s") >= 0:
            return fs
    for fs in BOARD_TEXT_FS + (5, 4):
        cut = "\n".join(_clip_text_line(x, rect.width - 4, fs) for x in [head, ""] + (lines or ["（空）"]))
        if pg.insert_textbox(rect, cut, fontsize=fs, fontname="china-s") >= 0:
            return fs
    return None


def _office_to_pdf(src, out, ext):
    errors = []
    if sys.platform == "win32":
        script = PS_WORD if ext in WORD_EXT else PS_SLIDES
        env = dict(os.environ, INK_IN=str(src.resolve()), INK_OUT=str(out.resolve()))
        before = office_pids()
        try:
            r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                               env=env, capture_output=True, text=True, timeout=120)
            if out.is_file() and out.stat().st_size > 0:
                line = next((x for x in (r.stdout or "").splitlines() if x.startswith("HIDDEN:")), "HIDDEN:")
                return [int(v) - 1 for v in line[7:].split(",") if v.strip().isdigit()]
            errors.append((r.stderr or r.stdout).strip()[:300] or f"Office 返回 {r.returncode}")
        except subprocess.TimeoutExpired:
            # Office 弹了看不见的对话框卡住：结束这次新开的 Office 进程（用户自己开着的不动）
            for pid in office_pids() - before:
                subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
            errors.append("Office 两分钟内没有完成转换（可能弹出了对话框）")
        except OSError as e:
            errors.append(str(e))
    soffice = find_soffice()
    if soffice:
        with tempfile.TemporaryDirectory() as tmp:
            fmt = 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}' if ext in SLIDE_EXT else "pdf"
            subprocess.run([soffice, "--headless", "--convert-to", fmt, "--outdir", tmp, str(src)],
                           capture_output=True, timeout=180)
            made = Path(tmp) / (src.stem + ".pdf")
            if made.is_file():
                shutil.copyfile(made, out)
                return [k - 1 for k in pptx_hidden(src)] if ext == ".pptx" else []
        errors.append("LibreOffice 没有转出 PDF")
    raise ValueError("没能把它转成 PDF：" + "；".join(errors or ["本机没有 Office 或 LibreOffice"]))
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webmanifest": "application/manifest+json; charset=utf-8",
}


class Conflict(Exception):
    """这一页在别的设备上改过了：旧版本不覆盖（返回 409）。"""


class TargetGone(ValueError):
    """这本绑定的对话不在了：先问发往哪个对话（返回 410）。"""

    def __init__(self, label):
        super().__init__(f"这本原来发往「{label}」，那个对话现在不在了。选一个对话再发。")
        self.label = label


class ClientGone(Exception):
    """对方断开了。"""


# ---------------------------------------------------------------- 对话登记与事件

LEASE_S = 30   # 交给对话后多久没确认收到就重新给（插件取到后出错时不丢）


class Bridge:
    """各个 Claude Code 对话的登记表、投递队列，以及推给平板的事件流。"""

    def __init__(self):
        self.cond = threading.Condition()
        # sid -> {sid, label, cwd, seen, active, started, hint, ink}：started 是插件报来的对话开始时刻（毫秒，拿不到是 None），
        # hint 是最近在那个对话里打的一句话的开头，ink 是那个对话里执行过 /ink（只在内存里，服务重启后由插件重新报）
        self.sessions = {}
        self.queues = {}       # sid -> [submission id]
        self.preferred = None  # 平板上手动选（或 /ink here 指定）的目标对话；存在文件里，服务重启后还记得
        self.pref_file = None
        self.state_file = None
        self.persist_lock = threading.Lock()
        self.events = []
        self.seq = 0
        self.tablet_seen = 0.0
        self.snapshots = {}    # rid -> {"done": threading.Event, "result": ...}
        self.confirms = {}     # cid -> 一张确认卡片（Claude 拿不准的字迹）
        self.asks = {}         # cid -> 一张问话卡片（要用户回答的问题，或纸上放不下的结果；见 App.post_card）
        self.where = None      # 平板当前打开的 {nb, page}
        self.leases = {}       # 投递编号 -> 交出去的时刻：已交给对话、等它确认收到

    def persist(self):
        """排队待取的投递、还没回答的确认卡片和问话卡片存到文件：服务重启（比如更新代码）后接着用。"""
        if not self.state_file:
            return
        # 几个请求可能同时来存：排队一个个写；Windows 上文件被别的程序短暂占用时重试几次，实在不行就算了（只是备份）
        with self.persist_lock:
            with self.cond:
                state = {"queues": {k: v for k, v in self.queues.items() if v},
                         "confirms": [{k: v for k, v in c.items() if k != "done"}
                                      for c in self.confirms.values() if c["answers"] is None],
                         # 问话卡片：等答案的事件、答了以后调用的回调不存（只在内存里）
                         "asks": [{k: v for k, v in c.items() if k not in ("done", "on_answer")}
                                  for c in self.asks.values() if c["answer"] is None]}
            tmp = self.state_file.with_suffix(".tmp")
            for attempt in range(5):
                try:
                    tmp.write_text(json.dumps(state, ensure_ascii=False), "utf-8")
                    os.replace(tmp, self.state_file)
                    return
                except OSError:
                    time.sleep(0.05 * (attempt + 1))
            print("[提示] 排队状态没能存到文件（不影响使用）")

    def restore(self):
        if not self.state_file or not self.state_file.exists():
            return
        try:
            state = json.loads(self.state_file.read_text("utf-8"))
        except ValueError:
            return
        self.queues = {k: list(v) for k, v in state.get("queues", {}).items()}
        for c in state.get("confirms", []):
            # 重启前在等回答的那次工具调用已经断了：之后的回答作为新消息送进对话
            c.update(done=threading.Event(), late=True)
            self.confirms[c["id"]] = c
        for c in state.get("asks", []):
            # 问话卡片同样：等着的工具调用、服务里等着的回调都断了；问题卡片之后的回答作为新消息送进发它的对话
            c.update(done=threading.Event(), late=bool(c.get("sid")))
            self.asks[c["id"]] = c

    def set_preferred(self, sid):
        self.preferred = sid or None
        if self.pref_file:
            self.pref_file.write_text(self.preferred or "", "utf-8")
        self.emit("sessions")

    def emit(self, kind, **data):
        with self.cond:
            self.seq += 1
            self.events.append({"seq": self.seq, "type": kind, **data})
            del self.events[:-300]
            self.cond.notify_all()

    def wait_events(self, since, timeout):
        with self.cond:
            self.tablet_seen = time.time()
            if since > self.seq:  # 服务重启过，平板手里的序号作废：从头给
                return self.events[:], self.seq
            if self.seq == since:
                self.cond.wait_for(lambda: self.seq > since, timeout=timeout)
            self.tablet_seen = time.time()
            return [e for e in self.events if e["seq"] > since], self.seq

    def tablet_online(self):
        return time.time() - self.tablet_seen < TABLET_ALIVE_S

    def hello(self, sid, label, cwd, started=None, hint="", ink=False):
        """插件登记（或重新登记）这个对话。started：对话开始的时刻（毫秒；插件从 $.session.usage() 取，拿不到就不给，
        这里也不另编一个）；hint：插件连上时从对话记录里取的最后一句用户打的话；ink：这个对话里执行过 /ink。
        没给的沿用上次登记时记下的。"""
        with self.cond:
            now = time.time()
            old = self.sessions.get(sid) or {}
            good_start = isinstance(started, (int, float)) and not isinstance(started, bool) and started > 0
            self.sessions[sid] = {"sid": sid, "label": label or "对话", "cwd": cwd or "",
                                  "seen": now, "active": old.get("active", now),
                                  "started": int(started) if good_start else old.get("started"),
                                  "hint": hint[:40] if hint else old.get("hint"),
                                  "ink": bool(ink) or bool(old.get("ink"))}
            self.queues.setdefault(sid, [])
        self.emit("sessions")

    def touch(self, sid):
        with self.cond:
            s = self.sessions.get(sid)
            if s:
                s["seen"] = time.time()
            return s is not None

    def mark_active(self, sid, hint=""):
        """sid 这个对话里刚打了字。hint：打的那句话的开头，平板上选发往哪个对话时用来认（只在内存里，不存盘）。"""
        with self.cond:
            if sid in self.sessions:
                self.sessions[sid]["active"] = self.sessions[sid]["seen"] = time.time()
                if hint:
                    self.sessions[sid]["hint"] = hint[:40]
        self.emit("sessions")

    def bye(self, sid):
        with self.cond:
            self.sessions.pop(sid, None)
            if not self.queues.get(sid):  # 还有没送到的留着：接着这个对话（--resume 编号不变）时照样送到，不转给别的对话
                self.queues.pop(sid, None)
        self.emit("sessions")

    def alive(self):
        now = time.time()
        with self.cond:
            return sorted((dict(s) for s in self.sessions.values() if now - s["seen"] < SESSION_ALIVE_S),
                          key=lambda s: -s["active"])

    def default_target(self):
        alive = self.alive()
        ids = [s["sid"] for s in alive]
        if self.preferred in ids:
            return self.preferred
        return ids[0] if ids else None

    def enqueue(self, sid, sub_id):
        with self.cond:
            self.queues.setdefault(sid, []).append(sub_id)
        self.persist()

    def pop(self, sid, lease=False):
        """取一条给这个对话。lease：先不删，等 ack 确认收到；LEASE_S 秒没确认就再给一次（插件那边按编号去重）。
        不带 lease：取走就删（插件取时都带 lease；测试脚本直接取时不带）。"""
        with self.cond:
            q = self.queues.get(sid) or []
            now, sub = time.time(), None
            for x in q:
                if now - self.leases.get(x, 0) >= LEASE_S:
                    sub = x
                    break
            if sub and lease:
                self.leases[sub] = now
                return sub
            if sub:
                q.remove(sub)
        if sub:
            self.persist()
        return sub

    def ack(self, sid, sub):
        """对话确认收到了这条投递：从队列里删掉。"""
        with self.cond:
            q = self.queues.get(sid) or []
            hit = sub in q
            if hit:
                q.remove(sub)
            self.leases.pop(sub, None)
        if hit:
            self.persist()
        return hit


# ---------------------------------------------------------------- 应用：存储、PDF、投递

class App:
    def __init__(self, args):
        self.data = Path(args.data).resolve() if args.data else ROOT / "data"
        self.books = Path(args.books).resolve() if args.books else ROOT / "books"
        for d in (self.data / "notebooks" / "board", self.data / "submissions", self.data / "cache",
                  self.data / "confirms", self.books):
            d.mkdir(parents=True, exist_ok=True)
        self.cfg = load_config(Path(args.config) if args.config else ROOT / "config.json")
        self.host = args.host or self.cfg.get("host") or "0.0.0.0"
        self.port = int(args.port or self.cfg.get("port") or 8765)
        self.code = self._access_code()
        self.pdf_lock = pages.FITZ_LOCK  # PyMuPDF 只能一个线程一个线程地用
        pages.FIG_DIR = self.data / "figures"  # Claude 放上来的图（figure）
        self.file_lock = threading.Lock()
        # 每次投递（整本的按页）Claude 已经交了哪几组的读法、回应到了哪几组：{(投递编号, 页的键): {"read": set, "hit": set}}，
        # 只在内存里（服务重启后最多多提醒一次）；见 reads_owed
        self.reads_seen = {}
        self.reads_lock = threading.Lock()
        self.folder_lock = threading.Lock()  # 抽屉里的文件夹（notebooks/folders.json）：读改写不让别的请求插进来
        self._rounds = {}  # 投递编号 -> 已经记过的进展
        self.page_lock = threading.Lock()
        self.dev_seen = {}  # 设备 id -> (最近一次请求的时刻, IP)，只在内存里  # 存页面：比版本号和写文件之间不让别的请求插进来
        self._docs = {}
        self._hidden_cache = {}
        self._ans_cache = {}  # 页的数据文件 -> ((修改时间, 大小), 上面没擦掉的长回答有几条)；见 answer_count
        self.bridge = Bridge()
        self.bridge.pref_file = self.data / "preferred_target.txt"
        if self.bridge.pref_file.exists():
            self.bridge.preferred = self.bridge.pref_file.read_text("utf-8").strip() or None
        self.bridge.state_file = self.data / "bridge_state.json"
        self.bridge.restore()
        self.zotero = zotero.Zotero(self.cfg.get("zotero") or zotero.BASE)
        # 原稿、往来稿两份 PDF 导出到哪（config.json 的 paper_dir，每本一个子文件夹）；没配置就不导出，测试不会写到用户的文件夹
        self.paper_dir = Path(self.cfg["paper_dir"]) if self.cfg.get("paper_dir") else None
        self.paper_delay = float(self.cfg.get("paper_delay", 15))  # 一本纸停笔这么多秒后才重出
        self._paper_timers, self._paper_lock = {}, threading.Lock()
        # 改电脑上的文件之前留底（覆盖前、另存前、存回 PDF 前、撤回前另留的），整个服务一个；不进每日备份（backup.DIRS 里没有它）
        self.keeper = Keeper(self.data / "keep")
        self.edit_lock = threading.RLock()  # 留底、另存、撤回一次只办一件：同一张卡片的回答不会办两次

    # -- 设备：扫码打开时用访问码配对，之后用只属于这台设备的令牌；令牌只存哈希

    def _devices_file(self):
        return self.data / "devices.json"

    def devices(self):
        f = self._devices_file()
        try:
            return json.loads(f.read_text("utf-8")) if f.exists() else []
        except ValueError:
            return []

    def _save_devices(self, items):
        tmp = self._devices_file().with_suffix(".tmp")
        tmp.write_text(json.dumps(items, ensure_ascii=False, indent=1), "utf-8")
        os.replace(tmp, self._devices_file())

    def pair_device(self, name, ip):
        token = secrets.token_urlsafe(24)
        with self.file_lock:
            items = self.devices()
            name = re.sub(r"[<>&\"'`\x00-\x1f]", "", name or "").strip()[:40]  # 名字会显示在电脑上的二维码页里：不留能当标签的字符
            dev = {"id": uuid.uuid4().hex[:8], "name": name or "设备", "hash": hashlib.sha256(token.encode()).hexdigest(),
                   "created": datetime.now().isoformat(timespec="seconds"), "ip": ip}
            items.append(dev)
            self._save_devices(items)
        print(f"[设备] 配对：{dev['name']}（{ip}）")
        return dev["id"], token

    def device_ok(self, token, ip):
        h = hashlib.sha256(token.encode()).hexdigest()
        for d in self.devices():
            if secrets.compare_digest(d["hash"], h):
                self.dev_seen[d["id"]] = (time.time(), ip)
                return True
        return False

    def device_list(self):
        out = []
        for d in self.devices():
            seen = self.dev_seen.get(d["id"])
            out.append({"id": d["id"], "name": d["name"], "created": d["created"], "ip": seen[1] if seen else d.get("ip"),
                        "seen": datetime.fromtimestamp(seen[0]).isoformat(timespec="seconds") if seen else None})
        return out

    def revoke_device(self, dev_id):
        """断开一台设备：删掉它的令牌，并换访问码（它可能还记着带旧访问码的地址，别让它重新配对）。"""
        with self.file_lock:
            items = self.devices()
            left = [d for d in items if d["id"] != dev_id]
            if len(left) == len(items):
                raise KeyError("没有这台设备")
            self._save_devices(left)
        self.dev_seen.pop(dev_id, None)
        return self.rotate_code()

    def rotate_code(self):
        """换一个新的访问码（二维码跟着变）。已配对的设备照常用，新设备要扫新的码。"""
        if self.cfg.get("access_code"):
            raise ValueError("访问码写在 config.json 的 access_code 里：要换的话改那里，再重启服务")
        self.code = secrets.token_urlsafe(12)
        (self.data / "access_code.txt").write_text(self.code, "utf-8")
        print("[设备] 访问码已更换")
        return self.code

    def _access_code(self):
        if self.cfg.get("access_code"):
            return str(self.cfg["access_code"])
        f = self.data / "access_code.txt"
        if f.exists() and f.read_text("utf-8").strip():
            return f.read_text("utf-8").strip()
        code = secrets.token_urlsafe(6)
        f.write_text(code, "utf-8")
        return code

    def tablet_url(self):
        ips = lan_ips()
        return f"http://{ips[0]}:{self.port}/?k={self.code}" if ips else f"http://127.0.0.1:{self.port}/?k={self.code}"

    def stable_url(self):
        """用电脑名访问（电脑名.local）：换了网络、IP 变了也不用重新扫码；有的网络屏蔽这种广播，就只能用 IP。"""
        name = local_name()
        return f"http://{name}:{self.port}/?k={self.code}" if name else None

    # -- 书（PDF）

    def book_names(self):
        return sorted(p.name for p in self.books.iterdir() if p.is_file() and p.suffix.lower() == ".pdf")

    def current_nb(self, nb):
        """书换成新版时会跟着改名（v48 → v50）：之前的投递按旧名字记，这里找到它现在的名字；没改过名原样返回。"""
        if not nb.startswith("book:") or nb[5:] in self.book_names():
            return nb
        stem = Path(nb[5:]).stem
        for d in (self.data / "notebooks").glob("book-*"):
            hist, meta = d / "history.json", d / "meta.json"
            if not hist.exists() or not meta.exists():
                continue
            names = {n for h in json.loads(hist.read_text("utf-8")) for n in (h.get("from"), h.get("to"))}
            book = json.loads(meta.read_text("utf-8")).get("book")
            if stem in names and book in self.book_names():
                return "book:" + book
        return nb

    def book_path(self, name):
        if name not in self.book_names():
            raise KeyError(f"没有这本书：{name}")
        return self.books / name

    def _doc(self, name):
        """调用方需持有 pdf_lock。"""
        path = self.book_path(name)
        key = (name, path.stat().st_mtime)
        if key not in self._docs:
            self._docs = {k: v for k, v in self._docs.items() if k[0] != name}
            # 读进内存再打开：Windows 上不会锁住文件，服务开着也能删改 books 里的 PDF
            self._docs[key] = fitz.open(stream=path.read_bytes(), filetype="pdf")
        return self._docs[key]

    def book_page_jpeg(self, name, i):
        path = self.book_path(name)
        key = hashlib.sha1(f"{name}|{path.stat().st_mtime}|{i}|{RENDER_PX}".encode()).hexdigest()[:20]
        cached = self.data / "cache" / f"{key}.jpg"
        if cached.exists():
            return cached.read_bytes()
        with self.pdf_lock:
            page = self._doc(name)[i]
            zoom = RENDER_PX / page.rect.width
            data = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False).tobytes("jpg", jpg_quality=88)
        cached.write_bytes(data)
        return data

    def book_text(self, name, i):
        """这一页的原文（太长时只留开头 2500 字）。"""
        with self.pdf_lock:
            full = self._doc(name)[i].get_text("text").strip()
        if len(full) > 2500:
            full = full[:2500] + "……"
        return full

    # -- Claude 推送的页面（board）

    def board_index(self):
        f = self.data / "notebooks" / "board" / "index.json"
        return json.loads(f.read_text("utf-8")) if f.exists() else {"pages": []}

    def add_board_page(self, src, page_no=None, title=None):
        """把一个文件变成平板上的一页：图片原样，PDF/SVG 等渲染成图，文本排成页。返回页码（0 起）。"""
        src = Path(src)
        if not src.is_file():
            raise ValueError(f"找不到文件：{src}")
        if fitz is None:
            raise ValueError("没有安装 PyMuPDF，不能推送页面")
        ext = src.suffix.lower()
        if ext in WORD_EXT | SLIDE_EXT:  # 先转成 PDF，再取那一页
            pdf = self.data / "cache" / (hashlib.sha1(f"{src}|{src.stat().st_mtime}".encode()).hexdigest()[:16] + ".pdf")
            if not pdf.exists():
                convert_to_pdf(src, pdf)
            label = title or (src.name if page_no in (None, 1) else f"{src.name} 第 {page_no} 页")
            return self.add_board_page(pdf, page_no, label)
        board = self.data / "notebooks" / "board"
        with self.file_lock, self.pdf_lock:
            idx = self.board_index()
            n = len(idx["pages"])
            name = f"bg-{n:04d}.png"
            if ext in IMAGE_EXT:
                pix = fitz.Pixmap(str(src))
                if pix.alpha:
                    pix = fitz.Pixmap(pix, 0)
                if pix.n not in (1, 3):  # CMYK 等转成 RGB
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                pix.save(board / name)
            elif ext in RENDER_EXT:
                doc = fitz.open(str(src))
                k = max(0, min(int(page_no or 1) - 1, len(doc) - 1))
                page = doc[k]
                zoom = RENDER_PX / max(1.0, page.rect.width)
                page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False).save(board / name)
                doc.close()
            else:
                text = src.read_text("utf-8", errors="replace")
                lines = text.splitlines()
                start = max(0, int(page_no or 1) - 1) * 70
                doc = fitz.open()
                pg = doc.new_page(width=595, height=842)
                fit_board_text(pg, fitz.Rect(40, 40, 555, 802), f"{src.name}  第 {start + 1} 行起", lines[start:start + 70])
                pg.get_pixmap(matrix=fitz.Matrix(RENDER_PX / 595, RENDER_PX / 595), alpha=False).save(board / name)
                doc.close()
            pix = fitz.Pixmap(str(board / name))
            h = round(PAGE_W * pix.height / pix.width, 1)
            label = title or (src.name if page_no in (None, 1) else f"{src.name} 第 {page_no} 页")
            idx["pages"].append({"title": label, "file": name, "h": h, "src": str(src)})
            (board / "index.json").write_text(json.dumps(idx, ensure_ascii=False, indent=1), "utf-8")
        return n

    # -- 导入的文档记着原文件：原文件改了可以原地更新（笔迹保留），并和旧版对比

    def sources(self):
        f = self.books / "_sources.json"
        return json.loads(f.read_text("utf-8")) if f.exists() else {}

    def set_source(self, name, src, **extra):
        """记下（或更新）这本的原文件；原文件没换时保留 Zotero 信息和存回时间，extra 另外记上。
        t 是记下的时刻（Claude 原地更新时据此看「上次导入之后有没有先留底」，见 import_remind）。"""
        s = self.sources()
        st = Path(src).stat()
        old, path = s.get(name) or {}, str(Path(src).resolve())
        keep = {k: old[k] for k in ("zotero", "saved", "owner") if k in old and old.get("src", "").lower() == path.lower()}
        s[name] = {"src": path, "mtime": st.st_mtime, "size": st.st_size, "t": datetime.now().isoformat(timespec="seconds"),
                   **keep, **extra}
        (self.books / "_sources.json").write_text(json.dumps(s, ensure_ascii=False, indent=1), "utf-8")

    def pdf_owners(self, src):
        """（这台电脑上存回过 PDF 的本子的归属标记, 这个文件是不是在改版前存回过）：导入时据此去掉自己写的批注。"""
        want = str(Path(src).resolve()).lower()
        s = self.sources().values()
        owners = {v["owner"] for v in s if v.get("owner")}
        legacy = any(v.get("saved") and not v.get("owner") and v.get("src", "").lower() == want for v in s)
        return owners, legacy

    def unplaced(self, nb):
        """{页序号: 条数}：Claude 写回、还在排队等平板排版落下的批注（平板没打开过那一页）。"""
        out = {}
        for i, e in enumerate(self.layout_of(nb).pages):
            f = self._key_file(nb, e["key"], ".pending.json")
            if f.exists():
                try:
                    n = sum(len(x.get("items") or []) for x in json.loads(f.read_text("utf-8")))
                except ValueError:
                    continue
                if n:
                    out[i] = n
        return out

    def book_of_source(self, src, shared_first=False):
        """这个原文件导入成了哪本（书名），没有返回 None。

        shared_first（Claude 一侧用）：同一个原文件导入成了几本时，先挑不是「只在本地」的那本；只有只在本地的，照样返回它，
        由调用的地方拦下（ensure_writable）。"""
        want = str(Path(src).resolve()).lower()
        hits = [name for name, info in self.sources().items() if info["src"].lower() == want and (self.books / name).is_file()]
        if shared_first:
            hits.sort(key=lambda name: self.is_local("book:" + name))  # 稳定排序：同类里还是原来的先后
        return hits[0] if hits else None

    def similar_book(self, src):
        """名字只差版本号之类的旧本子（如 …_v47_修改6.pptx 和 …_v47_修改7.pptx），用来提示「替换旧版」。
        只找比它旧的：不会建议用较早的版本去替换较新的。"""
        src = Path(src)
        try:
            mtime = src.stat().st_mtime
        except OSError:
            return None
        # 同一系列（v47、v48……）都够像时，替换其中最新的那本（一样新就取名字更像、排在后面的）
        best, key = None, None
        for name, info in self.sources().items():
            old = Path(info["src"])
            if old.suffix.lower() != src.suffix.lower() or not (self.books / name).is_file() or info["mtime"] > mtime:
                continue
            s = name_similarity(old.stem, src.stem)
            if s > 0.75 and old.resolve() != src.resolve() and (key is None or (info["mtime"], s, name) > key):
                best, key = name, (info["mtime"], s, name)
        return best

    def adopt_source(self, src):
        """以前导入、没记原文件的本子：碰到同名的文件就认它做原文件（导入后才改过的，仍算「原文件改过了」）。"""
        src = Path(src)
        name = f"{src.stem}.pdf"
        if name in self.sources() or not (self.books / name).is_file() or src.suffix.lower() == ".pdf" and src.parent == self.books:
            return None
        st = src.stat()
        s = self.sources()
        s[name] = {"src": str(src.resolve()), "mtime": min(st.st_mtime, (self.books / name).stat().st_mtime), "size": st.st_size}
        (self.books / "_sources.json").write_text(json.dumps(s, ensure_ascii=False, indent=1), "utf-8")
        return name

    def source_changed(self, name):
        info = self.sources().get(name)
        if not info:
            return False
        p = Path(info["src"])
        try:
            st = p.stat()
        except OSError:
            return False
        return abs(st.st_mtime - info["mtime"]) > 1 or st.st_size != info["size"]

    def set_doc_info(self, nb, hidden):
        (self._nb_dir(nb) / "doc.json").write_text(json.dumps({"converter": CONVERTER, "hidden": hidden}), "utf-8")

    def doc_info(self, nb):
        f = self._nb_dir(nb) / "doc.json"
        return json.loads(f.read_text("utf-8")) if f.exists() else None

    def kept_original(self, name):
        """导入时另存在 books/_原件/ 的原件（同名导入第二次的「… (2).pdf」也认），没有返回 None。"""
        stem = re.sub(r" \(\d+\)$", "", Path(name).stem)
        found = sorted(p for p in (self.books / "_原件").glob("*") if p.stem == stem and p.is_file())
        return found[0] if found else None

    def original_of(self, name):
        """这本书的原文件：记下的原文件还在就用它，否则用导入时另存的原件。"""
        info = self.sources().get(name)
        if info and Path(info["src"]).is_file():
            return Path(info["src"])
        return self.kept_original(name)

    def hidden_missing(self, nb):
        """以前转换的 PPT 漏掉了隐藏页：返回原文件里隐藏页的张数（新方式转换过的、不是 PPT 的为 0）。"""
        info = self.doc_info(nb)
        src = self.original_of(nb[5:])
        if (info and info.get("converter", 0) >= CONVERTER) or not src or src.suffix.lower() != ".pptx":
            return 0
        key = (str(src), src.stat().st_mtime)
        if key not in self._hidden_cache:
            self._hidden_cache[key] = len(pptx_hidden(src))
        return self._hidden_cache[key]

    def changes(self, nb):
        f = self._nb_dir(nb) / "changes.json"
        return json.loads(f.read_text("utf-8")) if f.exists() else None

    def update_document(self, nb, src=None, edit=None, undo=False):
        """用原文件（或另给的新文件）的新版本原地替换一本书：页按内容对齐，手写跟着对应的页走；
        旧版留在 books/_旧版/，每页改动的区域记在 changes.json 里供平板对比。返回改动摘要。

        换成另一个文件（如 v48 → v50）时，本子原来是按原文件命名的，就跟着改名。
        edit：这次换新版是 Claude 改完文件后导入的那一次修改（data/edits.json 里的 eid），记进 changes.json，
        平板上这一页的提示条据此出「撤回这次修改」；并记下这时文件内容的 SHA-256（撤回时看那之后又改过没有）。
        undo：这次是平板上撤回之后换回去的（提示条上写「再往回撤一次」）。
        """
        if not nb.startswith("book:"):
            raise ValueError("只有导入的文档能更新")
        name = nb[5:]
        dest = self.book_path(name)
        info = self.sources().get(name)
        src = Path(src) if src else self.original_of(name)  # 没记原文件、原文件不在了：用导入时另存的原件
        if not src or not src.is_file():
            raise ValueError("找不到这本的原文件（只有从电脑上的文件导入的才能更新）")
        kept_copy = src.parent.resolve() == (self.books / "_原件").resolve()
        other_file = not info or Path(info["src"]).resolve() != src.resolve()
        named_after_source = not info or Path(info["src"]).stem == Path(name).stem
        rename = other_file and named_after_source and src.stem != Path(name).stem \
            and not (self.books / f"{src.stem}.pdf").exists()
        tmp = self.data / "cache" / f"update-{uuid.uuid4().hex[:8]}.pdf"
        hidden = convert_to_pdf(src, tmp, *self.pdf_owners(src))
        old_bytes, new_bytes = dest.read_bytes(), tmp.read_bytes()
        with self.pdf_lock:
            mapping, pages_info, removed = versions.compare(old_bytes, new_bytes)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        olddir = self.books / "_旧版"
        olddir.mkdir(exist_ok=True)
        old_pdf = olddir / f"{Path(name).stem}.{stamp}.pdf"
        old_pdf.write_bytes(old_bytes)
        d = self._nb_dir(nb)
        with self.file_lock:
            # 先把旧页的笔迹文件挪到临时名，再按对齐表放回新页号，避免互相覆盖
            moved = {}
            for f in list(d.glob("page-*.json")):
                i = int(f.name[5:9])
                tmpf = d / f"move-{f.name}"
                os.replace(f, tmpf)
                moved.setdefault(i, []).append((tmpf, f.name[9:]))
            for j, i in enumerate(mapping):
                for tmpf, suffix in moved.pop(i, []) if i is not None else []:
                    os.replace(tmpf, d / f"page-{j:04d}{suffix}")
            kept = []
            for i, files in moved.items():  # 新版里没有的页：有笔迹就另存，不删
                for tmpf, suffix in files:
                    keep = d / f"removed-{stamp}-page-{i:04d}{suffix}"
                    os.replace(tmpf, keep)
                    if suffix == ".json":
                        kept.append(i)
            def remap(seen):
                out = {k: v for k, v in seen.items() if not k.startswith("p")}  # 空白纸的键不变
                out.update({f"p{j:04d}": seen[f"p{i:04d}"] for j, i in enumerate(mapping) if i is not None and f"p{i:04d}" in seen})
                return out
            (d / "seen.json").write_text(json.dumps({"by": {sid: remap(v) for sid, v in self._seen_by(nb).items()}}), "utf-8")
            lay = self.layout_of(nb)  # 这时 dest 还是旧版，按旧版页数读
            lay.remap_pdf(mapping, len(mapping))
            lay.save()
            os.replace(tmp, dest)
            self._docs = {k: v for k, v in self._docs.items() if k[0] != name}
            to_title = src.stem if rename else Path(name).stem
            ch = {"t": datetime.now().isoformat(timespec="seconds"), "src": str(src), "old_pdf": str(old_pdf),
                  "from": Path(name).stem, "to": to_title,
                  "pages": {str(j): p for j, p in pages_info.items()}, "removed": removed, "removed_with_ink": sorted(kept),
                  "edit": edit, "undo": bool(undo)}
            (d / "changes.json").write_text(json.dumps(ch, ensure_ascii=False, indent=1), "utf-8")
            hist_f = d / "history.json"
            hist = json.loads(hist_f.read_text("utf-8")) if hist_f.exists() else []
            hist.append({"t": ch["t"], "from": ch["from"], "to": to_title, "old_pdf": str(old_pdf), "src": str(src)})
            hist_f.write_text(json.dumps(hist, ensure_ascii=False, indent=1), "utf-8")
            (d / "doc.json").write_text(json.dumps({"converter": CONVERTER, "hidden": hidden}), "utf-8")
        if rename:
            nb = self.rename_book(name, f"{src.stem}.pdf")
            name = nb[5:]
        if not kept_copy:  # 另存的原件不当作原文件记下，以免把真正的原文件盖掉
            self.set_source(name, src)
        if edit:  # 改完导入的这一刻文件是什么样：之后撤回时据此判断「那次修改之后又改过没有」
            try:
                self.change_edit(edit, post=file_sha(src), book="book:" + name)
            except OSError:
                pass
        # 新旧两个原文件的「新文件」提示都不用再显示了
        self.dismiss_offers_for([src] + ([Path(info["src"])] if info else []))
        return self.change_summary(nb)

    def pdf_source(self, name):
        """原文件是 PDF 而且还在：返回它的路径（「存回 PDF」写进这个文件），否则 None。"""
        info = self.sources().get(name)
        p = Path(info["src"]) if info else None
        return p if p and p.suffix.lower() == ".pdf" and p.is_file() else None

    def save_pdf(self, nb):
        """抽屉里「存回 PDF」：把这本书上的手写和 Claude 的批注写进原 PDF（再存时替换上次写的）。写之前先留底
        （和改文件同一个留底文件夹，2026-11-14 起；以前 data/backups 里的旧备份留着不动），留底没做成就不写；
        存完能在平板上撤回（undo 为真）。

        只写书页上的：插入的空白页上的组数记在 blank 里。返回 pdfsave.save 的统计，加上 file、name、blank、undo。
        """
        if not nb.startswith("book:"):
            raise ValueError("只有导入的 PDF 能存回")
        name = nb[5:]
        self.book_path(name)
        src = self.pdf_source(name)
        if src is None:
            raise ValueError("这本不是从电脑上的 PDF 导入的，没有可以存回的原文件")
        if self.source_changed(name):
            raise ValueError("原文件在导入后改过：先更新这本，再存回")
        items, blank = [], 0
        with self.file_lock:
            for e in self.layout_of(nb).pages:
                f = self._key_file(nb, e["key"])
                if not f.exists():
                    continue
                page = json.loads(f.read_text("utf-8"))
                if "pdf" in e:
                    items.append((e["pdf"], page))
                else:
                    blank += len(pages.group_strokes(pages.ink(page)))
        info = self.sources().get(name) or {}
        owner = info.get("owner") or uuid.uuid4().hex[:16]
        legacy = bool(info.get("saved")) and not info.get("owner")  # 改版前存回过：那时写的批注没带归属，这次一起换掉
        with self.edit_lock, self.pdf_lock:
            res = pdfsave.save(src, items, self.keeper, self.data / "cache", owner=owner, legacy=legacy)
        self.set_source(name, src, saved=datetime.now().isoformat(timespec="seconds"), owner=owner)
        kept = res.pop("kept", None)
        if kept:  # 记下这一次存回（撤回时知道是存回、不用重新转换，也知道之后又改过没有）
            e = self.record_edit(kept, src, "savepdf", src)
            try:
                self.change_edit(e["eid"], post=file_sha(src), book=nb)
            except OSError:
                pass
        un = self.unplaced(nb)
        res.update(file=str(src), name=src.name, blank=blank, unplaced=sum(un.values()), unplaced_pages=[i + 1 for i in sorted(un)],
                   undo=bool(self.keeper.history(src)))
        return res

    def dismiss_offers_for(self, paths):
        want = {str(Path(p).resolve()).lower() for p in paths}
        with self.file_lock:
            items = self.offers()
            hit = False
            for o in items:
                if o["state"] == "new" and str(Path(o["path"]).resolve()).lower() in want:
                    o["state"] = "dismissed"
                    hit = True
            if hit:
                self.save_offers(items)

    def rename_book(self, name, new_name):
        """书改名：PDF、本子目录（笔迹、对比记录）、原文件记录一起改。返回新的本子 id。"""
        with self.file_lock:
            old_dir = self._nb_dir("book:" + name)
            new_dir = self.data / "notebooks" / ("book-" + hashlib.sha1(new_name.encode()).hexdigest()[:12])
            if new_dir.exists():  # 以前用过这个名字的本子目录：挪开，不覆盖
                os.replace(new_dir, new_dir.with_name(new_dir.name + "-old-" + uuid.uuid4().hex[:4]))
            os.replace(self.books / name, self.books / new_name)
            os.replace(old_dir, new_dir)
            (new_dir / "meta.json").write_text(json.dumps({"book": new_name}, ensure_ascii=False), "utf-8")
            s = self.sources()
            if name in s:
                s[new_name] = s.pop(name)
                (self.books / "_sources.json").write_text(json.dumps(s, ensure_ascii=False, indent=1), "utf-8")
            self._docs = {k: v for k, v in self._docs.items() if k[0] != name}
        w = self.bridge.where
        if w and w.get("nb") == "book:" + name:
            w["nb"] = "book:" + new_name
        self.folders_touch(lambda fs: folders.rename_member(fs, "book:" + name, "book:" + new_name))  # 在文件夹里的跟着走
        return "book:" + new_name

    def rename_notebook(self, nb, title):
        """平板上给本子改名：自己建的本子改标题；导入的书连 PDF 文件一起改名（笔迹、原文件记录跟着走）。
        记进 history.json，按旧名字记的投递还找得到。返回新的本子 id。"""
        title = "".join(c for c in str(title or "") if c.isprintable() and c not in '<>:"/\\|?*').strip()
        title = " ".join(title.split())[:80]
        if not title:
            raise ValueError("名字是空的")
        if nb.startswith("pad:"):
            with self.file_lock:
                items = self.pads()
                hit = next((p for p in items if p["id"] == nb[4:]), None)
                if not hit:
                    raise KeyError(f"没有这个本子：{nb}")
                hit["title"] = title[:40]
                self._save_pads(items)
            return nb
        if not nb.startswith("book:"):
            raise ValueError("草稿本和「Claude 推送」不能改名")
        name = nb[5:]
        self.book_path(name)
        new = f"{title}.pdf"
        if new == name:
            return nb
        if new.lower() != name.lower() and (self.books / new).exists():
            raise ValueError(f"已经有一本叫《{title}》的了")
        new_nb = self.rename_book(name, new)
        hist_f = self._nb_dir(new_nb) / "history.json"
        hist = json.loads(hist_f.read_text("utf-8")) if hist_f.exists() else []
        hist.append({"t": datetime.now().isoformat(timespec="seconds"), "from": Path(name).stem, "to": title, "renamed": True})
        hist_f.write_text(json.dumps(hist, ensure_ascii=False, indent=1), "utf-8")
        return new_nb

    def delete_book(self, nb):
        """从本子列表里删掉一本：PDF 挪到 books/_已删除/，笔迹目录改名留着，都能找回。"""
        if nb.startswith("pad:"):
            title = self.nb_title(nb)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            with self.file_lock:
                d = self._nb_dir(nb)
                os.replace(d, d.with_name(f"_deleted-{stamp}-{d.name}"))
                self._save_pads([p for p in self.pads() if p["id"] != nb[4:]])
            self.folders_touch(lambda fs: folders.forget(fs, nb))  # 文件夹里不再记它
            return title
        if not nb.startswith("book:"):
            raise ValueError("草稿本和「Claude 推送」不能删")
        name = nb[5:]
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        with self.file_lock:
            d = self._nb_dir(nb)
            trash = self.books / "_已删除"
            trash.mkdir(exist_ok=True)
            os.replace(self.books / name, trash / f"{Path(name).stem}.{stamp}.pdf")
            os.replace(d, d.with_name(f"_deleted-{stamp}-{d.name}"))
            s = self.sources()
            if s.pop(name, None):
                (self.books / "_sources.json").write_text(json.dumps(s, ensure_ascii=False, indent=1), "utf-8")
            self._docs = {k: v for k, v in self._docs.items() if k[0] != name}
        self.folders_touch(lambda fs: folders.forget(fs, nb))  # 文件夹里不再记它：以后再导入同名的书，是新的一本，在文件夹外面
        return Path(name).stem

    def change_summary(self, nb):
        ch = self.changes(nb) or {"pages": {}, "removed": [], "removed_with_ink": []}
        changed = [int(j) + 1 for j, p in ch["pages"].items() if p["status"] == "changed"]
        added = [int(j) + 1 for j, p in ch["pages"].items() if p["status"] == "new"]
        parts = []
        if changed:
            parts.append(f"第 {'、'.join(map(str, sorted(changed)))} 页有改动")
        if added:
            parts.append(f"新增第 {'、'.join(map(str, sorted(added)))} 页")
        if ch["removed"]:
            parts.append(f"删掉了旧版第 {'、'.join(str(i + 1) for i in ch['removed'])} 页"
                         + ("（上面的手写另存了）" if ch.get("removed_with_ink") else ""))
        text = "；".join(parts) or "内容没有变化"
        renamed = bool(ch.get("from") and ch.get("to") and ch["from"] != ch["to"])
        headline = f"从《{ch['from']}》换成了《{ch['to']}》：{text}" if renamed else text
        old_id = f"book:{ch['from']}.pdf" if ch.get("from") else nb
        return {"id": nb, "old_id": old_id, "title": Path(nb[5:]).stem, "changed": sorted(changed), "added": sorted(added),
                "removed": [i + 1 for i in ch["removed"]], "text": text, "headline": headline,
                "prev": ch["from"] if renamed else None}

    def old_page_jpeg(self, nb, j):
        """更新前那一版里，与新版第 j 页对应的那一页（渲染成图）。"""
        ch = self.changes(nb)
        p = (ch or {}).get("pages", {}).get(str(j))
        if not p or p["old"] is None:
            raise KeyError("这一页没有旧版")
        old_pdf = Path(ch["old_pdf"])
        key = hashlib.sha1(f"{old_pdf}|{p['old']}|{RENDER_PX}".encode()).hexdigest()[:20]
        cached = self.data / "cache" / f"old-{key}.jpg"
        if not cached.exists():
            with self.pdf_lock, fitz.open(str(old_pdf)) as doc:
                page = doc[p["old"]]
                zoom = RENDER_PX / page.rect.width
                cached.write_bytes(page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False).tobytes("jpg", jpg_quality=88))
        return cached.read_bytes()

    def import_document(self, src, title=None, register=True, as_new=False):
        """把文件导入为一本「书」（统一转成 PDF 放进 books/），返回本子 id。原件另存在 books/_原件/。

        同一个原文件再导入时，原地更新原来那本（笔迹保留），除非 as_new。
        """
        src = Path(src)
        if not src.is_file():
            raise ValueError(f"找不到文件：{src}")
        if src.suffix.lower() not in IMPORT_EXT:
            raise ValueError(f"不支持的文件类型：{src.suffix}（可以导入 {IMPORT_KINDS}）")
        same = self.book_of_source(src) if register and not as_new else None
        if same:
            self.update_document("book:" + same, src)
            return "book:" + same
        bad = '<>:"/\\|?*'
        stem = "".join(c for c in (title or src.stem) if c.isprintable() and c not in bad).strip() or "文档"
        dest = self.books / f"{stem}.pdf"
        n = 1
        while dest.exists():
            n += 1
            dest = self.books / f"{stem} ({n}).pdf"
        tmp = self.data / "cache" / f"import-{uuid.uuid4().hex[:8]}.pdf"
        hidden = convert_to_pdf(src, tmp, *self.pdf_owners(src))
        os.replace(tmp, dest)
        self.set_doc_info("book:" + dest.name, hidden)
        if src.suffix.lower() != ".pdf":
            keep = self.books / "_原件"
            keep.mkdir(exist_ok=True)
            if src.parent.resolve() != keep.resolve():
                shutil.copyfile(src, keep / src.name)
        if register:
            self.set_source(dest.name, src)
        # 新导入的本子在文件夹外面（以前同名的书删掉时文件夹里没清干净的，这里清掉）
        self.folders_touch(lambda fs: folders.forget(fs, "book:" + dest.name))
        return "book:" + dest.name

    def board_image(self, i):
        idx = self.board_index()["pages"]
        if not 0 <= i < len(idx):
            raise KeyError("没有这一页")
        return (self.data / "notebooks" / "board" / idx[i]["file"]).read_bytes()

    # -- 本子与页面

    def notebooks(self):
        items = [{"id": "scratch", "title": "草稿本"}]
        items += [{"id": "pad:" + p["id"], "title": p["title"]} for p in self.pads()]
        if self.board_index()["pages"]:
            items.append({"id": "board", "title": "Claude 推送"})
        if fitz is not None:
            items += [{"id": "book:" + n, "title": Path(n).stem} for n in self.book_names()]
        for it in items:
            if self.is_local(it["id"]):
                it["local"] = True
        return items

    def _nb_dir(self, nb):
        if nb in ("scratch", "board"):
            d = self.data / "notebooks" / nb
        elif nb.startswith("pad:"):
            pid = nb[4:]
            if pid not in {p["id"] for p in self.pads()}:
                raise KeyError(f"没有这个本子：{nb}")
            d = self.data / "notebooks" / f"pad-{pid}"
        elif nb.startswith("book:"):
            name = nb[5:]
            self.book_path(name)
            d = self.data / "notebooks" / ("book-" + hashlib.sha1(name.encode()).hexdigest()[:12])
            d.mkdir(parents=True, exist_ok=True)
            meta = d / "meta.json"
            if not meta.exists():
                meta.write_text(json.dumps({"book": name}, ensure_ascii=False), "utf-8")
        else:
            raise KeyError(f"没有这个本子：{nb}")
        d.mkdir(parents=True, exist_ok=True)
        return d

    # -- 自己新建的空白本子（随笔、想法、读书笔记……）

    def pads(self):
        f = self.data / "notebooks" / "pads.json"
        return json.loads(f.read_text("utf-8")) if f.exists() else []

    def _save_pads(self, items):
        (self.data / "notebooks" / "pads.json").write_text(json.dumps(items, ensure_ascii=False, indent=1), "utf-8")

    def new_pad(self, title, paper="portrait"):
        title = "".join(c for c in str(title or "") if c.isprintable()).strip()[:40] or "新本子"
        pid = uuid.uuid4().hex[:8]
        with self.file_lock:
            items = self.pads()
            items.append({"id": pid, "title": title, "created": datetime.now().isoformat(timespec="seconds")})
            self._save_pads(items)
        nb = "pad:" + pid
        self.set_setting(nb, "paper", "landscape" if paper == "landscape" else "portrait")
        return nb

    def kind_of(self, nb):
        return "book" if nb.startswith("book:") else "pad" if nb.startswith("pad:") else nb

    def blank_nb(self, nb):
        """空白本子（草稿本、自己新建的本子；平板的 blankNb）：服务端画的图整页是纸、没有右边那一栏（pages.blank_rect）。"""
        return self.kind_of(nb) in ("scratch", "pad")

    def nb_title(self, nb):
        kind = self.kind_of(nb)
        if kind == "book":
            return Path(nb[5:]).stem
        if kind == "pad":
            return next((p["title"] for p in self.pads() if p["id"] == nb[4:]), "本子")
        return {"scratch": "草稿本", "board": "Claude 推送"}.get(kind, nb)

    # -- 抽屉里的文件夹（folders.py）：只是归类，不动本子的数据

    def nb_ids(self):
        """现在列表里有的本子（和 notebooks() 的 id 一样，不读各本的设置）。"""
        ids = {"scratch"} | {"pad:" + p["id"] for p in self.pads()}
        if self.board_index()["pages"]:
            ids.add("board")
        if fitz is not None:
            ids |= {"book:" + n for n in self.book_names()}
        return ids

    def folder_list(self):
        """给平板的文件夹：items 里只留现在还在的本子（删掉的、对不上的照旧留在文件里，不报错）。"""
        ids = self.nb_ids()
        return [dict(f, items=[i for i in f["items"] if i in ids]) for f in folders.load(self.data)]

    def change_folders(self, fn):
        """改文件夹：读出来（读不出来就报错，不覆盖）、fn 改、写回、告诉平板。返回 fn 的结果。"""
        with self.folder_lock:
            items = folders.load(self.data, strict=True)
            out = fn(items)
            folders.save(self.data, items)
        self.bridge.emit("folders")
        return out

    def folders_touch(self, fn):
        """本子删掉、改名时顺带改文件夹里的记录：没有文件夹文件、或没改到就不写；出错不影响删除和改名本身。"""
        try:
            with self.folder_lock:
                if not folders.path_of(self.data).exists():
                    return
                items = folders.load(self.data, strict=True)
                if not fn(items):
                    return
                folders.save(self.data, items)
            self.bridge.emit("folders")
        except (OSError, ValueError) as e:
            print(f"[提示] 文件夹的记录没跟着改：{e}", flush=True)

    # -- 本子设置（本子目录下 settings.json）：目前只有新建本子的纸张方向

    def setting(self, nb, key, default=None):
        f = self._nb_dir(nb) / "settings.json"
        return (json.loads(f.read_text("utf-8")) if f.exists() else {}).get(key, default)

    def is_local(self, nb):
        return bool(self.setting(nb, "local", False))

    def ensure_shareable(self, nb, which=None):
        """设为「只在本地」的本子不发给 Claude：发送、整本检测、快照、确认字迹都在这里拦下（Claude 往里写、往里放在 ensure_writable 里另拦）。

        which：经 /bridge/* 回给 Claude 时说成哪一本（「平板上开着的这一本」「这一页所在的那本」），不带书名（2026-11-16 用户定
        「拦住，也不列名字」）。不给就写《书名》：平板上用户自己点「AI」时，和 Claude 写全了名字的整本检测（名字是它自己写的）。"""
        if nb and self.is_local(nb):
            who = which or f"《{self.nb_title(nb)}》"
            raise ValueError(f"{who}设为「只在本地」，不发给 Claude。要发的话，在平板抽屉里点「这本发往」选一个对话。")

    def ensure_writable(self, nb, which, doing, again, tail=""):
        """设为「只在本地」的本子，Claude 一侧（/bridge/*）也不往里放东西、不换掉它：写回批注（用户 2026-11-12 定）；
        导入时原地更新、按 replace 替换、另存出来的新文件换掉它、往「Claude 推送」推页面（2026-11-16 定「拦住，也不列名字」）。
        在动任何东西之前调，拦下时什么都没写。回给 Claude 的话按写批注那一句的样子拼：which 是开头（「这一页所在的那本」
        「这个文件导入成的那本」……，都不带书名），doing 是 Claude 不做的事，again 是「要……的话」里的动作。
        用户自己在平板上的导入、更新、替换（/api/*）不经过这里，照常。"""
        if nb and self.is_local(nb):
            raise ValueError(f"{which}只在本地：用户设了不发给 Claude，Claude 也不{doing}。"
                             f"要{again}的话，请用户在平板抽屉里点「这本发往」选一个对话（就取消了只在本地）。{tail}")

    def set_setting(self, nb, key, value):
        f = self._nb_dir(nb) / "settings.json"
        s = json.loads(f.read_text("utf-8")) if f.exists() else {}
        s[key] = value
        f.write_text(json.dumps(s, ensure_ascii=False), "utf-8")

    # -- 发往哪个对话：每本记住自己的对话，不随「最近打字」漂移

    ROUND_STAGES = ("sent", "queued", "delivered", "reading", "working", "replied", "done")

    def progress(self, sub_id, stage, sid=""):
        """这一轮到哪一步了：平板显示，时刻写进 data/metrics/rounds.jsonl（每次投递每一步只记第一次）。

        sent 平板发出（服务收到）、queued 对话正忙在排队、delivered 进了对话、reading Claude 读了投递的图、
        working 在改文件（Write、Edit、Bash 等）、replied 第一次写回草稿纸、done 这一轮结束。"""
        if stage not in self.ROUND_STAGES or not sub_id:
            return False
        with self.file_lock:
            seen = self._rounds.setdefault(sub_id, set())
            if stage in seen:
                return False
            seen.add(stage)
            if len(self._rounds) > 500:  # 只留最近的
                for k in list(self._rounds)[:100]:
                    del self._rounds[k]
            t = int(time.time() * 1000)
            f = self.data / "metrics" / "rounds.jsonl"
            f.parent.mkdir(parents=True, exist_ok=True)
            with f.open("a", encoding="utf-8") as fp:
                fp.write(json.dumps({"id": sub_id, "stage": stage, "t": t, "sid": sid}, ensure_ascii=False) + "\n")
        self.bridge.emit("progress", id=sub_id, stage=stage, t=t)
        return True

    def store_figure(self, path):
        """Claude 在电脑上生成的图（PNG、JPG、SVG）存进 data/figures，统一画成白底 PNG（最宽 1600 像素）。
        返回 {img: 文件名, iw, ih, src: 原文件}。"""
        if fitz is None:
            raise ValueError("没有安装 PyMuPDF，不能放图")
        src = Path(path)
        if not src.is_file():
            raise ValueError(f"figure 的 path 找不到文件：{path}")
        ext = src.suffix.lower()
        if ext not in FIG_EXT:
            raise ValueError("figure 只收 PNG、JPG、SVG")
        if src.stat().st_size > 20 * 1024 * 1024:
            raise ValueError("图太大（超过 20 MB）")
        raw = src.read_bytes()
        name = hashlib.sha1(raw).hexdigest()[:16] + ".png"
        d = self.data / "figures"
        d.mkdir(parents=True, exist_ok=True)
        with self.pdf_lock:
            try:
                doc = fitz.open(stream=raw, filetype=ext[1:])
            except Exception as e:  # noqa: BLE001 - 坏文件：说清楚
                raise ValueError(f"打不开这张图：{e}") from None
            try:
                pg = doc[0]
                # SVG 是矢量：放大到最宽 1600（最多 3 倍）；PNG/JPG 照原来的像素（最宽 1600），不放大
                want = 1600 if ext == ".svg" else min(1600, fitz.Pixmap(str(src)).width)
                zoom = min(3.0, want / max(pg.rect.width, 1))
                pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)  # 透明的地方铺白
                if not (d / name).exists():
                    pix.save(str(d / name))
                return {"img": name, "iw": pix.width, "ih": pix.height, "src": str(src)}
            finally:
                doc.close()

    def nb_target(self, nb):
        """这本绑定的对话 {sid, label, cwd}；没绑过是 None。"""
        t = self.setting(nb, "target") if nb else None
        return t if isinstance(t, dict) and t.get("sid") else None

    def bind_target(self, nb, sid, only_new=False):
        """把这本记成发往这个（连着的）对话；only_new：这本已经绑了别的就不动。返回那个对话，不在了返回 None。"""
        s = next((x for x in self.bridge.alive() if x["sid"] == sid), None)
        if not nb or not s or (only_new and self.nb_target(nb)):
            return s
        t = {"sid": sid, "label": s["label"], "cwd": s["cwd"]}
        if self.nb_target(nb) != t:
            self.set_setting(nb, "target", t)
            self.bridge.emit("target", nb=nb, target=t)
        return s

    def target_of(self, nb):
        """这本现在发往的对话 sid：绑了且连着的那个；绑了但不在了是 None；没绑过用默认（/ink here 指定的或最近打字的）。"""
        t = self.nb_target(nb)
        if t:
            return t["sid"] if any(s["sid"] == t["sid"] for s in self.bridge.alive()) else None
        return self.bridge.default_target()

    def send_target(self, nb, want=""):
        """发送用哪个对话，并记成这本的对话（投递时就定下，之后不再转给别的对话）。
        want：平板上刚选的。原对话不在了先问：抛 TargetGone。"""
        alive = {s["sid"]: s for s in self.bridge.alive()}
        if not alive:
            raise ValueError("没有连上的 Claude Code 对话。在电脑上打开一个装了 inkpad 插件的对话再试。")
        t = self.nb_target(nb)
        sid = want or (t["sid"] if t else self.bridge.default_target())
        if sid not in alive:
            raise TargetGone(t["label"] if t and t["sid"] == sid else "选的那个对话")
        self.bind_target(nb, sid)
        return alive[sid]

    def seen_sid(self, nb):
        """「只发新写的」按哪个对话算：这本绑定的（不在了也按它），没绑过按默认的。"""
        t = self.nb_target(nb)
        return t["sid"] if t else self.bridge.default_target()

    # -- 页面顺序：显示的第几页是什么（见 layout.py）

    def layout_of(self, nb):
        kind, d = self.kind_of(nb), self._nb_dir(nb)
        if kind == "book":
            with self.pdf_lock:
                n = len(self._doc(nb[5:]))
        elif kind == "board":
            n = len(self.board_index()["pages"])
        elif kind == "scratch":
            idx = d / "index.json"  # 以前的草稿本只记了页数
            n = json.loads(idx.read_text("utf-8")).get("pages", 1) if idx.exists() else 1
        else:
            n = 1
        return layout.Layout(d / "layout.json", kind, n)

    def page_entry(self, nb, i):
        return self.layout_of(nb).entry(int(i))

    def page_key(self, nb, i):
        return self.page_entry(nb, i)["key"]

    def index_of_key(self, nb, key):
        return self.layout_of(nb).index_of(key)

    def notebook_info(self, nb):
        kind = self.kind_of(nb)
        if kind == "board" and not self.board_index()["pages"]:
            raise KeyError("Claude 还没有推送过页面")
        lay = self.layout_of(nb)
        board = self.board_index()["pages"] if kind == "board" else []
        pdf_h = []
        if kind == "book":
            with self.pdf_lock:
                pdf_h = [round(PAGE_W * p.rect.height / p.rect.width, 1) for p in self._doc(nb[5:])]
        sizes, page_info = [], []
        paper = self.setting(nb, "paper", "portrait")
        hidden = set((self.doc_info(nb) or {}).get("hidden") or []) if kind == "book" else set()
        d = self._nb_dir(nb)
        for k, e in enumerate(lay.pages):
            if "pdf" in e:
                h = pdf_h[e["pdf"]]
            elif "board" in e:
                h = board[e["board"]]["h"]
            else:
                h = blank_height(lay, k, paper, pdf_h)
            sizes.append({"w": PAGE_W, "h": h})
            page_info.append({"key": e["key"], "pdf": e.get("pdf"), "board": e.get("board"),
                              "blank": "pdf" not in e and "board" not in e, "hiddenSlide": e.get("pdf") in hidden})
            if self.reply_waiting(nb, e["key"]):  # 有 Claude 写回、还没落到纸上的回答：平板在页码旁标「别的页有新回答」
                page_info[-1]["newAns"] = True
            n_ans = self.answer_count(d / (layout.file_stem(e["key"]) + ".json"))
            if n_ans:  # 这一页上有几条没擦掉的长回答（圈号）：卡片里的上一条、下一条跨页时找下一页用（2026-11-16 夜）
                page_info[-1]["ans"] = n_ans
        info = {"id": nb, "title": self.nb_title(nb), "kind": kind, "pages": len(lay.pages), "sizes": sizes,
                "pageInfo": page_info, "hidden": len(lay.hidden), "paper": self.setting(nb, "paper", "portrait"),
                "flow": bool(self.setting(nb, "flow", kind == "book")),  # 连续阅读：书（导入的文档）默认开
                "flowSet": self.setting(nb, "flow") is not None,  # 这本上明确选过没有：平时的页面没选过就按连续
                "local": self.is_local(nb),  # 只在本地：不发给 Claude
                "target": self.nb_target(nb)}  # 这本发往的对话（没绑过是 None）
        if kind == "board":
            info["titles"] = [board[e["board"]]["title"] if "board" in e else "空白页" for e in lay.pages]
        if kind == "book":
            name = nb[5:]
            info["v"] = int(self.book_path(name).stat().st_mtime)
            src = self.sources().get(name)
            if src:
                info["source"] = Path(src["src"]).name
                info["sourceChanged"] = self.source_changed(name)
                info["savePdf"] = self.pdf_source(name) is not None
                info["saved"] = src.get("saved")
                info["undo"] = self.undo_brief(src["src"])  # 能撤回的上一次修改（没有是 None）
            info["undone"] = self.undone_ids()  # 撤回过的修改：纸上那几条「已改」写成「已撤回」
            info["hiddenMissing"] = self.hidden_missing(nb)
            ch = self.changes(nb)
            if ch:  # 按原文件页号记的改动；edit：这次换新版是哪一次改文件，undo：是撤回换回去的
                info["changes"] = {"t": ch["t"], "from": ch.get("from"), "to": ch.get("to"), "edit": ch.get("edit"),
                                   "undo": bool(ch.get("undo")),
                                   "pages": {j: {"status": p["status"], "boxes": p["boxes"], "old": p["old"]}
                                             for j, p in ch["pages"].items() if p["status"] != "same"}}
        return info

    def add_page(self, nb):
        """在本子最后加一张空白页（所有本子都行）。"""
        with self.file_lock:
            lay = self.layout_of(nb)
            lay.insert_blank(len(lay.pages) - 1)
            lay.save()
        return self.notebook_info(nb)

    def insert_page(self, nb, after, orient=None):
        with self.file_lock:
            lay = self.layout_of(nb)
            i = lay.insert_blank(int(after), orient)
            lay.save()
        return i

    def delete_page(self, nb, i):
        with self.file_lock:
            lay = self.layout_of(nb)
            e = lay.delete(int(i))
            lay.save()
        return e

    def restore_page(self, nb, key):
        with self.file_lock:
            lay = self.layout_of(nb)
            i = lay.restore(key)
            lay.save()
        return i

    def move_page(self, nb, i, j, key=None):
        """把第 i 页挪到第 j 页（j 按挪完以后的位置算；抽屉里拖缩略图，2026-11-16 用户定）。只改页序（layout.json），
        页的键不变，各页的笔迹文件不动、不改名。key：平板以为第 i 页是哪一页（页的键）；对不上说明页序在别处改过了，不挪。
        书里的横版空白纸和前面最近一页书页一样大（blank_height）：挪完前面换了一页、算出来的高度变了的，把原来的高度记进它的页序，
        纸不因挪页变大变小（转过的页、写到纸边的字都还对得上）。返回挪完后它是第几页。"""
        with self.file_lock:
            lay = self.layout_of(nb)
            if key and lay.entry(int(i))["key"] != key:
                raise ValueError("页的先后在别处改过了：重新打开这本再挪")
            before = self._blank_heights(nb, lay)
            j = lay.move(int(i), int(j))
            after = self._blank_heights(nb, lay)
            for e in lay.pages:
                if e["key"] in before and after.get(e["key"]) != before[e["key"]]:
                    e["h"] = before[e["key"]]
            lay.save()
        self.schedule_paper(nb)  # 原稿、往来稿按新的页序重出
        return j

    def _blank_heights(self, nb, lay):
        """书里各张空白纸现在算出来的高度 {键: 高}；别的本子的空白纸高度和位置无关，返回空的。"""
        if self.kind_of(nb) != "book":
            return {}
        with self.pdf_lock:
            pdf_h = [round(PAGE_W * p.rect.height / p.rect.width, 1) for p in self._doc(nb[5:])]
        paper = self.setting(nb, "paper", "portrait")
        return {e["key"]: blank_height(lay, k, paper, pdf_h) for k, e in enumerate(lay.pages) if "pdf" not in e}

    def hidden_pages(self, nb):
        lay = self.layout_of(nb)
        board = self.board_index()["pages"] if nb == "board" else []
        out = []
        for h in reversed(lay.hidden):
            e = h["entry"]
            label = (f"原文件第 {e['pdf'] + 1} 页" if "pdf" in e else board[e["board"]]["title"] if "board" in e
                     else "空白页")
            f = self._key_file(nb, e["key"])
            ink = f.exists() and pages.has_ink(json.loads(f.read_text("utf-8")))
            out.append({"key": e["key"], "label": label, "ink": ink, "t": h["t"]})
        return out

    def _key_file(self, nb, key, suffix=".json"):
        return self._nb_dir(nb) / (layout.file_stem(key) + suffix)

    def _page_file(self, nb, i, suffix=".json"):
        return self._key_file(nb, self.page_key(nb, i), suffix)

    def load_page(self, nb, i):
        f = self._page_file(nb, i)
        if f.exists():
            return f.read_text("utf-8")
        return json.dumps({"v": 1, "strokes": [], "ai": [], "reads": []})

    def save_page(self, nb, i, body, client=""):
        """存平板发来的一页。页面带版本号 rev 和最后写它的设备 by：
        平板发来的 rev 落后于文件、而文件又是别的设备写的，说明这一页在别处改过了——不覆盖，
        把这份另存到 data/conflicts/，抛 Conflict（平板据此载入新版本）。同一台设备连着存几次不算冲突。
        返回存好后的版本号。没带 rev 的（旧版平板页面）照旧直接存。"""
        page = json.loads(body)
        if not isinstance(page, dict) or not isinstance(page.get("strokes"), list):
            raise ValueError("页面数据格式不对")
        with self.page_lock:
            f = self._page_file(nb, i)
            cur = {}
            if f.exists():
                try:
                    cur = json.loads(f.read_text("utf-8"))
                except ValueError:
                    cur = {}
            cur_rev, cur_by = int(cur.get("rev") or 0), cur.get("by") or ""
            base = page.get("rev")
            if isinstance(base, int) and base != cur_rev and cur_by != client:
                d = self.data / "conflicts"
                d.mkdir(exist_ok=True)
                keep = d / f"{f.parent.name}-{f.stem}-{datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:4]}.json"
                keep.write_text(body if isinstance(body, str) else body.decode("utf-8"), "utf-8")
                print(f"[冲突] {self.page_label(nb, i)} 在别的设备上改过了；这份另存为 {keep.name}")
                raise Conflict(f"这一页在别的设备上改过了。你这边没存上的改动另存在电脑上：data/conflicts/{keep.name}")
            page["rev"], page["by"] = cur_rev + 1, client
            tmp = f.with_suffix(".tmp")
            tmp.write_text(json.dumps(page, ensure_ascii=False, separators=(",", ":")), "utf-8")
            os.replace(tmp, f)
            self.schedule_paper(nb)
            return page["rev"]

    # -- 原稿与往来稿（2026-11-08 用户提出）：每本纸在 paper_dir/<本子名>/ 下有两份 PDF——原稿.pdf 只有我写的
    #    （黑字、红字），往来.pdf 再加上 Claude 的蓝字（横划掉的画淡，橡皮擦掉的不画；长回答在纸上只是圈号，
    #    全文另起一页「第 N 页的回答」紧跟在那一页后面）。存页后停笔一会儿重出；
    #    服务启动时把上次之后改过的补上

    def schedule_paper(self, nb):
        if not self.paper_dir:
            return
        with self._paper_lock:
            old = self._paper_timers.pop(nb, None)
            if old:
                old.cancel()
            t = threading.Timer(self.paper_delay, self.export_paper, [nb])
            t.daemon = True
            self._paper_timers[nb] = t
            t.start()

    def paper_folder(self, nb):
        title = self.nb_title(nb)
        name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", title).strip(" .")[:80] or "本子"
        if sum(1 for it in self.notebooks() if it.get("title") == title) > 1:  # 同名的几本：各用各的文件夹，不互相盖掉
            name += "（" + self._nb_dir(nb).name.split("-")[-1][:8] + "）"
        return self.paper_dir / name

    def export_paper(self, nb):
        """导出这一本的原稿.pdf 和往来.pdf，返回所在文件夹；只导出写过东西的页，一页都没有就不出。
        出错（比如文件正被别的程序打开占着）只打印一行，下次存页时再试。"""
        with self._paper_lock:
            self._paper_timers.pop(nb, None)
        if not self.paper_dir:
            return None
        try:
            lay, items = self.layout_of(nb), []
            for i in range(len(lay.pages)):
                page = json.loads(self.load_page(nb, i))
                if not pages.has_ink(page) and not any(not a.get("erasedAt") for a in page.get("ai") or []):
                    continue
                base_h, bg = self.page_base(nb, i, page)
                items.append((page, base_h, bg, i + 1))  # 页码写在往来稿的「第 N 页的回答」里
            if not items:
                return None
            d = self.paper_folder(nb)
            d.mkdir(parents=True, exist_ok=True)
            blank = self.blank_nb(nb)  # 空白本子：整页是纸，没有右边那一栏
            pages.export_pdf(items, d / "原稿.pdf", ai=False, blank=blank)
            pages.export_pdf(items, d / "往来.pdf", ai=True, blank=blank)
            return d
        except Exception as e:  # noqa: BLE001 - 导出失败不影响存页
            print(f"[纸] 《{self.nb_title(nb)}》的原稿、往来稿没导出：{e}")
            return None

    def export_stale_papers(self):
        """服务启动时：上次导出之后改过的本子补导一遍（比本子目录里页面文件和往来.pdf 的修改时间）。"""
        if not self.paper_dir:
            return
        for it in self.notebooks():
            nb = it["id"]
            try:
                files = [f for f in self._nb_dir(nb).glob("*.json") if f.name not in ("seen.json", "settings.json")]
                newest = max((f.stat().st_mtime for f in files), default=0)
                out = self.paper_folder(nb) / "往来.pdf"
                if newest and (not out.exists() or out.stat().st_mtime < newest):
                    self.export_paper(nb)
            except Exception as e:  # noqa: BLE001
                print(f"[纸] 补导《{it.get('title')}》没成功：{e}")

    def page_label(self, nb, i):
        lay = self.layout_of(nb)
        e, title = lay.entry(int(i)), self.nb_title(nb)
        if nb.startswith("book:"):
            if "pdf" in e:
                orig = "" if e["pdf"] == i else f"，原文件第 {e['pdf'] + 1} 页"
                hid = "，PPT 里的隐藏页" if e["pdf"] in set((self.doc_info(nb) or {}).get("hidden") or []) else ""
                z = (self.sources().get(nb[5:]) or {}).get("zotero")
                cite = ""
                if z:  # 从 Zotero 导入的：说明是哪篇文献，Claude 需要时可以按条目号去查
                    who = " · ".join(x for x in (z.get("creators"), z.get("year"), z.get("type")) if x)
                    cite = f"；Zotero 文献：{who}《{z.get('title')}》，条目 {z.get('item')}"
                return f"《{title}》第 {i + 1} 页（书页{orig}{hid}{cite}，我在上面写写画画）"
            prev = next((x["pdf"] for x in reversed(lay.pages[:i]) if "pdf" in x), None)
            where = f"插在原文件第 {prev + 1} 页后" if prev is not None else "插在最前面"
            return f"《{title}》第 {i + 1} 页（{where}的空白纸）"
        if nb == "board":
            if "board" in e:
                return f"你推送到平板的「{self.board_index()['pages'][e['board']]['title']}」（我在上面写写画画）"
            return f"「Claude 推送」第 {i + 1} 页（插入的空白纸）"
        return f"{title}第 {i + 1} 页（空白草稿纸）"

    def page_role(self, nb, i):
        """这一页是谁的内容（给 Claude 判断角色用）：blank 空白纸、zotero 文献、editable 能改的文档（带原文件）、
        pdf 说不准的 PDF（带原文件）、board Claude 推送的。"""
        kind = self.kind_of(nb)
        e = self.page_entry(nb, i)
        if kind == "board":
            return {"page": "board" if "board" in e else "blank"}
        if kind != "book" or "pdf" not in e:
            return {"page": "blank"}
        info = self.sources().get(nb[5:]) or {}
        if info.get("zotero"):
            return {"page": "zotero"}
        src = info.get("src")
        if src and Path(src).suffix.lower() in EDITABLE_EXT:
            return {"page": "editable", "src": src}
        return {"page": "pdf", "src": src} if src else {"page": "pdf"}

    def page_text(self, nb, i):
        """这一页的书本原文；不是书页（空白纸、推送页）返回空串。"""
        if nb.startswith("book:") and fitz is not None:
            e = self.page_entry(nb, i)
            if "pdf" in e:
                return self.book_text(nb[5:], e["pdf"])
        return ""

    def page_thumb(self, nb, i):
        """抽屉里的页面缩略图（底图 + 笔迹，宽约 170 像素），按页文件和底图的版本缓存。
        书页、推送页只画到正文区的右边（PAGE_W）；空白本子整页是纸，写到原来那一栏位置的字也画进来（阶段 E；缓存的键带 b2，换掉以前的）。"""
        e = self.page_entry(nb, i)
        f = self._key_file(nb, e["key"])
        blank = self.blank_nb(nb)
        ver = f"{nb}|{e}|{f.stat().st_mtime if f.exists() else 0}|{self.book_path(nb[5:]).stat().st_mtime if nb.startswith('book:') else 0}"
        ver += "|b2" if blank else ""
        out = self.data / "cache" / f"thumb-{hashlib.sha1(ver.encode()).hexdigest()[:20]}.png"
        if not out.exists():
            page = json.loads(self.load_page(nb, i))
            base_h, bg = self.page_base(nb, i, page)
            bare = dict(page, ai=[])
            right, bottom = pages.content_extent(bare, base_h, blank=blank)
            left, top = pages.content_origin(bare, blank=blank)
            right = right if blank else PAGE_W
            pages.render_page(bare, str(out), base_h, bg, (), 170 / (right - left),
                              [left, top, right, max(base_h, min(bottom, base_h * 1.6))], blank=blank)
        return out.read_bytes()

    # -- Claude 写回的批注：先放进每页的待处理文件，平板打开那一页时排版（按页的键存，插页、删页不影响）

    def add_pending(self, nb, key, entry):
        with self.file_lock:
            f = self._key_file(nb, key, ".pending.json")
            items = json.loads(f.read_text("utf-8")) if f.exists() else []
            items.append(entry)
            f.write_text(json.dumps(items, ensure_ascii=False), "utf-8")

    def take_pending(self, nb, i):
        with self.file_lock:
            f = self._page_file(nb, i, ".pending.json")
            if not f.exists():
                return []
            items = json.loads(f.read_text("utf-8"))
            f.unlink()
            return items

    def reply_waiting(self, nb, key):
        """这一页有没有 Claude 写回、还没落到纸上的回答（2026-11-16，「别的页有新回答」的记号用）：待处理文件里有看得见的条目
        （只有读法的、只是记账的 lsent、msent、vsent 不算）。只读，不取走、不改任何文件。没加锁：正好在写的那一刻读到半截就当没有，
        平板那边还有事件补上。"""
        f = self._key_file(nb, key, ".pending.json")
        if not f.exists():
            return False
        try:
            entries = json.loads(f.read_text("utf-8"))
        except (OSError, ValueError):
            return False
        return isinstance(entries, list) and any(isinstance(e, dict) and shown_items(e.get("items")) for e in entries)

    def answer_count(self, f):
        """页的数据文件 f 上没擦掉的长回答（带圈号的 write，和平板 isBadge 一样认）有几条（2026-11-16 夜，卡片里的上一条、
        下一条跨页时，平板靠它知道别的页有没有回答，不用把每页都载下来）。只读，不写任何文件；按文件的修改时间和大小记着，
        没改过就不再读（页数多的书也不慢）。文件不在、读到半截或坏了算 0。还没落到纸上的回答（待处理文件里的）不算。"""
        try:
            st = f.stat()
        except OSError:
            return 0
        sig, key = (st.st_mtime_ns, st.st_size), str(f)
        hit = self._ans_cache.get(key)
        if hit and hit[0] == sig:
            return hit[1]
        try:
            page = json.loads(f.read_text("utf-8"))
            n = sum(1 for a in page.get("ai") or [] if is_badge(a))
        except (OSError, ValueError, AttributeError, TypeError):
            n = 0
        self._ans_cache[key] = (sig, n)
        return n

    # -- 投递

    def save_submission(self, req, snapshot=False, reader=None):
        """存下平板交上来的一页，写成给对话的消息。返回（投递编号, 消息）。
        reader：收这条消息的对话（默认是发往的对话），领域词表取它所在项目的。"""
        imgs = req.get("images") or {}
        cr = b64_of(imgs.get("crop"))
        if not cr:
            raise ValueError("缺少页面截图")
        now = datetime.now()
        sub_id = now.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        d = self.data / "submissions" / sub_id
        d.mkdir(parents=True)
        # 这一页的图：消息里列的就是它，Claude 给的 box 也按它的像素算。以前平板另画的整页概览（overview）不再要，旧页面发来了也不存
        paths = {"crop": str(d / "crop.jpg")}
        Path(paths["crop"]).write_bytes(base64.b64decode(cr))
        nb, i = str(req.get("nb") or "scratch"), int(req.get("page") or 0)
        meta = {k: v for k, v in req.items() if k != "images"}
        meta.update(nb=nb, page=i, page_key=self.page_key(nb, i), id=sub_id, snapshot=snapshot,
                    created=now.isoformat(timespec="seconds"), role=self.page_role(nb, i))
        page = json.loads(self.load_page(nb, i))
        t0 = time.perf_counter()
        self.attach_reco(nb, i, meta.get("groups") or [], only=lambda g: g.get("inSel") or prompt.asking(g), page=page)
        t1 = time.perf_counter()
        self.attach_sheet(meta.get("groups") or [], page, d, paths)
        t2 = time.perf_counter()
        if t2 - t0 > 1:  # 认字慢了：记一句，真机时好查
            print(f"[认字] Windows 识别 {t1 - t0:.1f} 秒，字帖和 PP-OCR {t2 - t1:.1f} 秒")
        meta.pop("cards", None)  # 卡片由服务端按存好的这一页挑，不认平板发来的
        if not snapshot:  # 长回答卡片上的红字（还没交的、交了还没被回应的）：每张卡片画一张图，连同红字一起交
            cards = self.card_images(page, d)
            if cards:
                meta["cards"] = cards
        book_text = self.page_text(nb, i)
        meta["corrections"] = self.corrections_for(meta.get("groups") or [], (book_text,))
        meta["vocab"] = self.vocab_for(nb, reader or meta.get("target") or "", book_text)
        if not snapshot:  # 之前采纳了、Claude 还没回报改成了没有的修改：这次消息里列出来（B 组⑤）
            meta["owed"] = self.owed_for(meta.get("target") or "", skip={v.get("ref") for v in meta.get("verdicts") or [] if isinstance(v, dict)})
        e = self.page_entry(nb, i) if nb.startswith("book:") else {}
        src = (str(self.book_path(nb[5:])), e["pdf"] + 1) if "pdf" in e else None
        text = prompt.build_message(meta, paths, self.page_label(nb, i), book_text, sub_id, snapshot, src=src)
        if snapshot:  # 快照：卡片、小蓝点上还没交的红字图里看不到，也不附卡片的图——如实说一句（放在最后那句「写回用……」前面）
            unsent = snapshot_unsent(*pages.unsent_on_page(page))
            if unsent:
                parts = text.split("\n\n")
                text = "\n\n".join(parts[:-1] + [unsent] + parts[-1:])
        (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
        (d / "message.txt").write_text(text, "utf-8")
        if not snapshot:  # 这次采纳的、在文档上的修改：记下，Claude 没用 result 回报就在之后的消息里提醒
            self.record_owed(sub_id, meta.get("target"), nb, self.owed_rows(meta.get("verdicts"), meta["page_key"]))
        return sub_id, text

    def card_images(self, page, d, prefix=""):
        """这一页上要连同红字一起交的长回答卡片：每张画成 d/<prefix>card-<圈号>.png（pages.render_card）。
        返回 [{id, n, q, img, marks, note?}]，marks 是这次交的红字的 id（平板据此记下「交过了」）；
        note 为 True 的是纸上的短批注收成的卡片（用户在那条短批注上写了红字，平板交稿时把它收成了圈号，见 pages.from_note）。"""
        out = []
        for it, marks in pages.cards_to_send(page):
            img = d / f"{prefix}card-{it.get('n') or len(out) + 1}.png"
            try:
                pages.render_card(it, marks, str(img))
            except Exception as e:  # noqa: BLE001 - 画不出来就不附这张卡片（红字留着，下次再交）
                print(f"[卡片] 圈号 {it.get('n')} 的卡片没画成：{e}")
                continue
            c = {"id": it.get("id"), "n": it.get("n"), "q": it.get("q"), "img": str(img), "marks": [m.get("id") for m in marks]}
            if pages.from_note(it):
                c["note"] = True
            out.append(c)
        return out

    def load_submission(self, sub_id):
        d = (self.data / "submissions" / sub_id).resolve()
        if d.parent != (self.data / "submissions").resolve() or not (d / "meta.json").exists():
            raise KeyError(f"没有这次投递：{sub_id}")
        return json.loads((d / "meta.json").read_text("utf-8"))

    def latest_submission_for(self, sid):
        subs = sorted((self.data / "submissions").iterdir(), reverse=True)
        for d in subs[:200]:
            f = d / "meta.json"
            if f.exists():
                meta = json.loads(f.read_text("utf-8"))
                # 指得出是哪一页的才算：盘上可能还留着以前没有页的投递（平板上的文字回复、旧批注判断，功能已删）
                if meta.get("target") == sid and (meta.get("kind") == "scan" or "page" in meta):
                    return meta
        return None

    def attach_reco(self, nb, i, groups, only=None, page=None):
        """给笔迹分组加上本机手写识别的候选（g["reco"]）。

        groups 是平板发来的（或服务端算的）分组；和服务器上存的这一页对得上的才认（pages.sent_groups）。
        认之前判断中文还是英文，判出的语种放进 g["reco_lang"]（recognize.choose）。
        """
        if not recognize.AVAILABLE or not groups:
            return
        if page is None:
            page = json.loads(self.load_page(nb, i))
        mine = pages.sent_groups([g for g in groups if not only or only(g)], page)
        reco = recognize.recognize_lang(list(mine.items()))
        for g in groups:
            if g.get("id") in reco:
                g["reco"], g["reco_lang"] = reco[g["id"]]["text"], reco[g["id"]]["lang"]

    def line_anchors(self, loc, items):
        """「g3:1」这类锚点：一组笔迹写了几行（比如列表的编号和上一行连着写成一组），只指其中第 k 行。
        按存好的笔迹分行（inksheet.lines，和投递时数的一样），把那一行作为一个小组加进这次回写的分组；
        对不上（行号超了、页面转过）就当整组。返回 (groups, gx) 的新副本，平板按它定位、跟着擦除收起。"""
        want = set()
        for it in items:
            for v in [it.get(k) for k in ("anchor", "from", "to")] + list(it.get("anchors") or []):
                if isinstance(v, str) and LINE_ANCHOR.fullmatch(v):
                    want.add(v)
        groups, gx = dict(loc.get("groups") or {}), dict(loc.get("gx") or {})
        if not want:
            return groups, gx
        page = json.loads(self.load_page(loc["nb"], loc["page"]))
        by_id = {s.get("id"): s for s in page.get("strokes") or []}
        same_rot = (page.get("rot") or 0) == (loc.get("rot") or 0)
        for a in want:
            gid, k = a.split(":")
            ss = [by_id[i] for i in (gx.get(gid) or {}).get("ids") or [] if i in by_id and not by_id[i].get("erasedAt")]
            lines = inksheet.lines(ss) if same_rot else []
            if 1 <= int(k) <= len(lines):
                ln = lines[int(k) - 1]
                bs = [pages.stroke_box(s) for s in ln]
                groups[a] = [round(min(b[0] for b in bs)), round(min(b[1] for b in bs)), round(max(b[2] for b in bs)), round(max(b[3] for b in bs))]
                gx[a] = dict(gx.get(gid) or {}, ids=[s.get("id") for s in ln])
            elif gid in groups:
                groups[a], gx[a] = groups[gid], gx.get(gid) or {}
        return groups, gx

    def attach_sheet(self, groups, page, d, paths):
        """字帖（sheet.png）：交上来的每组笔迹裁出来、统一字高排成一张，认字看它；
        本机装了 PP-OCR 就逐块识别，读法放进 g["ocr"]，和 Windows 识别一起当旁证。"""
        picked = inksheet.pick(groups, page)
        rows = {gid: len(inksheet.lines(ss)) for gid, ss in picked}
        for g in groups:  # 一组写了几行：消息里写明，Claude 只想指其中一行时用 g3:1
            if rows.get(g.get("id"), 1) > 1:
                g["lines"] = rows[g["id"]]
        cells = [(gid, im) for gid, im in ((gid, inksheet.cell(ss)) for gid, ss in picked) if im is not None]
        if not cells:
            return
        p = d / "sheet.png"
        inksheet.sheet(cells).save(p)
        paths["sheet"] = str(p)
        got = ocr.recognize(picked)
        for g in groups:
            if g.get("id") in got:
                g["ocr"] = got[g["id"]]

    # -- 认字的帮手：更正表（记住你的字）和领域词表

    def add_corrections(self, c, answers):
        """确认卡片上我更正了 Claude 的读法：记进更正表（data/corrections.json），之后发送时附上相关的几条。"""
        rows = []
        for qq, a in zip(c.get("questions") or [], answers):
            guess, text = str(qq.get("guess") or "").strip(), str(a.get("text") or "").strip()
            if guess and text and guess != text:
                rows.append({"guess": guess[:80], "text": text[:80], "nb": c.get("nb"), "t": int(time.time())})
        if not rows:
            return 0
        with self.file_lock:
            f = self.data / "corrections.json"
            old = json.loads(f.read_text("utf-8")) if f.exists() else []
            new = {(r["guess"], r["text"]) for r in rows}
            old = [r for r in old if (r.get("guess"), r.get("text")) not in new] + rows
            f.write_text(json.dumps(old[-500:], ensure_ascii=False, indent=0), "utf-8")
        return len(rows)

    def corrections_for(self, groups, texts=(), n=5, least=3):
        """挑这次附上的更正：和这一页的识别结果、原文共有的字越多越靠前；相关的不够 least 条时用最近的补上。"""
        f = self.data / "corrections.json"
        try:
            rows = json.loads(f.read_text("utf-8")) if f.exists() else []
        except ValueError:
            return []
        pool = set("".join(t for t in texts if t))
        for g in groups:
            pool.update("".join(g.get("reco") or []) + str(g.get("ocr") or ""))
        scored = sorted(((len(set(r["guess"] + r["text"]) & pool), r.get("t", 0), k) for k, r in enumerate(rows)), reverse=True)
        chosen = [k for sc, _, k in scored if sc > 0][:n]
        for _, _, k in sorted(((r.get("t", 0), 0, k) for k, r in enumerate(rows)), reverse=True):
            if len(chosen) >= least:
                break
            if k not in chosen:
                chosen.append(k)
        return [{"guess": rows[k]["guess"], "text": rows[k]["text"]} for k in chosen]

    def doc_terms(self, nb):
        """本子原文（PDF 全文）里的术语，按原文件的修改时间缓存。不是书的本子没有。"""
        if not nb.startswith("book:") or fitz is None:
            return vocab.Counter()
        p = self.book_path(nb[5:])
        try:
            ver = f"{p}|{p.stat().st_mtime}"
        except OSError:
            return vocab.Counter()
        cache = self.data / "cache" / f"terms-{hashlib.sha1(ver.encode()).hexdigest()[:16]}.json"
        if cache.exists():
            return vocab.Counter(json.loads(cache.read_text("utf-8")))
        with self.pdf_lock:
            text = "\n".join(pg.get_text("text") for pg in self._doc(nb[5:]))
        c = vocab.extract(text)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(c, ensure_ascii=False), "utf-8")
        return c

    def vocab_for(self, nb, sid, page_text=""):
        """领域词表：本子原文和这次发往的对话所在项目的说明文件里的术语，这一页原文里有的在前。"""
        try:
            doc = self.doc_terms(nb)
        except Exception:  # noqa: BLE001 - 只是认字的帮手
            doc = vocab.Counter()
        cwd = (self.bridge.sessions.get(sid) or {}).get("cwd") or ""
        return vocab.pick(doc, vocab.project_terms(cwd), page_text)

    def new_sub_dir(self):
        sub_id = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        d = self.data / "submissions" / sub_id
        d.mkdir(parents=True)
        return sub_id, d

    def locate(self, sid, submission=None, page_no=None):
        """Claude 说的「那一页」：某次投递（整本检测时再加页码），否则平板当前那一页，否则最近一次投递。

        返回 {id, nb, page, groups, gx, crop, sel, level, rot, vx}；groups 为 {编号: bbox}，gx 为 {编号: {ids, red, sel}}
        （每组的笔迹 id，平板据此记住批注指着哪几笔），vx 为 {s 编号: 修改建议的 id}，crop 把图片像素换回页面坐标；
        rot 为 Claude 看到的图是这一页转到多少度时画的（None 表示就是现在的样子）。
        """
        if submission:
            meta = self.load_submission(submission)
        elif self.bridge.where:  # 没指定投递：平板当前那一页（box 用页面坐标）
            w = self.bridge.where
            meta = {"id": "direct-" + uuid.uuid4().hex[:6], "nb": w["nb"], "page": w["page"], "groups": [],
                    "crop": {"x0": 0, "y0": 0, "scale": 1}, "sel": None, "level": None, "rot": None}
        else:
            meta = self.latest_submission_for(sid)
        if not meta:
            raise ValueError("平板没有打开草稿纸，也还没收到过这个对话的投递，没法确定是哪一页。")
        if meta.get("kind") == "scan":
            entries = meta.get("pages") or {}
            if page_no is None and len(entries) == 1:
                page_no = next(iter(entries))
            ent = entries.get(str(page_no)) if page_no is not None else None
            if not ent:
                raise ValueError(f"整本检测 {meta['id']} 里没有第 {page_no} 页；有：{'、'.join(entries) or '（无）'}（用 page 指定页码）")
            gx = ent.get("gx") or {}
            # reds：这一页这次新写的红笔（要交读法的那几组）；live：这一页没全擦掉的组。旧的整本检测没记这两样：按 gx 推
            loc = {"id": meta["id"], "nb": meta["nb"], "page": ent["page"], "key": ent.get("key"), "groups": ent["groups"],
                   "crop": ent["crop"], "sel": None, "level": meta.get("level"), "rot": ent.get("rot"), "gx": gx,
                   "vx": ent.get("vx") or {},
                   "reds": ent["reds"] if "reds" in ent else [g for g, x in gx.items() if x.get("red") and x.get("sel")],
                   "live": ent["live"] if "live" in ent else list(gx), "marks": ent.get("marks") or []}
        else:
            groups, gx, reds, live, marks = meta.get("groups") or [], {}, [], [], []
            if isinstance(groups, list):
                gx = {g["id"]: {"ids": g["ids"], "red": bool(g.get("red")), "sel": bool(g.get("inSel"))}
                      for g in groups if "id" in g and g.get("ids")}
                # 整页交上来的：还要回答的红笔问题（之前几轮回答过的不算）要交读法；全擦掉的组不算
                live = [g["id"] for g in groups if "id" in g and (g.get("n") or 1) > (g.get("erased") or 0)]
                marks = [g["id"] for g in groups if g.get("id") in live and mark_like(g)]  # 只是划线的：不用交读法
                reds = [g["id"] for g in groups if g.get("id") in live and prompt.asking(g) and g["id"] not in marks]
                groups = {g["id"]: g["bbox"] for g in groups if "id" in g and "bbox" in g}
            loc = {"id": meta["id"], "nb": meta["nb"], "page": meta["page"], "key": meta.get("page_key"), "groups": groups,
                   "crop": meta.get("crop"), "sel": meta.get("sel"), "level": meta.get("level"), "rot": meta.get("rot"), "gx": gx,
                   "vx": {v["id"]: v["ref"] for v in meta.get("verdicts") or [] if isinstance(v, dict) and v.get("id") and v.get("ref")},
                   "reds": reds, "live": live, "marks": marks}
        loc["nb"] = self.current_nb(loc["nb"])  # 投递之后书可能换成了新版、跟着改了名
        # 投递之后用户可能插了页、删了页：按页的键找它现在是第几页
        if not loc["key"]:
            loc["key"] = self.page_key(loc["nb"], loc["page"])
        now = self.index_of_key(loc["nb"], loc["key"])
        if now is None:
            raise ValueError("那一页已经从本子里删掉了（可以在平板抽屉的「显示已删的页」里还原）")
        loc["page"] = now
        return loc

    # -- 整本检测：在服务器上把每页（底图 + 笔迹 + 批注）画成图

    def page_count(self, nb):
        return self.notebook_info(nb)["pages"]

    def resolve_nb(self, want, claude=False):
        """Claude 说的本子：id，或名字（书名、「草稿本」、「Claude 推送」；也可只写名字的一部分）。

        claude=True（/bridge 一侧，2026-11-16 用户定「拦住，也不列名字」）：只在本地的本子只在写全了时认出来（id、名字，
        或文件名去掉扩展名后和名字一样），由调用的地方拦下；只写了一部分的不往它们上面配，出错时列出的现有本子里也没有它们。
        平板一侧（文件提示上的「更新」「替换」）照旧都认。"""
        items = self.notebooks()
        want = str(want).strip()
        for key in ("id", "title"):
            hit = [n for n in items if n[key] == want]
            if hit:
                return hit[0]["id"]
        stem = Path(want).stem.lower()
        if claude:
            hit = [n for n in items if n.get("local") and stem and n["title"].lower() == stem]
            if hit:
                return hit[0]["id"]
            items = [n for n in items if not n.get("local")]
        hit = [n for n in items if stem and (stem in n["title"].lower() or n["title"].lower() in stem)]
        if len(hit) == 1:
            return hit[0]["id"]
        raise KeyError(f"没有叫「{want}」的本子；现有：{'、'.join(n['title'] for n in items) or '（没有）'}")

    def page_base(self, nb, i, page=None):
        """返回（底图高度，底图字节或 None）；插入的空白纸没有底图。给了页面 JSON 时，高度按页面的转角（rot）换算。"""
        turn = (lambda h: pages.turned_h(page, h)) if page else (lambda h: h)
        e = self.page_entry(nb, i)
        if "pdf" in e:
            with self.pdf_lock:
                r = self._doc(nb[5:])[e["pdf"]].rect
            return turn(round(PAGE_W * r.height / r.width, 1)), self.book_page_jpeg(nb[5:], e["pdf"])
        if "board" in e:
            return turn(self.board_index()["pages"][e["board"]]["h"]), self.board_image(e["board"])
        lay, pdf_h = self.layout_of(nb), []
        if nb.startswith("book:"):
            with self.pdf_lock:
                pdf_h = [round(PAGE_W * p.rect.height / p.rect.width, 1) for p in self._doc(nb[5:])]
        return turn(blank_height(lay, int(i), self.setting(nb, "paper", "portrait"), pdf_h)), None

    def _seen_file(self, nb):
        return self._nb_dir(nb) / "seen.json"

    def _seen_by(self, nb):
        """{对话 sid: {页的键: 那个对话看到哪一笔为止}}。以前不分对话记的放在 "_"，第一个来记的对话接着用；
        以前按页码记的（"3"）换成键（"p0003"）。"""
        f = self._seen_file(nb)
        raw = json.loads(f.read_text("utf-8")) if f.exists() else {}
        by = raw["by"] if isinstance(raw.get("by"), dict) else ({"_": raw} if raw else {})
        return {sid: {(f"p{int(k):04d}" if k.isdigit() else k): v for k, v in d.items()} for sid, d in by.items()}

    def seen(self, nb, sid=None):
        """{页的键: 这个对话看到哪一笔为止}：按对话记，换了对话「只发新写的」从它没看过的算起。"""
        by = self._seen_by(nb)
        return by.get(sid or "_", by.get("_", {}))

    def mark_seen(self, nb, stamps, sid=None):
        """记下每页这个对话已经看到哪一笔为止（平板时钟），下次只把之后的标成新写的。stamps：{页的键: 时刻}。"""
        with self.file_lock:
            by, k = self._seen_by(nb), sid or "_"
            if k not in by and "_" in by:
                by[k] = by.pop("_")  # 以前不分对话记的：归第一个来记的对话
            s = by.setdefault(k, {})
            for key, t in stamps.items():
                s[key] = max(s.get(key, 0), t)
            self._seen_file(nb).write_text(json.dumps({"by": by}), "utf-8")

    def scan(self, nb, page_nos=None, only_new=False, region=None, target=None, origin="claude"):
        """把一本里写过字的页（或指定的页）画成图，写成一条消息。返回（投递编号, 消息, 页数）。"""
        self.ensure_shareable(nb)
        if fitz is None:
            raise ValueError("没有安装 PyMuPDF，不能整本检测")
        n = self.page_count(nb)
        if page_nos:
            idxs = sorted({int(p) - 1 for p in page_nos if 1 <= int(p) <= n})
            if not idxs:
                raise ValueError(f"页码超出范围（这本共 {n} 页）")
        else:
            idxs = list(range(n))
        if region and len(idxs) != 1:
            raise ValueError("region 只能配合单独一页使用")
        seen = self.seen(nb, target)
        unplaced = self.unplaced(nb)
        lay = self.layout_of(nb)
        picked, skipped_old = [], 0
        for i in idxs:
            page = json.loads(self.load_page(nb, i))
            fresh_cards = self.unsent_card_marks(nb, lay.entry(i)["key"], page)  # 长回答卡片上有还没交的红字：也算有新东西
            if not page_nos and not pages.has_ink(page) and not fresh_cards:
                continue
            groups = self.new_groups(page, seen.get(lay.entry(i)["key"], 0))
            if (only_new and not page_nos and not any(g["inSel"] for g in groups)
                    and not self.unsent_verdicts(nb, lay.entry(i)["key"], page) and not fresh_cards):
                skipped_old += 1
                continue
            self.attach_reco(nb, i, groups, page=page)
            picked.append((i, page, groups))
        truncated = max(0, len(picked) - SCAN_MAX_PAGES)
        picked = picked[:SCAN_MAX_PAGES]
        sub_id, d = self.new_sub_dir()
        entries, infos, stamps, sent, msent, lsent = {}, [], {}, {}, {}, {}
        blank = self.blank_nb(nb)  # 空白本子：图里整页是纸、没有右边那一栏，范围包住这一页上所有的东西（pages.blank_rect）
        for i, page, groups in picked:
            base_h, bg = self.page_base(nb, i, page)
            for g in groups:
                g["on"] = pages.group_on(page, g["bbox"], base_h, bg is not None)
            key_i = lay.entry(i)["key"]
            verdicts = self.page_verdicts(page, groups, self.pending_vsent(nb, key_i))
            h = max(base_h, page.get("h") or 0)
            x0, y0 = 0, 0
            if region:
                px0, py0, tw, h = pages.paper_rect(page, base_h, blank=blank)  # 整张纸的宽；空白本子包住纸外的东西
                x0 = px0
                y0 = max(py0, min(float(region[0]), h - 50))
                clip = [x0, y0, tw, min(h, max(y0 + 50, float(region[1])))]
                scale = pages.fit_scale(tw - x0, clip[3] - clip[1], cap=1.6)
            else:
                (x0, y0), (right, bottom) = pages.content_origin(page, blank=blank), pages.content_extent(page, base_h, blank=blank)
                clip = [x0, y0, right, bottom]
                scale = pages.fit_scale(right - x0, bottom - y0)
            img = d / f"p{i + 1:03d}.png"
            labelled = [g for g in groups if g["n"] > g["erased"]] + verdicts  # s 编号也标在图里
            # 图里的像素 (px, py) = 页面坐标 ((px / scale + x0), (py / scale + y0))：下面记进 crop，Claude 回的 box 按它换回去
            pages.render_page(page, str(img), base_h, bg, labelled, scale, clip, blank=blank)
            key = lay.entry(i)["key"]
            vis = dict(pages.group_strokes(pages.ink(page)))
            gx = {g["id"]: {"ids": [s["id"] for s in vis[g["id"]]], "red": g["red"], "sel": g["inSel"]} for g in groups if g["id"] in vis}
            # 只是划线、圈、箭头的组不用交读法（mark_like；2026-11-17 用户定：几页一起交时也免，和单页交一样）。
            # 这条路上没有 PP-OCR 的读法，只凭本机手写识别判断；没认过字的组照旧要
            bare = [g["id"] for g in groups if g["n"] > g["erased"] and mark_like(g)]
            entries[str(i + 1)] = {"page": i, "key": key, "groups": {g["id"]: g["bbox"] for g in groups}, "gx": gx,
                                   "crop": {"x0": x0, "y0": y0, "scale": scale}, "rot": page.get("rot") or 0,
                                   "vx": {v["id"]: v["ref"] for v in verdicts},
                                   # 回的时候要交读法的：这一页上次之后新写的红笔（App.reads_owed）；没全擦掉的组
                                   "reds": [g["id"] for g in groups if g["red"] and g["inSel"] and g["n"] > g["erased"] and g["id"] not in bare],
                                   "live": [g["id"] for g in groups if g["n"] > g["erased"]], "marks": bare}
            info = {"no": i + 1, "image": str(img), "label": self.page_label(nb, i), "scale": scale, "h": h, "y0": y0,
                    "groups": groups, "now": pages.last_touch(page), "first": key not in seen,
                    "clip": clip if region else None, "base_h": base_h, "role": self.page_role(nb, i),
                    "verdicts": verdicts,
                    "answers": [dict({"n": a.get("n"), "q": a.get("q"), "text": a.get("text"), "more": pages.more_of(a)},
                                     **({"note": True} if pages.from_note(a) else {})) for a in pages.answers_of(page)]}
            if verdicts:
                sent[i] = [v["ref"] for v in verdicts]
            cards = self.card_images(page, d, prefix=f"p{i + 1:03d}-")  # 长回答卡片上的红字：每张卡片一张图
            if cards:
                info["cards"] = cards
                msent[i] = {c["id"]: c["marks"] for c in cards if c.get("id")}
            if "pdf" in lay.entry(i):
                info["pdf"] = str(self.book_path(nb[5:]))
                info["pdf_page"] = lay.entry(i)["pdf"] + 1
            if unplaced.get(i):
                info["unplaced"] = unplaced[i]
            # 收成小蓝点的短批注：图里只有一个点，字写进消息；浮出来时上面写了还没交的红字的，后面写明图里看不到（SCAN_DOT_UNSENT）。
            # 用户点「AI」几页一起交时，平板已经先把这种小蓝点收成卡片了，不写
            dots = [str(a["text"]).strip() + (SCAN_DOT_UNSENT if origin != "tablet" and pages.unsent_marks(a) else "")
                    for a in pages.dot_items(page)]
            if dots:
                info["dots"] = dots
            infos.append(info)
            stamps[key] = pages.last_touch(page)
            if origin == "tablet":  # 用户点「AI」几页一起交的：这一页交到了哪一笔为止（平板的 lastSent，见 mark_pages_sent）
                lsent[i] = stamps[key]
        title = self.nb_title(nb)
        owe_now = [r for no, e in entries.items() for r in self.owed_rows(
            next(p["verdicts"] for p in infos if p["no"] == int(no)), e["key"], int(no))]
        # 之前采纳了、还没回报的修改：用户点「AI」几页一起交时列出来（Claude 自己整本检测取来的不列）（B 组⑤）
        owed = self.owed_for(target, skip={r["ref"] for r in owe_now}) if origin == "tablet" and infos else []
        text = prompt.build_scan_message(title, infos, sub_id, origin=origin, only_new=only_new,
                                         skipped_old=skipped_old, truncated=truncated, owed=owed)
        meta = {"id": sub_id, "kind": "scan", "nb": nb, "target": target,
                "created": datetime.now().isoformat(timespec="seconds"), "pages": entries}
        (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
        (d / "message.txt").write_text(text, "utf-8")
        self.record_owed(sub_id, target, nb, owe_now)
        self.mark_seen(nb, stamps, target)
        if sent:  # 这几条决定 Claude 收到了：记下，平板画淡、不再发
            self.mark_verdicts_sent(nb, sent)
        if msent:  # 卡片上的这几笔红字交过了：平板记下这一轮，圈号上的红点没了
            self.mark_cards_sent(nb, msent, sub_id)
        if lsent:  # 这几页交过了：平板记下交到了哪一笔为止
            self.mark_pages_sent(nb, lsent, sub_id)
        return sub_id, text, len(infos)

    def new_groups(self, page, t_seen):
        """这一页的笔迹分组；inSel 表示 Claude 上次看过之后新写或擦改的。"""
        groups = pages.compute_groups(pages.ink(page))
        for g in groups:
            g["inSel"] = g["t1"] > t_seen or (g.get("erasedAt") or 0) > t_seen
        return groups

    def new_pages(self, nb, sid=None):
        """这本里有新笔迹（这个对话上次看过之后新写或擦改）的页：平板点「AI」时，除了当前页还有别的页就几页一起交。"""
        if self.is_local(nb):
            return []
        seen, lay, out = self.seen(nb, sid), self.layout_of(nb), []
        for i, e in enumerate(lay.pages):
            f = self._key_file(nb, e["key"])
            if not f.exists():
                continue
            page = json.loads(f.read_text("utf-8"))
            if pages.has_ink(page) and (any(g["inSel"] for g in self.new_groups(page, seen.get(e["key"], 0)))
                                        or self.unsent_verdicts(nb, e["key"], page)):
                out.append(i)
            elif self.unsent_card_marks(nb, e["key"], page):  # 纸上没写新字，只在长回答的卡片上写了红字：也算有新东西
                out.append(i)
        return out

    def unsent_card_marks(self, nb, key, page):
        """这一页长回答的卡片上有没有还没交给 Claude 的红字（排在待处理队列里、平板还没合进页面的「交过了」不算）。"""
        skip = self.pending_msent(nb, key)
        return any(m.get("id") not in skip for a in page.get("ai") or [] if isinstance(a, dict) for m in pages.unsent_marks(a))

    def mark_cards_sent(self, nb, sent, req):
        """几页一起交带上的卡片红字记成交过了（req 是这一轮的投递编号）：和 ✓/× 决定一样排进那几页的待处理队列
        （平板合进页面），并告诉平板它手里的这几页也跟着改。不直接改页面文件。sent：{页号: {长回答 id: [红字 id]}}。"""
        lay = self.layout_of(nb)
        for i, cards in sent.items():
            self.add_pending(nb, lay.entry(i)["key"], {"msent": cards, "req": req, "t": int(time.time() * 1000)})
        self.bridge.emit("msent", nb=nb, req=req, pages={str(i): c for i, c in sent.items()})

    def mark_pages_sent(self, nb, sent, req):
        """用户点「AI」几页一起交上去的那几页：记下各页交到了哪一笔为止（那一页当时最后落笔、擦除的时刻，平板的时钟）。
        单页交时平板自己记（页面的 lastSent）；几页一起交时别的页不在平板手上，和卡片红字一样排进那几页的待处理队列
        （平板打开时合进 lastSent）、并告诉平板它手里的那几页。平板只在「短批注上的红字什么时候收成卡片」时看 lastSent：
        上次交稿之前写的不再收（免得几页一起交时当普通红笔交过的、下次单页交时又被收成卡片再交一次）。
        不直接改页面文件。sent：{页号: 时刻}。"""
        lay = self.layout_of(nb)
        now = int(time.time() * 1000)
        for i, t in sent.items():
            self.add_pending(nb, lay.entry(i)["key"], {"lsent": t, "req": req, "t": now})
        self.bridge.emit("lsent", nb=nb, req=req, pages={str(i): t for i, t in sent.items()})

    def pending_msent(self, nb, key):
        """还在队列里、平板还没合进页面的「卡片红字交过了」标记（红字的 id）。"""
        f = self._key_file(nb, key, ".pending.json")
        if not f.exists():
            return set()
        try:
            return {x for e in json.loads(f.read_text("utf-8")) if isinstance(e, dict) and isinstance(e.get("msent"), dict)
                    for ids in e["msent"].values() if isinstance(ids, list) for x in ids}
        except ValueError:
            return set()

    def unsent_verdicts(self, nb, key, page):
        """这一页上有没有点了 ✓/×、还没发给 Claude 的决定：有的话没写新字也算「有新东西的页」。
        决定跟着下一次点「AI」走，不能因为那一页没写新字就落下。"""
        skip = self.pending_vsent(nb, key)
        return any(a.get("type") in VOTE_TYPES and a.get("verdict") in ("yes", "no") and a.get("box")
                   and not a.get("sent") and not a.get("dismissed") and a.get("id") not in skip
                   for a in page.get("ai") or [])

    def page_verdicts(self, page, groups, skip=frozenset()):
        """整本发送时这一页要带上的：点了 ✓/×、还没发过的修改建议（s 编号），带 id 和 bbox（标在图里）。"""
        gid = {s["id"]: g for g, ss in pages.group_strokes(pages.ink(page)) for s in ss}
        live = [s for s in pages.ink(page) if s.get("pts") and not s.get("erasedAt")]
        verdicts = []
        for a in page.get("ai") or []:
            skipped = a.get("sent") or a.get("id") in skip  # skip：已发、平板还没合进页面的
            if a.get("type") not in VOTE_TYPES or skipped or a.get("dismissed") or a.get("verdict") not in ("yes", "no") or not a.get("box"):
                continue
            b, on = a["box"], set(a.get("on") or [])
            z = [b[0] - 40, b[1] - 40, b[2] + 40, b[3] + 40]
            near = sorted({gid[s["id"]] for s in live if s["id"] in gid and s["id"] not in on and s.get("t0", 0) > (a.get("t") or 0)
                           and pages.box_dist(pages.stroke_box(s), z) == 0}, key=lambda x: int(x[1:]))
            verdicts.append({"id": f"s{len(verdicts) + 1}", "ref": a["id"], "kind": a["type"], "text": a.get("text") or "", "verdict": a["verdict"],
                             "on": "doc" if a.get("onDoc") else "mine", "near": "、".join(near), "bbox": b})
        return verdicts

    def mark_verdicts_sent(self, nb, sent):
        """整本发送带上的 ✓/× 决定记成发过了：排进那几页的待处理队列（平板合进页面、记 sent: true），并告诉平板它手里的这几页也跟着改。
        不直接改页面文件：平板可能正开着那一页，直接改会和它的保存互相覆盖。"""
        lay = self.layout_of(nb)
        for i, ids in sent.items():
            self.add_pending(nb, lay.entry(i)["key"], {"vsent": ids, "t": int(time.time() * 1000)})
        self.bridge.emit("vsent", nb=nb, pages={str(i): ids for i, ids in sent.items()})

    def pending_vsent(self, nb, key):
        """还在队列里、平板还没合进页面的「已发」标记（建议的 id）。"""
        f = self._key_file(nb, key, ".pending.json")
        if not f.exists():
            return set()
        try:
            return {x for e in json.loads(f.read_text("utf-8")) for x in e.get("vsent") or []}
        except ValueError:
            return set()

    # -- 服务把关的两条（2026-11-16 规则瘦身 B 组④⑤）：读法漏了哪几组、采纳的修改还没回报的

    READS_KEEP = 300  # reads_seen 最多记这么多次投递（按页），旧的丢掉

    def reads_owed(self, loc, items):
        """这次投递（整本的按页）还缺哪几组的读法：红笔那几组（loc["reds"]）和到这次为止回应到的那几组（anchor、from、to、anchors
        指着的、这一页上没全擦掉的组），减去到这次为止交过 read 的。几次 ink_reply 合起来算（Claude 可以先写批注、后交读法）。
        返回组号（按编号排）；没指明投递的（写到平板当前页）不查。"""
        live = set(loc.get("live") or ())
        if not live or str(loc.get("id") or "").startswith("direct-"):
            return []

        def base(v):
            g = str(v).strip().lower().split(":")[0]
            return "g" + g if g.isdigit() else g
        with self.reads_lock:
            rec = self.reads_seen.pop((loc["id"], loc.get("key")), None) or {"read": set(), "hit": set()}
            self.reads_seen[(loc["id"], loc.get("key"))] = rec  # 放回最后：最近用到的留着
            while len(self.reads_seen) > self.READS_KEEP:
                del self.reads_seen[next(iter(self.reads_seen))]
            for it in items:
                if it["type"] == "read":
                    if it.get("anchor"):
                        rec["read"].add(base(it["anchor"]))
                elif it["type"] != "result":
                    refs = [it.get(k) for k in ("anchor", "from", "to")] + list(it.get("anchors") or [])
                    rec["hit"].update(b for b in (base(v) for v in refs if v) if b in live)
            want = [g for g in loc.get("reds") or [] if g in live] + sorted(rec["hit"] - set(loc.get("reds") or ()))
            num = lambda g: int(g[1:]) if g[1:].isdigit() else 0  # noqa: E731
            marks = set(loc.get("marks") or ())  # 只是划线的组：红笔也好、回应时指到它也好，都不点名要读法
            return sorted({g for g in want if g not in rec["read"] and g not in marks}, key=num)

    OWED_TELLS = 3  # 采纳了、还没回报的修改，在之后的消息里最多提醒这么多次（每次交稿都提会一直挂在消息里；平板上那条也一直标着没改）

    def _owed_file(self):
        return self.data / "owed.json"

    def _owed_load(self):
        f = self._owed_file()
        try:
            rows = json.loads(f.read_text("utf-8")) if f.exists() else []
        except ValueError:
            rows = []
        return [r for r in rows if isinstance(r, dict) and r.get("ref") and r.get("sub")]

    def record_owed(self, sub_id, sid, nb, rows):
        """这次消息里我采纳了的修改（在文档上的 suggest，Claude 要去改原文件、改完用 result 回报的）：记下，之后没回报就提醒。
        rows：[{s, ref, key, page}]，s 是这次消息里的 s 编号，key 是那一页的键，page 是整本消息里的页码（单页投递是 None）。"""
        if not rows:
            return
        with self.file_lock:
            old = [r for r in self._owed_load() if r["ref"] not in {x["ref"] for x in rows}]
            new = [{"sub": sub_id, "sid": sid or "", "nb": nb, "key": r["key"], "page": r.get("page"), "s": r["s"], "ref": r["ref"],
                    "told": 0, "t": int(time.time())} for r in rows]
            self._owed_file().write_text(json.dumps((old + new)[-200:], ensure_ascii=False), "utf-8")

    def settle_owed(self, refs):
        """Claude 用 result 回报了（改成了或没改成都算）：这几条不再提醒。"""
        refs = set(refs)
        if not refs:
            return
        with self.file_lock:
            rows = self._owed_load()
            keep = [r for r in rows if r["ref"] not in refs]
            if len(keep) != len(rows):
                self._owed_file().write_text(json.dumps(keep, ensure_ascii=False), "utf-8")

    def _owed_still(self, r):
        """这条还该提醒吗：那一页、那条建议还在，还是「采纳」、没擦掉、没清除，平板上也还没记着结果。"""
        try:
            nb = self.current_nb(r["nb"])
            f = self._key_file(nb, r["key"])
            page = json.loads(f.read_text("utf-8")) if f.exists() else None
        except (OSError, ValueError, KeyError):
            return False
        a = next((a for a in (page or {}).get("ai") or [] if isinstance(a, dict) and a.get("id") == r["ref"]), None)
        return bool(a) and a.get("verdict") == "yes" and not a.get("result") and not a.get("dismissed") and not a.get("erasedAt")

    def owed_for(self, sid, skip=()):
        """要写进这次消息的「还没回报的修改」：发给这个对话的、还该提醒的（skip：这次消息里刚带上的，不算），按那次投递分组：
        [{sub, page, ids}]。每列出一次记一次，满 OWED_TELLS 次就不再提；那条建议没了、改了决定的也不再提。"""
        skip = set(skip)
        with self.file_lock:
            rows = self._owed_load()
            keep, out = [], {}
            for r in rows:
                if r["ref"] in skip:
                    keep.append(r)
                    continue
                if not self._owed_still(r):
                    continue
                if r.get("sid", "") == (sid or ""):
                    out.setdefault((r["sub"], r.get("page")), []).append(r["s"])
                    r["told"] = int(r.get("told") or 0) + 1
                if r["told"] < self.OWED_TELLS:
                    keep.append(r)
            if keep != rows or out:
                self._owed_file().write_text(json.dumps(keep, ensure_ascii=False), "utf-8")
        num = lambda s: int(s[1:]) if str(s)[1:].isdigit() else 0  # noqa: E731
        return [{"sub": sub, "page": page, "ids": sorted(ids, key=num)} for (sub, page), ids in out.items()]

    @staticmethod
    def owed_rows(verdicts, key, page=None):
        """一次消息里带的决定里，要 Claude 改原文件、改完回报的：采纳了的、在文档上的修改建议（概念图上的、在我写的字上的不算）。"""
        return [{"s": v["id"], "ref": v["ref"], "key": key, "page": page} for v in verdicts or []
                if isinstance(v, dict) and v.get("id") and v.get("ref") and v.get("verdict") == "yes"
                and v.get("kind", "suggest") == "suggest" and v.get("on") == "doc"]

    # -- 确认卡片：Claude 拿不准的字迹截一小块图，问用户

    def confirm_snippet(self, cid, k, nb, i, bbox):
        page = json.loads(self.load_page(nb, i))
        base_h, bg = self.page_base(nb, i, page)
        h = max(base_h, page.get("h") or 0)
        cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
        hw, hh = max(160, (bbox[2] - bbox[0]) / 2 + 60), max(60, (bbox[3] - bbox[1]) / 2 + 40)
        blank = self.blank_nb(nb)  # 空白本子：整页是纸，没有右边那一栏
        px0, py0, px1, py1 = pages.paper_rect(page, base_h, blank=blank)
        clip = [max(px0, cx - hw), max(py0, cy - hh), min(px1, cx + hw), min(max(h, py1) if blank else h, cy + hh)]
        scale = min(2.0, 900 / max(1, clip[2] - clip[0]), 500 / max(1, clip[3] - clip[1]))
        out = self.data / "confirms" / f"{cid}-{k}.png"
        pages.render_page(page, str(out), base_h, bg, (), scale, clip, mark=bbox, blank=blank)
        return out

    # -- 问话卡片（2026-11-14，阶段 C）：能写在纸上的都写在纸上；只有要用户回答才能继续的问题、纸上放不下的结果，
    #    才发一张卡片到平板顶上。用户点选或用笔在卡片里的一小块纸上手写回答（笔迹当图片交回，不转文字）。
    #    Claude 用 ink_ask 发（bridge_ask），服务自己的代码（比如改文件前问覆盖还是另存）直接调 post_card / wait_card。

    def post_card(self, sid, kind="question", question="", options=(), write=True, text="", label=None,
                  on_answer=None, origin="claude", extra=None):
        """发一张问话卡片到平板，返回这张卡片（dict，id 是它的编号）；平板不在线返回 None——不排队到以后，调用的一方改在对话里问。

        kind：question 问题（点选 options 里的一个，或 write 为真时用笔手写）；result 纸上放不下的结果（text，只有「知道了」）。
        sid：发卡片的对话（问题没在等着的时候答了，答案作为一条新消息送进这个对话；服务自己发、不想送进对话的给空）。
        on_answer(card, answer)：用户答了（结果卡片是点了「知道了」）时，在服务处理那次请求的线程里调用；
        answer 是 {"choice": 选项原文}、{"image": 手写回答的 PNG 路径}、{"seen": True} 或 {"ignored": True}（用户点了「忽略」，
        不算回答；回调照样调一次，靠这个区分）。回调只在内存里：服务重启后没有了，
        那时卡片还在，问题卡片的回答作为一条新消息送进 sid 那个对话。
        origin：claude（Claude 用 ink_ask 发的，平板上照原文显示）或 server（服务自己问的，英文界面跟着翻译）。
        extra：另外记在卡片上的（比如改文件那张卡片的 {"edit": {path, name}}），和卡片一起存进文件、服务重启后还在；
        晚到的回答写成新消息时 prompt.build_ask_answer 据此写得具体。"""
        b = self.bridge
        if kind not in ("question", "result"):
            raise ValueError("kind 只能是 question 或 result")
        question, text = str(question or "").strip()[:300], str(text or "").strip()[:6000]
        opts = []
        for o in options or ():
            o = " ".join(str(o).split())[:40]
            if o and o not in opts:
                opts.append(o)
        if kind == "question":
            if not question:
                raise ValueError("问题卡片要有 question（问用户的一句话）")
            if len(opts) > 4:
                raise ValueError("options 最多 4 个")
            if not opts and not write:
                raise ValueError("没有选项、又不让手写：用户没法回答")
        elif not text:
            raise ValueError("结果卡片要有 result（纸上放不下的那段结果）")
        if not b.tablet_online():
            return None
        if label is None:
            label = (b.sessions.get(sid) or {}).get("label", "")
        cid = uuid.uuid4().hex[:10]
        card = {"id": cid, "kind": kind, "sid": sid or "", "label": label or "", "origin": origin, "t": time.time(),
                "question": question if kind == "question" else "", "options": opts if kind == "question" else [],
                "write": bool(write) if kind == "question" else False, "text": text if kind == "result" else "",
                "answer": None, "late": False, "done": threading.Event(), "on_answer": on_answer}
        for k, v in (extra or {}).items():
            if k not in card:  # 不盖掉卡片自己的字段
                card[k] = v
        with b.cond:
            now = time.time()
            for old in [k for k, v in b.asks.items() if v["answer"] is not None and now - v.get("at", now) > ASK_KEEP_S]:
                b.asks.pop(old, None)
            b.asks[cid] = card
        b.emit("ask", id=cid)
        b.persist()
        return card

    def wait_card(self, cid, timeout, last=False):
        """等这张问话卡片的回答，最多 timeout 秒：答了返回 answer（见 post_card），没答返回 None。
        last：这次再等不到就不等了，之后的回答作为一条新消息送进发卡片的对话。"""
        b = self.bridge
        c = b.asks.get(cid)
        if not c:
            raise KeyError("没有这张问话卡片")
        c["done"].wait(timeout=max(0.0, float(timeout)))
        with b.cond:  # 和 answer_card 里记回答用同一把锁：不会落在「等的人刚走、还没记下不等了」的空当里
            if c["answer"] is not None:
                return c["answer"]
            if last and not c["late"]:
                c["late"] = True
                late = True
            else:
                late = False
        if late:
            b.persist()
        return None

    def answer_card(self, cid, choice=None, image_b64=None, ignore=False):
        """平板上答了这张问话卡片：choice 是点的选项原文；image_b64 是手写那块纸的 PNG（base64）；结果卡片两样都不用给（点了「知道了」）。
        ignore：用户点了「忽略」或「全部忽略」（2026-11-14 用户在 iPad 上试过后定）：问题卡片记成 {"ignored": True}——不算回答，
        还在等的工具据此告诉 Claude 用户忽略了；已经不等了的不往对话里送消息，只把卡片清掉。结果卡片按点了「知道了」算。
        记下回答、叫醒等着的一方；问题卡片已经没人等（late）就作为一条新消息送进发它的对话；有回调就调用（忽略了也调一次）。返回 answer。"""
        b = self.bridge
        c = b.asks.get(cid)
        if not c or c["answer"] is not None:
            raise KeyError("这张卡片已经回答过或过期了")
        sub = None
        if c["kind"] == "result":
            answer = {"seen": True}
        elif ignore:
            answer = {"ignored": True}
        elif choice is not None:
            if str(choice) not in c["options"]:
                raise ValueError("卡片上没有这个选项")
            answer = {"choice": str(choice)}
        elif image_b64:
            if not c["write"]:
                raise ValueError("这张卡片不收手写回答")
            raw = base64.b64decode(image_b64)
            if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("手写回答的图不是 PNG")
            if len(raw) > ASK_IMG_MAX:
                raise ValueError("手写回答的图太大")
            # 放在投递的文件夹下面：插件读这里的图不用每次问（见 inkpad 的 tool.check）
            sub, d = self.new_sub_dir()
            (d / "answer.png").write_bytes(raw)
            answer = {"image": str(d / "answer.png")}
        else:
            raise ValueError("回答是空的：点一个选项，或用笔写了再交")
        with b.cond:
            if c["answer"] is not None:
                raise KeyError("这张卡片已经回答过或过期了")
            c["answer"], c["at"] = answer, time.time()
            late = c["late"]
        c["done"].set()
        b.emit("asked", id=cid)
        b.persist()
        if late and c["kind"] == "question" and c["sid"] and not answer.get("ignored"):  # 那边已经不等了：作为一条新消息送进对话（忽略了的不送）
            if not sub:
                sub, d = self.new_sub_dir()
            else:
                d = self.data / "submissions" / sub
            (d / "message.txt").write_text(prompt.build_ask_answer(c, answer, late=True), "utf-8")
            b.enqueue(c["sid"], sub)
        cb = c.get("on_answer")
        if cb:
            try:
                cb(c, answer)
            except Exception:  # noqa: BLE001 - 回调出错不影响记下的回答
                traceback.print_exc()
        return answer

    # -- 改电脑上的文件（2026-11-14，阶段 C；《产品定义》第 4 节）。Claude 每次动手前调 ink_edit（bridge_edit）：没带 mode 就在平板顶上
    #    问覆盖还是另存；覆盖前把原文件留底，另存时在原文件旁边新建一份。改完 Claude 用 ink_import 让平板上那本原地换新版，
    #    用 result 回报每条建议。平板上能撤回（undo_book），「存回 PDF」同样留底、能撤回。
    #    留底文件夹由 keep.py 管（<数据文件夹>/keep）；每一次修改另记在 data/edits.json：
    #      {eid, rec（留底记录的编号）, chain（这条记录记在哪个文件名下：覆盖、存回是原文件，另存是新文件）, mode（overwrite / saveas /
    #       savepdf）, path（原文件）, saved_as（另存出来的新文件）, sid（哪个对话改的，撤回后告诉它）, t（毫秒）,
    #       post（改完导入平板时文件内容的 SHA-256，撤回时据此看那之后又改过没有）, book, undone（撤回过了）}
    #    Claude 用 result 回报的那几条记着 eid：撤回那一次，纸上「已改」写成「已撤回」。
    #    只动：Claude 要改的那个文件（撤回时写回）、另存时新建的那个文件、草稿纸自己的数据文件夹。草稿纸从不删用户电脑上的文件。

    def _edits_file(self):
        return self.data / "edits.json"

    def edits(self):
        f = self._edits_file()
        try:
            v = json.loads(f.read_text("utf-8")) if f.exists() else []
        except (OSError, ValueError):
            return []
        return [e for e in v if isinstance(e, dict) and e.get("eid")] if isinstance(v, list) else []

    def _save_edits(self, items):
        f = self._edits_file()
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(items[-EDITS_KEEP:], ensure_ascii=False, indent=1), "utf-8")
        os.replace(tmp, f)

    def record_edit(self, rec, chain, mode, path, saved_as=None, sid=""):
        """记下一次修改（留底记录 rec 记在 chain 名下）。同一条留底记录已经记过（Claude 没改文件就又调了一次 ink_edit，
        留底没多留一份）：返回原来那条，还没导入过的话时刻和对话换成这一次的。"""
        ck = path_key(chain)
        with self.file_lock:
            items = self.edits()
            for e in items:
                if e.get("rec") == rec["id"] and path_key(e.get("chain")) == ck:
                    if not e.get("post") and not e.get("undone") and mode == e.get("mode"):
                        e.update(t=int(time.time() * 1000), sid=sid or e.get("sid") or "")
                        self._save_edits(items)
                    return e
            e = {"eid": uuid.uuid4().hex[:10], "rec": rec["id"], "chain": str(chain), "mode": mode, "path": str(path),
                 "saved_as": str(saved_as) if saved_as else None, "sid": sid or "", "t": int(time.time() * 1000),
                 "post": None, "book": None, "undone": False}
            items.append(e)
            self._save_edits(items)
            return e

    def change_edit(self, eid, **fields):
        with self.file_lock:
            items = self.edits()
            hit = next((e for e in items if e["eid"] == eid), None)
            if hit:
                hit.update(fields)
                self._save_edits(items)
            return hit

    def edit_for(self, chain, rec_id):
        """留底记录 rec_id（记在 chain 名下）是哪一次修改，没记过返回 None。"""
        ck = path_key(chain)
        return next((e for e in reversed(self.edits()) if e.get("rec") == rec_id and path_key(e.get("chain")) == ck), None)

    def undone_ids(self):
        return [e["eid"] for e in self.edits() if e.get("undone")]

    def edit_target(self, path):
        """Claude 要改的文件：完整路径、得是个文件、不能是草稿纸自己的数据（导入后转成的 PDF、留底……）。返回解开后的绝对路径。"""
        raw = str(path or "").strip()
        if not raw:
            raise ValueError("缺少 path（要改的那个文件的完整路径）")
        p = Path(raw)
        if not p.is_absolute():
            raise ValueError(f"path 要写完整路径：{raw}")
        if not p.exists():
            raise ValueError(f"找不到要改的文件：{p}")
        if not p.is_file():
            raise ValueError(f"{p} 不是文件")
        real = p.resolve()
        for d in (self.data.resolve(), self.books.resolve()):
            if real == d or d in real.parents:
                raise ValueError(f"{real} 是草稿纸自己的数据，不能改；要改的是导入它的那个原文件")
        return real

    @staticmethod
    def _fresh_copy(src):
        """另存：在原文件旁边按起名规则（keep.next_name）新建一份，逐字节复制。只用独占方式新建：名字刚好被别的程序占了
        就再往后顺延，绝不覆盖已有的文件。复制到一半出错时，只删这一次自己新建、没写完的那一份。"""
        for _ in range(50):
            new = Path(next_name(src))
            try:
                fo = open(new, "xb")
            except FileExistsError:
                continue
            except OSError as e:
                raise ValueError(f"另存的新文件建不起来（{new}）：{e}。原文件没动。") from None
            try:
                with fo, open(src, "rb") as fi:
                    shutil.copyfileobj(fi, fo, 1 << 20)
            except OSError as e:
                try:
                    new.unlink()
                except OSError:
                    pass
                raise ValueError(f"另存没做成（{e}）：原文件没动。") from None
            return new
        raise ValueError(f"给 {Path(src).name} 另存时找不到空着的新名字")

    def begin_edit(self, sid, path, mode):
        """ink_edit 带着 mode 来（或用户在卡片上选好了）：覆盖前留底，或另存一份新文件；文件内容由 Claude 自己改。
        返回 {done, mode, target（该改的文件）, original, book（平板上对应的本子名，没导入过是 None）, eid, text（给 Claude 的话）}。
        留底没做成抛 ValueError（说清楚别动原文件）。这个文件没导入过草稿纸：不拦，照样留底。"""
        if mode not in ("overwrite", "saveas"):
            raise ValueError("mode 只能是 overwrite（覆盖原文件）或 saveas（另存一份）")
        real = self.edit_target(path)
        name = self.book_of_source(real, shared_first=True)
        # 对应的那本只在本地：改电脑上的文件照常（不往本子里放东西），但不说那本叫什么，告诉 Claude 改完别导入（导入会被拦下）
        local = bool(name) and self.is_local("book:" + name)
        title = Path(name).stem if name and not local else None
        with self.edit_lock:
            if mode == "overwrite":
                try:
                    rec = self.keeper.keep(real, NOTE_OVERWRITE)
                except KeepError as e:
                    raise ValueError(f"覆盖前没能把原文件留底（{e}）：原文件不要动，先告诉用户。") from None
                target, saved_as = real, None
            else:
                target = saved_as = self._fresh_copy(real)
                try:
                    rec = self.keeper.keep(real, NOTE_SAVEAS, saved_as=target)
                except KeepError as e:
                    raise ValueError(f"另存的新文件 {target} 已经建好（和原文件一模一样），但留底记录没写成（{e}），"
                                     "平板上撤不回这次另存：这次先别改任何文件，告诉用户。") from None
            e = self.record_edit(rec, target, mode, real, saved_as, sid)
        self.withdraw_edit_cards(real)
        print(f"[改文件] {'覆盖' if mode == 'overwrite' else '另存'}：{real.name}" + (f" → {target.name}" if saved_as else ""))
        return {"done": True, "mode": mode, "target": str(target), "original": str(real), "book": title, "eid": e["eid"],
                "text": prompt.edit_go(mode, str(real), str(target), title, local=local)}

    def ask_edit(self, sid, path):
        """ink_edit 没带 mode：在平板顶上弹问话卡片「覆盖还是另存」（只能点选，不能手写）。返回 {ask: 卡片编号, name}；
        平板不在线返回 {offline, text}：Claude 改在对话里问。"""
        real = self.edit_target(path)
        card = None
        if self.bridge.tablet_online():
            card = self.post_card(sid, question=f"改《{real.name}》：覆盖原文件，还是另存一份？", options=list(EDIT_CHOICES),
                                  write=False, origin="server", extra={"edit": {"path": str(real), "name": real.name}})
        if card is None:
            return {"offline": True, "text": prompt.edit_offline(real.name)}
        print(f"[改文件] 问覆盖还是另存：{real.name}")
        return {"ask": card["id"], "name": real.name}

    def edit_wait(self, cid, wait, last=False):
        """等「覆盖还是另存」卡片的回答（最多 wait 秒）：答了就照选的办（begin_edit），返回它的结果（另带 chose）；
        没答返回 {pending, text}；last：这次再等不到就不等了，之后的回答作为一条新消息送进对话（让 Claude 带上 mode 再调一次）。
        同一张卡片只办一次：插件重试时返回第一次办的结果。"""
        c = self.bridge.asks.get(cid)
        if not c or not c.get("edit"):
            raise KeyError("没有这张问覆盖还是另存的卡片")
        if c.get("edit_result"):
            return c["edit_result"]
        ans = self.wait_card(cid, wait, last=last)
        if ans is None:
            return {"pending": True, "tabletOnline": self.bridge.tablet_online(), "text": prompt.EDIT_PENDING}
        if ans.get("withdrawn"):
            return {"withdrawn": True, "text": prompt.EDIT_WITHDRAWN}
        if ans.get("ignored"):  # 用户点了「忽略」：这次不改这个文件（不留底、不建新文件）
            return {"ignored": True, "text": prompt.EDIT_IGNORED}
        with self.edit_lock:
            if c.get("edit_result"):
                return c["edit_result"]
            res = self.begin_edit(c["sid"], c["edit"]["path"], EDIT_CHOICES.get(ans.get("choice")))
            res["chose"] = ans.get("choice")
            c["edit_result"] = res
        return res

    def withdraw_edit_cards(self, real):
        """这个文件已经按 mode 办了：平板上还没答的「覆盖还是另存」卡片撤下（免得晚到的回答又让 Claude 办第二次）。"""
        b, want = self.bridge, path_key(real)
        with b.cond:
            hits = [c for c in b.asks.values() if c["answer"] is None and path_key((c.get("edit") or {}).get("path")) == want]
            for c in hits:
                c["answer"], c["at"] = {"withdrawn": True}, time.time()
        for c in hits:
            c["done"].set()
            b.emit("asked", id=c["id"])
        if hits:
            b.persist()

    def saveas_book(self, path, shared_first=False):
        """另存出来、还没导入过的新文件：原文件导入成的那本（Claude 改完导入新文件时，那本跟着换成它）。没有返回 None。
        shared_first 见 book_of_source。"""
        try:
            hist = self.keeper.history(path)
        except (KeepError, OSError):
            return None
        rec = next((r for r in hist if r["kind"] == "saveas"), None)
        name = self.book_of_source(rec["path"], shared_first) if rec else None
        return "book:" + name if name else None

    def pending_edit(self, path):
        """这个文件上还没导入平板的那一次修改（ink_edit 记下的）：Claude 改完导入时，换新版记着它。没有返回 None。"""
        want = path_key(path)
        hit = [e for e in self.edits() if e.get("mode") in ("overwrite", "saveas") and not e.get("post")
               and not e.get("undone") and path_key(e.get("chain")) == want]
        return hit[-1]["eid"] if hit else None

    def import_remind(self, nb, path):
        """Claude 原地更新一本时：原文件自上次导入之后变了，留底里却没有那之后的记录（多半是没先调 ink_edit 就改了）→
        返回提醒的一句话（不拦）；不是这种情况返回 None。"""
        name = nb[5:] if str(nb).startswith("book:") else ""
        info = self.sources().get(name)
        if not info or path_key(info.get("src")) != path_key(path) or not self.source_changed(name):
            return None
        since = info.get("t") or datetime.fromtimestamp(info.get("mtime") or 0).isoformat(timespec="seconds")
        try:
            if any((r.get("t") or "") >= since for r in self.keeper.history(path)):
                return None
        except (KeepError, OSError):
            pass
        return prompt.IMPORT_REMIND

    def edit_of_round(self, nb, sub_id):
        """这一轮（投递 sub_id 之后）对这本的原文件做的那一次修改：Claude 用 result 回报的几条记着它，撤回时好对上。没有返回 None。"""
        if not str(nb).startswith("book:"):
            return None
        info = self.sources().get(nb[5:])
        if not info:
            return None
        want = path_key(info["src"])
        try:
            t0 = datetime.strptime(str(sub_id)[:15], "%Y%m%d-%H%M%S").timestamp() * 1000
        except ValueError:
            t0 = 0
        hit = [e for e in self.edits() if e.get("mode") in ("overwrite", "saveas") and not e.get("undone") and e.get("t", 0) >= t0
               and want in (path_key(e.get("chain")), path_key(e.get("path")))]
        return hit[-1]["eid"] if hit else None

    def _book_src(self, nb):
        if not str(nb).startswith("book:"):
            raise ValueError("只有从电脑上的文件导入的本子能撤回修改")
        name = nb[5:]
        self.book_path(name)
        info = self.sources().get(name)
        if not info or not info.get("src"):
            raise ValueError("这本不是从电脑上的文件导入的，没有可撤回的修改")
        return name, info["src"]

    def undo_brief(self, src):
        """这个原文件能撤回的上一次修改（平板上出不出「撤回」用）：{id, kind, mode, left, t, file, back, edit}；没有返回 None。"""
        try:
            hist = self.keeper.history(src)
        except (KeepError, OSError):
            return None
        if not hist:
            return None
        rec = hist[0]
        e = self.edit_for(src, rec["id"])
        mode = e["mode"] if e else ("saveas" if rec["kind"] == "saveas" else "savepdf" if rec["note"] == NOTE_SAVEPDF else "overwrite")
        return {"id": rec["id"], "kind": rec["kind"], "mode": mode, "left": len(hist), "t": rec["t"], "file": Path(src).name,
                "back": Path(rec["path"]).name if rec["kind"] == "saveas" else None, "edit": e["eid"] if e else None}

    def changed_since_edit(self, name, src, eid):
        """那次修改之后这个文件又改过没有（比如用户自己在电脑上打开改了）：比对改完导入时记下的内容；没记下的按「导入之后改过没有」算。"""
        e = next((x for x in self.edits() if x["eid"] == eid), None) if eid else None
        if e and e.get("post"):
            try:
                return file_sha(src) != e["post"]
            except OSError:
                return False
        return self.source_changed(name)

    def undo_info(self, nb):
        """平板上点「撤回」时先问：{can, id, kind, mode, file, back, left, t, changed}。changed：文件在那次修改之后又改过
        （撤回会连后来的改动一起回退，确认时要说明，撤回前另留一份）；另存那种撤回不写文件，不算。"""
        name, src = self._book_src(nb)
        u = self.undo_brief(src)
        if not u:
            return {"can": False, "file": Path(src).name}
        u["can"] = True
        u["changed"] = u["kind"] == "copy" and self.changed_since_edit(name, src, u["edit"])
        return u

    def undo_book(self, nb, rid=None, expect_changed=None):
        """平板上确认了撤回：撤回这本原文件的上一次修改（keeper.undo）。rid、expect_changed 是确认时看到的那一次、那一句：
        对不上（别处刚撤回过、文件刚又改过）抛 Conflict，不撤回，让平板重新问。
        restored：文件写回了上一版 → 这本重新转换、原地换回去（存回 PDF 那种不用转换）；switched：撤回的是另存 →
        这本换回原文件，另存出来的新文件留在电脑上；别的（nothing、skipped、failed）文件没动，message 说明。
        返回 {ok, action, message, warning, id（这本现在的 id）, mode, file, back, left, aside, summary?}。"""
        with self.edit_lock:
            name, src = self._book_src(nb)
            info = self.undo_info(nb)
            if not info["can"]:
                return {"ok": False, "action": "nothing", "message": "没有可撤回的修改了。", "warning": None, "id": nb,
                        "file": info["file"], "left": 0}
            if rid and rid != info["id"]:
                raise Conflict("要撤回的那一次已经变了（可能在别的设备上撤回过）：没撤回。再点一次撤回看看。")
            if expect_changed is not None and bool(expect_changed) != info["changed"]:
                raise Conflict("这个文件在你确认之后又改过了：没撤回。再点一次撤回，确认时会说明。")
            aside = None
            if info["changed"]:  # 那之后又改过：现在这份另留一份（不占 5 版的名额，要用时让 Claude 找回）
                try:
                    aside = self.keeper.aside(src, NOTE_ASIDE)
                except KeepError as e:
                    raise ValueError(f"撤回前没能把现在这份另留一份（{e}）：没撤回，文件没动。") from None
            r = self.keeper.undo(src)
            out = {"ok": bool(r["ok"]), "action": r["action"], "message": r["message"], "id": nb, "mode": info["mode"],
                   "file": info["file"], "back": info.get("back"), "left": r["left"], "aside": aside["copy"] if aside else None,
                   "path": r["path"], "saved_as": r.get("saved_as"), "t": info.get("t")}
            warns = [r["warning"]] if r.get("warning") else []
            if r["action"] == "restored":
                if info["mode"] == "savepdf":  # 存回之前的那份：书页本来就不含自己写进去的批注，不用重新转换，只记下文件现在的样子
                    self.set_source(name, src)
                else:
                    try:
                        out["summary"] = self.update_document(nb, src, undo=True)
                    except (ValueError, OSError) as e:
                        warns.append(f"电脑上的文件已经撤回了，但平板上这本没换成（{e}）：点右上角的「更新这本」再试")
            elif r["action"] == "switched":
                orig = Path(r["path"])
                if orig.is_file():
                    try:
                        out["summary"] = self.update_document(nb, orig, undo=True)
                    except (ValueError, OSError) as e:
                        warns.append(f"平板上这本没换回原文件（{e}）")
                else:
                    warns.append(f"原文件 {orig} 不在了，平板上这本没换回去")
            if out.get("summary"):
                out["id"] = out["summary"]["id"]
            out["warning"] = "；".join(warns) or None
            if r["ok"] and info.get("edit"):
                self.change_edit(info["edit"], undone=True)
        if r["ok"]:
            out["told"] = self.tell_undo(info.get("edit"), out)
        self.bridge.emit("undone", nb=out["id"], old=nb)
        print(f"[撤回] {info['file']}：{out['action']}" + (f"（{out['warning']}）" if out["warning"] else ""))
        return out

    def tell_undo(self, eid, out):
        """撤回是用户在平板上做的：给改它的那个对话（存回 PDF 的是这本发往的对话）送一条简短的消息；那个对话不在了就不送。
        返回投递编号，没送返回 None。"""
        e = next((x for x in self.edits() if x["eid"] == eid), None) if eid else None
        own = (e or {}).get("sid")
        sid = own if own else (self.nb_target(out["id"]) or {}).get("sid")
        if not sid or sid not in {s["sid"] for s in self.bridge.alive()}:
            return None
        sub, d = self.new_sub_dir()
        (d / "message.txt").write_text(prompt.build_undo_message(out), "utf-8")
        self.bridge.enqueue(sid, sub)
        return sub

    # -- 对话里新生成的文件：插件报上来，平板上由用户决定要不要加进草稿纸

    def _offers_file(self):
        return self.data / "offers.json"

    def offers(self):
        f = self._offers_file()
        return json.loads(f.read_text("utf-8")) if f.exists() else []

    def save_offers(self, items):
        self._offers_file().write_text(json.dumps(items[-60:], ensure_ascii=False, indent=1), "utf-8")

    def add_offers(self, sid, label, files):
        added = []
        with self.file_lock:
            items = self.offers()
            known = {(o["path"].lower(), o.get("mtime")) for o in items}
            pending = {o["path"].lower(): o for o in items if o["state"] == "new"}
            for f in files:
                p = Path(str(f.get("path") or ""))
                if not p.is_file() or p.suffix.lower() not in IMPORT_EXT or is_temp_file(p.name):
                    continue
                if self.data in p.resolve().parents or self.books in p.resolve().parents:
                    continue  # 草稿纸自己的数据（投递截图、导入的书）不算
                self.adopt_source(p)
                mtime = int(f.get("mtimeMs") or p.stat().st_mtime * 1000)
                if (str(p).lower(), mtime) in known:
                    continue
                st = p.stat()
                old = pending.get(str(p).lower())
                if old:  # 还没处理的提示又生成了一次：更新那一条，不重复列
                    old.update(mtime=mtime, size=st.st_size, sid=sid, label=label, t=int(time.time() * 1000))
                    added.append(old)
                    continue
                o = {"id": uuid.uuid4().hex[:8], "path": str(p), "name": p.name, "ext": p.suffix.lower(),
                     "size": st.st_size, "mtime": mtime, "sid": sid, "label": label,
                     "t": int(time.time() * 1000), "state": "new"}
                items.append(o)
                pending[str(p).lower()] = o
                added.append(o)
            self.save_offers(items)
        return [self.offer_view(o) for o in added]

    def offer_view(self, o):
        """给平板看的提示：现在判断它是不是某本的原文件（可原地更新），或像某本的新版本（可替换）。"""
        o = {k: v for k, v in o.items() if k not in ("update", "replace")}
        same = self.book_of_source(o["path"])
        if same:
            o["update"] = Path(same).stem
        else:
            similar = self.similar_book(o["path"])
            if similar:
                o["replace"] = Path(similar).stem
        return o

    def pending_offers(self):
        latest = {}
        for o in self.offers():
            if o["state"] != "new" or is_temp_file(o["name"]) or not Path(o["path"]).is_file():
                continue
            same = self.book_of_source(o["path"])
            if same and not self.source_changed(same):
                continue  # 已经在草稿纸里、也没改过：不用提示
            latest[o["path"].lower()] = o  # 旧数据里同一文件可能有几条：只留最后一条
        views = [self.offer_view(o) for o in latest.values()]
        # 同一本的几个新版本（v49、v50……）只列最新的一个，其余记在 older 里
        best = {}
        for v in views:
            target = v.get("update") or v.get("replace")
            if target and (target not in best or v["mtime"] > best[target]["mtime"]):
                best[target] = v
        out = []
        for v in views:
            target = v.get("update") or v.get("replace")
            if not target:
                out.append(v)
            elif best[target] is v:
                v["older"] = [x["name"] for x in views if x is not v and (x.get("update") or x.get("replace")) == target]
                out.append(v)
        return out

    def resolve_offer(self, oid, state):
        with self.file_lock:
            items = self.offers()
            hit = [o for o in items if o["id"] == oid]
            if not hit:
                raise KeyError("这个文件提示已经过期")
            for o in items:  # 同一文件的其他待处理提示一并处理掉
                if o["state"] == "new" and o["path"].lower() == hit[0]["path"].lower():
                    o["state"] = state
            self.save_offers(items)
            return self.offer_view(hit[0])

    # -- 在平板上浏览对话所在的文件夹，点文件导入

    def session_root(self, sid):
        """连着的对话所在的文件夹；只能在这些文件夹里面浏览。"""
        s = next((x for x in self.bridge.alive() if x["sid"] == sid), None)
        if not s or not s.get("cwd"):
            raise KeyError("这个对话没连着，或不知道它在哪个文件夹")
        root = Path(s["cwd"]).resolve()
        if not root.is_dir():
            raise KeyError(f"找不到文件夹：{root}")
        return root

    def _inside(self, root, rel):
        target = (root / (rel or "")).resolve()
        if target != root and root not in target.parents:
            raise ValueError("只能浏览对话所在的文件夹")
        return target

    def _skip_dir(self, d):
        return (d.name.startswith((".", "$")) or d.name.lower() in BROWSE_SKIP
                or d.resolve() in (self.data.resolve(), self.books.resolve()))

    def _file_entry(self, root, f):
        st = f.stat()
        e = {"name": f.name, "path": f.relative_to(root).as_posix(), "kind": "file", "ext": f.suffix.lower(),
             "size": st.st_size, "mtime": int(st.st_mtime * 1000)}
        same = self.book_of_source(f)
        if same:
            e["imported"] = Path(same).stem
            e["changed"] = self.source_changed(same)
        else:
            similar = self.similar_book(f)
            if similar:
                e["replace"] = Path(similar).stem
        return e

    def _importable(self, f):
        return f.is_file() and f.suffix.lower() in IMPORT_EXT and not is_temp_file(f.name)

    def browse(self, sid, rel=""):
        root = self.session_root(sid)
        target = self._inside(root, rel)
        if not target.is_dir():
            raise KeyError("没有这个文件夹")
        dirs, files = [], []
        for x in sorted(target.iterdir(), key=lambda x: x.name.lower()):
            try:
                if x.is_dir():
                    if not self._skip_dir(x):
                        dirs.append({"name": x.name, "path": x.relative_to(root).as_posix(), "kind": "dir"})
                elif self._importable(x):
                    files.append(self._file_entry(root, x))
            except OSError:
                continue
        files.sort(key=lambda e: -e["mtime"])
        out = {"root": str(root), "rootName": root.name, "path": target.relative_to(root).as_posix() if target != root else "",
               "entries": (dirs + files)[:400]}
        if target == root:
            out["recent"] = self.recent_files(root)
        return out

    def recent_files(self, root, limit=8):
        """文件夹里最近改过的能导入的文件（往下 3 层、最多看 300 个文件夹）。"""
        found, todo, seen_dirs = [], [(root, 0)], 0
        while todo and seen_dirs < 300:
            d, depth = todo.pop()
            seen_dirs += 1
            try:
                for x in d.iterdir():
                    if x.is_dir():
                        if depth < 3 and not self._skip_dir(x):
                            todo.append((x, depth + 1))
                    elif self._importable(x):
                        found.append((x.stat().st_mtime, x))
            except OSError:
                continue
        found.sort(key=lambda t: -t[0])
        return [self._file_entry(root, f) for _, f in found[:limit]]

    def import_from_folder(self, sid, rel, mode=None):
        """平板上点了文件夹里的一个文件：导入成一本（图片也是，和从平板上传一样；「Claude 推送」那本只放 Claude 推过来的）；
        导入过的就打开或更新。

        mode="replace"：替换名字只差版本号的那本；mode="new"：另加一本。
        """
        root = self.session_root(sid)
        src = self._inside(root, rel)
        if not self._importable(src):
            raise ValueError("这个文件不能导入")
        same = self.book_of_source(src)
        if same and mode != "new":
            nb = "book:" + same
            if self.source_changed(same):
                summary = self.update_document(nb, src)
                return {"nb": summary["id"], "page": 0, "title": summary["title"], "updated": True,
                        "summary": summary["text"], "prev": summary["prev"]}
            return {"nb": nb, "page": 0, "title": Path(same).stem, "opened": True}
        similar = self.similar_book(src)
        if similar and mode == "replace":
            summary = self.update_document("book:" + similar, src)
            return {"nb": summary["id"], "page": (summary["changed"] + summary["added"] + [1])[0] - 1, "title": summary["title"],
                    "updated": True, "summary": summary["text"], "prev": summary["prev"]}
        nb = self.import_document(src, as_new=mode == "new")
        return {"nb": nb, "page": 0, "title": self.nb_title(nb)}

    # -- 从 Zotero 导入（平板导入面板的 Zotero 一栏）

    def zotero_books(self):
        """从 Zotero 导入过的书：{条目 key: 书名}。"""
        return {v["zotero"]["item"]: n for n, v in self.sources().items() if v.get("zotero") and (self.books / n).is_file()}

    def zotero_list(self, q="", coll="", start=0):
        """搜索结果、某个分类，或首页（最近添加 + 顶层分类）；导入过的标上 imported（原文件改过的 changed）。"""
        z = self.zotero
        if q:
            (items, total), cols, path = z.search(q, start), [], []
        elif coll:
            items, total = z.collection_items(coll, start)
            cols, path = (z.collections(coll) if not start else []), z.crumbs(coll)
        else:
            (items, total), cols, path = z.recent(start), (z.collections() if not start else []), []
        have = self.zotero_books()
        for e in items:
            name = have.get(e["key"])
            if name:
                e["imported"] = Path(name).stem
                e["changed"] = self.source_changed(name)
        return {"items": items, "total": total, "start": int(start), "collections": cols, "path": path, "q": q, "coll": coll}

    def zotero_import(self, key):
        """平板上点了 Zotero 里的一篇：导入它的 PDF，名字「第一作者 等 - 年份 - 标题」。

        这个文件导入过（不管当初从哪导入的）就打开那本，原文件改过的原地更新。都记下 Zotero 信息。"""
        e, att, src = self.zotero.pdf_path(key)
        meta = {"item": e["key"], "att": att, "title": e["title"], "creators": e["creators"], "year": e["year"], "type": e["type"]}
        same = self.book_of_source(src)
        if same:
            res = {"nb": "book:" + same, "page": 0, "title": Path(same).stem, "opened": True}
            if self.source_changed(same):
                summary = self.update_document("book:" + same, src)
                res = {"nb": summary["id"], "page": 0, "title": summary["title"], "updated": True,
                       "summary": summary["text"], "prev": summary["prev"]}
            self.set_source(res["nb"][5:], src, zotero=meta)
            return res
        title = " - ".join(x for x in (e["creators"], e["year"], re.sub(r"\.pdf$", "", e["title"], flags=re.I)) if x)[:80]
        nb = self.import_document(src, title=title)
        self.set_source(nb[5:], src, zotero=meta)
        return {"nb": nb, "page": 0, "title": self.nb_title(nb)}

    def accept_offer(self, oid, mode=None):
        """把文件加进草稿纸，成自己的一本：多页文档、单页 PDF、单张图都一样（不再放进「Claude 推送」）。

        mode="update"：原地更新导入过的那本；mode="replace"：用它替换名字相近的那本（都保留笔迹、可对比）；
        mode="new"：同一个原文件导入过，也另建一本。
        文件已经不在电脑上了：收掉这条提示，如实告诉平板。加的时候出错：提示恢复成没处理，可以再点一次。
        """
        view = next((x for x in self.pending_offers() if x["id"] == oid), None)
        hit = next((x for x in self.offers() if x["id"] == oid), None)
        if hit is None:
            raise KeyError("这个文件提示已经过期")
        if not Path(hit["path"]).is_file():
            self.resolve_offer(oid, "dismissed")
            raise ValueError(f"「{hit['name']}」已经不在电脑上了（可能被删了或挪走了），这条提示收掉了")
        same_file = {x["id"] for x in self.offers() if x["state"] == "new" and x["path"].lower() == hit["path"].lower()}
        o = self.resolve_offer(oid, "added")
        src = Path(o["path"])
        try:
            if mode in ("update", "replace") and o.get(mode):
                nb = self.resolve_nb(o[mode])
                summary = self.update_document(nb, src)
                # 同一本较早的几个新版本不用再提示了
                for name in (view or {}).get("older", []):
                    for x in self.offers():
                        if x["state"] == "new" and x["name"] == name:
                            self.resolve_offer(x["id"], "dismissed")
                return {"nb": summary["id"], "old": summary["old_id"], "page": (summary["changed"] + summary["added"] + [1])[0] - 1,
                        "title": summary["title"], "summary": summary["text"], "headline": summary["headline"],
                        "prev": summary["prev"], "updated": True}
            nb = self.import_document(src, as_new=mode == "new")
            return {"nb": nb, "page": 0, "title": self.notebook_info(nb)["title"]}
        except Exception:
            with self.file_lock:  # 没加成：这条提示（和同一文件的那几条）放回去，平板上还能再点
                items = self.offers()
                for x in items:
                    if x["id"] in same_file and x["state"] == "added":
                        x["state"] = "new"
                self.save_offers(items)
            raise


VERSION_NUM = re.compile(r"(?:v|ver|rev|r|版本?|修改|改|稿)(\d+)|(\d{6,})", re.I)


def name_similarity(a, b):
    """新文件名像不像旧文件名的新版本（0–1）：版本号（v48、修改7、日期）不算差别。

    只差一个编号、但编号不是版本号样式的（如「星球 p1」「星球 p2」），是不同的文件，返回 0。
    """
    norm = lambda s: VERSION_NUM.sub("#", s.lower())  # noqa: E731
    na, nb = norm(a), norm(b)
    if re.sub(r"\d+", "#", na) == re.sub(r"\d+", "#", nb) and na != nb:
        return 0.0  # 剩下的差别只在普通编号上
    ratio = difflib.SequenceMatcher(None, na, nb).ratio()
    # 版本号（v48、v50）前面的部分完全一样：同一系列，后面的说明文字（「按草稿纸批注」「按意见修改8」）随便变
    va, vb = re.search(r"v\d+", a, re.I), re.search(r"v\d+", b, re.I)
    if va and vb and va.start() >= 2 and norm(a[:va.start()]) == norm(b[:vb.start()]):
        ratio = max(ratio, 0.9)
    return ratio


def blank_height(lay, i, paper, pdf_h):
    """空白纸的高度（宽 1000）：竖版和草稿本一样（A4）；横版在书里和前面最近一页一样大（那一页是横的话），
    否则是 A4 横向。"""
    e = lay.pages[i]
    if (e.get("orient") or paper) != "landscape":
        return SCRATCH_H
    if isinstance(e.get("h"), (int, float)) and e["h"] > 0:  # 挪过页、前面换了一页：用挪之前的高度（App.move_page 记下的）
        return e["h"]
    prev = next((x["pdf"] for x in reversed(lay.pages[:i]) if "pdf" in x), None)
    if prev is not None and pdf_h and pdf_h[prev] < PAGE_W:
        return pdf_h[prev]
    return round(PAGE_W / 1.414, 1)


def is_temp_file(name):
    """Office 打开文档时的锁文件（~$开头）、各种临时文件：不当成新文件。"""
    return name.startswith(("~$", ".~", "~WRL")) or name.lower().endswith((".tmp", ".crdownload", ".part"))


def path_key(p):
    """认文件用的键：绝对路径、解开符号链接、Windows 上不分大小写（和 keep.py 认文件的办法一样）。空的给空串。"""
    if not p:
        return ""
    try:
        return os.path.normcase(os.path.realpath(os.path.abspath(str(p))))
    except (OSError, ValueError):
        return os.path.normcase(os.path.abspath(str(p)))


def file_sha(p):
    """文件内容的 SHA-256（十六进制）。读不了抛 OSError。"""
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load_config(path):
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text("utf-8-sig"))
    except ValueError as e:
        sys.exit(f"{path.name} 格式错误：{e}")


def clean_item(obj):
    """校验 Claude 写回的一条批注，返回干净的 dict 或 None。"""
    if not isinstance(obj, dict) or obj.get("type") not in ITEM_TYPES:
        return None
    item = {"type": obj["type"]}
    if isinstance(obj.get("text"), str) and obj["text"].strip():
        item["text"] = obj["text"].strip()[:300]
    for k in ("anchor", "from", "to"):
        if isinstance(obj.get(k), (str, int)):
            item[k] = str(obj[k]).strip()[:20]
    if item.get("anchor", "").lower() == "sel":  # 以前指「整块圈选处」的写法：没有圈选了，当作没给 anchor
        del item["anchor"]
    box = obj.get("box")
    if isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box):
        item["box"] = [float(v) for v in box]
    for k, n in (("anchors", 12), ("links", 6)):  # 分组的那几组、新概念要连的组
        v = obj.get(k)
        if isinstance(v, list):
            ids = [str(x).strip()[:20] for x in v if isinstance(x, (str, int)) and str(x).strip()][:n]
            if ids:
                item[k] = ids
    if item["type"] in ("read", "note", "question", "write", "suggest", "insert", "number", "label", "node",
                        "cross", "wavy", "strike") and "text" not in item:  # ✗、存疑、删除线必须带一句理由
        return None
    if item["type"] == "number":
        item["text"] = item["text"][:3]  # 圈里的编号
    if item["type"] in ("label", "node", "link") and "text" in item:
        item["text"] = item["text"][:20]  # 关系词、概念名：短
    if item["type"] == "link" and not ("from" in item and "to" in item):
        return None
    if item["type"] == "group" and "anchors" not in item:
        return None
    if item["type"] == "result":  # 回报一条采纳的修改：anchor 是 s 编号，ok 真假，text 是没改成的原因
        if "anchor" not in item or not isinstance(obj.get("ok"), bool):
            return None
        item["ok"] = obj["ok"]
    if item["type"] == "formula":  # 公式：tex 是 LaTeX；text 跟着写成源码（PDF、旧批注里用）
        tex = obj.get("tex")
        if not isinstance(tex, str) or not tex.strip():
            return None
        item["tex"] = item["text"] = tex.strip()[:300]
    if item["type"] == "sketch":  # 示意图：给结构（nodes、edges、groups），这里排版；旧写法是自己报坐标的 shapes（w × h）；text 是图注
        st = sketchlay.clean(obj) if obj.get("nodes") else None
        if st:
            lay = sketchlay.layout(*st)
            item["shapes"], size = clean_shapes(lay["shapes"]), {"w": lay["w"], "h": lay["h"]}
            item["struct"] = {"nodes": st[0], "edges": st[1], "groups": st[2]}
        else:
            item["shapes"], size = clean_shapes(obj.get("shapes")), obj
        if not item["shapes"]:
            return None
        for k, d in (("w", 600), ("h", 300)):
            v = size.get(k)
            item[k] = min(2000.0, max(50.0, float(v))) if isinstance(v, (int, float)) and not isinstance(v, bool) else float(d)
        if "text" in item:
            item["text"] = item["text"][:60]
    if item["type"] == "figure":  # 电脑上生成的图：path 是文件（PNG/JPG/SVG），回写时存进 data/figures；text 是图注
        if not isinstance(obj.get("path"), str) or not obj["path"].strip():
            return None
        item["path"] = obj["path"].strip()[:1000]
        if "text" in item:
            item["text"] = item["text"][:60]
    if item["type"] == "write":  # 长回答：平板在所答的笔迹旁标一个圈号，点开看全文
        item["text"] = obj["text"].strip()[:4000]  # 长回答可以长一些
        if isinstance(obj.get("q"), str) and obj["q"].strip():
            item["q"] = obj["q"].strip()[:200]  # 回答的是哪个红笔问题（照用户写的原样转写）
        if obj.get("card") not in (None, ""):  # 回应卡片上的红字：接在圈号 card 那张卡片下面（填得不对的由 bridge_reply 报错）
            item["card"] = card_no(obj["card"])
    return item


# 短批注最多多长（2026-11-16 规则瘦身 B 组①：原来规则里写「短的（约 40 字以内）用 note」，改成服务按字数归位）：
# note、question 的 text 超过这么多「字」，就当长回答收成圈号加卡片，放在同一个 anchor 旁边。
# 汉字、全角符号算 1 个字，英文字母、数字、半角符号和空格算半个（手写体里大约两个英文字母占一个汉字宽）。
# 为什么是 60：规则和工具说明里说的是「约 40 字以内」，门槛放宽一半，略长一点的短批注照旧上纸、不被误收；
# 短批注字号 21、最宽约 300（空白本子）到 336（书页右边那一栏），一行约 14–16 个汉字，60 字已经是四行左右，再长就挡纸面了
NOTE_MAX = 60


# 只是划线、圈、箭头的红笔组不用交读法（2026-11-16 用户定「划线免交」）：没有字可转写，交上来也只是一句「（划线）」。
# 认法保守：没全擦掉的笔画不超过 3 笔，而且本机认过字（有 reco 这一项）、头一个认法和 PP-OCR 里都没有像样的字
# ——去掉标点、符号、空白，再去掉划线和圈常被认成的那几个（一二三、〇、0、O、l、1、口……），什么都不剩。没认过字的组不免（分不出）
MARK_GLYPHS = set("一二三亠丨丿乙丶〇口日冂凵匚0OoIl1")


def mark_like(g):
    if not isinstance(g, dict) or not isinstance(g.get("reco"), list) or (g.get("n") or 1) - (g.get("erased") or 0) > 3:
        return False
    seen = (str(g["reco"][0]) if g["reco"] else "") + str(g.get("ocr") or "")
    return not [c for c in seen if unicodedata.category(c)[0] not in "PSZC" and c not in MARK_GLYPHS]


def note_len(text):
    """一段话按「字」数有多长：汉字、全角算 1，别的算半个（NOTE_MAX 的算法）。"""
    return sum(1 if unicodedata.east_asian_width(c) in "WF" else 0.5 for c in str(text))


def item_problem(obj):
    """Claude 写回的一条批注 clean_item 不收时，为什么不收（给 Claude 看的一句话）。"""
    if not isinstance(obj, dict):
        return "不是一条批注（要写成 {type, …}）"
    t = obj.get("type")
    if t not in ITEM_TYPES:
        return f"type「{t}」不认识"
    has_text = isinstance(obj.get("text"), str) and obj["text"].strip()
    if t in ("read", "note", "question", "write", "suggest", "insert", "number", "label", "node", "cross", "wavy", "strike") and not has_text:
        return prompt.MISSING_TEXT.get(t, "缺 text")
    if t == "link":
        return "缺 from 或 to（连线的两头）"
    if t == "group":
        return "缺 anchors（归成一类的那几组）"
    if t == "result":
        return "缺 anchor（s 编号）或 ok（true / false）"
    if t == "formula":
        return "缺 tex（LaTeX）"
    if t == "sketch":
        return "nodes（或旧写法的 shapes）里没有能画的"
    if t == "figure":
        return "缺 path（图的文件路径）"
    return "缺必填的内容"


def _anchor_of(it):
    return str(it.get("anchor") or "").strip().lower()


def settle_items(raw):
    """Claude 一次写回的几条批注：逐条校验（clean_item），再按规则把关（2026-11-16 规则瘦身 B 组，原来只写在固定说明里）：
    ① note、question 写长了（超过 NOTE_MAX 字）：当长回答，收成圈号卡片（type 改成 write，anchor、box 不变；没有 q 就没有，不编）；
    ② write 的 anchor 写成 end：当成没指明答哪句（页面把圈号放在这一轮最后一句还没答的红笔问题旁）；
       另画 number 去配圈号：只处理认得准的——这一次里有长回答，而且每一条 number 都指着某条长回答的同一处（同一个 anchor、
       同一个 box，或写 end、什么都没指）；有一条 number 指着别处（像是给步骤排顺序），就都不动；
    ③ 不收的（cross、wavy、strike 没带理由等）：这一条退回，说明第几条、缺什么；同一次的别的照写。
    返回（[(第几条, 批注)], [告诉 Claude 的话]）；第几条从 1 数，按 Claude 给的顺序。"""
    kept, notes = [], []
    for k, obj in enumerate(raw if isinstance(raw, list) else [], 1):
        t = obj.get("type") if isinstance(obj, dict) else None
        if t in ("note", "question") and isinstance(obj.get("text"), str) and note_len(obj["text"].strip()) > NOTE_MAX:
            it = clean_item(dict(obj, type="write"))
            if it:
                if _anchor_of(it) == "end":  # 短批注没有「页末」：当成没指明，不再另报一句
                    del it["anchor"]
                where = f" {it['anchor']} " if it.get("anchor") else " box 指的那块" if "box" in it else "这一轮最后一句还没答的红笔问题"
                notes.append(prompt.REPLY_LONG_NOTE.format(k=k, type=t, n=round(note_len(obj["text"].strip())), max=NOTE_MAX, where=where))
                kept.append((k, it))
                continue
        it = clean_item(obj)
        if it is None:
            notes.append(prompt.REPLY_REJECTED.format(k=k, type=f" {t} " if t in ITEM_TYPES else " ", why=item_problem(obj)))
            continue
        kept.append((k, it))
    writes = [it for _, it in kept if it["type"] == "write" and "card" not in it]
    for k, it in kept:
        if it in writes and _anchor_of(it) == "end":
            del it["anchor"]
            notes.append(prompt.REPLY_END_ANCHOR.format(k=k))
    if writes:
        spots = {("a", _anchor_of(w)) for w in writes if _anchor_of(w)} | {("b", tuple(w["box"])) for w in writes if "box" in w}
        nums = [(k, it) for k, it in kept if it["type"] == "number"]

        def at_write(it):
            if "box" in it:
                return ("b", tuple(it["box"])) in spots
            a = _anchor_of(it)
            return a in ("", "end") or ("a", a) in spots
        if nums and all(at_write(it) for _, it in nums):
            for k, it in nums:
                kept.remove((k, it))
                notes.append(prompt.REPLY_NUMBER_DROPPED.format(k=k))
    return kept, notes


def card_no(v):
    """write 的 card：长回答卡片的圈号，正整数（数字或数字串）；别的返回 None。"""
    if isinstance(v, bool):
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, str) and v.strip().isdigit():
        v = int(v.strip())
    return v if isinstance(v, int) and v >= 1 else None


def is_badge(a):
    """纸上一个圈号的长回答，还没擦掉（和平板 app.js 的 isBadge 加上没有 erasedAt 一样：type 是 write、at 是两个数）。"""
    if not isinstance(a, dict) or a.get("type") != "write" or a.get("erasedAt"):
        return False
    at = a.get("at")
    return isinstance(at, list) and len(at) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in at)


def shown_items(items):
    """Claude 写回的这一批里有没有平板纸上看得见的（读法只在「Claude 读到了什么」里显示，不算）。"""
    return isinstance(items, list) and any(isinstance(it, dict) and it.get("type") != "read" for it in items)


def attach_cards(page, items):
    """回应卡片上的红字的 write（带 card）：在这一页上找到那张卡片（圈号 card 的长回答），记下它的 id（cid，平板按它接）。
    圈号填得不对、这一页上没有、已经擦掉了：报错，告诉 Claude 怎么改（这次的批注一条都不写，免得回应落成别的样子）。"""
    for it in items:
        if it["type"] != "write" or "card" not in it:
            continue
        n = it["card"]
        if n is None:
            raise ValueError("write 的 card 要填长回答卡片的圈号（消息里「圈号 n 的卡片」的 n，正整数）")
        hit = [a for a in page.get("ai") or [] if isinstance(a, dict) and a.get("type") == "write" and a.get("n") == n and pages.badge_at(a)]
        if not hit:
            raise ValueError(f"这一页上没有圈号 {n} 的长回答，接不上；card 填消息里「圈号 n 的卡片」的 n（整本消息另带 page）")
        if hit[-1].get("erasedAt") or hit[-1].get("dismissed"):
            raise ValueError(f"圈号 {n} 的长回答已经被用户擦掉了，不能接在它下面；要回应的话去掉 card，写成一条新的 write")
        it["cid"] = hit[-1].get("id")


def b64_of(data_url):
    if not isinstance(data_url, str) or "," not in data_url:
        return None
    return data_url.split(",", 1)[1]


def lan_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    route_ip = None
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            route_ip = s.getsockname()[0]
    except OSError:
        pass
    if route_ip:
        ips.add(route_ip)
    # 198.18/15 是代理软件 TUN 网卡常用的地址段，平板连不上
    keep = [ip for ip in ips if not ip.startswith(("127.", "169.254.", "198.18.", "198.19.", "0."))]
    return sorted(keep, key=lambda ip: (ip != route_ip, ip.endswith(".1"), ip))


def local_name():
    """这台电脑在局域网里的名字（Windows 自带的 mDNS 会应答「电脑名.local」）；名字不是纯英文数字就不提供。"""
    host = socket.gethostname().split(".")[0].lower()
    return f"{host}.local" if host and all(c.isascii() and (c.isalnum() or c == "-") for c in host) else None


def qr_svg(text):
    if qrcode is None:
        return ""
    img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    return img.to_string(encoding="unicode")


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "InkThink/0.2"
    app: App = None

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    @property
    def is_local(self):
        return self.client_address[0] in ("127.0.0.1", "::1")

    def same_site(self):
        """本机管理接口（/bridge/、/qr）只认直接发来的请求：Host 必须是本机地址（挡 DNS 重绑定）；
        浏览器标明是别的网站发起的（Origin 对不上，或 Sec-Fetch-Site 是跨站）不收。插件不带这些头，照常通过。"""
        host = (self.headers.get("Host") or "").strip().lower()
        name = host if host.endswith("]") else host.rsplit(":", 1)[0]
        if name.strip("[]") not in ("127.0.0.1", "localhost", "::1"):
            return False
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc.lower() != host:
            return False
        return (self.headers.get("Sec-Fetch-Site") or "same-origin").lower() in ("same-origin", "none")

    def route(self, method):
        self._body_read = False  # 这一次请求的请求体读了没有（一条连接上可以接着来好几次请求）
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        path = u.path
        try:
            if method == "GET" and path in ("/", "/index.html"):
                return self.static("index.html")
            if method == "GET" and path.startswith("/static/"):
                return self.static(path[len("/static/"):])
            if (path == "/qr" or path.startswith("/bridge/")) and self.is_local and not self.same_site():
                return self.send_json({"error": "只能从这台电脑上的草稿纸页面或插件访问"}, 403)
            if method == "GET" and path == "/qr":
                return self.qr_page()
            if method == "GET" and path == "/favicon.ico":
                return self.send_bytes(b"", "image/x-icon", 204)
            if path.startswith("/bridge/"):
                if not self.is_local:  # 只给本机上的 inkpad 插件用
                    return self.send_json({"error": "只能从本机访问"}, 403)
                fn = BRIDGE.get((method, path))
                if fn:
                    return fn(self, q)
            if path.startswith("/api/"):
                # 设备令牌（配对后）或访问码，放在请求头里；只读的图片请求（<img> 发不了请求头）也可以放在地址的 d= / k= 里
                dev = self.headers.get("X-Device", "") or (q.get("d", "") if method == "GET" else "")
                given = self.headers.get("X-Access", "") or (q.get("k", "") if method == "GET" else "")
                ok = (dev and self.app.device_ok(dev, self.client_address[0])) or (given and secrets.compare_digest(given, self.app.code))
                if not ok:
                    return self.send_json({"error": "访问码不对"}, 401)
                fn = API.get((method, path))
                if fn:
                    return fn(self, q)
            self.send_json({"error": "not found"}, 404)
        except ClientGone:
            pass
        except KeyError as e:
            self.send_json({"error": str(e).strip("'\"")}, 404)
        except Conflict as e:
            self.send_json({"error": str(e), "conflict": True}, 409)
        except TargetGone as e:
            self.send_json({"error": str(e), "gone": e.label}, 410)
        except ValueError as e:
            self.send_json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001 - 本地服务：打印出来，返回 500
            traceback.print_exc()
            try:
                self.send_json({"error": f"服务器出错：{e}"}, 500)
            except (ClientGone, OSError):
                pass

    def _write(self, data):
        try:
            self.wfile.write(data)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as e:
            raise ClientGone() from e

    def _drain(self):
        """请求体还没读就要回话时（不支持的文件、没有的地址、访问码不对……）先把它读掉。
        不读就回的话，Windows 上客户端常常收不到这句回话，只看到「连接中断」。太大的只读前 64 MB。"""
        if self._body_read:
            return
        self._body_read = True
        try:
            left = min(int(self.headers.get("Content-Length") or 0), 64 * 1024 * 1024)
            while left > 0:
                chunk = self.rfile.read(min(left, 65536))
                if not chunk:
                    break
                left -= len(chunk)
        except (ValueError, OSError):
            pass

    def send_bytes(self, data, ctype, status=200, headers=None):
        self._drain()
        try:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as e:
            raise ClientGone() from e
        self._write(data)

    def send_json(self, obj, status=200):
        body = obj if isinstance(obj, (bytes, str)) else json.dumps(obj, ensure_ascii=False)
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_bytes(body, "application/json; charset=utf-8", status, {"Cache-Control": "no-store"})

    def read_body(self, limit):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError(f"请求太大（{n // 1024 // 1024} MB）")
        self._body_read = True
        return self.rfile.read(n) if n else b""

    def read_json(self, limit=1024 * 1024):
        body = self.read_body(limit)
        return json.loads(body) if body else {}

    def static(self, rel):
        if not static_rel_ok(rel):
            return self.send_json({"error": "not found"}, 404)
        f = (STATIC / rel).resolve()
        if STATIC.resolve() not in f.parents or not f.is_file():
            return self.send_json({"error": "not found"}, 404)
        cache = "public, max-age=31536000, immutable" if f.suffix == ".woff2" else "no-cache"
        self.send_bytes(f.read_bytes(), CONTENT_TYPES.get(f.suffix, "application/octet-stream"), 200,
                        {"Cache-Control": cache})

    def qr_page(self):
        if not self.is_local:
            return self.send_json({"error": "只能在电脑本机打开"}, 403)
        app = self.app
        blocks = []
        for n, ip in enumerate(lan_ips()):
            url = f"http://{ip}:{app.port}/?k={app.code}"
            hint = "先试这个（这次的 IP 地址）" if n == 0 else "上面那个打不开再试"
            blocks.append(f'<div class="b"><div class="q">{qr_svg(url)}</div><p><b>{hint}</b><br><code>{url}</code></p></div>')
        stable = app.stable_url()
        if stable:
            blocks.append(f'<div class="b"><div class="q">{qr_svg(stable)}</div><p><b>固定地址：换了网络、IP 变了也能用</b><br>'
                          f'<code>{stable}</code><br><span style="color:#777">有的网络屏蔽这种地址，打不开就用左边的</span></p></div>')
        names = "、".join(s["label"] for s in app.bridge.alive()) or "（还没有。在 Claude Code 里装好 inkpad 插件后，打开的对话会出现在这里）"
        html = f"""<!doctype html><meta charset="utf-8"><title>ThinkPaper 连接平板</title>
<style>body{{font:16px/1.5 "Microsoft YaHei",sans-serif;margin:32px;color:#222;background:#faf8f3}}
.b{{display:inline-block;margin:0 32px 24px 0;vertical-align:top}}.q svg{{width:260px;height:260px;background:#fff}}
code{{font-size:15px;user-select:all}}</style>
<h2>用平板扫码打开草稿纸</h2>
<p>平板和这台电脑要连同一个 Wi-Fi。已连上的 Claude Code 对话：{escape_html(names)}</p>
{''.join(blocks) or '<p>没找到局域网地址，检查电脑是否连着 Wi-Fi。</p>'}
<p style="color:#777">扫了打不开时：确认 Windows 防火墙已允许（见 inkthink\\README.md 的「出了问题」一节）；有些公共/校园 Wi-Fi 禁止设备互访，可改用电脑开的移动热点。</p>
<h3>设备与安全</h3>
<p style="color:#555">扫码打开过的设备会换到一个只属于它的凭据。断开一台设备时会同时换访问码（它可能还记着旧地址）；你别的设备照常用，新设备扫新的二维码。</p>
<div id="devs">读取中…</div>
<p><button onclick="act('/bridge/code/rotate','换了访问码之后，新设备要扫新的二维码。确定换？')">更换访问码</button>
 <button onclick="act('/bridge/stop','停止草稿纸服务？平板会连不上，插件也不会自动重新启动；要再用就在对话里输入 /ink。')">停止服务</button></p>
<script>
async function act(path, ask, body) {{
  if (!confirm(ask)) return;
  const r = await fetch(path, {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: JSON.stringify(body || {{}})}});
  if (path === '/bridge/stop') {{ document.body.innerHTML = '<h2>服务已停止</h2><p>要再用，在 Claude Code 对话里输入 /ink。</p>'; return; }}
  if (!r.ok) {{ alert((await r.json()).error || '没成功'); return; }}
  location.reload();
}}
fetch('/bridge/devices').then(r => r.json()).then(d => {{
  const box = document.getElementById('devs');
  if (!d.devices.length) {{ box.textContent = '还没有设备配对过。'; return; }}
  const table = document.createElement('table');
  table.style.borderCollapse = 'collapse';
  for (const x of d.devices) {{
    const tr = table.insertRow();
    const cell = (text, css) => {{ const td = tr.insertCell(); td.style.cssText = css; td.textContent = text; }};
    cell(x.name, 'padding:4px 12px 4px 0;font-weight:bold');
    cell('配对于 ' + x.created.replace('T', ' '), 'padding:4px 12px;color:#555');
    cell(x.seen ? '最近 ' + x.seen.replace('T', ' ') + '，' + x.ip : '这次启动后还没连过', 'padding:4px 12px;color:#555');
    const b = document.createElement('button');
    b.textContent = '断开';
    b.onclick = () => act('/bridge/devices/revoke', '断开「' + x.name + '」？它需要重新扫码才能再用，访问码也会一起换。', {{id: x.id}});
    tr.insertCell().appendChild(b);
  }}
  box.textContent = '';
  box.appendChild(table);
}});
</script>
<p style="color:#777"><a href="?lang=zh">中文</a> · <a href="?lang=en">English</a></p>
<script src="/static/i18n.js"></script>"""
        self.send_bytes(html.encode("utf-8"), "text/html; charset=utf-8", 200, {"Cache-Control": "no-store"})


# -- 平板用的接口（需要访问码）

def api_config(h, q):
    h.send_json({"pdf": fitz is not None})


def api_pair(h, q):
    """平板第一次用访问码打开：换一个只属于这台设备的令牌，之后都用它。"""
    dev_id, token = h.app.pair_device(str(h.read_json().get("name") or ""), h.client_address[0])
    h.send_json({"id": dev_id, "token": token})


# -- 本机才能用的管理接口（/bridge/ 下，只许本机访问）

def bridge_devices(h, q):
    h.send_json({"devices": h.app.device_list()})


def bridge_device_revoke(h, q):
    h.app.revoke_device(str(h.read_json().get("id") or ""))
    h.send_json({"ok": True})


def bridge_code_rotate(h, q):
    h.app.rotate_code()
    h.send_json({"ok": True})


def bridge_stop(h, q):
    """停止服务：记下是用户自己停的（插件不再自动拉起，直到下次 /ink 或 start.bat），回完话再停。"""
    (h.app.data / "stopped.flag").write_text(datetime.now().isoformat(timespec="seconds"), "utf-8")
    h.send_json({"ok": True})
    print("[停止] 用户停止了服务", flush=True)
    threading.Thread(target=h.server.shutdown, daemon=True).start()


def api_notebooks(h, q):
    h.send_json(h.app.notebooks())


def api_notebook(h, q):
    h.send_json(h.app.notebook_info(q.get("nb", "scratch")))


def api_add_page(h, q):
    h.send_json(h.app.add_page(q.get("nb", "scratch")))


def api_get_page(h, q):
    h.send_json(h.app.load_page(q.get("nb", "scratch"), int(q.get("i", 0))))


def api_put_page(h, q):
    rev = h.app.save_page(q.get("nb", "scratch"), int(q.get("i", 0)), h.read_body(limit=40 * 1024 * 1024),
                          client=h.headers.get("X-Client", "")[:40])
    h.send_json({"ok": True, "rev": rev})


def api_pending(h, q):
    h.send_json(h.app.take_pending(q.get("nb", "scratch"), int(q.get("i", 0))))


def api_book_page(h, q):
    nb = q.get("nb", "")
    if not nb.startswith("book:") or fitz is None:
        raise KeyError("不是书页")
    e = h.app.page_entry(nb, int(q.get("i", 0)))
    if "pdf" not in e:
        raise KeyError("这一页是插入的空白纸，没有底图")
    data = h.app.old_page_jpeg(nb, e["pdf"]) if q.get("old") else h.app.book_page_jpeg(nb[5:], e["pdf"])
    # 地址里带着版本号（v），书更新后地址就变了，所以可以放心缓存
    h.send_bytes(data, "image/jpeg", 200, {"Cache-Control": "private, max-age=86400"})


def api_book_update(h, q):
    """平板上点「更新」：用原文件的新版本原地替换这本书（笔迹跟着对应的页走，改动处记下来供对比）。"""
    app = h.app
    nb = h.read_json().get("nb", "")
    summary = app.update_document(nb)
    app.bridge.emit("updated", nb=summary["id"], old=nb, text=summary["text"], title=summary["title"], prev=summary["prev"])
    print(f"[更新] {summary['title']}：{summary['headline']}")
    h.send_json(summary)


def api_figure(h, q):
    """Claude 放上来的图（data/figures 里的 PNG）。"""
    name = q.get("f", "")
    f = h.app.data / "figures" / name
    if not FIG_NAME.match(name) or not f.is_file():
        raise KeyError("没有这张图")
    h.send_bytes(f.read_bytes(), "image/png", 200, {"Cache-Control": "private, max-age=86400"})


def api_board_bg(h, q):
    e = h.app.page_entry("board", int(q.get("i", 0)))
    if "board" not in e:
        raise KeyError("这一页是插入的空白纸，没有底图")
    h.send_bytes(h.app.board_image(e["board"]), "image/png", 200, {"Cache-Control": "private, max-age=86400"})


def api_page_insert(h, q):
    app = h.app
    req = h.read_json()
    nb = str(req.get("nb") or "scratch")
    i = app.insert_page(nb, int(req.get("after", -1)), req.get("orient"))
    h.send_json({"page": i, "notebook": app.notebook_info(nb)})


def api_page_delete(h, q):
    app = h.app
    req = h.read_json()
    nb = str(req.get("nb") or "scratch")
    app.delete_page(nb, int(req.get("i", 0)))
    h.send_json({"notebook": app.notebook_info(nb)})


def api_page_move(h, q):
    """抽屉里拖缩略图换页序：{nb, from, to, key}，把第 from 页挪到第 to 页（都从 0 起，to 按挪完以后的位置算）。
    只改页序，各页的笔迹文件不动；key 是平板以为第 from 页是哪一页，对不上就不挪（400）。和插页、删页一样返回挪完后的页号和这本的样子。"""
    app = h.app
    req = h.read_json()
    nb = str(req.get("nb") or "scratch")
    i = app.move_page(nb, int(req.get("from", -1)), int(req.get("to", -1)), str(req.get("key") or "") or None)
    h.send_json({"page": i, "notebook": app.notebook_info(nb)})


def api_page_hidden(h, q):
    h.send_json(h.app.hidden_pages(q.get("nb", "scratch")))


def api_page_restore(h, q):
    app = h.app
    req = h.read_json()
    nb = str(req.get("nb") or "scratch")
    i = app.restore_page(nb, str(req.get("key") or ""))
    h.send_json({"page": i, "notebook": app.notebook_info(nb)})


def api_thumb(h, q):
    if fitz is None:
        raise KeyError("没有安装 PyMuPDF")
    h.send_bytes(h.app.page_thumb(q.get("nb", "scratch"), int(q.get("i", 0))), "image/png", 200,
                 {"Cache-Control": "private, max-age=60"})


def api_notebook_new(h, q):
    app = h.app
    req = h.read_json()
    nb = app.new_pad(req.get("title"), str(req.get("paper") or "portrait"))
    print(f"[新本子] {app.nb_title(nb)}")
    h.send_json(app.notebook_info(nb))


def api_upload(h, q):
    if fitz is None:
        raise ValueError("没有安装 PyMuPDF，不能导入文档")
    raw = (q.get("name") or "文档.pdf").replace("\\", "/").split("/")[-1]
    name = "".join(c for c in raw if c.isprintable() and c not in '<>:"|?*').strip() or "文档.pdf"
    if Path(name).suffix.lower() not in IMPORT_EXT:
        raise ValueError(f"可以导入 {IMPORT_KINDS}")
    body = h.read_body(limit=400 * 1024 * 1024)
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / name
        src.write_bytes(body)
        nb = h.app.import_document(src, register=False)  # 平板上传的是临时文件，没有可跟踪的原文件
    print(f"[导入] {name} → {nb[5:]}")
    h.send_json({"id": nb})


def api_where(h, q):
    req = h.read_json()
    if isinstance(req.get("nb"), str) and isinstance(req.get("page"), int):
        h.app.bridge.where = {"nb": req["nb"], "page": req["page"]}
    h.send_json({"ok": True})


def api_sessions(h, q):
    """连着的对话（最近打字的在前）：平板「这本发往」的列表按文件夹分组，每个对话写最近打的一句话、什么时候开的、
    多久前活跃、执行过 /ink 没有（插件报的；/ink here 指定过的那个也算）。"""
    b = h.app.bridge
    now = time.time()
    h.send_json({"sessions": [{"sid": s["sid"], "label": s["label"], "cwd": s["cwd"], "idle": int(now - s["active"]),
                               "started": s.get("started"), "hint": s.get("hint"),
                               "ink": bool(s.get("ink")) or s["sid"] == b.preferred} for s in b.alive()],
                 "default": b.default_target(), "preferred": b.preferred})


def api_target(h, q):
    req = h.read_json()
    b = h.app.bridge
    b.set_preferred(req.get("sid"))
    h.send_json({"default": b.default_target()})


def api_send(h, q):
    app, b = h.app, h.app.bridge
    req = json.loads(h.read_body(limit=30 * 1024 * 1024))
    nb = str(req.get("nb") or "scratch")
    app.ensure_shareable(nb)
    s = app.send_target(nb, str(req.get("target") or ""))  # 这本的对话；原对话不在了先问
    target = req["target"] = s["sid"]
    sub_id, _ = app.save_submission(req)
    b.enqueue(target, sub_id)
    app.progress(sub_id, "sent", target)
    stamps = [max(g.get("t1") or 0, g.get("erasedAt") or 0) for g in req.get("groups") or []]
    if stamps:  # 整页都交上去了：这个对话再整本检测时，这一页之前的笔迹不再算新写的
        app.mark_seen(nb, {app.page_key(nb, int(req.get("page") or 0)): max(stamps)}, target)
    label = s["label"]
    print(f"[投递] → {label} · {sub_id}")
    # 连同交上去的长回答卡片上的红字：{长回答 id: [红字 id]}，平板记下这一轮（圈号上的红点没了）
    cards = {c["id"]: c["marks"] for c in app.load_submission(sub_id).get("cards") or [] if c.get("id")}
    h.send_json({"id": sub_id, "target": target, "label": label, "cards": cards})


def api_events(h, q):
    since = int(q.get("since") or 0)
    wait = min(25.0, float(q.get("wait") or 20))
    events, seq = h.app.bridge.wait_events(since, wait)
    h.send_json({"events": events, "seq": seq})


def api_snapshot(h, q):
    b = h.app.bridge
    req = json.loads(h.read_body(limit=30 * 1024 * 1024))
    slot = b.snapshots.get(req.get("rid"))
    if not slot:
        raise KeyError("这个快照请求已经过期")
    try:
        # 发出快照请求时查过一次（bridge_snapshot），但平板可能正好在这几秒里换到了「只在本地」的本子：
        # 交回来的是那一本的页，这里再查一次，不存、不发，回给 Claude 的话不带书名
        h.app.ensure_shareable(str(req.get("nb") or "scratch"), "平板上开着的这一本")
        slot["result"] = h.app.save_submission(req, snapshot=True, reader=slot.get("sid"))
    except ValueError as e:
        slot["error"] = str(e)
    slot["done"].set()
    h.send_json({"ok": True})


def api_new_pages(h, q):
    nb = q.get("nb", "scratch")
    h.send_json({"pages": h.app.new_pages(nb, h.app.seen_sid(nb))})


def api_send_all(h, q):
    """几页一起交给 Claude（点「AI」时别的页也有新字就走这里，only_new）：每页画成一张图，一起投递，标出上次之后新写的。"""
    app, b = h.app, h.app.bridge
    req = h.read_json()
    nb = str(req.get("nb") or "scratch")
    app.ensure_shareable(nb)
    s = app.send_target(nb, str(req.get("target") or ""))
    target = s["sid"]
    sub_id, _, count = app.scan(nb, only_new=bool(req.get("only_new")), target=target, origin="tablet")
    if not count:
        shutil.rmtree(app.data / "submissions" / sub_id, ignore_errors=True)
        raise ValueError("这本里没有新写的页" if req.get("only_new") else "这本里还没有写过字")
    b.enqueue(target, sub_id)
    app.progress(sub_id, "sent", target)
    label = s["label"]
    print(f"[整本] → {label} · {count} 页 · {sub_id}")
    h.send_json({"id": sub_id, "target": target, "label": label, "pages": count})


def confirm_public(c, app=None):
    """t：问的时刻（平板把确认卡片和问话卡片按先后排成一队）；每处的截图只说有没有（iw、ih 是它的像素大小，平板先留好位置）。
    给了 app：问过之后插了页、删了页、挪了页，页号和「哪一页」那句按那一页的键现找（找不到就照问的时候的）。"""
    page, where = c["page"], c["where"]
    if app is not None and c.get("key"):
        try:
            now = app.index_of_key(c["nb"], c["key"])
            if now is not None and now != page:
                page, where = now, app.page_label(c["nb"], now)
        except Exception:  # noqa: BLE001 - 本子没了、改了名：照问的时候的
            pass
    return {"id": c["id"], "label": c["label"], "nb": c["nb"], "page": page, "where": where, "t": c.get("t", 0),
            "questions": [{k: v for k, v in qq.items() if k != "img"} | {"img": bool(qq.get("img"))}
                          for qq in c["questions"]]}


def png_size(path):
    """PNG 的宽高（读文件头）；读不出返回 (0, 0)。"""
    try:
        with open(path, "rb") as f:
            head = f.read(24)
    except OSError:
        return 0, 0
    if not head.startswith(b"\x89PNG\r\n\x1a\n") or len(head) < 24:
        return 0, 0
    return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")


def ask_public(c):
    """平板上显示的一张问话卡片：问题（选项、能不能手写）或结果。origin 是 server 的（服务自己问的，比如改文件前问覆盖还是另存）
    在英文界面里跟着翻译；Claude 写的照原文。"""
    return {"id": c["id"], "kind": c["kind"], "label": c["label"], "t": c["t"], "question": c["question"],
            "options": c["options"], "write": c["write"], "text": c["text"], "origin": c.get("origin") or "claude"}


def api_asks(h, q):
    b = h.app.bridge
    with b.cond:  # 别的请求可能正往里加卡片
        cards = [ask_public(c) for c in b.asks.values() if c["answer"] is None]
    h.send_json(sorted(cards, key=lambda c: c["t"]))


def api_ask_answer(h, q):
    """平板上答了问话卡片：{id, choice}（点的选项）、{id, image}（手写那块纸的 PNG，data URL）或 {id}（结果卡片点了「知道了」）。"""
    req = h.read_json(limit=8 * 1024 * 1024)
    cid = str(req.get("id") or "")
    image = b64_of(req.get("image")) if req.get("image") else None
    ans = h.app.answer_card(cid, choice=req.get("choice"), image_b64=image)
    print(f"[问话] {cid} " + ("看过了" if ans.get("seen") else "已回答"))
    h.send_json({"ok": True})


def api_confirms(h, q):
    b = h.app.bridge
    h.send_json([confirm_public(c, h.app) for c in b.confirms.values() if c["answers"] is None])


def api_confirm_img(h, q):
    c = h.app.bridge.confirms.get(q.get("id", ""))
    k = int(q.get("k") or 0)
    if not c or not 0 <= k < len(c["questions"]) or not c["questions"][k].get("img"):
        raise KeyError("没有这张图")
    h.send_bytes(Path(c["questions"][k]["img"]).read_bytes(), "image/png", 200, {"Cache-Control": "no-store"})


def answer_confirm(app, cid, raw, quiet=False):
    """平板上答了字迹确认卡片：raw 是每处的 {text}（空的算「看不清，跳过」）。记下、叫醒等着的一方；
    Claude 那边已经不等了就作为一条新消息送进对话。点「看不清，跳过」和「全部忽略」都走这里（全部忽略时 raw 是空的：每处都算跳过）。
    quiet：「全部忽略」清掉的：Claude 已经不等了也不送消息（《产品定义》第 3 节：忽略不把对话吵醒）；还在等的照样拿到「跳过」。"""
    b = app.bridge
    c = b.confirms.get(cid)
    if not c or c["answers"] is not None:
        raise KeyError("这张确认卡片已经回答过或过期了")
    answers = []
    for k in range(len(c["questions"])):
        a = raw[k] if k < len(raw) and isinstance(raw[k], dict) else {}
        text = str(a.get("text") or "").strip()[:500]
        answers.append({"text": text} if text else {"skip": True})
    c["answers"] = answers
    app.add_corrections(c, answers)  # 我更正了的读法：记进更正表
    c["done"].set()
    b.emit("confirmed", id=c["id"])
    b.persist()
    if c["late"] and not quiet:  # Claude 那边已经不等了：作为一条新消息送进对话
        sub_id, d = app.new_sub_dir()
        text = prompt.build_confirm_answer(c, answers, late=True)
        (d / "message.txt").write_text(text, "utf-8")
        meta = {"id": sub_id, "target": c["sid"], "nb": c["nb"], "page": c["page"], "page_key": c.get("key"), "groups": c["groups"],
                "crop": {"x0": 0, "y0": 0, "scale": 1}, "sel": None}
        (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
        b.enqueue(c["sid"], sub_id)
    return answers


def api_confirm_answer(h, q):
    req = h.read_json()
    raw = req.get("answers") or []
    answer_confirm(h.app, str(req.get("id") or ""), raw if isinstance(raw, list) else [])
    print(f"[确认] {req.get('id')} 已回答")
    h.send_json({"ok": True})


def api_ask_ignore(h, q):
    """平板上点了问题卡片的「忽略」：{id}。不算回答——还在等的工具告诉 Claude 用户忽略了；已经不等了的不往对话里送消息。"""
    req = h.read_json()
    cid = str(req.get("id") or "")
    c = h.app.bridge.asks.get(cid)
    if c and c["kind"] != "question":
        raise ValueError("只有问题卡片能忽略")
    h.app.answer_card(cid, ignore=True)
    print(f"[问话] {cid} 忽略了")
    h.send_json({"ok": True})


def api_cards_ignore_all(h, q):
    """平板上点了「全部忽略（N 张）」：{ids}（平板上排着的那几张）。问题卡片按忽略算，字迹确认卡片按「看不清，跳过」算，
    结果卡片按点了「知道了」算；已经答过、过期了的跳过。Claude 已经不等了的，哪一种都不往对话里送消息。返回清掉了几张。"""
    app, req = h.app, h.read_json()
    ids = [str(x) for x in (req.get("ids") or []) if isinstance(x, str)][:200]
    done = 0
    for cid in ids:
        try:
            if cid in app.bridge.asks:
                app.answer_card(cid, ignore=True)
            elif cid in app.bridge.confirms:
                answer_confirm(app, cid, [], quiet=True)
            else:
                continue
            done += 1
        except KeyError:  # 别处刚答过
            continue
    print(f"[问话] 全部忽略：{done} 张")
    h.send_json({"ok": True, "ignored": done})


def api_notebook_rename(h, q):
    req = h.read_json()
    nb = h.app.rename_notebook(str(req.get("nb") or ""), req.get("title"))
    print(f"[改名] {req.get('nb')} → {h.app.nb_title(nb)}")
    h.send_json({"id": nb, "title": h.app.nb_title(nb)})


def api_notebook_setting(h, q):
    """平板上改本子的设置：「连续阅读」（flow）和「只在本地」（local），都是布尔值。"""
    req = h.read_json()
    if req.get("key") not in ("flow", "local") or not isinstance(req.get("value"), bool):
        raise ValueError("只能设置 flow 或 local（true / false）")
    h.app.set_setting(req.get("nb", ""), req["key"], req["value"])
    h.send_json({"ok": True})


def api_notebook_target(h, q):
    """平板上「发往：XX ▾」选了一个对话：这本以后发到那里。"""
    app = h.app
    req = h.read_json()
    nb = str(req.get("nb") or "")
    if not app.bind_target(nb, str(req.get("sid") or "")):
        raise ValueError("这个对话已经断开了")
    print(f"[发往] {app.nb_title(nb)} → {app.nb_target(nb)['label']}")
    h.send_json({"target": app.nb_target(nb)})


def api_notebook_delete(h, q):
    app = h.app
    nb = h.read_json().get("nb", "")
    title = app.delete_book(nb)
    app.bridge.emit("deleted", nb=nb, title=title)
    print(f"[删除] {title}")
    h.send_json({"ok": True, "title": title})


def api_folders(h, q):
    """抽屉里的文件夹（只是归类）：[{id, name, items, folded?}]，items 里只有现在还在的本子。"""
    h.send_json({"folders": h.app.folder_list()})


def api_folder_new(h, q):
    """新建文件夹（排在最后）；带 nb 就顺手把这本放进去。"""
    app, req = h.app, h.read_json()
    nb = str(req.get("nb") or "")
    if nb and (nb in folders.FIXED or nb not in app.nb_ids()):
        raise ValueError("草稿本和「Claude 推送」不能放进文件夹" if nb in folders.FIXED else f"没有这个本子：{nb}")

    def make(items):
        fd = folders.create(items, req.get("name"))
        if nb:
            folders.move(items, nb, fd["id"])
        return fd
    fd = app.change_folders(make)
    print(f"[文件夹] 新建「{fd['name']}」" + (f"，放进《{app.nb_title(nb)}》" if nb else ""))
    h.send_json({"id": fd["id"], "folders": app.folder_list()})


def api_folder_rename(h, q):
    app, req = h.app, h.read_json()
    fd = app.change_folders(lambda items: folders.rename(items, str(req.get("id") or ""), req.get("name")))
    print(f"[文件夹] 改名为「{fd['name']}」")
    h.send_json({"folders": app.folder_list()})


def api_folder_delete(h, q):
    """删文件夹：里面的本子回到外面，本子本身不动。"""
    app, req = h.app, h.read_json()
    fd = app.change_folders(lambda items: folders.delete(items, str(req.get("id") or "")))
    print(f"[文件夹] 删掉「{fd['name']}」，{len(fd['items'])} 本回到外面")
    h.send_json({"folders": app.folder_list()})


def api_folder_move(h, q):
    """把一本放进某个文件夹（folder 是文件夹的 id），或移出文件夹（folder 为空）。"""
    app, req = h.app, h.read_json()
    nb, fid = str(req.get("nb") or ""), str(req.get("folder") or "")
    if nb not in folders.FIXED and nb not in app.nb_ids():
        raise KeyError(f"没有这个本子：{nb}")
    fd = app.change_folders(lambda items: folders.move(items, nb, fid))
    print(f"[文件夹] 《{app.nb_title(nb)}》" + (f"放进「{fd['name']}」" if fd else "移出文件夹"))
    h.send_json({"folders": app.folder_list()})


def api_save_pdf(h, q):
    res = h.app.save_pdf(h.read_json().get("nb", ""))
    print(f"[存回 PDF] {res['file']}：手写 {res['ink']} 组、Claude 批注 {res['marks'] + res['notes']} 条，"
          f"跳过页面外 {res['outside'] + res['outside_ai']}、空白页 {res['blank']}")
    h.send_json(res)


def api_files(h, q):
    h.send_json(h.app.browse(q.get("sid", ""), q.get("path", "")))


def api_files_import(h, q):
    app = h.app
    req = h.read_json()
    res = app.import_from_folder(str(req.get("sid") or ""), str(req.get("path") or ""), req.get("mode"))
    if res.get("nb") != "board":  # 从这个对话的文件夹导入的本子：没绑过对话的就发给它
        app.bind_target(res["nb"], str(req.get("sid") or ""), only_new=True)
    print(f"[从文件夹导入] {req.get('path')} → {res['title']}")
    h.send_json(res)


def api_zotero(h, q):
    h.send_json(h.app.zotero_list(q.get("q", "").strip()[:200], q.get("coll", ""), int(q.get("start") or 0)))


def api_zotero_import(h, q):
    key = str(h.read_json().get("key") or "")
    res = h.app.zotero_import(key)
    print(f"[从 Zotero 导入] {key} → {res['title']}")
    h.send_json(res)


def api_offers(h, q):
    h.send_json(h.app.pending_offers())


def api_offer_accept(h, q):
    app = h.app
    req = h.read_json()
    try:
        res = app.accept_offer(req.get("id", ""), req.get("mode"))
    finally:  # 成没成都告诉各台平板马上刷新这条提示：没加成时提示放回去了，文件不在了时收掉了（阶段 E 补：以前只在加成时发）
        app.bridge.emit("offers")
    if res.get("updated"):
        app.bridge.emit("updated", nb=res["nb"], old=res["old"], text=res["summary"], title=res["title"], prev=res["prev"])
    print(f"[加入] {res['title']}")
    h.send_json(res)


def api_offer_dismiss(h, q):
    app = h.app
    req = h.read_json()
    if req.get("all"):
        with app.file_lock:
            items = app.offers()
            for o in items:
                if o["state"] == "new":
                    o["state"] = "dismissed"
            app.save_offers(items)
    else:
        app.resolve_offer(req.get("id", ""), "dismissed")
    app.bridge.emit("offers")
    h.send_json({"ok": True})


# -- 插件用的接口（只限本机）

def bridge_hello(h, q):
    app = h.app
    req = h.read_json()
    sid = str(req.get("sid") or "")
    if not sid:
        raise ValueError("缺少 sid")
    hint = " ".join(str(req.get("hint") or "").split())
    app.bridge.hello(sid, str(req.get("label") or ""), str(req.get("cwd") or ""),
                     started=req.get("started"), hint=hint, ink=req.get("ink") is True)
    h.send_json(bridge_status_of(app, sid))


def bridge_status_of(app, sid):
    b = app.bridge
    nb = (b.where or {}).get("nb")
    try:  # 平板上开着的那本发往哪个对话
        target, title = (app.target_of(nb), app.nb_title(nb)) if nb else (b.default_target(), "")
    except (KeyError, ValueError, OSError):
        target, title = b.default_target(), ""
    labels = {s["sid"]: s["label"] for s in b.alive()}
    url = app.tablet_url()
    # 平板上开着的是「只在本地」的本子：/ink 的输出和面板进的是 Claude 的对话，不带它的名字，也不说它发往谁
    # （2026-11-17 用户定；和 /bridge/* 的拒绝话不带书名是一回事）。插件按 targetLocal 另说一句
    local = False
    try:
        local = bool(nb) and app.is_local(nb)
    except (KeyError, ValueError, OSError):
        pass
    if local:
        target, title = None, ""
    return {
        "url": url, "qr": qr_svg(url), "code": app.code, "known": sid in b.sessions, "stableUrl": app.stable_url(),
        "tabletOnline": b.tablet_online(), "isTarget": target == sid and not local, "targetLocal": local,
        "targetLabel": labels.get(target, ""), "targetNb": title, "sessions": len(labels),
        "submissionsDir": str((app.data / "submissions").resolve()),
        "skipDirs": [str(app.data.resolve()), str(app.books.resolve())],  # 找新文件时跳过草稿纸自己的数据
        "protocol": prompt.protocol(),  # 插件放进系统提示的固定说明
    }


def bridge_status(h, q):
    h.send_json(bridge_status_of(h.app, q.get("sid", "")))


def bridge_poll(h, q):
    app, sid = h.app, q.get("sid", "")
    if not app.bridge.touch(sid):
        return h.send_json({"unknown": True})
    sub_id = app.bridge.pop(sid, lease=q.get("ack") == "1")
    if not sub_id:
        return h.send_json({})
    text = (app.data / "submissions" / sub_id / "message.txt").read_text("utf-8")
    h.send_json({"submission": {"id": sub_id, "text": text}})


def bridge_ack(h, q):
    req = h.read_json()
    sid, sub = str(req.get("sid") or ""), str(req.get("id") or "")
    ok = h.app.bridge.ack(sid, sub)
    if ok:
        h.app.progress(sub, "delivered", sid)
    h.send_json({"ok": ok})


def bridge_progress(h, q):
    """插件报这一轮的进展（排队、Claude 在看、在改文件、结束）。"""
    app, req = h.app, h.read_json()
    sid = str(req.get("sid") or "")
    stage = str(req.get("stage") or "")
    ok = stage in ("queued", "reading", "working", "done") and app.progress(str(req.get("id") or ""), stage, sid)
    h.send_json({"ok": bool(ok)})


def bridge_active(h, q):
    req = h.read_json()
    h.app.bridge.mark_active(req.get("sid", ""), " ".join(str(req.get("hint") or "").split()))
    h.send_json({"ok": True})


def bridge_claim(h, q):
    """/ink here：平板上开着的这本改发到这个对话；也作为还没绑过对话的本子的默认。"""
    app, b = h.app, h.app.bridge
    sid = h.read_json().get("sid")
    b.set_preferred(sid)
    nb = (b.where or {}).get("nb")
    if nb and sid:
        app.bind_target(nb, sid)
    h.send_json({"ok": True})


def bridge_bye(h, q):
    h.app.bridge.bye(h.read_json().get("sid", ""))
    h.send_json({"ok": True})


def bridge_reply(h, q):
    app = h.app
    req = h.read_json()
    meta = app.locate(req.get("sid", ""), req.get("submission"), req.get("page"))
    # 用户定的（2026-11-12）：只在本地的本子 Claude 也不往上写；拦下时那句不带书名（2026-11-16，原来开头是「《书名》这本」）
    app.ensure_writable(meta["nb"], "这一页所在的那本", "往上写批注", "写")
    # 逐条校验、按规则把关（短批注写长了收成圈号、write 的 anchor 写 end、另画 number 配圈号、缺理由的批改符号退回）：
    # 查出来的话接在工具结果后面告诉 Claude（notes）
    kept, notes = settle_items(req.get("items") or [])
    if not kept:
        raise ValueError("items 里没有能写的批注" + ("：" + "".join(notes) if notes else "（items 是空的）"))
    for k, it in [x for x in kept if x[1]["type"] == "result"]:  # 回报：s 编号换成建议的 id；对不上的不要
        ref = (meta.get("vx") or {}).get(str(it["anchor"]).lower())
        if ref:
            it["ref"] = ref
        else:
            kept.remove((k, it))
            notes.append(prompt.REPLY_BAD_RESULT.format(k=k, s=it["anchor"]))
    items = [it for _, it in kept]
    if not items:
        raise ValueError("result 的 anchor 要填消息里「修改建议的决定」列出的 s 编号")
    if any(it["type"] == "write" and "card" in it for it in items):  # 回应卡片上的红字：那张卡片得在这一页上、没擦掉
        attach_cards(json.loads(app.load_page(meta["nb"], meta["page"])), items)
    for it in items:  # 图：把文件存进来（SVG 画成 PNG），平板、发给 Claude 的图、存回 PDF 都用这一份
        if it["type"] == "figure":
            it.update(app.store_figure(it.pop("path")))
    results = [x for x in items if x["type"] == "result"]
    eid = app.edit_of_round(meta["nb"], meta["id"]) if results else None
    for it in results if eid else ():  # 这几条是哪一次改文件改的：平板上撤回那一次时，「已改」写成「已撤回」
        it["edit"] = eid
    groups, gx = app.line_anchors(meta, items)
    entry = {"req": meta["id"], "level": meta.get("level"), "items": items, "groups": groups, "gx": gx,
             "crop": meta.get("crop"), "sel": meta.get("sel"), "rot": meta.get("rot"), "t": int(time.time() * 1000)}
    app.add_pending(meta["nb"], meta["key"], entry)
    if results:  # 回报了的不再在之后的消息里提醒（B 组⑤）
        app.settle_owed([it["ref"] for it in results])
    missing = app.reads_owed(meta, items)  # 红笔那几组、回应到的那几组还缺读法的：点名，不拦（B 组④）
    if missing:
        notes.append(prompt.REPLY_MISSING_READS.format(ids="、".join(missing)))
    label = app.page_label(meta["nb"], meta["page"])
    # key：那一页的键（页号会因插页、删页、换页序变）；shown：有没有纸上看得见的（只有读法的不在平板上出「别的页有新回答」的记号）
    app.bridge.emit("ai", nb=meta["nb"], page=meta["page"], key=meta["key"], shown=shown_items(items), req=meta["id"], label=label)
    app.progress(meta["id"], "replied", req.get("sid", ""))
    print(f"[回写] {len(items)} 条 → {label}")
    h.send_json({"ok": True, "count": len(items), "page": label, "tabletOnline": app.bridge.tablet_online(), "notes": notes})


def bridge_show(h, q):
    app = h.app
    req = h.read_json()
    # 「Claude 推送」设成了只在本地：不加页、不改它发往的对话（2026-11-16 用户定），Word、PPT 也不先转换
    app.ensure_writable("board", "「Claude 推送」这本", "往里推页面，这次什么都没推", "推")
    i = app.add_board_page(req.get("path", ""), req.get("page"), req.get("title"))
    app.bind_target("board", str(req.get("sid") or ""))  # 推给你的页，你在上面写的发回推它的对话
    title = app.board_index()["pages"][i]["title"]
    shown = app.index_of_key("board", f"p{i:04d}")
    app.bridge.emit("show", nb="board", page=shown, title=title)
    print(f"[推送] {title}")
    h.send_json({"ok": True, "page": shown, "title": title, "tabletOnline": app.bridge.tablet_online()})


def bridge_import(h, q):
    """ink_import：导入一份文档；导入过的（或指定替换某本）原地更新。另存出来的新文件（ink_edit 选了另存）导入时，
    原文件那本跟着换成它。原地更新时原文件自上次导入后变了、却没先留底：结果里带一句提醒（remind），不拦。

    要落到的那本「只在本地」（2026-11-16 用户定「拦住，也不列名字」）：拒绝，什么都不写——同一个原文件再导入时也不悄悄另建一本；
    Claude 明说 as_new 才另建（只在本地的那本不动）。同一个原文件导入成了几本时，先落到不是只在本地的那本。"""
    app = h.app
    req = h.read_json()
    path = req.get("path", "")
    target = app.resolve_nb(req["replace"], claude=True) if req.get("replace") else None
    which = "replace 指的那本"
    if not target and not req.get("as_new"):
        same = app.book_of_source(path, shared_first=True)
        if same:
            target, which = "book:" + same, "这个文件导入成的那本"
        else:
            target, which = app.saveas_book(path, shared_first=True), "原文件导入成的那本"
    if target:  # 同一个文件的新版本，或指定替换某本，或另存出来的那份：原地更新，笔迹保留
        app.ensure_writable(target, which, "往里导入、不换掉它，这次什么都没导入", "导入", "不要另建一本绕过去。")
        flush_tablet(app)
        remind = app.import_remind(target, path)
        eid = app.pending_edit(path)  # 改完导入：记下是哪一次修改，平板上的提示条据此出「撤回这次修改」
        summary = app.update_document(target, path, edit=eid)
        app.bridge.emit("updated", nb=summary["id"], old=target, text=summary["text"], title=summary["title"], prev=summary["prev"])
        print(f"[更新] {summary['title']}：{summary['headline']}")
        info = app.notebook_info(summary["id"])
        return h.send_json({"ok": True, "id": summary["id"], "title": info["title"], "pages": info["pages"], "updated": summary["headline"],
                            "tabletOnline": app.bridge.tablet_online(), "remind": remind})
    nb = app.import_document(path, req.get("title"), as_new=bool(req.get("as_new")))
    app.bind_target(nb, str(req.get("sid") or ""), only_new=True)  # 新导入的本子发给导入它的对话
    info = app.notebook_info(nb)
    app.bridge.emit("show", nb=nb, page=0, title=info["title"])
    print(f"[导入] {path} → {nb[5:]}")
    h.send_json({"ok": True, "id": nb, "title": info["title"], "pages": info["pages"],
                 "tabletOnline": app.bridge.tablet_online()})


def flush_tablet(app):
    """平板上刚写的几笔可能还没存（停笔 1.2 秒后才存）：让它先存一下。"""
    if app.bridge.tablet_online():
        app.bridge.emit("flush")
        time.sleep(1.6)


def bridge_snapshot(h, q):
    b = h.app.bridge
    req = h.read_json()
    wait = float(req.get("wait") or 15)
    if not b.tablet_online():
        raise ValueError("平板上没有打开草稿纸页面。")
    h.app.ensure_shareable((b.where or {}).get("nb"), "平板上开着的这一本")
    rid = uuid.uuid4().hex[:10]
    slot = {"done": threading.Event(), "result": None, "error": None, "sid": str(req.get("sid") or "")}
    b.snapshots[rid] = slot
    b.emit("snapshot", rid=rid)
    ok = slot["done"].wait(timeout=wait)
    b.snapshots.pop(rid, None)
    if not ok:
        raise ValueError("平板没有及时回应（页面可能在后台或已锁屏）。")
    if slot["error"]:
        raise ValueError(slot["error"])
    sub_id, text = slot["result"]
    h.send_json({"id": sub_id, "text": text})


def bridge_scan(h, q):
    app, b = h.app, h.app.bridge
    req = h.read_json()
    if req.get("nb"):  # 写全了名字、被拦下时，scan 里那句带的书名是 Claude 自己写的
        nb = app.resolve_nb(req["nb"], claude=True)
    else:  # 没写：检测平板上开着的那本（没开着就是草稿本，名字是固定的），拦下时不说书名
        nb = (b.where or {}).get("nb")
        app.ensure_shareable(nb, "平板上开着的这一本")
        nb = nb or "scratch"
        app.ensure_shareable(nb, "草稿本")
    flush_tablet(app)
    pages_req = req.get("pages")
    if isinstance(pages_req, (int, float)):
        pages_req = [pages_req]
    region = req.get("region") if isinstance(req.get("region"), list) and len(req["region"]) == 2 else None
    sub_id, text, count = app.scan(nb, pages_req or None, bool(req.get("only_new")), region, target=req.get("sid"))
    h.send_json({"id": sub_id, "text": text, "pages": count, "nb": nb})


def bridge_confirm(h, q):
    """Claude 拿不准某处字迹：在平板上弹一张确认卡片（附那一块的截图和候选）。"""
    app, b = h.app, h.app.bridge
    req = h.read_json()
    sid = req.get("sid", "")
    raw = [x for x in (req.get("questions") or []) if isinstance(x, dict)][:6]
    if not raw:
        raise ValueError("questions 不能为空")
    loc = app.locate(sid, req.get("submission"), req.get("page"))
    app.ensure_shareable(loc.get("nb"), "这一页所在的那本")
    cid = uuid.uuid4().hex[:10]
    questions = []
    for k, x in enumerate(raw):
        bbox = None
        ref = str(x.get("anchor") or "").strip().lower()
        if ref.isdigit():
            ref = "g" + ref
        if ref in loc["groups"]:
            bbox = loc["groups"][ref]
        elif isinstance(x.get("box"), list) and len(x["box"]) == 4:
            cr = loc["crop"] or {"x0": 0, "y0": 0, "scale": 1}
            bx = [float(v) for v in x["box"]]
            bbox = [cr["x0"] + min(bx[0], bx[2]) / cr["scale"], cr["y0"] + min(bx[1], bx[3]) / cr["scale"],
                    cr["x0"] + max(bx[0], bx[2]) / cr["scale"], cr["y0"] + max(bx[1], bx[3]) / cr["scale"]]
        opts = [str(o).strip()[:80] for o in (x.get("options") or []) if str(o).strip()][:6]
        guess = str(x.get("guess") or "").strip()[:80]
        if guess and guess not in opts:
            opts.insert(0, guess)
        qq = {"question": str(x.get("question") or "").strip()[:200] or "这里写的是？", "guess": guess,
              "options": opts, "anchor": ref if ref in loc["groups"] else None, "bbox": bbox, "img": None}
        if bbox and fitz is not None:
            qq["img"] = str(app.confirm_snippet(cid, k, loc["nb"], loc["page"], bbox))
            qq["iw"], qq["ih"] = png_size(qq["img"])  # 平板按这个大小先留好位置，图载入时卡片不跳高
        questions.append(qq)
    label = b.sessions.get(sid, {}).get("label", "")
    # key：那一页的键。卡片可能挂很久（重启后还在）：这期间插页、删页、挪页，平板上的页号和晚到的回答都按它找那一页
    c = {"id": cid, "sid": sid, "label": label, "nb": loc["nb"], "page": loc["page"], "key": loc["key"],
         "where": app.page_label(loc["nb"], loc["page"]), "groups": [{"id": k, "bbox": v} for k, v in loc["groups"].items()],
         "questions": questions, "answers": None, "done": threading.Event(), "late": False, "t": time.time()}
    b.confirms[cid] = c
    for old in [k for k, v in b.confirms.items() if time.time() - v["t"] > 6 * 3600]:
        b.confirms.pop(old, None)
    b.emit("confirm", id=cid)
    b.persist()
    print(f"[确认] {len(questions)} 处 → {c['where']}")
    h.send_json({"id": cid, "tabletOnline": b.tablet_online(), "where": c["where"]})


def bridge_confirm_wait(h, q):
    """等用户回答确认卡片（每次最多挂 25 秒）。last=true：这次再等不到，之后的回答作为新消息送进对话。"""
    b = h.app.bridge
    req = h.read_json()
    c = b.confirms.get(req.get("id", ""))
    if not c:
        raise KeyError("没有这张确认卡片")
    # wait 给 0 就是不等（平板不在线时插件只来记一下「不等了」）；以前 0 被当成没给、白等 25 秒
    wait = CONFIRM_WAIT_S if req.get("wait") is None else float(req["wait"])
    c["done"].wait(timeout=max(0.0, min(CONFIRM_WAIT_S, wait)))
    if c["answers"] is None:
        if req.get("last"):
            c["late"] = True
            b.persist()
        return h.send_json({"pending": True, "tabletOnline": b.tablet_online()})
    h.send_json({"answers": c["answers"], "text": prompt.build_confirm_answer(c, c["answers"])})


def bridge_ask(h, q):
    """Claude 用 ink_ask 发一张问话卡片到平板：question（0–4 个短选项，handwrite 为 false 时不能手写）或 result（纸上放不下的结果）。
    平板不在线就不发，返回 {offline: true}：不排队到以后，Claude 改在对话里问。"""
    app = h.app
    req = h.read_json()
    sid = str(req.get("sid") or "")
    question, result = str(req.get("question") or "").strip(), str(req.get("result") or "").strip()
    if bool(question) == bool(result):
        raise ValueError("question 和 result 要给一个、只给一个：问问题和给结果分两张卡片")
    opts = req.get("options") or []
    if not isinstance(opts, list):
        raise ValueError("options 是几个短选项的列表")
    card = app.post_card(sid, "result" if result else "question", question=question, options=opts,
                         write=req.get("handwrite") is not False, text=result)
    if card is None:
        return h.send_json({"offline": True})
    print(f"[问话] {card['id']} → 平板：" + (f"结果（{len(card['text'])} 字）" if result else f"「{card['question'][:30]}」"))
    h.send_json({"id": card["id"], "tabletOnline": True})


def bridge_ask_wait(h, q):
    """等用户回答问话卡片（每次最多挂 25 秒）：答了返回 {answer, text}，没答返回 {pending: true}。
    last=true：这次再等不到就不等了，之后的回答作为一条新消息送进对话。"""
    app = h.app
    req = h.read_json()
    cid = str(req.get("id") or "")
    wait = ASK_WAIT_S if req.get("wait") is None else float(req["wait"])
    ans = app.wait_card(cid, min(ASK_WAIT_S, wait), last=bool(req.get("last")))
    if ans is None:
        return h.send_json({"pending": True, "tabletOnline": app.bridge.tablet_online()})
    h.send_json({"answer": ans, "text": prompt.build_ask_answer(app.bridge.asks[cid], ans)})


def bridge_edit(h, q):
    """Claude 改文件之前（ink_edit）：带 mode（overwrite / saveas）就直接办（覆盖前留底，或另存一份）；没带就在平板顶上问
    覆盖还是另存，返回 {ask: 卡片编号}，插件再连着调 /bridge/edit-wait 等；平板不在线返回 {offline, text}。"""
    app, req = h.app, h.read_json()
    sid, path, mode = str(req.get("sid") or ""), req.get("path"), req.get("mode")
    if mode in (None, ""):
        return h.send_json(app.ask_edit(sid, path))
    h.send_json(app.begin_edit(sid, path, str(mode)))


def bridge_edit_wait(h, q):
    """等「覆盖还是另存」卡片的回答（每次最多挂 25 秒）：选了就办好，返回该改哪个文件；没选返回 {pending, text}。
    last=true：这次再等不到就不等了，之后的回答作为一条新消息送进对话。"""
    app, req = h.app, h.read_json()
    wait = ASK_WAIT_S if req.get("wait") is None else float(req["wait"])
    h.send_json(app.edit_wait(str(req.get("id") or ""), min(ASK_WAIT_S, wait), last=bool(req.get("last"))))


def api_book_undo_info(h, q):
    """平板上点「撤回」：先取上一次修改的情况（确认那一句按它写；文件那之后又改过的，确认时要说明）。"""
    h.send_json(h.app.undo_info(q.get("nb", "")))


def api_book_undo(h, q):
    """平板上确认了撤回：{nb, id（确认时看到的那一次）, changed（确认时说没说「又改过」）}。"""
    app, req = h.app, h.read_json()
    changed = req.get("changed") if isinstance(req.get("changed"), bool) else None
    h.send_json(app.undo_book(str(req.get("nb") or ""), str(req.get("id") or "") or None, changed))


def bridge_offer(h, q):
    app = h.app
    req = h.read_json()
    sid = req.get("sid", "")
    files = [f for f in (req.get("files") or []) if isinstance(f, dict)][:30]
    label = app.bridge.sessions.get(sid, {}).get("label", "")
    added = app.add_offers(sid, label, files)
    if added:
        app.bridge.emit("offers", label=label, names=[o["name"] for o in added])
        print(f"[新文件] {label}：{'、'.join(o['name'] for o in added)}")
    h.send_json({"ok": True, "added": len(added), "tabletOnline": app.bridge.tablet_online()})


def bridge_ping(h, q):
    h.send_json({"ok": True, "app": "inkthink", "version": 2})


API = {
    ("GET", "/api/config"): api_config,
    ("GET", "/api/notebooks"): api_notebooks,
    ("GET", "/api/notebook"): api_notebook,
    ("POST", "/api/notebook/addpage"): api_add_page,
    ("GET", "/api/page"): api_get_page,
    ("PUT", "/api/page"): api_put_page,
    ("GET", "/api/pending"): api_pending,
    ("GET", "/api/bookpage"): api_book_page,
    ("GET", "/api/boardbg"): api_board_bg,
    ("POST", "/api/upload"): api_upload,
    ("GET", "/api/sessions"): api_sessions,
    ("POST", "/api/target"): api_target,
    ("POST", "/api/send"): api_send,
    ("GET", "/api/events"): api_events,
    ("POST", "/api/snapshot"): api_snapshot,
    ("POST", "/api/where"): api_where,
    ("POST", "/api/send-all"): api_send_all,
    ("GET", "/api/new-pages"): api_new_pages,
    ("GET", "/api/figure"): api_figure,
    ("GET", "/api/confirms"): api_confirms,
    ("GET", "/api/confirm-img"): api_confirm_img,
    ("POST", "/api/confirm-answer"): api_confirm_answer,
    ("GET", "/api/asks"): api_asks,
    ("POST", "/api/ask-answer"): api_ask_answer,
    ("POST", "/api/ask-ignore"): api_ask_ignore,
    ("POST", "/api/cards/ignore-all"): api_cards_ignore_all,
    ("POST", "/api/book-update"): api_book_update,
    ("POST", "/api/book/save-pdf"): api_save_pdf,
    ("GET", "/api/book/undo"): api_book_undo_info,
    ("POST", "/api/book/undo"): api_book_undo,
    ("POST", "/api/pair"): api_pair,
    ("POST", "/api/page/insert"): api_page_insert,
    ("POST", "/api/page/delete"): api_page_delete,
    ("GET", "/api/page/hidden"): api_page_hidden,
    ("POST", "/api/page/restore"): api_page_restore,
    ("POST", "/api/page/move"): api_page_move,
    ("GET", "/api/thumb"): api_thumb,
    ("POST", "/api/notebook/new"): api_notebook_new,
    ("POST", "/api/notebook/delete"): api_notebook_delete,
    ("POST", "/api/notebook/setting"): api_notebook_setting,
    ("POST", "/api/notebook/target"): api_notebook_target,
    ("POST", "/api/notebook/rename"): api_notebook_rename,
    ("GET", "/api/folders"): api_folders,
    ("POST", "/api/folders/new"): api_folder_new,
    ("POST", "/api/folders/rename"): api_folder_rename,
    ("POST", "/api/folders/delete"): api_folder_delete,
    ("POST", "/api/folders/move"): api_folder_move,
    ("GET", "/api/offers"): api_offers,
    ("GET", "/api/files"): api_files,
    ("POST", "/api/files/import"): api_files_import,
    ("GET", "/api/zotero"): api_zotero,
    ("POST", "/api/zotero/import"): api_zotero_import,
    ("POST", "/api/offer-accept"): api_offer_accept,
    ("POST", "/api/offer-dismiss"): api_offer_dismiss,
}

BRIDGE = {
    ("GET", "/bridge/ping"): bridge_ping,
    ("POST", "/bridge/hello"): bridge_hello,
    ("GET", "/bridge/status"): bridge_status,
    ("GET", "/bridge/poll"): bridge_poll,
    ("POST", "/bridge/active"): bridge_active,
    ("POST", "/bridge/ack"): bridge_ack,
    ("POST", "/bridge/progress"): bridge_progress,
    ("GET", "/bridge/devices"): bridge_devices,
    ("POST", "/bridge/devices/revoke"): bridge_device_revoke,
    ("POST", "/bridge/code/rotate"): bridge_code_rotate,
    ("POST", "/bridge/stop"): bridge_stop,
    ("POST", "/bridge/claim"): bridge_claim,
    ("POST", "/bridge/bye"): bridge_bye,
    ("POST", "/bridge/reply"): bridge_reply,
    ("POST", "/bridge/show"): bridge_show,
    ("POST", "/bridge/snapshot"): bridge_snapshot,
    ("POST", "/bridge/import"): bridge_import,
    ("POST", "/bridge/scan"): bridge_scan,
    ("POST", "/bridge/confirm"): bridge_confirm,
    ("POST", "/bridge/confirm-wait"): bridge_confirm_wait,
    ("POST", "/bridge/ask"): bridge_ask,
    ("POST", "/bridge/ask-wait"): bridge_ask_wait,
    ("POST", "/bridge/edit"): bridge_edit,
    ("POST", "/bridge/edit-wait"): bridge_edit_wait,
    ("POST", "/bridge/offer"): bridge_offer,
}


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = os.name != "nt"  # Windows 上允许复用会让两个实例抢同一个端口


def no_power_throttling():
    """Windows 11 会给没有窗口的后台进程开「节能降速」（EcoQoS）：本机 PP-OCR 一次发送从 0.4 秒拖到 4 秒，
    PDF 渲染也跟着慢（2026-11-02 实测）。服务一直在后台跑，所以启动时说明不要降速。别的系统、老 Windows 上什么也不做。"""
    if sys.platform != "win32":
        return False
    try:
        import ctypes
        from ctypes import wintypes

        class State(ctypes.Structure):
            _fields_ = [("Version", wintypes.ULONG), ("ControlMask", wintypes.ULONG), ("StateMask", wintypes.ULONG)]

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.SetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        s = State(1, 1, 0)  # 版本 1；管「执行速度」这一项；状态 0 = 不降速
        return bool(k32.SetProcessInformation(k32.GetCurrentProcess(), 4, ctypes.byref(s), ctypes.sizeof(s)))  # 4 = ProcessPowerThrottling
    except (OSError, AttributeError):
        return False


def main():
    no_power_throttling()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", line_buffering=True)
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="InkThink 中转服务")
    ap.add_argument("--host")
    ap.add_argument("--port", type=int)
    ap.add_argument("--open", action="store_true", help="启动后在电脑浏览器打开二维码页")
    ap.add_argument("--config", help="配置文件路径（默认 config.json）")
    ap.add_argument("--data", help="数据目录（默认 data/）")
    ap.add_argument("--books", help="PDF 书目录（默认 books/）")
    ap.add_argument("--log", help="输出追加到这个文件（后台启动时用；没有控制台）")
    args = ap.parse_args()
    if args.log:
        sys.stdout = sys.stderr = open(args.log, "a", encoding="utf-8", buffering=1)
    # 程序在 PyMuPDF 等底层代码里崩溃时，也把出错位置写进日志（不然进程直接消失，什么也查不到）
    faulthandler.enable(file=sys.stderr)

    app = App(args)
    Handler.app = app
    try:
        httpd = Server((app.host, app.port), Handler)
    except OSError as e:
        sys.exit(f"端口 {app.port} 用不了（{e}）。是不是已经开着一个了？")

    print(f"InkThink 中转服务已启动 {datetime.now().isoformat(timespec='seconds')} pid={os.getpid()}"
          "（不调用模型 API；由 Claude Code 里的 inkpad 插件接入对话）")
    atexit.register(lambda: print(f"服务退出 {datetime.now().isoformat(timespec='seconds')}", flush=True))
    if fitz is None:
        print("  （没装 PyMuPDF，只能用草稿本，不能打开 PDF）")
    if app.host in ("0.0.0.0", ""):
        print("平板浏览器打开（和电脑连同一个 Wi-Fi）：")
        for n, ip in enumerate(lan_ips()):
            print(f"  http://{ip}:{app.port}/?k={app.code}" + ("" if n == 0 else "   ← 上面那个打不开再试"))
        if app.stable_url():
            print(f"  {app.stable_url()}   ← 固定地址，IP 变了也能用（有的网络不支持）")
    print(f"电脑上看二维码：http://127.0.0.1:{app.port}/qr")
    print(f"数据：{app.data}    PDF 书：{app.books}")
    backup.start_loop(app.data, app.books)  # 每天一份备份，放 data/backups/daily/
    threading.Thread(target=ocr.warm, daemon=True).start()  # 本机 PP-OCR 先把模型读进来，第一次发送不用等
    if app.paper_dir:
        print(f"原稿、往来稿导出到：{app.paper_dir}")
        threading.Thread(target=app.export_stale_papers, daemon=True).start()
    (app.data / "stopped.flag").unlink(missing_ok=True)  # 这次是有意启动的
    print("按 Ctrl+C 停止。")
    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(f"http://127.0.0.1:{app.port}/qr")).start()
    try:
        httpd.serve_forever()
        print("已停止。")
    except KeyboardInterrupt:
        print("已停止。")


if __name__ == "__main__":
    main()

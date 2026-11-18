"""草稿纸（ThinkPaper）的 MCP 小程序：让 Claude Code 以外的命令行 AI（先针对 Codex CLI、Gemini CLI）把草稿纸接成自己的工具。

2026-11-17「适配别的 AI 的第一步」（《产品定义》第 2 节「本子、对话、AI 的关系」最后一条；用户不在时暂定）。
形态不变：它是某个 AI 对话的另一种输入方式，带着那个对话的上下文和项目文件，不直连模型接口。

怎么工作：AI 的命令行把它当成 stdio 上的 MCP 服务起起来（JSON-RPC 2.0，一行一条，UTF-8；日志只写 stderr）。
它向草稿纸服务（server.py）的 /bridge/* 登记这个对话（和 Claude Code 插件 inkpad 走同一套接口，插件那条路一个字不改），
每 1.5 秒报到一次、取平板交来的投递（带 lease，交给 AI 以后才 ack，和插件一样不丢也不重复给）。
能叫醒的 Codex 对话由一条固定消息提醒来取；别的对话调 ink_wait 等。页和图都只经工具结果交给 AI。
写回纸上等工具和插件注册的同名（ink_reply、ink_show……），参数、说明、调 /bridge/* 前后做的事照插件来。

只用 Python 自带的库（3.10 能跑），不加依赖。用法见 README.md 的「接别的 AI（试验）」：
    python mcp_server.py [--url http://127.0.0.1:8765] [--ai Codex] [--label 文件夹名] [--cwd 文件夹] [--wait 45]
叫醒用 --wake auto|off、--codex 路径；也可以用环境变量 INKPAD_WAKE、INKPAD_CODEX、INKPAD_URL、INKPAD_AI、INKPAD_WAIT 给。

不打印、不外传：服务登记时回的访问码、带访问码的地址、二维码这些一概不碰（只取 submissionsDir）。
"""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import prompt  # noqa: E402  固定规则（prompt.protocol()）：和插件放进 Claude 系统提示的是同一份

NAME = "inkpad"
VERSION = "0.1.0"
# 认识的协议版本，新的在前（2026-07-28 那一版去掉了 initialize 握手，这里不支持它；客户端报别的版本时回 2025-11-25）
PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
POLL_S = 1.5        # 和插件一样每 1.5 秒取一次：服务 20 秒（SESSION_ALIVE_S）没见到就当对话已关
RETRY_S = 3.0       # 连不上服务时，多久再试一次登记
WAIT_DEFAULT = 45   # ink_wait 默认等多久（秒）：比老版本 Codex 默认的 60 秒工具时限短
WAIT_MAX = 290      # 最多等多久：比 Codex 新版默认的 300 秒、Gemini CLI 默认的 600 秒都短
PROBE_WAIT_S = 3
QUEUE_TIMEOUT_S = 30
ROUND_IDLE_S = 12
THREAD_ID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
WAKE_MESSAGE = ("【草稿纸】用户在平板上交来了新的一页或卡片回答。调 ink_wait 取，会马上返回，图附在结果里。"
                "照草稿纸的规则看，需要写回时用 ink_reply。取完手边的、回完就结束这一轮，不用再调 ink_wait 等。")
CONNECTED = ("已接上草稿纸。用户在平板上点「AI」交来的页，会用一条以【草稿纸】开头的新消息叫你调 ink_wait 来取。"
             "现在不用等，这一轮可以结束。")
IMG_MAX = 5 * 1024 * 1024      # 一张图超过这么大不附（只给路径）
IMG_TOTAL = 15 * 1024 * 1024   # 一次结果里附的图加起来最多这么大
IMG_COUNT = 12                 # 一次结果里最多附几张图
IMG_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}

# 卡片留在平板上时，根据这个对话能不能叫醒，补一句怎么收回答。
CONFIRM_LATE = "等了约 45 秒，用户暂时没有回答，确认卡片还留在平板上。"
ASK_WAITS = [25, 25, 25, 15]
ASK_PENDING = "用户还没答，卡片留在平板上。不要替用户选，也不要按哪个选项先做下去。"
EDIT_PENDING = "用户还没选，卡片留在平板顶上。先别动这个文件，收到选择后按那里说的带上 mode 再调一次 ink_edit。"
CARD_WAKE = "用户答了会有一条新消息叫你调 ink_wait 来取，这一轮停在这里。"
CONFIRM_GUESS = "先按你的理解继续，并在回复里标明哪处是推测的。"  # 确认卡片和问话卡片不一样：没等到不停下（插件的 CONFIRM_LATE 也是这样）
CONFIRM_WAKE = "用户之后答了，会有一条新消息叫你调 ink_wait 来取。"
CARD_WAIT = "调 ink_wait 收之后的回答，照结果说的做。"
OFFLINE = ("草稿纸服务没有运行（连不上）。请用户在电脑上启动它：运行草稿纸所在文件夹里 inkthink 文件夹中的 start.bat。"
           "启动以后这里会自己连上，到时再调一次就行；在那之前不用反复调。")
NOTHING_YET = "还没有新的投递（等了 {n} 秒）。要接着等就再调一次 ink_wait。用户在对话里说了话，先回应用户。"
CRASHED = "草稿纸的 MCP 小程序出错，没有完成这次操作。"
LATE = "late-"  # 自己存下的迟到回答的编号开头（Link.stash）：不是服务给的投递，不向服务确认
LATE_HEAD = "【草稿纸·回答】刚才等卡片回答的那次调用没把回答交到你手里。用户在平板上是这样答的：\n"

# 给 AI 的说明（initialize 的 instructions 开头；后面接固定规则）
INTRO = (
    "这是「草稿纸」（ThinkPaper）的一组工具：用户在平板上的草稿纸里用笔写、画、圈，点「AI」把一页交给你这个对话，"
    "你把回答用蓝字写回纸上。用户说「接上草稿纸」「等我在草稿纸上写的」，或收到【草稿纸】叫你来取的消息时，调 ink_wait。"
    "交来的页和图在结果里，照下面的规则看，用 ink_reply 写回纸上。结果会告诉你还有没有要取的、这一轮能结束还是要再调一次接着等。"
    "下面规则里说的「消息」就是 ink_wait（或 ink_snapshot、ink_scan）返回的结果。"
)
RULES_HEAD = "（这是这个对话第一次收到草稿纸交来的东西：先附上草稿纸的固定规则，之后不再附。）\n"
RULES_SEP = "\n\n———— 以下是这次交来的 ————\n\n"


def log(msg):
    """日志只写 stderr（stdout 只能有 MCP 消息）。不写访问码、地址、配置里的东西。"""
    try:
        sys.stderr.buffer.write(f"[inkpad-mcp] {msg}\n".encode("utf-8", "replace"))
        sys.stderr.buffer.flush()
    except (OSError, ValueError, AttributeError):
        pass


# ---------------------------------------------------------------- 给 AI 的文字

def for_ai(text, attached=False):
    """服务拼的消息、固定规则里写的是 Claude Code 的说法：工具名带 mcp__inkpad__ 前缀、「用 Read 看图」。经这里出去的去掉前缀；
    图附在结果里的，「用 Read 看」那几处改成说图附在后面（能读本机文件的照样可以按路径读）；「作为一条新消息送来」改成经 ink_wait 收。
    prompt.py 给 Claude 的原文不动。"""
    t = str(text or "").replace("mcp__inkpad__", "")
    if attached:
        t = re.sub(r"先用 ?Read ?看这(\S{1,3})张图：",
                   r"先看这\1张图（附在这条结果后面，次序和下面列的一样；能读本机文件的也可以按路径读）：", t)
        t = t.replace("每页一张图，用 Read 逐页看。",
                      "每页一张图，逐页看（各页的图按页的先后附在这条结果后面；能读本机文件的也可以按路径读）。")
        t = t.replace("用 Read 看这张图", "看这张图（附在这条结果后面）")
    t = t.replace("先用 Read 看消息里列的图", "先看消息里列的图（ink_wait 等工具的结果里附着这些图，也写着路径）")
    t = re.sub(r"作为一条新消息（(【草稿纸[^】]*】)）送来", r"由 ink_wait 交给你（以\1开头，照工具结果说的收取）", t)
    return re.sub(r"用 ?Read ?", "", t)


def rules():
    """固定规则（和插件放进系统提示的同一份），工具名去掉前缀。"""
    return for_ai(prompt.protocol())


def instructions():
    return INTRO + "\n\n" + rules()


def guess_ai(client_name):
    """客户端在 initialize 里报的名字 → 这个对话是哪个 AI。"""
    n = " ".join(str(client_name or "").split())
    low = n.lower()
    for key, ai in (("codex", "Codex"), ("gemini", "Gemini"), ("claude", "Claude")):
        if key in low:
            return ai
    return n[:40] or "AI"


ABS_PATH = re.compile(r"^([a-zA-Z]:[\\/]|[\\/]{2}|/)")


# ---------------------------------------------------------------- 和草稿纸服务说话

class Reply:
    def __init__(self, ok, data=None, error="", offline=False):
        self.ok, self.data, self.error, self.offline = ok, data or {}, error, offline


class Offline(Exception):
    """连不上草稿纸服务。"""


class ToolError(Exception):
    """这次工具调用没办成：话照原样给 AI（结果里 isError）。"""


class Bridge:
    """/bridge/* 的 HTTP 客户端。不走系统代理（Windows 上 urllib 会读注册表里的代理，本机地址也可能被转出去）。"""

    def __init__(self, url):
        self.base = str(url or "").rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, method, path, body=None, timeout=30.0):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with self.opener.open(req, timeout=timeout) as r:
                return Reply(True, parse_json(r.read()))
        except urllib.error.HTTPError as e:
            try:
                d = parse_json(e.read())
            except OSError:
                d = {}
            return Reply(False, d, str(d.get("error") or f"HTTP {e.code}"))
        except (urllib.error.URLError, OSError, ValueError) as e:  # 连不上、被拒、超时
            return Reply(False, {}, str(getattr(e, "reason", e)), offline=True)


def parse_json(raw):
    try:
        d = json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def find_codex(path):
    if path:
        return os.path.abspath(path) if os.path.isfile(path) else None
    if os.name == "nt":
        # 只在 PATH 指定的文件夹找，不顺带去这个对话的项目文件夹找。
        folders = [Path(folder.strip('"')) for folder in os.get_exec_path() if folder]
        for name in ("codex.cmd", "codex.exe", "codex.bat", "codex.com"):
            for folder in folders:
                candidate = folder / name
                if candidate.is_file():
                    return str(candidate.absolute())
        return None
    return shutil.which("codex")


def run_codex(path, args, *, version=False):
    """参数只有固定文字和验过的 UUID。Windows 批处理经 Unicode 命令行收参，不按终端代码页转码。"""
    command = [path, *args]
    env = None
    if os.name == "nt" and path.lower().endswith((".cmd", ".bat")):
        cmd = os.environ.get("COMSPEC") or os.path.join(os.environ.get("SystemRoot") or r"C:\Windows", "System32", "cmd.exe")
        # 路径单独放进环境变量，避免路径里的 % 被当作变量名。/d 不读启动命令，/v:off 保留感叹号。
        env = dict(os.environ, INKPAD_CODEX_CMD=path)
        words = " ".join(f'"{a}"' for a in args)
        command = f'"{cmd}" /d /v:off /s /c ""%INKPAD_CODEX_CMD%" {words}"'
    return subprocess.run(command, env=env, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          stdout=subprocess.PIPE if version else subprocess.DEVNULL,
                          timeout=QUEUE_TIMEOUT_S,
                          creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)


class Link:
    """这个对话和草稿纸服务的连接：登记、每 1.5 秒报到并取投递，取到的先放在手边，ink_wait 来要时交给 AI 再 ack。

    lease / ack 和插件（register.tsx 的 tick、deliver）一样：/bridge/poll 带 ack=1 取，服务先不删、30 秒没确认就再给一次；
    交给 AI 之后才 /bridge/ack。服务再给一次已经在手边的（还没交）就不管；交过的（ack 没成，比如服务正好重启）只补一次 ack，不再交。"""

    def __init__(self, bridge, sid, label, cwd, ai, wake="auto", codex=""):
        self.bridge, self.sid, self.label, self.cwd, self.ai = bridge, sid, label, cwd, ai
        self.started = int(time.time() * 1000)  # 这个对话（这个进程）什么时候开的：平板上选对话的单子里写「今天 14:05 开的」
        self.cond = threading.Condition()
        self.online = None  # 还没试过：第一次连上或连不上都记一笔日志
        self.registered = False
        self.subdir = ""      # 服务的 submissions 文件夹：只从这里面取图附给 AI
        self.inbox = []       # [(投递编号, 文字)]：取到了、还没交给 AI
        self.held = {}        # 投递编号 -> (编号, 文字)：ink_wait 拿走了、结果还没写给客户端（写出去了才算交到，见 commit / release）
        self.handed = set()   # 交给过 AI 的投递编号
        self.current = ""     # 最近交给 AI 的那一次（报进度：在看、在改文件、这一轮结束）
        self.waiters = 0      # 正在 ink_wait 里等着的有几个
        self.wake, self.codex = wake, codex
        self.thread_id, self.turn_trigger = "", ""
        self.probe_started = False
        self.codex_version = None  # None 还没查到结果，空元组表示已经查过、不能用
        self.deferred = False   # 查版本期间收到了投递，查完再看是否还要叫
        self.wake_pending = None  # 最近一次叫醒；AI 来调任一工具就清掉
        self.active_calls = set()
        self.done_after = None  # 当前页已写回，最后一个草稿纸工具结束后开始计时
        self.stop = threading.Event()
        self.thread = None
        self.last_try = 0.0
        self.lock = threading.Lock()
        self.settling = threading.Lock()  # 一页的结果写给客户端到向服务确认完这一段（见 McpServer.run_tool、round_over）

    def wants_wake(self):
        return self.wake == "auto" and bool(self.thread_id) and self.turn_trigger != "exec"

    def can_wake(self):
        return self.wants_wake() and bool(self.codex_version)

    def may_wake(self):
        """会话和参数允许叫醒，版本可能还在查。"""
        return self.wants_wake() and self.codex_version != ()

    def tool_started(self, call, meta):
        """按 tools/call 到达的顺序认会话，不能等工具线程争到时间片才记。"""
        meta = meta if isinstance(meta, dict) else {}
        thread_id = meta.get("threadId")
        turn = meta.get("x-codex-turn-metadata")
        with self.cond:
            old = self.thread_id
            self.thread_id = thread_id if isinstance(thread_id, str) and THREAD_ID.fullmatch(thread_id) else ""
            self.turn_trigger = turn.get("turn_trigger") if isinstance(turn, dict) else None
            if old != self.thread_id or not self.wants_wake():
                self.deferred = False
                self.done_after = None
            self.active_calls.add(call)
            self.wake_pending = None
            if self.wants_wake() and not self.probe_started:
                self.probe_started = True
                threading.Thread(target=self.probe_codex, name="inkpad-version", daemon=True).start()
            self.cond.notify_all()

    def tool_finished(self, call):
        with self.cond:
            self.active_calls.discard(call)
            if self.done_after is not None:
                self.done_after = time.monotonic() + ROUND_IDLE_S

    def probe_codex(self):
        version = ()
        try:
            path = find_codex(self.codex)
            if path:
                r = run_codex(path, ["--version"], version=True)
                m = re.match(rb"codex-cli\s+(\d+)\.(\d+)\.(\d+)(?![\d.])", r.stdout.strip())  # 后面带 -alpha.1 这类尾巴的也认
                version = tuple(map(int, m.groups())) if m and r.returncode == 0 else ()
                if version < (0, 149, 0):
                    version = ()
                    log("Codex 版本太旧或没认出来，这次用 ink_wait 等")
            else:
                log("没找到 Codex，这次用 ink_wait 等")
        except Exception:  # noqa: BLE001 - 查不到就不叫醒，不能停在「还在查」
            version = ()
            log("没能查到 Codex 版本，这次用 ink_wait 等")
        with self.cond:
            self.codex_version = version
            if version:
                self.codex = path
            else:
                self.done_after = None
            if self.deferred and self.inbox:
                self.wake_if_idle()
            self.deferred = False
            self.cond.notify_all()

    def wake_if_idle(self):
        """在 cond 内决定，一条新投递或迟到回答只走到这里一次。排消息本身交给另一个线程。"""
        if self.waiters or self.wake_pending or not self.wants_wake() or self.stop.is_set():
            return
        if self.codex_version is None:
            self.deferred = True
        elif self.can_wake():
            attempt = self.wake_pending = object()
            threading.Thread(target=self.queue_message, args=(self.thread_id, attempt),
                             name="inkpad-queue", daemon=True).start()

    def queue_message(self, thread_id, attempt):
        args = ["queue", "--thread=" + thread_id, "--message=" + WAKE_MESSAGE]
        if self.codex_version >= (0, 166, 0):
            args.append("--resume")
        try:
            result = run_codex(self.codex, args)
            if result.returncode == 0:
                return  # 排进对话只算叫过；只有 ink_wait 的结果写出后才确认投递。
            log(f"叫醒消息没排进去（退出码 {result.returncode}），投递留着")
        except subprocess.TimeoutExpired:
            log("排叫醒消息超时，投递留着")
        except Exception:  # noqa: BLE001 - 这一次没叫成，投递留着
            log("没能运行 Codex 排叫醒消息，投递留着")
        with self.cond:
            if not os.path.isfile(self.codex):
                self.codex_version = ()
                log("已找不到 Codex，这次用 ink_wait 等")
            if self.wake_pending is attempt:
                self.wake_pending = None

    # -- 登记、报到
    def start(self):
        with self.lock:
            if self.thread:
                return
            self.thread = threading.Thread(target=self.loop, name="inkpad-poll", daemon=True)
            self.thread.start()

    def set_online(self, on):
        with self.lock:  # 报到的线程和工具调用可能同时发现：日志只记一笔
            changed, self.online = on != self.online, on
        if changed:
            log("已连上草稿纸服务" if on else "连不上草稿纸服务（服务没有运行？），之后每几秒再试一次")

    def hello(self):
        if self.stop.is_set():  # 已经说过 bye：报到的线程这时才回来的那次（服务回「不认识」）不再登记回去
            return False
        self.last_try = time.time()
        r = self.bridge.call("POST", "/bridge/hello", {"sid": self.sid, "label": self.label, "cwd": self.cwd,
                                                         "ai": self.ai, "started": self.started}, timeout=10)
        if r.ok:
            # 回话里还有访问码、地址、二维码：一概不碰，只取投递的文件夹
            self.subdir = str(r.data.get("submissionsDir") or "")
            self.registered = True
            self.set_online(True)
        elif r.offline:
            self.set_online(False)
        else:
            log("登记没成功：" + r.error)
        return r.ok

    def ensure(self):
        """工具调用前：还没连上就马上试一次。连不上抛 Offline。"""
        if not (self.registered and self.online) and not self.hello():
            raise Offline()

    def loop(self):
        while not self.stop.is_set():
            try:
                if self.done_after is not None:
                    self.round_over(if_idle=True)
                if not (self.registered and self.online):
                    if time.time() - self.last_try >= RETRY_S:
                        self.hello()
                else:
                    self.tick()
            except Exception:  # noqa: BLE001 - 报到不能停：记一笔接着来
                log("报到时出错：" + traceback.format_exc().strip().splitlines()[-1])
            self.stop.wait(POLL_S)

    def tick(self):
        r = self.bridge.call("GET", "/bridge/poll?sid=" + urllib.parse.quote(self.sid) + "&ack=1", timeout=15)
        if r.offline:
            self.set_online(False)
            return
        if not r.ok:
            return
        if r.data.get("unknown"):  # 服务重启过：重新登记
            self.registered = False
            self.hello()
            return
        sub = r.data.get("submission")
        if not isinstance(sub, dict) or not sub.get("id"):
            return
        sub_id = str(sub["id"])
        with self.cond:
            again = sub_id in self.handed
            if sub_id in self.held or any(x[0] == sub_id for x in self.inbox):
                return
            idle = self.waiters == 0
        if again:  # 交给过 AI、服务没收到确认又给了一次：补一次确认，不再交
            self.ack(sub_id)
            return
        # 只有报到线程会从服务取页。先报排队，再把页交给工具，避免平板先收到「在看」又退回「排队中」。
        if idle:
            self.progress(sub_id, "queued")
        with self.cond:
            self.inbox.append((sub_id, str(sub.get("text") or "")))
            self.wake_if_idle()
            self.cond.notify_all()
        log("收到草稿纸交来的一页")

    def ack(self, sub_id):
        return self.bridge.call("POST", "/bridge/ack", {"sid": self.sid, "id": sub_id}, timeout=10)

    def progress(self, sub_id, stage):
        if sub_id:
            self.bridge.call("POST", "/bridge/progress", {"sid": self.sid, "id": sub_id, "stage": stage}, timeout=10)

    def working(self):
        """改文件、导入：这一轮在做重活（插件按 Write、Edit、ink_import、ink_edit 这些工具报）。"""
        self.progress(self.current, "working")

    def round_over(self, if_idle=False):
        """进程退出、又来等下一页，或已经写回且安静了一会儿：让平板按钮变回原样。"""
        with self.settling, self.cond:
            if if_idle and (self.active_calls or not self.can_wake() or self.done_after is None or time.monotonic() < self.done_after):
                return
            cur, self.current, self.done_after = self.current, "", None
        if cur:
            self.progress(cur, "done")

    def take(self, timeout, cancel):
        """返回（拿在手里的投递或 None，这次能否叫醒）。手边已有投递时直接取，否则最多等 3 秒定下这次的收法。
        拿到的这一条还不算交到：结果写给了客户端才 commit（向服务确认）；客户端取消了、没写出去就 release（放回去，下次 ink_wait 再给）。
        （2026-11-18 审查后改：原来一拿到就确认，这时取消或写不出去，服务那边已经删了，这一页就丢了。）"""
        deadline = time.monotonic() + timeout
        with self.cond:
            self.waiters += 1
            try:
                if self.codex_version is None and self.wants_wake() and not self.inbox:
                    self.cond.wait_for(lambda: self.inbox or self.codex_version is not None or not self.wants_wake() or cancel.is_set(),
                                       min(timeout, PROBE_WAIT_S))
                wake = self.can_wake()
                while True:
                    if cancel.is_set():
                        return None, False
                    if self.inbox:
                        item = self.inbox.pop(0)
                        self.held[item[0]] = item
                        return item, wake
                    if wake:
                        return None, True
                    left = deadline - time.monotonic()
                    if left <= 0:
                        return None, False
                    self.cond.wait(min(left, 0.5))
            finally:
                self.waiters -= 1

    def commit(self, sub_id):
        """这一条的结果已经写给客户端了：记成交过，向服务确认。"""
        with self.cond:
            if self.held.pop(sub_id, None) is None:
                return
            self.handed.add(sub_id)
        # commit 在 settling 内。并行的两次 ink_wait 也按实际交到的顺序收尾。
        if self.current:
            self.progress(self.current, "done")
        self.current, self.done_after = "", None
        if sub_id.startswith(LATE):  # 自己存下的迟到回答（stash）：服务那边没有这一条，不用确认
            return
        self.ack(sub_id)  # 没成（服务正好停了）：编号记在 handed 里，服务以后再给时只补确认
        self.current = sub_id
        self.progress(sub_id, "reading")  # 图就附在结果里：交出去就算在看了

    def release(self, sub_id):
        """这一条没交到（客户端取消了这次调用、结果写不出去、附图时出了错）：放回最前面，下次 ink_wait 再给。"""
        with self.cond:
            item = self.held.pop(sub_id, None)
            if item is not None:
                self.inbox.insert(0, item)
                self.cond.notify_all()

    def stash(self, text):
        """卡片上的回答服务已经给了，可是那次调用被客户端取消了、话没送到 AI：存下来，下次 ink_wait 交给它。"""
        with self.cond:
            self.inbox.append((LATE + uuid.uuid4().hex[:8], LATE_HEAD + text))
            self.wake_if_idle()
            self.cond.notify_all()

    def bye(self):
        self.stop.set()
        self.round_over()
        if self.registered:
            self.bridge.call("POST", "/bridge/bye", {"sid": self.sid}, timeout=5)


# ---------------------------------------------------------------- 工具

def obj(props, required=None):
    out = {"type": "object", "properties": props}
    if required:
        out["required"] = required
    return out


S = {"type": "string"}
N = {"type": "number"}
B = {"type": "boolean"}


def d(schema, text):
    return dict(schema, description=text)


REPLY_TYPES = ["write", "note", "question", "underline", "circle", "arrow", "read", "suggest", "tick", "cross", "strike", "insert",
               "wavy", "highlight", "brace", "number", "label", "node", "link", "group", "sketch", "figure", "formula", "result"]

# 说明照插件（register.tsx）的同名工具写，「Claude」换成不带厂商名的说法，提到别的工具用不带前缀的名字
TOOLS = [
    {
        "name": "ink_wait",
        "description": (
            "等用户在平板的草稿纸上点「AI」交来的下一页（也可能是别的草稿纸消息：问话卡片、确认卡片晚到的回答，撤回修改的通知）。"
            "用户说「接上草稿纸」「等我在草稿纸上写的」，或有【草稿纸】新消息叫你来取时调它。取到的消息照固定规则看，用 ink_reply 写回，"
            "这一页的图、字帖（有卡片的连卡片的图）附在结果里；第一次还会在前面附上草稿纸的固定规则。"
            "手边没有投递时，结果会说已经接上、这一轮可以结束，或让你再调一次接着等。用户在对话里说了话，先回应用户。"
        ),
        "inputSchema": obj({"timeout": d(N, f"最多等多少秒，默认 {WAIT_DEFAULT}，最多 {WAIT_MAX}；一般不用填")}),
    },
    {
        "name": "ink_reply",
        "description": (
            "把回答写回用户平板上的草稿纸，以蓝色手写体出现。放在哪由草稿纸定，你只要把 anchor 指对。"
            "write：长的回答（可多段，用 \\n 换行；单独一行写成 $$…$$ 的排成公式），用来代替在对话里回答：anchor 填所答的那条红笔（或它讲的那处笔迹），q 填问题原文；空白本子里这段话不太长（约 10 行以内）、旁边又有空，草稿纸把它摊在纸上所答内容的旁边（细线连过去；被用户后来写的字压到就收回圈号）；否则平板在那里标一个圈号，用户点圈号才看到全文，不占纸面。想放在哪用 place（right/below/left/above，或消息图里的像素框），草稿纸先试那里、放不下照常找；只想收着用 fold: true；书页和推送页上一律是圈号；"
            "note/question：短批注（约 40 字以内；写长了草稿纸会把它收成圈号卡片，工具结果里会说），用细线连到所指的笔迹：空白本子里草稿纸在旁边找空白放下，后来被用户写的字压到就收成一个小蓝点（点一下浮出），书页和推送页上排在右边一栏；"
            "underline/circle/arrow：画在笔迹上的标记；read：你对一组手写的读法（照写的原样转写，不翻译、不解释），anchor 填组号，每次回都把红笔那几组和这次回应到的那几组的读法各交一条（用户在平板上打开显示读法的开关时，读法以灰色小字显示在那几笔下面；漏了的组，工具结果里会点名）。"
            "anchor/from/to 用消息图片里的笔迹编号（g1、g2……）；指向印刷文字或无编号处时用 box（消息里那一页的图里的像素坐标 [x0,y0,x1,y1]；不给 submission 时为页面坐标）。回某次投递就带上它的 submission；不给 submission 就写到平板当前打开的那一页（这时笔迹编号用不了，用 box），平板没打开时写到这个对话最近一次投递的那一页。"
            "回答红笔问题：短的（约 40 字以内）用 note，anchor 填那个红笔问题的编号；长的用 write，anchor 也填那个红笔问题的编号。圈号是平板自己标的，不用另画 number 去配，write 的 anchor 也不要写 end（number 仍可用来给步骤排顺序）。"
            "用户用红笔要你改写某条回答：红字写在卡片上的，照下一句接在卡片下面；写在纸上别处的，回一条新的 write（anchor 填那条红笔），旧的那条用户自己擦。"
            "用户在长回答的卡片上用红笔写了批注（消息里附那张卡片的图，写着「圈号 n 的卡片」）：回应用 write，card 填 n，q 填你读到的那句红字，这段接在那张卡片最下面，不出新的圈号；要改写整段，也把改好的写在下面。用户在纸上的短批注上（或紧挨着它）用红笔写了字时，那条短批注照旧留在纸上，书写过程里写明那组红笔写在哪条批注上：照别的红笔问题回，anchor 填那组红笔（以前由短批注收成的卡片上的红字，照上面卡片的办法回）。"
            "用户采纳了文档上的修改建议（消息里「修改建议的决定」）：先调 ink_edit（在平板上问用户覆盖还是另存，并先留底），按它返回的路径改，用 ink_import 导入改好的那个文件，最后用 result 逐条回报改成了没有。"
        ),
        "inputSchema": obj({
            "submission": d(S, "【草稿纸】消息里给的 submission 编号；省略则写到平板当前打开的那一页（这时笔迹编号用不了，用 box 页面坐标），平板没打开时写到这个对话最近一次投递的那一页"),
            "page": d(N, "【草稿纸·整本】消息里的页码（第几页，从 1 起）；单页投递不用填"),
            "items": {
                "type": "array",
                "minItems": 1,
                "items": obj({
                    "type": dict(S, enum=REPLY_TYPES, description=(
                        "write 长的回答（空白本子里不太长、旁边有空时摊在纸上，否则平板在 anchor 那处标一个圈号，用户点开看全文；place 说想放哪，fold 收着）；note 短批注（约 40 字以内，写长了收成圈号卡片；用细线连到 anchor 指的笔迹，位置草稿纸自己找）；question 以问句写的短批注；underline 下划线；circle 圈出；arrow 箭头（from、to，连起两处）；read 你对一组手写的读法（anchor 填组号，照原样转写；用户在平板上打开显示读法的开关时显示在那几笔下面）；suggest 要用户同意才动的一处修改，只用在书页、推送页上印刷的内容（框住 anchor/box 那块，text 写改成什么，用户点 ✓/×；指着手写的字或写在空白本子上的，只画成一条短批注）。"
                        "批改符号（都画在 anchor/box 那块上，只标要紧的）：tick 对 ✓（用户问对不对、或关键的一步才打）；cross 错 ✗（text 写一句为什么）；strike 删除线，该删的（text 写改成什么或为什么删）；insert 插入符 ^，该补的（text 写补的字）；wavy 波浪线表示存疑（text 写一句疑问）；highlight 荧光笔，标关键的；brace 大括号把几行括起来，要合并或归纳时用（text 写一句）；number 圈着的编号，给步骤排顺序（text 写 1、2、3）；cross、strike、wavy 不带 text 的那一条会被退回、不画（工具结果里写明第几条缺什么，同一次的别的照写）。"
                        "概念图（用户把框、圈着的词用箭头连起来）上的四种都是建议，画成虚线，用户点 ✓/×，采纳的变实线：label 给用户画的箭头补关系词（anchor 填那条箭头，text 两三个字），node 建议加一个概念（text 是概念，anchor 填放在哪个旁边，links 列出要连的组），link 建议加一条线（from、to 填组号，text 是关系词），group 建议把几个归成一类（anchors 列出那几组，text 是类名）；概念图里连错的线用 cross 标在那条线上，有疑问用 question，中心概念用 circle。"
                        "sketch 一张手绘风格的示意图或方框图（方框图、流程、因果关系）：只给结构（nodes 节点、edges 连线、groups 分组），不写坐标，草稿纸排版；text 可写一句图注；草稿纸把它放在 anchor/box 所指内容旁边不压字的地方（空白本子里先看右边再看下面，书页、推送页上在下面），anchor 写 end 或不写就接在页面内容后面。"
                        "figure 一张你在电脑上生成的图（数据图、函数曲线这类要准确的，matplotlib 等画成 PNG 或 SVG）：path 填文件路径，text 写一句图注，放法和 sketch 一样。formula 一个排版好的公式（tex 写 LaTeX，不带 $），放法和 sketch 一样，平板上排成数学公式。"
                        "result 回报一条采纳的修改改完了没有（在 ink_edit → 改文件 → ink_import 之后）：anchor 填 s 编号，ok 填 true / false，没改成时 text 写一句原因；没回报的，之后的消息里会列出来")),
                    "text": d(S, "write/note/question/read 的文字；suggest 写改成什么（如「改为：……」「删去这句」，最多 120 字）；批改符号旁边的一句话（不超过 40 字），insert 是补的字、number 是编号；arrow 可带不超过 8 字的标签"),
                    "q": d(S, "write 回答红笔问题时：那个问题的原文（照用户写的转写），显示在点开的卡片顶上，用户擦掉红字后也看得到；带 card 时填你读到的卡片上的那句红字，显示在接上的那一段前面"),
                    "card": d(N, "write 回应用户在长回答卡片（或以前由短批注收成的卡片）上写的红字时：那张卡片的圈号 n（消息里写着「圈号 n 的卡片」）。带了它，这段 text 接在那张卡片最下面，不出新的圈号"),
                    "place": {
                        "anyOf": [dict(S, enum=["right", "below", "left", "above"]), {"type": "array", "items": N, "minItems": 4, "maxItems": 4}],
                        "description": "write：想把这段话摊在纸上的哪里——所答内容的 right（右边）、below（下面）、left（左边）、above（上面），或消息里那一页的图里的一个像素框 [x0,y0,x1,y1]；草稿纸先试那里，放不下（会压到用户的字或别的蓝字、出纸）再照常找，都放不下就收成圈号。不写由草稿纸定",
                    },
                    "fold": d(B, "write：true 表示这条收着——只标圈号，用户点开看，不摊在纸上"),
                    "anchor": d(S, "笔迹编号如 g3；一组分了几行（消息里写着「分 N 行」）时 g3:1 指它的第 1 行。read 填读的那一组（或那一行）；write 填所答的那条红笔（或它讲的那处笔迹）：圈号标在它右边，不要写 end；sketch、figure、formula 可写 end 表示接在页面内容后面"),
                    "from": d(S, "arrow/link 的起点编号"),
                    "to": d(S, "arrow/link 的终点编号"),
                    "anchors": {"type": "array", "items": S, "description": "group：归成一类的那几组的编号"},
                    "links": {"type": "array", "items": S, "description": "node：新概念要连过去的组的编号"},
                    "ok": d(B, "result：改成了 true，没改成 false"),
                    "tex": d(S, "formula 的 LaTeX（不带 $），如 \\frac{a+b}{2}"),
                    "nodes": {
                        "type": "array",
                        "description": "sketch 的节点：每个是一个字符串（就是节点的字），或 {id, text, shape}；字要短（不超过 12 个字），shape 填 round 画成椭圆，默认方框。最多 24 个",
                        "items": {"anyOf": [S, obj({"id": S, "text": S, "shape": dict(S, enum=["box", "round"])}, ["text"])]},
                    },
                    "edges": {
                        "type": "array",
                        "description": "sketch 的连线（带箭头）：from、to 填节点的 id 或字，text 写两三个字的关系词，dash 为 true 画虚线。最多 40 条",
                        "items": obj({"from": S, "to": S, "text": S, "dash": B}, ["from", "to"]),
                    },
                    "groups": {
                        "type": "array",
                        "description": "sketch 的分组：nodes 列出组里的节点，text 是组名，画成虚线框",
                        "items": obj({"nodes": {"type": "array", "items": S}, "text": S}, ["nodes"]),
                    },
                    "dir": dict(S, enum=["LR", "TB"], description="sketch：从左往右（LR）还是从上往下（TB）排；不写时四层以内从左往右"),
                    "path": d(S, "figure：图的文件路径（PNG、JPG、SVG；相对路径按当前项目目录）"),
                    "w": d(N, "sketch 旧写法：坐标范围的宽，默认 600"),
                    "h": d(N, "sketch 旧写法：坐标范围的高，默认 300"),
                    "shapes": {
                        "type": "array",
                        "description": "sketch 旧写法（尽量用 nodes/edges/groups）：形状，坐标都在 w × h 里：line（pts 折线，arrow 画箭头，dash 虚线，text 写在中段旁）、curve（pts，过这些点的平滑曲线）、rect（x、y、w、h，text 写在框中间）、ellipse（cx、cy、rx、ry，text）、text（x、y 是这行字的左端、竖直居中，size 字号默认 20）、axes（x、y、w、h 坐标轴，左下角为原点，xlabel、ylabel）",
                        "items": obj({
                            "type": dict(S, enum=["line", "curve", "rect", "ellipse", "text", "axes"]),
                            "pts": {"type": "array", "items": {"type": "array", "items": N, "minItems": 2, "maxItems": 2}},
                            "x": N, "y": N, "w": N, "h": N, "cx": N, "cy": N, "rx": N, "ry": N,
                            "text": S, "size": N, "xlabel": S, "ylabel": S,
                            "arrow": dict(S, enum=["end", "start", "both"]),
                            "dash": B,
                        }, ["type"]),
                    },
                    "box": {"type": "array", "items": N, "minItems": 4, "maxItems": 4, "description": "消息里那一页的图里的像素框 [x0,y0,x1,y1]"},
                }, ["type"]),
            },
        }, ["items"]),
    },
    {
        "name": "ink_show",
        "description": (
            "把一个文件推到用户平板的草稿纸上，成为一页，让用户在上面手写、圈画后发回来：推的页进你这个对话所在项目文件夹自己的那本"
            "（默认叫「推送 · 文件夹名」，没有就新开一本），用户在这一页上点「AI」交回来的发回给你（用 ink_wait 收）。"
            "支持图片（png/jpg）、PDF 和 Word、PPT（用 page 选页）、SVG，以及文本/代码文件（排成一页，page 表示第几个 70 行）。整份文档要让用户翻着写，用 ink_import。"
        ),
        "inputSchema": obj({
            "path": d(S, "文件路径（相对路径按当前项目目录解析）"),
            "page": d(N, "PDF、Word、PPT 的页码（从 1 起），或文本文件的第几段 70 行"),
            "title": d(S, "在平板上显示的标题"),
        }, ["path"]),
    },
    {
        "name": "ink_snapshot",
        "description": (
            "取用户平板草稿纸当前这一页的快照（这一页的图、字帖、书写过程），用于用户在对话里提到「看我草稿纸上写的」之类的时候。"
            "图附在结果里，也写着路径。需要平板上开着草稿纸页面。"
        ),
        "inputSchema": obj({}),
    },
    {
        "name": "ink_import",
        "description": (
            "把一整份文档导入用户平板的草稿纸，成为一个可以翻页、手写的本子：PDF、PPT/PPTX、Word（DOC/DOCX，用本机 Office 转换）、EPUB、图片、Markdown 和纯文本。"
            "同一个文件再导入，会原地更新原来那本：页按内容对齐，用户的手写跟着对应的页走，平板上能对比新旧版、看到改动处。"
            "改已导入的文档：动手前先调 ink_edit（它问用户覆盖还是另存，并先留底），按它返回的路径改完，再用这个工具导入改好的那个文件："
            "覆盖的导入原文件；另存的导入 ink_edit 新建的那个文件，平板上那本自动换成它（不用 replace）。然后用 ink_reply 的 result 回报采纳的修改建议改成了没有。"
            "用户在对话里打字让你改已导入的文档也一样。不经 ink_edit 另存成新文件名的新版本（如 v47 → v48）用 replace 指定替换哪本。只想推某一页让用户圈画时用 ink_show。"
        ),
        "inputSchema": obj({
            "path": d(S, "文件路径（相对路径按当前项目目录解析）"),
            "title": d(S, "在平板上显示的名字，默认用文件名"),
            "replace": d(S, "用这个文件替换草稿纸里已有的哪本（本子名字），笔迹保留、可对比新旧版"),
            "as_new": d(B, "即使导入过，也另建一本"),
        }, ["path"]),
    },
    {
        "name": "ink_scan",
        "description": (
            "检测用户草稿纸上一整本的内容：把一本里写过字的每一页（书页/推送页连同用户的手写、你之前的批注）在电脑上画成图，"
            "返回各页的书写过程和图的路径，各页的图也附在结果里（页太多、图太大时只附前面几张，其余的结果里写明）。"
            "用户说「我在好几页上写了」「看看整本」或想知道用户在哪些页留了意见时用。不需要平板开着。"
        ),
        "inputSchema": obj({
            "nb": d(S, "本子：名字（如 PPT 文件名、推送的页所在的「推送 · 文件夹名」）或 id（scratch=草稿本，book:文件名.pdf）；省略则为平板当前打开的本子"),
            "pages": {"type": "array", "items": N, "description": "只看这些页（从 1 起）；省略则为所有写过字的页"},
            "only_new": d(B, "只要上次看过之后有新笔迹的页"),
            "region": {"type": "array", "items": N, "minItems": 2, "maxItems": 2, "description": "配合单独一页：只截页面坐标 y0–y1 这一段并放大"},
        }),
    },
    {
        "name": "ink_confirm",
        "description": (
            "读不准用户的手写（字、符号、下标、数字）时，在平板上弹一张确认卡片问用户：附那一块的截图、你的读法和候选，用户点选或手写更正。"
            "会等用户回答（最多约 45 秒），返回用户的读法。还没答时，照结果说的收之后的回答。一次可问几处。"
        ),
        "inputSchema": obj({
            "submission": d(S, "【草稿纸】消息里的 submission 编号；省略则为平板当前那一页"),
            "page": d(N, "整本检测消息里的页码（从 1 起）"),
            "questions": {
                "type": "array",
                "minItems": 1,
                "maxItems": 6,
                "items": obj({
                    "anchor": d(S, "笔迹编号，如 g3"),
                    "box": {"type": "array", "items": N, "minItems": 4, "maxItems": 4, "description": "没有编号时：图里的像素框 [x0,y0,x1,y1]"},
                    "guess": d(S, "你的读法"),
                    "options": {"type": "array", "items": S, "description": "其他候选读法"},
                    "question": d(S, "想问的话，如「这里是 ρ 还是 p？」"),
                }),
            },
        }, ["questions"]),
    },
    {
        "name": "ink_ask",
        "description": (
            "在用户平板的草稿纸顶上发一张问话卡片。能写在纸上的都写在纸上（用 ink_reply），只有两种情况才用它：要用户回答才能继续的问题"
            "（question，可带 0–4 个短选项；用户点一个，或用笔在卡片上手写），和纸上放不下的结果（result）。别的对话内容不发到平板。"
            "问题卡片会等用户回答约一分半：点了选项，返回那个选项的原文；手写的，返回那张图（附在结果里，也写着路径），看图读出用户写的。"
            "一分半还没答，卡片留在平板上。不要替用户选，照结果说的收之后的回答。"
            "用户也可能点「忽略」不答：返回会告诉你，忽略了的问题不要再问。"
            "结果卡片发出去就返回，用户看完点「知道了」它就消失，不用等。平板没打开草稿纸时卡片不发，马上告诉你：改在对话里问、在对话里说。"
        ),
        "inputSchema": obj({
            "question": d(S, "要用户回答的一句话（问题卡片）；和 result 只给一个"),
            "options": {"type": "array", "items": S, "maxItems": 4, "description": "0–4 个短选项（几个字），用户点一个；不给就只能手写回答"},
            "handwrite": d(B, "能不能用笔在卡片上手写回答，默认能；只许点选项时填 false（这时要给 options）"),
            "result": d(S, "纸上放不下的结果（结果卡片，可多段，用 \\n 换行）；和 question 只给一个"),
        }),
    },
    {
        "name": "ink_edit",
        "description": (
            "改用户电脑上一份已导入草稿纸的文档之前先调它（用户交上来的书页对应的原文件，或用户在对话里点名的）：每一轮动手改之前调一次；"
            "一次只办一个文件，这一轮要改同一个文件的几处合起来只调一次，要改两个文件就调两次，下一轮再改再调。"
            "不带 mode：在用户平板顶上问「覆盖原文件，还是另存一份？」，等用户点选约一分半。用户还没选就先别动这个文件。"
            "照结果说的收之后的选择，到时带上 mode 再调一次。用户点了「忽略」，这次就不改这个文件。平板没打开草稿纸时马上告诉你：在对话里问用户，再带上 mode 调。"
            "带 mode 就不弹卡片，直接办：overwrite 先把原文件留底，然后你改原文件本身；saveas 在原文件旁边另存一份（如 v47 → v48），返回新文件的路径，你改这个新文件，原文件不要动。留了底，用户在平板上能撤回。"
            "按返回的路径改完：用 ink_import 导入改好的那个文件（平板上那本原地换成新版；另存的，那本换成新文件），采纳的修改建议再用 ink_reply 的 result 逐条回报改成了没有。"
            "用户在对话里打字让你改已导入的文档也一样先调它：用户已经说了覆盖还是另存，就带上 mode；没说的，在对话里问用户。"
            "留底在草稿纸数据文件夹（消息里图片所在 submissions 的上一层）的 keep 里：用户要找回旧版或第一次改之前的原件时去那里拿；拿回来要盖掉现在这份时，也算改文件，照样先调它，再拿留底的内容覆盖。"
        ),
        "inputSchema": obj({
            "path": d(S, "要改的那个原文件的路径（相对路径按当前项目目录解析）"),
            "mode": dict(S, enum=["overwrite", "saveas"],
                         description="用户已经说了时填：overwrite 覆盖原文件（先留底），saveas 另存一份（改新文件）。不填就在平板上问用户"),
        }, ["path"]),
    },
]
TOOL_NAMES = [t["name"] for t in TOOLS]


def is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


class Out:
    """一次工具调用的结果：text 是给 AI 的话（出去前经 for_ai）；images_from 是从哪段文字里找要附的图（只认投递文件夹里的）；
    first 为 True 时前面附上固定规则（ink_wait 每个进程第一次等到投递时）。
    taken：ink_wait 拿在手里的那条投递的编号——结果写给了客户端才向服务确认，没写出去就放回去（McpServer.run_tool）。
    keep：这是用户在卡片上的回答（服务已经给了、不会再给）——没送到 AI 就存下来，下次 ink_wait 交。"""

    def __init__(self, text, images_from="", first=False, taken="", keep=False):
        self.text, self.images_from, self.first = str(text or ""), images_from or "", first
        self.taken, self.keep = taken, keep


class Tools:
    """各工具做的事：照插件 register.tsx 里同名工具的 tool.call 处理写（调哪个 /bridge/*、前后做什么、返回什么话）。
    每个返回 Out（或一句话）。没办成的抛 ToolError（结果里 isError），连不上服务抛 Offline。"""

    def __init__(self, link, cwd, wait_default):
        self.link, self.cwd, self.wait_default = link, cwd, wait_default
        self.rules_given = False

    def abspath(self, p):
        return p if ABS_PATH.match(p) else os.path.join(self.cwd, p)

    def call(self, method, path, body=None, timeout=30.0):
        r = self.link.bridge.call(method, path, body, timeout)
        if r.offline:
            self.link.set_online(False)
            raise Offline()
        return r

    def body(self, **kw):
        out = {"sid": self.link.sid}
        out.update({k: v for k, v in kw.items() if v is not None})
        return out

    # -- 等平板交来的下一页（新的，插件那边由插件自己取、交进对话）
    def ink_wait(self, args, cancel):
        try:  # 有的模型把数字写成字符串「"45"」：也认
            t = float(args.get("timeout")) if args.get("timeout") is not None and not isinstance(args.get("timeout"), bool) else 0.0
        except (TypeError, ValueError):
            t = 0.0
        timeout = max(1.0, min(float(WAIT_MAX), t if t > 0 else float(self.wait_default)))
        if not self.link.may_wake():
            self.link.round_over()  # 仍靠等待的对话，又来等就算上一轮结束
        if not (self.link.registered and self.link.online):
            self.link.hello()   # 连不上也不马上回：报到的线程每几秒再试，等的这段时间里服务开了照样收得到
        item, wake = self.link.take(timeout, cancel)
        if item is None:
            if cancel.is_set():
                return Out("")  # 客户端已经取消：这句不会发出去
            if not self.link.online:
                raise Offline()
            return Out(CONNECTED if wake else NOTHING_YET.format(n=int(round(timeout))))
        # 每个进程第一次等到：固定规则附在前面（不是每家客户端都把 instructions 给模型看）
        first, self.rules_given = not self.rules_given, True
        return Out(item[1], item[1], first=first, taken=item[0])

    def ink_reply(self, args, cancel):
        self.link.ensure()
        items = args.get("items")
        items = [dict(it, path=self.abspath(it["path"])) if isinstance(it, dict) and it.get("type") == "figure" and isinstance(it.get("path"), str) else it
                 for it in items] if isinstance(items, list) else []
        sub = args.get("submission")
        r = self.call("POST", "/bridge/reply", self.body(submission=sub if isinstance(sub, str) and sub else None,
                                                          page=args.get("page") if is_num(args.get("page")) else None, items=items))
        if not r.ok:
            raise ToolError(f"没写成：{r.error}")
        # 客户端可能一看到上一页的结果就写回，这时先等它的 ack 和 reading 都办完。
        with self.link.settling, self.link.cond:
            if self.link.may_wake() and self.link.current and (not sub or sub == self.link.current):
                self.link.done_after = time.monotonic() + ROUND_IDLE_S
        later = "" if r.data.get("tabletOnline") else "（平板现在没打开草稿纸，下次打开那一页时会出现）"
        notes = [s for s in r.data.get("notes") or [] if isinstance(s, str) and s]
        return Out(f"已写到草稿纸：{r.data.get('page', '')}，共 {r.data.get('count')} 条{later}" + "".join("\n" + s for s in notes))

    def ink_show(self, args, cancel):
        path = args.get("path")
        if not isinstance(path, str) or not path:
            raise ToolError("缺少 path")
        self.link.ensure()
        r = self.call("POST", "/bridge/show", self.body(path=self.abspath(path), page=args.get("page") if is_num(args.get("page")) else None,
                                                         title=args.get("title") if isinstance(args.get("title"), str) else None), timeout=120)
        if not r.ok:
            raise ToolError(f"没推送成：{r.error}")
        book = r.data.get("nbTitle") if isinstance(r.data.get("nbTitle"), str) and r.data.get("nbTitle") else "推送"
        later = "平板上会弹出提示" if r.data.get("tabletOnline") else f"平板现在没打开草稿纸，打开后在「{book}」那本里"
        try:
            no = int(r.data.get("page")) + 1
        except (TypeError, ValueError):
            no = "?"
        return Out(f"已推到平板：「{r.data.get('title')}」（「{book}」第 {no} 页），{later}。"
                   "用户圈画后点「AI」交回来，用 ink_wait 收。")

    def ink_import(self, args, cancel):
        path = args.get("path")
        if not isinstance(path, str) or not path:
            raise ToolError("缺少 path")
        self.link.ensure()
        self.link.working()
        rep = args.get("replace")
        r = self.call("POST", "/bridge/import", self.body(path=self.abspath(path), title=args.get("title") if isinstance(args.get("title"), str) else None,
                                                           replace=rep if isinstance(rep, str) and rep else None, as_new=args.get("as_new") is True),
                      timeout=280)
        if not r.ok:
            raise ToolError(f"没导入成：{r.error}")
        later = "平板上会弹出提示" if r.data.get("tabletOnline") else "平板现在没打开草稿纸，打开后在左上角的本子列表里"
        if isinstance(r.data.get("updated"), str):
            remind = "\n" + r.data["remind"] if isinstance(r.data.get("remind"), str) and r.data.get("remind") else ""
            return Out(f"已原地更新《{r.data.get('title')}》（共 {r.data.get('pages')} 页，用户的手写保留）：{r.data['updated']}。"
                       f"平板上改过的页会标出改动处，可对比旧版。{remind}")
        return Out(f"已导入：《{r.data.get('title')}》，共 {r.data.get('pages')} 页，{later}。")

    def ink_snapshot(self, args, cancel):
        self.link.ensure()
        r = self.call("POST", "/bridge/snapshot", self.body(wait=15), timeout=40)
        if not r.ok:
            raise ToolError(f"没取到：{r.error}")
        text = str(r.data.get("text") or "")
        return Out(text, text)

    def ink_scan(self, args, cancel):
        self.link.ensure()
        nb, pages, region = args.get("nb"), args.get("pages"), args.get("region")
        r = self.call("POST", "/bridge/scan", self.body(
            nb=nb if isinstance(nb, str) and nb else None,
            pages=[p for p in pages if is_num(p)] if isinstance(pages, list) else None,
            only_new=args.get("only_new") is True,
            region=region if isinstance(region, list) and len(region) == 2 else None), timeout=280)
        if not r.ok:
            raise ToolError(f"没取到：{r.error}")
        text = str(r.data.get("text") or "")
        return Out(text, text)

    def ink_confirm(self, args, cancel):
        qs = args.get("questions")
        if not isinstance(qs, list) or not qs:
            raise ToolError("缺少 questions")
        self.link.ensure()
        sub = args.get("submission")
        r = self.call("POST", "/bridge/confirm", self.body(submission=sub if isinstance(sub, str) and sub else None,
                                                            page=args.get("page") if is_num(args.get("page")) else None, questions=qs), timeout=60)
        if not r.ok:
            raise ToolError(f"没问成：{r.error}")
        cid = str(r.data.get("id"))
        if not r.data.get("tabletOnline"):
            self.call("POST", "/bridge/confirm-wait", {"id": cid, "wait": 0, "last": True})
            return Out("平板现在没打开草稿纸：确认卡片已经留在那一页，用户打开后回答会出现在 ink_wait 等到的结果里。"
                       + self.card_followup(confirm=True))
        # 共等约 45 秒（25 + 20），和插件的 waitConfirm 一样；被客户端取消了也记一下「不等了」，之后的回答经 ink_wait 收
        for k, wait in enumerate((25, 20)):
            stop = cancel.is_set()
            last = k == 1 or stop
            w = self.link.bridge.call("POST", "/bridge/confirm-wait", {"id": cid, "wait": 0 if stop else wait, "last": last}, timeout=wait + 15)
            if not w.ok:
                return Out(f"没等到回答：{w.error}。先按你的理解继续，并在回复里标明哪处是推测的。")
            if isinstance(w.data.get("text"), str):
                return Out(w.data["text"], keep=True)  # 用户答了：这次调用要是被取消了，回答存下来经 ink_wait 交
            if last:
                break
        return Out(CONFIRM_LATE + self.card_followup(confirm=True))

    def card_followup(self, confirm=False):
        wake = self.link.can_wake()
        if confirm:
            return CONFIRM_GUESS + (CONFIRM_WAKE if wake else CARD_WAIT)
        return CARD_WAKE if wake else CARD_WAIT

    def wait_card(self, path, cid, pending_text, cancel, edit=False):
        """问话卡片、「覆盖还是另存」卡片：一次最多挂 25 秒，连着等几次，共约一分半（插件的 waitAsk、waitEdit）。
        最后一次还没答：服务记下「不等了」，之后的回答经 ink_wait 收。被客户端取消了也照样记一下（等 0 秒、last）。
        返回 (给 AI 的话, 是不是用户已经答了)：答了的那句服务不会再给，调用的地方标 keep，没送到 AI 就存下来。"""
        pending = ""
        for k, wait in enumerate(ASK_WAITS):
            stop = cancel.is_set()
            last = k == len(ASK_WAITS) - 1 or stop
            r = self.link.bridge.call("POST", path, {"id": cid, "wait": 0 if stop else wait, "last": last}, timeout=wait + 15)
            if not r.ok:
                again = None if last else self.link.bridge.call("POST", path, {"id": cid, "wait": 0, "last": True}, timeout=15)
                if again is not None and again.ok and isinstance(again.data.get("text"), str):
                    return again.data["text"], True
                who = "用户选" if edit else "回答"
                return f"没等到{who}（{r.error}）。{pending_text}", False
            if isinstance(r.data.get("text"), str):
                if not edit or not r.data.get("pending"):
                    return r.data["text"], True  # 答了（或选了、已留底或另存好）、忽略了、或卡片撤下了
                pending = r.data["text"]
            if last:
                break
        return pending or pending_text, False

    def ink_ask(self, args, cancel):
        q = args.get("question").strip() if isinstance(args.get("question"), str) else ""
        res = args.get("result").strip() if isinstance(args.get("result"), str) else ""
        if not q and not res:
            raise ToolError("要给 question（要用户回答的一句话）或 result（纸上放不下的结果）")
        if q and res:
            raise ToolError("question 和 result 只给一个：问问题和给结果分两张卡片")
        opts = [o for o in args.get("options") or [] if isinstance(o, str) and o.strip()] if isinstance(args.get("options"), list) else []
        if len(opts) > 4:
            raise ToolError("options 最多 4 个")
        self.link.ensure()
        body = self.body(question=q, options=opts, handwrite=args.get("handwrite") is not False) if q else self.body(result=res)
        r = self.call("POST", "/bridge/ask", body)
        if not r.ok:
            raise ToolError(f"没发成：{r.error}")
        if r.data.get("offline"):
            return Out("平板现在没打开草稿纸，卡片没发出去：改在对话里问用户。" if q else "平板现在没打开草稿纸，卡片没发出去：把结果直接写在对话里。")
        if res:
            return Out("结果卡片已经显示在平板顶上，用户看完点「知道了」它就消失；不用等。")
        text, answered = self.wait_card("/bridge/ask-wait", str(r.data.get("id")), ASK_PENDING, cancel)
        if not answered:
            text += self.card_followup()
        return Out(text, text, keep=answered)  # 手写的回答：那张图附在结果里

    def ink_edit(self, args, cancel):
        path = args.get("path")
        if not isinstance(path, str) or not path:
            raise ToolError("缺少 path（要改的那个原文件）")
        mode = args.get("mode") if args.get("mode") in ("overwrite", "saveas") else None
        if args.get("mode") not in (None, "") and not mode:
            raise ToolError("mode 只能是 overwrite（覆盖原文件）或 saveas（另存一份）；不知道用户要哪种就不填，在平板上问")
        self.link.ensure()
        self.link.working()
        r = self.call("POST", "/bridge/edit", self.body(path=self.abspath(path), mode=mode), timeout=120)
        if not r.ok:
            raise ToolError(f"没办成：{r.error}")
        if isinstance(r.data.get("ask"), str) and r.data.get("ask"):
            text, answered = self.wait_card("/bridge/edit-wait", r.data["ask"], EDIT_PENDING, cancel, edit=True)
            if not answered:
                if text == prompt.EDIT_PENDING:
                    text = EDIT_PENDING
                text += self.card_followup()
            return Out(text, keep=answered)
        return Out(r.data.get("text") or "")


# ---------------------------------------------------------------- 附图

def attach_images(text, subdir):
    """消息里列的图（只认草稿纸投递文件夹里的 png/jpg），读出来作为 MCP 的 image 内容附上。
    返回 (内容列表, 没附上的 [(路径, 为什么)])。太大的、超过张数或总大小的不附，只在文字里说明。"""
    if not text or not subdir:
        return [], []
    flags = re.IGNORECASE if os.name == "nt" else 0
    pat = re.compile(re.escape(subdir.rstrip("\\/")) + r"[\\/][^\s（）()「」【】：，。；;、\"'<>|*?]+?\.(?:png|jpe?g)(?![A-Za-z0-9_])", flags)
    try:
        root = os.path.normcase(os.path.realpath(subdir)).rstrip("\\/") + os.sep
    except OSError:
        return [], []
    seen, out, dropped, total = [], [], [], 0
    for m in pat.finditer(text):
        p = m.group(0)
        if p in seen:
            continue
        seen.append(p)
        try:
            real = os.path.realpath(p)
        except OSError:
            continue
        if not os.path.normcase(real).startswith(root) or not os.path.isfile(real):  # 只认投递文件夹里面的（挡 ..）
            continue
        size = os.path.getsize(real)
        if size > IMG_MAX:
            dropped.append((p, f"太大（{size / 1048576:.1f} MB）"))
            continue
        if len(out) >= IMG_COUNT or total + size > IMG_TOTAL:
            dropped.append((p, "这次附的图已经够多"))
            continue
        try:
            raw = Path(real).read_bytes()
        except OSError:
            continue
        total += len(raw)
        out.append({"type": "image", "data": base64.b64encode(raw).decode("ascii"),
                    "mimeType": IMG_TYPES.get(os.path.splitext(real)[1].lower(), "image/png")})
    return out, dropped


def dropped_note(dropped):
    if not dropped:
        return ""
    rows = "\n".join(f"- {p}：{why}" for p, why in dropped)
    return (f"\n\n（下面 {len(dropped)} 张图没有附在结果里：能读本机文件的，按路径读；读不了的，在对话里告诉用户哪几张没看到。）\n" + rows)


# ---------------------------------------------------------------- MCP（stdio 上的 JSON-RPC 2.0）

class McpServer:
    def __init__(self, opts, inp=None, out=None):
        self.opts = opts
        self.inp = inp or sys.stdin.buffer
        self.out = out or sys.stdout.buffer
        self.out_lock = threading.Lock()
        self.cancels = {}
        self.fixed_ai = opts.ai
        sid = str(uuid.uuid4())  # 进程活着期间不变
        self.link = Link(Bridge(opts.url), sid, opts.label, opts.cwd, opts.ai or "AI", opts.wake, opts.codex)
        self.tools = Tools(self.link, opts.cwd, opts.wait)

    # -- 写
    def send(self, msg):
        """写一条给客户端。返回写出去了没有（管道断了、已经关了是 False）。"""
        data = json.dumps(msg, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        with self.out_lock:
            try:
                self.out.write(data)
                self.out.flush()
                return True
            except (OSError, ValueError):
                return False

    def result(self, mid, res):
        return self.send({"jsonrpc": "2.0", "id": mid, "result": res})

    def error(self, mid, code, message):
        self.send({"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}})

    # -- 读
    def serve(self):
        try:
            while True:
                raw = self.inp.readline()
                if not raw:
                    break
                line = raw.strip().lstrip(b"\xef\xbb\xbf")
                if not line:
                    continue
                try:
                    msg = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    self.error(None, -32700, "Parse error")
                    continue
                try:
                    self.handle(msg)
                except Exception:  # noqa: BLE001 - 一条消息出错不把整个程序弄死
                    log("处理消息出错：" + traceback.format_exc().strip().splitlines()[-1])
                    if isinstance(msg, dict) and msg.get("id") is not None and "method" in msg:
                        self.error(msg.get("id"), -32603, "Internal error")
        except KeyboardInterrupt:
            pass
        finally:
            self.shutdown()

    def shutdown(self):
        try:
            self.link.bye()
        except Exception:  # noqa: BLE001
            pass
        log("退出")

    def handle(self, msg):
        if isinstance(msg, list):  # 2025-06-18 起不支持批量
            self.error(None, -32600, "Invalid Request: batch is not supported")
            return
        if not isinstance(msg, dict):
            self.error(None, -32600, "Invalid Request")
            return
        method, has_id, mid = msg.get("method"), "id" in msg, msg.get("id")
        if method is None:  # 对方回我们的请求（我们不发请求）：不理
            return
        if not isinstance(method, str):
            if has_id:
                self.error(mid, -32600, "Invalid Request")
            return
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        if not has_id:  # 通知：不回话
            if method == "notifications/initialized":
                self.link.start()
            elif method == "notifications/cancelled":
                ev = self.cancels.get(json.dumps(params.get("requestId")))
                if ev:
                    ev.set()
            return
        if method == "initialize":
            self.initialize(mid, params)
        elif method == "ping":
            self.result(mid, {})
        elif method == "tools/list":
            self.link.start()
            self.result(mid, {"tools": TOOLS})
        elif method == "tools/call":
            key, ev = json.dumps(mid), threading.Event()
            self.link.tool_started(ev, params.get("_meta"))
            self.link.start()
            self.cancels[key] = ev
            threading.Thread(target=self.run_tool, args=(mid, key, ev, params), name="inkpad-tool", daemon=True).start()
        else:
            self.error(mid, -32601, f"Method not found: {method}")

    def initialize(self, mid, params):
        asked = params.get("protocolVersion")
        version = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        info = params.get("clientInfo") if isinstance(params.get("clientInfo"), dict) else {}
        ai = self.fixed_ai or guess_ai(info.get("name"))
        changed = ai != self.link.ai
        self.link.ai = ai
        self.result(mid, {"protocolVersion": version, "capabilities": {"tools": {}},
                          "serverInfo": {"name": NAME, "version": VERSION}, "instructions": instructions()})
        if changed and self.link.registered:  # 已经登记过（客户端先调了工具才握手）：用新的名字重新登记
            self.link.hello()

    def run_tool(self, mid, key, ev, params):
        name, args = params.get("name"), params.get("arguments")
        try:
            if name not in TOOL_NAMES:
                self.error(mid, -32602, f"Unknown tool: {name}")
                return
            if args is None:
                args = {}
            o, whole = None, False
            if not isinstance(args, dict):
                res = {"content": [{"type": "text", "text": "arguments 要是一个对象"}], "isError": True}
            else:
                res, o, whole = self.call_tool(name, args, ev)
            if o is not None and o.taken:
                # 手里拿着一页：写出去、向服务确认（或放回去）一气做完——客户端收到结果马上又来 ink_wait 时，
                # 那边「上一页这一轮结束」的一步（Link.round_over）等这里办完再走，不会抢在「在看」前面
                with self.link.settling:
                    self.settle(o, whole and not ev.is_set() and self.result(mid, res))
                return
            # 客户端已经取消了这次调用：不再回话。没取消的写出去，写成了才算送到
            got = whole and not ev.is_set() and self.result(mid, res)
            if not whole and not ev.is_set():
                self.result(mid, res)  # 出错的那句话照样回
            self.settle(o, got)
        finally:
            self.link.tool_finished(ev)
            self.cancels.pop(key, None)

    def settle(self, o, got):
        """工具的结果送到客户端了没有（got），决定手里的东西怎么办：ink_wait 拿着的那一页，送到了才向服务确认，没送到放回去下次再给；
        用户在卡片上的回答（服务不会再给），没送到就存下来经 ink_wait 交。（2026-11-18 审查后加）"""
        if o is None:
            return
        if o.taken:
            if got:
                self.link.commit(o.taken)
            else:
                self.link.release(o.taken)
                if o.first:
                    self.tools.rules_given = False  # 固定规则也没送到：下次等到时再附
        elif o.keep and not got:
            self.link.stash(o.text)

    def call_tool(self, name, args, ev):
        """返回 (给客户端的结果, 工具的 Out（工具自己就出错的是 None）, 结果里是不是工具要说的整段话（不是出错的那句）)。"""
        o = None
        try:
            o = getattr(self.tools, name)(args, ev)
            if not isinstance(o, Out):
                o = Out(o)
            images, dropped = attach_images(o.images_from, self.link.subdir) if o.images_from else ([], [])
            body = for_ai(o.text, attached=bool(images)) + dropped_note(dropped)
            if o.first:
                body = RULES_HEAD + rules() + RULES_SEP + body
            if o.taken:
                with self.link.cond:
                    remaining = len(self.link.inbox)
                    wake = self.link.can_wake()
                if remaining:
                    body += f"\n\n还有 {remaining} 条在等：回完这一条再调一次 ink_wait，马上返回。"
                elif wake:
                    body += "\n\n回完这一条就结束这一轮，下次会有新消息叫你来取。"
                else:
                    body += "\n\n回完这一条，用户没让你停，就再调 ink_wait 等下一页。"
            return {"content": [{"type": "text", "text": body}] + images}, o, True
        except ToolError as e:
            return {"content": [{"type": "text", "text": for_ai(str(e))}], "isError": True}, o, False
        except Offline:
            return {"content": [{"type": "text", "text": OFFLINE}], "isError": True}, o, False
        except Exception:  # noqa: BLE001
            log(f"{name} 出错：" + traceback.format_exc().strip().splitlines()[-1])
            return {"content": [{"type": "text", "text": CRASHED}], "isError": True}, o, False


def options(argv=None):
    ap = argparse.ArgumentParser(description="草稿纸（ThinkPaper）的 MCP 小程序：让别的命令行 AI 把草稿纸接成自己的工具")
    ap.add_argument("--url", default=os.environ.get("INKPAD_URL") or "http://127.0.0.1:8765", help="草稿纸服务的地址（默认 http://127.0.0.1:8765）")
    ap.add_argument("--ai", default=os.environ.get("INKPAD_AI") or "", help="这个对话是哪个 AI（不给就按客户端报的名字猜）")
    ap.add_argument("--wake", choices=("auto", "off"), default=os.environ.get("INKPAD_WAKE") or "auto", help="自动叫醒 Codex 对话，或关掉叫醒")
    ap.add_argument("--codex", default=os.environ.get("INKPAD_CODEX") or "", help="Codex 程序的路径，默认从 PATH 找")
    ap.add_argument("--label", default="", help="平板上显示的文件夹名（默认是 --cwd 的文件夹名）")
    ap.add_argument("--cwd", default="", help="这个对话的项目文件夹（默认是进程的当前目录）")
    ap.add_argument("--wait", type=float, default=None, help=f"ink_wait 默认等多少秒（默认 {WAIT_DEFAULT}，最多 {WAIT_MAX}）")
    o = ap.parse_args(argv)
    # 地址只留「http://主机:端口」：有人把平板用的带访问码的地址整个填进来时，问号后面的、路径、用户名密码都丢掉——
    # 这个小程序走的是不要访问码的 /bridge/*，留着它只会在连不上时被写进日志（2026-11-18 审查后加）。写得不像地址的直接不启动，
    # 报错的话里不带填的那串
    try:
        u = urllib.parse.urlsplit(o.url.strip())
        host, port = u.hostname, u.port
    except ValueError:
        u, host, port = None, None, None
    if u is None or u.scheme not in ("http", "https") or not host:
        ap.exit(2, "inkpad-mcp：--url（或 INKPAD_URL）要写成 http://主机:端口 的样子，比如 http://127.0.0.1:8765\n")
    o.url = f"{u.scheme}://{'[' + host + ']' if ':' in host else host}" + (f":{port}" if port else "")
    o.ai = " ".join(o.ai.split())[:40]
    o.cwd = os.path.abspath(o.cwd or os.getcwd())
    o.label = o.label or Path(o.cwd).name or o.cwd
    wait = o.wait
    if wait is None:
        try:
            wait = float(os.environ.get("INKPAD_WAIT") or WAIT_DEFAULT)
        except ValueError:  # 环境变量写错了：照默认的来，不因此起不来
            wait = WAIT_DEFAULT
    o.wait = max(1.0, min(float(WAIT_MAX), wait if wait > 0 else WAIT_DEFAULT))
    return o


def main(argv=None):
    o = options(argv)
    McpServer(o).serve()


if __name__ == "__main__":
    main()

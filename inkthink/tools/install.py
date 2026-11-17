"""ThinkPaper 一步安装（只支持 Windows）。仓库根目录的 install.bat 找到 Python 后调用它；只用标准库。

用法：
    双击仓库根目录的 install.bat
    install.bat --dry-run        只列出会做什么，什么都不改（不建环境、不装、不运行 claude、不弹管理员确认、不启动服务）

按顺序做九步，每一步先说要做什么，做完说结果；已经做过的跳过并说明，所以可以重复运行：
    1. 检查 Python 版本（3.10 以上）
    2. 建环境 inkthink\\.venv（只用自己的包；以前建的借用了系统里的包，就改成不借）
    3. 装依赖（requirements.txt）
    4. 找到 claude 命令（命令行版；没有就用 VS Code 扩展自带的 claude.exe）
    5. 登记插件市场：claude plugin marketplace add <仓库>\\inkpad-plugin
    6. 安装插件：claude plugin install inkpad@inkthink-local
    7. 填好插件的启动命令 server_command：claude plugin configure inkpad@inkthink-local --values-stdin
       （做不到时把要填的那一行打出来、复制到剪贴板，说明贴到哪里）
    8. 查防火墙：没放行时说明原因，弹一次管理员确认来加规则；点「否」也能装完
    9. 在后台启动服务，打开配对二维码页

不改 config.json（只读其中的 port、host），不动 data\\。
外部命令都经过 Runner（测试里换成假的）；会改东西的命令都标着 changes=True，演练时一条也不跑。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import webbrowser
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # inkthink\

MIN_PY = (3, 10)
MIN_CONFIGURE = (2, 1, 285)  # `claude plugin configure --values-stdin` 从这一版起有（见插件命令文档的 plugin configure 一节）
DEFAULT_PORT = 8765
STAMP = "thinkpaper-requirements.txt"  # 装依赖成功后，把当时的 requirements.txt 抄一份放进 .venv：没变就不重装
CORE_IMPORTS = "import pymupdf, qrcode, numpy, PIL"
# 可选的包：以前的环境借用系统里的包时能用、改成不借以后要补装进环境的
EXTRAS = (("本机认字（RapidOCR）", "local OCR (RapidOCR)", ("rapidocr", "onnxruntime"),
           "import onnxruntime; from rapidocr import ModelType, OCRVersion, RapidOCR"),)  # 和 ocr.py 的写法一样
LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")

DONE, SKIP, PLAN, WARN, FAIL, BLOCKED = "done", "skip", "plan", "warn", "fail", "blocked"
TAGS = {DONE: "完成 OK", SKIP: "跳过 SKIP", PLAN: "演练 DRY", WARN: "注意 NOTE", FAIL: "失败 FAIL",
        BLOCKED: "没做 NOT RUN"}


@dataclass
class Done:
    """一条命令的结果：退出码、标准输出、错误输出。"""
    code: int
    out: str = ""
    err: str = ""

    @property
    def text(self):
        """给人看的：两样合在一起。"""
        return "\n".join(s for s in (self.out, self.err) if s and s.strip())


@dataclass
class Outcome:
    status: str
    zh: str
    en: str
    fix_zh: str = ""
    fix_en: str = ""


class Runner:
    """所有外部命令都经过这里；测试里换成假的。命令找不到、超时都不抛出，返回非 0 的退出码和原因。"""

    def run(self, argv, *, input=None, env=None, cwd=None, timeout=None, live=False, changes=False):
        # changes 只是标记（这条命令会不会改东西），真的执行器不看它
        try:
            if live:  # 输出直接显示在窗口里（装依赖时看得到进度）
                p = subprocess.run([str(a) for a in argv], stdin=subprocess.DEVNULL, env=env, cwd=cwd, timeout=timeout)
                return Done(p.returncode)
            p = subprocess.run([str(a) for a in argv], input=None if input is None else input.encode("utf-8"),
                               stdin=None if input is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=cwd, timeout=timeout)
            return Done(p.returncode, _decode(p.stdout), _decode(p.stderr))
        except subprocess.TimeoutExpired:
            return Done(-1, "", f"timed out after {timeout} s")
        except OSError as e:
            return Done(-2, "", str(e))

    def open_url(self, url):
        webbrowser.open(url)


def _decode(b):
    if not b:
        return ""
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("mbcs" if sys.platform == "win32" else "latin-1", errors="replace")


# ------------------------------------------------------------ 小工具（单独可测）

def quote(p):
    """路径里有空格就加引号（插件按空格分参数，引号里的算一个；路径里不会有引号）。"""
    s = str(p)
    return f'"{s}"' if any(c.isspace() for c in s) else s


def split_command(cmd):
    """和插件 register.tsx 里的 splitArgv 一样：引号里的算一个参数，其余按空白分。"""
    return [m.group(1) if m.group(1) is not None else m.group(2)
            for m in re.finditer(r'"([^"]*)"|(\S+)', cmd or "")]


def norm_path(p):
    return os.path.normcase(os.path.normpath(str(p)))


def same_command(a, b):
    """两条启动命令是不是同一个意思（路径不分大小写、斜杠方向；引号加不加都一样）。"""
    def norm(cmd):
        return [norm_path(t) if ("\\" in t or "/" in t) else t for t in split_command(cmd)]
    return bool(a) and bool(b) and norm(a) == norm(b)


def parse_version(text):
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(x) for x in m.groups()) if m else None


def parse_json_out(text):
    """取命令输出里的 JSON：前后可能夹着几行别的（提示、警告、PowerShell 的 #< CLIXML）。
    从上往下找第一处以 [ 或 { 开头、从那里能读出一段完整 JSON 的行（后面多出来的不管）。"""
    lines = (text or "").strip().splitlines()
    dec = json.JSONDecoder()
    for i, line in enumerate(lines):
        if line.strip()[:1] in ("[", "{"):
            try:
                return dec.raw_decode("\n".join(lines[i:]).lstrip())[0]
            except ValueError:
                continue
    return None


def tail(text, n=6):
    lines = [ln for ln in (text or "").strip().splitlines() if ln.strip()]
    return "\n".join(lines[-n:])


def read_cfg_kv(path):
    """pyvenv.cfg：key = value 一行一个。"""
    out = {}
    try:
        for line in Path(path).read_text("utf-8", errors="replace").splitlines():
            k, sep, v = line.partition("=")
            if sep:
                out[k.strip().lower()] = v.strip()
    except OSError:
        pass
    return out


def venv_borrows(cfg_path):
    """环境是不是借用系统里的包（建环境时带了 --system-site-packages）。"""
    return read_cfg_kv(cfg_path).get("include-system-site-packages", "false").lower() == "true"


def stop_borrowing(cfg_path):
    """把 pyvenv.cfg 里的 include-system-site-packages 改成 false；别的行、换行方式都不动。"""
    raw = Path(cfg_path).read_bytes()
    new = re.sub(rb"(?im)^(\s*include-system-site-packages\s*=\s*)true(\s*)$", rb"\1false\2", raw)
    Path(cfg_path).write_bytes(new)


def port_in(spec, port):
    """防火墙规则的本地端口写法（"8765"、"80,443"、"8000-9000"、"*"）里有没有这个端口。"""
    for tok in str(spec or "").split(","):
        tok = tok.strip()
        if tok in ("*", "Any"):
            return True
        a, sep, b = tok.partition("-")
        if a.isdigit() and (b.isdigit() if sep else True):
            lo, hi = int(a), int(b) if sep else int(a)
            if lo <= port <= hi:
                return True
    return False


def judge_firewall(state, port, programs):
    """state 是 FW_CHECK 查到的 {on, current, rules:[{ours, allow, profiles, ports, app}]}。
    返回 (放行了没有, 为什么（中、英）, 有没有挡着它的规则)。
    只看对当前网络生效、TCP（或任意协议）、管得到这个端口和这个 Python 的规则；挡的规则比放行的优先。"""
    if not state.get("on"):
        return True, ("Windows 防火墙对当前网络是关着的", "Windows Firewall is off for the current network"), False
    cur = int(state.get("current") or 0)
    progs = {norm_path(p) for p in programs if p}
    rules = state.get("rules") or []
    if isinstance(rules, dict):
        rules = [rules]
    why, blocked = None, False
    for r in rules:
        profiles = int(r.get("profiles") or 0)
        if cur and not (profiles & cur):
            continue
        app = (r.get("app") or "").strip()
        if app and norm_path(app) not in progs:
            continue  # 别的程序的规则，管不到草稿纸服务
        ports = str(r.get("ports") or "")
        if not (port_in(ports, port) or (app and ports in ("", "*"))):
            continue
        if not r.get("allow"):
            blocked = True
        elif why is None:
            if r.get("ours"):
                why = (f"已有规则 InkThink {port} (LAN)", f"the rule InkThink {port} (LAN) exists")
            elif app:
                why = (f"已有一条规则放行这个 Python：{app}", f"a rule allows this Python: {app}")
            else:
                why = (f"已有一条规则放行 {port} 端口", f"a rule allows port {port}")
    return why is not None, why, blocked


# 查防火墙（不用管理员权限）：用 HNetCfg.FwPolicy2 读规则，只挑可能相关的几条交给 Python 判断。
# 规则名不输出（可能是任何文字），只输出是不是我们那条。
FW_CHECK = r"""
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
$fw = New-Object -ComObject HNetCfg.FwPolicy2
$cur = [int]$fw.CurrentProfileTypes
$on = $false
foreach ($t in 1, 2, 4) { if (($cur -band $t) -and $fw.FirewallEnabled($t)) { $on = $true } }
$name = 'InkThink __PORT__ (LAN)'
$rules = @()
foreach ($r in $fw.Rules) {
  if ($r.Direction -ne 1 -or -not $r.Enabled) { continue }
  if ($r.Protocol -ne 6 -and $r.Protocol -ne 256) { continue }
  $app = [string]$r.ApplicationName
  $ports = [string]$r.LocalPorts
  $ours = ($r.Name -eq $name)
  $maybe = $ours -or ($app -match 'python') -or ($ports -match '(^|,)\s*__PORT__\s*(,|$)') -or ($ports -match '\d-\d')
  if (-not $maybe) { continue }
  $rules += [pscustomobject]@{ ours = $ours; allow = ($r.Action -eq 1); profiles = [int]$r.Profiles;
    ports = $ports; app = [Environment]::ExpandEnvironmentVariables($app) }
}
ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ on = $on; current = $cur; rules = $rules })
"""

# 弹一次管理员确认（UAC），在管理员身份的 PowerShell 里执行 open-firewall.ps1 的内容。
# 内容整段编码后传过去：路径里有空格、中文都不用转义，也不受脚本执行策略限制。点「否」时退出码 1223。
FW_ELEVATE = (
    "try { Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -WindowStyle Hidden "
    "-ArgumentList '-NoProfile -NonInteractive -EncodedCommand __ENC__' -ErrorAction Stop | Out-Null; exit 0 } "
    "catch { $e = $_.Exception; while ($e) { if ($e.NativeErrorCode -eq 1223) { exit 1223 }; "
    "$e = $e.InnerException }; exit 1 }"
)


def encode_ps(script):
    return base64.b64encode(script.encode("utf-16-le")).decode("ascii")


# ------------------------------------------------------------ 安装

class Installer:
    def __init__(self, root=ROOT, runner=None, *, dry_run=False, out=None, env=None, python=None,
                 py_version=None, platform=None):
        self.root = Path(root)
        self.repo = self.root.parent
        self.plugin_dir = self.repo / "inkpad-plugin"
        self.venv = self.root / ".venv"
        self.venv_py = self.venv / "Scripts" / "python.exe"
        self.req = self.root / "requirements.txt"
        self.launch = self.root / "launch.py"
        self.fw_script = self.root / "open-firewall.ps1"
        self.runner = runner or Runner()
        self.dry = dry_run
        self.out = out or sys.stdout
        self.env = dict(os.environ if env is None else env)
        self.python = python or sys.executable
        self.py_version = tuple(py_version or sys.version_info[:3])
        self.platform = platform or sys.platform
        self.market, self.plugin = self._names()
        self.plugin_id = f"{self.plugin}@{self.market}"
        cfg = self._config()
        try:
            self.port = int(cfg.get("port") or DEFAULT_PORT)
        except (TypeError, ValueError):
            self.port = DEFAULT_PORT
        self.host = str(cfg.get("host") or "")
        self.claude = None
        self.claude_version = None
        self.flipped = False  # 这次把环境从「借用系统里的包」改成了不借
        self.borrowed = []  # 改之前能用的可选包（EXTRAS 里的），装依赖时补装进环境
        self.results = []

    # ---------- 读设置（只读）

    def _names(self):
        """插件市场和插件的名字，从 inkpad-plugin\\.claude-plugin\\marketplace.json 里读。"""
        try:
            m = json.loads((self.plugin_dir / ".claude-plugin" / "marketplace.json").read_text("utf-8-sig"))
            return m["name"], m["plugins"][0]["name"]
        except (OSError, ValueError, KeyError, IndexError, TypeError):
            return "inkthink-local", "inkpad"

    def _config(self):
        """config.json 里的 port、host（只读，不改；没有或读不了就用默认）。"""
        try:
            cfg = json.loads((self.root / "config.json").read_text("utf-8-sig"))
            return cfg if isinstance(cfg, dict) else {}
        except (OSError, ValueError):
            return {}

    def server_command(self):
        return f"{quote(self.venv_py)} {quote(self.launch)}"

    def wanted_options(self):
        want = {"server_command": self.server_command()}
        if self.port != DEFAULT_PORT:  # 插件默认连 8765；config.json 换了端口，地址也要跟着换
            want["server_url"] = f"http://127.0.0.1:{self.port}"
        return want

    def base_pythons(self):
        """真正在跑服务的 python.exe：环境里的 python.exe 只是个转发器，监听端口的是建环境用的那个 Python。"""
        kv = read_cfg_kv(self.venv / "pyvenv.cfg")
        out = [self.venv_py]
        if kv.get("executable"):
            out.append(kv["executable"])
        if kv.get("home"):
            out.append(Path(kv["home"]) / "python.exe")
        if not kv:
            out.append(self.python)
        return out

    # ---------- 输出

    def say(self, zh, en="", indent=6):
        pad = " " * indent
        for line in zh.splitlines() or [""]:
            print(pad + line, file=self.out)
        for line in en.splitlines():
            print(pad + "  " + line, file=self.out)

    def show_cmd(self, argv):
        print("      > " + subprocess.list2cmdline([str(a) for a in argv]), file=self.out)

    # ---------- 跑命令

    def _run(self, argv, *, changes=False, **kw):
        if changes and self.dry:
            raise RuntimeError("dry run must not change anything")
        return self.runner.run(argv, changes=changes, **kw)

    def _probe(self, code):
        """在环境里试 import（只读；-B 不写 .pyc）。"""
        return self._run([self.venv_py, "-B", "-c", code], cwd=str(self.venv), timeout=120).code == 0

    def _claude(self, *args, changes=False, input=None, timeout=180):
        # 在用户文件夹里运行：不让哪个项目文件夹里的 .claude 设置掺进来（装在用户范围）
        home = self.env.get("USERPROFILE")
        cwd = home if home and Path(home).is_dir() else str(self.repo)
        return self._run([self.claude, *args], changes=changes, input=input, timeout=timeout, cwd=cwd)

    def _powershell(self):
        exe = Path(self.env.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        return str(exe) if exe.is_file() else "powershell"

    # ---------- 九步

    def step_python(self):
        v = ".".join(str(x) for x in self.py_version)
        if self.platform != "win32":
            return Outcome(FAIL, "这个安装程序只支持 Windows。", "This installer supports Windows only.")
        if self.py_version[:2] < MIN_PY:
            return Outcome(FAIL, f"现在用的 Python 是 {v}，要 3.10 或更新的。", f"Python {v} is too old; 3.10+ is needed.",
                           "到 https://www.python.org/downloads/ 装新版（装的时候勾上「Add python.exe to PATH」），"
                           "再运行 install.bat。",
                           "Install a newer Python from https://www.python.org/downloads/ (tick \"Add python.exe to "
                           "PATH\"), then run install.bat again.")
        return Outcome(DONE, f"Python {v}（{self.python}）", f"Python {v} ({self.python})")

    def step_venv(self):
        cfg = self.venv / "pyvenv.cfg"
        if self.venv_py.is_file():
            r = self._run([self.venv_py, "-B", "-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"],
                          cwd=str(self.venv), timeout=120)
            if r.code != 0:
                return Outcome(
                    FAIL, "环境 inkthink\\.venv 在，但用不了（多半是建它的那个 Python 卸载、升级或挪了地方）。",
                    "inkthink\\.venv exists but does not run (the Python it was made from was probably removed, "
                    "upgraded or moved).",
                    "先停掉草稿纸服务（二维码页上的「停止服务」），删掉 inkthink\\.venv 文件夹，再运行 install.bat。",
                    "Stop the ThinkPaper service (\"Stop service\" on the QR page), delete the inkthink\\.venv "
                    "folder, then run install.bat again.")
            ver = r.out.strip().splitlines()[-1] if r.out.strip() else "?"
            if venv_borrows(cfg):
                self.borrowed = [x for x in EXTRAS if self._probe(x[3])]
                more = ("；原来能用的" + "、".join(x[0] for x in self.borrowed) + "改完后要是用不了，也补装进环境") \
                    if self.borrowed else ""
                more_en = ("; " + ", ".join(x[1] for x in self.borrowed) + " works now and will be installed into it "
                           "too if it stops working") if self.borrowed else ""
                if self.dry:
                    self.flipped = True
                    return Outcome(PLAN, f"环境在（Python {ver}），但设成了借用系统里装的包。会改成只用自己的包"
                                         f"（pyvenv.cfg 里 include-system-site-packages 改成 false），下一步把依赖装进环境{more}。",
                                   f"The environment exists (Python {ver}) but borrows system packages. Would set "
                                   f"include-system-site-packages = false in pyvenv.cfg and install the dependencies "
                                   f"into it{more_en}.")
                try:
                    stop_borrowing(cfg)
                except OSError as e:
                    return Outcome(FAIL, f"改不了 inkthink\\.venv\\pyvenv.cfg（{e}）。", f"Cannot edit pyvenv.cfg ({e}).",
                                   "用记事本打开它，把 include-system-site-packages = true 改成 false，再运行 install.bat。",
                                   "Open it in Notepad, change include-system-site-packages = true to false, "
                                   "then run install.bat again.")
                self.flipped = True
                return Outcome(DONE, f"环境在（Python {ver}）。它原来借用系统里装的包，已改成只用自己的包"
                                     f"（pyvenv.cfg 里 include-system-site-packages = false），下一步把依赖装进环境{more}。",
                               f"The environment exists (Python {ver}). It used to borrow system packages; it now "
                               f"uses only its own (include-system-site-packages = false). The next step installs "
                               f"the dependencies into it{more_en}.")
            return Outcome(SKIP, f"环境已经建好（Python {ver}），不重建。", f"The environment already exists (Python {ver}).")
        argv = [self.python, "-m", "venv", self.venv]
        if self.dry:
            self.show_cmd(argv)
            return Outcome(PLAN, "会建环境 inkthink\\.venv（只用自己的包，不借系统里的）。",
                           "Would create inkthink\\.venv (its own packages only).")
        self.say("正在建环境 inkthink\\.venv ……", "Creating inkthink\\.venv ...")
        self.show_cmd(argv)
        r = self._run(argv, changes=True, live=True, timeout=900)
        if r.code != 0 or not self.venv_py.is_file():
            return Outcome(FAIL, "建环境没成功（上面是出错信息）。", "Creating the environment failed (see above).",
                           "在 inkthink 文件夹里打开命令行，运行  python -m venv .venv  看它报什么错；"
                           "改好后再运行 install.bat。",
                           "Open a terminal in the inkthink folder and run  python -m venv .venv  to see the error; "
                           "fix it and run install.bat again.")
        return Outcome(DONE, "环境建好了：inkthink\\.venv", "Created inkthink\\.venv")

    def step_deps(self):
        argv = [self.venv_py, "-m", "pip", "install", "--disable-pip-version-check", "-r", self.req]
        manual = subprocess.list2cmdline([str(a) for a in argv])
        if not self.venv_py.is_file():
            if not self.dry:
                return Outcome(FAIL, "找不到 inkthink\\.venv\\Scripts\\python.exe。", "inkthink\\.venv\\Scripts\\python.exe is missing.",
                               "删掉 inkthink\\.venv 文件夹，再运行 install.bat。",
                               "Delete the inkthink\\.venv folder and run install.bat again.")
            self.show_cmd(argv)  # 演练、环境还没建
            return Outcome(PLAN, "建好环境以后，会用 pip 装 requirements.txt 里的依赖（要联网）。",
                           "After creating the environment, would pip-install requirements.txt (needs internet).")
        stamp = self.venv / STAMP
        try:
            same = stamp.is_file() and stamp.read_bytes() == self.req.read_bytes()
        except OSError:
            same = False
        if same and not self.flipped and self._probe(CORE_IMPORTS):
            return Outcome(SKIP, "依赖已经装好（requirements.txt 没变过），不重装。",
                           "Dependencies are already installed (requirements.txt unchanged).")
        if self.dry:
            self.show_cmd(argv)
            more = ("；" + "、".join(x[0] for x in self.borrowed) + "用不了的话也补装") if self.borrowed else ""
            more_en = ("; also " + ", ".join(x[1] for x in self.borrowed) + " if needed") if self.borrowed else ""
            return Outcome(PLAN, f"会用 pip 装 requirements.txt 里的依赖（要联网；已经装好的不重装）{more}。",
                           f"Would pip-install requirements.txt (needs internet; installed ones are kept){more_en}.")
        self.say("正在装依赖（要联网，第一次要下载几十 MB，请稍等）……",
                 "Installing dependencies (needs internet; the first time downloads tens of MB) ...")
        self.show_cmd(argv)
        fix_zh = f"联网后重新运行 install.bat（装好了的不会重装）。也可以手动运行：\n  {manual}"
        fix_en = f"Connect to the internet and run install.bat again (installed packages are kept), or run:\n  {manual}"
        env = dict(self.env, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        r = self._run(argv, changes=True, live=True, env=env, timeout=3600)
        if r.code != 0:
            return Outcome(FAIL, "装依赖没成功（上面是 pip 的出错信息）。常见原因：没联网、下载太慢或被拦。",
                           "Installing dependencies failed (see pip's messages above). Usually: no internet, "
                           "a slow download, or a blocked connection.", fix_zh, fix_en)
        if not self._probe(CORE_IMPORTS):
            return Outcome(FAIL, "pip 跑完了，但环境里还是用不了 PyMuPDF、qrcode、numpy、Pillow 里的某一个。",
                           "pip finished, but PyMuPDF / qrcode / numpy / Pillow still cannot be imported.",
                           fix_zh, fix_en)
        notes_zh, notes_en = [], []
        for zh, en, pkgs, code in self.borrowed:
            if self._probe(code):
                continue
            extra = [self.venv_py, "-m", "pip", "install", "--disable-pip-version-check", *pkgs]
            self.say(f"补装{zh}（原来借用系统里的包才能用）……", f"Installing {en} (it used to rely on system packages) ...")
            self.show_cmd(extra)
            if self._run(extra, changes=True, live=True, env=env, timeout=3600).code != 0 or not self._probe(code):
                notes_zh.append(f"{zh}没装上：草稿纸照常能用，只是少这一项旁证。以后手动装：\n  "
                                + subprocess.list2cmdline([str(a) for a in extra]))
                notes_en.append(f"{en} could not be installed; ThinkPaper still works without it. To retry:\n  "
                                + subprocess.list2cmdline([str(a) for a in extra]))
        try:
            shutil.copyfile(self.req, stamp)
        except OSError:
            pass  # 记不下来只是下次再跑一遍 pip
        if notes_zh:
            return Outcome(WARN, "依赖装好了。\n" + "\n".join(notes_zh), "Dependencies installed.\n" + "\n".join(notes_en))
        return Outcome(DONE, "依赖装好了。", "Dependencies installed.")

    def claude_candidates(self):
        """能找到的 claude.exe，按先后：命令行里的 claude、原生安装的位置、WinGet、VS Code 一类编辑器的扩展自带的。"""
        found, seen = [], set()

        def add(path, how, version=None):
            p = Path(path)
            if p.is_file() and norm_path(p) not in seen:
                seen.add(norm_path(p))
                found.append((p, how, version))

        w = shutil.which("claude", path=self.env.get("PATH", ""))
        if w:
            p = Path(w)
            p = p.with_suffix(p.suffix.lower())  # which() 按 PATHEXT 的写法给出 .EXE、.CMD
            if p.suffix.lower() in (".cmd", ".bat"):  # npm 装的：直接用包里的 claude.exe，参数不经过 cmd
                add(p.parent / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe", "PATH (npm)")
            add(p, "PATH")
        home = self.env.get("USERPROFILE")
        if home:
            add(Path(home) / ".local" / "bin" / "claude.exe", "native installer")
        local = self.env.get("LOCALAPPDATA")
        if local:
            add(Path(local) / "Microsoft" / "WinGet" / "Links" / "claude.exe", "WinGet")
        if home:
            exts = []
            for editor in (".vscode", ".vscode-insiders", ".cursor", ".windsurf"):
                base = Path(home) / editor / "extensions"
                if base.is_dir():
                    for d in base.glob("anthropic.claude-code-*"):
                        exts.append((parse_version(d.name) or (0, 0, 0), d, editor))
            for ver, d, editor in sorted(exts, key=lambda x: x[0], reverse=True):
                add(d / "resources" / "native-binary" / "claude.exe", f"{editor} extension",
                    ver if ver != (0, 0, 0) else None)
        return found

    def step_claude(self):
        cands = self.claude_candidates()
        if not cands:
            return Outcome(
                FAIL, "没找到 claude 命令，插件装不了。", "The claude command was not found, so the plugin cannot be installed.",
                "装 Claude Code 命令行版：打开 PowerShell 运行  irm https://claude.ai/install.ps1 | iex\n"
                "（或者  winget install Anthropic.ClaudeCode），装好后重新运行 install.bat。\n"
                "只用 VS Code 扩展的话：先在 VS Code 里装好 Claude Code 扩展并打开一次，再运行 install.bat，"
                "它会用扩展自带的 claude.exe。",
                "Install the Claude Code CLI: in PowerShell run  irm https://claude.ai/install.ps1 | iex\n"
                "(or  winget install Anthropic.ClaudeCode), then run install.bat again.\n"
                "If you only use the VS Code extension: install it and open it once in VS Code, then run "
                "install.bat; it will use the claude.exe bundled with the extension.")
        if self.dry:  # 演练不运行 claude（连查版本也不跑）
            path, how, ver = cands[0]
            self.claude, self.claude_version = path, ver
            v = ".".join(map(str, ver)) if ver else ""
            return Outcome(PLAN, f"会用：{path}（{how}，版本 {v or '演练时不查'}）",
                           f"Would use: {path} ({how}, version {v or 'not checked in a dry run'})")
        # 按先后用第一个够新的（有 plugin configure 的）；都不够新就用能运行的里面最新的
        best = None
        for path, how, ver in cands:
            r = self._run([path, "--version"], timeout=60)
            if r.code != 0:
                continue
            got = parse_version(r.out) or ver
            if got and got >= MIN_CONFIGURE:
                best = (path, how, got)
                break
            if best is None or (got or (0,)) > (best[2] or (0,)):
                best = (path, how, got)
        if best is None:
            path, how, ver = cands[0]
            return Outcome(FAIL, f"找到了 {path}，但运行不了。", f"Found {path} but it does not run.",
                           "在命令行里运行  claude --version  看报什么错；或者重装 Claude Code 命令行版"
                           "（PowerShell 里运行  irm https://claude.ai/install.ps1 | iex）。",
                           "Run  claude --version  to see the error, or reinstall the Claude Code CLI "
                           "(PowerShell:  irm https://claude.ai/install.ps1 | iex).")
        self.claude, how, self.claude_version = best
        v = ".".join(map(str, self.claude_version)) if self.claude_version else "?"
        zh, en = f"用的是：{self.claude}（{how}，版本 {v}）", f"Using: {self.claude} ({how}, version {v})"
        if "extension" in how:
            zh += "\n这是编辑器扩展自带的 claude.exe：这次安装用它，装好以后不再用到这个路径。"
            en += "\nThis is the claude.exe bundled with the editor extension; it is only used for this install."
        return Outcome(DONE, zh, en)

    def _same_dir(self, entry):
        p = entry.get("path") or ""
        if not p:
            return False
        p = Path(p)
        if p.name.lower() == "marketplace.json":
            p = p.parent.parent
        return norm_path(p) == norm_path(self.plugin_dir)

    def step_marketplace(self):
        argv = ["plugin", "marketplace", "add", str(self.plugin_dir)]
        if self.dry:
            self.show_cmd([self.claude, *argv])
            return Outcome(PLAN, f"会登记插件市场 {self.market}（已经登记过就跳过；演练不运行 claude，所以这里不知道登记过没有）。",
                           f"Would add the plugin marketplace {self.market} (skipped if already added; a dry run "
                           f"does not run claude, so it cannot tell).")
        r = self._claude("plugin", "marketplace", "list", "--json")
        entries = parse_json_out(r.out) if r.code == 0 else None
        if isinstance(entries, list):
            e = next((x for x in entries if isinstance(x, dict) and x.get("name") == self.market), None)
            if e and self._same_dir(e):
                return Outcome(SKIP, f"插件市场 {self.market} 已经登记过，指向这个文件夹。",
                               f"The marketplace {self.market} is already added from this folder.")
            if e:
                where = e.get("path") or e.get("repo") or e.get("url") or e.get("source") or "?"
                return Outcome(
                    FAIL, f"已经登记了一个同名的插件市场 {self.market}，但它指向别处：{where}\n"
                          f"为了不动那边装好的插件和它的设置，这次不改它。",
                    f"A marketplace named {self.market} is already added from somewhere else: {where}\n"
                    f"It is left untouched so the plugin installed from it keeps its settings.",
                    f"要改用这个文件夹：先运行  claude plugin marketplace remove {self.market}\n"
                    f"（会一并卸掉从那里装的 {self.plugin} 插件和它的设置），再运行 install.bat。\n"
                    f"要继续用那边的：到那个文件夹里运行 install.bat。",
                    f"To use this folder instead, run  claude plugin marketplace remove {self.market}\n"
                    f"(this also uninstalls the {self.plugin} plugin installed from it, with its settings), "
                    f"then run install.bat again.\nTo keep the other one, run install.bat from that folder.")
        self.say(f"正在登记插件市场 {self.market} ……", f"Adding the plugin marketplace {self.market} ...")
        self.show_cmd([self.claude, *argv])
        r = self._claude(*argv, changes=True)
        if r.code != 0:
            return Outcome(FAIL, f"登记插件市场没成功：\n{tail(r.text)}", f"Adding the marketplace failed:\n{tail(r.text)}",
                           "手动运行：claude " + subprocess.list2cmdline(argv),
                           "Run it by hand: claude " + subprocess.list2cmdline(argv))
        if "already" in r.text.lower():
            return Outcome(SKIP, f"插件市场 {self.market} 已经登记过。", f"The marketplace {self.market} was already added.")
        return Outcome(DONE, f"登记好了插件市场 {self.market}。", f"Added the marketplace {self.market}.")

    def step_plugin(self):
        argv = ["plugin", "install", self.plugin_id, "--scope", "user"]
        if self.dry:
            self.show_cmd([self.claude, *argv])
            return Outcome(PLAN, f"会安装插件 {self.plugin_id}（已经装过就跳过）。",
                           f"Would install the plugin {self.plugin_id} (skipped if already installed).")
        r = self._claude("plugin", "list", "--json")
        items = parse_json_out(r.out) if r.code == 0 else None
        if isinstance(items, dict):
            items = items.get("installed")
        mine = [x for x in items if isinstance(x, dict) and x.get("id") == self.plugin_id] if isinstance(items, list) else []
        user = next((x for x in mine if x.get("scope") in ("user", None)), None)
        if user:
            if user.get("enabled") is False:
                en_argv = ["plugin", "enable", self.plugin_id, "--scope", "user"]
                self.show_cmd([self.claude, *en_argv])
                r = self._claude(*en_argv, changes=True)
                if r.code != 0:
                    return Outcome(WARN, f"插件已经装着，但被关掉了；重新打开没成功：\n{tail(r.text)}",
                                   f"The plugin is installed but disabled, and enabling it failed:\n{tail(r.text)}",
                                   "在 Claude Code 里输入 /plugin，在 Installed 里把 inkpad 打开。",
                                   "In Claude Code, type /plugin and enable inkpad under Installed.")
                return Outcome(DONE, "插件已经装着，但被关掉了；已经重新打开。", "The plugin was installed but disabled; enabled it.")
            return Outcome(SKIP, f"插件 {self.plugin_id} 已经装好。", f"The plugin {self.plugin_id} is already installed.")
        self.say(f"正在安装插件 {self.plugin_id} ……", f"Installing the plugin {self.plugin_id} ...")
        self.show_cmd([self.claude, *argv])
        r = self._claude(*argv, changes=True)
        if r.code != 0:
            return Outcome(FAIL, f"安装插件没成功：\n{tail(r.text)}", f"Installing the plugin failed:\n{tail(r.text)}",
                           "手动运行：claude " + subprocess.list2cmdline(argv),
                           "Run it by hand: claude " + subprocess.list2cmdline(argv))
        return Outcome(DONE, f"插件 {self.plugin_id} 装好了。", f"Installed the plugin {self.plugin_id}.")

    def _manual_config(self, why_zh, why_en):
        """自动填不了：把要填的那一行打出来、复制到剪贴板，说明贴到哪里。"""
        line = self.server_command()
        copied = False
        if not self.dry:
            r = self._run([self._powershell(), "-NoProfile", "-NonInteractive", "-Command",
                           "Set-Clipboard -Value $env:INK_CLIP"],
                          env=dict(self.env, INK_CLIP=line), changes=True, timeout=60)
            copied = r.code == 0
        extra_zh = extra_en = ""
        if self.port != DEFAULT_PORT:
            extra_zh = f"\n「草稿纸服务地址」填：http://127.0.0.1:{self.port}"
            extra_en = f"\nSet \"server_url\" to: http://127.0.0.1:{self.port}"
        return Outcome(
            WARN, f"没能自动填好插件的启动命令：{why_zh}", f"Could not fill in the plugin's start command: {why_en}",
            f"在 Claude Code 里输入  /plugin configure {self.plugin_id}\n"
            f"把「启动草稿纸服务的命令」填成下面这一行{'（已复制到剪贴板）' if copied else ''}：\n  {line}{extra_zh}",
            f"In Claude Code, type  /plugin configure {self.plugin_id}\n"
            f"and set \"server_command\" to this line{' (copied to the clipboard)' if copied else ''}:\n  {line}{extra_en}")

    def step_configure(self):
        want = self.wanted_options()
        self.say("启动命令 / start command:  " + want["server_command"])
        argv = ["plugin", "configure", self.plugin_id, "--values-stdin"]
        if self.dry:
            self.show_cmd([self.claude, *argv])
            return Outcome(PLAN, "会把这一行填进插件设置的 server_command（已经是这一行就跳过）。",
                           "Would save this line as the plugin's server_command (skipped if already set).")
        if self.claude_version and self.claude_version < MIN_CONFIGURE:
            v = ".".join(map(str, self.claude_version))
            return self._manual_config(f"这个版本的 claude（{v}）还没有 plugin configure 命令（2.1.285 起才有）。",
                                       f"claude {v} has no `plugin configure` yet (it arrived in 2.1.285).")
        r = self._claude("plugin", "configure", self.plugin_id, "--json")
        cur = parse_json_out(r.out) if r.code == 0 else None
        inputs = {}
        if isinstance(cur, dict):
            raw = cur.get("inputs")
            if isinstance(raw, dict):
                inputs = raw
            configured = cur.get("configured")
            if isinstance(configured, list):
                inputs = {k: v for k, v in inputs.items() if k in configured}
        todo = {}
        for k, v in want.items():
            have = inputs.get(k)
            same = same_command(have, v) if k == "server_command" else (str(have or "").rstrip("/") == v)
            if not same:
                todo[k] = v
        if not todo:
            return Outcome(SKIP, "插件的启动命令已经是这一行。", "The plugin's start command is already set to this line.")
        old = inputs.get("server_command")
        if old and "server_command" in todo:
            self.say(f"原来填的是：{old}\n改成这个文件夹的。", f"It was: {old}\nChanging it to this folder.")
        self.say("正在填插件的启动命令 ……", "Saving the plugin's start command ...")
        self.show_cmd([self.claude, *argv])
        r = self._claude(*argv, changes=True, input=json.dumps(todo))
        if r.code != 0:
            return self._manual_config(tail(r.text, 3) or f"exit {r.code}", tail(r.text, 3) or f"exit {r.code}")
        return Outcome(DONE, "填好了插件的启动命令（重开 Claude Code 后生效）。",
                       "Saved the plugin's start command (takes effect after restarting Claude Code).")

    def firewall_state(self):
        script = FW_CHECK.replace("__PORT__", str(self.port))
        r = self._run([self._powershell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                       "-EncodedCommand", encode_ps(script)], timeout=120)
        state = parse_json_out(r.out) if r.code == 0 else None
        return state if isinstance(state, dict) else None

    def step_firewall(self):
        manual_zh = ("以后要放行：右键「开始」按钮 →「终端（管理员）」，运行\n  powershell -ExecutionPolicy Bypass -File "
                     f"{quote(self.fw_script)} -Port {self.port}")
        manual_en = ("To allow it later: right-click Start -> Terminal (Admin), and run\n  powershell -ExecutionPolicy "
                     f"Bypass -File {quote(self.fw_script)} -Port {self.port}")
        if self.host.lower() in LOCAL_HOSTS:
            return Outcome(SKIP, "config.json 里设了只让本机连，不用放行防火墙。",
                           "config.json only accepts connections from this computer; no firewall rule is needed.")
        state = self.firewall_state()
        if state is None:
            return Outcome(WARN, "查不了防火墙规则，这一步没做。", "Could not read the firewall rules; skipped this step.",
                           manual_zh, manual_en)
        allowed, why, blocked = judge_firewall(state, self.port, self.base_pythons())
        block_zh = ("有一条规则在挡这个 Python（多半是以前 Windows 防火墙弹窗时点了「取消」）。挡的规则比放行的优先，"
                    "平板可能连不上。\n要去掉它：按 Win+R 输入 wf.msc → 入站规则 → 找名字是 python、带红色禁止图标的，"
                    "右键「禁用规则」。")
        block_en = ("A rule blocks this Python (probably from pressing Cancel on a Windows Firewall prompt). Block "
                    "rules win over allow rules, so the tablet may not connect.\nTo remove it: Win+R, wf.msc -> "
                    "Inbound Rules -> the python rule with a red block icon -> Disable Rule.")
        if allowed:
            if blocked:
                return Outcome(WARN, f"{why[0]}。但是：\n{block_zh}", f"{why[1]}, but:\n{block_en}")
            return Outcome(SKIP, f"不用加规则。{why[0]}", f"No rule needed: {why[1]}.")
        if self.dry:
            return Outcome(PLAN, f"防火墙没放行 {self.port} 端口：会说明原因，弹一次管理员确认来加规则。",
                           f"Port {self.port} is not allowed by the firewall: would explain why and ask once for "
                           f"administrator approval to add a rule.")
        self.say(f"平板要通过局域网连这台电脑的 {self.port} 端口，Windows 防火墙现在挡着它。\n"
                 f"接下来会弹出一次管理员确认，只加一条规则「InkThink {self.port} (LAN)」：只允许同一局域网里的设备连 "
                 f"{self.port} 端口。\n点「否」也能装完，只是平板可能连不上，以后可以再加。",
                 f"The tablet connects to port {self.port} on this computer over the local network, and Windows "
                 f"Firewall is blocking it.\nAn administrator prompt will appear once, to add one rule "
                 f"\"InkThink {self.port} (LAN)\" that only lets devices on the local network reach port {self.port}.\n"
                 f"Choosing No still finishes the install; the tablet may just not be able to connect.")
        try:
            body = "\n".join(ln for ln in self.fw_script.read_text("utf-8-sig").splitlines()
                             if not ln.lstrip().startswith("#"))
        except OSError as e:
            return Outcome(WARN, f"读不到 open-firewall.ps1（{e}），没加规则。", f"Cannot read open-firewall.ps1 ({e}).",
                           manual_zh, manual_en)
        inner = "& {\n" + body + "\n} -Port " + str(self.port)
        r = self._run([self._powershell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                       FW_ELEVATE.replace("__ENC__", encode_ps(inner))], changes=True, timeout=600)
        if r.code == 1223:
            return Outcome(WARN, "你点了「否」，没有加防火墙规则。别的步骤照常做，只是平板可能连不上。",
                           "You chose No, so no firewall rule was added. The other steps go on as usual; the tablet "
                           "may not be able to connect.", manual_zh, manual_en)
        state = self.firewall_state()
        allowed, why, blocked = judge_firewall(state, self.port, self.base_pythons()) if state else (False, None, False)
        if not allowed:
            return Outcome(WARN, "没能加上防火墙规则。", "The firewall rule could not be added.", manual_zh, manual_en)
        if blocked:
            return Outcome(WARN, f"加好了防火墙规则，但是：\n{block_zh}", f"Added the firewall rule, but:\n{block_en}")
        return Outcome(DONE, f"加好了防火墙规则「InkThink {self.port} (LAN)」（只放行同一局域网里的设备）。",
                       f"Added the firewall rule \"InkThink {self.port} (LAN)\" (local network only).")

    def step_start(self):
        url = f"http://127.0.0.1:{self.port}/qr"
        argv = [self.venv_py, self.launch]
        if self.dry:
            self.show_cmd(argv)
            return Outcome(PLAN, f"会在后台启动草稿纸服务（已经在运行就不重复启动），然后打开配对二维码页 {url}",
                           f"Would start the ThinkPaper service in the background (unless it is already running), "
                           f"then open the pairing QR page {url}")
        self.say("正在启动草稿纸服务 ……", "Starting the ThinkPaper service ...")
        self.show_cmd(argv)
        r = self._run(argv, changes=True, cwd=str(self.root), timeout=120,
                      env=dict(self.env, PYTHONIOENCODING="utf-8"))
        if r.code != 0:
            return Outcome(FAIL, f"服务没能启动：\n{tail(r.text, 4)}", f"The service did not start:\n{tail(r.text, 4)}",
                           "看 inkthink\\data\\server.log 最后几行；或者双击 inkthink\\start.bat，在窗口里启动，看得到出错信息。",
                           "Read the last lines of inkthink\\data\\server.log, or double-click inkthink\\start.bat to "
                           "run it in a window and see the error.")
        self.runner.open_url(url)
        if "already running" in r.out:
            return Outcome(SKIP, f"服务已经在运行；打开了配对二维码页 {url}\n"
                                 "（刚更新过代码的话，要在二维码页上点「停止服务」再运行 install.bat，才用上新代码。）",
                           f"The service is already running; opened the pairing QR page {url}\n"
                           "(If you just updated the code, press \"Stop service\" on the QR page and run install.bat "
                           "again to load it.)")
        return Outcome(DONE, f"服务启动了；打开了配对二维码页 {url}", f"The service started; opened the pairing QR page {url}")

    # ---------- 整个流程

    STEPS = (
        ("python", "检查 Python 版本", "Check the Python version", ()),
        ("venv", "建环境", "Create the environment", ("python",)),
        ("deps", "装依赖", "Install dependencies", ("venv",)),
        ("claude", "找到 claude 命令", "Find the claude command", ("python",)),
        ("marketplace", "登记插件市场", "Add the plugin marketplace", ("claude",)),
        ("plugin", "安装插件", "Install the plugin", ("marketplace",)),
        ("configure", "填好插件的启动命令", "Fill in the plugin's start command", ("plugin",)),
        ("firewall", "查防火墙", "Check the firewall", ("python",)),
        ("start", "启动服务、打开配对二维码页", "Start the service and open the QR page", ("deps",)),
    )

    def run_all(self):
        n = len(self.STEPS)
        title = "ThinkPaper 安装（演练：只列出会做什么，什么都不改）" if self.dry else "ThinkPaper 安装"
        title_en = "ThinkPaper install (dry run: nothing will be changed)" if self.dry else "ThinkPaper install"
        print(f"{title}\n{title_en}\n", file=self.out)
        status, cause = {}, {}  # cause：没做的步骤是因为第几步失败
        for i, (key, zh, en, needs) in enumerate(self.STEPS, 1):
            print(f"[{i}/{n}] {zh} / {en}", file=self.out)
            bad = [k for k in needs if status.get(k) in (FAIL, BLOCKED)]
            if bad:
                cause[key] = j = cause.get(bad[0]) or next(idx for idx, s in enumerate(self.STEPS, 1) if s[0] == bad[0])
                res = Outcome(BLOCKED, f"没做：第 {j} 步没成功。", f"Not run: step {j} did not succeed.")
            else:
                try:
                    res = getattr(self, "step_" + key)()
                except Exception as e:  # noqa: BLE001 - 意外出错也要说清楚是哪一步
                    res = Outcome(FAIL, f"这一步意外出错：{e!r}", f"Unexpected error: {e!r}",
                                  "把这段输出发给作者；改好后重新运行 install.bat。",
                                  "Report this output; run install.bat again after fixing it.")
            status[key] = res.status
            self.results.append((key, zh, en, res))
            self.say(f"{TAGS[res.status]}  {res.zh}", res.en)
            if res.fix_zh:
                self.say("怎么补 / How to fix:", indent=6)
                self.say(res.fix_zh, res.fix_en, indent=8)
            print(file=self.out)
            if key == "python" and res.status == FAIL:
                break
        return self.summary()

    def summary(self):
        print("—— 结果 / Summary ——", file=self.out)
        for i, (key, zh, en, res) in enumerate(self.results, 1):
            print(f"  {i}. {TAGS[res.status]:<12} {zh} / {en}", file=self.out)
        failed = [(i, zh) for i, (_, zh, _, res) in enumerate(self.results, 1) if res.status == FAIL]
        print(file=self.out)
        if self.dry:
            self.say("演练结束：什么都没改。去掉 --dry-run 再运行才会真的安装。",
                     "Dry run finished: nothing was changed. Run without --dry-run to install.", indent=0)
            return 0
        if failed:
            steps = "、".join(f"第 {i} 步（{zh}）" for i, zh in failed)
            self.say(f"没装完：{steps}没成功，见上面的说明。改好后重新运行 install.bat，做过的步骤会跳过。",
                     "Not finished: see the steps marked FAIL above. Fix them and run install.bat again; finished "
                     "steps are skipped.", indent=0)
            return 1
        if any(res.status == WARN for *_, res in self.results):
            self.say("装好了，但有几处要你看一下：上面标着「注意 NOTE」的。",
                     "Installed, but see the items marked NOTE above.", indent=0)
        else:
            self.say("装好了。", "All set.", indent=0)
        self.say("下一步：重开 Claude Code（新装的插件和改过的设置重开以后才生效；VS Code 里可以用命令面板的"
                 "「Developer: Reload Window」），用平板扫二维码配对，然后在对话里输入 /ink。",
                 "Next: restart Claude Code (a newly installed plugin and changed settings take effect after a "
                 "restart; in VS Code you can run \"Developer: Reload Window\"), scan the QR code with the tablet, "
                 "then type /ink in the conversation.", indent=0)
        return 0


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="ThinkPaper 一步安装（只支持 Windows） / one-step install (Windows only)")
    ap.add_argument("--dry-run", action="store_true",
                    help="只列出会做什么，什么都不改 / only list what would be done; change nothing")
    args = ap.parse_args(argv)
    return Installer(ROOT, Runner(), dry_run=args.dry_run).run_all()


if __name__ == "__main__":
    sys.exit(main())

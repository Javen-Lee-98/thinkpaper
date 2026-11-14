"""在后台启动 InkThink 中转服务（不占窗口，关掉 Claude Code 也继续运行），然后退出。

inkpad 插件的 /ink 命令调用它；服务已经在运行就什么也不做。输出写到 data/server.log。
其余参数原样交给 server.py（例如 --port 8766）。

Windows 上经 WMI 启动：服务进程挂在系统的 WMI 服务下面，不是哪个 Claude Code 对话的子孙进程，
对话或 VS Code 窗口关掉、Claude Code 清理它启动过的进程时都不会连带结束它。
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# 用 WMI 创建进程（不显示窗口）；命令行和工作目录经环境变量传入，避免引号问题
PS_CREATE = (
    "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; "
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create "
    "-Arguments @{CommandLine=$env:INK_CMD; CurrentDirectory=$env:INK_CWD; ProcessStartupInformation=$si}; "
    "exit $r.ReturnValue"
)


def port(extra):
    if "--port" in extra:
        return int(extra[extra.index("--port") + 1])
    try:
        return int(json.loads((ROOT / "config.json").read_text("utf-8-sig")).get("port") or 8765)
    except (OSError, ValueError):
        return 8765


def alive(p):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{p}/bridge/ping", timeout=1) as r:
            return json.loads(r.read()).get("app") == "inkthink"
    except (OSError, ValueError):
        return False


def start_via_wmi(extra, log):
    # 用 python.exe（窗口隐藏）而不是 pythonw.exe：Windows 防火墙放行的是 python.exe，换成 pythonw 平板会连不上
    line = subprocess.list2cmdline([sys.executable, str(ROOT / "server.py"), "--log", str(log), *extra])
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", PS_CREATE],
                           env=dict(os.environ, INK_CMD=line, INK_CWD=str(ROOT)), capture_output=True, timeout=30)
        return r.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def start_detached(extra, log):
    """WMI 不可用时的老办法：脱离控制台的子进程。"""
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--log", str(log), *extra], cwd=ROOT,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                     creationflags=flags, close_fds=True)


def main():
    extra = sys.argv[1:]
    auto = "--auto" in extra  # 插件发现服务停了、自动重启时带上：用户自己停过的不重启
    extra = [a for a in extra if a != "--auto"]
    if auto and (ROOT / "data" / "stopped.flag").exists():
        print("stopped by user")
        return 0
    p = port(extra)
    if alive(p):
        print("already running")
        return 0
    (ROOT / "data").mkdir(exist_ok=True)
    log = ROOT / "data" / "server.log"
    how = "wmi"
    if sys.platform != "win32" or not start_via_wmi(extra, log):
        how = "detached"
        start_detached(extra, log)
    for _ in range(60):
        time.sleep(0.25)
        if alive(p):
            print(f"started ({how})")
            return 0
    print(f"服务没能启动，看 {log}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

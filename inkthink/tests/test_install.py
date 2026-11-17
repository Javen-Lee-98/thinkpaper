"""tools/install.py：一步安装的各步。

外部命令全部打桩：FakeWorld 扮演 Python、pip、claude、防火墙和服务，记下每条命令并记住装了什么
（所以第二遍运行看得到第一遍的结果）。只在临时文件夹里建假的仓库，路径带空格和中文；
不碰真的 claude、防火墙、网络和正在用的服务。"""
import base64
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import install  # noqa: E402
from install import BLOCKED, DONE, FAIL, PLAN, SKIP, WARN, Done  # noqa: E402

PLUGIN_ID = "inkpad@inkthink-local"
ALL_RULE_PROFILES = 0x7FFFFFFF


def ps_script(argv):
    """PowerShell 命令里的脚本文字（-EncodedCommand 解码，-Command 原样）。"""
    if "-EncodedCommand" in argv:
        return base64.b64decode(argv[argv.index("-EncodedCommand") + 1]).decode("utf-16-le")
    if "-Command" in argv:
        return argv[argv.index("-Command") + 1]
    return ""


class FakeWorld:
    def __init__(self, repo, python):
        self.repo = Path(repo)
        self.root = self.repo / "inkthink"
        self.venv_py = self.root / ".venv" / "Scripts" / "python.exe"
        self.python = str(python)
        self.calls, self.opened = [], []
        self.clipboard = None
        self.fail = set()  # 让哪些动作失败
        self.venv_ok = True
        self.importable = set()
        self.system_mods = {"fitz", "qrcode", "numpy", "PIL", "rapidocr", "onnxruntime"}  # 借用系统包时能 import 的
        self.versions = {}  # claude.exe 路径（小写）-> --version 的输出
        self.claude_version = "2.1.325 (Claude Code)"
        self.markets, self.plugins, self.options = {}, {}, {}
        self.fw = {"on": True, "current": 4, "rules": []}
        self.uac = "yes"
        self.elevated = None
        self.running = False

    # ---------- 执行器接口

    def run(self, argv, *, input=None, env=None, cwd=None, timeout=None, live=False, changes=False):
        argv = [str(a) for a in argv]
        self.calls.append({"argv": argv, "input": input, "changes": changes, "env": env})
        name = Path(argv[0]).name.lower()
        if argv[0] == self.python and argv[1:3] == ["-m", "venv"]:
            if "venv" in self.fail:
                return Done(1, "Error: cannot create venv")
            self.venv_py.parent.mkdir(parents=True, exist_ok=True)
            self.venv_py.write_text("")
            (self.root / ".venv" / "pyvenv.cfg").write_text(
                f"home = {Path(self.python).parent}\ninclude-system-site-packages = false\nversion = 3.12.1\n", "utf-8")
            return Done(0)
        if argv[0] == str(self.venv_py):
            return self._venv(argv[1:])
        if name in ("claude.exe", "claude.cmd"):
            return self._claude(argv, input)
        if name.startswith("powershell"):
            return self._ps(argv, env)
        return Done(127, "unknown command")

    def open_url(self, url):
        self.opened.append(url)

    # ---------- 各个假程序

    def _venv(self, args):
        if not self.venv_ok:
            return Done(1, "No Python at 'C:\\gone\\python.exe'")
        if args[:2] == ["-B", "-c"]:
            code = args[2]
            if "version_info" in code:
                return Done(0, "3.12.1\n")
            mods = {m for m in ("fitz", "qrcode", "numpy", "PIL", "rapidocr", "onnxruntime") if re.search(rf"\b{m}\b", code)}
            have = set(self.importable)
            if install.venv_borrows(self.root / ".venv" / "pyvenv.cfg"):
                have |= self.system_mods
            return Done(0) if mods <= have else Done(1, "ModuleNotFoundError")
        if args[:3] == ["-m", "pip", "install"]:
            if "-r" in args:
                if "pip" in self.fail:
                    return Done(1)
                self.importable |= {"fitz", "qrcode", "numpy", "PIL"}
                return Done(0)
            if "extras" in self.fail:
                return Done(1)
            self.importable |= set(args) & {"rapidocr", "onnxruntime"}
            return Done(0)
        if Path(args[0]).name == "launch.py":
            if "launch" in self.fail:
                return Done(1, "", "服务没能启动，看 data\\server.log")  # launch.py 把这句写到错误输出
            was, self.running = self.running, True
            return Done(0, "already running\n" if was else "started (wmi)\n")
        return Done(2, "unexpected venv call")

    def _claude(self, argv, input):
        a = argv[1:]
        if a == ["--version"]:
            if "claude" in self.fail:
                return Done(1, "boom")
            return Done(0, self.versions.get(argv[0].lower(), self.claude_version))
        if a == ["plugin", "marketplace", "list", "--json"]:
            return Done(0, json.dumps([{"name": n, "source": "directory", "path": p, "installLocation": p}
                                       for n, p in self.markets.items()]))
        if a[:3] == ["plugin", "marketplace", "add"]:
            if "marketplace" in self.fail:
                return Done(1, "Error: Invalid marketplace source format")
            mk = json.loads((Path(a[3]) / ".claude-plugin" / "marketplace.json").read_text("utf-8"))
            self.markets[mk["name"]] = a[3]
            return Done(0, f"Successfully added marketplace: {mk['name']} (declared in user settings)")
        if a == ["plugin", "list", "--json"]:
            return Done(0, json.dumps([dict(id=k, version="0.1.0", installPath="x", **v) for k, v in self.plugins.items()]))
        if a[:2] == ["plugin", "install"]:
            if "install" in self.fail or a[2].split("@")[1] not in self.markets:
                return Done(1, f'Plugin "{a[2]}" not found in any marketplace')
            self.plugins[a[2]] = {"scope": "user", "enabled": True}
            return Done(0, f"Successfully installed plugin: {a[2]} (scope: user)")
        if a[:2] == ["plugin", "enable"]:
            self.plugins[a[2]]["enabled"] = True
            return Done(0, f"Successfully enabled plugin: {a[2]} (scope: user)")
        if a[:2] == ["plugin", "configure"] and a[3:] == ["--json"]:
            inputs = {"server_url": "http://127.0.0.1:8765", "server_command": "", "offer_new_files": "true"}
            inputs.update(self.options)
            return Done(0, json.dumps({"schema": {}, "choices": {}, "inputs": inputs, "configured": sorted(self.options),
                                       "unconfigured": [k for k in inputs if k not in self.options]}))
        if a[:2] == ["plugin", "configure"] and a[3:] == ["--values-stdin"]:
            if "configure" in self.fail:
                return Done(1, "Failed to save configuration: unknown option")
            vals = json.loads(input)
            assert all(isinstance(v, str) and "\n" not in v for v in vals.values())
            self.options.update(vals)
            return Done(0, "Configuration saved. Restart Claude Code to apply it.")
        return Done(1, "unknown claude command")

    def _ps(self, argv, env):
        script = ps_script(argv)
        if "HNetCfg.FwPolicy2" in script:
            if "fwcheck" in self.fail:
                return Done(1, "", "New-Object : Retrieving the COM class factory failed")
            # 真机上输出被重定向时，PowerShell 会在前后夹上 #< CLIXML 和进度记录
            return Done(0, "#< CLIXML\n" + json.dumps(self.fw) + '\n<Objs Version="1.1.0.1"><Obj S="progress"/></Objs>')
        if "Start-Process" in script:
            self.elevated = base64.b64decode(re.search(r"-EncodedCommand (\S+?)'", script).group(1)).decode("utf-16-le")
            if self.uac == "no":
                return Done(1223)
            if self.uac == "yes":
                port = re.search(r"-Port (\d+)\s*$", self.elevated).group(1)
                self.fw["rules"].append({"ours": True, "allow": True, "profiles": ALL_RULE_PROFILES, "ports": port, "app": ""})
            return Done(0)
        if "Set-Clipboard" in script:
            self.clipboard = env["INK_CLIP"]
            return Done(0)
        return Done(1, "unknown powershell")

    # ---------- 查记录

    def changing(self):
        return [c["argv"] for c in self.calls if c["changes"]]

    def find(self, *words):
        return [c for c in self.calls if all(w in c["argv"] for w in words)]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.repo = base / "my files" / "草稿 纸"
        self.root = self.repo / "inkthink"
        (self.root / "tools").mkdir(parents=True)
        (self.root / "requirements.txt").write_text("pymupdf>=1.24\nPillow>=10\n", "utf-8")
        (self.root / "launch.py").write_text("", "utf-8")
        shutil.copy(ROOT / "open-firewall.ps1", self.root / "open-firewall.ps1")
        (self.repo / "inkpad-plugin" / ".claude-plugin").mkdir(parents=True)
        shutil.copy(ROOT.parent / "inkpad-plugin" / ".claude-plugin" / "marketplace.json",
                    self.repo / "inkpad-plugin" / ".claude-plugin" / "marketplace.json")
        self.py = base / "Python 3" / "python.exe"
        self.py.parent.mkdir()
        self.py.write_text("")
        self.home = base / "home 用户"
        self.home.mkdir()
        self.bin = base / "bin dir"
        self.bin.mkdir()
        self.claude_exe = self.bin / "claude.exe"
        self.claude_exe.write_text("")
        self.world = FakeWorld(self.repo, self.py)
        self.out = io.StringIO()

    def tearDown(self):
        self.tmp.cleanup()

    def inst(self, dry=False, version=(3, 12, 1), platform="win32"):
        env = {"PATH": str(self.bin), "USERPROFILE": str(self.home), "LOCALAPPDATA": str(self.home / "AppData" / "Local")}
        self.out = io.StringIO()
        return install.Installer(self.root, self.world, dry_run=dry, out=self.out, env=env, python=str(self.py),
                                 py_version=version, platform=platform)

    def make_venv(self, borrow=False, crlf=False):
        self.world.venv_py.parent.mkdir(parents=True, exist_ok=True)
        self.world.venv_py.write_text("")
        nl = "\r\n" if crlf else "\n"
        text = nl.join([f"home = {self.py.parent}", f"include-system-site-packages = {'true' if borrow else 'false'}",
                        "version = 3.12.1", ""])
        (self.root / ".venv" / "pyvenv.cfg").write_bytes(text.encode("utf-8"))

    def ready_venv(self):
        """环境建好、依赖装好（记号也写了）。"""
        self.make_venv()
        self.world.importable |= {"fitz", "qrcode", "numpy", "PIL"}
        shutil.copyfile(self.root / "requirements.txt", self.root / ".venv" / install.STAMP)

    def statuses(self, inst):
        return {k: r.status for k, _, _, r in inst.results}


class HelperTest(unittest.TestCase):
    def test_quote_and_split_round_trip(self):
        a, b = r"D:\my files\草稿 纸\inkthink\.venv\Scripts\python.exe", r"D:\my files\草稿 纸\inkthink\launch.py"
        cmd = f"{install.quote(a)} {install.quote(b)}"
        self.assertEqual(install.split_command(cmd), [a, b])
        self.assertEqual(install.quote(r"D:\plain\python.exe"), r"D:\plain\python.exe")

    def test_same_command(self):
        a = r'"D:\my files\py.exe" "D:\my files\launch.py"'
        self.assertTrue(install.same_command(a, a.lower().replace("\\", "/")))
        self.assertTrue(install.same_command(r"D:\x\py.exe D:\x\launch.py", r'"D:\x\py.exe" "D:\x\launch.py"'))
        self.assertFalse(install.same_command(a, r'"D:\other\py.exe" "D:\my files\launch.py"'))
        self.assertFalse(install.same_command("", a))

    def test_port_in(self):
        self.assertTrue(install.port_in("8765", 8765))
        self.assertTrue(install.port_in("80, 8765", 8765))
        self.assertTrue(install.port_in("8000-9000", 8765))
        self.assertTrue(install.port_in("*", 8765))
        self.assertFalse(install.port_in("RPC", 8765))
        self.assertFalse(install.port_in("", 8765))
        self.assertFalse(install.port_in("8766", 8765))

    def test_parse_json_out(self):
        self.assertEqual(install.parse_json_out('[{"id": "a"}]'), [{"id": "a"}])
        self.assertEqual(install.parse_json_out('Checking...\n{"outcome": "ok"}'), {"outcome": "ok"})
        self.assertEqual(install.parse_json_out('Warning: x\n[\n  {"name": "m"}\n]\n'), [{"name": "m"}])
        self.assertEqual(install.parse_json_out('#< CLIXML\n{"on": true}\n<Objs Version="1.1.0.1"></Objs>'), {"on": True})
        self.assertIsNone(install.parse_json_out("no json here"))
        self.assertIsNone(install.parse_json_out(""))

    def test_stop_borrowing_keeps_other_lines(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = Path(d) / "pyvenv.cfg"
            cfg.write_bytes(b"home = C:\\Py\r\ninclude-system-site-packages = true\r\nversion = 3.12.1\r\n")
            self.assertTrue(install.venv_borrows(cfg))
            install.stop_borrowing(cfg)
            self.assertEqual(cfg.read_bytes(), b"home = C:\\Py\r\ninclude-system-site-packages = false\r\nversion = 3.12.1\r\n")
            self.assertFalse(install.venv_borrows(cfg))

    def test_judge_firewall(self):
        py = r"C:\Program Files\Python312\python.exe"
        rule = lambda **kw: dict({"ours": False, "allow": True, "profiles": 4, "ports": "*", "app": ""}, **kw)  # noqa: E731
        judge = lambda rules, on=True: install.judge_firewall({"on": on, "current": 4, "rules": rules}, 8765, [py])  # noqa: E731
        self.assertTrue(judge([], on=False)[0])
        self.assertFalse(judge([])[0])
        self.assertTrue(judge([rule(ours=True, ports="8765", profiles=ALL_RULE_PROFILES)])[0])
        self.assertTrue(judge([rule(ports="8765")])[0])
        self.assertTrue(judge([rule(app=py.lower())])[0])  # 放行这个 Python 的规则（Windows 弹窗里点「允许」留下的）
        self.assertFalse(judge([rule(app=r"C:\Other\python.exe")])[0])  # 别的 Python
        self.assertFalse(judge([rule(ports="8765", profiles=2)])[0])  # 只对「专用网络」生效，现在连的是公用网络
        self.assertFalse(judge([rule(ports="80")])[0])
        allowed, _, blocked = judge([rule(ours=True, ports="8765"), rule(app=py, allow=False)])
        self.assertTrue(allowed)
        self.assertTrue(blocked)
        self.assertEqual(install.judge_firewall({"on": True, "current": 4, "rules": rule(ports="8765")}, 8765, [py])[0], True)


class RunnerTest(unittest.TestCase):
    """真的执行器：只跑这个 Python 自己，不跑别的程序。"""

    def test_output_input_and_errors(self):
        r = install.Runner().run([sys.executable, "-c", "import sys; print(sys.stdin.read().upper()); "
                                  "print('oops', file=sys.stderr); sys.exit(3)"], input="草稿 abc", timeout=60,
                                 env=dict(os.environ, PYTHONIOENCODING="utf-8"))
        self.assertEqual((r.code, r.out.strip(), r.err.strip()), (3, "草稿 ABC", "oops"))
        self.assertIn("oops", r.text)

    def test_missing_program_does_not_raise(self):
        r = install.Runner().run([str(Path(tempfile.gettempdir()) / "no such dir" / "nothing.exe")], timeout=10)
        self.assertNotEqual(r.code, 0)
        self.assertTrue(r.err)

    def test_timeout_does_not_raise(self):
        r = install.Runner().run([sys.executable, "-c", "import time; time.sleep(5)"], timeout=0.5)
        self.assertEqual(r.code, -1)


class PythonStepTest(Base):
    def test_ok(self):
        r = self.inst().step_python()
        self.assertEqual(r.status, DONE)
        self.assertIn("3.12.1", r.zh)

    def test_too_old_stops_everything(self):
        i = self.inst(version=(3, 9, 7))
        self.assertEqual(i.run_all(), 1)
        self.assertEqual(len(i.results), 1)
        self.assertEqual(i.results[0][3].status, FAIL)
        self.assertIn("python.org", i.results[0][3].fix_zh)
        self.assertEqual(self.world.calls, [])

    def test_not_windows(self):
        self.assertEqual(self.inst(platform="linux").step_python().status, FAIL)


class VenvStepTest(Base):
    def test_creates_venv_in_path_with_spaces_and_chinese(self):
        r = self.inst().step_venv()
        self.assertEqual(r.status, DONE)
        (call,) = self.world.find("venv")
        self.assertEqual(call["argv"], [str(self.py), "-m", "venv", str(self.root / ".venv")])
        self.assertTrue(call["changes"])
        self.assertTrue(self.world.venv_py.is_file())

    def test_existing_venv_is_skipped(self):
        self.make_venv()
        self.assertEqual(self.inst().step_venv().status, SKIP)
        self.assertEqual(self.world.changing(), [])

    def test_borrowing_venv_is_switched_to_its_own_packages(self):
        self.make_venv(borrow=True, crlf=True)
        i = self.inst()
        r = i.step_venv()
        self.assertEqual(r.status, DONE)
        cfg = (self.root / ".venv" / "pyvenv.cfg").read_bytes()
        self.assertIn(b"include-system-site-packages = false\r\n", cfg)
        self.assertIn(b"version = 3.12.1\r\n", cfg)
        self.assertTrue(i.flipped)
        self.assertEqual([x[2] for x in i.borrowed], [("rapidocr", "onnxruntime")])  # 改之前能用，记下来补装
        self.assertIn("RapidOCR", r.zh)

    def test_broken_venv(self):
        self.make_venv()
        self.world.venv_ok = False
        r = self.inst().step_venv()
        self.assertEqual(r.status, FAIL)
        self.assertIn("删掉 inkthink\\.venv", r.fix_zh)

    def test_create_fails(self):
        self.world.fail.add("venv")
        r = self.inst().step_venv()
        self.assertEqual(r.status, FAIL)
        self.assertIn("python -m venv .venv", r.fix_zh)


class DepsStepTest(Base):
    def test_installs_then_skips(self):
        self.make_venv()
        i = self.inst()
        self.assertEqual(i.step_deps().status, DONE)
        (pip,) = self.world.find("pip", "-r")
        self.assertEqual(pip["argv"][-1], str(self.root / "requirements.txt"))
        self.assertEqual(pip["env"]["PYTHONUTF8"], "1")
        self.assertEqual((self.root / ".venv" / install.STAMP).read_bytes(), (self.root / "requirements.txt").read_bytes())
        self.assertEqual(self.inst().step_deps().status, SKIP)
        self.assertEqual(len(self.world.find("pip", "-r")), 1)

    def test_changed_requirements_reinstall(self):
        self.ready_venv()
        (self.root / "requirements.txt").write_text("pymupdf>=1.24\nPillow>=10\nqrcode>=7.4\n", "utf-8")
        self.assertEqual(self.inst().step_deps().status, DONE)
        self.assertEqual(len(self.world.find("pip", "-r")), 1)

    def test_pip_fails(self):
        self.make_venv()
        self.world.fail.add("pip")
        r = self.inst().step_deps()
        self.assertEqual(r.status, FAIL)
        self.assertIn("联网", r.zh)
        self.assertIn(f'"{self.root / "requirements.txt"}"', r.fix_zh)  # 手动命令里带空格的路径有引号
        self.assertFalse((self.root / ".venv" / install.STAMP).exists())

    def test_borrowed_extras_are_installed_into_the_venv(self):
        self.make_venv(borrow=True)
        i = self.inst()
        i.step_venv()
        self.assertEqual(i.step_deps().status, DONE)
        self.assertEqual(len(self.world.find("pip", "rapidocr", "onnxruntime")), 1)
        self.assertLessEqual({"rapidocr", "onnxruntime"}, self.world.importable)

    def test_extras_failing_is_only_a_note(self):
        self.make_venv(borrow=True)
        self.world.fail.add("extras")
        i = self.inst()
        i.step_venv()
        r = i.step_deps()
        self.assertEqual(r.status, WARN)
        self.assertIn("RapidOCR", r.zh)


class ClaudeStepTest(Base):
    def test_found_on_path(self):
        i = self.inst()
        self.assertEqual(i.step_claude().status, DONE)
        self.assertEqual(i.claude, self.claude_exe)
        self.assertEqual(i.claude_version, (2, 1, 325))

    def test_npm_wrapper_uses_the_exe_inside(self):
        self.claude_exe.unlink()
        (self.bin / "claude.cmd").write_text("@echo off\n")
        exe = self.bin / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
        exe.parent.mkdir(parents=True)
        exe.write_text("")
        i = self.inst()
        self.assertEqual(i.step_claude().status, DONE)
        self.assertEqual(i.claude, exe)

    def test_vscode_extension_only(self):
        self.claude_exe.unlink()
        for v in ("2.1.300", "2.1.325"):
            exe = self.home / ".vscode" / "extensions" / f"anthropic.claude-code-{v}-win32-x64" / "resources" / "native-binary" / "claude.exe"
            exe.parent.mkdir(parents=True)
            exe.write_text("")
            self.world.versions[str(exe).lower()] = f"{v} (Claude Code)"
        i = self.inst()
        r = i.step_claude()
        self.assertEqual(r.status, DONE)
        self.assertIn("2.1.325", str(i.claude))
        self.assertIn("扩展", r.zh)

    def add_extension(self, version):
        ext = self.home / ".vscode" / "extensions" / f"anthropic.claude-code-{version}-win32-x64" / "resources" / "native-binary" / "claude.exe"
        ext.parent.mkdir(parents=True)
        ext.write_text("")
        self.world.versions[str(ext).lower()] = f"{version} (Claude Code)"
        return ext

    def test_command_line_claude_preferred_when_new_enough(self):
        self.add_extension("2.1.325")
        self.world.versions[str(self.claude_exe).lower()] = "2.1.290 (Claude Code)"
        i = self.inst()
        i.step_claude()
        self.assertEqual(i.claude, self.claude_exe)
        self.assertEqual(len(self.world.find("--version")), 1)  # 第一个就够新，不再挨个试

    def test_too_old_command_line_claude_falls_back_to_extension(self):
        ext = self.add_extension("2.1.325")
        self.world.versions[str(self.claude_exe).lower()] = "2.1.100 (Claude Code)"
        i = self.inst()
        i.step_claude()
        self.assertEqual(i.claude, ext)

    def test_found_but_does_not_run(self):
        self.world.fail.add("claude")
        r = self.inst().step_claude()
        self.assertEqual(r.status, FAIL)
        self.assertIn("claude --version", r.fix_zh)

    def test_not_found(self):
        self.claude_exe.unlink()
        r = self.inst().step_claude()
        self.assertEqual(r.status, FAIL)
        self.assertIn("install.ps1", r.fix_zh)
        self.assertIn("VS Code", r.fix_zh)

    def test_not_found_blocks_plugin_steps_but_not_the_rest(self):
        self.claude_exe.unlink()
        i = self.inst()
        self.assertEqual(i.run_all(), 1)
        s = self.statuses(i)
        self.assertEqual(s["claude"], FAIL)
        self.assertEqual([s[k] for k in ("marketplace", "plugin", "configure")], [BLOCKED] * 3)
        self.assertEqual(s["firewall"], DONE)
        self.assertEqual(s["start"], DONE)
        configure = dict((k, res) for k, _, _, res in i.results)["configure"]
        self.assertIn("第 4 步", configure.zh)  # 指到真正没成功的那一步，不是前一步
        self.assertIn("第 4 步（找到 claude 命令）没成功", self.out.getvalue())


class PluginStepsTest(Base):
    def setUp(self):
        super().setUp()
        self.ready_venv()
        self.i = self.inst()
        self.i.step_claude()

    def test_marketplace_added(self):
        self.assertEqual(self.i.step_marketplace().status, DONE)
        (call,) = self.world.find("marketplace", "add")
        self.assertEqual(call["argv"][-1], str(self.repo / "inkpad-plugin"))
        self.assertTrue(call["changes"])

    def test_marketplace_already_added_here(self):
        self.world.markets["inkthink-local"] = str(self.repo / "inkpad-plugin").upper().replace("\\", "/")
        self.assertEqual(self.i.step_marketplace().status, SKIP)
        self.assertEqual(self.world.changing(), [])

    def test_marketplace_added_from_elsewhere_is_left_alone(self):
        self.world.markets["inkthink-local"] = r"D:\another copy\inkpad-plugin"
        self.world.plugins[PLUGIN_ID] = {"scope": "user", "enabled": True}
        r = self.i.step_marketplace()
        self.assertEqual(r.status, FAIL)
        self.assertIn("another copy", r.zh)
        self.assertIn("marketplace remove inkthink-local", r.fix_zh)
        self.assertEqual(self.world.changing(), [])

    def test_marketplace_add_fails(self):
        self.world.fail.add("marketplace")
        r = self.i.step_marketplace()
        self.assertEqual(r.status, FAIL)
        self.assertIn("Invalid marketplace source", r.zh)
        self.assertIn("plugin marketplace add", r.fix_zh)

    def test_plugin_installed_then_skipped(self):
        self.i.step_marketplace()
        self.assertEqual(self.i.step_plugin().status, DONE)
        (call,) = self.world.find("install")
        self.assertEqual(call["argv"][1:], ["plugin", "install", PLUGIN_ID, "--scope", "user"])
        self.assertEqual(self.i.step_plugin().status, SKIP)
        self.assertEqual(len(self.world.find("install")), 1)

    def test_disabled_plugin_is_enabled(self):
        self.world.markets["inkthink-local"] = str(self.repo / "inkpad-plugin")
        self.world.plugins[PLUGIN_ID] = {"scope": "user", "enabled": False}
        self.assertEqual(self.i.step_plugin().status, DONE)
        self.assertTrue(self.world.plugins[PLUGIN_ID]["enabled"])

    def test_plugin_install_fails(self):
        self.world.markets["inkthink-local"] = str(self.repo / "inkpad-plugin")
        self.world.fail.add("install")
        r = self.i.step_plugin()
        self.assertEqual(r.status, FAIL)
        self.assertIn("plugin install", r.fix_zh)

    def configure(self):
        self.world.markets["inkthink-local"] = str(self.repo / "inkpad-plugin")
        self.world.plugins[PLUGIN_ID] = {"scope": "user", "enabled": True}
        return self.i.step_configure()

    def test_configure_fills_server_command(self):
        self.assertEqual(self.configure().status, DONE)
        (call,) = self.world.find("--values-stdin")
        sent = json.loads(call["input"])
        self.assertEqual(list(sent), ["server_command"])
        self.assertEqual(install.split_command(sent["server_command"]),
                         [str(self.root / ".venv" / "Scripts" / "python.exe"), str(self.root / "launch.py")])
        self.assertTrue(call["input"].isascii())  # 中文路径以 \\u 转义传过去，不怕编码

    def test_configure_already_set_is_skipped(self):
        self.world.options["server_command"] = self.i.server_command().lower()
        self.assertEqual(self.configure().status, SKIP)
        self.assertEqual(self.world.find("--values-stdin"), [])

    def test_configure_replaces_another_folder(self):
        self.world.options["server_command"] = r"D:\old\.venv\Scripts\python.exe D:\old\launch.py"
        self.assertEqual(self.configure().status, DONE)
        self.assertIn(r"D:\old\launch.py", self.out.getvalue())
        self.assertTrue(install.same_command(self.world.options["server_command"], self.i.server_command()))

    def test_old_claude_gets_the_line_to_paste(self):
        self.i.claude_version = (2, 1, 200)
        r = self.configure()
        self.assertEqual(r.status, WARN)
        self.assertEqual(self.world.clipboard, self.i.server_command())
        self.assertIn(f"/plugin configure {PLUGIN_ID}", r.fix_zh)
        self.assertIn(self.i.server_command(), r.fix_zh)
        self.assertEqual(self.world.find("configure"), [])

    def test_configure_refused_gets_the_line_to_paste(self):
        self.world.fail.add("configure")
        r = self.configure()
        self.assertEqual(r.status, WARN)
        self.assertIn("unknown option", r.zh)
        self.assertEqual(self.world.clipboard, self.i.server_command())

    def test_custom_port_also_sets_server_url_and_leaves_config_alone(self):
        cfg = self.root / "config.json"
        cfg.write_text('{"port": 8766, "access_code": "do-not-touch"}', "utf-8")
        before = cfg.read_bytes()
        self.i = self.inst()
        self.i.step_claude()
        self.configure()
        sent = json.loads(self.world.find("--values-stdin")[0]["input"])
        self.assertEqual(sent["server_url"], "http://127.0.0.1:8766")
        self.assertEqual(cfg.read_bytes(), before)


class FirewallStepTest(Base):
    def setUp(self):
        super().setUp()
        self.ready_venv()

    def test_rule_exists(self):
        self.world.fw["rules"] = [{"ours": True, "allow": True, "profiles": ALL_RULE_PROFILES, "ports": "8765", "app": ""}]
        self.assertEqual(self.inst().step_firewall().status, SKIP)
        self.assertIsNone(self.world.elevated)

    def test_python_allowed_by_program_rule(self):
        app = str(self.py).upper()  # 规则里的路径大小写不一定一样
        self.world.fw["rules"] = [{"ours": False, "allow": True, "profiles": 4, "ports": "*", "app": app}]
        r = self.inst().step_firewall()
        self.assertEqual(r.status, SKIP)
        self.assertIn("Python", r.zh)

    def test_missing_rule_user_says_yes(self):
        r = self.inst().step_firewall()
        self.assertEqual(r.status, DONE)
        self.assertIn("New-NetFirewallRule", self.world.elevated)
        self.assertTrue(self.world.elevated.rstrip().endswith("-Port 8765"))
        self.assertIn("防火墙现在挡着它", self.out.getvalue())  # 先说明原因
        self.assertEqual(len(self.world.find("-Command")), 1)  # 只弹一次

    def test_missing_rule_user_says_no_still_finishes(self):
        self.world.uac = "no"
        i = self.inst()
        self.assertEqual(i.run_all(), 0)
        r = dict((k, res) for k, _, _, res in i.results)["firewall"]
        self.assertEqual(r.status, WARN)
        self.assertIn("你点了「否」", r.zh)
        self.assertIn("open-firewall.ps1", r.fix_zh)
        self.assertEqual(self.statuses(i)["start"], DONE)
        self.assertIn("要你看一下", self.out.getvalue())

    def test_elevated_but_rule_still_missing(self):
        self.world.uac = "error"
        r = self.inst().step_firewall()
        self.assertEqual(r.status, WARN)
        self.assertIn("没能加上", r.zh)

    def test_check_fails(self):
        self.world.fail.add("fwcheck")
        r = self.inst().step_firewall()
        self.assertEqual(r.status, WARN)
        self.assertIsNone(self.world.elevated)

    def test_local_only_host_needs_no_rule(self):
        (self.root / "config.json").write_text('{"host": "127.0.0.1"}', "utf-8")
        self.assertEqual(self.inst().step_firewall().status, SKIP)
        self.assertEqual(self.world.calls, [])

    def test_block_rule_is_reported(self):
        self.world.fw["rules"] = [
            {"ours": True, "allow": True, "profiles": ALL_RULE_PROFILES, "ports": "8765", "app": ""},
            {"ours": False, "allow": False, "profiles": 4, "ports": "*", "app": str(self.py)}]
        r = self.inst().step_firewall()
        self.assertEqual(r.status, WARN)
        self.assertIn("wf.msc", r.zh)

    def test_firewall_off(self):
        self.world.fw["on"] = False
        self.assertEqual(self.inst().step_firewall().status, SKIP)


class StartStepTest(Base):
    def setUp(self):
        super().setUp()
        self.ready_venv()

    def test_starts_and_opens_qr(self):
        r = self.inst().step_start()
        self.assertEqual(r.status, DONE)
        (call,) = self.world.find(str(self.root / "launch.py"))
        self.assertEqual(call["argv"], [str(self.world.venv_py), str(self.root / "launch.py")])
        self.assertEqual(self.world.opened, ["http://127.0.0.1:8765/qr"])

    def test_already_running(self):
        self.world.running = True
        self.assertEqual(self.inst().step_start().status, SKIP)
        self.assertEqual(self.world.opened, ["http://127.0.0.1:8765/qr"])

    def test_fails(self):
        self.world.fail.add("launch")
        r = self.inst().step_start()
        self.assertEqual(r.status, FAIL)
        self.assertIn("服务没能启动，看", r.zh)  # launch.py 写在错误输出里的那句也给用户看
        self.assertIn("server.log", r.fix_zh)
        self.assertEqual(self.world.opened, [])


class WholeRunTest(Base):
    def test_fresh_install_then_rerun_skips(self):
        cfg = self.root / "config.json"
        cfg.write_text('{"access_code": "keep-me"}', "utf-8")
        (self.root / "data").mkdir()
        (self.root / "data" / "note.json").write_text("{}", "utf-8")
        i = self.inst()
        self.assertEqual(i.run_all(), 0)
        self.assertEqual(set(self.statuses(i).values()), {DONE})
        out = self.out.getvalue()
        self.assertIn("[9/9]", out)
        self.assertIn("装好了", out)
        self.assertIn("All set", out)
        self.assertIn(PLUGIN_ID, self.world.plugins)

        self.world.calls.clear()
        j = self.inst()
        self.assertEqual(j.run_all(), 0)
        s = self.statuses(j)
        self.assertEqual(s.pop("python"), DONE)
        self.assertEqual(s.pop("claude"), DONE)  # 找 claude 只是查，不改东西
        self.assertEqual(set(s.values()), {SKIP})
        # 第二遍会改东西的只有「启动服务」那一条（launch.py 自己发现已经在运行就什么也不做）
        self.assertEqual(self.world.changing(), [[str(self.world.venv_py), str(self.root / "launch.py")]])
        self.assertEqual(cfg.read_text("utf-8"), '{"access_code": "keep-me"}')
        self.assertEqual([p.name for p in (self.root / "data").iterdir()], ["note.json"])

    def test_failure_names_the_step(self):
        self.world.fail.add("pip")
        i = self.inst()
        self.assertEqual(i.run_all(), 1)
        out = self.out.getvalue()
        self.assertIn("第 3 步（装依赖）", out)
        self.assertEqual(self.statuses(i)["start"], BLOCKED)
        self.assertIn("怎么补", out)

    def test_dry_run_changes_nothing(self):
        i = self.inst(dry=True)
        self.assertEqual(i.run_all(), 0)
        self.assertEqual(self.world.changing(), [])
        self.assertEqual([c for c in self.world.calls if Path(c["argv"][0]).name.lower().startswith("claude")], [])
        self.assertEqual(self.world.opened, [])
        self.assertIsNone(self.world.clipboard)
        self.assertIsNone(self.world.elevated)
        self.assertFalse((self.root / ".venv").exists())
        self.assertEqual(set(self.statuses(i).values()) - {PLAN, DONE}, set())
        out = self.out.getvalue()
        self.assertIn("演练", out)
        self.assertIn("plugin marketplace add", out)
        self.assertIn("--values-stdin", out)

    def test_dry_run_on_borrowing_venv_leaves_it_alone(self):
        self.make_venv(borrow=True)
        cfg = (self.root / ".venv" / "pyvenv.cfg").read_bytes()
        i = self.inst(dry=True)
        self.assertEqual(i.run_all(), 0)
        self.assertEqual((self.root / ".venv" / "pyvenv.cfg").read_bytes(), cfg)
        self.assertEqual(self.world.changing(), [])
        self.assertEqual(self.statuses(i)["venv"], PLAN)
        self.assertEqual(self.statuses(i)["deps"], PLAN)
        self.assertIn("include-system-site-packages", self.out.getvalue())

    def test_dry_run_refuses_changing_commands(self):
        with self.assertRaises(RuntimeError):
            self.inst(dry=True)._run(["anything"], changes=True)


if __name__ == "__main__":
    unittest.main()

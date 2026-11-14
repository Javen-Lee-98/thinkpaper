"""领域词表（阶段 3「认字」）：从本子的原文和对话所在项目的说明文件里抽常用术语，发送时附上和这一页相关的几个，
帮 Claude 认手写里的专有名词、符号（S_abc、h_top、ABCD……）。只抽「长得像术语」的：带下划线的符号、
大写缩写、驼峰词、说明文件里加了「」或反引号的中文词。
"""
import re
from collections import Counter

PATTERNS = [
    re.compile(r"(?<![A-Za-z0-9_])[A-Za-z]{1,3}_\{?[A-Za-z0-9]{1,8}\}?(?![A-Za-z0-9_])"),  # 公式符号 S_abc、h_{top}（不要 bbox_inches 这类代码名）
    re.compile(r"(?<![A-Za-z0-9_])[A-Z]{2,5}[0-9]?(?![A-Za-z0-9_])"),                     # 两到五个大写字母的缩写（全大写太长的多半是强调的英文词）
    re.compile(r"(?<![A-Za-z0-9_])[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+(?![A-Za-z0-9_])"),       # 驼峰 InkThink、PyMuPDF
]
QUOTED = re.compile(r"[「`]([一-鿿][一-鿿A-Za-z0-9_]{1,7})[」`]")  # 「勾股定理」、`一元二次`
STOP = {"PDF", "PPT", "PPTX", "DOC", "DOCX", "HTTP", "HTTPS", "URL", "API", "JSON", "PNG", "JPG", "SVG", "OK", "TODO",
        "README", "CLAUDE", "AGENTS", "MCP", "CLI", "UI", "ID", "AI", "IO", "OS", "VS", "PC", "USB", "CPU", "GPU",
        "NOT", "AND", "THE", "FOR", "ALL", "NEW", "OLD", "YES", "NO", "DO", "MUST", "ONLY", "NOTE", "TBD", "DONE", "FIXME",
        "NEVER", "WARN", "SEE", "CSV", "XML", "HTML", "CSS", "BAT", "EXE", "MD", "PY", "JS", "TS", "ALSO", "IN", "ON", "OF",
        "IS", "IT", "AT", "BY", "OR", "IF", "BE", "AS", "UP", "TO", "SAME", "TURN", "MODEL", "YYYY", "MM", "DD", "GB", "MB",
        "KB", "UTF", "COM", "ASCII"}
PROJECT_FILES = ("CLAUDE.md", "AGENTS.md", "README.md")
MAX_FILE = 200_000  # 每个文件最多读这么多字


def extract(text, quoted=False):
    """一段文字里的术语 → Counter。quoted：也抽「」和反引号里的中文词（说明文件里常这样标术语）。"""
    c = Counter()
    for pat in PATTERNS:
        for m in pat.findall(text or ""):
            t = m.strip()
            if t.upper() not in STOP and len(t) <= 24:
                c[t] += 1
    if quoted:
        c.update(QUOTED.findall(text or ""))
    return c


def project_terms(cwd):
    """对话所在项目的说明文件（CLAUDE.md、AGENTS.md、README.md，只看顶层）里的术语。"""
    from pathlib import Path
    c = Counter()
    if not cwd:
        return c
    for name in PROJECT_FILES:
        p = Path(cwd) / name
        try:
            if p.is_file():
                c.update(extract(p.read_text("utf-8", errors="ignore")[:MAX_FILE], quoted=True))
        except OSError:
            continue
    return c


def pick(doc, project, page_text="", n=15):
    """挑这次附上的：这一页原文里出现的在前，其余按在本子和项目里出现的次数；出现一次的不要（多半是偶然）。"""
    total = doc + project
    here = set(extract(page_text))
    keep = [t for t, k in total.items() if k >= 2 or t in here]
    keep.sort(key=lambda t: (t not in here, -total[t], t))
    return keep[:n]

"""用 Windows 自带的手写识别（Windows Ink，按笔画顺序识别，在本机运行、不上传）给每组笔迹一个读法候选。

先判断语种再认（2026-11-14）：本机装了英文手写识别器时，每组中文、英文各认一遍，按英文那份结果像不像英文来选（looks_english）。
英文识别器遇到中文，认出来的多半是一串数字、符号或不成词的字母；遇到英文，认出来的是成词的单词。中文识别器遇到英文，
常认成形近的汉字，所以不能反过来看中文那份。中英混写的组照旧按中文认。
没装英文识别器就只按中文认，结果里标明（lang 为 "zh-only"），给 Claude 的旁证里如实写「只按中文认」。

识别器只认字和简单符号，草写、公式常认错，所以结果只给 Claude 当旁证，和图对照着看。
需要 Windows 的手写识别包（设置 → 时间和语言 → 语言 → 中文 / 英语 → 手写）和 winrt 的几个 Python 包；
一个识别器都没有就安静地不提供候选。
"""
import asyncio
import gc
import re
import threading

try:
    from winrt.windows.foundation import Point
    from winrt.windows.foundation.numerics import Matrix3x2
    from winrt.windows.ui.input.inking import (InkPoint, InkRecognitionTarget, InkRecognizerContainer,
                                               InkStrokeBuilder, InkStrokeContainer)
    AVAILABLE = True
except ImportError:
    AVAILABLE = False

MAX_GROUPS = 60
RETRIES = 4       # 识别器说「来得不是时候」时最多试几次（见 _recognize）
# 单独一笔识别成这些，多半是圈、横线、点之类的标记，不是字
SHAPES = set("。.,，0Oo〇囗口-—_~一、|/\\()（）")
# 识别器的名字（按系统显示语言不同写法不同）：先找第一组里的，找不到再找第二组里的
NAMES = {"zh": (("简体", "Simplified"), ("中文", "Chinese")),
         "en": (("English (US)", "English (United States)", "英语(美国)", "英语 (美国)"), ("English", "英语"))}
_lock = threading.Lock()
_recognizers = None

# 判断「像英文」用的：字母串、成词的字母串（首字母可大写的小写词，或 2 到 5 个大写字母的缩写）、至少 3 个字母的词
_LETTERS = re.compile(r"[A-Za-z]+")
_WORD = re.compile(r"[A-Za-z][a-z]+|[A-Z]{2,5}")
_LONG = re.compile(r"[A-Za-z][a-z]{2,}|[A-Z]{3,5}")
EN_SHARE = 0.6        # 英文那份结果里，成词的字母至少占所有字的这么多
EN_STROKES = 1.8      # 平均每个认出来的字不超过这么多笔（一个汉字常有好几笔，一个字母一两笔）


def looks_english(n_strokes, en):
    """英文识别器的结果（每段的候选列表）像不像英文：成词的字母至少 3 个、占所有字的 EN_SHARE 以上，至少有一个
    3 个字母以上的词，平均每个字不超过 EN_STROKES 笔。
    依据（2026-11-14，在真实笔迹的副本上量的）：17 个英文词组判对 15 个（漏的是两个两三个字母的缩写），评测集 43 组中文、
    混写、符号一组也没判成英文；其余 455 组里判成英文的 4 组，看过图是 2 组英文缩写、2 组夹着英文单词的中文。"""
    top = [c[0] for c in en if c]
    total = sum(len(re.sub(r"\s+", "", t)) for t in top)
    words = [w for t in top for w in _LETTERS.findall(t)]
    good = sum(len(w) for w in words if _WORD.fullmatch(w))
    return (good >= 3 and good >= EN_SHARE * total and n_strokes <= EN_STROKES * total
            and any(_LONG.fullmatch(w) for w in words))


def readings(segs):
    """识别器可能把一组拆成几段：每段取前三个候选，按顺序拼起来。返回 [最可能的读法, 备选…]，认不出来是 []。"""
    segs = [c for c in segs if c]
    if not segs:
        return []
    best = "".join(c[0] for c in segs)
    out = [best]
    for k in range(1, 3):
        alt = "".join(c[k] if len(c) > k else c[0] for c in segs)
        if alt not in out:
            out.append(alt)
    return out


def choose(n_strokes, zh, en):
    """两种识别结果（各是每段的候选列表；没有那种识别器就是 None）→（语种, 读法）。
    语种：en 按英文认、zh 按中文认、zh-only 只有中文识别器、en-only 只有英文识别器。"""
    if zh is None:
        return "en-only", readings(en or [])
    if en is None:
        return "zh-only", readings(zh)
    if looks_english(n_strokes, en):
        return "en", readings(en)
    return "zh", readings(zh)


def _find(recs, lang):
    for keys in NAMES[lang]:
        r = next((r for r in recs if any(k in r.name for k in keys)), None)
        if r is not None:
            return r
    return None


def _containers():
    """{语种: 设好识别器的 InkRecognizerContainer}，本机没有的语种不在里面。"""
    global _recognizers
    if _recognizers is None:
        recs = list(InkRecognizerContainer().get_recognizers())
        out = {}
        for lang in ("zh", "en"):
            r = _find(recs, lang)
            if r is not None:
                rc = InkRecognizerContainer()
                rc.set_default_recognizer(r)
                out[lang] = rc
        if not out:
            raise RuntimeError("没有中文或英文手写识别器")
        _recognizers = out
    return _recognizers


async def _recognize(rc, cont):
    """认一次。识别器连着认很多组时会报「A method was called at an unexpected time」（2026-11-14 实测：402 组一组接一组地认，
    167 组出错；每组之间等 50 毫秒就一组不错）：出错了先回收一下没用的对象、等一会儿再试，最多试 RETRIES 次。"""
    for k in range(RETRIES):
        try:
            return await rc.recognize_async(cont, InkRecognitionTarget.ALL)
        except OSError:
            if k == RETRIES - 1:
                raise
            gc.collect()
            await asyncio.sleep(0.05 * (k + 1))


async def _run(groups):
    rcs = _containers()
    out = {}
    for gid, strokes in groups:
        builder, cont = InkStrokeBuilder(), InkStrokeContainer()
        for s in strokes:
            pts = [InkPoint(Point(p[0], p[1]), max(0.05, min(1.0, p[2]))) for p in s["pts"]]
            cont.add_stroke(builder.create_stroke_from_ink_points(pts, Matrix3x2(1, 0, 0, 1, 0, 0)))
        got = {}
        try:
            for lang, rc in rcs.items():
                got[lang] = [list(r.get_text_candidates())[:3] for r in await _recognize(rc, cont)]
        except OSError:
            continue  # 这一组试了几次还是认不了：只是这一组没有候选，别的组照常（以前一组出错整批都没有）
        lang, text = choose(len(strokes), got.get("zh"), got.get("en"))
        if not text or (len(strokes) == 1 and text[0] in SHAPES):
            continue
        out[gid] = {"text": text, "lang": lang}
    return out


def recognize_lang(groups):
    """groups: [(组编号, [笔迹])]。返回 {组编号: {"text": [最可能的读法, 备选…], "lang": 语种}}（语种见 choose）；识别不了就返回 {}。"""
    if not AVAILABLE or not groups:
        return {}
    with _lock:  # 识别器不是线程安全的
        try:
            return asyncio.run(_run(groups[:MAX_GROUPS]))
        except Exception:  # noqa: BLE001 - 识别只是锦上添花，出错就不给候选
            return {}


def recognize(groups):
    """groups: [(组编号, [笔迹])]。返回 {组编号: [最可能的读法, 备选…]}（已按判断出的语种认）；识别不了就返回 {}。"""
    return {gid: r["text"] for gid, r in recognize_lang(groups).items()}

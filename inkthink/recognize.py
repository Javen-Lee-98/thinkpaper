"""用 Windows 自带的手写识别（Windows Ink，按笔画顺序识别，在本机运行、不上传）给每组笔迹一个读法候选。

识别器只认字和简单符号，草写、公式常认错，所以结果只给 Claude 当旁证，和图对照着看。
需要 Windows 的中文手写识别包（设置 → 时间和语言 → 语言 → 中文 → 手写）和 winrt 的几个 Python 包；
缺了就安静地不提供候选。
"""
import asyncio
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
# 单独一笔识别成这些，多半是圈、横线、点之类的标记，不是字
SHAPES = set("。.,，0Oo〇囗口-—_~一、|/\\()（）")
_lock = threading.Lock()
_recognizer = None


def _container():
    global _recognizer
    if _recognizer is None:
        rc = InkRecognizerContainer()
        recs = list(rc.get_recognizers())
        zh = next((r for r in recs if "中文" in r.name or "Chinese (Simplified)" in r.name), None)
        if zh is None:
            raise RuntimeError("没有中文手写识别器")
        rc.set_default_recognizer(zh)
        _recognizer = rc
    return _recognizer


async def _run(groups):
    rc = _container()
    out = {}
    for gid, strokes in groups:
        builder, cont = InkStrokeBuilder(), InkStrokeContainer()
        for s in strokes:
            pts = [InkPoint(Point(p[0], p[1]), max(0.05, min(1.0, p[2]))) for p in s["pts"]]
            cont.add_stroke(builder.create_stroke_from_ink_points(pts, Matrix3x2(1, 0, 0, 1, 0, 0)))
        results = await rc.recognize_async(cont, InkRecognitionTarget.ALL)
        # 识别器可能把一组拆成几段：每段取前三个候选，按顺序拼起来
        segs = [list(r.get_text_candidates())[:3] for r in results]
        segs = [c for c in segs if c]
        if not segs:
            continue
        best = "".join(c[0] for c in segs)
        alts = []
        for k in range(1, 3):
            alt = "".join(c[k] if len(c) > k else c[0] for c in segs)
            if alt != best and alt not in alts:
                alts.append(alt)
        if len(strokes) == 1 and best in SHAPES:
            continue
        out[gid] = [best] + alts
    return out


def recognize(groups):
    """groups: [(组编号, [笔迹])]。返回 {组编号: [最可能的读法, 备选…]}；识别不了就返回 {}。"""
    if not AVAILABLE or not groups:
        return {}
    with _lock:  # 识别器不是线程安全的
        try:
            return asyncio.run(_run(groups[:MAX_GROUPS]))
        except Exception:  # noqa: BLE001 - 识别只是锦上添花，出错就不给候选
            return {}

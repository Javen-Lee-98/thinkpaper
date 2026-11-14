"""本机的第二个手写旁证：PP-OCR（RapidOCR 的 ONNX 版本，在本机运行、不上传）。

和 Windows 手写识别（recognize.py，按笔画顺序）互补：这里看的是图。每组笔迹先按笔画位置分成行
（inksheet.lines），每行画成一条、只用识别模型认，不用它的文字检测——检测在手写上常常什么都找不到
（评测集上 PP-OCRv5 mobile 带检测只有 15/50 组有输出）。结果只给 Claude 当旁证。

可选安装：.venv\\Scripts\\python.exe -m pip install rapidocr onnxruntime（第一次用时 RapidOCR 会下载模型）；
没装就安静地不提供。用哪一版、哪一档，按评测集上的字错误率和速度定（tools/evalset.py ocr，记在路线图的「记录」里）。
"""
import threading
import time

import inksheet

try:
    import numpy as np
    from rapidocr import ModelType, OCRVersion, RapidOCR
    AVAILABLE = True
except ImportError:  # 没装 RapidOCR
    AVAILABLE = False

VERSION, MODEL = "PP-OCRv6", "medium"  # 评测集上定的：43 组 CER 0.474、每组约 0.2 秒（2026-11-02，见路线图「记录」）
LINE_H = 40       # 每行画成字高约这么多像素再交给识别模型（它的输入高 48）
BUDGET_S = 3.0    # 一次投递里识别最多花这么久，超了后面的组就不识别了
_lock = threading.Lock()
_engines = {}


def engine(version=VERSION, model=MODEL):
    """按版本和档位建一个识别器（建一次留着用；第一次建要读模型，几秒）。"""
    key = (version, model)
    if key not in _engines:
        _engines[key] = RapidOCR(params={
            "Global.log_level": "error", "Global.use_cls": False,  # 线程数用默认：限成 2 或 4 个反而慢十几倍（2026-11-02 实测）
            "Det.ocr_version": OCRVersion(version), "Det.model_type": ModelType(model),
            "Rec.ocr_version": OCRVersion(version), "Rec.model_type": ModelType(model),
        })
    return _engines[key]


def read_strokes(strokes, eng=None):
    """一组笔迹 → 读法：按行分开，每行画成一条、只用识别模型认，从上到下拼起来。读不出来是空串。"""
    eng = eng or engine()
    out = []
    for line in inksheet.lines(strokes):
        im = inksheet.cell(line, char_h=LINE_H, max_h=10_000)
        if im is None:
            continue
        res = eng(np.asarray(im), use_det=False, use_cls=False, use_rec=True)
        text = "".join(getattr(res, "txts", None) or []).strip()
        if text:
            out.append(text)
    return "".join(out)


def warm():
    """服务启动时在后台先把模型读进来，第一次发送不用等。"""
    if AVAILABLE:
        try:
            with _lock:
                engine()
        except Exception:  # noqa: BLE001
            pass


def recognize(groups, budget_s=BUDGET_S):
    """groups：[(组编号, 笔迹)]。返回 {组编号: 读法}；没装、出错或超时的组不给。"""
    if not AVAILABLE or not groups:
        return {}
    out, t0 = {}, time.monotonic()
    with _lock:  # 识别器不一定线程安全，一次一个
        try:
            eng = engine()
            for gid, strokes in groups:
                if time.monotonic() - t0 > budget_s:
                    break
                text = read_strokes(strokes, eng)
                if text:
                    out[gid] = text
        except Exception:  # noqa: BLE001 - 识别只是旁证，出错就不给
            return out
    return out

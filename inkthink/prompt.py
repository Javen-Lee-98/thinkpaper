"""把平板上点「AI」交上来的一页写成对话里的一条消息。

书写过程的格式、给 Claude 的固定说明（protocol()）、各工具返回给 Claude 的话都在这里；想调整 Claude 读到的内容，改这个文件
（插件 inkpad-plugin/inkpad/hooks/register.tsx 里的工具说明讲同一件事时要和这里一致；tests/test_prompt_rules.py 守着两边）。
"""

import re

MAX_OTHER_GROUPS = 12  # 整本消息里，一页上不带 ★ 的组最多列出多少（取最近写的）


def fmt_span(ms):
    """时长：不到 1 秒 / 3 秒 / 1 分 05 秒 / 2 小时 10 分 / 3 天。"""
    if ms < 1000:
        return "不到 1 秒"
    s = int(round(ms / 1000))
    if s < 60:
        return f"{s} 秒"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m} 分 {s:02d} 秒"
    h, m = divmod(m, 60)
    if h < 24:
        return f"{h} 小时 {m} 分"
    return f"{h // 24} 天"


def fmt_clock(ms):
    """相对本页第一笔的时刻：mm:ss 或 h:mm:ss，超过一天写「第 n 天」。"""
    s = max(0, int(ms // 1000))
    if s >= 86400:
        return f"第 {s // 86400 + 1} 天"
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def fmt_box(b):
    return f"x {b[0]:.0f}–{b[2]:.0f}，y {b[1]:.0f}–{b[3]:.0f}"


def asking(g):
    """还要回答的红笔问题：红笔、之前几轮没有回应指着它（平板发来 answered）。"""
    return bool(g.get("red")) and not g.get("answered")


def red_label(g):
    if not g.get("red"):
        return ""
    return "｜红笔（回答过）" if g.get("answered") else "｜红笔（问题）"


def timeline_hints(listed):
    """列出来的这几组里真有的情况才带的说明（2026-11-16 规则瘦身 C 组，从固定说明挪到这里）：
    有分了几行的组，说只指其中一行怎么写；电脑识别标着「只按中文认」「只按英文认」的，说那是什么意思。"""
    out = []
    rows = [g for g in listed if (g.get("lines") or 0) >= 2]
    if rows:
        out.append(ROWS_HINT.format(g=rows[0]["id"]))
    for lang in ("zh-only", "en-only"):
        if any(g.get("reco") and g.get("reco_lang") == lang for g in listed):
            out.append(RECO_ONLY[lang])
    return out


def build_timeline(groups, now_ms, include_process, star=None):
    """把笔迹分组写成文字。groups: [{id, t0, t1, n, erased, erasedAt, bbox, inSel, revisit}]。

    单页投递（不给 star）：整页都交上来了，每组都列，不标 ★。
    整本消息（star 说明 ★ 的含义）：inSel 的组标 ★；不带 ★ 的只列还没回答的红笔问题和最近写的几组。
    列出来的组里有分行的、识别标着「只按…认」的，末尾各带一句说明（timeline_hints）。
    """
    if not groups:
        return "这一页还没有手写笔迹。"
    groups = sorted(groups, key=lambda g: g["t0"])
    page_t0 = groups[0]["t0"]
    wrote = lambda g: g.get("tw") or g["t1"]  # noqa: E731 - 这组写完的时刻（回头补的笔画不算，见 pages.compute_groups）
    prev_t1 = {g["id"]: (wrote(groups[i - 1]) if i else None) for i, g in enumerate(groups)}
    if star:
        shown = [g for g in groups if g.get("inSel")]
        rest = [g for g in groups if not g.get("inSel")]
        # 不带 ★ 的：还要回答的红笔问题总要列出来；其余（回答过的红笔也算）只列最近写的几组
        others = [g for g in rest if asking(g)] + [g for g in rest if not asking(g)][-MAX_OTHER_GROUPS:]
        shown_ids = {g["id"] for g in shown} | {g["id"] for g in others}
    else:
        shown_ids = {g["id"] for g in groups}
    omitted = len(groups) - len(shown_ids)

    def mark(g):  # 每行开头：整本消息里新写的标 ★、别的空着；单页不标
        return ("★ " if g.get("inSel") else "   ") if star else ""

    if not include_process:
        lines = ["笔迹分组（这次没有附书写过程，只有位置）："]
        listed = [g for g in groups if g["id"] in shown_ids and g.get("n", 0) > g.get("erased", 0)]
        for g in listed:
            lines.append(f"{mark(g)}{g['id']}｜{fmt_box(g['bbox'])}{red_label(g)}{fmt_reco(g)}")
        if star:
            lines.append(f"★ 表示{star}。")
        # 这里不写「分 N 行」（fmt_rows 只在书写过程里写），分行那句也就不带
        return "\n".join(lines + timeline_hints([dict(g, lines=0) for g in listed]))

    last_t1 = max(g["t1"] for g in groups)
    lines = [
        f"书写过程（时间从这一页第一笔算起{'；★ 表示' + star if star else ''}）。这一页共 {len(groups)} 组笔迹，"
        f"最近一笔在 {fmt_span(now_ms - last_t1)}前。"
    ]
    if omitted > 0:
        lines.append(f"（其余较早的 {omitted} 组未列出）")
    # 已经全部擦掉的组不逐条列，只给编号；整本消息里不带 ★ 的只给个数
    gone = [g for g in groups if g["id"] in shown_ids and g.get("n", 0) and g.get("erased", 0) >= g["n"]]
    if gone:
        mine = [g["id"] for g in gone if g.get("inSel") or not star]
        bits = ([f"{'★ ' if star else ''}{'、'.join(mine)}"] if mine else []) + ([f"不带 ★ 的 {len(gone) - len(mine)} 组"] if len(gone) > len(mine) else [])
        lines.append(f"已经全部擦掉的（{'；'.join(bits)}，共 {sum(g['n'] for g in gone)} 笔）不逐条列出。")
        shown_ids -= {g["id"] for g in gone}
    listed = [g for g in groups if g["id"] in shown_ids]
    for g in listed:
        parts = [f"{fmt_clock(g['t0'] - page_t0)} 开始，写了 {fmt_span(wrote(g) - g['t0'])}"]
        if g.get("late") and g.get("lateAt"):
            parts.append(f"其中 {g['late']} 笔是 {fmt_clock(g['lateAt'] - page_t0)} 回头补的")
        p = prev_t1[g["id"]]
        if p is not None:
            gap = g["t0"] - p
            parts.append("紧接上一组" if gap < 1500 else f"之前停顿 {fmt_span(gap)}")
        desc = f"{g.get('n', 0)} 笔"
        if g.get("erased"):
            desc += "，已全部擦掉" if g["erased"] >= g.get("n", 0) else f"，其中 {g['erased']} 笔已擦掉"
            if g.get("erasedAt"):
                desc += f"（{fmt_clock(g['erasedAt'] - page_t0)} 擦）"
        extra = "｜回头补写（写在较早的笔迹旁边）" if g.get("revisit") else ""
        lines.append(f"{mark(g)}{g['id']}｜{'，'.join(parts)}｜{fmt_box(g['bbox'])}｜{desc}{red_label(g)}{extra}{fmt_rows(g)}{fmt_reco(g)}")
    return "\n".join(lines + timeline_hints(listed))


def memory_lines(meta):
    """认字的帮手：我以前更正过的读法（更正表里和这一页相关的几条）、领域词表。"""
    out = []
    cs = [c for c in meta.get("corrections") or [] if c.get("guess") and c.get("text")]
    if cs:
        out.append("你以前读错过的（我在确认卡片上更正的）：" + "；".join(f"「{c['guess']}」→「{c['text']}」" for c in cs) + "。")
    v = [t for t in meta.get("vocab") or [] if t]
    if v:
        out.append("领域词表（认字时参考）：" + "、".join(v) + "。")
    return out


def fmt_rows(g):
    """一组写了几行（比如列表的编号和上一行连着写成了一组）：只指其中一行时用 g3:1、g3:2。"""
    n = g.get("lines") or 0
    if n < 2:
        return ""
    names = "、".join(f"{g['id']}:{k}" for k in range(1, n + 1))
    return f"｜分 {n} 行（{names}）"


RECO_LANG = {"zh": "按中文认", "en": "按英文认", "zh-only": "只按中文认", "en-only": "只按英文认"}


def fmt_reco(g):
    """电脑识别的旁证：Windows 手写识别（按笔画）和 PP-OCR（看字帖里这一块）；只有 Windows 的时候照旧只写读法。
    Windows 识别判断过语种的（reco_lang）在后面括号里写明按什么认的。"""
    r, o = g.get("reco"), g.get("ocr")
    if not r and not o:
        return ""
    lang = RECO_LANG.get(g.get("reco_lang")) if r else None
    tag = f"（{lang}）" if lang else ""
    win = f"「{r[0]}」" + (f"（或：{' / '.join(r[1:])}）" if len(r) > 1 else "") if r else ""
    if not o:
        return f"｜电脑识别{tag}：{win}"
    return "｜电脑识别：" + "；".join(([f"Windows{tag}{win}"] if r else []) + [f"PP-OCR「{o}」"])


RECO_HINT = (
    "「电脑识别」是本机的手写识别：Windows 按笔画顺序认，PP-OCR 看字帖里那一块；都常把相邻的字拆错、认成形近字，公式基本认不了，"
    "只当旁证，以图为准，结合上下文判断。括号里写着 Windows 按中文还是英文认的（中英混写的按中文认）。识别结果和你的读法一致时不要问。"
    "「你以前读错过的」是我在确认卡片上更正过的读法，「领域词表」是这本和项目里的常用术语，认字时参考。"
)

# 识别结果标着「只按…认」时才带的一句（2026-11-16 规则瘦身 C 组：从固定说明挪到书写过程后面，见 timeline_hints）
RECO_ONLY = {
    "zh-only": "「只按中文认」表示本机没有英文识别器，英文会被认成形近的汉字。",
    "en-only": "「只按英文认」表示本机没有中文识别器，中文会被认成不相干的英文字母。",
}

# 有分了几行的组时才带的一句（2026-11-16 规则瘦身 C 组：从固定说明的「写回」挪到书写过程后面；server.line_anchors 认 g3:1）
ROWS_HINT = ("分了几行的组只想指其中一行时，anchor 写 {g}:1（第 1 行，从上往下数，其余类推）；"
             "只写 {g} 会落在整组中间，看着像指别的行。")


# 一条改动规则。②：红字写在卡片（或短批注）上的，改写接在卡片下面（write 带 card，消息里「卡片上的红字」那一段说怎么回）；
# 写在纸上别处的，才回一条新的
EDIT_RULE = (
    "改东西只按这一条规则：① 解释、检查、提建议，直接做；"
    "② 我用红笔要你改写你的某条回答：红字写在卡片上的，改好的接在卡片下面（write 带 card）；"
    "写在纸上别处的，回一条新的 write（anchor 填那条红笔），旧的那条我自己擦；"
    "③ 改电脑上的原文件，要有明确的文件和范围——我已经明确说「直接改这些」就照改，不再逐条问（是已导入的文档，动手前照样先调 ink_edit）；"
    "④ 你自己想多改的地方，用 suggest 一处一条提出来，等我采纳；"
    "⑤ 没确认的手写读法可以带着假设解释，不能据此改原文件，也不能代进计算。"
)

PAGE_FACTS = {
    "blank": "这一页是空白纸，上面是我写的内容。",
    "zotero": "这一页是 Zotero 文献的书页（只读资料）。",
    # 2026-11-16 用户定留着（一本 PDF 可能是自己的稿子也可能是文献，服务分不出来）
    "pdf": "这一页是 PDF 的书页：看内容判断是我的稿子还是参考资料。",
    "board": "这一页是你推送到平板的东西。",
}


def role_facts(meta):
    """「这次：」那句：这一页是谁的内容，这次交上来的笔迹（整本消息里是新写的和还没回答的红笔）写在什么上面。"""
    r = meta.get("role") or {}
    if r.get("page") == "editable":
        page = f"这一页是文档的书页，原文件是 {r.get('src')}（要改它，先调 mcp__inkpad__ink_edit，见「改文件」那一条）。"
    else:
        page = PAGE_FACTS.get(r.get("page"), "")
    chosen = [g for g in meta.get("groups") or [] if (g.get("inSel") or asking(g)) and g.get("n", 1) > g.get("erased", 0)]
    bits = [page]
    ids = [g["id"] for g in chosen if g.get("on") == "doc"]
    if ids:
        bits.append("、".join(ids) + " 写在书页的印刷内容上。")
    text = "".join(b for b in bits if b)
    return "这次：" + text if text else ""


COLORS = ("颜色：红笔是我要问你的问题或对你的要求，黑笔是我自己的推导和草稿，蓝色是你之前写回来的批注；"
          "之前几轮回答过的红笔问题在书写过程里标着「回答过」，深蓝带 ★ 的是我采纳的。")

# 空白本子里收成小蓝点的短批注（阶段 D1，2026-11-15 补的一句）：图里只画一个点，消息里说明那些点是什么
DOT_HINT = ("图里没有数字的蓝色小圆点是收起来的短批注：被我后来写的字压到、或者到的时候旁边放不下，平板把它收成了一个点，"
            "我点一下能看。")

# 交上来的一页怎么回（《产品定义》第 3 节「按一条规则回」）：红字必做，红字里说了怎么回就照那样；
# 红字之外少而准、可以没有，点拨最多一条，都写依据。短的、长的各写在哪，见「写回」那一条
TWO_LAYERS = (
    "两层：我写完一段点「AI」才交上来，不用赶快。"
    "① 红字是我明确要你办的，一条条办完：问的就答，要的就给，要生成或修改文件就照做（改已导入的文档照「改文件」那一条走）；"
    "红字里说了要怎么回（比如「只给提示」），就照那样回。"
    "② 红字之外，自己通读整页，只指出真正的错和漏，少而准，没有就一条都不写；其中最多一条点拨——我没想到的那个关键点，"
    "用 insert 放在它该在的位置（缺一支就用 box 指两支之间的空白），点到为止，不替我写；每条都写出依据：哪一步、哪篇文献、项目里哪个文件。"
    "红字没要求的，不改电脑上的文件。"
)

# 2026-11-14 用户定了方向，2026-11-16 用户确认了措辞
# 蓝字怎么写：和 TWO_LAYERS 第②条是同一个意思的两面（纸上的思考是用户的，蓝字只补还没有的）。用户的原话：
# 「这样看起来是你告诉我的方案，但蓝色的内容有一些是我自己或者我们共同探讨的结果。」回答要「体现出 Claude 对我这些思考的启发」。
VOICE_HINT = (
    "蓝字只补我纸上还没有的：这和上面「两层」第②条（少而准、点到为止）是同一件事的两面——红字问的照样一条条答；红字之外没有新东西就不写，写了就要是新的。"
    "① 回答红字时，我已经写了的最多复述半句，只用来点明接着哪一处说；重心放在这一页上还没有的：一个我没连起来的联系、"
    "一个漏掉的情形、下一步值得问的问题。问题本身只要一个直接的答案时，就直接答，不硬凑。"
    "② 分清是谁的想法：蓝字里说到的想法、方案，是我在纸上写的或在对话里提的，就写明是我的（「你写的那一步」「你提的办法」）；"
    "是你和我一来一回定下来的，写「我们定的」；不要写成像是你在介绍一个方案。"
    "这张纸是我自己的思考，蓝字读起来要是像你在讲课，我就分不清哪些是自己想到的、哪些是新得到的。"
)


def _third(s):
    """写给系统提示的说明用第三人称：「我」换成「用户」，引号「」里我举的原话不动。"""
    return "".join(part if part.startswith("「") else part.replace("我", "用户")
                   for part in re.split(r"(「[^」]*」)", s))


def protocol():
    """固定说明：插件放进系统提示（每个对话一次，走缓存），投递里只放这一页的内容。

    各段的句子是按「我」（用户）的口气写的，这里改成第三人称拼起来。
    2026-11-16 规则瘦身（用户定的三组）：工具说明或每条消息里已经有一份的删掉，只留一句指路的话（写出工具全名：插件的工具
    注册时带 isDeferred: false，说明一直在上下文里，但别的插件能把它挪到 ToolSearch 后面，写全名 Claude 才找得到）；
    能由服务把关的五条改成服务把关（server.settle_items、App.reads_owed、App.owed_for）；两处细节挪到用到的地方（timeline_hints、
    插件里 ink_confirm 等不到时的返回）。tests/test_prompt_rules.py 守着总字数。"""
    rows = [
        "用户在平板的草稿纸上手写、画图、圈画，写完点「AI」交上来，代替在文本框里打字。这类消息以【草稿纸】开头，"
        "只带这一页的内容：图的路径、页面、原文、书写过程（笔迹分组 g1、g2…… 的先后、停顿、擦改）、这次的特别情况；"
        "固定的规则都在这里，消息里不再重复。",
        "看：先用 Read 看消息里列的图，再结合这次对话和项目文件理解我写的东西。" + COLORS
        + "我写的常是想法的雏形：帮它往前长一步，不要替我把话说完。",
        "认字：" + RECO_HINT + CONFIRM_HINT,
        TWO_LAYERS,
        VOICE_HINT,
        EDIT_RULE,
        "写回：" + WRITE_HINT,
        CARD_HINT,
        ASK_HINT,
        "画：" + SKETCH_HINT,
        "建议：" + SUGGEST_HINT,
        FILE_HINT,
        "概念图：" + MAP_HINT,
        OTHER_HINT,
    ]
    return "## 手写草稿纸（inkpad）\n" + "\n".join("- " + _third(r) if k else _third(r) for k, r in enumerate(rows))


MAP_KIND = {"label": "建议的关系词", "node": "建议加的概念", "link": "建议的连线", "group": "建议的分组"}


def verdict_block(vs):
    """「修改建议的决定」一段：我对你提的修改（以及概念图上建议加的概念、连线、分组）逐条点的 ✓/×。"""
    where = {"doc": "（在文档上）", "mine": "（在我写的内容上）"}
    rows = [f"- {v['id']}{MAP_KIND[v['kind']] if v.get('kind') in MAP_KIND else where.get(v.get('on'), '')}「{str(v.get('text') or '')[:120]}」："
            f"{'采纳' if v.get('verdict') == 'yes' else '不采纳'}{'；旁边写了 ' + str(v['near']) if v.get('near') else ''}" for v in vs]
    edits = [v for v in vs if v.get("kind", "suggest") not in MAP_KIND]
    maps = [v for v in vs if v.get("kind") in MAP_KIND]
    what = "虚线框是你提的修改" if not maps else "虚线是你在概念图上建议加的东西" if not edits else "虚线是你提的修改和概念图上建议加的东西"
    tail = []
    if edits:
        tail.append(("修改里" if maps else "") + "同意的照改：在文档上的，动手前先调 mcp__inkpad__ink_edit（path 填原文件，不带 mode："
                    "它在平板上问我覆盖还是另存，并先留底），按它返回的路径改，改完用 mcp__inkpad__ink_import 导入改好的那个文件；"
                    "要改两个文件就调两次 ink_edit。在我写的内容上的，我自己改，你不用动。不同意的别改；旁边写了字的，先看我写了什么。")
    if maps:
        tail.append("关系词、概念、连线、分组：采纳的在平板上已变成实线，算进我的图里；不采纳的已变淡，别再提；旁边写了字的，先看我写了什么。")
    tail.append("采纳的改完后，用 ink_reply 的 result 逐条告诉我结果（anchor 填 s 编号，ok 填 true / false，没改成写一句原因）。")
    return (f"修改建议的决定：图里标 {'、'.join(v['id'] for v in vs)} 的{what}，我逐条选了：\n" + "\n".join(rows)
            + "\n" + "\n".join(tail))


def owed_block(owed):
    """还没回报的修改（2026-11-16 规则瘦身 B 组⑤，服务记着，见 server.App.owed_for）：之前的消息里我采纳了、你还没用 result 回报的。
    owed：[{sub, page, ids}]：sub 是那次投递的编号，page 是整本消息里的页码（单页投递是 None），ids 是那次消息里的 s 编号。
    投递编号不写成 submission="…" 的样子：插件按消息里第一个 submission="…" 认这一轮在回哪次投递。"""
    rows = []
    for o in owed:
        where = f" 第 {o['page']} 页" if o.get("page") else ""
        rows.append(f"- 投递 {o['sub']}{where}：{'、'.join(o['ids'])}")
    return ("还没回报的修改：之前我采纳的这几条，你还没用 result 告诉我改成了没有：\n" + "\n".join(rows)
            + "\n改完了的，用 mcp__inkpad__ink_reply 逐条回报 result（submission 填上面那次的投递编号，整本的另带 page；"
              "anchor 填 s 编号，ok 填 true / false，没改成写一句原因）；还没改的，照那次「修改建议的决定」改完再报。")


ANSWER_HEAD = 200  # 之前写过的长回答：消息里只带前这么多字，让 Claude 知道自己答过什么


def _head(text, n=ANSWER_HEAD):
    text = " ".join(str(text).split())
    return f"{text[:n]}{'…' if len(text) > n else ''}"


def fmt_prev(note):
    """「你之前在这一页写过的批注」里的一条：短批注是原话；长回答（平板上的圈号）写成「圈号 n（问：q）：前 200 个字…」，
    卡片下面接着回过的各段（回应卡片上的红字）另起一行接在后面：「  - 接着（回应红字「…」）：前 200 个字…」。
    纸上的短批注被我写了红字、收成的卡片（note 为真）写成「圈号 n（原来是短批注）：原话」。"""
    if isinstance(note, str):
        return note.strip()
    if not isinstance(note, dict) or not str(note.get("text") or "").strip():
        return ""
    head = f"圈号 {note['n']}" if note.get("n") else "长回答"
    q = "（原来是短批注）" if note.get("note") else f"（问：{note['q']}）" if note.get("q") else ""
    out = f"{head}{q}：{_head(note['text'])}"
    for m in note.get("more") or []:
        if isinstance(m, dict) and str(m.get("text") or "").strip():
            mq = f"（回应红字「{m['q']}」）" if m.get("q") else ""
            out += f"\n  - 接着{mq}：{_head(m['text'])}"
    return out


ZH_NUM = "一两三四五六七八九十"


def count_zh(n):
    """图的张数：一、两、三……十，再多写数字。"""
    return ZH_NUM[n - 1] if 1 <= n <= len(ZH_NUM) else str(n)


def card_lines(cards, page=None):
    """卡片上的红字（2026-11-14）：用户在长回答的卡片上用红笔写了批注，附了卡片的图。cards：[{n, img, note?}]；page：整本消息里的页码。
    note 为真的是纸上的短批注收成的卡片：用户在你写在纸上的一条短批注上用红笔写了字，交稿时它收成了圈号。"""
    out = []
    for c in cards or []:
        if not isinstance(c, dict) or not c.get("img"):
            continue
        n = c.get("n") or ""
        if c.get("note"):
            head = (f"圈号 {n} 的卡片原来是你写在纸上的一条短批注：我在它上面用红笔写了字，它就收成了圈号 {n}，见图 {c['img']}："
                    "蓝字是你那条短批注（照纸上的换行），红字是我写的。")
        else:
            head = f"圈号 {n} 的卡片上我用红笔写了批注，见图 {c['img']}：蓝字是你之前的回答，红字是我写的。"
        out.append(head + f"回应用 ink_reply 的 write，card 填 {n}{'（再带上 page=' + str(page) + '）' if page else ''}，"
                   "q 填你读到的那句红字，text 写回应；回应接在那张卡片下面（要改写整段，也写在下面）。")
    return out


def card_image_line(c):
    """「先用 Read 看这几张图」里卡片那一行。"""
    what = "蓝字是你原来写在纸上的短批注，红字是我在它上面写的" if c.get("note") else "蓝字是你之前的回答，红字是我在卡片上写的"
    return f"- 圈号 {c.get('n') or ''} 的卡片：{c['img']}（{what}）"


TEXT_MAX = 1000  # 原文只放一份、限这么多字；要核对时 Claude 去读原文件


def _clip(s, n):
    return s if len(s) <= n else s[:n] + "……"


def text_block(book_text, src=None):
    """这一页的书本原文，只放一份并限长；另说整页原文在哪，要核对时再读。"""
    if not book_text:
        return []
    out = [f"这一页的书本原文{'（节选）' if len(book_text) > TEXT_MAX else ''}：\n" + _clip(book_text, TEXT_MAX)]
    if src:
        out.append(f"整页原文在 {src[0]} 第 {src[1]} 页，要核对时再读。")
    return out


def build_message(meta, paths, page_label, book_text, sub_id, snapshot=False, src=None):
    """写成投递到对话里的一条消息：只放这一页的内容，固定说明在对话的系统提示里（protocol()）。

    meta 为平板发来的数据（不含图片）；paths 的 crop 是这一页的图，sheet 是字帖（没有笔迹时没有）；
    src：(PDF 路径, 页码)，整页原文在哪。"""
    include_process = bool(meta.get("include_process", True))
    groups = meta.get("groups") or []
    if snapshot:
        head = ["【草稿纸·快照】这是我平板草稿纸当前这一页（你调用 ink_snapshot 取来的）。"]
    else:
        head = ["【草稿纸】我在平板上写了一些东西发给你。"]
    facts = role_facts(meta)
    if facts:
        head.append(facts)
    notes = "笔迹旁的灰色编号 g1、g2…… 是笔迹分组" + ("；浅灰色是我擦掉的笔迹" if include_process else "")
    # 点「AI」交的是整页；快照的图是平板按笔迹的外框截的，页面上有笔迹时不是整页，照实说
    if snapshot and any(g.get("n", 0) > g.get("erased", 0) for g in groups):
        imgs = [f"- 这一页有笔迹的那一块：{paths['crop']}（快照只截到笔迹的外框，框外的内容不在图里；{notes}）"]
    else:
        imgs = [f"- 这一页：{paths['crop']}（{notes}）"]
    if paths.get("sheet"):
        imgs.append(f"- 字帖：{paths['sheet']}（每组笔迹裁出来、统一字高，左边是编号；认字时看这张）")
    cards = [c for c in meta.get("cards") or [] if isinstance(c, dict) and c.get("img")]
    for c in cards:  # 长回答卡片上（或纸上的短批注上）我写了红字：每张卡片一张图
        imgs.append(card_image_line(c))
    lines = head + [f"先用 Read 看这{count_zh(len(imgs))}张图：\n" + "\n".join(imgs)]
    lines.append(f"页面：{page_label}。")
    lines += text_block(book_text, src)
    lines.append(build_timeline(groups, meta.get("now") or 0, include_process))
    lines += memory_lines(meta)
    prev = [t for t in (fmt_prev(x) for x in meta.get("prev_notes") or []) if t][-12:]
    if prev:
        lines.append("你之前在这一页写过的批注：\n" + "\n".join(f"- {t}" for t in prev)
                     + ("\n" + DOT_HINT + "它们的字就在上面这几条里。" if meta.get("dots") else ""))
    if cards:
        lines.append("卡片上的红字：\n" + "\n".join(f"- {t}" for t in card_lines(cards)))
    vs = [v for v in meta.get("verdicts") or [] if isinstance(v, dict) and v.get("id")][:20]
    if vs:  # 我对你提的修改建议逐条点了 ✓/×
        lines.append(verdict_block(vs))
    owed = [o for o in meta.get("owed") or [] if isinstance(o, dict) and o.get("sub") and o.get("ids")]
    if owed:  # 之前采纳的修改还没回报的（服务记着）
        lines.append(owed_block(owed))
    # 别的旧批注不请 Claude 整理：采纳、擦掉都由我在平板上用笔定
    lines.append(f'写回用 mcp__inkpad__ink_reply（submission="{sub_id}"）。')
    return "\n\n".join(lines)


# 写回（「写回」那一条的全部内容）：用哪个工具、短的长的各写在哪、读法、标记。位置由页面定（app.js 的 buildFreeNote、
# answerSpot、blockSpot），Claude 只管 anchor 指对。2026-11-16 规则瘦身：
# - 带上 submission：每条消息末尾自带（「写回用 …（submission=…）」）；分了几行的组怎么指：书写过程后面真有分行的组时才带（ROWS_HINT）；
# - 批改符号清单（各自什么意思、哪几种要带 text）：在插件 ink_reply 的说明里；cross、wavy、strike 不带 text 由服务退回并说明；
# - 短的长的按多少字分、不另画 number 配圈号、write 的 anchor 不写 end：服务把关（server.settle_items），写错了工具结果里说；
# - 读法漏了哪几组：服务在工具结果里点名（App.reads_owed）
WRITE_HINT = (
    "草稿纸上来的就在草稿纸上答，用 mcp__inkpad__ink_reply。"
    "写在纸上的话，语言跟我写的一致：我写英文就用英文回。"
    "放在哪由草稿纸定，你只要把 anchor 指对：填笔迹编号，指印刷文字或没有编号的地方用 box。"
    "回答红字：短的用 note（问句用 question），anchor 填那个红笔问题的编号：它成为一条用细线连过去的短批注"
    "（空白本子里挡了我后来写的字，就收成一个小蓝点）。"
    "长的用 write，anchor 填所答的那条红字（或它讲的那处笔迹），q 填问题原文：平板在那里标一个圈号，我点圈号才看到全文，不占纸面。"
    "红笔是指令（标出、圈出、排序、整理……）时，可以只用标记回应，再用 tick 标在那条红笔上（anchor 填它的编号），表示处理过了。"
    "每次回都给红笔那几组和回应到的那几组各交一条 read（照写的原样转写）。"
    "标记用来代替大段的话，不是越多越好，只标要紧的：对我写的东西（或书页上的字）直接标在上面，各种批改符号怎么用见 ink_reply 的说明。"
    "只有非得用话说的才写成短批注或 write。"
    "对话里只用半句话说写了什么；代码、文件改动这类纸上放不下的照常在对话里做。"
)

# 卡片上的红字（2026-11-14）：用户在长回答的卡片上（或纸上的短批注上）用红笔批注、追问，Claude 的回应接在同一张卡片下面。
# 怎么回在每条附了卡片的消息里（card_lines、card_image_line）和插件 ink_reply 的说明里，这里只指路（2026-11-16 规则瘦身）
CARD_HINT = "卡片上的红字：我在长回答的卡片上（或纸上的短批注上）写了红字时，消息里附那张卡片的图和怎么回，照那一段做（write 带 card）。"

# 问话卡片（2026-11-14，阶段 C）：只有这两种情况才发卡片到平板；没答就停手等着、忽略了不再问——这些在插件 ink_ask 的说明和
# 它的返回里（ASK_IGNORED、插件的 ASK_PENDING），这里只留什么时候用（2026-11-16 规则瘦身）
ASK_HINT = ("问话卡片：只有要我回答才能继续、或结果纸上放不下时，才用 mcp__inkpad__ink_ask 发卡片到平板；"
            "没答时怎么办见它的说明和返回。")

# 别的几种消息和工具（2026-11-16 规则瘦身）：整本消息、撤回消息自己写明了是什么、怎么回（build_scan_message、build_undo_message）；
# 整本检测、推页、导入、快照什么时候用、怎么用，在插件各工具的说明里
OTHER_HINT = ("其他消息：【草稿纸·整本】【草稿纸·撤回】这类消息里写明了是什么、怎么回。"
              "整本检测、推一页给我圈画、导入整份文档、看我此刻草稿纸上这一页，分别用 mcp__inkpad__ink_scan、ink_show、ink_import、"
              "ink_snapshot，用法见各自的说明。")

# 用户在平板上点了问题卡片的「忽略」（2026-11-14 用户在 iPad 上试过后定）：工具还在等时这样告诉 Claude；已经不等了的不送消息
ASK_IGNORED = ("用户忽略了这个问题，没有回答。不要再问同一个问题；按最稳妥的做法继续，或者停下来在对话里说明，"
               "不要替用户做有风险的选择。")

# 修改建议：页面只把指着书页（或推送页）上印刷内容的 suggest 画成带 ✓ × 的虚线框；空白本子上、指着用户手写的字的，画成普通短批注
SUGGEST_HINT = (
    "suggest 只用在改文档：书页（或你推送的页）上印刷的内容，按改动规则第④条，一处一条，anchor 或 box 指着要改的那块，"
    "text 写改成什么（如「改为：……」「删去这句」）。我自己写的字有错，用批改符号（strike 写改成什么、insert、cross 写理由），不用 suggest："
    "指着手写的字或写在空白本子上的 suggest，草稿纸只当一条短批注画，没有 ✓ ×。"
    "我在平板上点建议框旁的 ✓ / ×，决定随我下一次交上来的消息带给你，照那里说的做。"
)

# 改电脑上的文件（2026-11-14，阶段 C；《产品定义》第 4 节）：动手前在平板上问覆盖还是另存、先留底，平板上能撤回。
# 以前「新文件放进项目，不覆盖原文件」和「改原文件再原地更新」两种说法互相矛盾，删了，换成这一条。
# 2026-11-16 规则瘦身：一步步怎么做（问覆盖还是另存、没选就等、忽略了不改、按返回的路径改、改完导入、result 回报、带 mode、
# 一次只办一个文件、留底在哪）在插件 ink_edit 的说明和它的返回里（edit_go、EDIT_PENDING、EDIT_IGNORED、edit_offline），这里只留
# 什么时候要先调它；「从留底拿旧版回来盖掉现在这份也算改文件」是 2026-11-16 用户定的那一句，缩进括号里留着
FILE_HINT = (
    "改文件：要改一份已导入草稿纸的文档（我交上来的书页对应的原文件、我在对话里点名的；从留底拿旧版回来盖掉现在这份也算），"
    "动手前先调 mcp__inkpad__ink_edit，照它的说明和返回做。"
)

# ink_edit 的几种返回（服务给，插件原样交给 Claude）
EDIT_PENDING = ("用户还没选（卡片留在平板顶上）。这一轮就停在这里等着：不要替用户选，也不要先动这个文件；"
                "用户选了，会作为一条新消息（【草稿纸·回答】）送来，到时按消息里说的带上 mode 再调一次 ink_edit。")
EDIT_WITHDRAWN = "这张卡片已经撤下了：这个文件刚才已经带着 mode 调过 ink_edit、办好了，照那一次的返回做。"
EDIT_IGNORED = ("用户忽略了，这次不要改这个文件（没有留底，也没有建新文件，原文件没动）。不要再问同一个问题；"
                "需要的话在对话里说明这次没改。")
IMPORT_REMIND = ("提醒：这个文件在上次导入之后改过，留底里却没有那之后的记录。如果是你改的，说明改之前没先调 mcp__inkpad__ink_edit，"
                 "用户在平板上撤不回这次修改；下次改已导入的文档，动手前先调它。是用户自己改的就不用管。")


# ink_reply 写回时服务查出来的，接在工具结果后面告诉 Claude（2026-11-16 规则瘦身 B 组：原来写在固定说明里的几条改成服务把关，
# 见 server.settle_items、App.reads_owed）。k 是 items 里的第几条（从 1 数）
REPLY_LONG_NOTE = ("第 {k} 条 {type} 约 {n} 字，比短批注长（超过 {max} 字），收成了圈号卡片，放在{where}旁边；"
                   "长的回答直接用 write（回答红字时带上 q，卡片顶上显示问的是什么）。")
REPLY_END_ANCHOR = ("第 {k} 条 write 的 anchor 写了 end，当成没指明答哪句：圈号由草稿纸放（这一轮最后一句还没答的红笔问题旁边）；"
                    "write 的 anchor 填所答的那条红笔。")
REPLY_NUMBER_DROPPED = "第 {k} 条 number 没画：它和长回答指着同一处，圈号是草稿纸自己标的，不用另画编号去配。"
REPLY_REJECTED = "第 {k} 条{type}没写上：{why}。"  # 同一次的别的照写：工具结果开头那句「已写到草稿纸……共 N 条」说了
REPLY_BAD_RESULT = "第 {k} 条 result 的 anchor「{s}」不是那次消息「修改建议的决定」里的 s 编号，没记上。"
REPLY_MISSING_READS = ("还缺 {ids} 的读法（红笔那几组和这次回应到的组都要交）：各补一条 read（anchor 填组号，text 照写的原样转写，"
                       "不翻译、不解释）。")
# 一条批注为什么没写上（server.item_problem）：批改符号里 ✗、存疑、删除线必须带一句理由（2026-11-16 起不带的退回并说明，原来是悄悄不画）
MISSING_TEXT = {"cross": "缺一句 text（为什么错）", "wavy": "缺一句 text（疑在哪）", "strike": "缺一句 text（改成什么或为什么删）",
                "insert": "缺 text（补的字）", "number": "缺 text（编号）", "read": "缺 text（读法）", "label": "缺 text（关系词）",
                "node": "缺 text（概念）", "suggest": "缺 text（改成什么）"}


def edit_offline(name):
    """ink_edit 没带 mode、平板又没打开草稿纸：改在对话里问。"""
    return (f"平板现在没打开草稿纸，没法弹卡片：在对话里问用户，改《{name}》是覆盖原文件还是另存一份，"
            "再带上 mode（overwrite 覆盖 / saveas 另存）调一次 ink_edit。原文件还没动。")


def edit_go(mode, original, target, title, local=False):
    """ink_edit 办好之后给 Claude 的话：该改哪个文件，改完怎么做。title：平板上对应的本子名（没导入过是 None）。
    local：对应的那本设成了「只在本地」（2026-11-16）：不说它叫什么，告诉 Claude 改完别导入（导入会被拦下）。"""
    if mode == "overwrite":
        head = f"可以改了：改 {original} 本身（覆盖原文件；改之前的样子已经留底，用户在平板上能撤回）。"
    else:
        head = f"已经另存了一份：{target}（和原文件一模一样）。改这个新文件，原文件 {original} 不要动。"
    if local:
        return head + ("这个文件在平板上对应的那本设成了只在本地：改完不要用 mcp__inkpad__ink_import 导入（会被拒绝），平板上那本不跟着换；"
                       "要换，请用户在平板抽屉里点「这本发往」选一个对话（就取消了只在本地）。")
    if not title:
        return head + ("这个文件没有导入过草稿纸，平板上没有对应的本子（留底照样做了）；要放到平板上，改完用 mcp__inkpad__ink_import 导入"
                       + (" " + target if mode == "saveas" else "它") + "。")
    switch = "，以后再改，改的是这个新文件" if mode == "saveas" else ""
    return head + (f"改完用 mcp__inkpad__ink_import 导入 {target}，平板上的《{title}》原地换成新版{switch}；"
                   "采纳的修改建议再用 ink_reply 的 result 逐条回报改成了没有。")


def build_undo_message(u):
    """用户在平板上撤回了一次修改：告诉改它的那个对话（存回 PDF 的告诉这本发往的对话），不用回复。
    u 是 server.undo_book 的结果：{action, mode, path, saved_as, file, t, aside, left, warning}。"""
    when = f"（{str(u.get('t') or '').replace('T', ' ')} 留的底）" if u.get("t") else ""
    if u.get("action") == "switched":
        body = (f"我在平板上撤回了那次另存：平板上那本换回了原文件 {u.get('path')}；另存出来的 {u.get('saved_as')} 留在电脑上，没删。"
                "之后再改，改的是原文件（照旧先调 mcp__inkpad__ink_edit）。")
    elif u.get("mode") == "savepdf":
        body = f"我在平板上撤回了上一次「存回 PDF」：{u.get('path')} 回到了存回之前{when}。"
    else:
        body = f"我在平板上撤回了对 {u.get('path')} 的上一次修改：电脑上的文件回到了那次修改之前{when}，平板上那本也换回去了。"
    if u.get("aside"):
        body += f"那次修改之后这个文件又改过；撤回前，当时那份另留在 {u['aside']}，要用可以从那里拿回。"
    if u.get("warning"):
        body += f"（{u['warning']}）"
    return "【草稿纸·撤回】" + body + "这条只是告诉你，不用回复，也不用动手。"


# 概念图（label、node、link、group 是建议，画成虚线，点 ✓ 才变实线；连错的用 cross、有疑问用 question、中心概念用 circle）：
# 怎么给在插件 ink_reply 的说明里，这里只指路（2026-11-16 规则瘦身）
MAP_HINT = ("我画概念图（框、圈着的词用箭头连起来）时，在图上互动：补关系词、建议加概念、加连线、归类"
            "（label、node、link、group），怎么给见 mcp__inkpad__ink_reply 的说明。")

# 图、公式（app.js 的 blockSpot 放：空白本子里先右后下、不压字；书页、推送页放在所指那块下面；没指着的接在内容后面）：
# sketch、figure、formula 怎么给、放在哪在插件 ink_reply 的说明里，这里只指路（2026-11-16 规则瘦身）
SKETCH_HINT = ("讲不清的画出来：方框图、流程用 sketch，要准确的数据图、函数曲线在电脑上画好用 figure，公式用 formula，"
               "怎么给见 mcp__inkpad__ink_reply 的说明。")

# 确认字迹：插件连着等 25 + 20 秒（register.tsx 的 waitConfirm）；等多久、等不到怎么办写在等不到时的返回里（插件的 CONFIRM_LATE，
# 2026-11-16 规则瘦身 C 组从这里挪过去），这里只留「读不准不要猜、先问」
CONFIRM_HINT = (
    "读不准、或和电脑识别不一致又关系到意思的字迹（字、符号、下标、数字）不要猜：先用 mcp__inkpad__ink_confirm 在平板上问我，"
    "拿到回答再往下写。"
)


def build_scan_message(title, infos, sub_id, origin="claude", only_new=False, skipped_old=0, truncated=0, owed=None):
    """整本检测：一本里写过字的每一页各一张图，附各页的书写过程（固定说明在对话的系统提示里，这里不附）。

    infos: [{no, image, label, scale, h, groups, now, first, clip, pdf?}]，groups 里 inSel 表示上次之后新写的。
    owed：之前采纳了、还没回报的修改（owed_block），放在最后那句「写回某一页用……」前面。
    """
    if origin == "tablet":  # 点「AI」时别的页也有新写的：平板带 only_new 一起交
        head = f"【草稿纸·整本】我把《{title}》里{'有新笔迹' if only_new else '写过字'}的页一起发给你（共 {len(infos)} 页）。"
    else:
        head = (f"【草稿纸·整本】《{title}》里{'有新笔迹' if only_new else '写过字'}的页（你调用 ink_scan 取来的，"
                f"共 {len(infos)} 页）。")
    lines = [head]
    if not infos:
        lines.append("没有符合条件的页。" + (f"（{skipped_old} 页的笔迹你之前都看过了）" if skipped_old else ""))
        return "\n\n".join(lines)
    lines.append(
        "每页一张图，用 Read 逐页看。图里笔迹旁的灰色编号 g1、g2…… 是这一页的笔迹分组（编号每页各自从 g1 起）。"
        "★ 是你上次看过之后我新写或擦改的，先看这些。"
    )
    notes = []
    if skipped_old:
        notes.append(f"另有 {skipped_old} 页没有新笔迹，没附上")
    if truncated:
        notes.append(f"页数太多，后面还有 {truncated} 页没附上（用 ink_scan 的 pages 指定页码再取）")
    if notes:
        lines.append("；".join(notes) + "。")
    for p in infos:
        new = sum(1 for g in p["groups"] if g.get("inSel"))
        bits = [f"── 第 {p['no']} 页：{p['label']}"]
        img = f"图：{p['image']}"
        if p.get("clip"):
            c = p["clip"]
            img += f"（只截了 y {c[1]:.0f}–{c[3]:.0f} 这一段，图里像素 ÷ {p['scale']:.2f} + {c[1]:.0f} = 页面 y 坐标）"
        elif p["scale"] < 0.6:
            # 空白本子的纸向上长过时，图的上沿不在页面的 y = 0：换算要加上图上沿的页面 y（p["y0"]，可以是负的）
            y0 = p.get("y0") or 0
            off = "" if abs(y0) < 0.5 else (f" + {y0:.0f}" if y0 > 0 else f" − {-y0:.0f}")
            img += (f"（这一页很长，图缩小到 {p['scale']:.2f} 倍；看不清时用 ink_scan 的 region=[y0,y1] 放大某一段，"
                    f"页面 y 坐标 = 图里像素 ÷ {p['scale']:.2f}{off}）")
        bits.append(img)
        if p.get("pdf"):
            bits.append(f"书页原文在 {p['pdf']} 第 {p.get('pdf_page', p['no'])} 页（要核对印刷内容时再读）")
        if p.get("unplaced"):
            bits.append(f"你之前写回这一页的 {p['unplaced']} 条批注还在排队，平板打开这一页时才会落下，图里还看不到；别重复写。")
        if p.get("first"):
            bits.append("这一页你第一次看，全部笔迹都算新写的。")
        elif not new:
            bits.append("这一页上次之后没有新写的。")
        facts = role_facts({"role": p.get("role"), "groups": p["groups"]})
        if facts:
            bits.append(facts)
        bits.append(build_timeline(p["groups"], p.get("now") or 0, True, star="上次之后新写或擦改的"))
        answers = [t for t in (fmt_prev(a) for a in p.get("answers") or []) if t]
        if answers:  # 图里只有圈号：让 Claude 知道自己在这一页答过什么
            bits.append("你之前在这一页写过的长回答（图里的蓝色圈号）：\n" + "\n".join(f"- {t}" for t in answers))
        if p.get("dots"):  # 图里只有小蓝点：让 Claude 知道那几个点是哪几条短批注
            bits.append(DOT_HINT + "这一页收起来的是：\n" + "\n".join(f"- {t}" for t in p["dots"]))
        if p.get("cards"):  # 长回答卡片上我写了红字：每张卡片另一张图
            bits.append("卡片上的红字：\n" + "\n".join(f"- {t}" for t in card_lines(p["cards"], p["no"])))
        if p.get("verdicts"):
            bits.append(verdict_block(p["verdicts"]))
        lines.append("\n".join(bits))
    owed = [o for o in owed or [] if isinstance(o, dict) and o.get("sub") and o.get("ids")]
    if owed:
        lines.append(owed_block(owed))
    lines.append(f'写回某一页用 mcp__inkpad__ink_reply（submission="{sub_id}"，page=页码），anchor 用那一页的笔迹编号，box 用那一页图里的像素坐标；'
                 f'不同页分别调用。ink_confirm 也要带 submission="{sub_id}" 和 page。')
    return "\n\n".join(lines)


def build_confirm_answer(c, answers, late=False):
    """把确认卡片的回答写成文字：给 ink_confirm 的返回值，或（晚到时）一条新消息。"""
    lines = []
    if late:
        lines.append(f"【草稿纸·确认】你之前在草稿纸上问我拿不准的字迹（{c['where']}），我现在回答了：")
    for k, (qq, a) in enumerate(zip(c["questions"], answers), 1):
        where = qq["anchor"] or "那一处"
        ask = qq["question"]
        guess = f"（你读成「{qq['guess']}」）" if qq.get("guess") else ""
        if a.get("skip"):
            ans = "我没有回答（跳过了），按你的理解来，但在回复里说明这处是推测的。"
        elif qq.get("guess") and a["text"] == qq["guess"]:
            ans = f"对，是「{a['text']}」。"
        else:
            ans = f"是「{a['text']}」。"
        lines.append(f"{k}. {where}：{ask}{guess} → {ans}")
    if late:
        lines.append("请据此继续。已经写回草稿纸的内容要是按错的读法写的，用 ink_reply 补一条更正（写上去的蓝字你撤不回，我会自己擦），"
                     "这几组的读法也按这里再交一条 read（新的会替掉旧的）。")
    else:
        lines.append("（直接按这些读法理解；这几组要交 read 的，按这里的读法写。）")
    return "\n".join(lines)


def build_ask_answer(c, answer, late=False):
    """把问话卡片的回答写成文字：给 ink_ask 的返回值，或（Claude 已经不等了）一条新消息。
    answer：{"choice": 点的选项} 或 {"image": 手写回答的图}（笔迹原样交，不转文字，Claude 用 Read 看图读）。
    改文件前问「覆盖还是另存」的那张卡片（c 带 edit）：晚到的回答写明是哪个文件、选了什么、接下来带上 mode 再调一次 ink_edit。
    {"ignored": True}：用户点了「忽略」（只在工具还在等时用到；已经不等了的，服务不送消息）。"""
    e = c.get("edit")
    if answer.get("ignored"):
        return EDIT_IGNORED if e else ASK_IGNORED
    if e:
        mode = {"覆盖": "overwrite", "另存": "saveas"}.get(answer.get("choice"), "")
        if not late:
            return f"我选了「{answer.get('choice', '')}」。"
        return (f"【草稿纸·回答】你之前要改 {e.get('path')}，在平板上问我覆盖原文件还是另存一份。我现在选了「{answer.get('choice', '')}」。"
                f"接下来再调一次 mcp__inkpad__ink_edit（path={e.get('path')}，mode={mode}），按它返回的做。")
    if answer.get("image"):
        got = f"我在卡片上用笔手写了回答，图在 {answer['image']}：用 Read 看这张图，读出我写的。"
    else:
        got = f"我点了「{answer.get('choice', '')}」。"
    if not late:
        return got
    return (f"【草稿纸·回答】你之前在平板上用问话卡片问我：「{c.get('question', '')}」。我现在回答了：{got}\n"
            "请据此接着做之前停下的事。")

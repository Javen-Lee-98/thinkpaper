"""把平板上的一次「检查」写成对话里的一条消息。

书写过程的格式、给 Claude 的固定说明（protocol()）都在这里；想调整 Claude 读到的内容，改这个文件。
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


def build_timeline(groups, now_ms, include_process, star=None):
    """把笔迹分组写成文字。groups: [{id, t0, t1, n, erased, erasedAt, bbox, inSel, revisit}]。

    单页投递（不给 star）：整页都交上来了，每组都列，不标 ★。
    整本消息（star 说明 ★ 的含义）：inSel 的组标 ★；不带 ★ 的只列还没回答的红笔问题和最近写的几组。
    """
    if not groups:
        return "这一页还没有手写笔迹。"
    groups = sorted(groups, key=lambda g: g["t0"])
    page_t0 = groups[0]["t0"]
    prev_t1 = {g["id"]: (groups[i - 1]["t1"] if i else None) for i, g in enumerate(groups)}
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
        for g in groups:
            if g["id"] in shown_ids and g.get("n", 0) > g.get("erased", 0):
                lines.append(f"{mark(g)}{g['id']}｜{fmt_box(g['bbox'])}{red_label(g)}{fmt_reco(g)}")
        if star:
            lines.append(f"★ 表示{star}。")
        return "\n".join(lines)

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
    for g in groups:
        if g["id"] not in shown_ids:
            continue
        parts = [f"{fmt_clock(g['t0'] - page_t0)} 开始，写了 {fmt_span(g['t1'] - g['t0'])}"]
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
    return "\n".join(lines)


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


def fmt_reco(g):
    """电脑识别的旁证：Windows 手写识别（按笔画）和 PP-OCR（看字帖里这一块）；只有 Windows 的时候照旧只写读法。"""
    r, o = g.get("reco"), g.get("ocr")
    if not r and not o:
        return ""
    win = f"「{r[0]}」" + (f"（或：{' / '.join(r[1:])}）" if len(r) > 1 else "") if r else ""
    if not o:
        return f"｜电脑识别：{win}"
    return "｜电脑识别：" + "；".join(([f"Windows{win}"] if r else []) + [f"PP-OCR「{o}」"])


RECO_HINT = (
    "「电脑识别」是本机的手写识别：Windows 按笔画顺序认，PP-OCR 看字帖里那一块；都常把相邻的字拆错、认成形近字，公式基本认不了，"
    "只当旁证，以图为准，结合上下文判断。识别结果和你的读法一致时不要问；不一致、又关系到意思的地方，用 ink_confirm 问我。"
    "「你以前读错过的」是我在确认卡片上更正过的读法，「领域词表」是这本和项目里的常用术语，认字时参考。"
)


# 一条改动规则
EDIT_RULE = (
    "改东西只按这一条规则：① 解释、检查、提建议，直接做；"
    "② 我用红笔要你改写你的某条回答时，回一条新的 write（anchor 填那条红笔），旧的那条我自己擦；"
    "③ 改电脑上的原文件，要有明确的文件和范围——我已经明确说「直接改这些」就照改，不再逐条问；"
    "④ 你自己想多改的地方，用 suggest 一处一条提出来，等我采纳；"
    "⑤ 没确认的手写读法可以带着假设解释，不能据此改原文件，也不能代进计算。"
)

PAGE_FACTS = {
    "blank": "这一页是空白纸，上面是我写的内容。",
    "zotero": "这一页是 Zotero 文献的书页（只读资料）。",
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

# 交上来的一页怎么回（2026-11-10 定；2026-11-13 长回答改成圈号加卡片）：
# 红字必做；红字之外少而准、可以没有，点拨最多一条，都写依据；短的写在原处，长的平板标圈号、点开才看全文
TWO_LAYERS = (
    "两层：我写完一段点「检查」才交上来，不用赶快。"
    "① 红字是我明确要你办的，一条条办完：问的就答，要的就给，要生成或修改文件就照做（改已导入的文档照「改文件」那一条走）。"
    "② 红字之外，自己通读整页，只指出真正的错和漏，少而准，没有就一条都不写；其中最多一条点拨——我没想到的那个关键点，"
    "用 insert 放在它该在的位置（缺一支就用 box 指两支之间的空白），点到为止，不替我写；每条都写出依据：哪一步、哪篇文献、项目里哪个文件。"
    "③ 标记写在原处：短的回答（约 40 字以内）用 note 连到那条红字；长的用 write，anchor 填所答的那条红字（或它讲的那处笔迹），"
    "q 填问题原文——平板在那里标一个圈号，我点圈号才看到全文，不占纸面。不要自己用 number 标圈号去配页末的 write，anchor 也不要写 end。"
    "红字没要求的，不改电脑上的文件。"
)


def _third(s):
    """写给系统提示的说明用第三人称：「我」换成「用户」，引号「」里我举的原话不动。"""
    return "".join(part if part.startswith("「") else part.replace("我", "用户")
                   for part in re.split(r"(「[^」]*」)", s))


def protocol():
    """固定说明：插件放进系统提示（每个对话一次，走缓存），投递里只放这一页的内容。

    各段的句子是按「我」（用户）的口气写的，这里改成第三人称拼起来。"""
    rows = [
        "用户在平板的草稿纸上手写、画图、圈画，写完点「检查」交上来，代替在文本框里打字。这类消息以【草稿纸】开头，"
        "只带这一页的内容：图的路径、页面、原文、书写过程（笔迹分组 g1、g2…… 的先后、停顿、擦改）、这次的特别情况；"
        "固定的规则都在这里，消息里不再重复。",
        "看：先用 Read 看消息里列的图，再结合这次对话和项目文件理解用户写的东西。" + COLORS
        + "用户写的常是想法的雏形：帮它往前长一步，不要替用户把话说完。",
        "认字：" + RECO_HINT + CONFIRM_HINT,
        TWO_LAYERS,
        EDIT_RULE,
        "写回：草稿纸上来的就在草稿纸上答，用 mcp__inkpad__ink_reply，带上消息里给的 submission（整本消息另带 page）。"
        "写在纸上的话，语言跟我写的一致：我写英文就用英文回。"
        "长的回答用 write（可分段；anchor 填所答的那条红笔或它讲的那处笔迹，q 填问题原文；平板在那里标一个圈号，我点圈号才看到全文，不占纸面），"
        "指向具体笔迹的简短批注（约 40 字以内）用 note/question，标记用 underline/circle/arrow。"
        + WRITE_HINT + "对话里只用半句话说写了什么；代码、文件改动这类纸上放不下的照常在对话里做。",
        CARD_HINT,
        ASK_HINT,
        "画：" + SKETCH_HINT + FORMULA_HINT,
        "建议：" + SUGGEST_HINT,
        FILE_HINT,
        "概念图：" + MAP_HINT,
        "其他消息：【草稿纸·整本】是一本里写过字的每一页各一张图（★ 是你上次看过之后新写的），写回时 ink_reply 带上 submission 和 page；"
        "我说「好几页上写了」「整本看看」时，用 mcp__inkpad__ink_scan 自己去取（only_new 只取有新笔迹的页，region 放大某页的一段）。"
        "想让我在某张图、某页 PDF 或某个文件上圈画时用 mcp__inkpad__ink_show 推一页；整份文档（PDF/PPT/Word）用 mcp__inkpad__ink_import 导入；"
        "想看我此刻草稿纸上这一页用 mcp__inkpad__ink_snapshot。【草稿纸·撤回】是我在平板上撤回了你的一次修改，知道就行。",
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


ANSWER_HEAD = 200  # 之前写过的长回答：消息里只带前这么多字，让 Claude 知道自己答过什么


def _head(text, n=ANSWER_HEAD):
    text = " ".join(str(text).split())
    return f"{text[:n]}{'…' if len(text) > n else ''}"


def fmt_prev(note):
    """「你之前在这一页写过的批注」里的一条：短批注是原话；长回答（平板上的圈号）写成「圈号 n（问：q）：前 200 个字…」，
    卡片下面接着回过的各段（回应卡片上的红字）另起一行接在后面：「  - 接着（回应红字「…」）：前 200 个字…」。"""
    if isinstance(note, str):
        return note.strip()
    if not isinstance(note, dict) or not str(note.get("text") or "").strip():
        return ""
    head = f"圈号 {note['n']}" if note.get("n") else "长回答"
    q = f"（问：{note['q']}）" if note.get("q") else ""
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
    """卡片上的红字（2026-11-14）：用户在长回答的卡片上用红笔写了批注，附了卡片的图。cards：[{n, img}]；page：整本消息里的页码。"""
    out = []
    for c in cards or []:
        if not isinstance(c, dict) or not c.get("img"):
            continue
        n = c.get("n") or ""
        out.append(f"圈号 {n} 的卡片上我用红笔写了批注，见图 {c['img']}：蓝字是你之前的回答，红字是我写的。"
                   f"回应用 ink_reply 的 write，card 填 {n}{'（再带上 page=' + str(page) + '）' if page else ''}，"
                   "q 填你读到的那句红字，text 写回应；回应接在那张卡片下面。")
    return out


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
    # 点「检查」交的是整页；快照的图是平板按笔迹的外框截的，页面上有笔迹时不是整页，照实说
    if snapshot and any(g.get("n", 0) > g.get("erased", 0) for g in groups):
        imgs = [f"- 这一页有笔迹的那一块：{paths['crop']}（快照只截到笔迹的外框，框外的内容不在图里；{notes}）"]
    else:
        imgs = [f"- 这一页：{paths['crop']}（{notes}）"]
    if paths.get("sheet"):
        imgs.append(f"- 字帖：{paths['sheet']}（每组笔迹裁出来、统一字高，左边是编号；认字时看这张）")
    cards = [c for c in meta.get("cards") or [] if isinstance(c, dict) and c.get("img")]
    for c in cards:  # 长回答卡片上我写了红字：每张卡片一张图
        imgs.append(f"- 圈号 {c.get('n') or ''} 的卡片：{c['img']}（蓝字是你之前的回答，红字是我在卡片上写的）")
    lines = head + [f"先用 Read 看这{count_zh(len(imgs))}张图：\n" + "\n".join(imgs)]
    lines.append(f"页面：{page_label}。")
    lines += text_block(book_text, src)
    lines.append(build_timeline(groups, meta.get("now") or 0, include_process))
    lines += memory_lines(meta)
    prev = [t for t in (fmt_prev(x) for x in meta.get("prev_notes") or []) if t][-12:]
    if prev:
        lines.append("你之前在这一页写过的批注：\n" + "\n".join(f"- {t}" for t in prev))
    if cards:
        lines.append("卡片上的红字：\n" + "\n".join(f"- {t}" for t in card_lines(cards)))
    vs = [v for v in meta.get("verdicts") or [] if isinstance(v, dict) and v.get("id")][:20]
    if vs:  # 我对你提的修改建议逐条点了 ✓/×
        lines.append(verdict_block(vs))
    # 别的旧批注不请 Claude 整理：采纳、擦掉都由我在平板上用笔定
    lines.append(f'写回用 mcp__inkpad__ink_reply（submission="{sub_id}"）。')
    return "\n\n".join(lines)


WRITE_HINT = (
    "标记用来代替大段的话，不是越多越好，只标要紧的：对我写的东西（或书页上的字），直接标在上面——对的 tick（我问对不对、或关键的一步才打），错的 cross（text 写一句为什么），"
    "该删的 strike（text 可写改成什么），该补的 insert（text 写补的字），存疑的 wavy（text 可写一句疑问），关键的 highlight，"
    "几行要合并或归纳的 brace（text 写一句），给步骤排顺序的 number（text 写 1、2、3）；下划线、圈、箭头照旧。"
    "cross、wavy、strike 必须写一句 text（为什么错、疑在哪、改成什么）。只有非得用话说的才写一段 write。"
    "一组笔迹分了几行时（书写过程里写着「分 N 行」，常见于列表：下一行的编号和上一行连着写成一组），"
    "只指其中一行就把 anchor 写成 g3:1（第 1 行，从上往下数），否则标记会落在整组中间、看着像指别的行。"
    "红笔是问句时，短的回答（约 40 字以内）用 note，anchor 填那个红笔问题的编号；长的用 write，anchor 也填那个红笔问题的编号，"
    "q 填问题原文，平板在那里标一个圈号，我点开才看全文。"
    "红笔是指令（标出、圈出、排序、整理……）时，可以只用标记回应，再用 tick 标在那条红笔上（anchor 填它的编号），表示处理过了。"
)

# 卡片上的红字（2026-11-14）：用户在长回答的卡片上用红笔批注、追问，Claude 的回应接在同一张卡片下面
CARD_HINT = (
    "卡片上的红字：我也会在长回答的卡片上用红笔批注、追问；交上来时消息里附那张卡片的图（蓝字是你之前的回答，红字是我写的）。"
    "回应用 write，card 填那张卡片的圈号，q 填你读到的那句红字，text 写回应：它接在那张卡片最下面，不出新的圈号；"
    "要改写整段，也把改好的写在下面。"
)

# 问话卡片（2026-11-14，阶段 C）：只有这两种情况才发卡片到平板；没答就停手等着
ASK_HINT = (
    "问话卡片：能写在纸上的都写在纸上；只有要我回答才能继续的问题（question，加 0–4 个短选项）和纸上放不下的结果（result），"
    "才用 mcp__inkpad__ink_ask 发一张卡片到平板。工具说我还没答时，这一轮就停在这里等着，不替我选；我答了会作为一条新消息送来。"
    "我也可能点「忽略」不答：忽略了的问题不要再问。"
)

# 用户在平板上点了问题卡片的「忽略」（2026-11-14 用户在 iPad 上试过后定）：工具还在等时这样告诉 Claude；已经不等了的不送消息
ASK_IGNORED = ("用户忽略了这个问题，没有回答。不要再问同一个问题；按最稳妥的做法继续，或者停下来在对话里说明，"
               "不要替用户做有风险的选择。")

SUGGEST_HINT = (
    "suggest 只用在改文档、改你自己的回答、概念图上（按改动规则第④条）：一处一条，anchor 或 box 指着要改的那块，"
    "text 写改成什么（如「改为：……」「删去这句」）。我自己写的字有错，用批改符号（strike 写改成什么、insert、cross 写理由），不用 suggest。"
    "我在平板上点建议框旁的 ✓ / ×（或用笔在框里打勾、横划）＝采纳 / 不采纳，决定随我下一次交上来的消息带给你；"
    "采纳的改完后，用 ink_reply 的 result 逐条回报（anchor 填 s 编号，ok 填 true / false，没改成时 text 写一句原因）。"
)

# 改电脑上的文件（2026-11-14，阶段 C；《产品定义》第 4 节）：动手前在平板上问覆盖还是另存、先留底，平板上能撤回。
# 以前「新文件放进项目，不覆盖原文件」和「改原文件再原地更新」两种说法互相矛盾，删了，换成这一条（插件里 ink_edit、ink_import、
# ink_reply 的说明和这里一致）
FILE_HINT = (
    "改文件：要改一份已导入草稿纸的文档（我交上来的书页对应的原文件，或我在对话里点名的），动手前先调 mcp__inkpad__ink_edit"
    "（path 填原文件）：它在平板顶上问我覆盖原文件还是另存一份，并在动手前把原文件留底，我在平板上能撤回。"
    "它说我还没选，就停手等着，不替我选；我选了会作为一条新消息送来；我点了「忽略」，这次就不改这个文件。"
    "按它返回的路径改：覆盖就改原文件本身；另存就改它新建的那份，原文件不动。"
    "改完用 mcp__inkpad__ink_import 导入改好的那个文件，平板上那本原地换成新版；采纳的修改建议再用 ink_reply 的 result 逐条回报改成了没有。"
    "我在对话里打字让你改已导入的文档也一样先调 ink_edit：我已经说了覆盖还是另存，就带上 mode（overwrite 覆盖 / saveas 另存），"
    "不弹卡片；没说的在对话里问我。一次 ink_edit 只办一个文件：这一轮要改同一个文件的几处合起来只调一次，要改两个文件就调两次；"
    "下一轮再改，再调。"
)

# ink_edit 的几种返回（服务给，插件原样交给 Claude）
EDIT_PENDING = ("用户还没选（卡片留在平板顶上）。这一轮就停在这里等着：不要替用户选，也不要先动这个文件；"
                "用户选了，会作为一条新消息（【草稿纸·回答】）送来，到时按消息里说的带上 mode 再调一次 ink_edit。")
EDIT_WITHDRAWN = "这张卡片已经撤下了：这个文件刚才已经带着 mode 调过 ink_edit、办好了，照那一次的返回做。"
EDIT_IGNORED = ("用户忽略了，这次不要改这个文件（没有留底，也没有建新文件，原文件没动）。不要再问同一个问题；"
                "需要的话在对话里说明这次没改。")
IMPORT_REMIND = ("提醒：这个文件在上次导入之后改过，留底里却没有那之后的记录。如果是你改的，说明改之前没先调 mcp__inkpad__ink_edit，"
                 "用户在平板上撤不回这次修改；下次改已导入的文档，动手前先调它。是用户自己改的就不用管。")


def edit_offline(name):
    """ink_edit 没带 mode、平板又没打开草稿纸：改在对话里问。"""
    return (f"平板现在没打开草稿纸，没法弹卡片：在对话里问用户，改《{name}》是覆盖原文件还是另存一份，"
            "再带上 mode（overwrite 覆盖 / saveas 另存）调一次 ink_edit。原文件还没动。")


def edit_go(mode, original, target, title):
    """ink_edit 办好之后给 Claude 的话：该改哪个文件，改完怎么做。title：平板上对应的本子名（没导入过是 None）。"""
    if mode == "overwrite":
        head = f"可以改了：改 {original} 本身（覆盖原文件；改之前的样子已经留底，用户在平板上能撤回）。"
    else:
        head = f"已经另存了一份：{target}（和原文件一模一样）。改这个新文件，原文件 {original} 不要动。"
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


MAP_HINT = (
    "我画概念图（框、圈着的词用箭头连起来）时，在图上互动：给我的箭头补关系词用 label（anchor 填那条箭头，text 两三个字）；"
    "建议加一个概念用 node（text 是概念，anchor 填放在哪个旁边，links 列出要和它连的组）；建议加一条线用 link（from、to 填组号，text 是关系词）；"
    "建议把几个归成一类用 group（anchors 列出那几组，text 是类名）；label、node、link、group 都是建议，画成虚线，我采纳了才变实线。"
    "连错的用 cross 标在那条线上，有疑问用 question，中心概念用 circle。"
)

SKETCH_HINT = (
    "讲不清的画出来，放在 anchor 那块下面（anchor 写 end 或不写就接在页面最后），text 可写一句图注。"
    "方框图、流程、因果关系用 sketch，只给结构：nodes（节点的字，要短）、edges（from、to，text 写关系词，dash 为 true 画虚线）、"
    "groups（nodes 列出组里的节点，text 是组名），不写坐标，草稿纸排成手绘风格。"
    "数据图、函数曲线这类要准确的，在电脑上用 matplotlib 等画成 PNG 或 SVG，用 figure 放上来（path 填文件路径）。"
)

FORMULA_HINT = (
    "公式用 formula（tex 写 LaTeX，不带 $，放法和 sketch 一样），平板上排成数学公式；整段回答里单独一行写成 $$…$$ 的，也排成公式。"
)

CONFIRM_HINT = (
    "有读不准的字迹（字、符号、下标、数字）时不要猜：先用 mcp__inkpad__ink_confirm 在平板上问我"
    "（anchor 填笔迹编号，guess 填你的读法，options 给几个候选），拿到回答再往下写。"
)


def build_scan_message(title, infos, sub_id, origin="claude", only_new=False, skipped_old=0, truncated=0):
    """整本检测：一本里写过字的每一页各一张图，附各页的书写过程（固定说明在对话的系统提示里，这里不附）。

    infos: [{no, image, label, scale, h, groups, now, first, clip, pdf?}]，groups 里 inSel 表示上次之后新写的。
    """
    if origin == "tablet":
        head = f"【草稿纸·整本】我把《{title}》里写过字的页一起发给你（共 {len(infos)} 页）。"
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
            img += f"（这一页很长，图缩小到 {p['scale']:.2f} 倍；看不清时用 ink_scan 的 region=[y0,y1] 放大某一段，页面坐标 = 图里像素 ÷ {p['scale']:.2f}）"
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
        if p.get("cards"):  # 长回答卡片上我写了红字：每张卡片另一张图
            bits.append("卡片上的红字：\n" + "\n".join(f"- {t}" for t in card_lines(p["cards"], p["no"])))
        if p.get("verdicts"):
            bits.append(verdict_block(p["verdicts"]))
        lines.append("\n".join(bits))
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
        lines.append("请据此继续，需要时更正你已经写回草稿纸的内容（ink_reply）。")
    else:
        lines.append("（不必再把这些读法用 read 写回草稿纸，直接用于理解。）")
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

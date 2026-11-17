"""守着给 Claude 的规则文字：prompt.py 的固定说明（protocol()）、每次发给 Claude 的消息和工具返回，
插件 inkpad 里的工具说明、命令说明和插件自己的 README。

三样检查：
- 已经删掉或改掉的说法不再出现（GONE；出现就报在哪一处、前后是什么字）；
- 现在的几条要点都在固定说明里（AI 按钮、读法、两条蓝字的写法、改文件先调 ink_edit……）；
- 固定说明和工具说明讲同一件事时说法一致。

词表只收「出现就一定是旧说法」的写法，免得误伤正常的话：交稿的按钮改叫「AI」以后，「检查」作动词
（「解释、检查、提建议」）照常能用，只有写成按钮的样子（「检查」、点检查、检查按钮）才算旧说法；
「上下文」照常能用（「结合上下文判断」），只有「上下文太长」「上下文大小」那个已删的提示才算。
改规则时每次都跑这个测试；要加新的作废说法，加进 GONE，写上为什么。
"""

import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import prompt  # noqa: E402

PLUGIN = HERE.parents[1] / "inkpad-plugin" / "inkpad"
REGISTER = PLUGIN / "hooks" / "register.tsx"

# （写法，为什么不该再有）。写法是正则；《产品定义》指 inkthink/docs/PRODUCT.md
GONE = [
    (r"「检查」|点\s*检查|检查按钮", "交稿的按钮 2026-11-14 改叫「AI」（《产品定义》第 2 节）"),
    (r"页边", "空白本子没有页边那一栏了：短批注由草稿纸在所指笔迹旁找空白，挡路时收成小蓝点（第 3 节）"),
    (r"批注栏|右侧栏|右侧一栏", "同上：规则里只说「短批注」，书页上的说「右边一栏」"),
    (r"显示在顶部|顶上那一条读法", "读法以前显示在顶上，现在写在那几笔下面（第 3 节「Claude 读到了什么」）"),
    (r"页末|整段回答|顶栏的回答|回答 ?N\b|下方弹窗|回答弹窗", "长回答永远不上纸：平板标圈号、点开是卡片（第 10 节）"),
    (r"回答栏|本页回答", "第 6 节删掉的"),
    (r"帮助力度", "第 6、10 节删掉的说法"),
    (r"按做法|定做法|选做法|做法文件|六个做法|写在什么上面|按字写在", "「按字写在什么上面定做法」整段删了，只有一条规则（第 3、10 节）"),
    (r"快看|细想|档位|快通道", "第 6 节删掉的"),
    (r"框选|圈选|只交圈里", "第 6 节删掉的：红笔画的圈就是一笔红字"),
    (r"补一句|批量回应|发送决定|浮动工具条|钉住抽屉|对话回复面板", "第 6 节删掉的"),
    (r"上下文太长|上下文大小|回得会慢", "第 2、6 节：那条提示和报数一起删了"),
    (r"新文件放进项目|不覆盖原文件|改过后再导入|导入同一个文件，平板上原地更新", "第 10 节：两种互相矛盾的写法，现在是第 4 节"),
    (r"整本发给 ?Claude|只发这本里有新笔迹|附上书写过程", "第 6 节：菜单里这几项删了，点「AI」自动把有新字的页一起交，书写过程每次都附"),
    (r"100 ?秒", "确认字迹实际等约 45 秒（插件 waitConfirm：25 + 20）"),
    (r"改你自己的回答", "suggest 只在书页的印刷内容上有 ✓ ×；改写回答是接在卡片下面"),
    (r"新版换旧版|旧版收起|revises|像脚注", "长回答不再改写成新版，回应接在卡片下面（第 3 节）"),
    (r"你写我审|审阅者", "按底子分角色的那一段删了"),
    (r"ink_relocate", "删掉的工具"),
    (r"不带(?: ?text ?)?的(?:草稿纸)?不画", "2026-11-16 起 cross、wavy、strike 不带 text 的由服务退回，工具结果里写明第几条缺什么（规则瘦身 B 组③）"),
    (r"每条不超过 40 字|note 短批注（不超过 40 字", "2026-11-16 起短批注写长了服务收成圈号卡片（NOTE_MAX），说成「约 40 字以内」（规则瘦身 B 组①）"),
]

# 2026-11-16 规则瘦身：从固定说明里删掉、挪走的话（固定说明里不再有），和它现在在哪（那里一定有）。
# 每条：（固定说明里不该再有的写法，现在在哪：名字，那里一定有的话）。名字是 tool:工具名（插件里那个工具的说明）、
# tsx（插件源码里的字符串）或 msg:…（拼出来的消息，见 moved_homes）
MOVED = [
    ("先看右边再看下面", "tool:ink_reply", "空白本子里先看右边再看下面，书页、推送页上在下面"),
    ("不出新的圈号", "tool:ink_reply", "这段接在那张卡片最下面，不出新的圈号"),
    ("要改写整段", "msg:card", "要改写整段，也写在下面"),
    ("回应的办法一样", "tool:ink_reply", "那条短批注交上来时已收成圈号、变成这样一张卡片，回应的办法一样"),
    ("0–4 个短选项", "tool:ink_ask", "可带 0–4 个短选项"),
    ("忽略了的问题不要再问", "tool:ink_ask", "忽略了的问题不要再问"),
    ("不替用户选", "tool:ink_ask", "不要替用户选"),
    ("nodes、edges、groups", "tool:ink_reply", "只给结构（nodes 节点、edges 连线、groups 分组），不写坐标"),
    ("matplotlib", "tool:ink_reply", "matplotlib 等画成 PNG 或 SVG"),
    ("$$…$$", "tool:ink_reply", "单独一行写成 $$…$$ 的排成公式"),
    ("tex 写 LaTeX", "tool:ink_reply", "tex 写 LaTeX，不带 $"),
    ("label、node、link、group 都是建议", "tool:ink_reply", "上的四种都是建议，画成虚线"),
    ("连错的用 cross", "tool:ink_reply", "概念图里连错的线用 cross 标在那条线上，有疑问用 question，中心概念用 circle"),
    ("给步骤排顺序的 number", "tool:ink_reply", "number 圈着的编号，给步骤排顺序"),
    ("问对不对", "tool:ink_reply", "tick 对 ✓（用户问对不对、或关键的一步才打）"),
    ("几行要合并或归纳", "tool:ink_reply", "brace 大括号把几行括起来，要合并或归纳时用"),
    ("insert 写补的字", "tool:ink_reply", "insert 插入符 ^，该补的（text 写补的字）"),
    ("带上消息里给的 submission", "msg:single", 'mcp__inkpad__ink_reply（submission="S1"）'),
    ("带上 submission 和 page", "msg:scan", 'mcp__inkpad__ink_reply（submission="S9"，page=页码）'),
    ("only_new", "tool:ink_scan", "只要上次看过之后有新笔迹的页"),
    ("好几页上写了", "tool:ink_scan", "「我在好几页上写了」「看看整本」"),
    ("推一页；整份文档", "tool:ink_show", "整份文档要让用户翻着写，用 ink_import"),
    ("知道就行", "msg:undo", "这条只是告诉你，不用回复，也不用动手"),
    ("覆盖原文件还是另存一份", "tool:ink_edit", "覆盖原文件，还是另存一份？"),
    ("一次 ink_edit 只办一个文件", "tool:ink_edit", "一次只办一个文件，这一轮要改同一个文件的几处合起来只调一次"),
    ("按它返回的路径改", "tool:ink_edit", "按返回的路径改完：用 ink_import 导入改好的那个文件"),
    ("就带上 mode", "tool:ink_edit", "用户已经说了覆盖还是另存，就带上 mode"),
    ("submissions 的上一层", "tool:ink_edit", "留底在草稿纸数据文件夹（消息里图片所在 submissions 的上一层）的 keep 里"),
    ("再拿留底的内容覆盖", "tool:ink_edit", "拿回来要盖掉现在这份时，也算改文件，照样先调它，再拿留底的内容覆盖"),
    ("result 逐条回报", "msg:verdicts", "采纳的改完后，用 ink_reply 的 result 逐条告诉我结果"),
    ("约 40 字以内", "tool:ink_reply", "短批注（约 40 字以内；写长了草稿纸会把它收成圈号卡片"),
    ("圈号是平板自己标的", "tool:ink_reply", "圈号是平板自己标的，不用另画 number 去配，write 的 anchor 也不要写 end"),
    ("「Claude 读到了什么」", "tool:ink_reply", "用户打开「Claude 读到了什么」时，读法以灰色小字显示在那几笔下面"),
    ("g3:1", "msg:rows", "anchor 写 g2:1（第 1 行"),
    ("只按中文认", "msg:zh-only", "「只按中文认」表示本机没有英文识别器，英文会被认成形近的汉字。"),
    ("约 45 秒", "tsx", "等了约 45 秒，用户暂时没有回答"),
    ("标明哪处是推测的", "tsx", "先按你的理解继续，并在回复里标明哪处是推测的"),
]

# 固定说明的总字数上限（2026-11-16 规则瘦身后约 2800 字，原来 4562）：留约 200 字余量，防止以后又一句句长回去；
# 要加规则时先看能不能放进工具说明或只在用到时随消息带上，真要加再调这个数
PROTOCOL_MAX = 3000

CJK = re.compile(r"[\u4e00-\u9fff]")


# -- 插件源码里的字符串（只看字符串，不看注释：注释里讲来历的「以前是怎样」可以留）

REGEX_BEFORE = set("(,=:[!&|?{};+-*%~^")


def ts_strings(src):
    """TypeScript 源码里的字符串字面量：[(起点偏移, 行号, 内容)]。认得注释、正则字面量和模板字符串（${…} 里的代码照样往下找）。
    只为这个测试够用：不处理 JSX 里不带引号的文字（那是界面上的字，不是给 Claude 的）。"""
    out, n = [], len(src)

    def line_of(k):
        return src.count("\n", 0, k) + 1

    def prev_sig(k):
        k -= 1
        while k >= 0 and src[k] in " \t\r\n":
            k -= 1
        return src[k] if k >= 0 else ""

    def read_template(k):
        """从反引号后面读到收尾的反引号；${…} 里的代码递归找字符串。返回（结束位置, 模板里的字）。"""
        buf = []
        while k < n:
            c = src[k]
            if c == "\\":
                buf.append(src[k:k + 2])
                k += 2
                continue
            if c == "`":
                return k + 1, "".join(buf)
            if c == "$" and src[k + 1:k + 2] == "{":
                k = read_code(k + 2, stop="}")
                buf.append("…")
                continue
            buf.append(c)
            k += 1
        return k, "".join(buf)

    def read_code(k, stop=None):
        nest = 0
        while k < n:
            c = src[k]
            if stop and c == "{":
                nest += 1
            elif stop and c == "}":
                if nest == 0:
                    return k + 1
                nest -= 1
            if c == "/" and src[k + 1:k + 2] == "/":
                k = src.find("\n", k)
                k = n if k < 0 else k
                continue
            if c == "/" and src[k + 1:k + 2] == "*":
                e = src.find("*/", k + 2)
                k = n if e < 0 else e + 2
                continue
            if c == "/" and (prev_sig(k) in REGEX_BEFORE or prev_sig(k) == "" or src[max(0, k - 6):k].rstrip().endswith("return")):
                k += 1
                cls = False
                while k < n and src[k] != "\n":
                    if src[k] == "\\":
                        k += 2
                        continue
                    if src[k] == "[":
                        cls = True
                    elif src[k] == "]":
                        cls = False
                    elif src[k] == "/" and not cls:
                        break
                    k += 1
                k += 1
                continue
            if c in "'\"":
                start, k, buf = k, k + 1, []
                while k < n and src[k] != c:
                    if src[k] == "\\":
                        buf.append(src[k:k + 2])
                        k += 2
                        continue
                    buf.append(src[k])
                    k += 1
                out.append((start, line_of(start), "".join(buf)))
                k += 1
                continue
            if c == "`":
                start = k
                k, text = read_template(k + 1)
                out.append((start, line_of(start), text))
                continue
            k += 1
        return k

    read_code(0)
    return out


def plugin_texts():
    """插件里给 Claude（和给装插件的人）看的字：register.tsx 里带汉字的字符串、README、plugin.json。{名字: 字}"""
    texts = {}
    if REGISTER.is_file():
        for _, line, s in ts_strings(REGISTER.read_text("utf-8")):
            if CJK.search(s):
                texts[f"register.tsx 第 {line} 行"] = texts.get(f"register.tsx 第 {line} 行", "") + s
    for f in (PLUGIN / "README.md", PLUGIN / ".claude-plugin" / "plugin.json"):
        if f.is_file():
            for k, line in enumerate(f.read_text("utf-8").splitlines(), 1):
                if line.strip():
                    texts[f"{f.name} 第 {k} 行"] = line
    return texts


def tool_desc(name):
    """register.tsx 里某个工具的说明（description 和各参数的说明连起来）：从 name: 'ink_x' 到下一个工具之前。"""
    src = REGISTER.read_text("utf-8")
    a = src.index(f"name: '{name}'")
    b = src.find("$.tool.register(", a)
    b = src.find("$.command.register(", a) if b < 0 else b
    return "".join(s for off, _, s in ts_strings(src) if a <= off < b)


# -- prompt.py 这边：固定说明、各常量、用合成的输入拼出来的消息和工具返回

GROUPS = [
    {"id": "g1", "t0": 0, "t1": 3000, "n": 4, "bbox": [100, 100, 300, 140], "red": True, "inSel": True},
    {"id": "g2", "t0": 5000, "t1": 9000, "tw": 8000, "n": 6, "erased": 1, "erasedAt": 12000, "bbox": [100, 160, 420, 200],
     "reco": ["买两斤苹果", "买两斤草果"], "ocr": "买两斤苹果", "reco_lang": "zh", "lines": 2, "inSel": True},
    {"id": "g3", "t0": 20000, "t1": 22000, "n": 2, "erased": 2, "erasedAt": 25000, "bbox": [500, 100, 560, 130]},
    {"id": "g4", "t0": 30000, "t1": 31000, "n": 3, "bbox": [100, 220, 200, 250], "red": True, "answered": True, "on": "doc",
     "revisit": True, "late": 1, "lateAt": 40000},
    {"id": "g5", "t0": 50000, "t1": 52000, "n": 5, "bbox": [100, 260, 380, 300], "reco": ["coffee"], "reco_lang": "en-only"},
]
VERDICTS = [
    {"id": "s1", "ref": "x1", "kind": "suggest", "text": "改为：九点出发", "verdict": "yes", "on": "doc"},
    {"id": "s2", "ref": "x2", "kind": "suggest", "text": "删去这句", "verdict": "no", "on": "mine", "near": "g5"},
    {"id": "s3", "ref": "x3", "kind": "node", "text": "雨具", "verdict": "yes"},
    {"id": "s4", "ref": "x4", "kind": "label", "text": "需要", "verdict": "no"},
]
PREV = ["记得带伞", {"n": 1, "q": "周六几点出发？", "text": "八点出门，九点前能到。", "more": [{"q": "太早了", "text": "那就九点出门。"}]},
        {"n": 2, "note": True, "text": "车票要提前买"}]
CARDS = [{"n": 1, "img": "E:\\d\\card-1.png"}, {"n": 2, "img": "E:\\d\\card-2.png", "note": True}]
PATHS = {"crop": "E:\\d\\crop.jpg", "sheet": "E:\\d\\sheet.png"}
OWED = [{"sub": "20261116-101010-abcd", "page": None, "ids": ["s1"]}, {"sub": "20261116-111111-beef", "page": 2, "ids": ["s1", "s3"]}]


def meta(**kw):
    m = {"now": 200_000, "include_process": True, "groups": [dict(g) for g in GROUPS]}
    m.update(kw)
    return m


def prompt_texts():
    """prompt.py 里所有给 Claude 的字：{名字: 字}。"""
    texts = {"protocol()": prompt.protocol()}
    for name, v in vars(prompt).items():  # 各 *_HINT、EDIT_*、COLORS、EDIT_RULE、TWO_LAYERS、VOICE_HINT、ASK_IGNORED、PAGE_FACTS……
        if name.startswith("_"):
            continue
        if isinstance(v, str) and CJK.search(v):
            texts[f"prompt.{name}"] = v
        elif isinstance(v, dict):
            for k, s in v.items():
                if isinstance(s, str) and CJK.search(s):
                    texts[f"prompt.{name}[{k!r}]"] = s
    for role in ({"page": "blank"}, {"page": "zotero"}, {"page": "pdf"}, {"page": "board"},
                 {"page": "editable", "src": "E:\\docs\\周末安排.docx"}):
        texts[f"build_message(role={role['page']})"] = prompt.build_message(
            meta(role=role, prev_notes=PREV, dots=1, cards=CARDS, verdicts=VERDICTS, owed=OWED,
                 corrections=[{"guess": "草果", "text": "苹果"}], vocab=["超市", "车票"]),
            PATHS, "草稿本第 1 页（空白草稿纸）", "周六去超市，买两斤苹果。" * 3, "S1", src=("E:\\d\\book.pdf", 3))
    texts["build_message(snapshot)"] = prompt.build_message(meta(), PATHS, "草稿本第 2 页", "", "S2", snapshot=True)
    texts["build_message(没有书写过程)"] = prompt.build_message(meta(include_process=False), PATHS, "x", "", "S3")
    zh_only = [dict(g, reco_lang="zh-only") if g["id"] == "g2" else g for g in GROUPS]
    texts["build_message(只按中文认)"] = prompt.build_message(meta(groups=zh_only), PATHS, "x", "", "S4")
    texts["build_message(只按中文认，没有书写过程)"] = prompt.build_message(meta(groups=zh_only, include_process=False), PATHS, "x", "", "S5")
    scan_groups = [dict(g, inSel=g["id"] in ("g1", "g2")) for g in GROUPS]
    infos = [
        {"no": 1, "image": "E:\\d\\p001.png", "label": "草稿本第 1 页", "scale": 0.5, "h": 3000, "groups": scan_groups, "now": 200_000,
         "first": True, "role": {"page": "blank"}},
        {"no": 2, "image": "E:\\d\\p002.png", "label": "《周末安排》第 2 页", "scale": 1.0, "h": 1414, "groups": scan_groups, "now": 200_000,
         "clip": [0, 500, 1000, 700], "pdf": "E:\\d\\book.pdf", "pdf_page": 2, "unplaced": 2, "role": {"page": "pdf"},
         "answers": PREV[1:], "dots": ["记得带伞"], "cards": CARDS, "verdicts": VERDICTS},
        {"no": 3, "image": "E:\\d\\p003.png", "label": "草稿本第 3 页", "scale": 1.0, "h": 1414, "groups": [dict(g, inSel=False) for g in GROUPS],
         "now": 200_000},
    ]
    for origin, only_new in (("claude", False), ("claude", True), ("tablet", True), ("tablet", False)):
        texts[f"build_scan_message({origin}, only_new={only_new})"] = prompt.build_scan_message(
            "草稿本", infos, "S9", origin=origin, only_new=only_new, skipped_old=1, truncated=2, owed=OWED if origin == "tablet" else None)
    texts["build_scan_message(空)"] = prompt.build_scan_message("草稿本", [], "S9", skipped_old=3)
    c = {"where": "草稿本第 1 页", "questions": [{"anchor": "g2", "question": "这几个字？", "guess": "买两斤苹果"},
                                                {"anchor": None, "question": "这里写的是？", "guess": ""},
                                                {"anchor": "g5", "question": "这是什么？", "guess": "coffee"}]}
    answers = [{"text": "买两斤苹果"}, {"skip": True}, {"text": "toffee"}]
    for late in (False, True):
        texts[f"build_confirm_answer(late={late})"] = prompt.build_confirm_answer(c, answers, late=late)
        for ans in ({"choice": "东门"}, {"image": "E:\\d\\answer.png"}, {"ignored": True}):
            texts[f"build_ask_answer({list(ans)[0]}, late={late})"] = prompt.build_ask_answer({"question": "周六去哪家超市？"}, ans, late=late)
        for ans in ({"choice": "覆盖"}, {"choice": "另存"}, {"ignored": True}):
            texts[f"build_ask_answer(edit {list(ans.values())[0]}, late={late})"] = prompt.build_ask_answer(
                {"question": "改《清单.docx》：覆盖原文件，还是另存一份？", "edit": {"path": "E:\\d\\清单.docx"}}, ans, late=late)
    for u in ({"action": "switched", "path": "E:\\d\\清单.docx", "saved_as": "E:\\d\\清单 (改1).docx"},
              {"action": "restored", "mode": "savepdf", "path": "E:\\d\\book.pdf", "t": "2026-11-14T10:00:00"},
              {"action": "restored", "mode": "overwrite", "path": "E:\\d\\清单.docx", "t": "2026-11-14T10:00:00",
               "aside": "E:\\data\\keep\\x\\aside\\1.docx", "warning": "平板上那本没换成"}):
        texts[f"build_undo_message({u.get('mode') or u['action']})"] = prompt.build_undo_message(u)
    for mode in ("overwrite", "saveas"):
        for title in (None, "清单"):
            texts[f"edit_go({mode}, {title})"] = prompt.edit_go(mode, "E:\\d\\清单.docx", "E:\\d\\清单 (改1).docx", title)
        texts[f"edit_go({mode}, 只在本地)"] = prompt.edit_go(mode, "E:\\d\\清单.docx", "E:\\d\\清单 (改1).docx", None, local=True)
    texts["edit_offline()"] = prompt.edit_offline("清单.docx")
    texts["verdict_block()"] = prompt.verdict_block(VERDICTS)
    return texts


def moved_homes():
    """MOVED 里各条现在的去处：{名字: 字}。"""
    homes = {f"tool:{n}": tool_desc(n) for n in ("ink_reply", "ink_show", "ink_snapshot", "ink_import", "ink_scan", "ink_confirm",
                                                    "ink_ask", "ink_edit")}
    homes["tsx"] = "\n".join(s for _, _, s in ts_strings(REGISTER.read_text("utf-8")))
    homes["msg:card"] = "\n".join(prompt.card_lines(CARDS))
    homes["msg:single"] = prompt.build_message(meta(), PATHS, "草稿本第 1 页", "", "S1")
    info = {"no": 1, "image": "p.png", "label": "草稿本第 1 页", "scale": 1, "h": 1414, "groups": [], "now": 0, "first": True}
    homes["msg:scan"] = prompt.build_scan_message("草稿本", [info], "S9")
    homes["msg:undo"] = prompt.build_undo_message({"action": "restored", "mode": "overwrite", "path": "E:\\d\\清单.docx"})
    homes["msg:verdicts"] = prompt.verdict_block(VERDICTS)
    homes["msg:rows"] = homes["msg:single"]  # GROUPS 里 g2 分了 2 行
    homes["msg:zh-only"] = prompt.build_message(meta(groups=[dict(g, reco_lang="zh-only") for g in GROUPS]), PATHS, "x", "", "S1")
    return homes


def hits(texts):
    """GONE 在这些字里出现的每一处：「哪一处：写法（为什么）……前后的字……」"""
    out = []
    for where, text in texts.items():
        for pat, why in GONE:
            for m in re.finditer(pat, text):
                a, b = max(0, m.start() - 18), min(len(text), m.end() + 18)
                out.append(f"{where}：「{m.group(0)}」（{why}）……{text[a:b]}……")
    return out


class GoneWordsTest(unittest.TestCase):
    def test_prompt_has_no_old_sayings(self):
        found = hits(prompt_texts())
        self.assertEqual(found, [], "\n".join(found))

    def test_plugin_has_no_old_sayings(self):
        self.assertTrue(REGISTER.is_file(), REGISTER)
        found = hits(plugin_texts())
        self.assertEqual(found, [], "\n".join(found))

    def test_word_list_does_not_hit_normal_words(self):
        """词表不误伤：「检查」作动词、「上下文」「做法」的平常用法照常能写。"""
        for ok in ("解释、检查、提建议，直接做", "检查 inkpad 插件的 server_command 设置", "结合上下文判断", "按最稳妥的做法继续",
                   "书页和推送页上排在右边一栏", "接在页面内容后面", "回答红字", "点「AI」", "批改符号旁边的一句话（不超过 40 字）",
                   "不带 text 的那一条会被退回、不画"):
            self.assertEqual(hits({"例句": ok}), [], ok)
        for bad in ("写完点「检查」交上来", "note：页边的短批注", "整段回答写在页末", "按做法和帮助力度来回", "最多约 100 秒",
                    "对话上下文太长，回得会慢", "新文件放进项目，不覆盖原文件", "cross、strike、wavy 不带 text 的不画", "不带的草稿纸不画",
                    "note/question：短批注（每条不超过 40 字）"):
            self.assertTrue(hits({"例句": bad}), bad)

    def test_ts_strings_finds_the_tool_descriptions(self):
        """读插件源码的那一段要真读到了东西：八个工具的说明都在，正则字面量、注释里的字不算进来。"""
        src = REGISTER.read_text("utf-8")
        strs = [s for _, _, s in ts_strings(src)]
        for name in ("ink_reply", "ink_show", "ink_snapshot", "ink_import", "ink_scan", "ink_confirm", "ink_ask", "ink_edit"):
            self.assertIn(name, strs)
            self.assertTrue(CJK.search(tool_desc(name)), name)
        self.assertTrue(any(s.startswith("把回答写回用户平板上的草稿纸") for s in strs))
        self.assertIn("草稿纸服务已停止。要再用，输入 /ink。", strs)
        self.assertFalse(any("本会话的连接状态" in s for s in strs))  # 注释
        got = ts_strings("const re = /\"([^\"]*)\"|(\\S+)/g\nconst a = '好' // 'x'\nconst b = `x${f('y')}z`\n<Box a=\"b\" />")
        self.assertEqual(sorted((line, s) for _, line, s in got), [(2, "好"), (3, "x…z"), (3, "y"), (4, "b")])


class ProtocolPointsTest(unittest.TestCase):
    def setUp(self):
        self.p = prompt.protocol()

    def test_every_section_is_in(self):
        """每个分段的常量都原样（换成第三人称）拼进了固定说明，没有哪条在重排时掉了；蓝字那条紧跟在「两层」后面。"""
        names = ("COLORS", "RECO_HINT", "CONFIRM_HINT", "TWO_LAYERS", "VOICE_HINT", "EDIT_RULE", "WRITE_HINT", "CARD_HINT",
                 "ASK_HINT", "SKETCH_HINT", "SUGGEST_HINT", "FILE_HINT", "MAP_HINT", "OTHER_HINT")
        for name in names:
            self.assertIn(prompt._third(getattr(prompt, name)), self.p, name)
        at = {name: self.p.index(prompt._third(getattr(prompt, name))) for name in names}
        self.assertLess(at["TWO_LAYERS"], at["VOICE_HINT"])
        self.assertLess(at["VOICE_HINT"], at["EDIT_RULE"])
        self.assertNotIn("我", re.sub(r"「[^」]*」", "", self.p))   # 第三人称；引号里的原话不换
        self.assertNotIn("用户们", self.p)                          # 「我们」只能写在引号里

    def test_ai_button_and_one_rule(self):
        self.assertIn("写完点「AI」交上来", self.p)
        self.assertIn("用户写完一段点「AI」才交上来", self.p)
        for must in ("红字是用户明确要你办的", "红字里说了要怎么回", "只指出真正的错和漏", "没有就一条都不写", "最多一条点拨",
                     "点到为止", "写出依据", "红字没要求的，不改电脑上的文件"):
            self.assertIn(must, self.p)

    def test_voice_rules(self):
        """两条蓝字的写法（2026-11-14 用户定了方向）：和「少而准」写成同一件事的两面，不是另立一条。"""
        v = prompt._third(prompt.VOICE_HINT)
        for must in ("同一件事的两面", "最多复述半句", "没连起来的联系", "漏掉的情形", "下一步值得问的问题", "不硬凑",
                     "分清是谁的想法", "「你提的办法」", "「我们定的」", "不要写成像是你在介绍一个方案", "分不清哪些是自己想到的"):
            self.assertIn(must, v)
        self.assertIn("少而准", prompt.TWO_LAYERS)  # VOICE_HINT 指着的那一条还在

    def test_where_things_go(self):
        """位置由草稿纸定：短批注、小蓝点、圈号和卡片；Claude 只管 anchor 指对。图和公式、卡片怎么回见工具说明和消息（2026-11-16 规则瘦身）。"""
        for must in ("放在哪由草稿纸定，你只要把 anchor 指对", "短批注", "小蓝点", "圈号", "不占纸面", "write 带 card",
                     "讲不清的画出来"):
            self.assertIn(must, self.p)

    def test_reads(self):
        """读法：规则里只留半句（2026-11-16 规则瘦身 B 组④），漏了哪几组服务在工具结果里点名，怎么显示在工具说明里。"""
        self.assertIn("每次回都给红笔那几组和回应到的那几组各交一条 read（照写的原样转写）", self.p)
        reply = tool_desc("ink_reply")
        for must in ("照写的原样转写，不翻译、不解释", "「Claude 读到了什么」", "灰色小字显示在那几笔下面", "漏了的组，工具结果里会点名"):
            self.assertIn(must, reply)

    def test_confirm_ask_and_files(self):
        """确认字迹、问话卡片、改文件：规则里留「什么时候用、读不准不要猜」，一步步怎么做在工具说明和返回里。"""
        for must in ("mcp__inkpad__ink_confirm", "不要猜", "mcp__inkpad__ink_ask", "要用户回答才能继续", "纸上放不下",
                     "动手前先调 mcp__inkpad__ink_edit", "【草稿纸·撤回】", "【草稿纸·整本】"):
            self.assertIn(must, self.p)
        self.assertIn("解释、检查、提建议", self.p)  # 「检查」作动词照常
        ask, edit = tool_desc("ink_ask"), tool_desc("ink_edit")
        for must in ("能写在纸上的都写在纸上", "不要替用户选", "忽略了的问题不要再问"):
            self.assertIn(must, ask)
        for must in ("覆盖原文件，还是另存一份？", "不要替用户选", "用户点了「忽略」，这次就不改这个文件", "用 ink_import 导入改好的那个文件",
                     "ink_reply 的 result 逐条回报", "keep"):
            self.assertIn(must, edit)

    def test_restoring_from_keep_is_an_edit(self):
        """从留底拿回旧版、盖掉现在这份，也算改文件：照样先调 ink_edit 再覆盖（2026-11-16 用户定「规则补一句」）。
        规则瘦身后这句缩进了固定说明「改文件」那一条的括号里；留底在哪、怎么拿回来写在 ink_edit 的说明里。"""
        self.assertIn("改文件：要改一份已导入草稿纸的文档（用户交上来的书页对应的原文件、用户在对话里点名的；"
                      "从留底拿旧版回来盖掉现在这份也算），动手前先调 mcp__inkpad__ink_edit", self.p)
        self.assertIn("拿回来要盖掉现在这份时，也算改文件，照样先调它，再拿留底的内容覆盖。", tool_desc("ink_edit"))

    def test_suggest_only_on_documents(self):
        s = prompt.SUGGEST_HINT
        self.assertIn("suggest 只用在改文档", s)
        self.assertIn("印刷的内容", s)
        self.assertIn("没有 ✓ ×", s)
        self.assertIn("label、node、link、group", self.p)
        self.assertIn("概念图（用户把框、圈着的词用箭头连起来）上的四种都是建议", tool_desc("ink_reply"))

    def test_protocol_is_short(self):
        """规则瘦身（2026-11-16）：固定说明每个对话一开头就整段带上，不能再一句句长回去。"""
        self.assertLessEqual(len(self.p), PROTOCOL_MAX, f"固定说明 {len(self.p)} 字，超过 {PROTOCOL_MAX}")

    def test_moved_details_left_the_protocol(self):
        """规则瘦身（2026-11-16）删掉、挪走的话：固定说明里不再有，现在的去处一定有（MOVED 逐条）。"""
        homes = moved_homes()
        for gone, where, must in MOVED:
            self.assertNotIn(gone, self.p, f"固定说明里还有「{gone}」（应当只在 {where}）")
            self.assertIn(must, homes[where], f"{where} 里没有「{must}」（从固定说明挪过去的「{gone}」）")

    def test_pointers_name_real_tools(self):
        """指路的话里提到的工具名都是插件真注册了的（写错一个字，Claude 就找不到）；每段指路的都写了工具全名。"""
        real = set(re.findall(r"name: '(ink_[a-z]+)'", REGISTER.read_text("utf-8")))
        self.assertEqual(len(real), 8, real)
        named = re.findall(r"(?<![a-z_])(ink_[a-z]+)", self.p)
        self.assertTrue(named)
        for name in named:
            self.assertIn(name, real, f"固定说明里提到的 {name} 不是插件的工具")
        for full in re.findall(r"mcp__inkpad__(\w+)", self.p):
            self.assertIn(full, real)
        for pointer in (prompt.CARD_HINT, prompt.ASK_HINT, prompt.SKETCH_HINT, prompt.FILE_HINT, prompt.MAP_HINT, prompt.OTHER_HINT,
                        prompt.CONFIRM_HINT):
            if "见" in pointer or "调" in pointer or "用 mcp" in pointer:
                self.assertTrue("mcp__inkpad__ink_" in pointer or "write 带 card" in pointer, pointer)

    def test_scan_head_says_what_was_sent(self):
        """平板点「AI」几页一起交（only_new）：开头写「有新笔迹的页」，不写成整本都交了。"""
        info = [{"no": 1, "image": "p.png", "label": "草稿本第 1 页", "scale": 1, "h": 1414, "groups": [], "now": 0, "first": True}]
        self.assertTrue(prompt.build_scan_message("草稿本", info, "S1", origin="tablet", only_new=True)
                        .startswith("【草稿纸·整本】我把《草稿本》里有新笔迹的页一起发给你（共 1 页）。"))
        self.assertTrue(prompt.build_scan_message("草稿本", info, "S1", origin="tablet")
                        .startswith("【草稿纸·整本】我把《草稿本》里写过字的页一起发给你（共 1 页）。"))

    def test_scan_long_page_says_where_the_image_starts(self):
        """很长的页缩小了画：换回页面 y 坐标要加上图上沿在页面上的位置（空白本子的纸向上长过时不是 0，可以是负的）。"""
        def say(y0):
            info = [{"no": 1, "image": "p.png", "label": "草稿本第 1 页", "scale": 0.5, "h": 4000, "y0": y0, "groups": [], "now": 0}]
            return prompt.build_scan_message("草稿本", info, "S1")
        self.assertIn("页面 y 坐标 = 图里像素 ÷ 0.50）", say(0))
        self.assertIn("页面 y 坐标 = 图里像素 ÷ 0.50 − 300）", say(-300))
        self.assertIn("页面 y 坐标 = 图里像素 ÷ 0.50 + 120）", say(120))


class SameStoryTest(unittest.TestCase):
    """固定说明和插件的工具说明讲同一件事时一致。"""

    def setUp(self):
        self.p = prompt.protocol()
        self.reply = tool_desc("ink_reply")

    def test_reply_tool_matches_protocol(self):
        for both in ("小蓝点", "原样转写", "回一条新的 write（anchor 填那条红笔），旧的那条用户自己擦", "不占纸面", "放在哪由草稿纸定，你只要把 anchor 指对"):
            self.assertIn(both, self.reply, both)
            self.assertIn(both, self.p, both)
        # 规则瘦身（2026-11-16）：这几样只在工具说明里（固定说明指路过来）
        for only in ("圈号是平板自己标的", "先看右边再看下面", "card 填 n", "概念图（用户把框、圈着的词用箭头连起来）上的四种都是建议"):
            self.assertIn(only, self.reply, only)
            self.assertNotIn(only, self.p, only)
        self.assertIn("书页和推送页上排在右边一栏", self.reply)          # 短批注放哪：照页面实际的做法
        self.assertIn("只用在书页、推送页上印刷的内容", self.reply)       # suggest 只在文档上有 ✓ ×
        self.assertIn("书页（或你推送的页）上印刷的内容", self.p)
        self.assertIn("平板当前打开的那一页", self.reply)               # 不给 submission 时写到哪：description 和参数说明说法一样
        # 服务把关的几条（B 组）：工具说明里说了写错会怎样
        self.assertIn("写长了草稿纸会把它收成圈号卡片，工具结果里会说", self.reply)
        self.assertIn("cross、strike、wavy 不带 text 的那一条会被退回、不画（工具结果里写明第几条缺什么，同一次的别的照写）", self.reply)

    def test_waits_match(self):
        confirm = tool_desc("ink_confirm")
        self.assertIn("约 45 秒", confirm)
        self.assertNotIn("约 45 秒", self.p)                            # 规则瘦身：等多久写在等不到时的返回里（C 组②）
        src = REGISTER.read_text("utf-8")
        self.assertIn("wait: k ? 20 : 25", src)                         # 插件实际等 25 + 20 秒
        self.assertIn("约一分半", tool_desc("ink_ask"))
        self.assertIn("const ASK_WAITS = [25, 25, 25, 15]", src)        # 共 90 秒

    def test_confirm_timeout_says_what_to_do(self):
        """确认卡片等不到回答（C 组②，从固定说明挪过来）：返回里写等了约 45 秒、先按自己的理解继续、标明哪处是推测的、回答之后作为新消息来。"""
        src = REGISTER.read_text("utf-8")
        late = [s for _, _, s in ts_strings(src) if s.startswith("等了约 45 秒")]
        self.assertEqual(len(late), 1, late)
        for must in ("用户暂时没有回答", "确认卡片还留在平板上", "【草稿纸·确认】", "先按你的理解继续", "标明哪处是推测的"):
            self.assertIn(must, late[0])
        body = src[src.index("async function waitConfirm"):src.index("// 问话卡片（ink_ask）")]
        self.assertIn("return CONFIRM_LATE", body)                      # 等满两次还没答时返回的就是它
        self.assertIn("const CONFIRM_LATE =", src[:src.index("async function waitConfirm")])


class MessageHintsTest(unittest.TestCase):
    """规则瘦身（2026-11-16）C 组：两处细节只在这次消息里真有那种情况时才带。"""

    def test_rows_hint_only_when_a_group_has_rows(self):
        msg = prompt.build_message(meta(), PATHS, "草稿本第 1 页", "", "S1")          # g2 分了 2 行
        self.assertIn("｜分 2 行（g2:1、g2:2）", msg)
        self.assertIn(prompt.ROWS_HINT.format(g="g2"), msg)
        self.assertIn("分了几行的组只想指其中一行时，anchor 写 g2:1（第 1 行，从上往下数，其余类推）", msg)
        flat = [dict(g, lines=0) for g in GROUPS]
        for m in (prompt.build_message(meta(groups=flat), PATHS, "x", "", "S1"),
                  prompt.build_message(meta(include_process=False), PATHS, "x", "", "S1")):   # 只有位置时不写「分 N 行」，也不带这句
            self.assertNotIn("分了几行的组", m)
        scan = prompt.build_scan_message("草稿本", [{"no": 1, "image": "p.png", "label": "草稿本第 1 页", "scale": 1, "h": 1414,
                                                    "groups": [dict(g, inSel=True) for g in GROUPS], "now": 200_000, "first": True}], "S9")
        self.assertIn("anchor 写 g2:1", scan)
        self.assertNotIn("g3:1", prompt.protocol())

    def test_reco_only_hint_only_when_it_shows(self):
        plain = [dict(g, reco_lang="zh") if g.get("reco") else g for g in GROUPS]
        msg = prompt.build_message(meta(groups=plain), PATHS, "x", "", "S1")
        self.assertNotIn("只按", msg)
        zh = [dict(g, reco_lang="zh-only") if g["id"] == "g2" else dict(g, reco_lang="zh") if g.get("reco") else g for g in GROUPS]
        for proc in (True, False):
            m = prompt.build_message(meta(groups=zh, include_process=proc), PATHS, "x", "", "S1")
            self.assertIn("｜电脑识别", m)
            self.assertIn("（只按中文认）", m)
            self.assertEqual(m.count("「只按中文认」表示本机没有英文识别器，英文会被认成形近的汉字。"), 1)
            self.assertNotIn("只按英文认", m)
        en = prompt.build_message(meta(), PATHS, "x", "", "S1")                     # g5 是 en-only
        self.assertIn("「只按英文认」表示本机没有中文识别器", en)
        gone = [dict(g, erased=g["n"]) if g["id"] == "g2" else dict(g, reco_lang="zh") if g.get("reco") else g for g in zh]
        self.assertNotIn("只按中文认", prompt.build_message(meta(groups=gone), PATHS, "x", "", "S1"))  # 那组全擦掉了、没列出来：不带
        self.assertNotIn("只按中文认", prompt.protocol())

    def test_owed_block_does_not_steal_the_submission(self):
        """还没回报的修改（B 组⑤）列在消息里：写那次的投递编号，但不写成 submission="…"——插件按第一个 submission="…" 认这一轮在回哪次投递。"""
        msg = prompt.build_message(meta(owed=OWED), PATHS, "x", "", "S1")
        self.assertIn("还没回报的修改：之前我采纳的这几条，你还没用 result 告诉我改成了没有：\n- 投递 20261116-101010-abcd：s1\n"
                      "- 投递 20261116-111111-beef 第 2 页：s1、s3", msg)
        self.assertEqual(re.findall(r'submission="([^"]+)"', msg), ["S1"])
        scan = prompt.build_scan_message("草稿本", [{"no": 1, "image": "p.png", "label": "草稿本第 1 页", "scale": 1, "h": 1414,
                                                    "groups": [], "now": 0, "first": True}], "S9", origin="tablet", owed=OWED)
        self.assertIn("还没回报的修改", scan)
        self.assertEqual(set(re.findall(r'submission="([^"]+)"', scan)), {"S9"})
        self.assertLess(scan.index("还没回报的修改"), scan.index('写回某一页用'))
        self.assertNotIn("还没回报", prompt.build_message(meta(), PATHS, "x", "", "S1"))

    def test_edit_story(self):
        for name in ("ink_edit", "ink_import", "ink_reply"):
            d = tool_desc(name)
            self.assertIn("ink_edit", d, name)
            self.assertIn("ink_import", d, name)
        self.assertIn("动手前先调 ink_edit", tool_desc("ink_import"))

    def test_plugin_readme(self):
        readme = (PLUGIN / "README.md").read_text("utf-8")
        self.assertIn("点「AI」", readme)
        self.assertIn("短批注", readme)
        self.assertIn("/ink stop", readme)
        self.assertIn("offer_new_files", readme)


if __name__ == "__main__":
    unittest.main()

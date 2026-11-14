// 改电脑上的文件 · 覆盖（2026-11-14，阶段 C；《产品定义》第 4 节），用一份 Markdown（周末买菜清单）走一遍：
// Claude 在文档上提一条修改 → 我在平板上点 ✓、点「AI」→ Claude 调 ink_edit（不带 mode）→ 平板顶上落下「覆盖还是另存」的卡片 →
// 点「覆盖」→ 服务先留底 → Claude 改原文件、ink_import → 这本原地换新版，橙框标出改动，右上角提示条上有「撤回这次修改」→
// Claude 用 result 回报，纸上那条写「已改」→ 点「撤回这次修改」，顶上先问一句 → 撤回：电脑上的文件逐字节回到改之前，
// 这本换回去，纸上那条写「已撤回」，对话收到一条【草稿纸·撤回】。另查提示条摆的位置（全屏、退出全屏）不压页面右上角的字、
// 不挡顶上居中的卡片和右下角那一条。
// 这里站在插件的位置上直接调服务的 /bridge/edit、/bridge/edit-wait、/bridge/import、/bridge/reply。
// 跑法：node tests/browser/edit_overwrite.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY, APP } from '../browser_lib.mjs';

const T = await boot({ name: 'edit-overwrite' });
const js = T.evalJS, sid = 'S1';
const SRC = join(T.ROOT, 'docs'), MD = join(SRC, '买菜清单.md');
mkdirSync(SRC, { recursive: true });
const V0 = '# 周末买菜清单\n\n- 西红柿 三个\n- 鸡蛋 一盒\n- 青菜 一把\n- 面包 一袋\n- 苹果 四个\n';
const V1 = '# 周末买菜清单\n\n- 西红柿 五个\n- 鸡蛋 一盒\n- 青菜 一把\n- 面包 一袋\n- 苹果 四个\n- 豆腐 一块\n';
writeFileSync(MD, V0, 'utf8');
const before = readFileSync(MD);
const py = (code, ...args) => execFileSync(PY, ['-c', code, ...args], { encoding: 'utf8' });
const kept = (p) => JSON.parse(py(`import sys,json; sys.path.insert(0, sys.argv[1]); from keep import Keeper
k=Keeper(sys.argv[2]); print(json.dumps({'h': k.history(sys.argv[3]), 'a': k.asides(sys.argv[3])}))`, APP, join(T.DATA, 'keep'), p));
const rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.hidden || !e.getClientRects().length) return null;
  const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
// 截图：先收起底下那句提示（要 8 秒才自己消失），免得盖住纸上的字
const shot = async (f) => { await js(`document.querySelector('#toast').hidden = true`); return T.shot(f); };
const meets = (a, b) => Boolean(a && b) && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const toastText = () => js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
const waitToast = async (re, ms = 30000) => { const t0 = Date.now(); for (;;) { const t = await toastText(); if (re.test(t)) return t; if (Date.now() - t0 > ms) return t; await T.sleep(200); } };
// 这一页上的修改建议：决定、回报、纸上写的状态
const sug = () => js(`window.__ink.S.page.ai.filter((a) => a.type === 'suggest').map((a) => { const g = document.querySelector('#aiRoot [data-id="' + a.id + '"]'), q = (s) => g && g.querySelector(s);
  const c = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  return { id: a.id, verdict: a.verdict || null, sent: Boolean(a.sent), result: a.result || null, onDoc: Boolean(a.onDoc), yes: c(q('.vbtn.yes circle')),
    stat: (q('text.vstat') || {}).textContent || '', statCls: (q('text.vstat') || { getAttribute: () => '' }).getAttribute('class') }; })`);
// 提示条底下那块书页上有没有印刷的字（深色的点）：提示条不该压在文档内容上
const underChip = () => js(`(() => { const S = window.__ink.S, c = document.querySelector('#verchip').getBoundingClientRect(), r = document.querySelector('#stage').getBoundingClientRect(), v = S.view;
  const img = S.bgImg; if (!img) return null;
  const toPage = (x, y) => [(x - r.left - v.tx) / v.s, (y - r.top - v.ty) / v.s], [x0, y0] = toPage(c.left, c.top), [x1, y1] = toPage(c.right, c.bottom), k = img.naturalWidth / 1000;
  const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight; const x = cv.getContext('2d'); x.drawImage(img, 0, 0);
  const sx = Math.max(0, Math.floor(x0 * k)), sy = Math.max(0, Math.floor(y0 * k)), ex = Math.min(cv.width, Math.ceil(x1 * k)), ey = Math.min(cv.height, Math.ceil(y1 * k));
  if (ex <= sx || ey <= sy) return { dark: 0, area: 0, page: [x0, y0, x1, y1] };
  const d = x.getImageData(sx, sy, ex - sx, ey - sy).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 450) dark++;
  return { dark, area: (ex - sx) * (ey - sy), page: [x0, y0, x1, y1] }; })()`);
const chipText = () => js(`[...document.querySelectorAll('#verchip span, #verchip button')].filter((e) => !e.hidden).map((e) => e.textContent)`);
// 提示条摆得对：不挡左上角那一排、顶栏、右下角那一条，不压文档上的字
const chipPlaced = async () => {
  const chip = await rect('#verchip'), row = await rect('#chipRow'), bar = await rect('#bar'), tools = await rect('#tools'), under = await underChip();
  return { ok: Boolean(chip) && !meets(chip, row) && !meets(chip, bar) && !meets(chip, tools) && Boolean(under) && under.dark === 0 && chip.r <= (await js('document.documentElement.clientWidth')),
    chip, row, bar, tools, under };
};

// 1. 导入这份清单，打开它；Claude 在文档上提一条修改（框住第一行清单），我点 ✓ 采纳，点「AI」交上去
const imp = await T.post('/bridge/import', { sid, path: MD });
T.ok('导入了：一本「买菜清单」', imp.ok === true && imp.id === 'book:买菜清单.pdf', imp);
await T.openNotebook(imp.id, 0);
T.ok('打开了这本，书页有底图', await T.waitFor(`window.__ink.S.nb && window.__ink.S.nb.id === ${JSON.stringify(imp.id)} && window.__ink.S.bgImg`), await js(`window.__ink.S.nb && window.__ink.S.nb.id`));
const rep = await T.post('/bridge/reply', { sid, items: [{ type: 'suggest', text: '改为：西红柿 五个', box: [60, 150, 520, 200] }] });
T.ok('Claude 的修改建议落到这一页，算在文档上，带 ✓ ×', rep.ok && (await T.waitFor(`window.__ink.S.page.ai.some((a) => a.type === 'suggest')`, 10000)) && (await sug())[0].onDoc && Boolean((await sug())[0].yes), await sug());
await T.sleep(800);
await T.fingerTapAt(...(await sug())[0].yes);
T.ok('点 ✓：采纳', (await sug())[0].verdict === 'yes', await sug());
await T.saved();
await T.tap('#check');
const sub1 = await T.waitSub(sid);
T.ok('交上去了：消息里有这条采纳的决定，叫 Claude 动手前先调 ink_edit', Boolean(sub1) && sub1.text.includes('- s1（在文档上）「改为：西红柿 五个」：采纳')
  && sub1.text.includes('动手前先调 mcp__inkpad__ink_edit'), sub1 && sub1.text.slice(-600));

// 2. Claude 调 ink_edit（不带 mode）：平板顶上落下「覆盖还是另存」，只能点选；点「覆盖」，工具那边拿到「改原文件本身」
const ask = await T.post('/bridge/edit', { sid, path: MD });
T.ok('服务在平板上问了（拿到卡片编号）', typeof ask.ask === 'string' && ask.name === '买菜清单.md', ask);
T.ok('平板顶上落下卡片：问改《买菜清单.md》覆盖还是另存', await T.waitFor(`window.__ink.S.qShown === ${JSON.stringify(ask.ask)} && !document.querySelector('#qcard').hidden`));
await T.sleep(400);
const card = await js(`({ head: document.querySelector('#qcHead').textContent, q: document.querySelector('#qcBody .qc-q').textContent,
  opts: [...document.querySelectorAll('#qcBody .qc-opts button')].map((b) => b.textContent), pad: Boolean(document.querySelector('#qcBody .qc-pad')),
  left: [...document.querySelectorAll('#qcFoot .qc-left button')].filter((b) => !b.hidden).map((b) => b.textContent) })`);
T.ok('卡片：问的话、「覆盖」「另存」两个选项、没有手写那块纸、左下角「忽略」', card.head === 'idea 问你' && card.q === '改《买菜清单.md》：覆盖原文件，还是另存一份？'
  && JSON.stringify(card.opts) === '["覆盖","另存"]' && !card.pad && JSON.stringify(card.left) === '["忽略"]', card);
T.ok('选之前什么都没动：没有留底', kept(MD).h.length === 0 && readFileSync(MD).equals(before), kept(MD));
await shot('edit-ask-card.png');
const waiting = T.post('/bridge/edit-wait', { id: ask.ask, wait: 20 });
const opt = await js(`(() => { const b = [...document.querySelectorAll('#qcBody .qc-opts button')].find((x) => x.textContent === '覆盖'); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
await T.tapAt(opt[0], opt[1]);
const go = await waiting;
T.ok('工具那边拿到：覆盖，改原文件本身，改完 ink_import', go.done === true && go.mode === 'overwrite' && go.chose === '覆盖' && go.text.includes('本身') && go.text.includes('mcp__inkpad__ink_import'), go);
const k1 = kept(MD);
T.ok('留了底：改之前的样子，逐字节一样', k1.h.length === 1 && k1.h[0].note === '覆盖前' && readFileSync(k1.h[0].copy).equals(before), k1);
T.ok('卡片消失', await T.waitFor(`document.querySelector('#qcard').hidden && !window.__ink.S.cards.length`));

// 3. Claude 改原文件、导入：这本原地换新版（橙框标出改动），提示条上有「撤回这次修改」；Claude 用 result 回报，纸上写「已改」
writeFileSync(MD, V1, 'utf8');
const after = readFileSync(MD);
const up = await T.post('/bridge/import', { sid, path: MD });
T.ok('导入：原地更新同一本，没有提醒', up.ok === true && up.id === imp.id && !up.remind, up);
T.ok('平板上这本换了新版：右上角提示条写这一页改过，带「对比旧版」「撤回这次修改」', await T.waitFor(`!document.querySelector('#verchip').hidden && document.querySelector('#verchip').dataset.kind === 'page'
  && document.querySelector('#verUndo').textContent === '撤回这次修改' && !document.querySelector('#verUndo').hidden`, 20000), await chipText());
T.ok('改动处有橙框', (await T.count('#aiRoot .chg-marks rect.chg')) > 0, await T.count('#aiRoot .chg-marks rect'));
const res = await T.post('/bridge/reply', { sid, submission: sub1.id, items: [{ type: 'result', anchor: 's1', ok: true }] });
T.ok('Claude 回报 s1 改成了：纸上那条写「已改」', res.ok === true && (await T.waitFor(`window.__ink.S.page.ai.some((a) => a.result && a.result.ok)`, 10000)) && (await sug())[0].stat === '已改', await sug());
T.ok('回报记着是哪一次修改', Boolean((await sug())[0].result.edit) && (await sug())[0].result.edit === go.eid, (await sug())[0].result);
await T.sleep(600);
let at = await chipPlaced();
T.ok('全屏：提示条和左上角那一排在同一行（或它下面），不挡它和右下角那一条，底下没有文档的字', at.ok && at.chip.t < 80, at);
await shot('edit-chip-fullscreen.png');
// 顶上来一张卡片：排在提示条下面，不互相挡
const r1 = await T.post('/bridge/ask', { sid, result: '清单改好了：西红柿改成五个，加了豆腐。' });
await T.waitFor(`window.__ink.S.qShown === ${JSON.stringify(r1.id)} && !document.querySelector('#qcard').hidden`);
await T.sleep(400);
T.ok('顶上居中的卡片排在提示条下面，两个不重叠', !meets(await rect('#qcard'), await rect('#verchip')), [await rect('#qcard'), await rect('#verchip')]);
await T.tap('#qcSeen');
await T.tap('#toolsBars', 800);
at = await chipPlaced();
const barR = await rect('#bar');
T.ok('退出全屏：提示条在顶栏下面靠右，不挡顶栏，底下没有文档的字', at.ok && Boolean(barR) && at.chip.t >= barR.b, at);
await shot('edit-chip-bars.png');
await T.tap('#fsBtn', 800);

// 4. 点「撤回这次修改」：顶上先问一句；确认后电脑上的文件逐字节回到改之前，这本换回去，纸上那条写「已撤回」
await T.tap('#verUndo', 800);
const conf = await js(`({ up: !document.querySelector('#qcard').hidden, kind: document.querySelector('#qcard').dataset.kind, head: document.querySelector('#qcHead').textContent,
  text: document.querySelector('#qcBody').innerText, later: !document.querySelector('#qcLater').hidden,
  btns: [...document.querySelectorAll('#qcFoot button')].filter((b) => !b.hidden && b.offsetWidth).map((b) => b.textContent) })`);
T.ok('顶上问一句：撤回对《买菜清单.md》的上一次修改？，「取消」「撤回」，没有「稍后」', conf.up && conf.kind === 'local' && conf.head === '撤回修改'
  && conf.text.trim() === '撤回对《买菜清单.md》的上一次修改？电脑上的文件会回到修改之前。' && JSON.stringify(conf.btns) === '["取消","撤回"]' && !conf.later, conf);
await shot('edit-undo-confirm.png');
await T.tap('#qcNo', 600);
T.ok('点「取消」：什么都没动', (await js(`document.querySelector('#qcard').hidden`)) && readFileSync(MD).equals(after) && kept(MD).h.length === 1);
await T.tap('#verUndo', 800);
await T.tap('#qcYes');
const t4 = await waitToast(/已撤回|没撤回/);
T.ok('撤回了：提示说回到了修改之前、再往前没有留底了', /已撤回：《买菜清单\.md》回到了修改之前（再往前没有留底了）/.test(t4), t4);
T.ok('电脑上的文件逐字节回到改之前', readFileSync(MD).equals(before));
T.ok('纸上那条写「已撤回」', await T.waitFor(`(() => { const a = window.__ink.S.page.ai.find((x) => x.type === 'suggest'), g = a && document.querySelector('#aiRoot [data-id="' + a.id + '"] text.vstat'); return g && g.textContent === '已撤回'; })()`, 15000), await sug());
T.ok('「已撤回」不是绿色（和「已改」分得开）', /undone/.test((await sug())[0].statCls), (await sug())[0]);
await shot('edit-undone.png');
const told = await T.waitSub(sid);
T.ok('对话收到一条【草稿纸·撤回】，说文件回到了修改之前、不用回复', Boolean(told) && told.text.startsWith('【草稿纸·撤回】我在平板上撤回了对 ') && told.text.includes('不用回复'), told && told.text);
T.ok('没有可撤的了：提示条上不再有撤回按钮', (await js(`document.querySelector('#verUndo').hidden`)), await chipText());
if (!(await T.visible('#drawer'))) await T.tap('#nbChip');
T.ok('抽屉里这本那一行也没有「撤回上次修改」', (await T.count('#nbList .nb-item.cur')) === 1 && (await T.count('#actUndoEdit')) === 0);

await T.finish();

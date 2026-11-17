// 改电脑上的文件 · 另存（2026-11-14，阶段 C；《产品定义》第 4 节），用一份横版 PDF（旅行计划，像幻灯片那样 16:9）、横着的 iPad 走一遍：
// Claude 在文档上提一条修改 → 我点 ✓、点「AI」→ Claude 调 ink_edit（不带 mode）→ 卡片上点「另存」→ 服务在原文件旁边新建
// 旅行计划_v2.pdf（和原文件逐字节一样），留一条「另存」的记录 → Claude 改新文件、ink_import 新文件（不用 replace）→
// 平板上这本换成 v2，提示条上有「撤回这次修改」→ result 回报「已改」→ 撤回：顶上先问一句（说清楚换回原文件、新文件留着）→
// 这本换回 v1，v1 逐字节没动过，v2 留在电脑上，纸上写「已撤回」，对话收到【草稿纸·撤回】。
// 另查横屏时提示条（全屏、退出全屏）不压在幻灯片上。
// 跑法：node tests/browser/edit_saveas.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY, APP } from '../browser_lib.mjs';

const T = await boot({ name: 'edit-saveas', width: 1194, height: 834 });
const js = T.evalJS, sid = 'S1';
const SRC = join(T.ROOT, 'docs'), V1 = join(SRC, '旅行计划_v1.pdf'), V2 = join(SRC, '旅行计划_v2.pdf');
mkdirSync(SRC, { recursive: true });
const py = (code, ...args) => execFileSync(PY, ['-c', code, ...args], { encoding: 'utf8' });
// 一页 16:9 的「幻灯片」：标题、右上角一个小标签（幻灯片右上角常有页码、标志：以前全屏时提示条正压在这里）和三行行程
const slide = (file, lines) => py(`import pymupdf as fitz,sys,json
doc=fitz.open(); p=doc.new_page(width=1000,height=562.5)
p.insert_text((60,90),'Autumn trip plan',fontsize=34)
p.insert_text((800,100),'Plan A',fontsize=30)
for i,t in enumerate(json.loads(sys.argv[2])): p.insert_text((60,180+i*70),t,fontsize=26)
doc.save(sys.argv[1])`, file, JSON.stringify(lines));
slide(V1, ['Day 1: early train to the lake', 'Day 2: museum and old town', 'Day 3: hike the north trail']);
const before = readFileSync(V1);
const kept = (p) => JSON.parse(py(`import sys,json; sys.path.insert(0, sys.argv[1]); from keep import Keeper
print(json.dumps(Keeper(sys.argv[2]).history(sys.argv[3])))`, APP, join(T.DATA, 'keep'), p));
const rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.hidden || !e.getClientRects().length) return null;
  const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
// 截图：先收起底下那句提示（要 8 秒才自己消失），免得盖住纸上的字
const shot = async (f) => { await js(`document.querySelector('#toast').hidden = true`); return T.shot(f); };
const meets = (a, b) => Boolean(a && b) && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const toastText = () => js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
const waitToast = async (re, ms = 30000) => { const t0 = Date.now(); for (;;) { const t = await toastText(); if (re.test(t)) return t; if (Date.now() - t0 > ms) return t; await T.sleep(200); } };
const sug = () => js(`window.__ink.S.page.ai.filter((a) => a.type === 'suggest').map((a) => { const g = document.querySelector('#aiRoot [data-id="' + a.id + '"]'), q = (s) => g && g.querySelector(s);
  const c = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  return { verdict: a.verdict || null, result: a.result || null, onDoc: Boolean(a.onDoc), yes: c(q('.vbtn.yes circle')), stat: (q('text.vstat') || {}).textContent || '' }; })`);
// 这一页纸（幻灯片）在屏幕上的位置
const paper = () => js(`(() => { const S = window.__ink.S, r = document.querySelector('#stage').getBoundingClientRect(), v = S.view;
  return { l: r.left + v.tx, t: r.top + v.ty, r: r.left + v.tx + 1000 * v.s, b: r.top + v.ty + S.baseH * v.s }; })()`);
// 提示条底下那块幻灯片上有没有印刷的字（深色的点）
const underChip = () => js(`(() => { const S = window.__ink.S, c = document.querySelector('#verchip').getBoundingClientRect(), r = document.querySelector('#stage').getBoundingClientRect(), v = S.view;
  const img = S.bgImg; if (!img) return null;
  const toPage = (x, y) => [(x - r.left - v.tx) / v.s, (y - r.top - v.ty) / v.s], [x0, y0] = toPage(c.left, c.top), [x1, y1] = toPage(c.right, c.bottom), k = img.naturalWidth / 1000;
  const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight; const x = cv.getContext('2d'); x.drawImage(img, 0, 0);
  const sx = Math.max(0, Math.floor(x0 * k)), sy = Math.max(0, Math.floor(y0 * k)), ex = Math.min(cv.width, Math.ceil(x1 * k)), ey = Math.min(cv.height, Math.ceil(y1 * k));
  if (ex <= sx || ey <= sy) return { dark: 0, area: 0, page: [x0, y0, x1, y1] };
  const d = x.getImageData(sx, sy, ex - sx, ey - sy).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 450) dark++;
  return { dark, area: (ex - sx) * (ey - sy), page: [x0, y0, x1, y1] }; })()`);
// 摆得对：不压幻灯片上的字（全屏时幻灯片顶到屏幕最上沿，提示条和左上角那一排一样浮在它的上沿那一窄条里），不挡左上角那一排、顶栏、右下角那一条
const chipPlaced = async () => {
  const chip = await rect('#verchip'), pg = await paper(), row = await rect('#chipRow'), bar = await rect('#bar'), tools = await rect('#tools'), under = await underChip();
  return { ok: Boolean(chip) && Boolean(under) && under.dark === 0 && !meets(chip, row) && !meets(chip, bar) && !meets(chip, tools), chip, under, pg, row, bar, tools };
};
// 对照：以前全屏时提示条的位置（顶栏高度 + 8 起，高 36）底下有字——「Plan A」那个标签
const oldSpot = () => js(`(() => { const S = window.__ink.S, r = document.querySelector('#stage').getBoundingClientRect(), v = S.view, vw = document.documentElement.clientWidth;
  const w = document.querySelector('#verchip').offsetWidth, top = 52 + 8, toPage = (x, y) => [(x - r.left - v.tx) / v.s, (y - r.top - v.ty) / v.s];
  const [x0, y0] = toPage(vw - 10 - w, top), [x1, y1] = toPage(vw - 10, top + 36);
  const img = S.bgImg, k = img.naturalWidth / 1000, cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight; const x = cv.getContext('2d'); x.drawImage(img, 0, 0);
  const sx = Math.max(0, Math.floor(x0 * k)), sy = Math.max(0, Math.floor(y0 * k)), ex = Math.min(cv.width, Math.ceil(x1 * k)), ey = Math.min(cv.height, Math.ceil(y1 * k));
  if (ex <= sx || ey <= sy) return 0; const d = x.getImageData(sx, sy, ex - sx, ey - sy).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 450) dark++; return dark; })()`);
const nbId = () => js(`window.__ink.S.nb && window.__ink.S.nb.id`);
// 临时目录可能是 8.3 短名（像 ABCDEF~1）：服务返回的是解开后的长路径，比的时候都解开
const real = (p) => (existsSync(p) ? realpathSync.native(p) : p);

// 1. 导入、打开；Claude 提一条修改（框住第 2 天那一行），我点 ✓、点「AI」
const imp = await T.post('/bridge/import', { sid, path: V1 });
await T.openNotebook(imp.id, 0);
T.ok('导入并打开了这份横版 PDF', imp.id === 'book:旅行计划_v1.pdf' && (await T.waitFor(`window.__ink.S.bgImg && window.__ink.S.nb.id === ${JSON.stringify(imp.id)}`)), imp);
await T.post('/bridge/reply', { sid, items: [{ type: 'suggest', text: '改为：Day 2: old town only', box: [55, 225, 520, 262] }] });
await T.waitFor(`window.__ink.S.page.ai.some((a) => a.type === 'suggest')`, 10000);
await T.sleep(800);
await T.fingerTapAt(...(await sug())[0].yes);
await T.saved();
await T.tap('#check');
const sub1 = await T.waitSub(sid);
T.ok('采纳的决定交上去了', Boolean(sub1) && sub1.text.includes('「改为：Day 2: old town only」：采纳'), sub1 && sub1.text.slice(-400));

// 2. ink_edit 不带 mode：卡片上点「另存」→ 原文件旁边新建 v2（逐字节一样），原文件不动，记一条「另存」
const ask = await T.post('/bridge/edit', { sid, path: V1 });
await T.waitFor(`window.__ink.S.qShown === ${JSON.stringify(ask.ask)} && !document.querySelector('#qcard').hidden`);
await T.sleep(400);
T.ok('卡片问改《旅行计划_v1.pdf》覆盖还是另存', (await T.text('#qcBody .qc-q')) === '改《旅行计划_v1.pdf》：覆盖原文件，还是另存一份？', await T.text('#qcBody .qc-q'));
await shot('edit-saveas-card-landscape.png');
const waiting = T.post('/bridge/edit-wait', { id: ask.ask, wait: 20 });
const opt = await js(`(() => { const b = [...document.querySelectorAll('#qcBody .qc-opts button')].find((x) => x.textContent === '另存'); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
await T.tapAt(opt[0], opt[1]);
const go = await waiting;
T.ok('工具那边拿到：另存，改新文件 旅行计划_v2.pdf，原文件不要动', go.done === true && go.mode === 'saveas' && go.target === real(V2) && go.text.includes(real(V2)) && go.text.includes('不要动'), go);
T.ok('新文件和原文件逐字节一样，原文件没动', existsSync(V2) && readFileSync(V2).equals(before) && readFileSync(V1).equals(before));
const k = kept(V2);
T.ok('记了一条「另存」（原文件没动，不留副本）', k.length === 1 && k[0].kind === 'saveas' && k[0].note === '另存前' && k[0].copy === null && kept(V1).length === 0, k);

// 3. Claude 改新文件、导入新文件（不用 replace）：平板上这本换成 v2；提示条带「撤回这次修改」；result 回报「已改」
slide(V2, ['Day 1: early train to the lake', 'Day 2: old town only', 'Day 3: hike the north trail']);
const v2bytes = readFileSync(V2);
const up = await T.post('/bridge/import', { sid, path: V2 });
T.ok('导入新文件：原来那本跟着换成它', up.ok === true && up.id === 'book:旅行计划_v2.pdf', up);
T.ok('平板上这本换成了 v2，提示条带「撤回这次修改」', await T.waitFor(`window.__ink.S.nb.id === 'book:旅行计划_v2.pdf' && !document.querySelector('#verchip').hidden
  && document.querySelector('#verUndo').textContent === '撤回这次修改' && !document.querySelector('#verUndo').hidden`, 20000), [await nbId(), await T.text('#verchip')]);
await T.post('/bridge/reply', { sid, submission: sub1.id, items: [{ type: 'result', anchor: 's1', ok: true }] });
T.ok('纸上那条写「已改」', await T.waitFor(`window.__ink.S.page.ai.some((a) => a.result && a.result.ok)`, 10000) && (await sug())[0].stat === '已改', await sug());
await T.sleep(600);
let at = await chipPlaced();
T.ok('横屏全屏：提示条和左上角那一排同一行，不压幻灯片上的字（右上角的「Plan A」露着），不挡左上角那一排和右下角那一条', at.ok && at.chip.t < at.row.b, at);
T.ok('对照：以前的位置底下正是「Plan A」', (await oldSpot()) > 30, await oldSpot());
await shot('edit-saveas-chip-fullscreen.png');
await T.tap('#toolsBars', 800);
at = await chipPlaced();
T.ok('横屏退出全屏：提示条在顶栏下面，不压幻灯片上的字', at.ok && at.chip.t >= at.bar.b, at);
await shot('edit-saveas-chip-bars.png');
await T.tap('#fsBtn', 800);

// 4. 撤回：顶上问一句（换回原文件、新文件留着不删）→ 这本换回 v1；v1 逐字节没动过，v2 留着；纸上「已撤回」
await T.tap('#verUndo', 800);
const conf = await js(`({ head: document.querySelector('#qcHead').textContent, text: document.querySelector('#qcBody').innerText.trim(),
  btns: [...document.querySelectorAll('#qcFoot button')].filter((b) => !b.hidden && b.offsetWidth).map((b) => b.textContent) })`);
T.ok('顶上问：撤回另存？这本换回原文件，另存出来的留在电脑上、不删', conf.head === '撤回修改'
  && conf.text === '撤回对《旅行计划_v2.pdf》的另存？平板上这本换回原文件《旅行计划_v1.pdf》，另存出来的《旅行计划_v2.pdf》留在电脑上，不删。'
  && JSON.stringify(conf.btns) === '["取消","撤回"]', conf);
await shot('edit-saveas-undo-confirm.png');
await T.tap('#qcYes');
const t4 = await waitToast(/已撤回|没撤回/);
T.ok('撤回了：这本换回 v1，v2 留在电脑上', /已撤回另存：这本换回了《旅行计划_v1\.pdf》，《旅行计划_v2\.pdf》留在电脑上/.test(t4), t4);
T.ok('平板上这本换回了 v1', await T.waitFor(`window.__ink.S.nb && window.__ink.S.nb.id === 'book:旅行计划_v1.pdf'`, 15000), await nbId());
T.ok('原文件逐字节没动过；另存出来的 v2 还在、内容是改过的', readFileSync(V1).equals(before) && existsSync(V2) && readFileSync(V2).equals(v2bytes));
T.ok('纸上那条写「已撤回」', await T.waitFor(`(() => { const a = window.__ink.S.page.ai.find((x) => x.type === 'suggest'), g = a && document.querySelector('#aiRoot [data-id="' + a.id + '"] text.vstat'); return g && g.textContent === '已撤回'; })()`, 15000), await sug());
await shot('edit-saveas-undone.png');
const told = await T.waitSub(sid);
T.ok('对话收到【草稿纸·撤回】：撤回了那次另存，新文件没删', Boolean(told) && told.text.startsWith('【草稿纸·撤回】') && told.text.includes('撤回了那次另存') && told.text.includes('没删'), told && told.text);

await T.finish();

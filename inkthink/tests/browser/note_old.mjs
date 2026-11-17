// 旧数据：以前排在右侧批注栏位置（存着 lay）的短批注（阶段 D1，《产品定义》第 3 节「短的回在原处」最后一句：以前排在右侧栏位置的旧批注留在原处不动）。
// 照以前的样子造一页数据（草稿本上一句红笔问题、一行黑笔，两条批注排在页边那一栏 x 1022，连线拉过去），打开页面查：
// 1. 两条都在原处（数据里的 lay 一点没动，纸上的字就画在那里），整行看得全（在纸上、在屏幕里），没有那一栏的米色底。
// 2. 黑笔压到第一条：它收成小蓝点，点在所指那句红笔问题的右端旁边；它的 lay 照旧不动；另一条不受影响。
// 3. 再来一条新的批注指着那句红笔：落在它旁边（让开小蓝点），不压旧的那条、不压字。
// 只在无头 Edge 里跑过；笔是 pointerType 为 pen 的鼠标事件。
// 跑法：node tests/run_browser.mjs <临时目录> --only note_old；有一项不对退出码 1。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'note-old', open: false });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const meets = (p, q) => p[0] < q[2] && p[2] > q[0] && p[1] < q[3] && p[3] > q[1];
const line = (x0, y, len, n = 10) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 2]);
const T0 = 1793300000000, REQ = '20261101-101010-ab12';
const stroke = (id, t0, x, y, n, red) => Object.assign({ id, t0, w: 2.1, pts: Array.from({ length: n }, (_, k) => [x + 12.5 * k, y + (k % 2), 0.5, 30 * k]) }, red ? { c: 'r' } : {});
const q1 = stroke('q1', T0, 100, 300, 21, true), k1 = stroke('k1', T0 + 5000, 100, 500, 41, false);
const O1 = '页边的旧批注', O2 = '另一条旧批注写得长一些会排成两行的那种样子';
const ai = [
  { id: 'o1', req: REQ, type: 'note', t: T0 + 900, level: null, on: ['q1'], text: O1, box: [98, 298, 352, 304],
    lay: { x: 1022, y: 280, w: 336, h: 37, lines: [O1], fs: 21, lh: 29 }, paths: [{ d: 'M358 301 Q690 300 1014 302', cls: 'leader', w: 1.3 }], hit: [1016, 276, 1358, 321] },
  { id: 'o2', req: REQ, type: 'note', t: T0 + 6000, level: null, on: ['k1'], text: O2, box: [98, 498, 602, 504],
    lay: { x: 1022, y: 486, w: 336, h: 66, lines: ['另一条旧批注写得长一些会排成', '两行的那种样子'], fs: 21, lh: 29 }, paths: [{ d: 'M608 501 Q810 500 1014 502', cls: 'leader', w: 1.3 }], hit: [1016, 482, 1358, 556] },
];
const DIR = join(T.DATA, 'notebooks', 'scratch');
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'page-0000.json'), JSON.stringify({ v: 1, strokes: [q1, k1], ai, reads: [], lastSent: T0 + 6000 }), 'utf8');
const LAY = JSON.stringify(ai.map((a) => a.lay));
await T.go();
if (await S('S.flow')) { await js('window.__ink.toggleFlow()'); await sleep(600); }
await sleep(500);
const note = (id) => js(`(() => { const a = window.__ink.S.page.ai.find((o) => o.id === ${JSON.stringify(id)}); if (!a) return null; const g = document.querySelector('#aiRoot > g[data-id="' + a.id + '"]');
  return Object.assign(JSON.parse(JSON.stringify(a)), { isDot: window.__ink.isDot(a), tb: a.lay ? window.__ink.noteTextBox(a) : null,
    texts: g ? [...g.querySelectorAll(':scope > text')].map((t) => { const r = t.getBoundingClientRect(); return { s: t.textContent, x: +t.getAttribute('x'), l: r.left, r: r.right, t: r.top, b: r.bottom }; }) : [] }); })()`);

// ================= 1. 原处显示、看得全
let n1 = await note('o1'), n2 = await note('o2');
const TW = await S('S.TW');
T.ok('两条旧批注都在原处（数据里的排版一点没动）', JSON.stringify([n1.lay, n2.lay]) === LAY, [n1.lay, n2.lay]);
T.ok('纸上的字就画在原来那个位置（x 1022），两条的每一行都画出来了', n1.texts.length === 1 && n2.texts.length === 2 && [...n1.texts, ...n2.texts].every((t) => t.x === 1022), [n1.texts, n2.texts]);
T.ok('整行看得全：字在纸上、在屏幕里', [...n1.texts, ...n2.texts].every((t) => t.l >= 0 && t.r <= 834 && t.t > 0 && t.b < 1194) && n1.tb[2] <= TW && n2.tb[2] <= TW, [n1.texts, n2.texts, TW]);
{ const c = await T.screenOf(1300, 630), r = await T.cdp('Page.captureScreenshot', { format: 'png' });
  const px = await js(`new Promise((res) => { const im = new Image(); im.onload = () => { const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const x = cv.getContext('2d'); x.drawImage(im, 0, 0);
    res(Array.from(x.getImageData(${Math.round(c[0])}, ${Math.round(c[1])}, 1, 1).data.slice(0, 3))); }; im.src = 'data:image/png;base64,${r.data}'; })`);
  T.ok('原来那一栏的地方没有米色底（白纸）', px.every((v) => v >= 252), px); }
const SHOT = join(T.OUT, '1-old-page.png');
{ const z = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 834, height: 1194, scale: 2 } }); writeFileSync(SHOT, Buffer.from(z.data, 'base64')); }

// ================= 2. 黑笔压到第一条：收成小蓝点，点在所指那句旁边
await T.pen(line(1030, 300, 120, 8));
n1 = await note('o1');
n2 = await note('o2');
T.ok('黑笔压到旧的第一条：它收成了小蓝点', n1.isDot && n1.dot.why === 'ink' && n1.texts.length === 0, n1);
T.ok('小蓝点在所指那句红笔问题的右端旁边（不在原来那一栏）', n1.isDot && n1.dot.at[0] > 352 && n1.dot.at[0] < 390 && Math.abs(n1.dot.at[1] - 301) < 6, n1.dot);
T.ok('它的排版（lay）照旧不动；另一条不受影响', JSON.stringify(n1.lay) === JSON.stringify(ai[0].lay) && !n2.isDot && n2.texts.length === 2, [n1.lay, n2.isDot]);

// ================= 3. 新来一条指着那句红笔：落在旁边，让开小蓝点，不压旧的、不压字
await T.saved();
await T.tap('#check');
const sub = await T.waitSub('S1', 80), meta = sub && T.metaOf(sub);
const g = meta && meta.groups.find((x) => x.red);
T.ok('（前提）交上去了', Boolean(g), meta && meta.groups);
await T.post('/bridge/reply', { sid: 'S1', submission: sub.id, items: [{ type: 'note', anchor: g.id, text: '新来的一条' }] });
await T.waitFor(`window.__ink.S.page.ai.length >= 3`, 10000);
await sleep(1500);
const n3 = await js(`(() => { const a = window.__ink.S.page.ai.find((o) => o.text === '新来的一条'); return a ? { lay: a.lay, dot: a.dot || null, tb: window.__ink.noteTextBox(a) } : null; })()`);
const SB = await S(`S.page.strokes.filter((s) => !s.erasedAt).map((s) => [Math.min(...s.pts.map((p) => p[0])) - s.w, Math.min(...s.pts.map((p) => p[1])) - s.w, Math.max(...s.pts.map((p) => p[0])) + s.w, Math.max(...s.pts.map((p) => p[1])) + s.w])`);
const dotB = [n1.dot.at[0] - 10, n1.dot.at[1] - 10, n1.dot.at[0] + 10, n1.dot.at[1] + 10];
T.ok('新的一条落在那句旁边（右边，让开了小蓝点），不压小蓝点、不压旧的那条、不压字', Boolean(n3) && !n3.dot && n3.tb[0] > dotB[2] && n3.tb[0] < 460 && !meets(n3.tb, dotB)
  && !meets(n3.tb, n2.tb) && SB.every((s) => !meets(n3.tb, s)), [n3, dotB, n2.tb]);
console.error('截图：\n' + SHOT);
T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

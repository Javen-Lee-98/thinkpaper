// 空白本子里图和公式也自己找空白（阶段 D1，《产品定义》第 3 节「能画」）：先看所指内容的右边，再看下面，不盖已有的字，
// 尽量不占用户接着往下写的地方；用户在图上圈画不会让图收起。书页上的放法不变（这里不查，见 reply_draw）。查：
// 1. 第 1 页：一句红笔问题，右边空着。Claude 回一个公式、一张图，都指着它：公式落在它的右边（上沿和它齐平）；
//    图在右边放不下（公式占了）就落在它下面。两样不压字、互不相压，都在纸上。
// 2. 在图上用黑笔写画：图不收起（没有变成小蓝点、照旧画着），那一笔照常留在纸上。
// 3. 第 2 页：先把那句右边写满，Claude 回一个公式：落在那句的下面，不压字。
// 4. 第 3 页：一句短的红笔问题，Claude 回一张图：落在它的右边。
// 只在无头 Edge 里跑过；笔是 pointerType 为 pen 的鼠标事件。
// 跑法：node tests/run_browser.mjs <临时目录> --only block_room；有一项不对退出码 1。
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'block-room', pages: 3 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const line = (x0, y, len, n = 10) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 2]);
const meets = (p, q) => p[0] < q[2] && p[2] > q[0] && p[1] < q[3] && p[3] > q[1];
const TEX = 'a^2 + b^2 = c^2';
const PNG = join(T.OUT, 'bars.png'); // 600 × 300：左半绿、右半白
spawnSync(PY, ['-c', 'import sys, pymupdf as fitz; pm = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 600, 300), 0); pm.clear_with(255); pm.set_rect(fitz.IRect(0, 0, 300, 300), (30, 160, 60)); pm.save(sys.argv[1])', PNG]);
async function landed(n) {
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
const items = () => S(`Object.fromEntries(S.page.ai.map((a) => [a.type, Object.assign(JSON.parse(JSON.stringify(a)), { drawn: Boolean(document.querySelector('#aiRoot > g[data-id="' + a.id + '"]')),
  dot: window.__ink.isDot(a) })]))`);
const strokeBoxes = () => S(`S.page.strokes.filter((s) => !s.erasedAt).map((s) => [Math.min(...s.pts.map((p) => p[0])) - s.w, Math.min(...s.pts.map((p) => p[1])) - s.w, Math.max(...s.pts.map((p) => p[0])) + s.w, Math.max(...s.pts.map((p) => p[1])) + s.w])`);
const paper = () => S('({ X0: S.X0, TW: S.TW })');
async function send() {
  await T.saved();
  await T.tap('#check');
  const sub = await T.waitSub('S1', 80), meta = sub && T.metaOf(sub);
  return { sub, meta };
}
const SHOTS = [];
const shot2 = async (file) => { const z = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 834, height: 1194, scale: 2 } });
  const f = join(T.OUT, file); writeFileSync(f, Buffer.from(z.data, 'base64')); SHOTS.push(f); return f; };
if (await S('S.flow')) { await js('window.__ink.toggleFlow()'); await sleep(600); }

// ================= 1. 第 1 页：公式落在右边，图落在下面
await T.tool('red');
await T.pen(line(100, 200, 250));
await T.tool('pen');
const s1 = await send();
const A = s1.meta && s1.meta.groups[0].bbox;
T.ok('（前提）交上去了：一句红笔问题', Boolean(A), s1.meta && s1.meta.groups);
await T.post('/bridge/reply', { sid: 'S1', submission: s1.sub.id, items: [{ type: 'formula', anchor: 'g1', tex: TEX }, { type: 'figure', anchor: 'g1', path: PNG, text: '一周的步数' }] });
T.ok('（前提）两样都落下、画完了', await landed(2));
await T.waitFor(`document.querySelector('#aiRoot image.fig') && document.querySelector('#aiRoot image.fig').getBBox().width > 0`, 5000);
let I = await items(), SB = await strokeBoxes(), P = await paper();
const fm = I.formula, fg = I.figure;
T.ok('公式落在那句的右边（和它在同一高度上）', Boolean(fm) && fm.hit[0] > A[2] && fm.hit[0] < A[2] + 60 && fm.hit[1] < A[3] && fm.hit[3] > A[1], [fm && fm.hit, A]);
T.ok('图（右边被公式占了）落在那句的下面，横向和它对得上', Boolean(fg) && fg.hit[1] > A[3] && fg.hit[1] < A[3] + 120 && fg.hit[0] < A[2] && fg.hit[2] > A[0], [fg && fg.hit, A]);
T.ok('两样都不压字、互不相压、都在纸上', [fm, fg].every((b) => SB.every((s) => !meets(b.hit, s)) && b.hit[0] >= P.X0 && b.hit[2] <= P.TW) && !meets(fm.hit, fg.hit), [fm.hit, fg.hit, SB, P]);
await shot2('1-formula-right-figure-below.png');

// ================= 2. 在图上写画：图不收起
await T.pen(line(fg.fig.x + 20, fg.fig.y + fg.fig.h / 2, fg.fig.w - 40));
await T.pen([[fg.fig.x + 60, fg.fig.y + 30], [fg.fig.x + 120, fg.fig.y + 90], [fg.fig.x + 60, fg.fig.y + 150], [fg.fig.x + 20, fg.fig.y + 90], [fg.fig.x + 60, fg.fig.y + 30]]);
I = await items();
T.ok('在图上写画：图不收起（没有变成小蓝点，照旧画着、位置不变），两笔都留在纸上', Boolean(I.figure) && !I.figure.dot && !I.figure.dot && I.figure.drawn && JSON.stringify(I.figure.fig) === JSON.stringify(fg.fig)
  && (await strokeBoxes()).length === 3 && (await T.count('#aiRoot image.fig')) === 1, [I.figure && I.figure.fig, fg.fig]);
T.ok('公式也照旧', Boolean(I.formula) && I.formula.drawn && !I.formula.dot && (await T.count('#tex .tx')) === 1);
await T.tap('#toolsUndo');
await T.tap('#toolsUndo'); // 撤掉这两笔：下面翻到第 2 页交的时候只交那一页
T.ok('（前提）撤掉了写在图上的两笔', (await strokeBoxes()).length === 1);

// ================= 3. 第 2 页：右边写满了，公式落在下面
await T.openPage(1);
for (const y of [160, 185, 210, 235, 260]) await T.pen(line(390, y, 980, 8));
await sleep(2000);
await T.tool('red');
await T.pen(line(100, 210, 250));
await T.tool('pen');
const s3 = await send();
const red3 = s3.meta && s3.meta.groups.find((g) => g.red), A3 = red3 && red3.bbox;
T.ok('（前提）第 2 页交上去了', Boolean(A3), s3.meta && s3.meta.groups);
await T.post('/bridge/reply', { sid: 'S1', submission: s3.sub.id, items: [{ type: 'formula', anchor: red3.id, tex: TEX }] });
T.ok('（前提）落下了', await landed(1));
I = await items();
SB = await strokeBoxes();
T.ok('右边写满了：公式落在那句的下面，不压字', Boolean(I.formula) && I.formula.hit[1] > A3[3] && I.formula.hit[0] < A3[2] && SB.every((s) => !meets(I.formula.hit, s)), [I.formula && I.formula.hit, A3]);

// ================= 4. 第 3 页：图落在右边
await T.openPage(2);
await T.tool('red');
await T.pen(line(100, 300, 200));
await T.tool('pen');
const s4 = await send();
const A4 = s4.meta && s4.meta.groups[0].bbox;
await T.post('/bridge/reply', { sid: 'S1', submission: s4.sub.id, items: [{ type: 'figure', anchor: 'g1', path: PNG, text: '一周的步数' }] });
T.ok('（前提）落下了', await landed(1));
await T.waitFor(`document.querySelector('#aiRoot image.fig') && document.querySelector('#aiRoot image.fig').getBBox().width > 0`, 5000);
I = await items();
SB = await strokeBoxes();
P = await paper();
T.ok('图落在那句的右边（上沿和它齐平），不压字、在纸上', Boolean(I.figure) && I.figure.hit[0] > A4[2] && I.figure.hit[0] < A4[2] + 60 && Math.abs(I.figure.fig.y - A4[1]) < 12
  && SB.every((s) => !meets(I.figure.hit, s)) && I.figure.hit[2] <= P.TW, [I.figure && I.figure.hit, A4, P]);
await shot2('2-figure-right.png');

console.error('截图：\n' + SHOTS.join('\n'));
T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

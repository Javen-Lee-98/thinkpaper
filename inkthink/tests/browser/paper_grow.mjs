// 空白本子的纸跟着字长：连续阅读时快写到页底，纸自己往下长；把纸挪开或缩小后，在纸外面（右、左、上、最后一页的下面）落笔，
// 纸往那边长到把这一笔包进来；视图不动（下一笔不落偏），长出来的大小存到电脑上，刷新后还在，照样能交。贴着纸边写不会把纸加宽。
// 跑法：node tests/browser/paper_grow.mjs [临时目录]；有一项不对退出码 1。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from '../browser_lib.mjs';

const T = await boot({ name: 'paper-grow' });
const js = T.evalJS;
// 纸现在多大、视图在哪、写了几笔
const geo = () => js(`(() => { const S = window.__ink.S, p = S.page; return { X0: S.X0, Y0: S.Y0, TW: S.TW, W: S.W, pageH: S.pageH, h: p.h || 0, xw: p.xw || 0, ox: p.ox || 0, oy: p.oy || 0,
  view: [Math.round(S.view.s * 1000), Math.round(S.view.tx), Math.round(S.view.ty)], n: p.strokes.filter((s) => !s.erasedAt).length, flow: S.flow, kind: S.nb.kind, fit: S.fitMode }; })()`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inView = (p) => p[0] > 4 && p[0] < 830 && p[1] > 64 && p[1] < 1120; // 落笔点在屏幕里，也不压着左上角的本子名和右下角那一条
const pen = (pts) => T.pen(pts, 350);

// 1. 连续阅读（打开时的样子）：快写到页底，纸自己往下长；视图不动，这一笔留着
const g0 = await geo();
T.ok('草稿本、连续阅读', g0.kind === 'scratch' && g0.flow === true, g0);
await pen(T.line(120, 200, 300));
let g = await geo();
T.ok('在纸中间写：纸不变', g.pageH === g0.pageH && g.xw === 0 && g.ox === 0 && g.oy === 0 && g.n === 1, g);
const nearBottom = g.pageH - 100;
const nb = await T.screenOf(420, nearBottom); // 这一笔在屏幕左下，不压着右下角那一条
T.ok('页底那一段在屏幕里', nb[0] < 500 && nb[1] > 64 && nb[1] < 1190, nb);
await pen(T.line(120, nearBottom, 300));
g = await geo();
T.ok('快写到页底：纸往下长了', g.pageH >= g0.pageH + 500 && g.h === g.pageH && g.n === 2, { before: g0.pageH, after: g.pageH, h: g.h, n: g.n });
T.ok('视图没动', same(g.view, g0.view), [g0.view, g.view]);

// 2. 贴着右边写（平时纸边就是屏幕边）：不加宽，页边还在原处
await pen(T.line(g.TW - 300, 320, 296));
let g1 = await geo();
T.ok('贴着纸的右边写：不加宽', g1.xw === 0 && g1.TW === g.TW && g1.n === 3, g1);

// 3. 把纸缩小、挪开，四周露出纸外面的灰底（缩放是真的滚轮；挪到哪儿是直接摆的，为了后面每一笔都落在屏幕里）
const c = await js(`(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return [r.left + r.width / 2, r.top + 400]; })()`);
await T.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c[0], y: c[1], deltaX: 0, deltaY: 60, modifiers: 2 }); // ctrl + 滚轮：自己缩放过，不再是「适配宽度」
await T.sleep(500);
const zoomed = await geo();
await js(`(() => { const S = window.__ink.S; S.view = { s: S.fitS * 0.4, tx: 260, ty: 330 }; window.dispatchEvent(new Event('resize')); return 1; })()`);
await T.sleep(600);
g = await geo();
T.ok('缩小后不再是适配宽度', zoomed.fit === null && zoomed.view[0] < g0.view[0] && g.fit === null, [g0.view, zoomed.view, zoomed.fit, g.fit]);
await T.shot('1-small.png');

// 4. 写在纸的右边外面：纸往右长到把这一笔包进来；视图不动；这一笔留着
const v0 = g.view;
T.ok('右边外面那块在屏幕里', inView(await T.screenOf(g.TW + 80, 400)) && inView(await T.screenOf(g.TW + 280, 400)), await T.screenOf(g.TW + 280, 400));
await pen(T.line(g.TW + 80, 400, 200));
g1 = await geo();
T.ok('写在右边外面：纸往右长了，把这一笔包进来', g1.xw >= 400 && g1.TW - 60 >= g.TW + 280 && g1.n === g.n + 1, { before: g.TW, after: g1.TW, xw: g1.xw, n: g1.n });
T.ok('视图没动（右）', same(g1.view, v0), [v0, g1.view]);

// 5. 写在左边外面
g = g1;
T.ok('左边外面那块在屏幕里', inView(await T.screenOf(g.X0 - 400, 500)) && inView(await T.screenOf(g.X0 - 100, 500)), await T.screenOf(g.X0 - 400, 500));
await pen(T.line(g.X0 - 400, 500, 300));
g1 = await geo();
T.ok('写在左边外面：纸往左长了', g1.ox >= 400 && g1.X0 + 60 <= g.X0 - 400 && g1.n === g.n + 1, { before: g.X0, after: g1.X0, ox: g1.ox, n: g1.n });
T.ok('视图没动（左）', same(g1.view, v0), [v0, g1.view]);

// 6. 写在第一页的上面
g = g1;
T.ok('上面外面那块在屏幕里', inView(await T.screenOf(300, g.Y0 - 300)), await T.screenOf(300, g.Y0 - 300));
await pen(T.line(300, g.Y0 - 300, 300));
g1 = await geo();
T.ok('写在第一页上面：纸往上长了', g1.oy >= 500 && g1.Y0 + 60 <= g.Y0 - 300 && g1.n === g.n + 1, { before: g.Y0, after: g1.Y0, oy: g1.oy, n: g1.n });
T.ok('视图没动（上）', same(g1.view, v0), [v0, g1.view]);

// 7. 写在最后一页的下面
g = g1;
T.ok('下面外面那块在屏幕里', inView(await T.screenOf(100, g.pageH + 200)), [await T.screenOf(100, g.pageH + 200), g.pageH]);
await pen(T.line(100, g.pageH + 200, 300));
g1 = await geo();
T.ok('写在最后一页下面：纸往下长了，把这一笔包进来', g1.pageH >= g.pageH + 200 + 60 && g1.n === g.n + 1, { before: g.pageH, after: g1.pageH, n: g1.n });
T.ok('视图没动（下）', same(g1.view, v0), [v0, g1.view]);
await T.shot('2-grown.png');

// 8. 自己存到电脑上了；刷新后纸还是这么大，笔迹都在纸里面
T.ok('写完自己存上了', await T.saved(), await js(`({ dirty: window.__ink.S.dirty, saving: window.__ink.S.saving })`));
const sv = T.pageFile('scratch', 0);
T.ok('电脑上的页面文件里存下了长出来的大小', Boolean(sv) && sv.xw === g1.xw && sv.ox === g1.ox && sv.oy === g1.oy && sv.h >= g1.pageH - 1 && sv.strokes.length === g1.n && g1.n === 7,
  sv && { xw: sv.xw, ox: sv.ox, oy: sv.oy, h: sv.h, n: sv.strokes.length });
await T.go();
g = await geo();
const inside = await js(`(() => { const S = window.__ink.S; return S.page.strokes.every((s) => s.pts.every((p) => p[0] >= S.X0 && p[0] <= S.TW && p[1] >= S.Y0 && p[1] <= S.pageH)); })()`);
T.ok('刷新后纸还是这么大，每一笔都在纸里面', g.xw === g1.xw && g.ox === g1.ox && g.oy === g1.oy && g.pageH >= g1.pageH - 1 && g.n === g1.n && inside, g);

// 9. 照样能交
await T.tap('#check');
const sub = await T.waitSub('S1');
const subDir = sub ? join(T.DATA, 'submissions', sub.id) : '';
T.ok('长过的页照样能交上去：消息里列着这一页的图（crop.jpg），电脑上有这张；不再另存整页概览（overview.jpg）', Boolean(sub && sub.id) && sub.text.startsWith('【草稿纸】')
  && sub.text.includes(join('submissions', sub.id, 'crop.jpg')) && existsSync(join(subDir, 'crop.jpg')) && !existsSync(join(subDir, 'overview.jpg')), sub && sub.text.slice(0, 60));

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

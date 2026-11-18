// 空白本子到处看起来都是纸（阶段 D1，《产品定义》第 2 节「空白本子的纸跟着字长」）：去掉纸边和灰底，不再画右边那一栏；
// 纸照样跟着字长（数据不变，只是看不出边）。连续模式下页与页之间只画一条淡虚线，线的左端写小页码。书页、推送页照旧。查：
// 1. 草稿本（单页、适配宽度、全屏）：屏幕四角都是纸的白色；原来右边那一栏的地方是白的（不是米色），原来那条分隔线没了。
// 2. 把纸缩小、挪开：纸外面也是白纸带点阵（没有灰底），纸边没有阴影；在纸外面写，纸照样往那边长。
// 3. 连续模式：第 1、2 页之间是一条虚线（一段段的），线的左端有小页码，上下都是白纸（没有灰缝）。
// 4. 书页（导入的 PDF）：缩小后纸外面照旧是灰底；平时没有页边那一栏，Claude 写了批注才在右边开一栏（米色）；连续模式下页缝照旧是灰的。
// 5. 推送页（「Claude 推送」那本）：缩小后纸外面照旧是灰底。
// 只在无头 Edge 里跑过；颜色是从页面截图里取的。
// 跑法：node tests/run_browser.mjs <临时目录> --only paper_blank；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'paper-blank', pages: 2 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const line = (x0, y, len, n = 10) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 2]);
const WHITE = (c) => c[0] >= 252 && c[1] >= 252 && c[2] >= 252;
const GRAY = (c) => Math.abs(c[0] - 232) <= 3 && Math.abs(c[1] - 229) <= 3 && Math.abs(c[2] - 223) <= 3; // #e8e5df：纸外面的灰底
const CREAM = (c) => Math.abs(c[0] - 250) <= 2 && Math.abs(c[1] - 248) <= 2 && Math.abs(c[2] - 243) <= 2; // #faf8f3：页边那一栏
// 截一张屏（1 倍），取几处的颜色：pts 是屏幕上的点；rows：[y, x0, x1] 一行里每个点的颜色
async function colors(pts, rows = []) {
  const r = await T.cdp('Page.captureScreenshot', { format: 'png' });
  return js(`new Promise((res) => { const im = new Image(); im.onload = () => { const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const x = cv.getContext('2d'); x.drawImage(im, 0, 0);
    const at = (X, Y) => Array.from(x.getImageData(Math.round(X), Math.round(Y), 1, 1).data.slice(0, 3));
    res({ pts: ${JSON.stringify(pts)}.map((p) => at(p[0], p[1])), rows: ${JSON.stringify(rows)}.map(([y, x0, x1]) => { const out = []; for (let X = x0; X <= x1; X++) out.push(at(X, y)); return out; }) }); };
    im.src = 'data:image/png;base64,${r.data}'; })`);
}
const SHOTS = [];
const shot2 = async (file) => { const z = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 834, height: 1194, scale: 2 } });
  const f = join(T.OUT, file); writeFileSync(f, Buffer.from(z.data, 'base64')); SHOTS.push(f); return f; };
const geo = () => S('({ X0: S.X0, Y0: S.Y0, W: S.W, TW: S.TW, M: S.M, pageH: S.pageH, ox: S.page.ox || 0, s: S.view.s, fitS: S.fitS })');
const setView = async (k, tx, ty) => { await js(`(() => { const S = window.__ink.S; S.fitMode = null; S.view = { s: S.fitS * ${k}, tx: ${tx}, ty: ${ty} }; window.dispatchEvent(new Event('resize')); return 1; })()`); await sleep(400); };
const refit = async () => { await js(`(() => { window.__ink.S.fitMode = 'width'; window.dispatchEvent(new Event('resize')); return 1; })()`); await sleep(400); };

// ================= 1. 草稿本：单页、适配宽度、全屏
if (await S('S.flow')) { await js('window.__ink.toggleFlow()'); await sleep(600); }
T.ok('（前提）草稿本、全屏、单页', (await S('S.nb.kind')) === 'scratch' && (await S('S.collapsed')) && !(await S('S.flow')));
await T.pen(line(100, 300, 500));
await T.pen(line(100, 380, 400));
let g = await geo();
const sc = async (x, y) => T.screenOf(x, y);
// 原来右边那一栏的里面（避开点阵：点在 40 的倍数上），原来的分隔线 x = W（这一列上每隔一点取一个，不取点阵那几行）
const marg = [await sc(1110, 610), await sc(1030, 310), await sc(1250, 990)];
const sepX = (await sc(g.W, 0))[0], sepRows = [];
for (const y of [330, 470, 650, 850, 1050]) sepRows.push([(await sc(0, y))[1], Math.round(sepX) - 2, Math.round(sepX) + 2]);
let C = await colors([[2, 2], [831, 2], [2, 1191], [831, 1191], ...marg], sepRows);
T.ok('屏幕四角都是纸的白色（没有纸外面的灰底）', C.pts.slice(0, 4).every(WHITE), C.pts.slice(0, 4));
T.ok('原来右边那一栏的地方是白纸（不是米色的一栏）', C.pts.slice(4).every(WHITE) && !C.pts.slice(4).some(CREAM), C.pts.slice(4));
T.ok('原来那一栏左边的分隔线没了（那一竖列是白的）', C.rows.every((r) => r.every(WHITE)), C.rows);
T.ok('纸的数据照旧：宽度、页边宽度都没变（只是不画成一栏）', g.W === 1000 && g.M === 380 && g.TW === 1380, g);
await shot2('1-blank-fullscreen.png');

// ================= 2. 缩小、挪开：纸外面也是白纸带点阵，没有灰底、没有阴影；写在外面纸照样长
await setView(0.5, 300, 260);
g = await geo();
const left = (await sc(g.X0, 0))[0], top = (await sc(0, g.Y0))[1];
T.ok('（前提）纸缩小了，左边和上面露出了纸外面', left > 200 && top > 200, [left, top]);
const out = [[left - 150, top + 300], [left - 3, top + 300], [left + 300, top - 3], [left - 100, top - 100]];
const strip = [];
for (let y = Math.round(top + 100); y < top + 260; y += 1) strip.push([y, Math.round(left - 160), Math.round(left - 40)]);
C = await colors(out, strip);
T.ok('纸外面是白的（不是灰底），纸边外面紧挨着的地方也是白的（没有阴影、没有边线）', C.pts.every(WHITE), C.pts);
const dots = C.rows.flat().filter((c) => !WHITE(c) && c[0] > c[2]).length; // 点阵的点（缩小后不到一个像素，颜色淡、偏暖）
T.ok('纸外面也有点阵（看起来到处都是纸）', dots >= 6, dots);
await shot2('2-blank-zoomed-out.png');
const ox0 = g.ox;
await T.pen(line(g.X0 - 300, 500, 200));
g = await geo();
T.ok('写在纸的左边外面：纸照样往左长了', g.ox > ox0 && g.X0 < -300, g);
await refit();

// ================= 3. 连续模式：页与页之间只有一条淡虚线，左端写小页码
await js('window.__ink.toggleFlow()');
await sleep(900);
await T.waitFor('window.__ink.flowStrip().length >= 1', 5000);
g = await geo();
const gapY = g.pageH + 20; // FLOW_GAP = 40，线在页缝正中
const [, ly] = await sc(0, gapY);
T.ok('（前提）连续模式，第 2 页接在下面，页缝在屏幕里', (await S('S.flow')) && ly > 100 && ly < 1100, ly);
C = await colors([], [[Math.round(ly), 150, 800], [Math.round(ly) - 7, 100, 800], [Math.round(ly) + 7, 100, 800], [Math.round(ly) - 4, 2, 70], [Math.round(ly), 2, 70], [Math.round(ly) + 3, 2, 70]]);
const on = C.rows[0].map((c) => !WHITE(c));
let flips = 0;
for (let i = 1; i < on.length; i++) if (on[i] !== on[i - 1]) flips++;
T.ok('页缝正中是一条虚线（一段一段的，颜色淡）', flips >= 20 && C.rows[0].filter((c) => !WHITE(c)).every((c) => c[0] > 180), [flips, C.rows[0].filter((c) => !WHITE(c)).slice(0, 4)]);
T.ok('页缝里线的上下都是白纸（没有灰色的缝）', [C.rows[1], C.rows[2]].every((r) => r.filter(GRAY).length === 0 && r.filter(WHITE).length > r.length - 25), [C.rows[1].filter((c) => !WHITE(c)).length, C.rows[2].filter((c) => !WHITE(c)).length]);
T.ok('线的左端有小页码（那里有字）', C.rows.slice(3).flat().filter((c) => c[0] < 200).length >= 3, C.rows.slice(3).map((r) => r.filter((c) => c[0] < 200).length));
{ const [x0, y0] = [0, Math.max(0, ly - 200)]; const z = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: x0, y: y0, width: 834, height: 400, scale: 2 } });
  const f = join(T.OUT, '3-blank-flow-gap.png'); writeFileSync(f, Buffer.from(z.data, 'base64')); SHOTS.push(f); }
await js('window.__ink.toggleFlow()');
await sleep(600);

// ================= 4. 书页：纸外面照旧是灰底；平时不留栏，有批注才开；连续模式页缝照旧
const SRC = join(T.ROOT, 'src'), PDF = join(SRC, 'trip.pdf'), PNG = join(SRC, 'map.png');
mkdirSync(SRC, { recursive: true });
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
doc=fitz.open()
for t in ('Trip plan: train at 9', 'Lunch at noon'):
    p=doc.new_page(width=1000,height=1300)
    p.insert_text((60,120),t,fontsize=34)
doc.save(sys.argv[1])
d=fitz.open(); q=d.new_page(width=800,height=600)
q.draw_rect(fitz.Rect(0,0,200,200),color=None,fill=(0,0.6,0)); q.insert_text((300,400),'map',fontsize=40)
q.get_pixmap(alpha=False).save(sys.argv[2])`, PDF, PNG]);
const imp = await T.post('/bridge/import', { sid: 'S1', path: PDF });
await T.openNotebook(imp.id, 0);
if (await S('S.flow')) { await js('window.__ink.toggleFlow()'); await sleep(600); }
g = await geo();
T.ok('（前提）书页、单页；平时没有页边那一栏', (await S('S.nb.kind')) === 'book' && (await S('Boolean(S.bgImg)')) && g.M === 0, g);
await setView(0.5, 300, 260);
g = await geo();
const bl = (await sc(g.X0, 0))[0], bt = (await sc(0, g.Y0))[1];
C = await colors([[bl - 150, bt + 300], [bl - 100, bt - 100], [2, 1191]]);
T.ok('书页：纸外面照旧是灰底', C.pts.every(GRAY), C.pts);
await shot2('4-book-zoomed-out.png');
await refit();
await T.tool('red');
await T.pen(line(60, 140, 300));
await T.tool('pen');
await T.saved();
await T.tap('#check');
const sub = await T.waitSub('S1', 80);
await T.post('/bridge/reply', { sid: 'S1', submission: sub.id, items: [{ type: 'note', anchor: 'g1', text: '九点的车要提前到' }] });
await T.waitFor('window.__ink.S.page.ai.length >= 1', 10000);
await sleep(1500);
g = await geo();
const cm = await sc(g.W + 300, 610);
C = await colors([cm]);
T.ok('书页：Claude 写了批注，右边开出一栏（米色），批注在栏里', g.M === 380 && CREAM(C.pts[0]) && (await S('S.page.ai[0].lay.x')) > g.W, [g.M, C.pts[0]]);
await T.waitFor(`document.querySelector('#toast').hidden`, 6000);
await shot2('5-book-page.png');
await js('window.__ink.toggleFlow()');
await sleep(900);
await T.waitFor('window.__ink.flowStrip().length >= 1', 5000);
g = await geo();
const [, by] = await sc(0, g.pageH + 20);
C = await colors([[200, by], [600, by]]);
T.ok('书页连续模式：页缝照旧是灰的', (await S('S.flow')) && C.pts.every(GRAY), [by, C.pts]);
await js('window.__ink.toggleFlow()');
await sleep(600);

// ================= 5. 推送页：纸外面照旧是灰底
const shown5 = await T.post('/bridge/show', { sid: 'S1', path: PNG, title: '路线图' }); // 进这个对话所在文件夹的推送本子（2026-11-17）
await T.openNotebook(shown5.nb, 0);
await T.waitFor('window.__ink.S.bgImg', 8000);
await setView(0.5, 300, 260);
g = await geo();
const pl = (await sc(g.X0, 0))[0], pt = (await sc(0, g.Y0))[1];
C = await colors([[pl - 150, pt + 300], [pl - 100, pt - 100]]);
T.ok('推送页：纸外面照旧是灰底', (await S('S.nb.kind')) === 'board' && C.pts.every(GRAY), C.pts);

console.error('截图：\n' + SHOTS.join('\n'));
T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

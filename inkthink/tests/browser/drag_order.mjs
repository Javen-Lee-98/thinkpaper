// 拖动改抽屉里文件夹和本子的上下顺序（2026-11-18 用户定，《产品定义》第 2 节「抽屉里再补两样小的」）。和「把本子拖进文件夹」是同一个动作：
// 按住约半秒抓起；拖到两行之间出现一条插入线（排在外面的整行宽，排在文件夹里的缩进 22、和里面的本子对齐），松手就排到那里；
// 文件夹那一行上面四分之一是排到它上面、中间一半照旧是放进去（白底加粗边框，没有插入线）、下面四分之一是排到文件夹里第一本上面（展开着、
// 里面有本子时）；本子那一行上半截、下半截是排到它上面、下面；文件夹里最后一本的下半截是排在文件夹里最后（缩进的线），下一行的上半截是排在
// 文件夹外面（整行宽的线）。文件夹也能抓起来换上下顺序（里面的本子跟着变淡，指着别的文件夹不会放进去）；文件夹里的本子在文件夹里换顺序；
// 本子从文件夹里排到外面时整个列表再画一圈虚线。草稿本照旧在最上面：指着它是排到它下面。放下去不会变的不画线、松手什么都不改。
// 放下后屏幕上方一句（「已调整顺序」「已放进「…」」「已移出文件夹」），带「撤销」：回到抓起时的那一层、那个位置。
// 顺序记在电脑上（notebooks/folders.json 的 top、文件夹的 items 加 ordered），刷新后还在；排回原来的样子时不记。
// 只在无头 Edge 里用合成的触点（手指）试过；iPad 上手指、笔真的拖起来顺不顺手，这里测不到。
// 跑法：node tests/run_browser.mjs <临时目录> --only drag_order；有一项不对退出码 1。截图存在 <临时目录>/drag-order/out/ 下。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from '../browser_lib.mjs';

const T = await boot({ name: 'drag-order', open: false });
const js = T.evalJS, FILE = join(T.DATA, 'notebooks', 'folders.json');
const mk = async (title) => (await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title }) })).id;
const P1 = await mk('随笔'), P2 = await mk('想法'), P3 = await mk('读书笔记'), P4 = await mk('草图');
const folder = async (name, nb) => (await T.apiJson('/api/folders/new', { method: 'POST', body: JSON.stringify(nb ? { name, nb } : { name }) })).id;
const F1 = await folder('课题', P2), F2 = await folder('旧的');
await T.go();

// ---- 小工具
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) await T.tap('#nbChip', 600); };
const rowSel = (nb) => `#nbList .nb-item[data-nb=${JSON.stringify(nb)}]`;
const folderSel = (fid) => `#nbList .nf-item[data-fid=${JSON.stringify(fid)}]`;
const saved = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { folders: [] });
// 抽屉里从上到下：文件夹写「[名字]」，文件夹里的本子前面带「· 」
const list = () => js(`[...document.querySelectorAll('#nbList > *')].filter((r) => !r.hidden).map((r) => r.classList.contains('nf-item')
  ? '[' + r.querySelector('.nf-name').textContent + ']' : (r.classList.contains('nested') ? '· ' : '') + r.querySelector('.nb-name').textContent)`);
// 一行的位置：拿它左边一点（名字上）当手指的横坐标，避开右边的按钮
const geo = async (sel) => {
  const g = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect();
    return { l: r.left, t: r.top, b: r.bottom, h: r.height }; })()`);
  if (!g) throw new Error('页面上没有 ' + sel);
  return g;
};
const pt = (g, f) => [g.l + 80, g.t + g.h * f];
const touch = (type, x, y) => T.cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 4, radiusX: 8, radiusY: 8, force: 0.5 }] });
let finger = null;
async function grab(p) { finger = p; await touch('touchStart', p[0], p[1]); await T.sleep(700); }
async function slide(to, steps = 12) {
  const from = finger;
  for (let k = 1; k <= steps; k++) { await touch('touchMove', from[0] + ((to[0] - from[0]) * k) / steps, from[1] + ((to[1] - from[1]) * k) / steps); await T.sleep(16); }
  finger = to;
  await T.sleep(120);
}
async function release() { await touch('touchEnd'); finger = null; await T.sleep(900); }
const state = () => js(`(() => { const l = document.querySelector('#nbDropLine'), lr = document.querySelector('#nbList').getBoundingClientRect();
  let line = null;
  if (l && !l.hidden) { const r = l.getBoundingClientRect(); line = { indent: Math.round(r.left - lr.left), w: Math.round(r.width), lw: Math.round(lr.width), y: r.top + r.height / 2, color: getComputedStyle(l).backgroundColor }; }
  return { line, drop: [...document.querySelectorAll('#nbList .nf-item.drop')].map((e) => e.dataset.fid), out: document.querySelector('#nbList').classList.contains('drop-out'),
    lifted: [...document.querySelectorAll('#nbList .lifted')].map((e) => e.dataset.nb || e.dataset.fid), carried: [...document.querySelectorAll('#nbList .carried')].map((e) => e.dataset.nb),
    ghost: [...document.querySelectorAll('.drag-ghost')].map((g) => g.textContent), nb: window.__ink.S.nb.id }; })()`);
const toastNow = () => js(`(() => { const t = document.querySelector('#toast'); if (t.hidden) return null;
  return { text: t.firstChild ? t.firstChild.textContent : '', btn: (t.querySelector('button') || {}).textContent || '' }; })()`);
const near = (a, b) => Math.abs(a - b) <= 3;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NATURAL = ['草稿本', '[课题]', '· 想法', '[旧的]', '随笔', '读书笔记', '草图'];

await drawer(true);
await T.sleep(300);
T.ok('准备：没排过时照原来的顺序（文件夹在前，接着是本子）；电脑上没记 top', same(await list(), NATURAL) && !('top' in saved()), [await list(), saved()]);

// 1. 「草图」拖到「课题」那一行的上面四分之一：整行宽的插入线画在「课题」上沿，没有文件夹高亮；松手排到「课题」上面
let g = await geo(rowSel(P4));
await grab(pt(g, 0.5));
let s = await state();
T.ok('按住约半秒抓起「草图」', same(s.lifted, [P4]) && same(s.ghost, ['草图']), s);
let gf = await geo(folderSel(F1));
await slide(pt(gf, 0.12));
s = await state();
T.ok('指着「课题」那一行上面四分之一：一条整行宽的插入线在它上沿，「课题」不高亮，列表不画虚线',
  Boolean(s.line) && s.line.indent === 0 && s.line.w === s.line.lw && near(s.line.y, gf.t - 2) && s.drop.length === 0 && !s.out, [s, gf]);
T.ok('插入线是界面上的深色（不是 Claude 的蓝色）', s.line && s.line.color === 'rgb(34, 34, 34)', s.line);
await T.shot('1-insert-line.png');
await release();
let t = await toastNow();
T.ok('松手：「草图」排到了「课题」上面（草稿本照旧最上面），抽屉没打开那本', same(await list(), ['草稿本', '草图', '[课题]', '· 想法', '[旧的]', '随笔', '读书笔记']) && (await state()).nb === 'scratch', await list());
T.ok('电脑上记下了最外层的顺序（文件夹的 id 和本子混排）', same(saved().top, [P4, F1, F2, P1, P3]), saved());
T.ok('屏幕上方一句「已调整顺序」，带「撤销」', t && t.text === '已调整顺序' && t.btn === '撤销', t);
await T.tap('#toast button', 900);
t = await toastNow();
T.ok('点「撤销」：回到原来的顺序，说「已挪回原处」；和原来一样了，电脑上不再记 top', same(await list(), NATURAL) && t && t.text === '已挪回原处' && !('top' in saved()), [await list(), t, saved()]);

// 2. 「随笔」拖到「课题」那一行中间：照旧是放进去（高亮、没有插入线）；再往下到下面四分之一：缩进的插入线（排到文件夹里第一本上面）
g = await geo(rowSel(P1));
await grab(pt(g, 0.5));
gf = await geo(folderSel(F1));
await slide(pt(gf, 0.5));
s = await state();
T.ok('指着「课题」那一行中间：「课题」白底加粗边框（放进去），没有插入线', same(s.drop, [F1]) && !s.line, s);
await slide(pt(gf, 0.88));
s = await state();
T.ok('指着「课题」那一行下面四分之一（展开着、里面有本子）：缩进 22 的插入线在「课题」下沿，「课题」不高亮',
  Boolean(s.line) && s.line.indent === 22 && near(s.line.y, gf.b + 2) && s.drop.length === 0, [s, gf]);
await release();
t = await toastNow();
T.ok('松手：「随笔」放进了「课题」、排在第一本，提示「已放进「课题」」', same(await list(), ['草稿本', '[课题]', '· 随笔', '· 想法', '[旧的]', '读书笔记', '草图'])
  && t && t.text === '已放进「课题」' && t.btn === '撤销', [await list(), t]);
T.ok('电脑上：课题里是随笔、想法（和原来的先后一样，不记 ordered）', same(saved().folders[0].items, [P1, P2]) && !saved().folders[0].ordered, saved());

// 3. 文件夹里换顺序：「· 随笔」拖到「· 想法」的下半截：缩进的插入线；松手后课题里是想法、随笔，记下 ordered
g = await geo(rowSel(P1));
await grab(pt(g, 0.5));
const g2 = await geo(rowSel(P2));
await slide(pt(g2, 0.75));
s = await state();
T.ok('「随笔」指着「想法」的下半截：缩进的插入线在「想法」下沿', Boolean(s.line) && s.line.indent === 22 && near(s.line.y, g2.b + 2) && !s.out, [s, g2]);
await T.shot('1b-insert-line-in-folder.png');
await release();
t = await toastNow();
T.ok('松手：文件夹里换了先后（想法、随笔），提示「已调整顺序」', same(await list(), ['草稿本', '[课题]', '· 想法', '· 随笔', '[旧的]', '读书笔记', '草图']) && t && t.text === '已调整顺序', [await list(), t]);
T.ok('电脑上记下了文件夹里的先后（ordered）', same(saved().folders[0].items, [P2, P1]) && saved().folders[0].ordered === true, saved());

// 4. 文件夹抓起来换上下顺序：按住「课题」那一行；里面的本子跟着变淡；指着「旧的」中间不会放进去（画线）；拖到「读书笔记」下半截松手
gf = await geo(folderSel(F1));
await grab(pt(gf, 0.5));
s = await state();
T.ok('按住「课题」那一行约半秒：文件夹抓起来了（影子写着「课题」），里面两本跟着变淡', same(s.lifted, [F1]) && same(s.ghost, ['课题']) && same(s.carried.sort(), [P1, P2].sort()), s);
const gOld = await geo(folderSel(F2));
await slide(pt(gOld, 0.5));
s = await state();
T.ok('拖着文件夹指着「旧的」中间：不会放进去（不高亮），画的是插入线', s.drop.length === 0 && Boolean(s.line) && s.line.indent === 0, s);
const g3 = await geo(rowSel(P3));
await slide(pt(g3, 0.75));
s = await state();
T.ok('指着「读书笔记」下半截：整行宽的插入线在它下沿', Boolean(s.line) && s.line.indent === 0 && near(s.line.y, g3.b + 2), [s, g3]);
await T.shot('2-drag-folder.png');
await release();
t = await toastNow();
T.ok('松手：「课题」连同里面的本子排到了「读书笔记」下面', same(await list(), ['草稿本', '[旧的]', '读书笔记', '[课题]', '· 想法', '· 随笔', '草图']) && t && t.text === '已调整顺序', [await list(), t]);
T.ok('抓起后的松手不算点击：「课题」没有被折起来', (await js(`document.querySelector(${JSON.stringify(folderSel(F1))}).getAttribute('aria-expanded')`)) === 'true');
T.ok('电脑上：最外层是 旧的、读书笔记、课题、草图', same(saved().top, [F2, P3, F1, P4]), saved());

// 5. 文件夹里的本子排到外面：「· 随笔」拖到「草图」上半截：整行宽的线，整个列表画一圈虚线；松手移出文件夹；「撤销」放回文件夹里原来的位置
g = await geo(rowSel(P1));
await grab(pt(g, 0.5));
const g4 = await geo(rowSel(P4));
await slide(pt(g4, 0.25));
s = await state();
T.ok('「随笔」指着「草图」上半截：整行宽的插入线在「草图」上沿，列表画一圈虚线（移出文件夹）', Boolean(s.line) && s.line.indent === 0 && near(s.line.y, g4.t - 2) && s.out, [s, g4]);
await T.shot('1c-insert-line-out-of-folder.png');
await release();
t = await toastNow();
T.ok('松手：「随笔」移出了文件夹、排在「草图」上面，提示「已移出文件夹」', same(await list(), ['草稿本', '[旧的]', '读书笔记', '[课题]', '· 想法', '随笔', '草图'])
  && t && t.text === '已移出文件夹' && t.btn === '撤销', [await list(), t]);
await T.tap('#toast button', 900);
t = await toastNow();
T.ok('点「撤销」：「随笔」回到「课题」里原来的位置（想法后面），说「已放回「课题」」', same(await list(), ['草稿本', '[旧的]', '读书笔记', '[课题]', '· 想法', '· 随笔', '草图'])
  && t && t.text === '已放回「课题」' && same(saved().folders[0].items, [P2, P1]), [await list(), t, saved()]);

// 6. 文件夹里最后一本的下半截和下一行的上半截：同一个高度，一个是排在文件夹里（缩进），一个是排在外面（整行宽）；拖到列表外面松手，什么都不改
let before = JSON.stringify(saved());
g = await geo(rowSel(P3));
await grab(pt(g, 0.5));
const gLast = await geo(rowSel(P1));
await slide(pt(gLast, 0.8));
const sIn = await state();
await slide(pt(await geo(rowSel(P4)), 0.2));
const sOut = await state();
T.ok('指着文件夹里最后一本（随笔）的下半截：缩进的线；指着下一行（草图）的上半截：整行宽的线', Boolean(sIn.line) && sIn.line.indent === 22 && Boolean(sOut.line) && sOut.line.indent === 0
  && Math.abs(sIn.line.y - sOut.line.y) <= 6, [sIn, sOut]);
await slide([700, 600]);
s = await state();
T.ok('拖到抽屉外面：不画线', !s.line && s.drop.length === 0, s);
await release();
T.ok('在抽屉外面松手：回到原处，电脑上一个字没改', JSON.stringify(saved()) === before && same(await list(), ['草稿本', '[旧的]', '读书笔记', '[课题]', '· 想法', '· 随笔', '草图']), saved());

// 7. 放下去不会变的：「读书笔记」拖到自己下半截、「草图」拖到「· 随笔」下面……不画线，松手什么都不改
g = await geo(rowSel(P3));
await grab(pt(g, 0.5));
await slide(pt(g, 0.8));
s = await state();
T.ok('指着自己：不画线', !s.line && s.drop.length === 0, s);
await slide(pt(await geo(folderSel(F2)), 0.88)); // 「旧的」是空的：下面四分之一是排在它下面，就是「读书笔记」现在的位置
s = await state();
T.ok('指着上面那个空文件夹的下面四分之一（就是它现在的位置）：不画线', !s.line, s);
await release();
T.ok('松手：什么都不改', JSON.stringify(saved()) === before, saved());

// 8. 草稿本：指着它是排到它下面（不会排到它上面）；最后一行下面一点是排到最后
g = await geo(rowSel(P4));
await grab(pt(g, 0.5));
const gs = await geo(rowSel('scratch'));
await slide(pt(gs, 0.2));
s = await state();
T.ok('指着草稿本（哪怕是它的上半截）：线画在草稿本下沿', Boolean(s.line) && s.line.indent === 0 && near(s.line.y, gs.b + 2), [s, gs]);
await release();
T.ok('松手：「草图」排在草稿本下面，草稿本照旧最上面', same((await list()).slice(0, 2), ['草稿本', '草图']), await list());
g = await geo(rowSel(P4));
await grab(pt(g, 0.5));
const lastRow = await js(`(() => { const rows = [...document.querySelectorAll('#nbList > *')]; const r = rows[rows.length - 1].getBoundingClientRect(); return { l: r.left, b: r.bottom }; })()`);
await slide([lastRow.l + 80, lastRow.b + 10]);
s = await state();
T.ok('最后一行下面 10 像素：整行宽的线画在最后一行下沿', Boolean(s.line) && s.line.indent === 0 && near(s.line.y, lastRow.b + 2), [s, lastRow]);
await release();
T.ok('松手：「草图」排到最后（在「课题」整块下面，没进文件夹）', same(await list(), ['草稿本', '[旧的]', '读书笔记', '[课题]', '· 想法', '· 随笔', '草图']) && same(saved().top, [F2, P3, F1, P4]), [await list(), saved()]);

// 9. 刷新后还在（顺序是电脑上记的，各台设备一样）；服务给平板的 top 和文件里记的一样
const shown = await list();
await T.reload();
await drawer(true);
const api = await T.apiJson('/api/folders');
T.ok('刷新后抽屉里还是这个顺序', same(await list(), shown), [await list(), shown]);
T.ok('服务给平板的最外层顺序（top）和电脑上记的一样，文件夹里的也一样', same(api.top, [F2, P3, F1, P4]) && same(api.folders.find((f) => f.id === F1).items, [P2, P1]), api);

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

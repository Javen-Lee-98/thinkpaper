// 连续阅读：打开多页的本子默认连续，下一页接在下面；手指往上拖过半页，下一页成为当前页，屏幕不跳；
// 笔落在相邻页上就写在那一页；每页的撤销各自保留（离开再远回来也还在）；
// 抽屉最上面的「连续 / 单页」切到单页后一页一页翻，开关记在电脑上（刷新后还在）。
// 跑法：node tests/browser/flow.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'flow', pages: 3, open: false });
// 一本 7 页的书：每页比屏幕矮（下一页露得出来）；每页的大黑字在不同的横向位置，看画面就认得出是哪一页
execFileSync(PY, ['-c', `import fitz,sys
doc=fitz.open()
for k in range(7):
    p=doc.new_page(width=595,height=520); p.insert_text((60+70*k,100),"P%d"%(k+1),fontsize=40)
doc.save(sys.argv[1])`, join(T.BOOKS, 'seven.pdf')]);
const NB = 'book:seven.pdf', nbQ = encodeURIComponent(NB);
await T.go();
const js = T.evalJS;
const view = () => js(`(() => { const S = window.__ink.S, r = document.querySelector('#stage').getBoundingClientRect();
  return { s: S.view.s, ty: S.view.ty, h: r.height, idx: S.idx, pageH: S.pageH, flow: S.flow, n: S.page.strokes.filter((s) => !s.erasedAt).length }; })()`);
const strip = () => js(`window.__ink.flowStrip().map((n) => ({ i: n.i, D: n.D, Y0: n.G.Y0, pageH: n.G.pageH }))`);
const center = (v) => (v.h / 2 - v.ty) / v.s; // 屏幕中线在当前页的哪个高度
// 画面上（底图那一层）第 k + 1 页的大黑字该在的那一块里有多少深色的点；D：那一页的顶比当前页的顶低多少
const label = (k, D = 0) => js(`(() => { const S = window.__ink.S, c = document.querySelector('#bg'), q = c.width / c.clientWidth, v = S.view, x0 = ${(60 + 70 * k) * 1.68}, y0 = ${D + 110};
  const d = c.getContext('2d').getImageData(Math.round((v.tx + x0 * v.s) * q), Math.round((v.ty + y0 * v.s) * q), Math.round(80 * v.s * q), Math.round(65 * v.s * q)).data;
  let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] < 110 && d[i + 1] < 110 && d[i + 2] < 110) n++; return n; })()`);
// 一根手指竖着拖 dy 像素（正数是往上拖，露出下面的页）；松手前记下视图
async function drag(dy) {
  const x = 420, y0 = dy > 0 ? 1050 : 150;
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0, id: 1 }] });
  for (let k = 1; k <= 12; k++) { await T.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 - (dy * k) / 12, id: 1 }] }); await T.sleep(16); }
  await T.sleep(350); // 拖得慢一点，不算轻点
  const before = await view();
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await T.sleep(400);
  return before;
}
const openDrawer = async () => { if (!(await T.visible('#drawer'))) await T.tap('#nbChip'); };
const closeDrawer = async () => { if (await T.visible('#drawer')) await T.tap('#nbChip'); };
// 翻到第 i + 1 页：打开抽屉，点那一页的缩略图，再把抽屉收起
async function gotoPage(i) {
  await openDrawer();
  await js(`document.querySelector('#thumbs .th:nth-child(${i + 1})').scrollIntoView({ block: 'center' })`);
  await T.tap(`#thumbs .th:nth-child(${i + 1})`, 1500);
  await closeDrawer();
}
const onServer = async () => { const out = []; for (const i of [0, 1, 2]) out.push((await T.apiJson(`/api/page?nb=${nbQ}&i=${i}`)).strokes.filter((s) => !s.erasedAt).length); return out; };

// 0. 打开就是 3 页的草稿本（没选过连续还是单页）：默认连续，第 2 页接在下面；手指往上拖过去，第 2 页成为当前页
await T.waitFor(`window.__ink.flowStrip().length > 0`);
const v0 = await view(), p2 = (await strip()).find((n) => n.i === 1);
T.ok('3 页的草稿本：默认连续，第 2 页接在下面', v0.flow === true && v0.idx === 0 && Boolean(p2) && Math.abs(p2.D - (v0.pageH + 40)) < 1 && (await T.text('#chipPage')) === '1/3', [v0, p2]);
await T.sleep(1200); // 页面刚打开的头一秒里手指拖不动纸（已知的毛病，记在 palm.mjs 最后一步）
const b0 = await drag(((p2 ? p2.D : 0) + 300 - center(v0)) * v0.s);
const v1 = await view();
T.ok('草稿本上手指往上拖过半页：第 2 页成为当前页，屏幕不跳', b0.idx === 0 && v1.idx === 1 && (await T.text('#chipPage')) === '2/3'
  && Math.abs(v1.ty - (b0.ty + p2.D * b0.s)) < 1.5, [b0, v1, await T.text('#chipPage')]);

// 1. 在抽屉里点开一本 7 页的书：默认连续，第 2 页接在第 1 页下面
await openDrawer();
const row = await js(`[...document.querySelectorAll('#nbList .nb-item')].findIndex((e) => e.textContent.includes('seven')) + 1`);
await T.tap(`#nbList .nb-item:nth-child(${row}) .nb-name`, 800);
await T.waitFor(`window.__ink.S.nb.id === ${JSON.stringify(NB)} && window.__ink.S.page && window.__ink.flowStrip().length > 0`, 15000);
await T.sleep(600);
await openDrawer();
const info0 = await T.apiJson(`/api/notebook?nb=${nbQ}`);
let v = await view();
T.ok('打开多页的书：默认连续，抽屉里选着「连续」', v.flow === true && v.idx === 0 && info0.pages === 7 && info0.flowSet === false
  && (await js(`[...document.querySelectorAll('#segFlow button.on')].map((b) => b.dataset.v).join(',')`)) === 'flow' && (await T.text('#chipPage')) === '1/7', [v, info0.flowSet, await T.text('#chipPage')]);
await closeDrawer();
let st = await strip();
const s2 = st.find((n) => n.i === 1), D = s2 ? s2.D : 0;
T.ok('下一页接在下面：隔一条页缝', Boolean(s2) && Math.abs(D - (v.pageH + 40)) < 1 && v.pageH * v.s < v.h - 200, [st, v]);
const px1 = [await label(0), await label(1, D), await label(0, D), await label(1)];
T.ok('画面上第 1 页在上、第 2 页的内容画在它下面', px1[0] > 100 && px1[1] > 100 && px1[2] === 0 && px1[3] === 0, px1);
await T.shot('1-strip.png');

// 2. 第 1 页写一笔；手指只往上拖一点（中线还在第 1 页）不换页；拖到中线落进第 2 页：第 2 页成为当前页，屏幕不跳
await T.pen(T.line(200, 300, 300));
T.ok('第 1 页写了一笔', (await view()).n === 1 && (await view()).idx === 0, await view());
await T.sleep(1200); // 笔刚用过的一秒内手指不算挪纸
await drag(60);
v = await view();
T.ok('只拖一点（屏幕中线还在第 1 页）：当前页不变', v.idx === 0 && center(v) < v.pageH && (await T.text('#chipPage')) === '1/7', v);
const before = await drag((D + 300 - center(v)) * v.s);
v = await view();
T.ok('手指往上拖过半页：第 2 页成为当前页', before.idx === 0 && v.idx === 1 && v.n === 0 && (await T.text('#chipPage')) === '2/7', [before, v, await T.text('#chipPage')]);
const px2 = [await label(1), await label(0)];
T.ok('换页时屏幕不跳：第 2 页还在松手时的位置', Math.abs(v.ty - (before.ty + D * before.s)) < 1.5 && Math.abs(center(v) - 300) < 3 && px2[0] > 100 && px2[1] === 0,
  { ty: v.ty, expect: before.ty + D * before.s, center: center(v), px2 });
await T.shot('2-dragged.png');

// 3. 再往上拖一些，让第 3 页的上半露出来（中线仍在第 2 页）；笔落在第 3 页上：第 3 页成为当前页，这一笔写在第 3 页
await drag((v.pageH - 120 - center(v)) * v.s);
v = await view();
st = await strip();
const s3 = st.find((n) => n.i === 2);
T.ok('再拖一些，中线还在第 2 页：当前页还是第 2 页，第 3 页露出来了', v.idx === 1 && Boolean(s3) && (v.ty + (s3 ? s3.D : 0) * v.s) < v.h - 300, [v, st]);
await T.pen(T.line(300, s3.D + s3.Y0 + 150, 250));
const v3 = await view();
const y3 = await js(`(window.__ink.S.page.strokes[0] || { pts: [[0, -1]] }).pts[0][1]`);
T.ok('笔落在相邻的第 3 页上：第 3 页成为当前页，这一笔写在第 3 页', v3.idx === 2 && v3.n === 1 && Math.abs(y3 - 150) < 2 && (await T.text('#chipPage')) === '3/7', [v3, y3, await T.text('#chipPage')]);
T.ok('落笔换页时屏幕也不跳', Math.abs(v3.ty - (v.ty + s3.D * v.s)) < 1.5 && (await label(2)) > 100, { ty: v3.ty, expect: v.ty + s3.D * v.s });
T.ok('写完自己存上了', await T.saved(), await js(`({ dirty: window.__ink.S.dirty, saving: window.__ink.S.saving })`));
T.ok('电脑上：第 1、3 页各一笔，第 2 页没有', JSON.stringify(await onServer()) === '[1,0,1]', await onServer());

// 4. 每页的撤销各自保留：翻到第 7 页（离第 1 页很远，第 1 页的缓存放掉了）再回第 1 页，撤销撤掉的是第 1 页那一笔；
//    第 3 页那一笔不受影响，回到第 3 页它自己的撤销也还在
await gotoPage(6);
const far = await js(`({ idx: window.__ink.S.idx, cached: [...window.__ink.S.flowCache.keys()].sort() })`);
T.ok('翻到第 7 页：第 1 页已经不在相邻页的缓存里（下一项的前提：离得够远）', far.idx === 6 && !far.cached.includes(0), far);
await gotoPage(0);
v = await view();
await T.tap('#toolsUndo');
T.ok('回到第 1 页点撤销：撤掉第 1 页那一笔', v.idx === 0 && v.n === 1 && (await view()).n === 0, [v, await view()]);
await gotoPage(2);
v = await view();
await T.tap('#toolsUndo');
T.ok('第 3 页那一笔还在，它自己的撤销也还在', v.idx === 2 && v.n === 1 && (await view()).n === 0, [v, await view()]);
await T.saved();
T.ok('电脑上：三页的笔迹都撤掉了', JSON.stringify(await onServer()) === '[0,0,0]', await onServer());

// 5. 抽屉最上面切到「单页」：下面不再接着下一页，一页一页翻；电脑上记下了，刷新后还是单页
await openDrawer();
await T.tap('#segFlow button[data-v="single"]', 800);
v = await view();
const dirs = readdirSync(join(T.DATA, 'notebooks')).filter((d) => d.startsWith('book-'));
const setFile = dirs.length === 1 ? join(T.DATA, 'notebooks', dirs[0], 'settings.json') : '';
const onDisk = setFile && existsSync(setFile) ? JSON.parse(readFileSync(setFile, 'utf8')) : null;
const info1 = await T.apiJson(`/api/notebook?nb=${nbQ}`);
T.ok('点「单页」：下面不再接着下一页', v.flow === false && v.idx === 2 && (await strip()).length === 0 && (await label(3, D)) === 0 && (await label(2)) > 100
  && (await js(`[...document.querySelectorAll('#segFlow button.on')].map((b) => b.dataset.v).join(',')`)) === 'single', [v, await strip(), await label(3, D)]);
T.ok('开关记在电脑上', info1.flow === false && info1.flowSet === true && Boolean(onDisk) && onDisk.flow === false, [info1.flow, info1.flowSet, onDisk]);
await closeDrawer();
await T.sleep(1200);
await drag(500);
T.ok('单页时手指再怎么往上拖也不换页', (await view()).idx === 2 && (await T.text('#chipPage')) === '3/7', await view());
T.ok('单页时本子名旁边有翻页', (await T.visible('#chipPrev')) && (await T.visible('#chipNext')));
await T.tap('#chipNext', 1500);
T.ok('点下一页：翻到第 4 页', (await view()).idx === 3 && (await T.text('#chipPage')) === '4/7' && (await label(3)) > 100, [await view(), await T.text('#chipPage')]);
await T.tap('#chipPrev', 1500);
T.ok('点上一页：回到第 3 页', (await view()).idx === 2 && (await T.text('#chipPage')) === '3/7', await view());
await T.reload();
v = await view();
T.ok('刷新后还是这本、还是单页', v.flow === false && (await js(`window.__ink.S.nb.id`)) === NB && (await strip()).length === 0 && (await T.visible('#chipNext')), v);
await openDrawer();
await T.tap('#segFlow button[data-v="flow"]', 1200);
T.ok('再切回「连续」：下一页又接在下面', (await view()).flow === true && (await strip()).some((n) => n.i === (v.idx + 1)) && (await T.apiJson(`/api/notebook?nb=${nbQ}`)).flow === true, await strip());

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

// 纸四边的「＋ 加长 / 加宽 / 向上 / 向左」（阶段 D1，《产品定义》第 2 节）：空白本子（草稿本、自己新建的本子）里没有这四个按钮——
// 笔写到纸边附近也不出来；纸照样跟着字长（写到页底自己加长）。书页（导入的文档）和推送页（「Claude 推送」那本）照旧：
// 写到哪一边附近，那一边的按钮亮出来，点一下纸就往那边长。
// 跑法：node tests/run_browser.mjs <临时目录> --only paper_edges；有一项不对退出码 1。只在无头 Edge 里跑过；笔是 pointerType 为 pen 的鼠标事件。
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'paper-edges' });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const IDS = ['#extDown', '#extRight', '#extUp', '#extLeft'];
// 四个按钮：藏着没有、亮着没有（亮着才点得到：不亮时看不见、点不着）
const tabs = () => js(`${JSON.stringify(IDS)}.map((id) => { const e = document.querySelector(id); return { id, hidden: e.hidden, hot: e.classList.contains('hot'), pe: getComputedStyle(e).pointerEvents }; })`);
const shown = (t) => t.filter((x) => !x.hidden && x.hot && x.pe !== 'none').map((x) => x.id);
const geo = () => S('({ X0: S.X0, Y0: S.Y0, W: S.W, TW: S.TW, pageH: S.pageH, xw: S.page.xw || 0, ox: S.page.ox || 0, oy: S.page.oy || 0, h: S.page.h || 0, n: S.page.strokes.length, kind: S.nb.kind })');
const refit = async () => { await js(`(() => { window.__ink.S.fitMode = 'width'; window.dispatchEvent(new Event('resize')); return 1; })()`); await sleep(300); };
const waitPen = () => sleep(2700); // 上一次亮出来的按钮 2.5 秒后自己收起：等它收起再写下一笔
// 贴着四边各写一笔（都在纸里面、在屏幕上，避开右下角那一条），写完马上看哪些按钮亮了。返回 { 方向: 亮着的按钮 }
async function writeNearEdges() {
  const out = {};
  for (const dir of ['down', 'right', 'up', 'left']) {
    await refit();
    const g = await geo();
    const pts = { down: T.line(g.X0 + 150, g.pageH - 100, 110), right: T.line(g.TW - 130, 420, 90), up: T.line(g.X0 + 420, g.Y0 + 70, 110), left: T.line(g.X0 + 40, 640, 50) }[dir];
    await T.pen(pts, 150);
    out[dir] = shown(await tabs());
    await waitPen();
  }
  return out;
}
// 书页、推送页：写到那一边附近，那个按钮亮出来；点它，纸往那边长
async function useEdges(label) {
  const want = { down: '#extDown', right: '#extRight', up: '#extUp', left: '#extLeft' };
  for (const dir of ['down', 'right', 'up', 'left']) {
    await refit();
    const g = await geo();
    const pts = { down: T.line(g.X0 + 150, g.pageH - 100, 110), right: T.line(g.TW - 130, 420, 90), up: T.line(g.X0 + 420, g.Y0 + 70, 110), left: T.line(g.X0 + 40, 640, 50) }[dir];
    await T.pen(pts, 150);
    const lit = shown(await tabs());
    if (dir === 'down') { // 「＋ 加长」躲开全屏时右下角那一条（阶段 D1 第二部分修的：原来被它压住一半）
      const ov = await js(`(() => { const a = document.querySelector('#extDown').getBoundingClientRect(), b = document.querySelector('#tools').getBoundingClientRect();
        return { hit: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top, a: [a.left, a.top, a.right, a.bottom], b: [b.left, b.top, b.right, b.bottom] }; })()`);
      T.ok(`${label}：「＋ 加长」亮出来时不被右下角那一条压住`, lit.includes('#extDown') && !ov.hit, ov);
    }
    const n = (await geo()).n;
    const tapped = lit.includes(want[dir]) && (await T.tap(want[dir], 400));
    const h = await geo();
    const grew = { down: h.pageH === g.pageH + 700 && h.h === h.pageH, right: h.xw === g.xw + 400 && h.W === g.W + 400, up: h.oy === g.oy + 500 && h.Y0 === g.Y0 - 500, left: h.ox === g.ox + 400 && h.X0 === g.X0 - 400 }[dir];
    T.ok(`${label}：写到${{ down: '页底', right: '右边', up: '上边', left: '左边' }[dir]}附近，「${want[dir]}」亮出来；点一下纸往那边长`, tapped && grew && h.n === n, { lit, before: g, after: h });
    await waitPen();
  }
}

// ================= 1. 草稿本（空白本子）：四个按钮都不在，写到纸边附近也不出来
T.ok('（前提）打开的是草稿本', (await S('S.nb.kind')) === 'scratch', await S('S.nb.kind'));
T.ok('草稿本：刚打开时四个按钮都藏着', (await tabs()).every((t) => t.hidden), await tabs());
let g0 = await geo();
const lit1 = await writeNearEdges();
T.ok('草稿本：贴着四边各写一笔，四个按钮一个也没出来', Object.values(lit1).every((l) => !l.length) && (await tabs()).every((t) => t.hidden && !t.hot), { lit1, tabs: await tabs() });
let g1 = await geo();
T.ok('草稿本：写到页底，纸自己加长了（不用按钮）', g1.pageH > g0.pageH + 300 && g1.n === g0.n + 4, { before: g0.pageH, after: g1.pageH, n: g1.n });
// 写出纸外面：纸自己往那边长（空白本子跟着字长的那条路照旧）
await js(`(() => { const S = window.__ink.S; S.fitMode = null; S.view = { s: S.view.s * 0.6, tx: 200, ty: S.view.ty + 150 }; window.dispatchEvent(new Event('resize')); return 1; })()`);
await sleep(300);
g0 = await geo();
await T.pen(T.line(g0.X0 - 60, 300, 40), 150);
g1 = await geo();
T.ok('草稿本：写在纸的左边外面，纸往左长（没有按钮也能长）', g1.ox > g0.ox && g1.X0 < g0.X0 && shown(await tabs()).length === 0, { before: g0, after: g1 });

// ================= 2. 自己新建的空白本子：同样没有
const pad = await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title: '旅行清单' }) });
await T.openNotebook(pad.id, 0);
T.ok('（前提）打开了新建的空白本子', (await S('S.nb.kind')) === 'pad', await S('S.nb.kind'));
g0 = await geo();
const lit2 = await writeNearEdges();
T.ok('新建的空白本子：贴着四边各写一笔，四个按钮一个也没出来', Object.values(lit2).every((l) => !l.length) && (await tabs()).every((t) => t.hidden), { lit2, tabs: await tabs() });
g1 = await geo();
T.ok('新建的空白本子：写到页底，纸自己加长了', g1.pageH > g0.pageH + 300, { before: g0.pageH, after: g1.pageH });

// ================= 3. 书页（导入的 PDF）：四个按钮照旧，写到边上亮出来，点了纸往那边长
const SRC = join(T.ROOT, 'src'), PDF = join(SRC, 'trip.pdf'), PNG = join(SRC, 'map.png');
mkdirSync(SRC, { recursive: true });
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
doc=fitz.open()
p=doc.new_page(width=1000,height=1300)
p.insert_text((60,120),'Trip plan: train at 9, lunch at noon',fontsize=34)
doc.save(sys.argv[1])
d=fitz.open(); q=d.new_page(width=800,height=600)
q.draw_rect(fitz.Rect(0,0,200,200),color=None,fill=(0,0.6,0)); q.insert_text((300,400),'map',fontsize=40)
q.get_pixmap(alpha=False).save(sys.argv[2])`, PDF, PNG]);
const imp = await T.post('/bridge/import', { sid: 'S1', path: PDF });
await T.openNotebook(imp.id, 0);
T.ok('（前提）打开了导入的书页', (await S('S.nb.kind')) === 'book' && (await S('Boolean(S.bgImg)')), await S('S.nb.kind'));
await useEdges('书页');

// ================= 4. 推送页（「Claude 推送」那本）：同样照旧
const sh = await T.post('/bridge/show', { sid: 'S1', path: PNG, title: '路线图' });
T.ok('（前提）推送了一张图', sh && sh.ok !== false, sh);
await T.openNotebook('board', 0);
T.ok('（前提）打开了推送页', (await S('S.nb.kind')) === 'board' && (await T.waitFor('window.__ink.S.bgImg', 8000)), await S('S.nb.kind'));
await useEdges('推送页');

// ================= 5. 回到草稿本：按钮又都不在了
await T.openNotebook('scratch', 0);
await T.pen(T.line(200, 500, 100), 150);
T.ok('回到草稿本：四个按钮都藏着', (await S('S.nb.kind')) === 'scratch' && (await tabs()).every((t) => t.hidden && !t.hot), await tabs());

await T.finish();

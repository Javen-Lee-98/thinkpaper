// 「Claude 读到了什么」（阶段 D2，《产品定义》第 3 节）：Claude 每次回都交红笔那几组和回应到的那几组的读法（ink_reply 的 read，anchor 填组号）。
// （2026-11-17 起空白本子里不太长、旁边有空的长回答会摊在纸上：这里的长回答都带 fold: true，查的是收着（圈号）的样子；摊开的见 open_answer.mjs）
// 默认不显示；在「⋯」菜单（全屏时在抽屉最下面）打开后，每组的读法用小号灰色印刷体写在那几笔正下方，不压字；
// 读法跟着那几笔走（接着在旁边写的字不算进去）；那几笔擦掉了就不写，撤销回来又写；同一组后来又交了读法只写新的；
// 没带 anchor 的存着、不显示；开关记在这台设备上（刷新后还开着）；连续阅读时相邻页上的也写；书页上也写；关掉就没了；
// 小灰字点不着：照常写字、照常点圈号打开长回答。截图存在 <临时目录>/readback/out/ 下。
// 跑法：node tests/browser/readback.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'readback', pages: 2 });
const js = T.evalJS, sleep = T.sleep;

// ---- 小工具
// 一行「手写」：上下抖动的一笔（页面坐标），看着像字
const scribble = (x, y, w, n = 24) => Array.from({ length: n }, (_, i) => [x + (i * w) / (n - 1), y + (i % 2 ? -10 : 10)]);
// 画在纸上的小灰字：每条的 data-k、字、页面坐标的框；在第几层（当前页 / 相邻页）
const drawn = () => js(`[...document.querySelectorAll('#aiRoot > g.reads > g.read')].map((g) => { const b = g.getBBox();
  return { k: Number(g.dataset.k), text: [...g.querySelectorAll('text')].map((t) => t.textContent).join(''), b: [b.x, b.y, b.x + b.width, b.y + b.height] }; })`);
const reads = () => js(`(window.__ink.S.page.reads || []).map((r) => ({ text: r.text, anchor: r.anchor || null, ids: r.ids || null }))`);
const liveBoxes = () => js(`window.__ink.S.page.strokes.filter((s) => !s.erasedAt).map((s) => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of s.pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } return [x0, y0, x1, y1]; })`);
const meet = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const waitPen = () => sleep(1200); // 笔刚抬起来的一会儿里手指轻点不算（手掌），等过去
async function landed(n) {
  const ok = await T.waitFor(`window.__ink.S.page && (window.__ink.S.page.reads || []).length + window.__ink.S.page.ai.length >= ${n}`, 10000);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
async function openDrawerAt(sel) {
  if (!(await T.visible('#drawer'))) await T.tap((await T.visible('#nbChip')) ? '#nbChip' : '#drawerBtn', 600);
  await js(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'nearest' })`);
  await sleep(200);
}
const closeDrawer = async () => { if (await T.visible('#drawer')) await T.tap((await T.visible('#nbChip')) ? '#nbChip' : '#drawerBtn', 500); };
if (await js('window.__ink.S.flow')) { await js('window.__ink.toggleFlow()'); await sleep(600); }

// 1. 默认关着；写三行（中文、英文、一句红笔问题），点「AI」交上去，Claude 回读法、一条短批注和一条长回答
T.ok('默认不显示读法：两个开关都没勾', !(await js(`document.querySelector('#optReads').checked || document.querySelector('#drReads').checked || window.__ink.S.readsOn`)), null);
await T.pen(scribble(120, 200, 260));
await T.pen(scribble(120, 330, 200));
await T.tool('red');
await T.pen(scribble(120, 460, 300));
await T.tool('pen');
await T.tap('#check');
const sub = await T.waitSub('S1'), meta = sub && T.metaOf(sub);
T.ok('三组笔迹交上去了', Boolean(meta) && meta.groups.length === 3, meta && meta.groups.map((g) => g.id));
const G = Object.fromEntries(meta.groups.map((g) => [g.id, g]));
const rep = await T.post('/bridge/reply', { sid: 'S1', submission: sub.id, items: [
  { type: 'read', anchor: 'g1', text: '周六去买菜' }, { type: 'read', anchor: 'g2', text: 'buy eggs and milk' }, { type: 'read', anchor: 'g3', text: '周日几点出发？' },
  { type: 'read', text: '整页：周末安排' },
  { type: 'note', anchor: 'g1', text: '记得带购物袋' },
  { type: 'write', fold: true, anchor: 'g3', q: '周日几点出发？', text: '早上八点出发比较好：路上不堵，中午前能到。\n\n要是下雨，就改到周六下午。' }] });
T.ok('服务收下了 6 条', rep.ok === true && rep.count === 6, rep);
T.ok('都落到这一页了', await landed(6), await reads());
const R0 = await reads();
T.ok('四条读法都存着：三条带组号和那几笔，没带组号的那条也存着（没有笔迹）', R0.length === 4 && R0.slice(0, 3).every((r, i) => r.anchor === `g${i + 1}` && r.ids && r.ids.length)
  && R0[3].anchor === null && R0[3].ids === null, R0);
T.ok('关着时纸上没有小灰字', (await drawn()).length === 0, await drawn());
await T.saved();

// 2. 全屏时（打开时的样子）没有「⋯」：在抽屉最下面打开
await openDrawerAt('#drReads');
T.ok('全屏时抽屉最下面有「Claude 读到了什么」', (await T.visible('#drReads')) && /Claude 读到了什么/.test(await js(`document.querySelector('#drReads').parentElement.textContent`)), null);
await T.tap('#drReads');
await closeDrawer();
const D1 = await drawn();
T.ok('打开后：三组各一行小灰字，没带组号的那条不写', D1.length === 3 && D1.map((d) => d.text).sort().join('|') === ['buy eggs and milk', '周六去买菜', '周日几点出发？'].sort().join('|'), D1);
const under = (d, g) => d.b[1] >= g.bbox[3] - 1 && d.b[1] - g.bbox[3] < 24 && Math.abs(d.b[0] - g.bbox[0]) < 12;
const byText = (D, s) => D.find((d) => d.text === s);
T.ok('每条就在它那组笔迹的正下方、从那组的左端起', under(byText(D1, '周六去买菜'), G.g1) && under(byText(D1, 'buy eggs and milk'), G.g2) && under(byText(D1, '周日几点出发？'), G.g3),
  { D1, g: meta.groups.map((g) => g.bbox) });
const inks = await liveBoxes();
T.ok('小灰字不压任何一笔', D1.every((d) => inks.every((b) => !meet(d.b, b))), { D1, inks });
const look = await js(`(() => { const t = document.querySelector('#aiRoot > g.reads text'), cs = getComputedStyle(t), r = t.getBoundingClientRect();
  return { fill: cs.fill, family: cs.fontFamily, h: r.height }; })()`);
T.ok('小号灰色印刷体（不是 Claude 蓝字那种手写体）', look.fill === 'rgb(138, 133, 123)' && !/xiaolai|kai/i.test(look.family) && look.h > 6 && look.h < 18, look);
T.ok('两个开关都勾上了，记在这台设备上', await js(`document.querySelector('#optReads').checked && document.querySelector('#drReads').checked && localStorage.getItem('inkthink.reads') === 'true'`), null);
await js(`document.querySelector('#toast').hidden = true`); // 截图里不要「Claude 回了 1 条」那一句
await T.shot('reads-on.png');

// 3. 在第一行右边接着写：那一行的读法不动（跟着原来那几笔走，新写的不算进去）
const before = byText(D1, '周六去买菜');
await T.pen(scribble(520, 200, 160));
const D2 = await drawn(), after = byText(D2, '周六去买菜');
T.ok('在第一行右边接着写：读法还是那一句、位置没变', Boolean(after) && after.b.every((v, i) => Math.abs(v - before.b[i]) < 0.5) && D2.length === 3, { before, after, D2 });
const n0 = await T.strokes();
// 在小灰字上面写一笔：照常写上（小灰字点不着、不挡笔）
await T.pen([[before.b[0] + 4, before.b[1] + 4], [before.b[2] - 4, before.b[3] - 4]]);
T.ok('在小灰字上落笔：照常写上', (await T.strokes()) === n0 + 1, [n0, await T.strokes()]);
await T.tap('#toolsUndo');
T.ok('撤销刚才那一笔', (await T.strokes()) === n0, await T.strokes());

// 4. Claude 又交了第一行的读法（读法改了）：只写新的。旧的那条所指的几笔都在新的这条里，落下时清掉（阶段 E：page.reads 不再只增不减）；
//    别的几条（另外两组的、没带组号的那条）不动
const rep2 = await T.post('/bridge/reply', { sid: 'S1', submission: sub.id, items: [{ type: 'read', anchor: 'g1', text: '周六去超市买菜' }] });
T.ok('又交了一条第一行的读法', rep2.ok === true, rep2);
T.ok('落到这一页', await T.waitFor(`window.__ink.S.page.reads.some((r) => r.text === '周六去超市买菜')`, 10000), await reads());
await sleep(300);
const R1 = await reads();
T.ok('第一行旧的那条读法清掉了；另两组的、没带组号的那条还在，次序不变', JSON.stringify(R1.map((r) => r.text)) === JSON.stringify(['buy eggs and milk', '周日几点出发？', '整页：周末安排', '周六去超市买菜'])
  && R1[2].ids === null && JSON.stringify(R1[3].ids) === JSON.stringify(R0[0].ids), R1);
const D3 = await drawn();
T.ok('第一行只写新的那句，旧的不写', D3.length === 3 && Boolean(byText(D3, '周六去超市买菜')) && !byText(D3, '周六去买菜'), D3);
await T.saved();
const P1 = T.pageFile('scratch', 0);
T.ok('存到电脑上的也是清过的（4 条）', Boolean(P1) && (P1.reads || []).length === 4 && !(P1.reads || []).some((r) => r.text === '周六去买菜'), P1 && P1.reads);

// 5. 擦掉第二行：它的读法跟着没了；撤销：回来
await T.tool('eraser');
await T.pen(scribble(120, 330, 200));
await T.tool('pen');
const D4 = await drawn();
T.ok('擦掉第二行：它的读法不写了', D4.length === 2 && !byText(D4, 'buy eggs and milk'), D4);
await T.tap('#toolsUndo');
T.ok('撤销擦除：又写出来了', await T.waitFor(`[...document.querySelectorAll('#aiRoot > g.reads text')].some((t) => t.textContent === 'buy eggs and milk')`, 3000), await drawn());
// 擦掉第一行（读法清理过的那一组）、撤销：回来的是新的那句，旧的那句不会冒出来
await T.tool('eraser');
await T.pen(scribble(120, 200, 260));
await T.tool('pen');
const D4b = await drawn();
T.ok('擦掉第一行：它的读法不写了（新旧两句都不写）', D4b.length === 2 && !byText(D4b, '周六去超市买菜') && !byText(D4b, '周六去买菜'), D4b);
await T.tap('#toolsUndo');
T.ok('撤销擦除：写出来的是新的那句', await T.waitFor(`[...document.querySelectorAll('#aiRoot > g.reads text')].some((t) => t.textContent === '周六去超市买菜')`, 3000)
  && !byText(await drawn(), '周六去买菜') && (await drawn()).length === 3, await drawn());

// 6. 圈号照常能点开（小灰字在批注层上、点不着）
await waitPen();
const badge = await js(`(() => { const c = document.querySelector('#aiRoot > .badge circle'); if (!c) return null; const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
if (badge) await T.fingerTapAt(badge[0], badge[1], 700);
T.ok('点圈号：长回答的卡片打开', Boolean(badge) && (await T.visible('#answerCard')), badge);
await js('window.__ink.closeCard()');
await T.saved();

// 7. 刷新：开关还开着，小灰字还在
await T.reload();
const D5 = await drawn();
T.ok('刷新后还开着，三行都在', (await js('window.__ink.S.readsOn')) && D5.length === 3, D5);

// 8. 连续阅读：翻到第 2 页，上面接着的第 1 页上的读法也写（画在相邻页那一层）
await js('window.__ink.toggleFlow()');
await sleep(800);
await T.openPage(1);
const nbr = await T.waitFor(`[...document.querySelectorAll('#aiRoot > g.nbr-reads > g.reads[data-page="0"] text')].length === 3`, 8000);
T.ok('连续阅读：第 2 页上面那一页的三行读法也写出来了', nbr, await js(`[...document.querySelectorAll('#aiRoot > g.nbr-reads text')].map((t) => t.textContent)`));
await js('window.__ink.toggleFlow()');
await sleep(600);
await T.openPage(0);

// 9. 退出全屏后在「⋯」菜单里关掉：都没了；再打开又有
await T.tap('#toolsBars', 800);
await T.tap('#menuBtn');
T.ok('「⋯」菜单里有「Claude 读到了什么」，勾着', (await T.visible('#optReads')) && (await js(`document.querySelector('#optReads').checked`)), null);
await T.tap('#optReads');
await T.tap('#menuBtn');
T.ok('在菜单里关掉：小灰字都没了，记下关了', (await drawn()).length === 0 && (await js(`localStorage.getItem('inkthink.reads')`)) === 'false', await drawn());
await T.tap('#menuBtn');
await T.tap('#optReads');
await T.tap('#menuBtn');
T.ok('再打开：又写出来了', (await drawn()).length === 3, await drawn());

// 10. 书页上也写：导入一页 PDF，写一行、交上去，Claude 交读法
const SRC = join(T.ROOT, 'src');
mkdirSync(SRC, { recursive: true });
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
doc=fitz.open(); p=doc.new_page(width=595,height=842); p.insert_text((72,100),"Weekend plan",fontsize=20); doc.save(sys.argv[1])`, join(SRC, '周末安排.pdf')]);
const imp = await T.post('/bridge/import', { sid: 'S1', path: join(SRC, '周末安排.pdf') });
await T.openNotebook(imp.id, 0);
T.ok('导入了一本书并打开', await T.waitFor(`window.__ink.S.nb && window.__ink.S.nb.id === ${JSON.stringify(imp.id)} && window.__ink.S.bgImg`, 15000),
  [imp, await js(`[window.__ink.S.nb && window.__ink.S.nb.id, Boolean(window.__ink.S.bgImg), window.__ink.S.flow]`)]);
await T.pen(scribble(120, 600, 240));
await T.tap('#barCheck');
const sub2 = await T.waitSub('S1');
await T.post('/bridge/reply', { sid: 'S1', submission: sub2.id, items: [{ type: 'read', anchor: 'g1', text: 'bring an umbrella' }] });
T.ok('书页上：读法写在那一行下面', await T.waitFor(`window.__ink.S.nb.kind === 'book' && [...document.querySelectorAll('#aiRoot > g.reads text')].some((t) => t.textContent === 'bring an umbrella')`, 10000),
  [await drawn(), await js('window.__ink.S.nb.id')]);
await T.shot('reads-book.png');

// 11. 一页还没有读法时打开：说一句
await T.openNotebook('scratch', 1);
await T.tap('#menuBtn');
await T.tap('#optReads');
await T.tap('#menuBtn');
await T.tap('#menuBtn');
await T.tap('#optReads');
const tt = await js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
T.ok('这一页没有读法时打开：提示「这一页还没有 Claude 读过的字」', tt === '这一页还没有 Claude 读过的字', tt);
await T.tap('#menuBtn');

await T.finish();

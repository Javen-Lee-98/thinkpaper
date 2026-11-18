// 页面上的开关：抽屉最上面两组——连续 / 单页、适配宽度 / 整页（本子再多也不用往下划）；
// 全屏和退出全屏各有自己的按钮：全屏时右下角那一条上有「退出全屏」，退出后左侧工具栏最下面有「全屏」。
// 全屏只有纸、左上角的本子名、右下角一条（能按住把手拖走）；退出全屏后顶栏和左侧工具栏回来，「AI」在顶栏上。
// 全屏时左上角一排：[☰ 本子名 页码] [‹] [›]  [单页图标|连续图标]  [加页图标]——这本不止一页才有翻页和「单页 / 连续」（连续时也有）；
// 「单页 / 连续」是并排的一对图标（像一个两格的开关），当前的那个白底加粗边框，点哪个就是哪个，点已选中的不变；
// 和抽屉里那组开关、顶栏上那一对是同一个状态。这一对和旁边的按钮之间留出明显的间隔。
// 只有一页的本子只有 [☰ 本子名] [加页图标]。加页图标在这一页后面加一张和它同方向的空白页并翻过去；退出全屏后顶栏上也有一个。
// 图标按钮没有字，说明写在 aria-label 里，长按看。
// 连续 / 单页每本记在电脑上（没选过的是连续）；全屏与否、那一条的位置记在这台设备上。
// 抽屉、「⋯」菜单开着时用笔点纸面只是收起它们，不留点。
// 跑法：node tests/browser/page_bars.mjs [临时目录]；有一项不对退出码 1。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from '../browser_lib.mjs';

const T = await boot({ name: 'page-bars', pages: 3 });
const js = T.evalJS;
const nbInfo = () => T.apiJson('/api/notebook?nb=scratch');
const st = () => js(`(() => { const S = window.__ink.S; return { flow: S.flow, fit: S.fitMode, collapsed: S.collapsed, idx: S.idx, pages: S.nb.pages }; })()`);
const onOf = (id) => js(`[...document.querySelectorAll('${id} button.on')].map((b) => b.dataset.v).join(',')`);
const openDrawer = async () => { if (!(await T.visible('#drawer'))) await T.tap((await T.visible('#nbChip')) ? '#nbChip' : '#drawerBtn', 600); };
const closeDrawer = async () => { if (await T.visible('#drawer')) await T.tap((await T.visible('#nbChip')) ? '#nbChip' : '#drawerBtn', 600); };
// 一块里看得见的按钮（或菜单行）各是什么
const shown = (sel, name) => js(`[...document.querySelectorAll('${sel}')].filter((b) => { const c = getComputedStyle(b); return c.display !== 'none' && b.getClientRects().length; }).map((b) => ${name}).join(',')`);
const tap = (sel) => T.tap(sel, 600);
// 左上角一排里看得见的按钮（从左到右；「单页 / 连续」那一对在一个框里，也算）
const chipBtns = () => shown('#chipRow button', 'b.id');
// 三个图标按钮的说明（长按看）
const SINGLE = '单页：一页一页翻', CONT = '连续：上下页接在一起', ADD = '在这一页后面加一张空白页';
// 一个按钮：里面有没有图（svg 里有线条）、有没有字、说明、用的哪个图标、多大、线条（图的描边颜色，三个通道里最亮的那个，越小越深）
const iconOf = (sel) => js(`(() => { const b = document.querySelector('${sel}'); if (!b) return null; const r = b.getBoundingClientRect(), s = b.querySelector('svg');
  return { lines: s ? s.querySelectorAll('path, rect, circle').length : 0, text: b.textContent.trim(), label: b.getAttribute('aria-label'), icon: b.dataset.icon || '',
    w: Math.round(r.width), h: Math.round(r.height), light: s ? Math.max(...getComputedStyle(s).stroke.match(/\\d+/g).slice(0, 3).map(Number)) : 999 }; })()`);
// 是图标按钮：有图、没有字，说明对，用的是这个图标，不小于 36×36，线条颜色不淡
const isIcon = (o, label, icon) => Boolean(o) && o.lines > 0 && o.text === '' && o.label === label && o.icon === icon && o.w >= 36 && o.h >= 36 && o.light <= 90;
const icons = async (p) => ({ single: await iconOf(`#${p}Single`), cont: await iconOf(`#${p}Cont`), add: await iconOf(`#${p}Add`) });
const allIcons = (o, lb = [SINGLE, CONT, ADD]) => isIcon(o.single, lb[0], 'single') && isIcon(o.cont, lb[1], 'cont') && isIcon(o.add, lb[2], 'addv');
// 「单页 / 连续」那一对（p 是 chip 或 bar）选中的是哪个：选中的加了 on、白底、有加粗的深色框，另一个没有框；不是这样就把两个的样子都列出来
const pairOf = (p) => js(`(() => { const one = (id) => { const b = document.querySelector('#' + id); if (!b) return null; const c = getComputedStyle(b);
    return { on: b.classList.contains('on'), bg: c.backgroundColor, ring: /inset/.test(c.boxShadow) && c.borderTopColor === 'rgb(34, 34, 34)' }; };
  const s = one('${p}Single'), c = one('${p}Cont'); if (!s || !c) return 'missing';
  const lit = (o) => o.on && o.bg === 'rgb(255, 255, 255)' && o.ring, off = (o) => !o.on && !o.ring;
  return lit(s) && off(c) ? 'single' : lit(c) && off(s) ? 'flow' : JSON.stringify([s, c]); })()`);
// 那一对和左右的按钮之间的间隔：inner 一对里面两个之间，before 和左边那个（›）之间，after 和右边的加页图标之间
const gaps = (p, left) => js(`(() => { const r = (q) => { const e = document.querySelector(q); return e && e.getBoundingClientRect(); };
  const a = r('${left}'), s = r('#${p}Single'), c = r('#${p}Cont'), d = r('#${p}Add');
  if (!a || !s || !c || !d) return { missing: true, oneRow: false };
  return { inner: Math.round(c.left - s.right), before: Math.round(s.left - a.right), after: Math.round(d.left - c.right),
    oneRow: Math.abs(s.top - d.top) < 2 && Math.abs(c.top - d.top) < 2 && Math.abs(a.top - d.top) < 2 }; })()`);
// 一对挨在一起（里面的间隔不超过 4 像素），和左右按钮之间的间隔比里面的大出 8 像素以上
const apart = (g) => g.oneRow && g.inner <= 4 && g.before >= g.inner + 8 && g.after >= g.inner + 8;
// 长按一个图标：按住 0.8 秒，看提示条上出了什么，再松手（这次松手不算点）
async function longPress(sel) {
  await js(`document.querySelector('#toast').hidden = true`);
  const c = await T.centerOf(sel);
  if (!c) return '（没有这个按钮）';
  await T.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: c[0], y: c[1], button: 'left', buttons: 1, clickCount: 1 });
  await T.sleep(800);
  const said = (await T.visible('#toast')) ? await T.text('#toast') : '';
  await T.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c[0], y: c[1], button: 'left', buttons: 0, clickCount: 1 });
  await T.sleep(500);
  return said;
}
// 把左上角那一排单独放大 3 倍截下来（看清图标画得对不对）
async function shotRow(file) {
  const r = await js(`(() => { const b = document.querySelector('#chipRow').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()`);
  const d = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, r[0] - 8), y: Math.max(0, r[1] - 8), width: r[2] + 16, height: r[3] + 16, scale: 3 } });
  writeFileSync(join(T.OUT, file), Buffer.from(d.data, 'base64'));
}
// 这一页和这一本：第几页、一共几页、纸（转过的算上）多高、左上角和顶栏上的页码
const pg = () => js(`(() => { const S = window.__ink.S; return { idx: S.idx, pages: S.nb.pages, baseH: Math.round(S.baseH * 10) / 10, loaded: Boolean(S.page),
  chip: document.querySelector('#chipPage').textContent, no: document.querySelector('#pageNo').textContent }; })()`);
// 等翻到第 i + 1 页、这本一共 n 页
const at = async (i, n) => { const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.idx === ${i} && window.__ink.S.nb.pages === ${n}`); await T.sleep(400); return ok; };
// 抽屉里的按钮：先滚到看得见再点（本子多时「页面」那一行在下面）
const tapIn = async (sel) => { await js(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'nearest' })`); await T.tap(sel, 300); };
const srvOf = (id) => T.apiJson(`/api/notebook?nb=${encodeURIComponent(id)}`);
// 字号、颜色（三个通道里最亮的那个，越小越深）、字在不在按钮里面（没被截掉、没出框）
const fontOf = (sel) => js(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; const c = getComputedStyle(e), b = e.getBoundingClientRect(), r = document.createRange();
  r.selectNodeContents(e); const t = r.getBoundingClientRect();
  return { size: parseFloat(c.fontSize), light: Math.max(...c.color.match(/\\d+/g).slice(0, 3).map(Number)),
    fits: t.left >= b.left - 0.5 && t.right <= b.right + 0.5 && t.top >= b.top - 0.5 && t.bottom <= b.bottom + 0.5, w: Math.round(b.width), h: Math.round(b.height) }; })()`);
// 左上角一排、右下角那一条：都在屏幕里吗、互相压着没有；左上角每个按钮都不小于 36×36 像素
const layout = () => js(`(() => {
  const box = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
  const vis = (e) => getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  const row = [...document.querySelectorAll('#chipRow button')].filter(vis).map(box), tools = box(document.querySelector('#tools'));
  const inside = (b) => b[0] >= 0 && b[1] >= 0 && b[2] <= innerWidth && b[3] <= innerHeight;
  const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  return { n: row.length, rowIn: row.every(inside), toolsIn: inside(tools), apart: row.every((b) => !hit(b, tools)),
    tall: row.every((b) => b[3] - b[1] >= 36 && b[2] - b[0] >= 36), right: Math.round(Math.max(...row.map((b) => b[2]))), tools: tools.map(Math.round), w: innerWidth };
})()`);
// 当前页的纸顶在屏幕上的位置
const pageTop = () => js(`(() => { const S = window.__ink.S; return Math.round(S.view.ty + S.Y0 * S.view.s); })()`);
// 电脑上记下的连续 / 单页（页面不等它存完，多问几次）
const flowOnServer = async (want) => { for (let i = 0; i < 20; i++) { const n = await nbInfo(); if (n.flowSet && n.flow === want) return true; await T.sleep(150); } return false; };

// 1. 打开就是全屏：只有纸；本子名前面有三条横线；没选过的本子是连续；本子名旁边有翻页、「单页 / 连续」一对图标和加页图标
let s = await st();
T.ok('打开是全屏、连续、适配宽度', s.collapsed === true && s.flow === true && s.fit === 'width', s);
T.ok('没有顶栏和左侧工具栏', !(await T.visible('#bar')) && !(await T.visible('#rail')));
T.ok('本子名前面有三条横线', (await T.visible('#nbChip .chip-menu')) && (await T.text('#nbChip .chip-menu')) === '☰');
T.ok('连续时本子名旁边也有翻页，后面是「单页」「连续」一对图标和加页图标', (await chipBtns()) === 'nbChip,chipPrev,chipNext,chipSingle,chipCont,chipAdd', await chipBtns());
T.ok('原来的文字按钮（chipFlow、flowBtn）没有了', !(await js(`Boolean(document.querySelector('#chipFlow, #flowBtn'))`)));
T.ok('电脑上：这本还没选过', (await nbInfo()).flowSet === false, (await nbInfo()).flowSet);

// 1b. 左上角一排：「单页」「连续」「加页」是图标（没有字，说明写在 aria-label 里），当前的那个选中；第一页 ‹ 不能点；
//     一对挨在一起、和旁边隔开；样子和本子名那块一样（圆角、半透明纸色底）、手指好点；长按看说明；
//     834 宽时这一排和右下角那一条都在屏幕里、互不重叠；右下角的「退出全屏」字不小、不淡
let ic = await icons('chip');
T.ok('左上角的「单页」「连续」「加页」都是图标按钮：有图没有字，说明写对，加页用的是纸上加号那个图标，不小于 36×36，线条颜色不淡', allIcons(ic), ic);
T.ok('连续时：「连续」图标选中（白底加粗框），「单页」图标没选中', (await pairOf('chip')) === 'flow', await pairOf('chip'));
T.ok('第一页：‹ 不能点，› 能点', await js(`document.querySelector('#chipPrev').disabled && !document.querySelector('#chipNext').disabled`));
let g = await gaps('chip', '#chipNext');
T.ok('「单页」「连续」挨在一起成一对，和左边的 ›、右边的加页图标之间的间隔明显大于这一对里面的间隔', apart(g), g);
const look = await js(`['#nbChip', '#chipPrev', '#chipNext', '#chipPair', '#chipAdd'].map((q) => { const e = document.querySelector(q); if (!e) return q; const c = getComputedStyle(e); return c.backgroundColor + ' ' + c.borderTopLeftRadius; })`);
T.ok('「单页 / 连续」那一对和加页图标与左上角别的按钮一个样子（圆角、半透明纸色底）', new Set(look).size === 1, look);
let said = await longPress('#chipSingle');
T.ok('长按「单页」图标：出说明「单页：一页一页翻」，松手不切换（还是连续）', said === SINGLE && (await st()).flow === true, [said, (await st()).flow]);
said = await longPress('#chipAdd');
T.ok('长按加页图标：出说明，松手不加页', said === ADD && (await st()).pages === 3, [said, (await st()).pages]);
let lay = await layout();
T.ok('834 宽：左上角一排和右下角那一条都在屏幕里、互不重叠，左上角的按钮都不小于 36×36', lay.n === 6 && lay.rowIn && lay.toolsIn && lay.apart && lay.tall && lay.w === 834, lay);
// 出问题时顶上那一句（连不上电脑、字没存上）：放一句最长的进去量一量，不压着左上角那一排；量完照原样收起
const tr = await js(`(() => { const t = document.querySelector('#trouble'), was = [t.hidden, t.textContent];
  t.textContent = '连不上电脑：新写的字还没存上，先别刷新这一页'; t.hidden = false;
  const a = t.getBoundingClientRect(), hit = [...document.querySelectorAll('#chipRow button')].some((e) => { const b = e.getBoundingClientRect();
    return b.width && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; });
  [t.hidden, t.textContent] = was; return { hit, top: Math.round(a.top), bottom: Math.round(a.bottom) }; })()`);
T.ok('出问题时顶上那一句不压着左上角那一排', !tr.hit, tr);
const tbF = await fontOf('#toolsBars');
T.ok('右下角的「退出全屏」字不小（≥ 14 像素）、颜色不淡、字在按钮里', tbF.size >= 14 && tbF.light <= 90 && tbF.fits, tbF);

// 1c. 连续时点 › ‹：翻到下一页 / 上一页（那一页成为当前页、顶在屏幕上），还是连续；最后一页 › 不能点
await T.tap('#chipNext', 1500);
s = await st();
T.ok('连续时点 ›：翻到第 2 页，页码跟着变，那一页顶在屏幕上', s.flow === true && s.idx === 1 && (await T.text('#chipPage')) === '2/3' && Math.abs(await pageTop()) <= 2,
  [s, await T.text('#chipPage'), await pageTop()]);
await T.tap('#chipNext', 1500);
T.ok('连续时到最后一页：› 不能点，‹ 能点', (await st()).idx === 2 && (await js(`document.querySelector('#chipNext').disabled && !document.querySelector('#chipPrev').disabled`)), await st());
await T.tap('#chipPrev', 1500);
await T.tap('#chipPrev', 1500);
s = await st();
T.ok('连续时点两次 ‹：回到第 1 页，‹ 又不能点', s.flow === true && s.idx === 0 && (await T.text('#chipPage')) === '1/3' && (await js(`document.querySelector('#chipPrev').disabled`)),
  [s, await T.text('#chipPage')]);

// 1d. 点左上角的「单页」图标：变成单页，「单页」图标选中、「连续」不选中；抽屉里那组开关、顶栏上那一对跟着变；电脑上记下了。
//     再点一下已选中的「单页」：什么都不变。点「连续」图标改回连续
await T.tap('#chipSingle', 800);
s = await st();
T.ok('点左上角的「单页」图标：一页一页翻，「单页」图标选中、「连续」图标不选中', s.flow === false && (await pairOf('chip')) === 'single', [s.flow, await pairOf('chip')]);
T.ok('抽屉里的开关跟着选「单页」，顶栏上那一对也是「单页」选中', (await onOf('#segFlow')) === 'single' && (await onOf('#barPair')) === 'single',
  [await onOf('#segFlow'), await onOf('#barPair')]);
T.ok('电脑上记下了单页', await flowOnServer(false), await nbInfo());
T.ok('单页时翻页和图标还在原处', (await chipBtns()) === 'nbChip,chipPrev,chipNext,chipSingle,chipCont,chipAdd', await chipBtns());
await T.sleep(2300); // 等切换的提示过去
await js(`document.querySelector('#toast').hidden = true`);
await T.tap('#chipSingle', 800);
s = await st();
T.ok('再点已选中的「单页」图标：不变（还是单页、没有切换的提示、电脑上还是单页）', s.flow === false && (await pairOf('chip')) === 'single' && !(await T.visible('#toast'))
  && (await flowOnServer(false)), [s.flow, await pairOf('chip'), await T.text('#toast')]);
await T.shot('0b-single.png');
await shotRow('0b-single-row-x3.png');
await T.tap('#chipCont', 800);
s = await st();
T.ok('点「连续」图标：改回连续，「连续」图标选中，抽屉里跟着变，电脑上也改回来了',
  s.flow === true && (await pairOf('chip')) === 'flow' && (await onOf('#segFlow')) === 'flow' && (await onOf('#barPair')) === 'flow' && (await flowOnServer(true)),
  [s.flow, await pairOf('chip'), await onOf('#segFlow'), await onOf('#barPair')]);
await T.sleep(2300); // 等切换的提示过去再截图
await T.shot('0-full.png');
await shotRow('0-row-x3.png');

// 2. 抽屉最上面的两组开关，当前选的加框；本子很多时也不用往下划就看得到
const made = []; // 新建的本子（都只有一页）
for (let k = 0; k < 14; k++) made.push((await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title: `本子 ${k + 1}`, paper: 'portrait' }) })).id);
await T.go();
await openDrawer();
T.ok('抽屉里有两组开关，没有全屏那一行', (await T.visible('#segFlow')) && (await T.visible('#segFit')) && !(await js(`Boolean(document.querySelector('#segBars'))`)));
const where = await js(`(() => { const d = document.querySelector('#drawer'), v = document.querySelector('#viewRow').getBoundingClientRect(), n = document.querySelector('#nbList').getBoundingClientRect();
  return { long: d.scrollHeight > d.clientHeight + 40, scrolled: d.scrollTop, bottom: Math.round(v.bottom), listTop: Math.round(n.top), screen: innerHeight,
    oneRow: new Set([...document.querySelectorAll('#viewRow button')].map((b) => Math.round(b.getBoundingClientRect().top))).size === 1 }; })()`);
T.ok('本子多到抽屉要往下划，开关仍在最上面、不用划就看得到', where.long && where.scrolled === 0 && where.bottom <= where.listTop && where.bottom < 160, where);
T.ok('中文界面里四个按钮排成一行', where.oneRow, where);
T.ok('当前选的是：连续、适配宽度', (await onOf('#segFlow')) === 'flow' && (await onOf('#segFit')) === 'width', [await onOf('#segFlow'), await onOf('#segFit')]);
await T.shot('1-drawer.png');

// 3. 单页：本子名旁边出翻页，能翻；电脑上记住了，刷新后还是单页
await tap('#segFlow button[data-v="single"]');
s = await st();
T.ok('点「单页」：一页一页翻，左上角那一对也是「单页」选中', s.flow === false && (await onOf('#segFlow')) === 'single' && (await pairOf('chip')) === 'single', [s, await pairOf('chip')]);
T.ok('本子名旁边出了翻页，第一页不能再往前', (await T.visible('#chipPrev')) && (await T.visible('#chipNext'))
  && (await js(`document.querySelector('#chipPrev').disabled && !document.querySelector('#chipNext').disabled`)));
await closeDrawer();
await T.tap('#chipNext', 1500);
s = await st();
T.ok('点下一页：到第 2 页', s.idx === 1 && (await T.text('#chipPage')) === '2/3', [s, await T.text('#chipPage')]);
await T.tap('#chipNext', 1500);
T.ok('最后一页不能再往后', (await st()).idx === 2 && (await js(`document.querySelector('#chipNext').disabled`)));
await T.tap('#chipPrev', 1500);
T.ok('点上一页：回到第 2 页', (await st()).idx === 1 && (await T.text('#chipPage')) === '2/3', await T.text('#chipPage'));
const saved = await nbInfo();
T.ok('电脑上记住了单页', saved.flow === false && saved.flowSet === true, { flow: saved.flow, flowSet: saved.flowSet });
await T.go();
s = await st();
T.ok('刷新后还是单页，翻页还在', s.flow === false && (await T.visible('#chipNext')), s);

// 4. 在抽屉里改回连续：翻页还在，左上角那一对跟着改成「连续」选中
await openDrawer();
await tap('#segFlow button[data-v="flow"]');
T.ok('改回连续：翻页还在，左上角那一对是「连续」选中', (await st()).flow === true && (await T.visible('#chipNext')) && (await onOf('#segFlow')) === 'flow'
  && (await pairOf('chip')) === 'flow', [await st(), await pairOf('chip')]);

// 5. 整页 / 适配宽度
await tap('#segFit button[data-v="page"]');
T.ok('点「整页」', (await st()).fit === 'page' && (await onOf('#segFit')) === 'page', await st());
await tap('#segFit button[data-v="width"]');
T.ok('点「适配宽度」', (await st()).fit === 'width' && (await onOf('#segFit')) === 'width', await st());

// 6. 右下角那一条上有「退出全屏」；这一条可以拖：按住左端的把手拖到别处，位置记住，刷新后还在那儿；
//    往屏幕外拖会留在屏幕里；拖过以后上面的按钮照样能点
await closeDrawer();
T.ok('右下角那一条上有「退出全屏」', (await T.visible('#toolsBars')) && (await T.text('#toolsBars')) === '退出全屏', await T.text('#toolsBars'));
const barAt = () => js(`(() => { const r = document.querySelector('#tools').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; })()`);
async function dragGrip(dx, dy) {
  const c = await T.centerOf('#toolsGrip');
  await T.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: c[0], y: c[1], button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 6; i++) await T.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c[0] + (dx * i) / 6, y: c[1] + (dy * i) / 6, button: 'left', buttons: 1 });
  await T.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c[0] + dx, y: c[1] + dy, button: 'left', buttons: 0, clickCount: 1 });
  await T.sleep(300);
}
const near = (a, b) => Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2;
const b0 = await barAt();
T.ok('没拖过：那一条在右下角', b0[2] > 780 && b0[3] > 1140, b0);
await dragGrip(-200, -500); // 2026-11-17 起那一条多了回答要多长的开关、宽了：往左拖 200（拖 300 会顶到屏幕左边）
const b1 = await barAt();
T.ok('按住把手拖：那一条跟着走', near(b1, [b0[0] - 200, b0[1] - 500]), [b0, b1]);
await tap('#tools [data-tool="red"]');
T.ok('拖过以后上面的按钮照样能点（换成红笔）', (await js(`window.__ink.S.tool`)) === 'red');
await tap('#tools [data-tool="pen"]');
await T.go();
const b2 = await barAt();
T.ok('刷新后还在拖到的位置', near(b2, b1), [b1, b2]);
await dragGrip(900, 900);
const b3 = await barAt();
T.ok('往屏幕外拖：留在屏幕里', b3[0] >= 0 && b3[2] <= 834 && b3[3] <= 1194 && b3[1] >= 0, b3);
await dragGrip(-200, -300); // 挪开一点，别压着后面要点的地方
const b4 = await barAt();

// 7. 点「退出全屏」：顶栏和左侧工具栏回来，本子名和右下角那一条收起；顶栏上是「AI」
await tap('#toolsBars');
s = await st();
T.ok('点「退出全屏」：顶栏和左侧工具栏回来', s.collapsed === false && (await T.visible('#bar')) && (await T.visible('#rail')) && !(await T.visible('#drawer')), s);
T.ok('本子名和右下角那一条收起', !(await T.visible('#nbChip')) && !(await T.visible('#tools')));
const barBtns = await shown('#bar button', 'b.id');
T.ok('顶栏：抽屉、翻页、「单页」「连续」一对图标、加页图标、回答要多长（2026-11-17）、AI、更多', barBtns === 'drawerBtn,prev,next,barSingle,barCont,barAdd,barSize,barCheck,menuBtn', barBtns);
ic = await icons('bar');
T.ok('顶栏上的「单页」「连续」「加页」也是图标按钮：有图没有字，说明和左上角的一样，不小于 36×36，线条颜色不淡', allIcons(ic), ic);
T.ok('顶栏上那一对：连续时「连续」图标选中，「单页」图标没选中', (await pairOf('bar')) === 'flow', await pairOf('bar'));
g = await gaps('bar', '#next');
T.ok('顶栏上那一对挨在一起，和左边的 ›、右边的加页图标之间的间隔明显大于这一对里面的间隔', apart(g), g);
const railBtns = await shown('#rail button', 'b.dataset.tool || b.id');
T.ok('左侧：黑笔、红笔、橡皮、套索、撤销、重做、全屏', railBtns === 'pen,red,eraser,lasso,undo,redo,fsBtn', railBtns);
const fsF = await fontOf('#fsBtn');
T.ok('左侧的「全屏」字不小（≥ 14 像素）、颜色不淡、字在按钮里', fsF.size >= 14 && fsF.light <= 90 && fsF.fits, fsF);
const stage = await js(`(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })()`);
T.ok('纸让开了顶栏和左侧工具栏', stage[0] >= 50 && stage[1] >= 44, stage);
await T.shot('3-bars.png');

// 8. 这时照样能写、能交：顶栏上的「AI」
await T.pen(T.line(120, 200, 260));
await tap('#barCheck');
const sub = await T.waitSub('S1');
T.ok('顶栏上的「AI」把这一页交上去了', Boolean(sub && sub.id) && sub.text.startsWith('【草稿纸】') && (T.metaOf(sub).groups || []).length === 1, sub && sub.text.slice(0, 60));

// 8b. 抽屉、「⋯」菜单开着时用笔点一下纸面：只收起它们，纸上不留点（点的地方在纸上、不在抽屉和菜单上）
const onPaper = async (wx, wy) => { const [x, y] = await T.screenOf(wx, wy); return js(`(() => { const e = document.elementFromPoint(${x}, ${y}); return Boolean(e && e.closest('#stage')); })()`); };
const n8 = await T.strokes(), idx8 = (await st()).idx;
await tap('#drawerBtn');
const drawer8 = [await T.visible('#drawer'), await onPaper(800, 260)];
await T.pen([[800, 260], [801, 261]]);
T.ok('抽屉开着时用笔点一下纸面：抽屉收起，纸上没有留下点', drawer8[0] && drawer8[1] && !(await T.visible('#drawer')) && (await T.strokes()) === n8 && (await st()).idx === idx8,
  [drawer8, await T.visible('#drawer'), n8, await T.strokes()]);
await tap('#menuBtn');
const menu8 = [await T.visible('#menu'), await onPaper(300, 300)];
await T.pen([[300, 300], [301, 301]]);
T.ok('「⋯」菜单开着时用笔点一下纸面：菜单收起，纸上没有留下点', menu8[0] && menu8[1] && !(await T.visible('#menu')) && (await T.strokes()) === n8 && (await st()).idx === idx8,
  [menu8, await T.visible('#menu'), n8, await T.strokes()]);

// 9. 顶栏的 ☰ 打开抽屉（在顶栏下面）；⋯ 菜单里只有现在的页面用得上的几项
await tap('#drawerBtn');
const dtop = await js(`Math.round(document.querySelector('#drawer').getBoundingClientRect().top)`);
T.ok('顶栏的 ☰ 打开抽屉，抽屉在顶栏下面，两组开关也在', (await T.visible('#drawer')) && dtop >= 44 && (await T.visible('#segFlow')) && (await onOf('#segFit')) === 'width', [dtop, await onOf('#segFit')]);
await tap('#drawerBtn');
await tap('#menuBtn');
const rows = await shown('#menu .row', `b.id || (b.querySelector('input') || {}).id || '?'`);
// 「画线停住变直」2026-11-16 夜起先藏着（app.js 的 STRAIGHT_SHOWN），菜单里没有它
T.ok('⋯ 菜单：显示批注、Claude 读到了什么、手指书写、回放、整页 / 适配宽度、清除批注、再看一遍新手引导',
  rows === 'optAi,optReads,optFinger,actReplay,actFit,actClearAi,actGuide', rows);
await T.shot('4-menu.png');
await tap('#menuBtn');

// 10. 顶栏上的「单页 / 连续」一对和翻页：和左上角那一对同一个状态
await tap('#barSingle');
T.ok('顶栏的「单页」图标切到单页，电脑上记下了', (await st()).flow === false && (await flowOnServer(false)), await st());
T.ok('顶栏上「单页」图标选中，左上角那一对和抽屉里的开关跟着变', (await pairOf('bar')) === 'single' && (await onOf('#chipPair')) === 'single' && (await onOf('#segFlow')) === 'single',
  [await pairOf('bar'), await onOf('#chipPair'), await onOf('#segFlow')]);
await T.sleep(2300); // 等切换的提示过去
await js(`document.querySelector('#toast').hidden = true`);
await tap('#barSingle');
T.ok('再点顶栏上已选中的「单页」图标：不变', (await st()).flow === false && (await pairOf('bar')) === 'single' && !(await T.visible('#toast')) && (await flowOnServer(false)),
  [await st(), await pairOf('bar'), await T.text('#toast')]);
said = await longPress('#barCont');
T.ok('长按顶栏上的「连续」图标：出说明「连续：上下页接在一起」，松手不切换（还是单页）', said === CONT && (await st()).flow === false, [said, (await st()).flow]);
const i0 = (await st()).idx;
await T.tap(i0 < 2 ? '#next' : '#prev', 1500);
T.ok('顶栏的翻页能翻', (await st()).idx === (i0 < 2 ? i0 + 1 : i0 - 1) && (await T.text('#pageNo')) === `${(await st()).idx + 1}/3`, [i0, (await st()).idx, await T.text('#pageNo')]);
await tap('#barCont');
T.ok('点顶栏上的「连续」图标切回连续，「连续」图标选中，左上角那一对跟着变', (await st()).flow === true && (await pairOf('bar')) === 'flow' && (await onOf('#chipPair')) === 'flow'
  && (await flowOnServer(true)), [await pairOf('bar'), await onOf('#chipPair')]);

// 11. 这台设备记住了：刷新后还是带顶栏的样子；点左侧的「全屏」回到只有纸，再刷新也记得
await T.go();
T.ok('刷新后还是退出全屏的样子', (await st()).collapsed === false && (await T.visible('#bar')) && !(await T.visible('#tools')));
await tap('#fsBtn');
T.ok('点左侧的「全屏」：回到只有纸', (await st()).collapsed === true && !(await T.visible('#bar')) && (await T.visible('#nbChip')) && (await T.visible('#tools')));
const b5 = await barAt();
T.ok('那一条回来时还在拖到的位置', near(b5, b4), [b4, b5]);
await T.go();
T.ok('刷新后还是全屏', (await st()).collapsed === true && !(await T.visible('#bar')) && (await T.visible('#tools')));
// 下面量左上角一排和右下角那一条压没压着：那一条放回右下角（没拖过的位置）
await js(`localStorage.removeItem('inkthink.toolsPos')`);
await T.go();

// 11b. 本子名很长：名字那块截短，翻页、「单页 / 连续」一对、加页图标不被挤出屏幕，不压着右下角那一条
const longNb = await T.apiJson('/api/notebook/new', { method: 'POST',
  body: JSON.stringify({ title: '暑假旅行计划：从订车票、订酒店到每天的行程和预算的整理与对照记录（第二版，含附录和全部原始票据）', paper: 'portrait' }) });
for (let k = 0; k < 2; k++) await T.api(`/api/notebook/addpage?nb=${encodeURIComponent(longNb.id)}`, { method: 'POST', body: '' });
await T.openNotebook(longNb.id, 0);
lay = await layout();
const cutOf = () => js(`(() => { const n = document.querySelector('#chipName'); return n.scrollWidth > n.clientWidth + 1; })()`);
const cut = await cutOf();
g = await gaps('chip', '#chipNext');
T.ok('本子名很长：名字截短，‹ ›、「单页 / 连续」一对、加页图标都还在屏幕里，不小于 36×36，不压着右下角那一条，一对和旁边照样隔开', cut && lay.n === 6 && lay.rowIn && lay.toolsIn
  && lay.apart && lay.tall && apart(g) && (await chipBtns()) === 'nbChip,chipPrev,chipNext,chipSingle,chipCont,chipAdd' && (await T.text('#chipPage')) === '1/3',
  [cut, lay, g, await chipBtns(), await T.text('#chipPage')]);
await T.shot('4b-long-name.png');

// 11c. 只有一页的本子：没有 ‹ ›、没有「单页 / 连续」那一对，有加页图标
await T.openNotebook(made[0], 0);
T.ok('只有一页的本子：没有 ‹ ›、没有「单页 / 连续」那一对，有加页图标', (await js(`window.__ink.S.nb.pages`)) === 1 && (await chipBtns()) === 'nbChip,chipAdd'
  && !(await T.visible('#chipSingle')) && !(await T.visible('#chipCont')) && isIcon(await iconOf('#chipAdd'), ADD, 'addv'), [await chipBtns(), await iconOf('#chipAdd')]);
lay = await layout();
T.ok('只有一页的本子 834 宽：左上角一排在屏幕里、不压着右下角那一条，按钮不小于 36×36', lay.n === 2 && lay.rowIn && lay.toolsIn && lay.apart && lay.tall, lay);
await T.sleep(1500); // 等打开本子时的提示过去再截图
await T.shot('7-one-page.png');
// 点加页图标：在这一页后面加一张同方向（竖版）的空白页，翻过去；这时 ‹ › 和「单页 / 连续」那一对出来
await T.tap('#chipAdd', 300);
T.ok('点加页图标：变成两页，翻到新加的第 2 页，页码写 2/2', (await at(1, 2)) && (await pg()).chip === '2/2', await pg());
let srv = await srvOf(made[0]);
T.ok('电脑上也多了一页：第 2 页是竖版空白页（和第 1 页一样高）', srv.pages === 2 && srv.pageInfo[1].blank && srv.sizes[1].h === 1414 && (await pg()).baseH === 1414,
  [srv.pages, srv.sizes, await pg()]);
T.ok('两页了：‹ › 和「单页 / 连续」那一对出来了（「连续」选中），加页图标还在最后', (await chipBtns()) === 'nbChip,chipPrev,chipNext,chipSingle,chipCont,chipAdd'
  && (await pairOf('chip')) === 'flow' && (await js(`!document.querySelector('#chipPrev').disabled && document.querySelector('#chipNext').disabled`)), [await chipBtns(), await pairOf('chip')]);
// 在横版页上点加页图标：加出来的是横版（先用抽屉里的图标在第 2 页后面加一张横版页）
await openDrawer();
await tapIn('#actAddLandscape');
const landOk = (await at(2, 3)) && Math.abs((await pg()).baseH - 707.2) < 1;
await closeDrawer();
await T.tap('#chipAdd', 300);
const p4 = (await at(3, 4)) && (await pg());
srv = await srvOf(made[0]);
T.ok('在横版页上点加页图标：加出来的是横版（高约 707），翻到第 4 页', landOk && Boolean(p4) && p4.idx === 3 && p4.chip === '4/4' && Math.abs(p4.baseH - 707.2) < 1
  && srv.pages === 4 && srv.pageInfo[3].blank && Math.abs(srv.sizes[3].h - 707.2) < 1 && srv.sizes[1].h === 1414, [landOk, p4, srv.sizes]);
// 把加出来的三页删掉（抽屉里的删除），回到一页：「单页 / 连续」那一对和 ‹ › 又不见了，加页图标还在
await openDrawer();
for (const [i, n] of [[2, 3], [1, 2], [0, 1]]) { await tapIn('#actDelPage'); await at(i, n); }
await closeDrawer();
srv = await srvOf(made[0]);
T.ok('删回一页：「单页 / 连续」那一对和 ‹ › 又不见了，加页图标还在', (await pg()).pages === 1 && srv.pages === 1 && (await chipBtns()) === 'nbChip,chipAdd'
  && !(await T.visible('#chipSingle')) && !(await T.visible('#chipCont')), [await pg(), srv.pages, await chipBtns()]);

// 11d. 退出全屏：一页时顶栏上也没有「单页 / 连续」那一对，有加页图标；顶栏上的加页图标同样加一页、翻过去
await tap('#toolsBars');
let bb = await shown('#bar button', 'b.id');
T.ok('退出全屏、只有一页：顶栏上没有「单页 / 连续」那一对，有加页图标', bb === 'drawerBtn,prev,next,barAdd,barSize,barCheck,menuBtn' && !(await T.visible('#barSingle'))
  && !(await T.visible('#barCont')) && isIcon(await iconOf('#barAdd'), ADD, 'addv'), [bb, await iconOf('#barAdd')]);
await T.tap('#barAdd', 300);
const pb = (await at(1, 2)) && (await pg());
srv = await srvOf(made[0]);
T.ok('点顶栏上的加页图标：变成两页，翻到第 2 页（竖版），页码写 2/2，电脑上也多了一页', Boolean(pb) && pb.idx === 1 && pb.no === '2/2' && pb.baseH === 1414
  && srv.pages === 2 && srv.pageInfo[1].blank && srv.sizes[1].h === 1414, [pb, srv.pages, srv.sizes]);
bb = await shown('#bar button', 'b.id');
T.ok('两页了：顶栏上的「单页 / 连续」那一对出来了（「连续」选中）', bb === 'drawerBtn,prev,next,barSingle,barCont,barAdd,barSize,barCheck,menuBtn' && (await pairOf('bar')) === 'flow',
  [bb, await pairOf('bar')]);
await tap('#fsBtn');
await T.openNotebook('scratch', 0);

// 12. 英文界面：这些按钮都有英文；四个按钮一行放不下，各占一行，字不被截掉；
//     左上角一排、右下角那一条（放回右下角）在 834 宽时也都在屏幕里、互不重叠
await js(`localStorage.removeItem('inkthink.toolsPos')`);
await T.go(`?k=${T.code}&lang=en`, { raw: true });
T.ok('英文界面：右下角是 Exit full screen', (await T.text('#toolsBars')) === 'Exit full screen', await T.text('#toolsBars'));
lay = await layout();
const tbEn = await fontOf('#toolsBars');
T.ok('英文界面 834 宽：左上角一排和右下角那一条都在屏幕里、互不重叠，Exit full screen 的字在按钮里', lay.n === 6 && lay.rowIn && lay.toolsIn && lay.apart && lay.tall
  && tbEn.fits && tbEn.size >= 14, [lay, tbEn]);
const EN = ['Single page: one page at a time', 'Continuous: pages joined top to bottom', 'Add a blank page after this one'];
ic = await icons('chip');
T.ok('英文界面：左上角的「单页」「连续」「加页」还是没有字的图标，说明是英文', allIcons(ic, EN), ic);
// 英文界面、本子名很长：名字先截短，‹ ›、「单页 / 连续」一对、加页图标都在屏幕里，不压着右下角那一条
await T.openNotebook(longNb.id, 0);
lay = await layout();
const cutEn = await cutOf();
T.ok('英文界面、本子名很长：名字截短，左上角一排都在屏幕里、不压着右下角那一条', cutEn && lay.n === 6 && lay.rowIn && lay.toolsIn && lay.apart && lay.tall
  && (await chipBtns()) === 'nbChip,chipPrev,chipNext,chipSingle,chipCont,chipAdd', [cutEn, lay, await chipBtns()]);
await T.shot('5b-en-long-name.png');
await T.openNotebook('scratch', 0);
await openDrawer();
const en = await js(`[...document.querySelectorAll('#viewRow button')].map((e) => e.textContent).join('|')`);
T.ok('英文界面里开关没有剩下中文', en === 'Continuous|Single page|Fit width|Whole page', en);
const fits = await js(`(() => { const d = document.querySelector('#drawer').getBoundingClientRect();
  return [...document.querySelectorAll('#viewRow button')].every((b) => b.scrollWidth <= b.clientWidth + 1 && b.getBoundingClientRect().right <= d.right - 8); })()`);
T.ok('英文界面里开关的字没被截掉、没超出抽屉', (await T.visible('#viewRow')) && fits);
await T.shot('5-en.png');
await closeDrawer();
await tap('#toolsBars');
const fsEn = await fontOf('#fsBtn');
const barFits = await js(`(() => { const b = document.querySelector('#bar'); return b.scrollWidth <= b.clientWidth + 1; })()`);
T.ok('英文界面退出全屏：左侧的 Full screen 字在按钮里，顶栏放得下', (await T.text('#fsBtn')) === 'Full screen' && fsEn.fits && fsEn.size >= 14 && barFits, [fsEn, barFits]);
ic = await icons('bar');
T.ok('英文界面退出全屏：顶栏上的「单页」「连续」「加页」是没有字的图标，说明是英文', allIcons(ic, EN), ic);
await T.shot('6-en-bars.png');

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

// 套索（2026-11-16 用户定，《产品定义》第 2 节「交互上补的八样」第二批；细节暂定，用户之后在平板上试；纯计算另有 node 单元测试 tests/test_lasso.mjs）。查：
// （2026-11-17 起空白本子里不太长、旁边有空的长回答会摊在纸上：这里的长回答都带 fold: true，查的是收着（圈号）的样子；摊开的见 open_answer.mjs）
// 1. 按钮：右下角那一条、左侧工具栏里橡皮后面一个「套索」，样子、选中的样子、长按看说明都和旁边的工具一样；
// 2. 用笔画一圈（画的时候是细虚线，抬笔自动闭合）：一笔的点有一半以上在圈里的、没擦掉的黑笔红笔被选中，外面一个虚线框；
//    笔迹的数据、画出来的样子一点不变；圈不是笔迹（不存、不进撤销）；圈到一半笔停住也不会「变直」；什么都没圈到就什么都不发生；
// 3. 按住框里拖：拖的时候就画在新地方，抬笔定下；点坐标整体平移，id、时刻、轻重、颜色、粗细不变，不加字段；可以接着再拖；挪得太少算没挪；
//    Claude 的东西里只指着这几笔的（短批注、圈号、圈、勾、两头都在里面的箭头、分组、带连线的新概念、关系词、下划线、小蓝点）跟着走、
//    每一种坐标都挪了同样的量；还指着别的笔迹的、指着一块地方（box）的、示意图、公式不动；读法：整组挪了跟着走，只挪了一部分的先不显示；
//    箭头、概念图上建议的连线只有起点那头指着这几笔的：起点跟着走、终点一点不动，关系词和 ✓ × 钮跟着线的中段，拖的时候就画成新的样子；
// 4. 一次挪动是撤销的一步，撤销回到原样（笔迹、蓝字、读法），重做再挪过去；
// 5. 点框外、换工具、Esc、翻页、换本子、点「AI」、在卡片上落笔：取消选中（卡片上没有套索）；
// 6. 选中时手指照旧挪纸（框跟着视图走）；拖的时候搭上来的手掌不挪纸；
// 7. 书页上挪不出纸边；空白本子挪到纸外面纸跟着长；连续模式下拖不出这一页；交过的笔迹挪了以后不算新写的；
//    书页右边一栏里的短批注留在栏里（不左右走，不压到印刷的字上），只跟着上下走，细线连到笔迹的新位置；它不挡笔迹往右拖；
//    上下走不出纸，碰到栏里别的批注就让开（用它到的时候排页边的办法）；起点指着别处（没记笔迹）的箭头只挪终点；撤销、恢复回到原样；
// 8. 存到电脑上的还是普通的笔迹；英文界面的说明。
// 只在无头 Edge 里跑过：笔是 pointerType 为 pen 的鼠标事件，手指是 CDP 的触摸事件（不是 iPad 上真的笔和手）。
// 跑法：node tests/run_browser.mjs <临时目录> --only lasso；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'lasso', pages: 3 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const PEN = { pointerType: 'pen', button: 'left' };
const waitPen = () => sleep(1150); // 笔刚用过的一秒内手指不算（手掌）

// ---- 笔（页面坐标一次换成屏幕坐标，事件一个接一个发）
async function scr(pts) {
  const v = await js(`(() => { const S = window.__ink.S, r = document.querySelector('#stage').getBoundingClientRect(); return { l: r.left + S.view.tx, t: r.top + S.view.ty, s: S.view.s }; })()`);
  return pts.map((p) => [v.l + p[0] * v.s, v.t + p[1] * v.s]);
}
const mouse = (type, p, buttons) => T.cdp('Input.dispatchMouseEvent', Object.assign({ type, x: p[0], y: p[1], buttons }, type === 'mouseMoved' ? {} : { clickCount: 1 }, PEN));
let tip = null;
async function down(w) { const [p] = await scr([w]); await mouse('mousePressed', p, 1); tip = p; }
async function move(ws) { for (const q of await scr(ws)) { await mouse('mouseMoved', q, 1); tip = q; } }
async function up(wait = 300) { await mouse('mouseReleased', tip, 0); await sleep(wait); }
// 折线上每段 n 等分的点（不含起点）
const path = (pts, n = 12) => pts.slice(1).flatMap((b, k) => Array.from({ length: n }, (_, i) => [pts[k][0] + ((b[0] - pts[k][0]) * (i + 1)) / n, pts[k][1] + ((b[1] - pts[k][1]) * (i + 1)) / n]));
// 套索画一圈：只画到最后一个角（抬笔自动闭合）
async function loop(corners) { await down(corners[0]); await move(path(corners)); await up(); }
// 按住页面上的 from，按屏幕挪 (sx, sy) 像素（分 steps 步），mid 是抬笔前要做的事
async function drag(from, sx, sy, mid, steps = 12) {
  const [a] = await scr([from]);
  await mouse('mousePressed', a, 1);
  for (let i = 1; i <= steps; i++) await mouse('mouseMoved', [a[0] + (sx * i) / steps, a[1] + (sy * i) / steps], 1);
  tip = [a[0] + sx, a[1] + sy];
  if (mid) await mid();
  await up();
}
const touch = (type, p, id = 5) => T.cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: p[0], y: p[1], id, radiusX: 6, radiusY: 6, force: 0.5 }] });
const scribble = (x, y, w, n = 24) => Array.from({ length: n }, (_, i) => [x + (i * w) / (n - 1), y + (i % 2 ? -10 : 10)]);

// ---- 看页面
const strokesNow = () => S(`JSON.parse(JSON.stringify(S.page.strokes, (k, v) => (k.startsWith('_') ? undefined : v)))`);
const aiNow = () => S(`JSON.parse(JSON.stringify(S.page.ai))`);
const readsNow = () => S(`JSON.parse(JSON.stringify(S.page.reads || []))`);
const sel = () => S(`S.sel ? S.sel.ids.slice() : null`);
const lastId = () => S(`S.page.strokes[S.page.strokes.length - 1].id`);
const undoTop = () => S(`JSON.parse(JSON.stringify(S.undo[S.undo.length - 1] || null, (k, v) => (k === 'apart' ? (v || []).length : v)))`);
const drawnReads = () => js(`[...document.querySelectorAll('#aiRoot > g.reads > g.read')].map((g) => { const b = g.getBBox();
  return { k: Number(g.dataset.k), text: [...g.querySelectorAll('text')].map((t) => t.textContent).join(''), b: [b.x, b.y, b.x + b.width, b.y + b.height] }; })`);
// 画布 sel 上，页面坐标的一块 [x0, y0, x1, y1] 里最不透明的像素
const alphaIn = (sel, b) => js(`(() => { const c = document.querySelector('${sel}'), r = c.getBoundingClientRect(), d = c.width / r.width, v = window.__ink.S.view, st = document.querySelector('#stage').getBoundingClientRect();
  const X = (x) => Math.round((st.left + v.tx + x * v.s - r.left) * d), Y = (y) => Math.round((st.top + v.ty + y * v.s - r.top) * d);
  const x0 = Math.max(0, X(${b[0]})), y0 = Math.max(0, Y(${b[1]})), w = Math.max(1, Math.min(c.width, X(${b[2]})) - x0), h = Math.max(1, Math.min(c.height, Y(${b[3]})) - y0);
  const px = c.getContext('2d').getImageData(x0, y0, w, h).data; let m = 0; for (let i = 3; i < px.length; i += 4) m = Math.max(m, px[i]); return m; })()`);
// 墨迹层上一块的指纹（每个像素的颜色都算进去）和有墨的像素数：笔迹画出来的样子变没变
const inkPrint = (b) => js(`(() => { const c = document.querySelector('#ink'), r = c.getBoundingClientRect(), d = c.width / r.width, v = window.__ink.S.view, st = document.querySelector('#stage').getBoundingClientRect();
  const X = (x) => Math.round((st.left + v.tx + x * v.s - r.left) * d), Y = (y) => Math.round((st.top + v.ty + y * v.s - r.top) * d);
  const px = c.getContext('2d').getImageData(X(${b[0]}), Y(${b[1]}), X(${b[2]}) - X(${b[0]}), Y(${b[3]}) - Y(${b[1]})).data; let h = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) { h = (h * 31 + px[i] * 7 + px[i + 1] * 3 + px[i + 2] + px[i + 3] * 11) >>> 0; if (px[i + 3]) n++; } return [h, n]; })()`);
const ptsBox = (ss) => { let b = [Infinity, Infinity, -Infinity, -Infinity]; for (const s of ss) for (const p of s.pts) b = [Math.min(b[0], p[0] - s.w), Math.min(b[1], p[1] - s.w), Math.max(b[2], p[0] + s.w), Math.max(b[3], p[1] + s.w)]; return b; };
const grow = (b, m) => [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
const meet = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byId = (list, id) => list.find((s) => s.id === id);
// 虚线框在不在（上面那层，框的上边那一条里有没有墨）：选中的几笔的外框四周放出 8 个屏幕像素
async function frameAt(ss) {
  const s = await S('S.view.s'), F = grow(ptsBox(ss), 8 / s), e = 2 / s;
  return (await alphaIn('#live', [F[0] + 10 / s, F[1] - e, F[2] - 10 / s, F[1] + e])) > 0 && (await alphaIn('#live', [F[0] - e, F[1] + 10 / s, F[0] + e, F[3] - 10 / s])) > 0;
}

// a 是 b 整体挪了 (dx, dy) 的样子：每一种页面坐标都挪了这么多，别的字段一点不变（和 static/lasso.js 分开写的一份，对着查）
const nums = (d) => (String(d).match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
function movedBy(b, a, dx, dy) {
  const bad = [], near = (u, v) => Math.abs(u - v) <= 0.051;
  const chk = (key, u, v, d) => { if (!near(v, u + d)) bad.push(`${key}: ${u} → ${v}`); };
  const box = (key, p, q) => { if (Array.isArray(p) && p.length === 4) [0, 1, 2, 3].forEach((i) => chk(key, p[i], q && q[i], i % 2 ? dy : dx)); };
  const xy = (key, p, q, kx = 'x', ky = 'y') => { if (p && typeof p[kx] === 'number') { chk(key, p[kx], q && q[kx], dx); chk(key, p[ky], q && q[ky], dy); } };
  const walk = (p, q, pre) => {
    for (const k of ['box', 'vbox', 'hit', 'sym', 'labelOf']) box(pre + k, p[k], q[k]);
    if (Array.isArray(p.at)) { chk(pre + 'at', p.at[0], q.at && q.at[0], dx); chk(pre + 'at', p.at[1], q.at && q.at[1], dy); }
    xy(pre + 'lay', p.lay, q.lay);
    xy(pre + 'fig', p.fig, q.fig);
    (p.labels || []).forEach((l, i) => xy(pre + 'labels', l, (q.labels || [])[i]));
    (p.paths || []).forEach((x, i) => { const u = nums(x.d), v = nums(((q.paths || [])[i] || {}).d); if (u.length !== v.length) bad.push(pre + 'paths 数字个数'); u.forEach((n, j) => chk(pre + 'paths', n, v[j], j % 2 ? dy : dx)); });
    if (p.dot && p.dot.at) { chk(pre + 'dot', p.dot.at[0], q.dot && q.dot.at[0], dx); chk(pre + 'dot', p.dot.at[1], q.dot && q.dot.at[1], dy); }
    xy(pre + 'popMap', p.popMap, q.popMap, 'x0', 'y0');
    xy(pre + 'fromMap', p.fromMap, q.fromMap, 'x0', 'y0');
    if (p.from) walk(p.from, q.from || {}, pre + 'from.');
  };
  walk(b, a, '');
  const strip = (o) => {
    const c = JSON.parse(JSON.stringify(o));
    const one = (x) => {
      for (const k of ['box', 'vbox', 'hit', 'sym', 'labelOf', 'at']) delete x[k];
      for (const k of ['lay', 'fig']) if (x[k]) { delete x[k].x; delete x[k].y; }
      for (const l of x.labels || []) { delete l.x; delete l.y; }
      for (const p of x.paths || []) delete p.d;
      if (x.dot) delete x.dot.at;
      for (const k of ['popMap', 'fromMap']) if (x[k]) { delete x[k].x0; delete x[k].y0; }
      if (x.from) one(x.from);
    };
    one(c);
    return c;
  };
  if (!same(strip(b), strip(a))) bad.push('别的字段变了');
  return bad;
}
// 箭头、连线的线身「M 起点 Q 控制点 终点」和箭头「M 一边 L 终点 L 另一边」的尖（和 static/lasso.js 分开写的一份）
const shaft = (a) => { const n = nums(a.paths[0].d); return { p1: [n[0], n[1]], c: [n[2], n[3]], p2: [n[4], n[5]], tip: a.paths[1] ? nums(a.paths[1].d).slice(2, 4) : null }; };
const midOf = (g) => [(g.p1[0] + 2 * g.c[0] + g.p2[0]) / 4, (g.p1[1] + 2 * g.c[1] + g.p2[1]) / 4]; // 线身弯线的中点
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const labC = (a) => [a.lay.x + a.lay.w / 2, a.lay.y + a.lay.h / 2];
// 除了带坐标的字段，别的一点没变
const COORDS = ['box', 'vbox', 'hit', 'sym', 'labelOf', 'at', 'lay', 'fig', 'labels', 'paths', 'dot', 'popMap', 'fromMap', 'from'];
const restSame = (b, a) => { const s = (o) => { const c = JSON.parse(JSON.stringify(o)); for (const k of COORDS) delete c[k]; return c; }; return same(s(b), s(a)); };

if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); } // 先在单页里测（连续模式在第 12 步）

// ================= 1. 按钮
const btns = await js(`[...document.querySelectorAll('#tools button')].map((b) => b.dataset.tool || b.id).join()`);
T.ok('右下角那一条：橡皮后面是「套索」（2026-11-17 起「AI」左边多了回答要多长的开关）', btns === 'toolsBars,pen,red,eraser,lasso,toolsUndo,toolsRedo,sizeBtn,check', btns);
const look = (q) => js(`(() => { const b = document.querySelector('${q}'), r = b.getBoundingClientRect(), c = getComputedStyle(b), s = b.querySelector('svg');
  return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), radius: c.borderTopLeftRadius, border: c.borderTopWidth + ' ' + c.borderTopStyle + ' ' + c.borderTopColor,
    bg: c.backgroundColor, shadow: c.boxShadow, color: c.color, icon: b.dataset.icon, marks: s ? s.children.length : 0, text: b.textContent.trim(), label: b.getAttribute('aria-label'), on: b.classList.contains('on') }; })()`);
const LABEL = '套索：圈住你的几笔，按住框里拖到别处';
let E = await look('#tools [data-tool=eraser]'), La = await look('#tools [data-tool=lasso]');
T.ok('「套索」是图标按钮（有图没有字），和橡皮一样大、同一行、同样的圆角和边框', La.icon === 'lasso' && La.marks >= 2 && La.text === '' && La.w === E.w && La.h === E.h && La.top === E.top
  && La.radius === E.radius && La.border === E.border, [E, La]);
T.ok('长按说明写着「套索：……」，左侧工具栏上的一字不差', La.label === LABEL && (await js(`document.querySelector('#rail [data-tool=lasso]').getAttribute('aria-label')`)) === LABEL, La.label);
await T.tool('eraser');
E = await look('#tools [data-tool=eraser]');
await T.tool('lasso');
La = await look('#tools [data-tool=lasso]');
const E2 = await look('#tools [data-tool=eraser]');
T.ok('点一下选上：和选上的橡皮一个样子（白底、加粗的边框、线条颜色），橡皮不再选着', (await S('S.tool')) === 'lasso' && La.on && !E2.on && E.on
  && La.bg === E.bg && La.border === E.border && La.shadow === E.shadow && La.color === E.color, [E, La]);
await T.tool('pen');
// 长按：屏幕上方说它是什么，这次松手不换工具
const lc = await T.centerOf('#tools [data-tool=lasso]');
await T.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: lc[0], y: lc[1], button: 'left', buttons: 1, clickCount: 1 });
await sleep(750);
await T.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: lc[0], y: lc[1], button: 'left', buttons: 0, clickCount: 1 });
await sleep(200);
T.ok('长按「套索」：屏幕上方写着它的说明，松手后工具还是黑笔', (await js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`)) === LABEL && (await S('S.tool')) === 'pen',
  [await js(`document.querySelector('#toast').textContent`), await S('S.tool')]);
await T.tap('#toolsBars');
const rail = await js(`[...document.querySelectorAll('#rail button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.dataset.tool || b.id).join()`);
const RE = await look('#rail [data-tool=eraser]'), RL = await look('#rail [data-tool=lasso]');
T.ok('退出全屏：左侧工具栏橡皮下面是「套索」，和橡皮一样大', rail === 'pen,red,eraser,lasso,undo,redo,fsBtn' && RL.w === RE.w && RL.h === RE.h && RL.icon === 'lasso', [rail, RE, RL]);
await T.tap('#fsBtn');

// ================= 2. 写字，交给 Claude，Claude 回各种批注和读法
const ids = {};
await T.pen(scribble(150, 200, 200)); ids.A = await lastId();           // gA：圈里
await T.tool('red');
await T.pen(scribble(150, 330, 200)); ids.B = await lastId();           // gB：红笔问题，圈里
await T.tool('pen');
await T.pen(scribble(150, 460, 200), 250); ids.C = await lastId();      // gC 的第一笔：圈里
await T.pen(scribble(390, 480, 210), 250); ids.C2 = await lastId();     // gC 的第二笔：圈外（和上一笔一组）
await T.pen(scribble(150, 900, 200)); ids.D = await lastId();           // gD：圈外
await T.pen(scribble(150, 600, 150)); ids.E = await lastId();           // 圈里，等一下擦掉
await T.pen(scribble(300, 560, 400)); ids.F = await lastId();           // 只有四分之一的点在圈里
await T.tool('eraser');
await T.pen([[140, 605], [230, 606], [320, 605]]);
await T.tool('pen');
T.ok('（前提）写了 7 笔，擦掉了一笔', (await S('S.page.strokes.length')) === 7 && (await S(`S.page.strokes.find((s) => s.id === '${ids.E}').erasedAt > 0`)));
await T.tap('#check');
const sub = await T.waitSub('S1'), meta = sub && T.metaOf(sub);
const gOf = (id) => meta.groups.find((g) => g.ids.includes(id)).id;
T.ok('（前提）交上去了：A、B、C、D 各是一组，C 的两笔在一组', Boolean(meta) && new Set([gOf(ids.A), gOf(ids.B), gOf(ids.C), gOf(ids.D)]).size === 4 && gOf(ids.C) === gOf(ids.C2),
  meta && meta.groups.map((g) => [g.id, g.ids]));
const gA = gOf(ids.A), gB = gOf(ids.B), gC = gOf(ids.C), gD = gOf(ids.D), c = meta.crop;
const px = (b) => [(b[0] - c.x0) * c.scale, (b[1] - c.y0) * c.scale, (b[2] - c.x0) * c.scale, (b[3] - c.y0) * c.scale];
const rep = await T.post('/bridge/reply', { sid: 'S1', submission: sub.id, items: [
  { type: 'note', anchor: gA, text: '这一行少了单位' },
  { type: 'write', fold: true, anchor: gB, q: '这一步对吗？', text: '对。\n第二行。' },
  { type: 'circle', anchor: gA },
  { type: 'tick', anchor: gA, text: '对' },
  { type: 'arrow', from: gA, to: gB, text: '推出' },
  { type: 'arrow', from: gA, to: gD },
  { type: 'group', anchors: [gA, gB], text: '一类' },
  { type: 'group', anchors: [gA, gD], text: '另一类' },
  { type: 'node', anchor: gA, text: '新概念', links: [gB] },
  { type: 'node', anchor: gA, text: '外面的', links: [gD] },
  { type: 'label', anchor: gA, text: '关系' },
  { type: 'underline', anchor: gB },
  { type: 'note', anchor: gC, text: '还指着外面' },
  { type: 'write', fold: true, anchor: gC, q: '这组呢？', text: '这组的回答。' },
  { type: 'note', box: px([160, 560, 300, 590]), text: '指着一块地方' },
  { type: 'sketch', anchor: gA, nodes: ['甲', '乙'], edges: [{ from: '甲', to: '乙' }], text: '示意' },
  { type: 'formula', anchor: gA, tex: 'E=mc^2' },
  { type: 'note', anchor: gB, text: '压成小蓝点' },
  { type: 'read', anchor: gA, text: '第一行' }, { type: 'read', anchor: gC, text: '分开的一行' }, { type: 'read', anchor: gD, text: '远处' },
  { type: 'link', from: gA, to: gD, text: '导致' }] }); // 放在最后：前面那些落在哪不受它影响
T.ok('（前提）服务收下了 22 条', rep.ok === true && rep.count === 22, rep);
const landed = await T.waitFor(`window.__ink.S.page.ai.length + (window.__ink.S.page.reads || []).length >= 22`, 15000);
await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
T.ok('（前提）都落到这一页了', landed && (await T.waitFor('window.__written', 60000)), await S('S.page.ai.map((a) => a.type)'));
// 「压成小蓝点」那条收成小蓝点：直接记上 dot（和黑笔压到它时 foldNote 记的一样；短批注落在哪随字体载入的快慢变，用笔压它时那一笔
// 有时会落进圈里，所以不用笔）
await S(`(() => { const a = S.page.ai.find((o) => o.text === '压成小蓝点'); a.dot = { at: [Math.round(a.lay.x + 7), Math.round(a.lay.y + 7)], t: Date.now(), why: 'ink' };
  window.__ink.renderAI(); return 1; })()`);
T.ok('（前提）那条批注收成了小蓝点', await S(`Boolean(window.__ink.isDot(S.page.ai.find((a) => a.text === '压成小蓝点')))`));
await T.shot('lasso-landed.png');
await js(`window.__ink.setReads(true)`);
await sleep(300);
const item = (list, f) => list.find(f);
const pick = {
  noteA: (a) => a.text === '这一行少了单位', writeB: (a) => a.type === 'write' && a.q === '这一步对吗？', circle: (a) => a.type === 'circle', tick: (a) => a.type === 'tick',
  arrowAB: (a) => a.type === 'arrow' && a.text === '推出', groupAB: (a) => a.type === 'group' && a.text === '一类', nodeB: (a) => a.type === 'node' && a.text === '新概念',
  label: (a) => a.type === 'label', underline: (a) => a.type === 'underline', dot: (a) => a.text === '压成小蓝点',
};
const stay = {
  groupAD: (a) => a.type === 'group' && a.text === '另一类', nodeD: (a) => a.type === 'node' && a.text === '外面的',
  noteC: (a) => a.text === '还指着外面', writeC: (a) => a.type === 'write' && a.q === '这组呢？', noteBox: (a) => a.text === '指着一块地方',
  sketch: (a) => a.type === 'sketch', formula: (a) => a.type === 'formula',
};
const bend = { arrowAD: (a) => a.type === 'arrow' && !a.text, linkAD: (a) => a.type === 'link' && a.text === '导致' }; // 起点指着 A（圈里）、终点指着 D（圈外）
const AI0 = await aiNow(), ST0 = await strokesNow(), RD0 = await readsNow(), RL0 = await drawnReads();
T.ok('（前提）要查的每一条都在', [...Object.values(pick), ...Object.values(stay), ...Object.values(bend)].every((f) => AI0.some(f)), AI0.map((a) => [a.type, a.text]));
T.ok('（前提）三条读法都画出来了', ['第一行', '分开的一行', '远处'].every((t) => RL0.some((r) => r.text === t)), RL0);

// ================= 3. 画一圈选中：第一条边画完后笔停住（不能「变直」）；圈里的选中，框出来；样子不变；不是笔迹
await T.tool('lasso');
const n0 = (await S('S.page.strokes.length')), u0 = await S('S.undo.length');
const ink0 = await inkPrint(grow(ptsBox(ST0.filter((s) => [ids.A, ids.B, ids.C].includes(s.id))), 6));
const LOOP = [[110, 160], [400, 160], [400, 640], [110, 640]];
await down(LOOP[0]);
await move(path(LOOP.slice(0, 2), 20));
await sleep(900); // 笔停住（这期间没有移动事件）
const held = await S(`({ cur: S.cur, n: S.lasso && S.lasso.pts.length, sl: Boolean(S.lasso && S.lasso._sl) })`);
const lineShown = await alphaIn('#live', [130, 158, 380, 162]);
await move(path(LOOP.slice(1), 12));
await up();
T.ok('画圈时第一条边画完停住：不是在写字（没有正写着的一笔），圈的点照旧，不会「变直」', held.cur === null && held.n >= 20 && !held.sl, held);
T.ok('画的时候是一条线（上面那层有墨）', lineShown > 0, lineShown);
T.ok('抬笔：圈里的三笔（黑、红、黑）选中；擦掉的、只有四分之一在圈里的、圈外的不选', same((await sel()), [ids.A, ids.B, ids.C]), await sel());
T.ok('圈不是笔迹：笔迹没多、撤销记录没多', (await S('S.page.strokes.length')) === n0 && (await S('S.undo.length')) === u0 && (await S('S.lasso')) === null);
T.ok('选中后：笔迹的数据一点没变（颜色、粗细、点）', same(await strokesNow(), ST0));
T.ok('选中后：墨迹层上那几笔画出来的样子一点没变（每个像素一样），上面那层没有压在笔迹上的东西', same(await inkPrint(grow(ptsBox(ST0.filter((s) => [ids.A, ids.B, ids.C].includes(s.id))), 6)), ink0)
  && ink0[1] > 50 && (await alphaIn('#live', [160, 195, 340, 205])) === 0 && (await alphaIn('#live', [160, 455, 340, 465])) === 0, ink0);
T.ok('圈的虚线没了，选中的外面有一个虚线框', (await alphaIn('#live', [130, 158, 380, 162])) === 0 && (await alphaIn('#live', [108, 200, 112, 600])) === 0
  && (await frameAt(ST0.filter((s) => [ids.A, ids.B, ids.C].includes(s.id)))));
await T.shot('lasso-selected.png');

// 再画一圈（圈住 D）：换成选中 D；圈在空白处：什么都没选，什么都没发生
await loop([[120, 870], [380, 870], [380, 935], [120, 935]]);
T.ok('在框外再画一圈：原来的取消，换成新圈里的', same(await sel(), [ids.D]), await sel());
await loop([[700, 1200], [900, 1200], [900, 1350], [700, 1350]]);
T.ok('圈在空白处：什么都没选中，笔迹、撤销都没变', (await sel()) === null && (await S('S.page.strokes.length')) === n0 && (await S('S.undo.length')) === u0);
await loop(LOOP);
T.ok('（前提）又选中了三笔', same(await sel(), [ids.A, ids.B, ids.C]), await sel());

// ================= 4. 拖：拖的时候就画在新地方；抬笔定下；跟着走的批注、读法
const SX = 270, SY = 360; // 屏幕上挪多少像素
const s0 = await S('S.view.s'), DX = SX / s0, DY = SY / s0;
let midInk = null;
await drag([250, 330], SX, SY, async () => {
  midInk = { oldInk: await alphaIn('#ink', [200, 195, 300, 205]), newLive: await alphaIn('#live', [200 + DX, 195 + DY, 300 + DX, 205 + DY]),
    data: same(await strokesNow(), ST0), tf: await js(`(() => { const S = window.__ink.S, g = (f) => document.querySelector('#aiRoot > [data-id="' + S.page.ai.find(f).id + '"]');
      return [g((a) => a.text === '这一行少了单位').getAttribute('transform'), g((a) => a.type === 'write' && a.q === '这一步对吗？').getAttribute('transform'), g((a) => a.text === '还指着外面').getAttribute('transform')]; })()`),
    bend: await js(`(() => { const S = window.__ink.S; return [(a) => a.type === 'arrow' && !a.text, (a) => a.type === 'link' && a.text === '导致'].map((f) => {
      const g = document.querySelector('#aiRoot > [data-id="' + S.page.ai.find(f).id + '"]'), t = g.querySelector(':scope > text');
      return { d: g.querySelector(':scope > path').getAttribute('d'), tf: g.getAttribute('transform'), lab: t && t.getAttribute('transform') }; }); })()`) };
});
T.ok('拖的时候：那几笔已经画在新地方（原处的墨迹层上没了），数据还没改', midInk.oldInk === 0 && midInk.newLive > 0 && midInk.data, midInk);
T.ok('拖的时候：跟着走的批注、圈号一起挪着，不跟的不动', Boolean(midInk.tf[0]) && Boolean(midInk.tf[1]) && !midInk.tf[2], midInk.tf);
const U1 = await undoTop();
T.ok('抬笔：撤销记录里多了一步「挪动」，挪的是这三笔，量和拖的一样（一位小数）', U1 && U1.t === 'move' && same(U1.ids, [ids.A, ids.B, ids.C]) && Math.abs(U1.dx - DX) < 0.6 && Math.abs(U1.dy - DY) < 0.6
  && Math.abs(U1.dx * 10 - Math.round(U1.dx * 10)) < 1e-9, U1);
const dx1 = U1.dx, dy1 = U1.dy, ST1 = await strokesNow();
const r1 = (v) => Math.round(v * 10) / 10;
const shifted = (b, a, dx, dy) => a.id === b.id && a.t0 === b.t0 && a.w === b.w && a.c === b.c && same(Object.keys(a).sort(), Object.keys(b).sort()) && a.pts.length === b.pts.length
  && a.pts.every((p, i) => p[0] === r1(b.pts[i][0] + dx) && p[1] === r1(b.pts[i][1] + dy) && p[2] === b.pts[i][2] && p[3] === b.pts[i][3] && p.length === b.pts[i].length);
T.ok('选中的三笔：每个点都挪了同一个量，id、开始时刻、每个点的时刻和轻重、颜色、粗细都没变，没多字段', [ids.A, ids.B, ids.C].every((id) => shifted(byId(ST0, id), byId(ST1, id), dx1, dy1)),
  [byId(ST0, ids.A).pts[0], byId(ST1, ids.A).pts[0]]);
T.ok('别的笔（同组的圈外那一笔、圈外的、擦掉的、只有四分之一在圈里的）一点没动', [ids.C2, ids.D, ids.E, ids.F].every((id) => same(byId(ST0, id), byId(ST1, id))));
T.ok('挪过的笔重新算了外框（缓存清掉了）', await S(`[${JSON.stringify(ids.A)}, ${JSON.stringify(ids.C)}].every((id) => { const s = S.page.strokes.find((x) => x.id === id); return s._box === undefined
  || (Math.abs(s._box[0] - (Math.min(...s.pts.map((p) => p[0])) - s.w)) < 1e-9 && Math.abs(s._box[3] - (Math.max(...s.pts.map((p) => p[1])) + s.w)) < 1e-9); })`));
const AI1 = await aiNow();
for (const [k, f] of Object.entries(pick)) {
  const bad = movedBy(item(AI0, f), item(AI1, f), dx1, dy1);
  T.ok(`跟着走：${k} 的每一种坐标都挪了同样的量，别的没变`, bad.length === 0, bad.slice(0, 6));
}
for (const [k, f] of Object.entries(stay)) T.ok(`不跟：${k} 一点没动`, same(item(AI0, f), item(AI1, f)), [item(AI0, f), item(AI1, f)].map((a) => a && (a.box || a.at)));
// 只有起点那头指着圈里的箭头、连线：起点跟着走，终点不动（2026-11-17）
for (const [k, f] of Object.entries(bend)) {
  const b = item(AI0, f), a = item(AI1, f), s0 = shaft(b), s1 = shaft(a);
  T.ok(`一头跟着走：${k} 的起点挪了同样的量，终点连同箭头尖一点没动`, dist(s1.p1, [s0.p1[0] + dx1, s0.p1[1] + dy1]) < 0.08 && same(s1.p2, s0.p2) && same(s1.tip, s0.tip) && same(s0.tip, s0.p2), [s0, s1]);
  T.ok(`一头跟着走：${k} 的点、擦的范围包着新的两头，带坐标以外的字段一点没变`, restSame(b, a) && a.hit[0] <= Math.min(s1.p1[0], s1.p2[0]) && a.hit[1] <= Math.min(s1.p1[1], s1.p2[1])
    && a.hit[2] >= Math.max(s1.p1[0], s1.p2[0]) && a.hit[3] >= Math.max(s1.p1[1], s1.p2[1]), [a.hit, s1]);
}
{
  const b = item(AI0, bend.arrowAD), a = item(AI1, bend.arrowAD);
  T.ok('一头跟着走：箭头的 box（终点那块）没动', same(a.box, b.box), [b.box, a.box]);
  const lb = item(AI0, bend.linkAD), la = item(AI1, bend.linkAD), m0 = midOf(shaft(lb)), m1 = midOf(shaft(la));
  T.ok('一头跟着走：连线的关系词跟着线的中段（离新的中点不比原来离旧的中点远多少），✓ × 钮围着的框跟着它', dist(labC(la), m1) <= dist(labC(lb), m0) + 25 && dist(labC(la), labC(lb)) > 50
    && [la.lay.x - 6, la.lay.y - 4, la.lay.x + la.lay.w + 6, la.lay.y + la.lay.h + 4].every((v, i) => Math.abs(v - la.vbox[i]) < 0.16) && same(la.box, la.vbox) && same([la.lay.w, la.lay.h, la.lay.lines], [lb.lay.w, lb.lay.h, lb.lay.lines]),
    [labC(lb), m0, labC(la), m1, la.vbox]);
  const d0 = item(AI0, bend.arrowAD), mb = midInk.bend.map((x) => ({ n: nums(x.d), tf: x.tf, lab: x.lab }));
  const pre = [shaft(d0), shaft(lb)];
  T.ok('一头跟着走：拖的时候就画成新的样子（起点在拖到的地方、终点没动，整组没有平移，关系词挪着）', mb.every((x, i) => dist([x.n[0], x.n[1]], [pre[i].p1[0] + DX, pre[i].p1[1] + DY]) < 0.3
    && same([x.n[4], x.n[5]], pre[i].p2) && !x.tf) && Boolean(mb[1].lab), [mb, pre]);
  const vb = await js(`(() => { const S = window.__ink.S, a = S.page.ai.find((o) => o.type === 'link' && o.text === '导致');
    return { vb: [...document.querySelectorAll('#aiRoot [data-id="' + a.id + '"] .vbtn circle')].map((c) => [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))]), d: document.querySelector('#aiRoot [data-id="' + a.id + '"] > path').getAttribute('d'), tf: document.querySelector('#aiRoot [data-id="' + a.id + '"] > text').getAttribute('transform') }; })()`);
  const LB = [la.lay.x, la.lay.y, la.lay.x + la.lay.w, la.lay.y + la.lay.h];
  T.ok('一头跟着走：抬笔后按数据重画，连线的 ✓ × 钮在挪过去的关系词旁边', vb.vb.length === 2 && vb.vb.every(([x, y]) => x > LB[0] - 120 && x < LB[2] + 120 && y > LB[1] - 80 && y < LB[3] + 80)
    && vb.d === la.paths[0].d && !vb.tf, [vb, LB]);
}
const dom = await js(`(() => { const S = window.__ink.S, id = (f) => S.page.ai.find(f).id, q = (s) => document.querySelector(s);
  const w = S.page.ai.find((a) => a.type === 'write' && a.q === '这一步对吗？'), d = S.page.ai.find((a) => a.text === '压成小蓝点'), n = S.page.ai.find((a) => a.type === 'node' && a.text === '新概念');
  const vb = [...document.querySelectorAll('#aiRoot [data-id="' + n.id + '"] .vbtn circle')].map((c) => [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))]);
  return { badge: [Number(q('#aiRoot .badge[data-id="' + w.id + '"] circle').getAttribute('cx')), w.at[0]], dot: [Number(q('#aiRoot .ai-dot[data-id="' + d.id + '"] .pt').getAttribute('cx')), d.dot.at[0]],
    vb, vbox: n.vbox }; })()`);
T.ok('圈号、小蓝点画在挪过去的地方', Math.abs(dom.badge[0] - dom.badge[1]) < 0.11 && Math.abs(dom.dot[0] - dom.dot[1]) < 0.11, dom);
T.ok('跟着走的新概念的 ✓ × 钮跟着到了它旁边', dom.vb.length === 2 && dom.vb.every(([x, y]) => x > dom.vbox[0] - 120 && x < dom.vbox[2] + 120 && y > dom.vbox[1] - 80 && y < dom.vbox[3] + 80), dom);
// 读法：整组挪了的跟着走；只挪了一部分（C 那组）的先不显示；圈外的不动
const RL1 = await drawnReads(), RD1 = await readsNow(), boxA1 = ptsBox([byId(ST1, ids.A)]), boxA0 = ptsBox([byId(ST0, ids.A)]);
const lab = (list, t) => list.find((r) => r.text === t);
T.ok('读法：A 那组挪了，它的小灰字跟到了新地方', Boolean(lab(RL1, '第一行')) && meet(grow(boxA1, 60), lab(RL1, '第一行').b) && !meet(grow(boxA0, 30), lab(RL1, '第一行').b), [lab(RL0, '第一行'), lab(RL1, '第一行')]);
T.ok('读法：C 那组只挪了一半，读法先不显示（记上 apart），别的读法也没顶上来', !lab(RL1, '分开的一行') && RD1.find((r) => r.text === '分开的一行').apart === true && RL1.length === 2, RL1);
T.ok('读法：D 那组没挪，小灰字原地不动', same(lab(RL0, '远处'), lab(RL1, '远处')), [lab(RL0, '远处'), lab(RL1, '远处')]);
T.ok('挪完还选着，虚线框跟到了新地方', same(await sel(), [ids.A, ids.B, ids.C]) && (await frameAt(ST1.filter((s) => [ids.A, ids.B, ids.C].includes(s.id)))));
await T.shot('lasso-moved.png');
// 存到电脑上：普通的笔迹，点就是挪过的
T.ok('（前提）存上了', await T.saved());
const disk = T.pageFile('scratch', 0);
T.ok('页面文件里：挪过的笔还是 id、t0、w、pts（红笔多一个 c），点和页面上的一样', [ids.A, ids.B, ids.C].every((id) => { const d = byId(disk.strokes, id), s = byId(ST1, id);
  return d && same(Object.keys(d).sort(), id === ids.B ? ['c', 'id', 'pts', 't0', 'w'] : ['id', 'pts', 't0', 'w']) && same(d.pts, s.pts) && d.t0 === s.t0; }));

// ================= 5. 接着再拖；挪得太少算没挪；撤销、重做
await drag([250 + dx1, 330 + dy1], -60, -30);
const U2 = await undoTop(), ST2 = await strokesNow(), AI2 = await aiNow();
T.ok('接着再拖：又是一步「挪动」，三笔又挪了', U2.t === 'move' && (await S('S.undo.length')) === u0 + 2 && [ids.A, ids.B, ids.C].every((id) => shifted(byId(ST1, id), byId(ST2, id), U2.dx, U2.dy)),
  [U2, await S('S.undo.length'), u0]);
await drag([250 + dx1 + U2.dx, 330 + dy1 + U2.dy], 2, 1);
T.ok('只挪了两三个像素：算没挪（笔迹、撤销都没变）', same(await strokesNow(), ST2) && (await S('S.undo.length')) === u0 + 2);
await T.tap('#toolsUndo');
T.ok('撤销一次：回到第一次挪完的样子（笔迹、批注），套索选中的取消了', same(await strokesNow(), ST1) && same(await aiNow(), AI1) && (await sel()) === null);
await T.tap('#toolsUndo');
T.ok('再撤销一次：笔迹回到原样（每个点一样）', same(await strokesNow(), ST0));
T.ok('批注也回到原样（每一条每个字段一样）', same(await aiNow(), AI0), (await aiNow()).filter((a, i) => !same(a, AI0[i])).map((a) => a.type));
const RL2 = await drawnReads();
T.ok('读法也回来了：C 那组的读法又显示了（apart 去掉），三条小灰字和原来一样', same(RL2, RL0) && !(await readsNow()).some((r) => r.apart), [RL0, RL2]);
await T.tap('#toolsRedo');
await T.tap('#toolsRedo');
T.ok('重做两次：笔迹、批注都和第二次挪完一样', same(await strokesNow(), ST2) && same(await aiNow(), AI2));
T.ok('重做后 C 那组的读法又是不显示', (await readsNow()).find((r) => r.text === '分开的一行').apart === true && !(await drawnReads()).some((r) => r.text === '分开的一行'));

// ================= 6. 取消选中：点框外、换工具、Esc、翻页、在卡片上落笔、点「AI」
const P = [dx1 + U2.dx, dy1 + U2.dy];
const LOOP2 = [[110 + P[0], 160 + P[1]], [400 + P[0], 160 + P[1]], [400 + P[0], 560 + P[1]], [110 + P[0], 560 + P[1]]];
const reselect = async () => { await loop(LOOP2); return same(await sel(), [ids.A, ids.B, ids.C]); };
T.ok('（前提）圈住挪过去的三笔，选中了', await reselect(), await sel());
await down([1200, 1700]); await up();
T.ok('用笔点框外：取消选中，没留下笔迹', (await sel()) === null && (await S('S.page.strokes.length')) === n0);
await reselect();
await T.tool('pen');
T.ok('换工具：取消选中', (await sel()) === null);
await T.tool('lasso');
T.ok('换回套索：还是没选中', (await sel()) === null && (await alphaIn('#live', grow(LOOP2[0].concat(LOOP2[2]), 20))) === 0);
await reselect();
await T.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await T.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(200);
T.ok('按 Esc：取消选中', (await sel()) === null);
await reselect();
await T.openPage(1);
T.ok('翻到第 2 页：没有选中的', (await sel()) === null);
await T.openPage(0);
T.ok('翻回来：也没有选中的，没有虚线框', (await sel()) === null && (await alphaIn('#live', grow(LOOP2[0].concat(LOOP2[2]), 20))) === 0);
// 卡片开着时用套索在卡片上落笔：卡片收起，不画圈（卡片上没有套索）
await waitPen();
const bw = await js(`(() => { const w = window.__ink.S.page.ai.find((a) => a.type === 'write' && a.q === '这一步对吗？'), c = document.querySelector('#aiRoot .badge[data-id="' + w.id + '"] circle').getBoundingClientRect(); return [c.left + c.width / 2, c.top + c.height / 2]; })()`);
await T.fingerTapAt(bw[0], bw[1]);
T.ok('（前提）手指点圈号：卡片开着', await S('Boolean(S.card)'));
const cc = await T.centerOf('#answerCard');
await mouse('mousePressed', cc, 1); tip = cc; await up();
T.ok('套索在卡片上落笔：卡片收起，没画圈、没选中、没留笔迹', !(await S('Boolean(S.card)')) && (await S('S.lasso')) === null && (await sel()) === null && (await S('S.page.strokes.length')) === n0);
await reselect();
await T.tap('#check');
T.ok('点「AI」：先取消选中，虚线框没了', (await sel()) === null && (await alphaIn('#live', grow(LOOP2[0].concat(LOOP2[2]), 20))) === 0);
T.ok('照常交上去了', Boolean(await T.waitSub('S1')));

// ================= 7. 选中时手指照旧挪纸，框跟着视图走；拖的时候搭上来的手掌不挪纸
await reselect();
await waitPen();
const v0 = await S('({ ...S.view })');
const fp = (await scr([[700, 1500]]))[0];
await touch('touchStart', fp);
for (let i = 1; i <= 6; i++) { await touch('touchMove', [fp[0], fp[1] - i * 25]); await sleep(16); }
await touch('touchEnd');
await sleep(400);
const v1 = await S('({ ...S.view })');
T.ok('选中时一根手指拖：纸跟着动，选中的还在', v1.ty < v0.ty - 20 && v1.s === v0.s && same(await sel(), [ids.A, ids.B, ids.C]), [v0, v1]);
T.ok('虚线框跟着视图走（按新的视图画在那几笔外面）', await frameAt(ST2.filter((s) => [ids.A, ids.B, ids.C].includes(s.id))));
// 拖的时候手掌搭上来、还在滑：纸不动，这一拖照常
const u7 = await S('S.undo.length');
await drag([250 + P[0], 330 + P[1]], 40, 30, async () => {
  const pp = (await scr([[900, 1300]]))[0];
  await touch('touchStart', pp, 9);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [pp[0] - i * 20, pp[1] - i * 30], 9);
});
await touch('touchEnd', null, 9);
await sleep(300);
const v2 = await S('({ ...S.view })'), U7 = await undoTop();
T.ok('拖的时候手掌搭上来滑：纸一点没动，这一拖照常定下', same(v1, v2) && (await S('S.undo.length')) === u7 + 1 && U7.t === 'move' && Math.abs(U7.dx - 40 / v1.s) < 0.6, [v1, v2, U7]);
await T.tap('#toolsUndo');
T.ok('（撤销这一拖）', same(await strokesNow(), ST2));
// 「手指也能书写」开着：手指当笔用，也能画套索；画着时落下第二根手指，这一圈作废
await js(`window.__ink.S.fingerDraw = true`);
await waitPen();
const fpts = await scr([[120, 870]].concat(path([[120, 870], [380, 870], [380, 935], [120, 935]])));
await touch('touchStart', fpts[0], 3);
for (const q of fpts.slice(1)) await touch('touchMove', q, 3);
await touch('touchEnd', null, 3);
await sleep(300);
T.ok('「手指也能书写」开着：手指画的圈也能选中', same(await sel(), [ids.D]), await sel());
await touch('touchStart', fpts[0], 3);
for (const q of fpts.slice(1, 15)) await touch('touchMove', q, 3);
await T.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fpts[14][0], y: fpts[14][1], id: 3 }, { x: 600, y: 900, id: 4 }] });
await T.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(300);
T.ok('手指画着圈时落下第二根手指：这一圈作废（原来选中的也取消了），没留笔迹', (await S('S.lasso')) === null && (await sel()) === null && (await S('S.page.strokes.length')) === n0);
await js(`window.__ink.S.fingerDraw = false`);
await sleep(300);

// ================= 8. 书页上：挪不出纸边
const SRC = join(T.ROOT, 'src'), PDF = join(SRC, 'lasso-book.pdf');
mkdirSync(SRC, { recursive: true });
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
doc=fitz.open()
p=doc.new_page(width=1000,height=1300)
p.insert_text((60,120),'A printed page',fontsize=36)
doc.save(sys.argv[1])`, PDF]);
await reselect();
const imp = await T.post('/bridge/import', { sid: 'S1', path: PDF });
await T.openNotebook(imp.id, 0);
T.ok('换本子（打开导入的书）：没有选中的', Boolean(imp.id) && (await S('Boolean(S.bgImg)')) && (await sel()) === null, imp);
await T.tool('pen');
const mid = await scr([[500, 650]]);
await T.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mid[0][0], y: mid[0][1], deltaX: 0, deltaY: 400, modifiers: 2 }); // Ctrl + 滚轮：缩小，纸四周留出地方
await sleep(400);
await T.pen(scribble(600, 1100, 200));
const bk = await lastId();
await T.tool('lasso');
await loop([[560, 1060], [840, 1060], [840, 1140], [560, 1140]]);
T.ok('（前提）书页上选中了这一笔', same(await sel(), [bk]));
const G = await S('({ X0: S.X0, Y0: S.Y0, TW: S.TW, pageH: S.pageH, s: S.view.s })');
await drag([620, 1100], 330, 330);
let bb = ptsBox([byId(await strokesNow(), bk)]);
T.ok('往右下拖过了头：停在纸的右边、下边（夹在纸内）', bb[2] <= G.TW + 0.06 && bb[3] <= G.pageH + 0.06 && bb[2] > G.TW - 1 && bb[3] > G.pageH - 1, [bb, G]);
await drag([bb[0] + 20, (bb[1] + bb[3]) / 2], -330, -560);
bb = ptsBox([byId(await strokesNow(), bk)]);
T.ok('往左上拖过了头：停在纸的左边、上边', bb[0] >= G.X0 - 0.06 && bb[1] >= G.Y0 - 0.06 && bb[0] < G.X0 + 1 && bb[1] < G.Y0 + 1, [bb, G]);
// Claude 在书页上回两条短批注（排在右边一栏）和一条起点指着别处的箭头（起点的组号对不上：落在整页上、不记笔迹，和指着印刷文字一样不动）。
// 页边的短批注留在栏里，只跟着上下走（2026-11-17；原来整条平移，往左拖压到印刷的字上，往右拖它先顶到纸边、笔迹拖不动）
await T.tool('pen');
await T.pen(scribble(250, 800, 150));
const bk2 = await lastId();
await T.tap('#check');
const subB = await T.waitSub('S1'), metaB = subB && T.metaOf(subB);
const gB1 = metaB && metaB.groups.find((g) => g.ids.includes(bk)), gB2 = metaB && metaB.groups.find((g) => g.ids.includes(bk2));
T.ok('（前提）书上的两笔交上去了，各是一组', Boolean(gB1 && gB2) && gB1.id !== gB2.id, metaB && metaB.groups.map((g) => [g.id, g.ids]));
await T.post('/bridge/reply', { sid: 'S1', submission: subB.id, items: [{ type: 'note', anchor: gB1.id, text: '书页上的批注' },
  { type: 'note', anchor: gB2.id, text: '第二条批注' }, { type: 'arrow', from: 'g99', to: gB1.id, text: '从别处' }] });
const landedB = await T.waitFor(`window.__ink.S.page.ai.length === 3 && window.__ink.S.M > 0`, 10000);
await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
const writtenB = landedB && (await T.waitFor('window.__written', 20000));
const isN1 = (a) => a.text === '书页上的批注', isN2 = (a) => a.text === '第二条批注', isAr = (a) => a.type === 'arrow';
const BK0 = await aiNow(), BS0 = await strokesNow(), PG = await S('({ W: S.W, TW: S.TW, Y0: S.Y0, pageH: S.pageH, s: S.view.s })');
T.ok('（前提）书页右边开出一栏，两条批注排在栏里，第一条有细线连到笔迹；箭头的起点没记笔迹', writtenB && [isN1, isN2].every((f) => item(BK0, f) && item(BK0, f).lay.x > PG.W)
  && item(BK0, isN1).paths.some((p) => p.cls === 'leader') && item(BK0, isAr) && !item(BK0, isAr).on2 && same(item(BK0, isAr).on, [bk]), [BK0.map((a) => [a.type, a.lay, a.on, a.on2]), PG]);
const yr = (a) => [a.lay.y, a.lay.y + a.lay.h]; // 一条批注在栏里占的那一段高度
const apart6 = (p, q) => p[1] + 6 <= q[0] || q[1] + 6 <= p[0]; // 两段隔开至少 6（排页边时的间隔）
const leadOf = (a) => nums(a.paths.find((p) => p.cls === 'leader').d);
const N0 = item(BK0, isN1), N2 = item(BK0, isN2);
await T.shot('lasso-book-landed.png');
await T.tool('lasso');
// 圈住这一笔（从右下角起笔：笔落在纸外不算）
const selBk = async () => { const b = ptsBox([byId(await strokesNow(), bk)]); await loop([[b[2] + 20, b[3] + 20], [b[2] + 20, b[1] - 20], [b[0] - 20, b[1] - 20], [b[0] - 20, b[3] + 20]]); return same(await sel(), [bk]); };
T.ok('（前提）选中了这一笔', await selBk(), await sel());

// A. 往右下拖：批注不左右走，往下挪同样的量；细线连到笔迹的新位置；拖的时候就是这个样子
let midB = null;
await drag([(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2], 200, 60, async () => {
  midB = await js(`(() => { const S = window.__ink.S, a = S.page.ai.find((o) => o.text === '书页上的批注'), g = document.querySelector('#aiRoot > [data-id="' + a.id + '"]');
    return { tf: g.getAttribute('transform'), text: g.querySelector(':scope > text').getAttribute('transform'), lead: g.querySelector(':scope > path.leader').getAttribute('d') }; })()`);
});
const U8 = await undoTop(), BK1 = await aiNow(), BS1 = await strokesNow(), N1 = item(BK1, isN1), bbA = ptsBox([byId(BS1, bk)]);
await T.shot('lasso-book-moved.png');
T.ok('（前提）往右下拖了一段', U8.t === 'move' && U8.dx > 100 && U8.dy > 30, U8);
T.ok('页边的短批注留在栏里：横着一点没动，往下挪了同样的量（字、点擦的范围），所指的那块跟着笔迹挪', N1.lay.x === N0.lay.x && Math.abs(N1.lay.y - N0.lay.y - U8.dy) < 0.06
  && same({ ...N1.lay, y: 0 }, { ...N0.lay, y: 0 }) && N1.hit[0] === N0.hit[0] && N1.hit[2] === N0.hit[2] && Math.abs(N1.hit[1] - N0.hit[1] - U8.dy) < 0.06
  && N1.box.every((v, i) => Math.abs(v - N0.box[i] - (i % 2 ? U8.dy : U8.dx)) < 0.06) && restSame(N0, N1), [N0.lay, N1.lay, N0.box, N1.box, U8]);
const L1 = leadOf(N1);
T.ok('细线重画了：一头在笔迹新位置的右边，一头在栏里那几行字的左边', L1.length === 6 && Math.abs(L1[0] - (bbA[2] + 6)) < 8 && L1[1] > bbA[1] - 2 && L1[1] < bbA[3] + 2
  && Math.abs(L1[4] - (N0.lay.x - 8)) < 1.6 && Math.abs(L1[5] - (N1.lay.y + 29 * 0.55)) < 1.6, [L1, bbA, N1.lay]);
const domN = await js(`(() => { const S = window.__ink.S, a = S.page.ai.find((o) => o.text === '书页上的批注'), g = document.querySelector('#aiRoot > [data-id="' + a.id + '"]');
  return { tf: g.getAttribute('transform'), x: g.querySelector(':scope > text').getAttribute('x'), ttf: g.querySelector(':scope > text').getAttribute('transform'), lead: g.querySelector(':scope > path.leader').getAttribute('d') }; })()`);
T.ok('抬笔后按数据重画：字画在栏里原来的横向位置，细线是新的那条', !domN.tf && !domN.ttf && Number(domN.x) === r1(N0.lay.x) && domN.lead === N1.paths.find((p) => p.cls === 'leader').d, [domN, N1.lay]);
const mt = nums(midB.text);
T.ok('拖的时候：批注那一组不整体平移，字只往下挪着，细线已经换了', !midB.tf && mt.length === 2 && mt[0] === 0 && Math.abs(mt[1] - U8.dy) < 1 && midB.lead !== N0.paths.find((p) => p.cls === 'leader').d, [midB, U8]);
T.ok('第二条批注（指着没选中的笔迹）一点没动', same(item(BK1, isN2), N2));
const A0 = shaft(item(BK0, isAr)), A1 = shaft(item(BK1, isAr)), ar1 = item(BK1, isAr), ar0 = item(BK0, isAr);
T.ok('起点指着别处的箭头：起点一点没动，终点（连同箭头尖）跟着笔迹挪了同样的量，终点那块也跟着', same(A1.p1, A0.p1) && dist(A1.p2, [A0.p2[0] + U8.dx, A0.p2[1] + U8.dy]) < 0.08 && same(A1.tip, A1.p2)
  && ar1.box.every((v, i) => Math.abs(v - ar0.box[i] - (i % 2 ? U8.dy : U8.dx)) < 0.06) && restSame(ar0, ar1), [A0, A1]);
T.ok('起点指着别处的箭头：关系词跟着线的中段（离弯线中点还是约 14）', Math.abs(dist([ar1.lay.x, ar1.lay.y + 18], midOf(A1)) - 14) < 0.6 && Math.abs(dist([ar0.lay.x, ar0.lay.y + 18], midOf(A0)) - 14) < 0.6
  && dist([ar1.lay.x, ar1.lay.y], [ar0.lay.x, ar0.lay.y]) > 20, [ar0.lay, ar1.lay, midOf(A0), midOf(A1)]);
// B. 撤销、恢复
await T.tap('#toolsUndo');
T.ok('撤销：笔迹、两条批注、箭头都回到挪之前（每个字段一样）', same(await strokesNow(), BS0) && same(await aiNow(), BK0));
await T.tap('#toolsRedo');
T.ok('恢复：又和挪完一样', same(await strokesNow(), BS1) && same(await aiNow(), BK1));
// C. 往下拖过了头：笔迹停在纸的下边，批注跟着往下但不出纸（夹在纸内：离纸底 6）
await T.tool('lasso');
T.ok('（前提）又选中了这一笔', await selBk(), await sel());
const vh8 = await js('document.documentElement.clientHeight'), vw8 = await js('document.documentElement.clientWidth');
const [bc, bottom] = await scr([[(bbA[0] + bbA[2]) / 2, (bbA[1] + bbA[3]) / 2], [0, PG.pageH]]);
T.ok('（前提）这一拖能拖过纸的下边、批注按挪的量会出纸', bottom[1] + 30 < vh8 && N1.lay.y + (PG.pageH - bbA[3]) + N1.lay.h > PG.pageH - 4, [bottom, vh8, N1.lay, bbA, PG]);
await drag([(bbA[0] + bbA[2]) / 2, (bbA[1] + bbA[3]) / 2], 0, bottom[1] + 30 - bc[1]);
const AIC = await aiNow(), NC = item(AIC, isN1), bbC = ptsBox([byId(await strokesNow(), bk)]), lowC = Math.max(bbC[3], shaft(item(AIC, isAr)).p2[1]);
T.ok('往下拖过了头：笔迹（连同跟着走的箭头尖）停在纸的下边', lowC <= PG.pageH + 0.06 && lowC > PG.pageH - 1, [bbC, lowC, PG.pageH]);
T.ok('批注留在栏里、往下到纸底为止（下沿离纸底 6），没压到第二条', NC.lay.x === N0.lay.x && Math.abs(NC.lay.y + NC.lay.h - (PG.pageH - 6)) < 0.06 && apart6(yr(NC), yr(N2)), [NC.lay, PG.pageH]);
await T.tap('#toolsUndo');
T.ok('（撤销这一拖，回到 A 挪完的样子）', same(await strokesNow(), BS1) && same(await aiNow(), BK1));
// D. 往右拖过了头：笔迹一直拖到纸的右边（拖进页边那一栏），不被批注挡住；批注让开拖进栏里的笔迹
T.ok('（前提）又选中了这一笔', await selBk(), await sel());
const [bc2, right] = await scr([[(bbA[0] + bbA[2]) / 2, (bbA[1] + bbA[3]) / 2], [PG.TW, 0]]);
T.ok('（前提）这一拖能拖过纸的右边', right[0] + 30 < vw8, [right, vw8]);
await drag([(bbA[0] + bbA[2]) / 2, (bbA[1] + bbA[3]) / 2], right[0] + 30 - bc2[0], 0);
const AID = await aiNow(), ND = item(AID, isN1), bbD = ptsBox([byId(await strokesNow(), bk)]), rightD = Math.max(bbD[2], shaft(item(AID, isAr)).p2[0]);
T.ok('往右拖过了头：笔迹停在纸的右边（不再被批注先挡在纸边）', rightD <= PG.TW + 0.06 && rightD > PG.TW - 1 && bbD[2] > PG.TW - 30, [bbD, rightD, PG.TW]);
T.ok('拖进页边那一栏的笔迹：批注留在栏里，上下让开它（隔开至少 6），也没压到第二条', ND.lay.x === N0.lay.x && apart6(yr(ND), [bbD[1], bbD[3]]) && apart6(yr(ND), yr(N2)), [ND.lay, bbD]);
await T.shot('lasso-book-into-margin.png');
await T.tap('#toolsUndo');
T.ok('（撤销这一拖，回到 A 挪完的样子）', same(await strokesNow(), BS1) && same(await aiNow(), BK1));
// E. 往左下拖，批注按挪的量正好落在第二条上：它在栏里让开第二条（排页边的办法：离原来想放的地方最近的空处）
T.ok('（前提）又选中了这一笔', await selBk(), await sel());
const want = N2.lay.y - N1.lay.y;
T.ok('（前提）批注按挪的量会正好落在第二条上', !apart6([N1.lay.y + want, N1.lay.y + want + N1.lay.h], yr(N2)), [N1.lay, N2.lay]);
await drag([(bbA[0] + bbA[2]) / 2, (bbA[1] + bbA[3]) / 2], -60, want * PG.s);
const BKE = await aiNow(), NE = item(BKE, isN1), UE = await undoTop();
await T.shot('lasso-book-make-way.png');
T.ok('往左下拖：批注没往左挪（不会压到印刷的字上），第二条一点没动', UE.dx < -20 && NE.lay.x === N0.lay.x && NE.lay.x > PG.W && same(item(BKE, isN2), N2), [UE, NE.lay]);
T.ok('批注按挪的量会落在第二条上：让开了，紧挨着第二条的上面或下面（隔 6）', apart6(yr(NE), yr(N2)) && (Math.abs(NE.lay.y - (N2.lay.y + N2.lay.h + 6)) < 0.06 || Math.abs(NE.lay.y + NE.lay.h + 6 - N2.lay.y) < 0.06),
  [NE.lay, N2.lay]);

// ================= 9. 空白本子：挪到纸边外面，纸跟着长（画面不动）
await T.openNotebook('scratch', 2);
await T.tool('pen');
const mid2 = await scr([[700, 700]]);
await T.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mid2[0][0], y: mid2[0][1], deltaX: 0, deltaY: 400, modifiers: 2 });
await sleep(400);
await T.pen(scribble(1150, 400, 150));
const bl = await lastId();
await T.tool('lasso');
await loop([[1120, 360], [1330, 360], [1330, 440], [1120, 440]]);
T.ok('（前提）空白本子上选中了这一笔', same(await sel(), [bl]));
const g0 = await S('({ TW: S.TW, xw: S.page.xw || 0, view: { ...S.view } })');
await drag([1180, 400], 250, 0);
const g1 = await S('({ TW: S.TW, xw: S.page.xw || 0, view: { ...S.view } })'), bb2 = ptsBox([byId(await strokesNow(), bl)]);
T.ok('拖到纸的右边外面：没被夹住，纸往右长到把它包进来，画面不动', bb2[2] > g0.TW + 100 && g1.xw > g0.xw && bb2[2] <= g1.TW && same(g0.view, g1.view), [bb2, g0, g1]);

// ================= 10. 连续模式：拖不出这一页；交过的笔挪了以后不算新写的
await js(`window.__ink.toggleFlow()`);
await sleep(800);
await T.openPage(1);
T.ok('（前提）连续模式，第 2 页', (await S('S.flow')) && (await S('S.idx')) === 1);
await T.tool('pen');
await T.pen(scribble(200, 1000, 200));
const fl = await lastId();
await T.saved();
await T.tap('#check');
T.ok('（前提）交上去了', Boolean(await T.waitSub('S1')));
await T.waitFor('!window.__ink.S.sending', 8000);
await T.tool('lasso');
await loop([[170, 960], [430, 960], [430, 1040], [170, 1040]]);
T.ok('（前提）第 2 页上选中了这一笔', same(await sel(), [fl]) && (await S('S.idx')) === 1);
const H = await S('S.pageH'), sy0 = (await scr([[250, 1000]]))[0][1], vh = await js('document.documentElement.clientHeight');
T.ok('（前提）这一拖能拖过这一页的底', (vh - 30 - sy0) / (await S('S.view.s')) > H - 1012, [H, sy0, vh]);
await drag([250, 1000], 0, vh - 30 - sy0);
const fb = ptsBox([byId(await strokesNow(), fl)]);
T.ok('连续模式下往下拖过了这一页的底：停在这一页里，没跨到下一页', fb[3] <= H + 0.06 && fb[3] > H - 1 && (await S('S.idx')) === 1, [fb, H]);
T.ok('（前提）存上了', await T.saved());
const np = await T.apiJson('/api/new-pages?nb=scratch');
T.ok('交过的笔挪了以后不算新写的：这一页不在「有新字的页」里', Array.isArray(np.pages) && !np.pages.includes(1), np);

// ================= 11. 英文界面
await T.go('&lang=en');
T.ok('英文界面：套索的说明是英文，两处一样', (await js(`document.querySelector('#tools [data-tool=lasso]').getAttribute('aria-label')`)) === 'Lasso: circle some of your strokes, then press inside the box and drag them elsewhere'
  && (await js(`document.querySelector('#rail [data-tool=lasso]').getAttribute('aria-label')`)) === (await js(`document.querySelector('#tools [data-tool=lasso]').getAttribute('aria-label')`)));
await T.shot('lasso-en.png');

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

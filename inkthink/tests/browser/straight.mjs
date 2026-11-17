// 画线停住变直（2026-11-16 用户定，《产品定义》第 2 节；直不直的算法在 static/straight.js，另有 node 单元测试 tests/test_straight.mjs）：
// 用笔画一条线，笔不抬、停住约半秒，这一笔又长又差不多直就变成从起点到笔尖的直线；变直后终点跟着笔尖走，抬笔定下来；
// 5° 以内吸成正水平、正竖直。弯的、短的、来回描的、画圈的不变；不停住的笔迹一点不动（存下的点和原来逐点一致，开关开着关着一样）；
// 停住时浏览器不再发移动事件也能变直（靠定时器）；停住时手抖一点照样算停住，慢慢地一直在挪不算。手指写的不变。
// 开关在「⋯」菜单和抽屉最下面（同一个），记在这台设备上，默认开；关了就是原来的写法。红笔也行；撤销一次去掉这一笔；存下的还是普通的一笔。
// 2026-11-16 夜起先藏着（app.js 的 STRAIGHT_SHOWN 是 false）：第 00 步查开关不在页面上、默认停住不变直（这台设备以前记过开着也一样）；
// 之后用 window.__ink.showStraight(true) 在页面里打开，照原来那样测（刷新、换语言后再打开一次）。
// 只在无头 Edge 里、用合成的笔事件跑过：iPad 上笔停着时还发不发移动事件、手抖多大，这里测不到。
// 跑法：node tests/browser/straight.mjs [临时目录]；有一项不对退出码 1。
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'straight' });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const PEN = { pointerType: 'pen', button: 'left' };
const HOLD = 800; // 停住多久（门槛是 500 毫秒）

// ---- 用笔：页面坐标一次换成屏幕坐标，事件一个接一个发（中间不问页面，免得事件之间隔太久）
let tip = null; // 笔尖现在在屏幕上的哪儿
async function scr(pts) {
  const v = await js(`(() => { const S = window.__ink.S, r = document.querySelector('#stage').getBoundingClientRect(); return { l: r.left + S.view.tx, t: r.top + S.view.ty, s: S.view.s }; })()`);
  return pts.map((p) => [v.l + p[0] * v.s, v.t + p[1] * v.s]);
}
const mouse = (type, p, buttons) => T.cdp('Input.dispatchMouseEvent', Object.assign({ type, x: p[0], y: p[1], buttons }, type === 'mouseMoved' ? {} : { clickCount: 1 }, PEN));
async function down(pts) { const sp = await scr(pts); await mouse('mousePressed', sp[0], 1); for (const q of sp.slice(1)) await mouse('mouseMoved', q, 1); tip = sp[sp.length - 1]; }
async function move(pts, gap = 0) { const sp = await scr(pts); for (const q of sp) { await mouse('mouseMoved', q, 1); if (gap) await sleep(gap); } tip = sp[sp.length - 1]; }
async function up(wait = 250) { await mouse('mouseReleased', tip, 0); await sleep(wait); }
// 手指（「手指也能书写」开着时）
const touch = (type, p) => T.cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: p[0], y: p[1], id: 3, radiusX: 4, radiusY: 4, force: 0.5 }] });

// ---- 看页面
// 正在写的这一笔（还没抬笔）：原来的点、开始时刻、变直了没有、这一笔有没有在看「停住」
const cur = () => S(`S.cur && JSON.parse(JSON.stringify({ t0: S.cur.t0, pts: S.cur.pts, on: Boolean(S.cur._sl && S.cur._sl.on), armed: Boolean(S.cur._sl) }))`);
const lastStroke = () => S(`JSON.parse(JSON.stringify(S.page.strokes[S.page.strokes.length - 1]))`);
// 画布 sel 上，纸上 (wx, wy) 周围 half 个单位的方块里最不透明的像素
const alphaAt = (sel, wx, wy, half = 3) => js(`(() => { const c = document.querySelector('${sel}'), r = c.getBoundingClientRect(), d = c.width / r.width, v = window.__ink.S.view, st = document.querySelector('#stage').getBoundingClientRect();
  const cx = (st.left + v.tx + ${wx} * v.s - r.left) * d, cy = (st.top + v.ty + ${wy} * v.s - r.top) * d, h = Math.max(2, Math.round(${half} * v.s * d));
  const px = c.getContext('2d').getImageData(Math.round(cx - h), Math.round(cy - h), 2 * h + 1, 2 * h + 1).data; let m = 0; for (let i = 3; i < px.length; i += 4) m = Math.max(m, px[i]); return m; })()`);

// ---- 判断
const distTo = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.hypot(dx, dy); };
const onLine = (pts) => pts.length >= 2 && pts.every((p) => distTo(p, pts[0], pts[pts.length - 1]) <= 0.1); // 只差一位小数的舍入
const timesOk = (pts, t1) => pts[0][3] === 0 && pts[pts.length - 1][3] === t1 && pts.every((p, i) => i === 0 || p[3] >= pts[i - 1][3]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keysOf = (s) => Object.keys(s).filter((k) => !k.startsWith('_')).sort().join(','); // 页面上那份另带着算好的外框（_box），不存
const xy = (p) => [p[0], p[1]];
const meanPr = (pts) => Math.round((pts.reduce((a, p) => a + p[2], 0) / pts.length) * 100) / 100;
// 页面坐标的形状：从 a 到 b 的 n 段（wob：垂直于线慢慢左右晃的幅度）、弦 a→b 拱高 h 的弧、圆
function seg(a, b, n = 30, wob = 0) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
  return Array.from({ length: n + 1 }, (_, i) => { const u = i / n, w = wob * Math.sin(u * Math.PI * 3); return [a[0] + dx * u + nx * w, a[1] + dy * u + ny * w]; });
}
function bow(a, b, h, n = 30) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
  return Array.from({ length: n + 1 }, (_, i) => { const u = i / n, w = 4 * h * u * (1 - u); return [a[0] + dx * u + nx * w, a[1] + dy * u + ny * w]; });
}
const circle = (cx, cy, r, n = 36) => Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);
// 画一笔、停住 HOLD、记下抬笔前的样子、抬笔，返回 [抬笔前, 存下的]
async function heldStroke(pts) { await down(pts); await sleep(HOLD); const c = await cur(); await up(); return [c, await lastStroke()]; }
// 画一笔不停住：记下抬笔前的样子（马上记、马上抬），返回 [抬笔前, 存下的]
async function quickStroke(pts) { await down(pts); const c = await cur(); await up(); return [c, await lastStroke()]; }

if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(600); }

// ================= 00. 先藏起来（2026-11-16 夜用户定）：两个开关不在页面上（连那一行，不占位置），停住不变直；
//     这台设备以前记过开着也一样。下面原来的各项用 window.__ink.showStraight(true) 在页面里打开来测（以后放出来只改 app.js 的 STRAIGHT_SHOWN）
const rowsShown = () => js(`(() => { const on = (e) => Boolean(e) && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  const m = document.querySelector('#optStraight').closest('.row'), d = document.querySelector('#drStraight').closest('.dr-row');
  return { menuRow: !m.hidden, drawerRow: !d.hidden, menuOn: on(m), drawerOn: on(d) }; })()`);
const menuRows = () => js(`(() => { const m = document.querySelector('#menu'), was = m.hidden; m.hidden = false;
  const r = [...m.querySelectorAll('.row')].filter((b) => getComputedStyle(b).display !== 'none' && b.getClientRects().length).map((b) => b.id || (b.querySelector('input') || {}).id || '?').join();
  m.hidden = was; return r; })()`);
const drawerChecks = () => js(`(() => { const d = document.querySelector('#drawer'), was = d.hidden; d.hidden = false;
  const r = [...d.querySelectorAll('.dr-row')].filter((b) => getComputedStyle(b).display !== 'none' && b.getClientRects().length && b.querySelector('input[type=checkbox]')).map((b) => b.querySelector('input').id).join();
  d.hidden = was; return r; })()`);
let R0 = await rowsShown();
T.ok('先藏着：「⋯」菜单和抽屉最下面都没有「画线停住变直」那一行（hidden，不占位置）', !R0.menuRow && !R0.drawerRow && !R0.menuOn && !R0.drawerOn, R0);
T.ok('「⋯」菜单里看得见的是：显示批注、Claude 读到了什么、手指书写、回放、整页 / 适配宽度、清除批注、再看一遍新手引导', (await menuRows()) === 'optAi,optReads,optFinger,actReplay,actFit,actClearAi,actGuide', await menuRows());
T.ok('抽屉最下面的勾选框只剩「Claude 读到了什么」', (await drawerChecks()) === 'drReads', await drawerChecks());
const n00 = await T.strokes();
const [c00, s00] = await heldStroke(seg([120, 200], [420, 260], 30, 5));
T.ok('默认：画线停住半秒不变直（不看停住），存下的点和抬笔前逐点一致', !c00.armed && !c00.on && same(s00.pts, c00.pts) && (await T.strokes()) === n00 + 1, { armed: c00.armed, on: c00.on });
await T.tap('#toolsUndo'); // 这一笔不要（下面从头测原来那样）
await T.saved();
await js(`localStorage.setItem('inkthink.straight', 'true')`); // 这台设备以前记过开着
await T.reload();
R0 = await rowsShown();
const [c01, s01] = await heldStroke(seg([120, 420], [420, 480], 30, 5));
T.ok('这台设备以前记过开着：刷新后开关照样不在、停住照样不变直', !R0.menuRow && !R0.drawerRow && !c01.armed && !c01.on && same(s01.pts, c01.pts), [R0, { armed: c01.armed, on: c01.on }]);
await T.tap('#toolsUndo');
await T.saved();
await js(`localStorage.removeItem('inkthink.straight')`);
await T.reload();
await js(`window.__ink.showStraight(true)`);
R0 = await rowsShown();
T.ok('（在页面里打开：两个开关回到菜单和抽屉里）', R0.menuRow && R0.drawerRow && (await T.strokes()) === n00 && (await menuRows()) === 'optAi,optReads,optFinger,optStraight,actReplay,actFit,actClearAi,actGuide', [R0, await T.strokes()]);

// ================= 0. 开关：「⋯」菜单和抽屉最下面各一个，默认开
T.ok('默认开：菜单和抽屉里的勾选框都勾着，这台设备上还没记过', (await S('S.straightOn')) === true
  && (await js(`document.querySelector('#optStraight').checked && document.querySelector('#drStraight').checked`)) && (await js(`localStorage.getItem('inkthink.straight')`)) === null,
  await js(`[document.querySelector('#optStraight').checked, document.querySelector('#drStraight').checked, localStorage.getItem('inkthink.straight')]`));
T.ok('菜单里那一项写「画线停住变直」，在「手指也能书写」下面', (await js(`document.querySelector('#optStraight').parentElement.textContent.trim()`)) === '画线停住变直'
  && (await js(`document.querySelector('#optFinger').parentElement.nextElementSibling === document.querySelector('#optStraight').parentElement`)));

// ================= 1. 停住变直（黑笔，斜着约 11°，画得有点晃）：笔停着时没有移动事件，靠定时器
const n0 = await T.strokes();
const [c1, s1] = await heldStroke(seg([120, 200], [420, 260], 30, 5));
T.ok('（前提）画的是晃的线，原来的点不在一条直线上', !onLine(c1.pts), c1.pts.length);
T.ok('笔不抬、停住半秒（这期间没有移动事件）：变直了', c1.on && c1.armed, { on: c1.on, armed: c1.armed });
T.ok('抬笔后：存下的点都在一条直线上', onLine(s1.pts), s1.pts.slice(0, 3));
T.ok('起点不动、终点就是笔尖', same(xy(s1.pts[0]), xy(c1.pts[0])) && same(xy(s1.pts[s1.pts.length - 1]), xy(c1.pts[c1.pts.length - 1])),
  [s1.pts[0], c1.pts[0], s1.pts[s1.pts.length - 1], c1.pts[c1.pts.length - 1]]);
T.ok('11° 的斜线不吸成水平', s1.pts[s1.pts.length - 1][1] - s1.pts[0][1] > 50, [s1.pts[0], s1.pts[s1.pts.length - 1]]);
T.ok('起止时间不变：开始时刻一样，时刻从 0 走到原来最后一个点的时刻，不倒退', s1.t0 === c1.t0 && timesOk(s1.pts, c1.pts[c1.pts.length - 1][3]),
  { t0: [s1.t0, c1.t0], end: [s1.pts[s1.pts.length - 1][3], c1.pts[c1.pts.length - 1][3]] });
T.ok('还是普通的一笔：字段还是 id、t0、w、pts，每个点 [x, y, 轻重, 毫秒]、坐标一位小数，轻重是原来的平均', keysOf(s1) === 'id,pts,t0,w' && s1.w === 2.1
  && s1.pts.every((p) => p.length === 4 && p.every(Number.isFinite) && Math.abs(p[0] * 10 - Math.round(p[0] * 10)) < 1e-6 && Math.abs(p[1] * 10 - Math.round(p[1] * 10)) < 1e-6 && p[2] === meanPr(c1.pts)),
  { keys: keysOf(s1), w: s1.w, p: s1.pts[1], pr: meanPr(c1.pts) });
T.ok('多了一笔，撤销记录里是这一笔', (await T.strokes()) === n0 + 1 && (await S(`JSON.stringify(S.undo[S.undo.length - 1])`)) === JSON.stringify({ t: 'add', id: s1.id }));
T.ok('上面那层清空了，这一笔画在墨迹层上', (await alphaAt('#live', 270, 230)) === 0 && (await alphaAt('#ink', 270, 230)) > 0);

// ================= 2. 变直后笔还没抬：终点跟着笔尖走，起点不动；抬笔定下来
const P2 = seg([120, 420], [400, 470], 30, 4);
await down(P2);
await sleep(HOLD);
const c2a = await cur();
const liveRaw = await alphaAt('#live', P2[15][0], P2[15][1]); // 变直以前画的那条（晃的）线中间
await move(seg([400, 470], [520, 600], 10).slice(1));
await sleep(150);
const liveNew = await alphaAt('#live', 320, 510), liveOld = await alphaAt('#live', P2[15][0], P2[15][1]);
const c2 = await cur();
await up();
const s2 = await lastStroke();
T.ok('（前提）停住后变直了', c2a.on, c2a.on);
T.ok('变直后笔挪到别处：屏幕上的线是从起点到笔尖的（新的线上有墨，原来那条线上没有了）', liveRaw > 0 && liveNew > 0 && liveOld === 0, { liveRaw, liveNew, liveOld });
T.ok('抬笔定下来：起点还是原来的，终点是抬笔前笔尖的位置，都在一条直线上', same(xy(s2.pts[0]), xy(c2.pts[0])) && Math.hypot(s2.pts[s2.pts.length - 1][0] - 520, s2.pts[s2.pts.length - 1][1] - 600) < 0.6 && onLine(s2.pts),
  [s2.pts[0], s2.pts[s2.pts.length - 1]]);
T.ok('跟笔那段的时刻也算进去：最后一个点的时刻是原来最后一个点的', timesOk(s2.pts, c2.pts[c2.pts.length - 1][3]) && c2.pts[c2.pts.length - 1][3] > c2a.pts[c2a.pts.length - 1][3]);

// ================= 3. 吸水平、吸竖直（5° 以内）
const [c3h, s3h] = await heldStroke(seg([150, 700], [450, 712], 30)); // 2.3°
T.ok('离水平 2.3°：吸成正水平（每个点的 y 都是起点的），终点的 x 是笔尖的', c3h.on && s3h.pts.every((p) => p[1] === s3h.pts[0][1]) && s3h.pts[0][1] === c3h.pts[0][1]
  && Math.abs(s3h.pts[s3h.pts.length - 1][0] - c3h.pts[c3h.pts.length - 1][0]) < 0.11, [s3h.pts[0], s3h.pts[s3h.pts.length - 1]]);
const [c3v, s3v] = await heldStroke(seg([700, 250], [712, 560], 30)); // 离竖直 2.2°
T.ok('离竖直 2.2°：吸成正竖直（每个点的 x 都是起点的），终点的 y 是笔尖的', c3v.on && s3v.pts.every((p) => p[0] === s3v.pts[0][0]) && s3v.pts[0][0] === c3v.pts[0][0]
  && Math.abs(s3v.pts[s3v.pts.length - 1][1] - c3v.pts[c3v.pts.length - 1][1]) < 0.11, [s3v.pts[0], s3v.pts[s3v.pts.length - 1]]);

// ================= 4. 弯的、短的、来回描的、画圈的：停住也不变，存下的就是原来的点
const keep = async (label, pts) => {
  const [c, s] = await heldStroke(pts);
  return T.ok(label, c.armed && !c.on && same(s.pts, c.pts) && s.t0 === c.t0, { armed: c.armed, on: c.on, n: [c.pts.length, s.pts.length] });
};
await keep('弯的（拱高是线长的 20%）停住：不变，存下的点和原来逐点一致', bow([120, 850], [420, 850], 60));
await keep('短的（50 个单位的直线）停住：不变', seg([500, 860], [550, 862], 8));
await keep('写「一」（40 个单位）停住：不变', seg([600, 860], [640, 861], 8));
await keep('写「1」（竖着 45 个单位）停住：不变', seg([680, 830], [683, 875], 8));
await keep('来回描（去 300 回 150）停住：不变', seg([120, 1000], [420, 1000], 20).concat(seg([420, 1000], [270, 1000], 10).slice(1)));
await keep('画圈停住：不变', circle(650, 1000, 60));
await keep('一笔画的 L（两条轴连着画）停住：不变', seg([800, 700], [800, 1000], 15).concat(seg([800, 1000], [950, 1000], 10).slice(1)));

// ================= 5. 不停住：一点不动（存下的点就是抬笔前的点），开关开着关着存下的一样
const LINE = seg([120, 1150], [420, 1180], 30, 4);
const [c5, s5] = await quickStroke(LINE);
T.ok('开关开着、不停住：没变直，存下的点和抬笔前逐点一致（位置、轻重、时刻）', c5.armed && !c5.on && same(s5.pts, c5.pts) && s5.t0 === c5.t0, { armed: c5.armed, on: c5.on, n: [c5.pts.length, s5.pts.length] });
// 先停住再画：落笔停半秒（这时还短），接着画一条直线、马上抬笔——不变
await down([[500, 1150]]);
await sleep(HOLD);
await move(seg([500, 1150], [800, 1200], 30).slice(1));
const c5c = await cur();
await up();
const s5c = await lastStroke();
T.ok('落笔先停半秒再画直线、不在末尾停：不变', !c5c.on && same(s5c.pts, c5c.pts), { on: c5c.on });
// 慢慢地一直在挪（每 150 毫秒挪 8 个像素，比「停住」的 5 个像素远）：不算停住
await down(seg([120, 1250], [125, 1251], 1));
await move(seg([125, 1251], [385, 1270], 20).slice(1), 150);
const c5d = await cur();
await up();
const s5d = await lastStroke();
T.ok('慢慢地一直在挪（3 秒画完，每一下都挪出 5 个像素）：不算停住，不变', !c5d.on && same(s5d.pts, c5d.pts), { on: c5d.on });

// ================= 6. 停住时手抖（还有一点点移动事件，都在 5 个像素以内）：照样算停住
await down(seg([500, 1250], [800, 1310], 30, 3));
const base = tip.slice();
for (let k = 0; k < 16; k++) { await mouse('mouseMoved', [base[0] + (k % 2 ? 1.5 : -1.5), base[1] + ((k % 3) - 1) * 1.2], 1); await sleep(50); }
tip = [base[0] + 1.5, base[1]];
await mouse('mouseMoved', tip, 1);
await sleep(200);
const c6 = await cur();
await up();
const s6 = await lastStroke();
T.ok('停住时手抖、还有移动事件（都在 5 个像素以内）：照样变直', c6.on && onLine(s6.pts) && same(xy(s6.pts[0]), xy(c6.pts[0])), { on: c6.on, n: s6.pts.length });

// ================= 7. 红笔也行；撤销一次就是去掉这一笔
await T.tool('red');
const n7 = await T.strokes();
const [c7, s7] = await heldStroke(seg([120, 1380], [420, 1440], 30, 4));
T.ok('红笔停住：变直，还是红笔', c7.on && s7.c === 'r' && onLine(s7.pts) && keysOf(s7) === 'c,id,pts,t0,w', { on: c7.on, c: s7.c, keys: keysOf(s7) });
await T.tap('#toolsUndo');
T.ok('撤销一次：这一笔没了，前面的都在', (await T.strokes()) === n7 && !(await S(`S.page.strokes.some((s) => s.id === '${s7.id}')`)) && (await S(`S.page.strokes.some((s) => s.id === '${s6.id}')`)),
  await T.strokes());
await T.tool('pen');

// ================= 8. 手指写的（「手指也能书写」开着）：停住也不变
await js(`window.__ink.S.fingerDraw = true`);
await sleep(1100);
const fp = await scr(seg([500, 1380], [800, 1440], 20, 3));
await touch('touchStart', fp[0]);
for (const q of fp.slice(1)) await touch('touchMove', q);
await sleep(HOLD);
const c8 = await cur();
await touch('touchEnd');
await sleep(250);
const s8 = await lastStroke();
T.ok('手指写的停住：不看停住，不变', Boolean(c8) && !c8.armed && !c8.on && same(s8.pts, c8.pts), c8 && { armed: c8.armed, on: c8.on });
await js(`window.__ink.S.fingerDraw = false`);
await sleep(1100);

// ================= 9. 存到电脑上的还是普通的一笔
T.ok('（前提）存上了', await T.saved(), await S('({ dirty: S.dirty })'));
const disk = T.pageFile('scratch', 0), d1 = disk && disk.strokes.find((s) => s.id === s1.id);
T.ok('变直的那一笔存到电脑上：字段只有 id、t0、w、pts，点和页面上的一样', Boolean(d1) && keysOf(d1) === 'id,pts,t0,w' && same(d1.pts, s1.pts) && d1.t0 === s1.t0, d1 && keysOf(d1));

// ================= 10. 关掉开关：完全是原来的写法；同样的一笔不停住时，开着关着存下的位置、轻重逐点一样；记在这台设备上
await js(`document.querySelector('#drStraight').click()`);
T.ok('点抽屉里的勾选框关掉：两个勾选框都不勾了，记在这台设备上', (await S('S.straightOn')) === false
  && !(await js(`document.querySelector('#optStraight').checked || document.querySelector('#drStraight').checked`)) && (await js(`localStorage.getItem('inkthink.straight')`)) === 'false');
const [c10, s10] = await heldStroke(seg([120, 1550], [420, 1610], 30, 5));
T.ok('关了：停住也不变（不看停住），存下的点和抬笔前逐点一致', !c10.armed && !c10.on && same(s10.pts, c10.pts), { armed: c10.armed, on: c10.on });
const [c10b, s10b] = await quickStroke(LINE); // 和第 5 步同一笔、同样的屏幕位置
const pxy = (pts) => pts.map((p) => p.slice(0, 3));
T.ok('同样的一笔不停住：开关开着存下的和关着存下的，点数、位置、轻重逐点一样', same(pxy(s10b.pts), pxy(s5.pts)) && same(s10b.pts, c10b.pts), { on: s5.pts.length, off: s10b.pts.length });
await T.reload();
await js(`window.__ink.showStraight(true)`); // 先藏着：刷新后在页面里再打开一次
T.ok('刷新后还是关着', (await S('S.straightOn')) === false && !(await js(`document.querySelector('#optStraight').checked || document.querySelector('#drStraight').checked`)));
await js(`document.querySelector('#optStraight').click()`);
T.ok('点菜单里的勾选框打开：两个都勾上，记下 true', (await S('S.straightOn')) === true
  && (await js(`document.querySelector('#optStraight').checked && document.querySelector('#drStraight').checked`)) && (await js(`localStorage.getItem('inkthink.straight')`)) === 'true');
const [c10c, s10c] = await heldStroke(seg([500, 1550], [800, 1610], 30, 5));
T.ok('再打开：停住又会变直', c10c.on && onLine(s10c.pts), c10c.on);
await T.shot('straight.png');

// ================= 11. 英文界面
await T.go('&lang=en');
await js(`window.__ink.showStraight(true)`);
T.ok('英文界面：菜单和抽屉里写「Pause to straighten a line」', (await js(`document.querySelector('#optStraight').parentElement.textContent.trim()`)) === 'Pause to straighten a line'
  && (await js(`document.querySelector('#drStraight').parentElement.textContent.trim()`)) === 'Pause to straighten a line');

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

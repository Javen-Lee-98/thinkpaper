// 笔触（阶段 D1，用户在试写页上选定的「笔触 1、细」，画法在 static/brush.js）：平板上的用户笔迹都这样画——
// 主体约是笔的基本粗细的 0.68 倍（比原来的 0.56 倍粗）、从头到尾一样粗、够黑；起笔不收；收笔略尖，而且抬笔那一刻才尖（写的时候不尖）。
// 查：打开页面时已有的笔迹（黑、红、报轻重的、一个点、擦掉的）；新写的一笔写到一半、抬笔以后；刷新后；书写回放写到一半、写完；
// 连续模式里相邻页上的；适配宽度（平常写字的大小）时也够粗；笔迹数据一个字段都不变（已有的原样存回去，新写的还是原来的格式）。
// 粗细按画布上的像素量：一列里笔迹覆盖了多少（透明度加起来，就是线有几个像素粗）。合不合手只有用户在 iPad 上写了才知道。
// 跑法：node tests/browser/pen_stroke.mjs [临时目录]；有一项不对退出码 1。只在无头 Edge 里跑过。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'pen-stroke', open: false, pages: 2 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const BODY = 2.1 * 0.68, OLD = 2.1 * (0.45 + 0.9 * 0.12); // 选定的笔触主体多粗；原来的画法（发给 Claude 的图还用它）多粗
const T0 = Date.now() - 3600 * 1000;

// ---- 已有的笔迹：直接写进页面文件（和平板存的格式一样），再打开页面
const line = (x0, x1, y, step, dt, pr = () => 0.12) => Array.from({ length: Math.round((x1 - x0) / step) + 1 }, (_, i) => [Math.round((x0 + i * step) * 10) / 10, y, pr(i), i * dt]);
const FIX = [
  { id: 'fx1', t0: T0, w: 2.1, pts: line(100, 220, 300, 2.4, 16) },                                   // 黑笔，平常快慢
  { id: 'fx2', t0: T0 + 2000, w: 2.1, pts: line(100, 220, 360, 2.4, 16), c: 'r' },                      // 红笔
  { id: 'fx3', t0: T0 + 4000, w: 2.1, pts: [[250, 300, 0.12, 0]] },                                     // 一个点
  { id: 'fx4', t0: T0 + 5000, w: 2.1, pts: line(100, 220, 420, 2.4, 16, (i) => (i < 25 ? 0.2 : 0.9)) },  // 报轻重的笔：前半轻、后半重
  { id: 'fx5', t0: T0 + 7000, w: 2.1, pts: line(100, 220, 470, 2.4, 16), erasedAt: T0 + 9000 },         // 擦掉的
];
const DIR = join(T.DATA, 'notebooks', 'scratch');
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'page-0000.json'), JSON.stringify({ v: 1, strokes: FIX, ai: [], reads: [] }), 'utf8');
// 第 2 页（加出来的页文件名不按页号，走存页的接口）：连续模式里当相邻页画
await T.api('/api/page?nb=scratch&i=1', { method: 'PUT', body: JSON.stringify({ v: 1, strokes: [{ id: 'nb1', t0: T0, w: 2.1, pts: line(100, 220, 300, 2.4, 16) }], ai: [], reads: [] }) });
await T.go();
if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(600); }

// 放大到 4 倍，左上角对着纸上 (80, 260)：纸上 1 个单位是屏幕上 4 个像素
const K = 4;
const zoom = () => js(`(() => { const S = window.__ink.S; S.fitMode = null; S.view = { s: ${K}, tx: -80 * ${K}, ty: -260 * ${K} }; window.dispatchEvent(new Event('resize')); return 1; })()`);
await zoom();
await sleep(300);
// 画布 sel 上，纸上 (wx, wy) 那一列、上下各 half 个单位里：笔迹覆盖了多少（像素）、最不透明的那个像素多不透明、它的颜色
async function col(sel, wx, wy, half = 4) {
  const [cx, cy] = await T.screenOf(wx, wy);
  return js(`(() => { const c = document.querySelector('${sel}'), r = c.getBoundingClientRect(), d = c.width / r.width, s = window.__ink.S.view.s;
    const x = Math.floor((${cx} - r.left) * d), y0 = Math.round((${cy} - ${half} * s - r.top) * d), h = Math.round(2 * ${half} * s * d);
    const px = c.getContext('2d').getImageData(x, y0, 1, h).data; let a = 0, top = 0, rgb = null;
    for (let i = 0; i < px.length; i += 4) { a += px[i + 3] / 255; if (px[i + 3] > top) { top = px[i + 3]; rgb = [px[i], px[i + 1], px[i + 2]]; } }
    return { cover: Math.round(a / d * 100) / 100, top, rgb }; })()`);
}
const cover = async (sel, wx, wy) => (await col(sel, wx, wy)).cover;
const near = (v, want, tol) => Math.abs(v - want) <= tol;
// 一笔横线的样子：主体几处的粗细、起笔、收笔（终点前 0.3 个单位）
async function shape(sel, x0, x1, y) {
  const body = [];
  for (let x = x0 + 6; x <= x1 - 9; x += (x1 - x0 - 15) / 5) body.push(await cover(sel, x, y));
  return { body, min: Math.min(...body), max: Math.max(...body), start: await cover(sel, x0 + 0.3, y), end: await cover(sel, x1 - 0.3, y), mid: await col(sel, (x0 + x1) / 2, y) };
}
const INK = [27, 27, 27], RED = [210, 60, 46];
const same = (a, b) => Boolean(a && b) && a.every((v, i) => Math.abs(v - b[i]) <= 2);

// ================= 1. 打开页面时已有的笔迹：都是选定的笔触
let f1 = await shape('#ink', 100, 220, 300);
T.ok('已有的黑笔：主体的粗细是选定的（约 1.43 个单位），比原来的画法（约 1.17）粗', near(f1.mid.cover, BODY * K, 0.12 * BODY * K) && f1.mid.cover > OLD * K * 1.12, { mid: f1.mid.cover, want: BODY * K, old: OLD * K });
T.ok('已有的黑笔：从头到尾一样粗（主体几处差不到 8%）', f1.max / f1.min < 1.08, f1.body);
T.ok('已有的黑笔：够黑——线中间的像素不透明、是墨的颜色', f1.mid.top === 255 && same(f1.mid.rgb, INK), f1.mid);
T.ok('已有的黑笔：起笔不收（和主体一样粗）', f1.start >= f1.min * 0.9, { start: f1.start, body: f1.min });
T.ok('已有的黑笔：收笔是尖的（终点处比主体细得多）', f1.end < f1.min * 0.8 && f1.end > 0.5, { end: f1.end, body: f1.min });
const f2 = await shape('#ink', 100, 220, 360);
T.ok('已有的红笔：同一种画法，颜色是红的', near(f2.mid.cover, BODY * K, 0.12 * BODY * K) && f2.end < f2.min * 0.8 && same(f2.mid.rgb, RED), { mid: f2.mid, end: f2.end });
const dot = await cover('#ink', 250, 300);
T.ok('一个点画成圆点，和线一样粗', near(dot, BODY * K, 0.2 * BODY * K), dot);
const light = await cover('#ink', 130, 420), heavy = await cover('#ink', 190, 420);
T.ok('报轻重的笔：重的地方比轻的地方粗', heavy > light * 1.4, { light, heavy });
T.ok('擦掉的笔迹不画', (await cover('#ink', 160, 470)) === 0, await cover('#ink', 160, 470));

// ================= 2. 新写一笔：写到一半笔尖处不尖、只画在上面那层；抬笔后收笔才尖
const base = { pointerType: 'pen', button: 'left' };
const P = Array.from({ length: 41 }, (_, i) => [100 + i * 2.5, 520]);
const sp = [];
for (const p of P) sp.push(await T.screenOf(p[0], p[1]));
await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: sp[0][0], y: sp[0][1], buttons: 1, clickCount: 1 }, base));
for (const p of sp.slice(1)) { await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: p[0], y: p[1], buttons: 1 }, base)); await sleep(18); }
await sleep(100);
const live = await shape('#live', 100, 200, 520);
T.ok('写到一半：画在上面那层（墨迹层上还没有），主体是选定的粗细', near(live.mid.cover, BODY * K, 0.12 * BODY * K) && (await cover('#ink', 150, 520)) === 0, { live: live.mid.cover, ink: await cover('#ink', 150, 520) });
T.ok('写到一半：笔尖处不尖（和主体一样粗）', live.end >= live.min * 0.9, { end: live.end, body: live.min });
const l = sp[sp.length - 1];
await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: l[0], y: l[1], buttons: 0, clickCount: 1 }, base));
await sleep(300);
const fin = await shape('#ink', 100, 200, 520);
T.ok('抬笔后：画到墨迹层上，上面那层清空了', near(fin.mid.cover, BODY * K, 0.12 * BODY * K) && (await cover('#live', 150, 520)) === 0, { ink: fin.mid.cover, live: await cover('#live', 150, 520) });
T.ok('抬笔后：收笔变尖', fin.end < fin.min * 0.8 && fin.end > 0.5, { end: fin.end, body: fin.min });
T.ok('抬笔后：起笔不收、从头到尾一样粗', fin.start >= fin.min * 0.9 && fin.max / fin.min < 1.08, fin);

// ================= 3. 笔迹数据不变：已有的原样存回去；新写的还是原来的格式
T.ok('（前提）存上了', await T.saved(), await S('({ dirty: S.dirty })'));
const canon = (o) => JSON.stringify(o, Object.keys(o).filter((k) => !k.startsWith('_')).sort()); // 页面上那份另带着算好的外框（_box），不存
const disk = T.pageFile('scratch', 0), mine = await S('JSON.parse(JSON.stringify(S.page.strokes[S.page.strokes.length - 1]))');
T.ok('已有的五笔存回去逐字段相同（画法改了，数据一点没动）', FIX.every((f) => { const d = disk.strokes.find((s) => s.id === f.id); return d && canon(d) === canon(f) && JSON.stringify(d.pts) === JSON.stringify(f.pts); }),
  disk.strokes.filter((s) => s.id.startsWith('fx')));
const nd = disk.strokes.find((s) => s.id === mine.id);
T.ok('新写的一笔：存下的和页面上的一样，字段还是 id、t0、w、pts，w 是 2.1', Boolean(nd) && canon(nd) === canon(mine) && JSON.stringify(nd.pts) === JSON.stringify(mine.pts)
  && JSON.stringify(Object.keys(nd).sort()) === JSON.stringify(['id', 'pts', 't0', 'w']) && nd.w === 2.1, nd && Object.keys(nd));
T.ok('新写的一笔：每个点还是 [x, y, 轻重, 毫秒]，坐标一位小数，时刻不倒退', nd.pts.length >= 30 && nd.pts.every((p, i) => p.length === 4 && p.every(Number.isFinite)
  && Math.abs(p[0] * 10 - Math.round(p[0] * 10)) < 1e-6 && Math.abs(p[1] * 10 - Math.round(p[1] * 10)) < 1e-6 && p[2] > 0 && p[2] <= 1 && (i === 0 || p[3] >= nd.pts[i - 1][3])), nd.pts.slice(0, 3));

// ================= 4. 刷新后：旧笔迹（刚才写的那一笔）还是这种画法，和刷新前一样
await T.reload();
if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(600); }
await zoom();
await sleep(300);
const again = await shape('#ink', 100, 200, 520);
// 刷新前后的像素差一点点是浏览器画布的事：读过几次像素的画布，浏览器会改用另一种方式画，边上的半透明像素略有不同
// （同一条路径量出 5.5 和 5.7）。所以主体按选定的粗细查，收笔按「收笔 / 主体」的比例和刷新前比
const ratio = (x) => x.end / x.mid.cover;
T.ok('刷新后：刚才那一笔画得和刷新前一样（主体是选定的粗细，收笔和主体之比差不到 0.12），收笔还是尖的', near(again.mid.cover, BODY * K, 0.12 * BODY * K)
  && near(ratio(again), ratio(fin), 0.12) && again.end < again.min * 0.8, { before: fin, after: again });
f1 = await shape('#ink', 100, 220, 300);
T.ok('刷新后：已有的黑笔照旧', near(f1.mid.cover, BODY * K, 0.12 * BODY * K) && f1.end < f1.min * 0.8, f1);

// ================= 5. 书写回放：写到一半的那笔画在上面那层、笔尖不尖；写完那一刻画到墨迹层上、收笔变尖
const id = mine.id;
await js(`(() => { window.__ink.replay(); window.__ink.S.replay.SPEED = 0.5; return 1; })()`); // 每一笔写得慢一点（原来是 2 倍速），好在中途看
T.ok('（前提）回放开始了', await T.waitFor(`window.__ink.S.replay && window.__ink.S.replay.active.some((a) => a.s.id === '${id}' && a.done > 12 && a.done < 30)`, 20000),
  await S('S.replay && S.replay.active.map((a) => [a.s.id, a.done])'));
const half = await S(`(() => { const a = S.replay.active.find((x) => x.s.id === '${id}'); return { n: a.done, x: a.s.pts[a.done - 1][0], x0: a.s.pts[0][0] }; })()`);
const rl = { mid: await cover('#live', (half.x0 + half.x) / 2, 520), end: await cover('#live', half.x - 0.3, 520), ink: await cover('#ink', (half.x0 + half.x) / 2, 520) };
T.ok('回放写到一半：画在上面那层，主体是选定的粗细，笔尖处不尖', near(rl.mid, BODY * K, 0.12 * BODY * K) && rl.end >= rl.mid * 0.9 && rl.ink === 0, Object.assign(rl, half));
T.ok('（前提）回放写完了这一笔、还没收尾', await T.waitFor(`window.__ink.S.replay && !window.__ink.S.replay.active.length && window.__ink.S.replay.next >= window.__ink.S.replay.ev.length`, 20000));
const rp = await shape('#ink', 100, 200, 520);
T.ok('回放写完那一笔：在墨迹层上，收笔变尖，和平时画的一样', near(rp.mid.cover, BODY * K, 0.12 * BODY * K) && near(ratio(rp), ratio(fin), 0.12) && rp.end < rp.min * 0.8
  && (await cover('#live', 150, 520)) === 0, { replay: [rp.mid.cover, rp.end], normal: [fin.mid.cover, fin.end] });
const rf = await shape('#ink', 100, 220, 300);
T.ok('回放里已有的黑笔也是这种画法', near(rf.mid.cover, BODY * K, 0.12 * BODY * K) && rf.end < rf.min * 0.8, rf);
T.ok('回放收尾后照常', await T.waitFor(`!window.__ink.S.replay`, 5000) && (await cover('#ink', 160, 470)) === 0 && near(await cover('#ink', 160, 300), f1.mid.cover, 0.5));

// ================= 6. 连续模式：相邻页（第 2 页）上的笔迹也是这种画法（画在底下那层画布上，和纸、点阵画在一起：按多黑来量）
await js(`window.__ink.toggleFlow()`);
T.ok('（前提）连续模式，第 2 页已经画在下面', (await S('S.flow')) && (await T.waitFor(`window.__ink.flowStrip().some((n) => n.i === 1)`, 8000)), await S('S.flow'));
const D = await js(`window.__ink.flowStrip().find((n) => n.i === 1).D`);
await js(`(() => { const S = window.__ink.S; S.fitMode = null; S.view = { s: ${K}, tx: -80 * ${K}, ty: -(${D} + 260) * ${K} }; window.dispatchEvent(new Event('resize')); return 1; })()`);
await sleep(300);
async function dark(wx, wy, half = 4) { // 底下那层：白纸上这一列有多黑（按墨的颜色折成覆盖了几个像素）
  const [cx, cy] = await T.screenOf(wx, wy);
  return js(`(() => { const c = document.querySelector('#bg'), r = c.getBoundingClientRect(), d = c.width / r.width, s = window.__ink.S.view.s;
    const x = Math.floor((${cx} - r.left) * d), y0 = Math.round((${cy} - ${half} * s - r.top) * d), h = Math.round(2 * ${half} * s * d);
    const px = c.getContext('2d').getImageData(x, y0, 1, h).data; let a = 0;
    for (let i = 0; i < px.length; i += 4) a += Math.max(0, Math.min(1, (255 - px[i]) / (255 - 27)));
    return Math.round(a / d * 100) / 100; })()`);
}
const nbBody = [await dark(130, D + 300), await dark(160, D + 300), await dark(190, D + 300)], nbEnd = await dark(219.7, D + 300);
T.ok('连续模式的相邻页：笔迹主体是选定的粗细、收笔是尖的', nbBody.every((v) => near(v, BODY * K, 0.12 * BODY * K)) && nbEnd < Math.min(...nbBody) * 0.8 && (await cover('#ink', 160, D + 300)) === 0,
  { nbBody, nbEnd, want: BODY * K });
await js(`window.__ink.toggleFlow()`);
await sleep(600);

// ================= 7. 适配宽度（平常写字时的大小），按 iPad 的两倍像素：线也比原来的画法粗
await T.cdp('Emulation.setDeviceMetricsOverride', { width: 834, height: 1194, deviceScaleFactor: 2, mobile: true });
await sleep(300);
await js(`(() => { window.__ink.S.fitMode = 'width'; window.dispatchEvent(new Event('resize')); return 1; })()`);
await sleep(300);
const s = await S('S.view.s'), small = [];
for (const x of [120, 140, 160, 180]) small.push(await cover('#ink', x, 300));
const avg = small.reduce((a, b) => a + b, 0) / small.length;
T.ok('适配宽度时：线有选定的那么粗（按页面单位算约 1.43，原来约 1.17）', near(avg / s, BODY, 0.15 * BODY) && avg / s > OLD * 1.1, { s, cover: small, units: avg / s });

await T.shot('pen.png');
await T.finish();

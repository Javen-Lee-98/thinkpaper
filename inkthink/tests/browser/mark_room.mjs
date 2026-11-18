// 空白本子里批改符号旁边那句话也照短批注的办法找空白（2026-11-18 用户在平板上试过上一轮后提的「蓝字不压已有的字」；
// 《产品定义》第 2 节，细节是用户不在时暂定的）。查：
// 1. 第 1 页写得密（一行行满宽的字，中间三处空出一个词的位置写了三个词，词的右边、上下紧挨着就是别的字）：回一条带两行长句子的
//    wavy、一条 cross、一条 strike——符号照旧画在那个词上、旁边；那句话画出来的每一行（按屏幕上实际画的字量，不借用页面里的障碍清单）
//    不压任何一笔用户的字、不压别的蓝字（字、符号、小蓝点），在纸上；离得远的有细线连回符号（线的一头挨着符号、一头挨着那句话）；
// 2. 交给 AI 的单页图里那句话在它现在的位置（那里有蓝字），老位置（压着字的地方）没有蓝字；
// 3. 橡皮擦到这句话：符号一起擦掉；撤销一起回来；
// 4. 之后黑笔写到这句话上：收成小蓝点；
// 5. 第 2 页四周都写满：那句话收成小蓝点（纸上没有它的字），符号照画；点一下小蓝点浮出那句话；交给 AI 的图里那里是小蓝点；
// 6. 第 3 页空旷：三条的那句话都还在符号旁的老位置（和改之前一样：还在那一条上、没有细线，wavy、cross 照老公式的位置）；
// 7. 刷新后都还在；
// 8. 书页上照旧（老位置、在那一条上）。
// 空旷页、书页的位置还写进 out/spots.json，和改之前的页面跑出来的那份逐条比过（见报告）。
// 笔是 pointerType 为 pen 的鼠标事件；只在无头 Edge 里跑过，没在 iPad 上试过。
// 跑法：node tests/run_browser.mjs <临时目录> --only mark_room；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'mark-room', pages: 3 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const line = (x0, y, len, n = 6) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 2]);
const word = (x0, y, len, n = 12) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2 ? 6 : -6)]);
const nums = (d) => (String(d).match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
const boxDist = (a, b) => Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
const ptBox = (p, b) => Math.hypot(Math.max(0, b[0] - p[0], p[0] - b[2]), Math.max(0, b[1] - p[1], p[1] - b[3]));
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
async function landed(n) { // 等写回的批注落到这一页（至少 n 条），并且一条条写完
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 60000)) && ok;
}
async function send() { // 点「AI」交上去，返回投递和分组
  await T.saved();
  await T.tap('#check');
  const sub = await T.waitSub('S1', 400), meta = sub && T.metaOf(sub); // 写满的页交上去要等十几到三十秒（无头浏览器里画图、出字帖）
  return { sub, meta };
}
// 一条批改符号（这一页上这种的第一条没擦掉的）和带着它那句话的那一条（符号自己，或另成的一条）
const pair = (type, text) => js(`(() => { const S = window.__ink.S, m = S.page.ai.find((a) => a.type === '${type}');
  const t = S.page.ai.find((a) => a.text === ${JSON.stringify(text)}); return { m: m ? JSON.parse(JSON.stringify(m)) : null, t: t ? JSON.parse(JSON.stringify(t)) : null, n: S.page.ai.length }; })()`);
// 屏幕上一个元素画出来的框，换成页面坐标
const PG = `const st = document.querySelector('#stage').getBoundingClientRect(), V = window.__ink.S.view;
  const pg = (e) => { const r = e.getBoundingClientRect(); return [(r.left - st.left - V.tx) / V.s, (r.top - st.top - V.ty) / V.s, (r.right - st.left - V.tx) / V.s, (r.bottom - st.top - V.ty) / V.s]; };
  const ok = (b) => b[2] > b[0] && b[3] > b[1];`;
// 这一条在纸上画出来的字（每一行一个框）、细线、是不是小蓝点
const drawn = (id) => js(`(() => { ${PG} const g = document.querySelector('#aiRoot > g[data-id="' + ${JSON.stringify(id)} + '"]'); if (!g) return null;
  const lead = g.querySelector('path.leader');
  return { rows: [...g.querySelectorAll(':scope > text:not(.adopt-star)')].map(pg).filter(ok), lead: lead ? lead.getAttribute('d') : null,
    sym: [...g.querySelectorAll('path:not(.leader)')].length, dot: g.classList.contains('ai-dot') }; })()`);
// 这几行字压到了什么：用户的每一笔（点的外框加半个笔宽）、别的蓝字（批注层上别的条目的字、小圈、小点）、所有的符号线（自己的也算），纸边
const clashes = (id) => js(`(() => { ${PG} const S = window.__ink.S, me = ${JSON.stringify(id)};
  const meet = (a, b) => a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1;
  const g = document.querySelector('#aiRoot > g[data-id="' + me + '"]'); if (!g) return ['没画出来'];
  const rows = [...g.querySelectorAll(':scope > text:not(.adopt-star)')].map(pg).filter(ok);
  const ink = S.page.strokes.filter((s) => !s.erasedAt && s.pts.length).map((s) => { const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]), h = (s.w || 2) / 2;
    return [Math.min(...xs) - h, Math.min(...ys) - h, Math.max(...xs) + h, Math.max(...ys) + h]; });
  const groups = [...document.querySelectorAll('#aiRoot > g[data-id]')];
  const blue = groups.filter((x) => x !== g).flatMap((x) => [...x.querySelectorAll('text, circle, ellipse')]).concat(groups.flatMap((x) => [...x.querySelectorAll('path:not(.leader)')]))
    .map(pg).filter((b) => b[2] >= b[0] && b[3] >= b[1]);
  const out = [];
  for (const r of rows) {
    const hi = ink.filter((o) => meet(r, o)), hb = blue.filter((o) => meet(r, o));
    if (hi.length) out.push(['压字', r, hi.slice(0, 3)]);
    if (hb.length) out.push(['压蓝字', r, hb.slice(0, 3)]);
    if (r[0] < S.X0 || r[2] > S.TW || r[1] < S.Y0) out.push(['出纸', r]);
  }
  return out; })()`);
// 交给 AI 的图（crop.jpg）里几块页面坐标的框各有多少蓝色的点
function bluePixels(file, k, boxes) {
  const b64 = readFileSync(file).toString('base64');
  const px = (b) => [b[0] - k.x0, b[1] - k.y0, b[2] - k.x0, b[3] - k.y0].map((v) => v * k.scale);
  return js(`new Promise((res) => { const im = new Image(); im.onload = () => { const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const x = cv.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, im.width, im.height).data, blue = (i) => d[i + 2] - d[i] > 50 && d[i + 2] > 90, boxes = ${JSON.stringify(boxes.map(px))};
    res(boxes.map((b) => { let n = 0; for (let Y = Math.max(0, Math.floor(b[1])); Y < Math.min(im.height, b[3]); Y++) for (let X = Math.max(0, Math.floor(b[0])); X < Math.min(im.width, b[2]); X++) if (blue((Y * im.width + X) * 4)) n++; return n; })); };
    im.onerror = () => res(null); im.src = 'data:image/jpeg;base64,${b64}'; })`);
}
const SHOTS = [];
const shot = async (file, box) => { // box：只截页面上这一块（页面坐标），放大来看
  let clip;
  if (box) { const [x0, y0] = await T.screenOf(box[0], box[1]), [x1, y1] = await T.screenOf(box[2], box[3]); clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: 2.5 }; }
  const z = await T.cdp('Page.captureScreenshot', Object.assign({ format: 'png' }, clip ? { clip } : {})); const f = join(T.OUT, file); writeFileSync(f, Buffer.from(z.data, 'base64')); SHOTS.push(f); };
const noFlow = async () => { if (await S('S.flow')) { await js('window.__ink.toggleFlow()'); await sleep(600); } };
const waitToast = () => T.waitFor(`document.querySelector('#toast').hidden`, 6000);
// 一行行满宽的字（每行一笔，隔 24），holes 里的那几处空出来（[行的 y, 左, 右]）
async function fill(y0, y1, holes = []) {
  for (let y = y0; y <= y1; y += 24) {
    const h = holes.find((q) => q[0] === y);
    if (!h) { await T.pen(line(10, y, 1360), 120); continue; }
    await T.pen(line(10, y, h[1] - 20 - 10), 120);
    await T.pen(line(h[2] + 20, y, 1370 - h[2] - 20), 120);
  }
}
const groupAt = (meta, x0, y) => meta && meta.groups.find((g) => Math.abs(g.bbox[0] - x0) < 8 && g.bbox[1] < y && g.bbox[3] > y && g.n === 1);

await noFlow();

// ================= 1. 第 1 页：写得密，三处空出一个词的位置写了三个词
const HA = [396, 420, 540], HB = [468, 620, 740], HC = [540, 420, 540];
await fill(300, 636, [HA, HB, HC]);
for (const h of [HA, HB, HC]) { await sleep(2000); await T.pen(word(h[1], h[0], h[2] - h[1])); }
await T.pen(line(100, 1200, 60)); // 交之前再写一笔（和下面无关）
const s1 = await send();
const gA = groupAt(s1.meta, HA[1], HA[0]), gB = groupAt(s1.meta, HB[1], HB[0]), gC = groupAt(s1.meta, HC[1], HC[0]);
T.ok('（前提）第 1 页交上去了：三个词各自一组', Boolean(gA && gB && gC) && new Set([gA.id, gB.id, gC.id]).size === 3, s1.meta && s1.meta.groups.map((g) => [g.id, g.n, g.bbox]));
const SW = '这里的符号前后不一致：上一行写的是加号，这一行变成了减号，要统一一下';
const SC = '这一步漏了一个系数二';
const SS = '改为：平方';
const rep1 = await T.post('/bridge/reply', { sid: 'S1', submission: s1.sub.id, items: [
  { type: 'wavy', anchor: gA.id, text: SW }, { type: 'cross', anchor: gB.id, text: SC }, { type: 'strike', anchor: gC.id, text: SS }] });
T.ok('（前提）服务收下了 3 条', rep1.ok === true && rep1.count === 3, rep1);
T.ok('（前提）落下、写完了', await landed(3));
await sleep(300);
const P1 = {};
for (const [k, type, text, g] of [['wavy', 'wavy', SW, gA], ['cross', 'cross', SC, gB], ['strike', 'strike', SS, gC]]) {
  const p = await pair(type, text);
  P1[k] = Object.assign(p, { g, d: p.t ? await drawn(p.t.id) : null, dm: p.m ? await drawn(p.m.id) : null, c: p.t ? await clashes(p.t.id) : ['没有'] });
}
T.ok('符号照旧画在那个词上、旁边（波浪线在词下面、✗ 在词右边、删除线穿过词）', ['wavy', 'cross', 'strike'].every((k) => P1[k].m && P1[k].dm && P1[k].dm.sym >= 1)
  && P1.wavy.m.sym[1] >= gA.bbox[3] - 2 && P1.cross.m.sym[0] >= gB.bbox[2] && P1.strike.m.sym[1] < gC.bbox[3] && P1.strike.m.sym[3] > gC.bbox[1],
  ['wavy', 'cross', 'strike'].map((k) => P1[k].m && P1[k].m.sym));
T.ok('那句话画出来了（几行字都在纸上画着）', ['wavy', 'cross', 'strike'].every((k) => P1[k].d && P1[k].d.rows.length === P1[k].t.lay.lines.length && P1[k].d.rows.length >= 1),
  ['wavy', 'cross', 'strike'].map((k) => P1[k].d && P1[k].d.rows.length));
for (const k of ['wavy', 'cross', 'strike']) {
  T.ok(`密的页上 ${k} 那句话：每一行不压用户的字、不压别的蓝字和符号、在纸上`, P1[k].c.length === 0, P1[k].c);
}
// 离符号（连同它批的那个词）远了的：有细线，一头挨着符号、一头挨着那句话
const far = {};
for (const k of ['wavy', 'cross', 'strike']) {
  const { m, t, d } = P1[k];
  if (!m || !t || !t.lay) { far[k] = null; continue; }
  const L = [t.lay.x, t.lay.y, t.lay.x + t.lay.w, t.lay.y + t.lay.h], A = union(P1[k].g.bbox, m.sym);
  const n = d && d.lead ? nums(d.lead) : [];
  far[k] = { dist: boxDist(L, A), lead: Boolean(d && d.lead), ends: n.length >= 4 ? [ptBox([n[0], n[1]], m.sym), ptBox([n[n.length - 2], n[n.length - 1]], [L[0] - 4, L[1], L[2], L[3]])] : null };
}
T.ok('（前提）三句都离开了老位置、离符号远（超过一行）', ['wavy', 'cross', 'strike'].every((k) => far[k] && far[k].dist > 28), far);
T.ok('离得远的都有细线连回符号：线的一头挨着符号、一头挨着那句话', ['wavy', 'cross', 'strike'].every((k) => far[k] && far[k].lead && far[k].ends && far[k].ends[0] < 3 && far[k].ends[1] < 6), far);
T.ok('删除线写在上方的那句：放在上面（先上、再右、下、左）', Boolean(P1.strike.t && P1.strike.t.lay) && P1.strike.t.lay.y + P1.strike.t.lay.h <= gC.bbox[1], P1.strike.t && P1.strike.t.lay);
await waitToast();
await shot('1-dense-room.png');
await shot('1b-dense-room-zoom.png', [300, 200, 1100, 820]);

// ================= 2. 交给 AI 的图：那句话在现在的位置，老位置（波浪线那个词右边，压着字）没有蓝字
await T.pen(line(100, 1250, 60));
const s2 = await send();
const L2 = P1.wavy.t && P1.wavy.t.lay, OLD2 = [gA.bbox[2] + 14, gA.bbox[3] - 18, gA.bbox[2] + 200, gA.bbox[3] + 6];
const bp2 = s2.sub && L2 && (await bluePixels(join(T.DATA, 'submissions', s2.sub.id, 'crop.jpg'), s2.meta.crop, [[L2.x, L2.y, L2.x + L2.w, L2.y + L2.h], OLD2]));
T.ok('交给 AI 的图里：wavy 那句话在它现在的位置（那里有蓝字），老位置没有蓝字', Boolean(bp2) && bp2[0] > 40 && bp2[1] < 15, bp2);

// ================= 3. 橡皮擦到 cross 那句话：✗ 一起擦掉；撤销一起回来
const tc = P1.cross.t;
await T.tool('eraser');
await T.pen(line(tc.lay.x + 6, tc.lay.y + 16, 30, 6));
await T.tool('pen');
let pc = await pair('cross', SC);
T.ok('橡皮擦到 cross 那句话：那句话和 ✗ 一起擦掉了', Boolean(pc.m && pc.t) && Boolean(pc.m.erasedAt) && Boolean(pc.t.erasedAt), pc.m && [pc.m.erasedAt, pc.t && pc.t.erasedAt]);
await T.tap('#toolsUndo');
pc = await pair('cross', SC);
T.ok('撤销：两样一起回来', Boolean(pc.m && pc.t) && !pc.m.erasedAt && !pc.t.erasedAt, pc.m && [pc.m.erasedAt, pc.t && pc.t.erasedAt]);

// ================= 4. 之后黑笔写到 wavy 那句话上：收成小蓝点
await sleep(1100);
await T.pen(line(L2.x + 4, L2.y + 16, Math.min(120, L2.w - 8), 8));
const pw = await pair('wavy', SW);
T.ok('之后黑笔写到那句话上：收成小蓝点（因为被字压到）', Boolean(pw.t && pw.t.dot) && pw.t.dot.why === 'ink' && Boolean((await drawn(pw.t.id)).dot), pw.t && pw.t.dot);
T.ok('收成小蓝点以后波浪线还在', Boolean(pw.m && !pw.m.erasedAt && (await drawn(pw.m.id)).sym >= 1));
await send(); // 这一笔先交掉（下面第 2 页交的时候只交那一页）

// ================= 5. 第 2 页：四周都写满，中间一个词
await T.openPage(1);
await noFlow();
const HD = [700, 500, 620];
await fill(316, 1084, [HD]);
await sleep(2000);
await T.pen(word(HD[1], HD[0], HD[2] - HD[1]));
await T.pen(line(100, 150, 60));
const s5 = await send();
const gD = groupAt(s5.meta, HD[1], HD[0]);
T.ok('（前提）第 2 页交上去了：中间那个词自己一组', Boolean(gD), s5.meta && s5.meta.groups.map((g) => [g.id, g.n, g.bbox]));
const SD = '这个式子和上面那一行对不上，要再核对一下';
await T.post('/bridge/reply', { sid: 'S1', submission: s5.sub.id, items: [{ type: 'wavy', anchor: gD.id, text: SD }] });
T.ok('（前提）落下、写完了', await landed(1));
await sleep(300);
const pd = await pair('wavy', SD), dd = pd.t ? await drawn(pd.t.id) : null;
T.ok('四周都写满：那句话收成小蓝点（因为放不下），纸上没有它的字', Boolean(pd.t && pd.t.dot) && pd.t.dot.why === 'room' && Boolean(dd && dd.dot) && dd.rows.length === 0, [pd.t && pd.t.dot, dd]);
T.ok('波浪线照画在那个词下面', Boolean(pd.m && pd.m.sym) && pd.m.sym[1] >= gD.bbox[3] - 2 && (await drawn(pd.m.id)).sym >= 1, pd.m && pd.m.sym);
const sb5 = await S(`S.page.strokes.filter((s) => !s.erasedAt).map((s) => { const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]); return [Math.min(...xs) - s.w / 2, Math.min(...ys) - s.w / 2, Math.max(...xs) + s.w / 2, Math.max(...ys) + s.w / 2]; })`);
const dotB = pd.t && pd.t.dot ? [pd.t.dot.at[0] - 7, pd.t.dot.at[1] - 7, pd.t.dot.at[0] + 7, pd.t.dot.at[1] + 7] : null;
T.ok('小蓝点在那个词旁边，不压字', Boolean(dotB) && boxDist(dotB, union(gD.bbox, pd.m.sym)) < 30 && sb5.every((b) => !(dotB[0] < b[2] - 1 && b[0] < dotB[2] - 1 && dotB[1] < b[3] - 1 && b[1] < dotB[3] - 1)), dotB);
await waitToast();
await sleep(1100);
const at5 = pd.t && pd.t.dot ? pd.t.dot.at : null; // 没收成小蓝点（改之前的页面）：下面这几项都不对，接着往下查别的
let pop = null;
if (at5) {
  const [dx, dy] = await T.screenOf(at5[0], at5[1]);
  await T.fingerTapAt(dx, dy);
  pop = await js(`(() => { const c = document.querySelector('#answerCard'); return c.hidden ? null : c.innerText; })()`);
}
T.ok('点一下小蓝点：浮出那句话', Boolean(pop) && pop.replace(/\s+/g, '').includes(SD), pop);
await shot('2-full-dot.png');
await js('window.__ink.closeCard()');
await T.pen(line(100, 1250, 60));
const s5b = await send();
const OLD5 = [Math.max(gD.bbox[2] + 14, at5 ? at5[0] + 12 : 0), gD.bbox[3] - 18, gD.bbox[2] + 250, gD.bbox[3] + 6]; // 老位置（小蓝点右边那一段）
const bp5 = s5b.sub && at5 && (await bluePixels(join(T.DATA, 'submissions', s5b.sub.id, 'crop.jpg'), s5b.meta.crop, [[at5[0] - 8, at5[1] - 8, at5[0] + 8, at5[1] + 8], OLD5]));
T.ok('交给 AI 的图里：那里是小蓝点，老位置没有蓝字', Boolean(bp5) && bp5[0] > 10 && bp5[1] < 15, bp5);

// ================= 6. 第 3 页：空旷，三个词
await T.openPage(2);
await noFlow();
await T.pen(word(200, 300, 120));
await sleep(2000);
await T.pen(word(200, 600, 120));
await sleep(2000);
await T.pen(word(200, 900, 120));
const s6 = await send();
const [e1, e2, e3] = ['g1', 'g2', 'g3'].map((id) => s6.meta && s6.meta.groups.find((g) => g.id === id));
T.ok('（前提）第 3 页交上去了：三组', Boolean(e1 && e2 && e3), s6.meta && s6.meta.groups);
await T.post('/bridge/reply', { sid: 'S1', submission: s6.sub.id, items: [
  { type: 'wavy', anchor: 'g1', text: SW }, { type: 'cross', anchor: 'g2', text: SC }, { type: 'strike', anchor: 'g3', text: SS }] });
T.ok('（前提）落下、写完了', await landed(3));
await sleep(300);
const E = {};
for (const [k, text] of [['wavy', SW], ['cross', SC], ['strike', SS]]) E[k] = await pair(k, text);
T.ok('空旷的页上：三句都还在符号那一条上（没有另成一条），这一页一共三条', ['wavy', 'cross', 'strike'].every((k) => E[k].m && E[k].t && E[k].t.id === E[k].m.id && E[k].m.lay) && E.wavy.n === 3,
  ['wavy', 'cross', 'strike'].map((k) => [E[k].m && E[k].m.id, E[k].t && E[k].t.id]));
const near = (u, v) => Math.abs(u - v) <= 1.5;
T.ok('wavy 那句话在老位置：词的右边隔 12、词底往上 20', Boolean(E.wavy.m && E.wavy.m.lay) && near(E.wavy.m.lay.x, e1.bbox[2] + 12) && near(E.wavy.m.lay.y, e1.bbox[3] - 20), [E.wavy.m && E.wavy.m.lay, e1.bbox]);
T.ok('cross 那句话在老位置：✗ 的右边（词右 42）、和词的中线齐', Boolean(E.cross.m && E.cross.m.lay) && near(E.cross.m.lay.x, e2.bbox[2] + 42) && near(E.cross.m.lay.y, (e2.bbox[1] + e2.bbox[3]) / 2 - 14),
  [E.cross.m && E.cross.m.lay, e2.bbox]);
const ls = E.strike.m && E.strike.m.lay;
T.ok('strike 那句话在老位置：词的正上方（居中）', Boolean(ls) && Math.abs(ls.x + ls.w / 2 - (e3.bbox[0] + e3.bbox[2]) / 2) <= 2 && ls.y + ls.h <= e3.bbox[1] + 1 && ls.y >= e3.bbox[1] - 32 - 26 - 1, [ls, e3.bbox]);
const dE = await Promise.all(['wavy', 'cross', 'strike'].map((k) => drawn(E[k].m.id)));
T.ok('空旷的页上：没有细线，字画在纸上', dE.every((d) => d && !d.lead && d.rows.length >= 1), dE);
await waitToast();
await shot('3-empty-old-spot.png');

// ================= 7. 刷新后都还在
await T.saved();
await T.reload();
await noFlow();
await T.openPage(0);
await noFlow();
const back1 = await S('S.page.ai.map((a) => [a.id, a.type, a.of || null, a.lay || null, a.dot || null])');
const disk1 = (T.pageFile('scratch', 0) || { ai: [] }).ai.map((a) => [a.id, a.type, a.of || null, a.lay || null, a.dot || null]);
T.ok('刷新后第 1 页：符号、另成的那几句（连同收成的小蓝点）都在，和存回电脑的一样', JSON.stringify(back1) === JSON.stringify(disk1) && back1.length === 6
  && back1.filter((a) => a[2]).length === 3, [back1.length, back1.map((a) => a[1] + (a[2] ? '→' : ''))]);
const pcb = await pair('cross', SC), pwb = await pair('wavy', SW);
T.ok('刷新后：cross 那句话画在它找到的地方、细线还在；wavy 那句话是小蓝点', Boolean(pcb.t) && (await drawn(pcb.t.id)).rows.length >= 1 && Boolean((await drawn(pcb.t.id)).lead)
  && Boolean((await drawn(pwb.t.id)).dot));
await T.openPage(1);
await noFlow();
const pdb = await pair('wavy', SD);
T.ok('刷新后第 2 页：小蓝点还在', Boolean(pdb.t && pdb.t.dot) && Boolean((await drawn(pdb.t.id)).dot));

// ================= 8. 书页上照旧
const SRC = join(T.ROOT, 'src'), PDF = join(SRC, 'notes.pdf');
mkdirSync(SRC, { recursive: true });
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
doc=fitz.open()
p=doc.new_page(width=1000,height=1300)
p.insert_text((60,120),'Chapter 1',fontsize=36)
doc.save(sys.argv[1])`, PDF]);
const imp = await T.post('/bridge/import', { sid: 'S1', path: PDF });
await T.openNotebook(imp.id, 0);
await noFlow();
T.ok('（前提）打开了导入的书页', (await S('S.nb.kind')) === 'book', await S('S.nb.kind'));
await T.pen(word(100, 600, 120));
const s8 = await send();
const b8 = s8.meta && s8.meta.groups[0];
await T.post('/bridge/reply', { sid: 'S1', submission: s8.sub.id, items: [{ type: 'wavy', anchor: 'g1', text: SW }] });
T.ok('（前提）落下了', await landed(1));
const pb = await pair('wavy', SW);
T.ok('书页上照旧：那句话在符号那一条上、在老位置（词的右边隔 12、词底往上 20）', Boolean(pb.m && pb.m.lay) && pb.t && pb.t.id === pb.m.id && pb.n === 1
  && near(pb.m.lay.x, b8.bbox[2] + 12) && near(pb.m.lay.y, b8.bbox[3] - 20), [pb.m && pb.m.lay, b8 && b8.bbox]);
await waitToast();
await shot('4-book.png');

// 空旷页、书页的样子：写下来，和改之前跑出来的那份比
const look = (p) => p.m && { type: p.m.type, lay: p.m.lay, sym: p.m.sym, paths: (p.m.paths || []).length, hit: p.m.hit };
writeFileSync(join(T.OUT, 'spots.json'), JSON.stringify({ empty: ['wavy', 'cross', 'strike'].map((k) => look(E[k])), book: look(pb) }, null, 1));
console.error('截图：\n' + SHOTS.join('\n'));
T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

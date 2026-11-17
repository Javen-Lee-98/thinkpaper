// 纸上的短批注上写红字（2026-11-14 用户定；怎么算「写在上面」、什么时候变、圈号放哪是用户不在时暂定的）。
// 《产品定义》第 3 节「在卡片上用红笔批注、追问」末尾：红笔写在一条短批注上或紧挨着它，点「AI」时它收成圈号、变成卡片，
// 里面依次是原来那句、用户的红字、Claude 的回应；之后和长回答的卡片一样能接着批。没被红笔碰过的短批注照旧留在纸上。查：
// 1. 红笔写在一条短批注上（一笔压着字，同一口气接着在框外写了一笔）、另一条紧挨着写黑笔（不压字）、第三条旁画星号、离批注远的地方写一句红笔，点「AI」：
//    只有第一条变了——纸上那条批注和那两笔红字没了，所指的笔迹（那句红笔问题）旁出现空心圈号；黑笔、星号、远处的红笔照旧；
//    投递里有这张卡片（图里蓝字、红字都在、红字在它批的那一行下面），消息写明它原来是纸上的短批注；发给 Claude 的整页图里那儿已经是圈号；
//    交出去后圈号上没有红点；页面文件里新条目带着原来那条批注（from）、换算（fromMap）、排版快照（sheet）。
// 2. 点开卡片：第一块是原来那几行（和纸上同样换行），没有「问：」；两笔红字都在卡片上、相对它压着的字的位置和纸上一样（按页面单位比），
//    写在框外的那一笔完整显示在卡片里。
// 3. Claude 用 write + card 回：接在下面，前面写着那句红字，圈号变实心、跳两下；上面的字和红字不错位。刷新后都还在、位置对。
// 4. 再在卡片上写红字、再交：又交这张卡片（只交新的那笔），消息里之前写过的批注写着「原来是短批注」。
// 5. 第 2 页：两条批注挨着、一笔红字两条都压到——归压得多的那条；写在批注上的红字交之前擦掉、撤销掉——不变；
//    一条批注上两组红字、一组拉得太远（太高）——近的那组收进卡片，远的那组整组留在纸上、照旧当普通红笔交（第二轮暂定）；
//    交稿失败（拦下 /api/send）——批注已经变成卡片、红字算没交（圈号带红点），刷新后一样，下次点「AI」照样交上去。
// 6. 回到第 1 页，在第三条（采纳过的）批注上写红字，翻到第 2 页写字、点「AI」：几页一起交，第 1 页那条也先变成卡片（带着采纳），
//    整本消息里有它的图和「原来是你写在纸上的一条短批注」；翻回第 1 页，圈号在、红点没了。
// 7. 几页一起交时第 1 页的一笔没收成卡片（取那一页没取到），当普通红笔交了；翻回第 1 页再单页交：那一笔不再被收成卡片
//    （几页一起交后，交上去的页记下了交到哪一笔为止，第二轮补的）。
// 笔是 pointerType 为 pen 的鼠标事件，手指是 CDP 的触摸事件；只在无头 Edge 里跑过。
// 跑法：node tests/run_browser.mjs <临时目录> --only note_followup；有一项不对退出码 1。
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'note-followup', pages: 2 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const waitPen = () => sleep(1150); // 笔刚用过的一秒内手指不算（手掌）

// ---- 小工具
const hline = (x0, y, len, n = 14) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 0.6]);
const seg = (pts, n = 8) => pts.slice(1).flatMap((b, k) => Array.from({ length: n }, (_, i) => [pts[k][0] + ((b[0] - pts[k][0]) * i) / n, pts[k][1] + ((b[1] - pts[k][1]) * i) / n])).concat([pts[pts.length - 1]]);
const star = (cx, cy, R = 22) => seg(Array.from({ length: 6 }, (_, k) => { const t = -Math.PI / 2 + (k * 4 * Math.PI) / 5; return [cx + R * Math.cos(t), cy + R * Math.sin(t)]; }), 10);
async function landed(n) { // 等写回的批注落到这一页（一共 n 条），并且一条条写完
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
// 一条短批注（纸上的，不是收成的卡片）：数据和纸上画出来的每一行字（屏幕上的框）
const noteOf = (text) => js(`(() => { const S = window.__ink.S, a = S.page.ai.find((o) => o.text === ${JSON.stringify(text)} && o.type !== 'write'); if (!a) return null;
  const g = document.querySelector('#aiRoot g[data-id="' + a.id + '"]');
  const lines = g ? [...g.querySelectorAll('text:not(.adopt-star)')].map((t) => { const r = t.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, s: t.textContent }; }) : [];
  return { id: a.id, type: a.type, lay: a.lay, adopted: Boolean(a.adopted), lines, s: S.view.s, drawn: Boolean(g) }; })()`);
const item = (id) => S(`(() => { const a = S.page.ai.find((o) => o.id === ${JSON.stringify(id)}); return a ? JSON.parse(JSON.stringify(a)) : null; })()`);
const badges = () => js(`[...document.querySelectorAll('#aiRoot .badge')].filter((g) => !g.classList.contains('nbr-badge')).map((g) => { const c = g.querySelector('circle'), r = c.getBoundingClientRect();
  return { id: g.dataset.id, num: g.querySelector('.bdg text').textContent, cx: r.left + r.width / 2, cy: r.top + r.height / 2, seen: g.classList.contains('seen'), dot: Boolean(g.querySelector('.bdot')),
    adopted: g.classList.contains('adopted'), fill: getComputedStyle(c).fill }; })`);
const badge = async (id) => (await badges()).find((b) => b.id === id);
// 开着的卡片：框、缩放（k：卡片的倍数，u：纸上那块换算进卡片的倍数）、最上面那几行字（屏幕上的框）、红字、接着的各段
const card = () => js(`(() => { const c = document.querySelector('#answerCard'); if (c.hidden) return null; const r = c.getBoundingClientRect(), S = window.__ink.S, a = window.__ink.cardItem();
  const R = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  const pg = document.querySelector('#acPage').getBoundingClientRect(), sz = document.querySelector('#acSizer').getBoundingClientRect();
  return { id: S.card && S.card.id, l: r.left, t: r.top, r: r.right, b: r.bottom, st: c.scrollTop, k: S.card && S.card.k, u: a && a.fromMap ? a.fromMap.u : null,
    page: { l: pg.left, t: pg.top, r: pg.right, b: pg.top + sz.height }, qHidden: document.querySelector('#acQ').hidden,
    lines: [...document.querySelectorAll('#acBody .ac-note text')].map((t) => Object.assign(R(t), { s: t.textContent })),
    marks: [...document.querySelectorAll('#acInk path:not(.live), #acInk circle:not(.live)')].map((p) => Object.assign(R(p), { id: p.dataset.id })),
    segs: [...document.querySelectorAll('#acMore .ac-seg')].map((d) => Object.assign(R(d), { mq: (d.querySelector('.ac-mq') || {}).textContent || null, text: d.querySelector('.ac-mbody').textContent })) }; })()`);
const openBadge = async (id) => { await waitPen(); const b = await badge(id); if (!b) return null; await T.fingerTapAt(b.cx, b.cy); return card(); };
const closeCardByTap = async () => { await waitPen(); const [x, y] = await T.screenOf(600, 1100); await T.fingerTapAt(x, y); };
// 一笔在屏幕上的框（按笔迹的点，不算笔画粗细）
const strokeScreen = async (st) => { const xs = st.pts.map((p) => p[0]), ys = st.pts.map((p) => p[1]);
  const [l, t] = await T.screenOf(Math.min(...xs), Math.min(...ys)), [r, b] = await T.screenOf(Math.max(...xs), Math.max(...ys)); return { l, t, r, b }; };
// 一笔相对一行字的位置，换成页面单位（s：屏幕上一个页面单位多少像素）
const relTo = (m, line, s) => [(m.l - line.l) / s, (m.t - line.t) / s, (m.r - line.l) / s, (m.b - line.t) / s];
const near = (a, b, d) => Boolean(a && b) && a.every((v, i) => Math.abs(v - b[i]) <= d);
const toastText = () => js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
const installLog = () => js(`(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (!t.hidden) window.__toasts.push(t.textContent); })
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true, attributes: true });
  window.__fresh = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType !== 1) continue;
    for (const g of [n, ...n.querySelectorAll('*')]) if (g.classList && g.classList.contains('badge') && g.classList.contains('fresh')) {
      const b = g.querySelector('.bdg'), cs = getComputedStyle(b); window.__fresh.push({ id: g.dataset.id, anim: cs.animationName, n: cs.animationIterationCount }); } } })
  .observe(document.querySelector('#aiRoot'), { childList: true, subtree: true }); return 1; })()`);
const resetLog = () => js(`(window.__toasts = [], window.__fresh = [], 1)`);
const log = () => js(`({ toasts: window.__toasts, fresh: window.__fresh })`);
// 截一块屏幕（放大 2 倍）：x、y、w、h 是屏幕像素
const clipShot = async (file, x, y, w, h) => {
  const z = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, x), y: Math.max(0, y), width: w, height: h, scale: 2 } });
  writeFileSync(join(T.OUT, file), Buffer.from(z.data, 'base64'));
  return join(T.OUT, file);
};
// 一张 PNG（或 JPG）里红色、蓝色的点：红点的外框和个数；band：只数这一段 y（像素）里的蓝点；box：只数这一块（像素）里的
function pixels(file, band, box, type = 'png') {
  const b64 = readFileSync(file).toString('base64');
  return js(`new Promise((res) => { const im = new Image(); im.onload = () => { const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const x = cv.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, im.width, im.height).data, band = ${JSON.stringify(band || null)}, bx = ${JSON.stringify(box || null)}; let red = 0, blue = 0, inBand = 0, inBox = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let Y = 0; Y < im.height; Y++) for (let X = 0; X < im.width; X++) { const i = (Y * im.width + X) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      if (r > 150 && g < 130 && b < 130) { red++; x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y); }
      else if (b - r > 50 && b > 90) { blue++; if (band && Y >= band[0] && Y <= band[1]) inBand++; if (bx && X >= bx[0] && X <= bx[2] && Y >= bx[1] && Y <= bx[3]) inBox++; } }
    res({ w: im.width, h: im.height, red, blue, inBand, inBox, box: [x0, y0, x1, y1] }); }; im.onerror = () => res(null); im.src = 'data:image/${type};base64,${b64}'; })`);
}
await installLog();
const SHOTS = [];
// 拦请求（Fetch.enable 时才拦）：failIf(请求) 为真的让它连不上，其余照常放行
let failIf = null;
T.onCdp('Fetch.requestPaused', (p) => {
  if (failIf && failIf(p.request)) T.cdp('Fetch.failRequest', { requestId: p.requestId, errorReason: 'InternetDisconnected' }).catch(() => {});
  else T.cdp('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
});

// ================= 0. 单页；第 1 页三句红笔问题，交上去；Claude 回三条短批注（第一条两行长）
if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }
await T.tool('red');
await T.pen(T.line(120, 200, 300));
await T.pen(T.line(120, 420, 300));
await T.pen(T.line(120, 640, 300));
await T.tool('pen');
await T.tap('#check');
const sub1 = await T.waitSub('S1', 80), meta1 = sub1 && T.metaOf(sub1);
T.ok('（前提）交上去了：三句红笔问题', Boolean(meta1) && meta1.groups.length === 3 && meta1.groups.every((g) => g.red), meta1 && meta1.groups);
const NOTE1 = '第二天上午先去博物馆，下午人少的时候再去公园散步。', NOTE2 = '记得带雨伞', NOTE3 = '车票要提前买';
await T.post('/bridge/reply', { sid: 'S1', submission: sub1.id, items: [
  { type: 'note', anchor: 'g1', text: NOTE1 }, { type: 'question', anchor: 'g2', text: NOTE2 }, { type: 'note', anchor: 'g3', text: NOTE3 }] });
T.ok('（前提）三条短批注落下、写完了', await landed(3));
await sleep(300);
let n1 = await noteOf(NOTE1);
const n2 = await noteOf(NOTE2), n3 = await noteOf(NOTE3);
// 空白本子不留批注栏了（阶段 D1 第二部分）：第一条在所指那句红笔问题（右端 420）的右边，不再在页边那一栏（x > 1000）
T.ok('（前提）第一条在所指那句的右边、两行（纸上的换行），第二条是 question', Boolean(n1 && n2 && n3) && n1.lay.lines.length === 2 && n1.lines.length === 2
  && n1.lay.x > 420 && n1.lay.x < 420 + 60 && n2.type === 'question', n1 && [n1.lay, n1.lines.length]);

// ================= 1. 第一条上写红字：一笔压在第一行的几个字下面，同一口气在框外（下面）又写一笔；第二条上写黑笔；第三条旁画星号；远处写一句红笔
const L = n1.lay;
await T.tool('red');
await T.pen(hline(L.x + 2 * L.fs, L.y + L.fs + 5, 5 * L.fs)); // 压着第一行第 3–7 个字的下沿
const yb = L.y + (L.lines.length - 1) * L.lh + L.fs * 1.2 + 30; // 最后一行字底下 30：出了放宽的那一圈（10）
await T.pen([[L.x + 140, yb], [L.x + 150, yb - 8], [L.x + 160, yb], [L.x + 152, yb + 10], [L.x + 152, yb + 16]]);
const reds1 = await S(`S.page.strokes.filter((s) => s.c === 'r').slice(-2).map((s) => JSON.parse(JSON.stringify(s)))`);
const [mkA, mkB] = reds1;
T.ok('（前提）这两笔是同一组（同一口气写的），第二笔在批注的字框外', (await js(`(() => { const gs = window.__ink.computeGroups(window.__ink.S.page.strokes); const ids = ${JSON.stringify(reds1.map((s) => s.id))};
  return gs.some((g) => ids.every((id) => g.strokes.some((s) => s.id === id))); })()`)) && Math.min(...mkB.pts.map((p) => p[1])) > L.y + L.lh + L.fs * 1.2 + 10, reds1.map((s) => s.pts[0]));
await T.tool('pen');
// 黑笔紧挨着第二条写（字底下 5，在红笔算「写在批注上」的那一圈里）。阶段 D1 第二部分起空白本子里黑笔压到字会把批注收成小蓝点
// （见 note_dot.mjs），所以这里改成紧挨着、不压字：查的仍是「黑笔不会让批注变成卡片」；第二条留在纸上，第 7 段还要在它上面写红字
await T.pen(hline(n2.lay.x - 4, n2.lay.y + (n2.lay.lines.length - 1) * n2.lay.lh + n2.lay.fs * 1.2 + 5, 90));
const blackId = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tool('red');
const nStrokes = await S('S.page.strokes.length');
await T.pen(star(n3.lines[0] ? n3.lay.x + (n3.lines[0].r - n3.lines[0].l) / n3.s + 34 : n3.lay.x + 160, n3.lay.y + 14));
T.ok('第三条旁画星号：是采纳（深蓝带 ★），这一笔不留作笔迹', (await noteOf(NOTE3)).adopted && (await S('S.page.strokes.length')) === nStrokes, [(await noteOf(NOTE3)).adopted, await S('S.page.strokes.length'), nStrokes]);
await sleep(2000); // 和上面那两笔隔开（另成一组）
await T.pen(T.line(120, 900, 250)); // 离批注远的地方：普通的红笔问题
const farId = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tool('pen');
await T.saved();
// 纸上这时的样子：第一行字的框、两笔红字的框（屏幕上）
n1 = await noteOf(NOTE1);
const sP = n1.s, line0P = n1.lines[0];
const relPA = relTo(await strokeScreen(mkA), line0P, sP), relPB = relTo(await strokeScreen(mkB), line0P, sP);
{ const [x0, y0] = await T.screenOf(L.x - 40, L.y - 30), [x1, y1] = await T.screenOf(L.x + L.w + 10, yb + 50); SHOTS.push(await clipShot('1-paper-before.png', x0, y0, x1 - x0, y1 - y0)); }

// ================= 点「AI」
await resetLog();
await T.tap('#check');
const sub2 = await T.waitSub('S1', 80), meta2 = sub2 && T.metaOf(sub2);
T.ok('（前提）交上去了', Boolean(meta2));
let w1 = await item(n1.id);
T.ok('第一条变成了一条长回答（write）：圈号 1、看过（空心）、原话是批注原文，两笔红字成了卡片上的红字（归最上面那块）', Boolean(w1) && w1.type === 'write' && w1.n === 1 && w1.seen === true
  && w1.text === NOTE1 && (w1.marks || []).map((m) => m.id).join() === [mkA.id, mkB.id].join() && w1.marks.every((m) => m.blk === 'a' && m.c === 'r'), w1);
T.ok('原来那条批注原样留在 from 里（类型、原文、排版都一样）', Boolean(w1 && w1.from) && w1.from.type === 'note' && w1.from.text === NOTE1 && JSON.stringify(w1.from.lay) === JSON.stringify(n1.lay)
  && w1.from.id === n1.id && Boolean(w1.fromMap) && w1.fromMap.u > 0 && w1.fromAt > 0, w1 && [w1.from, w1.fromMap]);
const strokesNow = await S(`S.page.strokes.map((s) => s.id)`);
T.ok('纸上那两笔红字没了，黑笔、远处的红笔还在', !strokesNow.includes(mkA.id) && !strokesNow.includes(mkB.id) && strokesNow.includes(blackId) && strokesNow.includes(farId), strokesNow);
const nn1 = await noteOf(NOTE1), nn2 = await noteOf(NOTE2), nn3 = await noteOf(NOTE3);
T.ok('纸上那条批注的字没了（只剩圈号）', !nn1 && !(await js(`[...document.querySelectorAll('#aiRoot text')].some((t) => ${JSON.stringify(n1.lay.lines)}.includes(t.textContent))`)), nn1);
T.ok('黑笔紧挨着第二条写：不变（照旧是纸上的批注，没收成卡片，也没收成小蓝点）', Boolean(nn2) && nn2.type === 'question' && nn2.lines.length === 1
  && !(await item(n2.id)).dot, nn2);
T.ok('星号采纳的第三条：不变（照旧是纸上的批注，带着采纳）', Boolean(nn3) && nn3.type === 'note' && nn3.adopted && nn3.lines.length === 1, nn3);
T.ok('圈号放在所指的那句红笔问题（g1，y 200、右端 420）右边', Boolean(w1) && w1.at[0] > 420 + 16 && w1.at[0] < 420 + 70 && Math.abs(w1.at[1] - 200) < 8, w1 && w1.at);
const c2 = meta2 && (meta2.cards || [])[0];
T.ok('投递里有这张卡片：圈号 1、标着原来是短批注、交的是那两笔红字', Boolean(c2) && meta2.cards.length === 1 && c2.n === 1 && c2.id === n1.id && c2.note === true
  && JSON.stringify(c2.marks) === JSON.stringify([mkA.id, mkB.id]) && existsSync(c2.img), meta2 && meta2.cards);
T.ok('那两笔红字不再当纸上的红笔问题交；远处那句照旧是红笔问题', Boolean(meta2) && !meta2.groups.some((g) => g.ids.includes(mkA.id) || g.ids.includes(mkB.id))
  && meta2.groups.some((g) => g.red && g.ids.includes(farId) && !g.answered), meta2 && meta2.groups.map((g) => [g.id, g.red, g.ids.length]));
T.ok('消息写明：图的列表里这张卡片「蓝字是你原来写在纸上的短批注」，另一句「圈号 1 的卡片原来是你写在纸上的一条短批注……card 填 1」', Boolean(c2)
  && sub2.text.includes(`- 圈号 1 的卡片：${c2.img}（蓝字是你原来写在纸上的短批注，红字是我在它上面写的）`)
  && sub2.text.includes(`圈号 1 的卡片原来是你写在纸上的一条短批注：我在它上面用红笔写了字，它就收成了圈号 1，见图 ${c2.img}：蓝字是你那条短批注（照纸上的换行），红字是我写的。`)
  && sub2.text.includes('card 填 1'), sub2 && sub2.text.slice(-900));
if (c2) { copyFileSync(c2.img, join(T.OUT, '5-card-image-for-claude.png')); SHOTS.push(join(T.OUT, '5-card-image-for-claude.png')); }
// 给 Claude 的卡片图：按排版快照画原来那几行、叠上红字；第一笔在第一行字的下面
await T.saved();
await sleep(300);
const disk2 = T.pageFile('scratch', 0).ai.find((a) => a.id === n1.id);
const blk = disk2 && disk2.sheet && disk2.sheet.blocks.find((b) => b.id === 'a'), rowsD = blk ? blk.rows : [];
T.ok('页面文件里：新条目有 from、fromMap、marks，排版快照最上面那块的各行就是纸上的那两行', Boolean(disk2 && disk2.from && disk2.fromMap && blk) && disk2.marks.length === 2
  && rowsD.map((r) => r.t).join('|') === n1.lay.lines.join('|') && disk2.sheet.w === 440, disk2 && disk2.sheet);
if (c2 && blk) {
  const r0 = rowsD[0], mA = disk2.marks[0], meanA = mA.pts.reduce((s, p) => s + p[1], 0) / mA.pts.length;
  T.ok('快照对得上：第一笔在第一行字的下沿附近（行底以下不到 8 个单位）', meanA > r0.y + r0.h - 3 && meanA < r0.y + r0.h + 8, [meanA, r0]);
  const px2 = await pixels(c2.img, [Math.round((blk.y + r0.y) * 2), Math.round((blk.y + r0.y + r0.h) * 2)]);
  const wantY = (blk.y + Math.min(...disk2.marks.flatMap((m) => m.pts.map((p) => p[1])))) * 2;
  T.ok('给 Claude 的卡片图：宽 880，第一行有蓝字，有红字，红字的上沿在第一笔的位置（差不到 6 像素）', Boolean(px2) && px2.w === 880 && px2.inBand > 150 && px2.red > 80
    && Math.abs(px2.box[1] - wantY) < 6, [px2, wantY]);
  T.ok('框外那一笔也画在图里（红字的下沿到了第二笔那里）', Boolean(px2) && px2.box[3] >= (blk.y + Math.max(...disk2.marks[1].pts.map((p) => p[1]))) * 2 - 6, [px2 && px2.box, disk2.marks[1].pts.slice(-1)]);
}
// 发给 Claude 的整页图：原来写着那条批注的地方已经没有蓝字，圈号那儿有
{
  const c = meta2.crop, jpg = join(T.DATA, 'submissions', sub2.id, 'crop.jpg'), toPx = (b) => [(b[0] - c.x0) * c.scale, (b[1] - c.y0) * c.scale, (b[2] - c.x0) * c.scale, (b[3] - c.y0) * c.scale].map(Math.round);
  const where = await pixels(jpg, null, toPx([L.x + 30, L.y + 2, L.x + 300, L.y + 50]), 'jpeg');
  const at = await pixels(jpg, null, toPx([w1.at[0] - 12, w1.at[1] - 12, w1.at[0] + 12, w1.at[1] + 12]), 'jpeg');
  T.ok('发给 Claude 的整页图里：那条批注已经是圈号（原来的字那儿没有蓝字，圈号那儿有）', Boolean(where && at) && where.inBox < 15 && at.inBox > 15, [where && where.inBox, at && at.inBox]);
}
T.ok('交出去了：圈号 1 是空心的、没有红点（红字记下了是这一轮交的）', await T.waitFor(`(() => { const g = document.querySelector('#aiRoot .badge[data-id="${n1.id}"]'); return g && g.classList.contains('seen') && !g.querySelector('.bdot'); })()`, 5000)
  && (await item(n1.id)).marks.every((m) => m.req === sub2.id), (await item(n1.id)).marks.map((m) => m.req));
await T.waitFor(`document.querySelector('#toast').hidden`, 5000); // 「已交给……」收起了再截
{ const B = await badge(n1.id), [, y0] = await T.screenOf(L.x - 40, L.y - 30), [bx] = await T.screenOf(380, 0); SHOTS.push(await clipShot('2-paper-after.png', bx, Math.min(y0, B.cy - 40), 834 - bx, 200)); }

// ================= 2. 点开卡片：第一块是原来那两行（同样换行），两笔红字都在、相对它压着的字和纸上一样，框外那一笔完整显示
let C = await openBadge(n1.id);
T.ok('手指点圈号：卡片开着，最上面是原来那两行（和纸上同样换行），没有「问：」', Boolean(C) && C.id === n1.id && C.qHidden && C.lines.map((l) => l.s).join('|') === n1.lay.lines.join('|'), C && [C.lines.map((l) => l.s), C.qHidden]);
const kU = C ? C.k * C.u : 1, mcA = C && C.marks.find((m) => m.id === mkA.id), mcB = C && C.marks.find((m) => m.id === mkB.id);
const relCA = mcA && relTo(mcA, C.lines[0], kU), relCB = mcB && relTo(mcB, C.lines[0], kU);
T.ok('卡片上两笔红字都画出来了', Boolean(mcA && mcB) && C.marks.length === 2, C && C.marks);
T.ok('压着字的那一笔：相对第一行字的位置和纸上一样（页面单位，差不到 2）', near(relCA, relPA, 2), [relPA, relCA]);
T.ok('框外的那一笔：相对第一行字的位置也和纸上一样（差不到 2）', near(relCB, relPB, 2), [relPB, relCB]);
const maxDev = (a, b) => (a && b ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))).toFixed(2) : '?');
console.error(`  （量到的偏差，页面单位：压着字的那一笔 ${maxDev(relCA, relPA)}，框外那一笔 ${maxDev(relCB, relPB)}；卡片倍数 k=${C && C.k.toFixed(3)}，u=${C && C.u}）`);
T.ok('框外的那一笔完整显示在卡片里（没被卡片的边裁掉）', Boolean(mcB) && mcB.l >= C.l + 1 && mcB.r <= C.r - 1 && mcB.t >= C.page.t && mcB.b <= C.page.b - 1, [mcB, C && C.page, C && [C.l, C.r]]);
T.ok('第一行字的大小和纸上的比例一致（宽度按 u·k 换算后差不到 2 个单位）', Boolean(C) && Math.abs((C.lines[0].r - C.lines[0].l) / kU - (line0P.r - line0P.l) / sP) < 2,
  [C && (C.lines[0].r - C.lines[0].l) / kU, (line0P.r - line0P.l) / sP]);
SHOTS.push(await T.shot('3-card-open.png'));
await closeCardByTap();

// ================= 3. Claude 用 write + card 回：接在下面
await resetLog();
const rep = await T.post('/bridge/reply', { sid: 'S1', submission: sub2.id, items: [{ type: 'write', card: 1, q: '为什么要上午去', text: '上午刚开门，人最少；下午三点以后公园更凉快。' }] });
T.ok('服务收下了这条回应', rep.ok === true && rep.count === 1, rep);
T.ok('回应接到圈号 1 的卡片下面（more 里一段）', await T.waitFor(`(window.__ink.S.page.ai.find((a) => a.n === 1).more || []).length === 1`, 10000));
await sleep(500);
w1 = await item(n1.id);
T.ok('这一段：前面是它回应的那句红字，那两笔红字记进 on', w1.more[0].q === '为什么要上午去' && JSON.stringify(w1.more[0].on) === JSON.stringify([mkA.id, mkB.id]), w1.more[0]);
const B3 = await badge(n1.id), L3 = await log();
T.ok('圈号 1 变回实心、跳了两下，屏幕上方说「Claude 回了 1 条」', !B3.seen && B3.fill === 'rgb(47, 95, 174)' && L3.fresh.some((f) => f.id === n1.id && f.anim === 'badgeHop' && f.n === '2')
  && L3.toasts.includes('Claude 回了 1 条'), [B3, L3]);
T.ok('不出新的圈号：这一页还是一个圈号', (await badges()).length === 1);
C = await openBadge(n1.id);
const sg = C && C.segs[0];
T.ok('点开：最上面还是原来那两行，下面多了一段，前面写着「红字：为什么要上午去」', Boolean(sg) && C.lines.length === 2 && sg.mq === '红字：为什么要上午去' && sg.text.startsWith('上午刚开门'), C && C.segs);
await js(`document.querySelector('#answerCard').scrollTop = 0`);
await sleep(150);
C = await card();
const relCA3 = relTo(C.marks.find((m) => m.id === mkA.id), C.lines[0], C.k * C.u);
T.ok('上面的红字没错位：相对第一行字和原来一样', near(relCA3, relCA, 0.8), [relCA, relCA3]);
SHOTS.push(await T.shot('4-card-reply.png'));
await closeCardByTap();

// ================= 刷新后：卡片、红字、圈号都在，位置对
T.ok('存上了', await T.saved());
await T.reload();
await installLog();
w1 = await item(n1.id);
T.ok('刷新后：还是那条长回答（带 from），两笔红字、接着的一段都在', Boolean(w1) && w1.type === 'write' && Boolean(w1.from) && w1.marks.length === 2 && w1.more.length === 1, w1);
T.ok('刷新后：圈号还在原处，纸上没有那条批注', Boolean(await badge(n1.id)) && !(await noteOf(NOTE1)));
C = await openBadge(n1.id);
await js(`document.querySelector('#answerCard').scrollTop = 0`);
await sleep(150);
C = await card();
const relCA4 = C && relTo(C.marks.find((m) => m.id === mkA.id), C.lines[0], C.k * C.u), relCB4 = C && relTo(C.marks.find((m) => m.id === mkB.id), C.lines[0], C.k * C.u);
T.ok('刷新后打开卡片：两笔红字相对第一行字和纸上一样', near(relCA4, relPA, 2) && near(relCB4, relPB, 2), [relPA, relCA4, relPB, relCB4]);

// ================= 4. 再在卡片上（接着的那一段上）写红字、再交：又交这张卡片，只交新的那一笔
await T.tool('red');
await js(`(() => { const c = document.querySelector('#answerCard'), s = document.querySelector('#acMore .ac-seg'); c.scrollTop += s.getBoundingClientRect().top - c.getBoundingClientRect().top - 10; return 1; })()`);
await sleep(150);
const sgLine = await js(`(() => { const r = document.querySelector('#acMore .ac-seg .ac-mbody .ac-line').getBoundingClientRect(); return { l: r.left, b: r.bottom }; })()`);
await (async () => { const base = { pointerType: 'pen', button: 'left' }, pts = hline(sgLine.l + 10, sgLine.b + 3, 90);
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: pts[0][0], y: pts[0][1], buttons: 1, clickCount: 1 }, base));
  for (const p of pts.slice(1)) await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: p[0], y: p[1], buttons: 1 }, base));
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: pts[13][0], y: pts[13][1], buttons: 0, clickCount: 1 }, base));
  await sleep(300); })();
w1 = await item(n1.id);
const mkC = w1.marks[2];
T.ok('（前提）卡片上多了一笔，归在接着的那一段', w1.marks.length === 3 && Boolean(mkC) && mkC.blk === w1.more[0].id, w1.marks.map((m) => m.blk));
await closeCardByTap();
await T.tool('pen');
await T.saved();
await T.tap('#check');
const sub3 = await T.waitSub('S1', 80), meta3 = sub3 && T.metaOf(sub3), c3 = meta3 && (meta3.cards || [])[0];
T.ok('再交：带着这张卡片（还标着原来是短批注），只交新写的那一笔', Boolean(c3) && c3.note === true && JSON.stringify(c3.marks) === JSON.stringify([mkC.id]), meta3 && meta3.cards);
T.ok('消息里之前写过的批注：「圈号 1（原来是短批注）：第二天上午……」，后面接着那一段', Boolean(sub3) && sub3.text.includes('- 圈号 1（原来是短批注）：第二天上午先去博物馆')
  && sub3.text.includes('\n  - 接着（回应红字「为什么要上午去」）：上午刚开门'), sub3 && sub3.text.slice(-800));

// ================= 5. 第 2 页：两条挨着的批注、一笔压两条；擦掉、撤销的不算；交稿失败不丢
await T.openPage(1);
await T.tool('red');
await T.pen(T.line(120, 200, 300));
await sleep(2000); // 两句隔开（挨得近，不隔开就成了一组）
await T.pen(T.line(120, 245, 300));
await T.pen(T.line(120, 600, 300));
await T.tool('pen');
await T.saved();
await T.tap('#check');
const sub4 = await T.waitSub('S1', 80), meta4 = sub4 && T.metaOf(sub4);
T.ok('（前提）第 2 页交上去了：三句红笔问题', Boolean(meta4) && meta4.page === 1 && meta4.groups.length === 3, meta4 && meta4.groups);
const NA = '牛奶买两盒', NB = '面包要全麦的', NC = '鸡蛋买十个';
await T.post('/bridge/reply', { sid: 'S1', submission: sub4.id, items: [{ type: 'note', anchor: 'g1', text: NA }, { type: 'note', anchor: 'g2', text: NB }, { type: 'note', anchor: 'g3', text: NC }] });
T.ok('（前提）三条短批注落下、写完了', await landed(3));
const nA = await noteOf(NA), nB = await noteOf(NB), nC = await noteOf(NC);
T.ok('（前提）前两条上下挨着（隔不到 20）', Boolean(nA && nB) && nB.lay.y - (nA.lay.y + nA.lay.h) < 20 && nB.lay.y > nA.lay.y, [nA && nA.lay, nB && nB.lay]);
// 写在第三条上又擦掉一笔、又撤销一笔
// （写在第三条字的上沿外面一点：在放宽的那一圈里、不在批注自己占的框里，橡皮落在这一笔上时擦的是笔迹，不是批注）
await T.tool('red');
const er = hline(nC.lay.x + 10, nC.lay.y - 5, 80);
await T.pen(er);
const erId = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tool('eraser');
await T.pen(er.map((p) => [p[0], p[1]]));
T.ok('（前提）橡皮擦掉了写在批注上的那一笔（批注本身没被擦）', await S(`Boolean(S.page.strokes.find((s) => s.id === ${JSON.stringify(erId)}).erasedAt)`) && Boolean(await noteOf(NC)) && !(await item(nC.id)).erasedAt,
  [await S(`S.page.strokes.find((s) => s.id === ${JSON.stringify(erId)})`), await item(nC.id)]);
await T.tool('red');
await T.pen(hline(nC.lay.x + 10, nC.lay.y + 18, 60));
const unId = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tap('#toolsUndo');
T.ok('（前提）又写了一笔、点撤销撤掉了', unId !== erId && !(await S(`S.page.strokes.some((s) => s.id === ${JSON.stringify(unId)})`)));
await T.tool('pen');
await T.saved();
await T.tap('#check');
const sub5 = await T.waitSub('S1', 80), meta5 = sub5 && T.metaOf(sub5);
T.ok('擦掉、撤销掉的红字不算：点「AI」后第三条照旧是纸上的批注，投递里没有卡片', Boolean(meta5) && !meta5.cards && (await item(nC.id)).type === 'note' && (await noteOf(NC)).lines.length === 1,
  [Boolean(meta5), meta5 && meta5.cards, (await item(nC.id)).type, await toastText()]);
// 一笔两条都压到：从第一条的字底下起笔，往下到第二条，再沿第二条的字横着写一长段
await T.tool('red');
const yA = nA.lay.y + nA.lay.fs * 1.2 + 4, yB = nB.lay.y + 14;
const both = seg([[nA.lay.x + 30, yA], [nA.lay.x + 30, yB], [nA.lay.x + 180, yB]], 10);
await T.pen(both);
const bothId = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
// 第三条上两组：先一组压在字下面（近的），隔 2 秒（另成一组）再一组从字上往下拉出 300 个单位（远的：带上它卡片比批注的字高出 240 以上）。
// 近的那组收进卡片；远的那组整组留在纸上，照旧是普通的红笔
await sleep(2000);
await T.pen(hline(nC.lay.x + 6, nC.lay.y + nC.lay.fs + 5, 70));
const nearC = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await sleep(2000);
await T.pen(seg([[nC.lay.x + 40, nC.lay.y + 10], [nC.lay.x + 40, nC.lay.y + 310]], 30));
const tallC = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tool('pen');
await T.saved();
// 交稿失败：拦下 /api/send，让它连不上
failIf = (r) => r.url.includes('/api/send');
await T.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/send*', requestStage: 'Request' }] });
await resetLog();
await T.tap('#check');
T.ok('交稿失败：提示没发出去', await T.waitFor(`(window.__toasts || []).some((t) => t.startsWith('没发出去'))`, 8000), (await log()).toasts);
let wB = await item(nB.id), wC = await item(nC.id);
T.ok('一笔压两条：归压得多的那条（第二条变成卡片，第一条照旧）', Boolean(wB) && wB.type === 'write' && wB.n === 1 && (wB.marks || []).map((m) => m.id).join() === bothId
  && (await item(nA.id)).type === 'note' && (await noteOf(NA)).lines.length === 1, [wB && wB.type, (await item(nA.id)).type]);
T.ok('一条批注上两组、一组太远（太高）：近的那组收进了卡片（圈号 2），远的那组整组留在纸上', Boolean(wC) && wC.type === 'write' && wC.n === 2
  && (wC.marks || []).map((m) => m.id).join() === nearC && (await S(`S.page.strokes.some((s) => s.id === ${JSON.stringify(tallC)} && !s.erasedAt)`))
  && !(await S(`S.page.strokes.some((s) => s.id === ${JSON.stringify(nearC)})`)), [wC && wC.type, wC && (wC.marks || []).map((m) => m.id), nearC, tallC]);
T.ok('收进卡片的只有近的那组：卡片没被撑高（这一块的高不到批注的字高加 240）', Boolean(wC && wC.fromMap) && wC.fromMap.h < 100 && wC.fromMap.u === 1, wC && wC.fromMap);
T.ok('交稿失败也不丢：卡片已经变好，红字算没交（没有 req），圈号带红点', wB.marks.every((m) => !m.req) && (await badge(nB.id)).dot && (await badge(nC.id)).dot, [wB.marks, await badge(nB.id)]);
T.ok('没有新的投递', !(await T.poll('S1')));
await T.saved();
await T.reload();
await installLog();
wB = await item(nB.id);
T.ok('刷新后一样：第二条是卡片、红字还没交、圈号带红点，纸上没有那一笔', Boolean(wB) && wB.type === 'write' && wB.marks.length === 1 && !wB.marks[0].req && (await badge(nB.id)).dot
  && !(await S(`S.page.strokes.some((s) => s.id === ${JSON.stringify(bothId)})`)), wB);
await T.cdp('Fetch.disable');
failIf = null;
await T.tap('#check');
const sub6 = await T.waitSub('S1', 80), meta6 = sub6 && T.metaOf(sub6), c6 = meta6 && (meta6.cards || [])[0], c6C = meta6 && (meta6.cards || [])[1];
T.ok('网通了再点「AI」：这张卡片连同那一笔红字交上去了', Boolean(c6) && c6.id === nB.id && c6.note === true && JSON.stringify(c6.marks) === JSON.stringify([bothId]), meta6 && meta6.cards);
T.ok('第三条那张卡片也交上去了，只带近的那一组', Boolean(c6C) && c6C.id === nC.id && c6C.note === true && JSON.stringify(c6C.marks) === JSON.stringify([nearC]), meta6 && meta6.cards);
T.ok('远的那一组作为一组普通的红笔交上去了', Boolean(meta6) && meta6.groups.some((g) => g.red && !g.answered && g.ids.includes(tallC) && !g.ids.includes(nearC)), meta6 && meta6.groups.map((g) => [g.id, g.red, g.ids]));
T.ok('交上去后红点没了', await T.waitFor(`(() => { const g = document.querySelector('#aiRoot .badge[data-id="${nB.id}"]'); return g && !g.querySelector('.bdot'); })()`, 5000));

// ================= 6. 第 1 页的第三条（采纳过的）上写红字，翻到第 2 页写字、点「AI」：几页一起交，第 1 页那条也变成卡片
await T.openPage(0);
const n3b = await noteOf(NOTE3);
await T.tool('red');
await T.pen(hline(n3b.lay.x + 4, n3b.lay.y + n3b.lay.fs + 5, 70));
const mk3 = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tool('pen');
await T.saved();
await T.openPage(1);
await T.pen(T.line(120, 1000, 200));
await T.saved();
await T.tap('#check');
const sub7 = await T.waitSub('S1', 80), meta7 = sub7 && T.metaOf(sub7);
T.ok('几页一起交（整本那种）：两页都在', Boolean(meta7) && meta7.kind === 'scan' && Boolean(meta7.pages['1']) && Boolean(meta7.pages['2']), meta7 && Object.keys(meta7.pages || {}));
const img7 = sub7 && (sub7.text.match(/圈号 2 的卡片原来是你写在纸上的一条短批注：我在它上面用红笔写了字，它就收成了圈号 2，见图 (\S+?)：/) || [])[1];
T.ok('整本消息里第 1 页那条批注已经是圈号 2 的卡片（写明原来是短批注、带上 page=1）', Boolean(img7) && existsSync(img7) && sub7.text.includes('card 填 2（再带上 page=1）'), sub7 && sub7.text.slice(0, 1500));
const disk7 = T.pageFile('scratch', 0), w3 = disk7 && disk7.ai.find((a) => a.id === n3.id);
T.ok('第 1 页的页面文件：那条批注变成了圈号 2 的长回答（带着采纳和 from），那一笔红字挪进了卡片', Boolean(w3) && w3.type === 'write' && w3.n === 2 && w3.adopted === true && w3.from.type === 'note'
  && w3.marks.map((m) => m.id).join() === mk3 && !disk7.strokes.some((s) => s.id === mk3), w3);
T.ok('第 1 页的那一笔不再当纸上的红笔问题交', !Object.values(meta7.pages).some((p) => Object.values(p.gx || {}).some((g) => (g.ids || []).includes(mk3))), meta7 && meta7.pages['1']);
await T.openPage(0);
T.ok('翻回第 1 页：圈号 2 在（采纳的样子），红点没了（记下交过了）', await T.waitFor(`(() => { const a = window.__ink.S.page.ai.find((o) => o.n === 2); const g = a && document.querySelector('#aiRoot .badge[data-id="' + a.id + '"]');
  return g && g.classList.contains('adopted') && !g.querySelector('.bdot') && a.marks.every((m) => m.req === ${JSON.stringify(sub7 && sub7.id)}); })()`, 8000), await item(n3.id));

// ================= 7. 几页一起交后，交上去的页也记下「交到了哪一笔为止」（2026-11-14 第二轮）：
//    第 1 页第二条批注上写一笔红字，翻到第 2 页写字、点「AI」；交的时候取第 1 页没取到（拦下那一个请求），那一笔没收成卡片，当普通的红笔交了。
//    Claude 没回。翻回第 1 页再单页点「AI」：那一笔是上次交稿之前写的，不再被收成卡片、不再当卡片交一次
const n2b = await noteOf(NOTE2);
await T.tool('red');
await T.pen(hline(n2b.lay.x + 4, n2b.lay.y + n2b.lay.fs + 5, 70));
const mk2 = await S(`(() => { const s = S.page.strokes[S.page.strokes.length - 1]; return { id: s.id, t1: s.t0 + s.pts[s.pts.length - 1][3] }; })()`);
await T.tool('pen');
await T.saved();
await T.openPage(1);
await T.pen(T.line(120, 1100, 200));
await T.saved();
failIf = (r) => r.method === 'GET' && /\/api\/page\?nb=scratch&i=0$/.test(r.url);
await T.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/page*', requestStage: 'Request' }] });
await T.tap('#check');
const sub8 = await T.waitSub('S1', 80), meta8 = sub8 && T.metaOf(sub8);
await T.cdp('Fetch.disable');
failIf = null;
T.ok('（前提）几页一起交，取不到第 1 页：那一笔没收成卡片，在整本消息里是第 1 页的一组普通红笔', Boolean(meta8) && meta8.kind === 'scan' && Boolean(meta8.pages['1'])
  && Object.values(meta8.pages['1'].gx || {}).some((g) => g.red && g.ids.includes(mk2.id)) && !sub8.text.includes('圈号 3 的卡片'), meta8 && meta8.pages['1']);
await T.openPage(0);
T.ok('翻回第 1 页：这一页记下了交到哪一笔为止（lastSent 不早于那一笔写完），第二条批注照旧在纸上', await T.waitFor(`window.__ink.S.page.lastSent >= ${mk2.t1}`, 8000)
  && (await item(n2.id)).type === 'question', [await S('S.page.lastSent'), mk2.t1]);
await T.saved();
await T.tap('#check');
const sub9 = await T.waitSub('S1', 80), meta9 = sub9 && T.metaOf(sub9);
T.ok('再单页点「AI」：那一笔不再被收成卡片（批注还在纸上、那一笔还在纸上、投递里没有它的卡片）', Boolean(meta9) && meta9.page === 0 && (await item(n2.id)).type === 'question'
  && (await S(`S.page.strokes.some((s) => s.id === ${JSON.stringify(mk2.id)})`)) && !(meta9.cards || []).some((c) => c.id === n2.id) && !sub9.text.includes('圈号 3 的卡片'),
  [meta9 && meta9.cards, (await item(n2.id)).type]);

console.error('截图：\n' + SHOTS.join('\n'));
T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

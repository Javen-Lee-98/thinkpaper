// 长回答摊在纸上：2026-11-18 外部审查（Codex）指出的几处，逐条复现（细节是用户不在时暂定的）。查：
// A. AI 给的 place 像素框：远超纸面的（[0,0,1e9,1e9]）不卡住页面，照样落下、在纸里；比字块还小的框不硬放进去（伸出框外），照常另找；
// B. 摊开的字上：红笔写的很小的一笔（小数点）照常留在纸上，不开卡片；黑笔点一下照旧开卡片；圈号上红笔点一下照旧开卡片（圈号上没有字可批）；
// E①. 黑笔压住摊开的回答让它收起，较长的重写到了（收着）：撤销那一笔，不把旧的那几行摊回去（纸上和卡片上不是同一个版本）；
// E②. 用户点「收起」过的：较短的重写到了也不自动摊开；AI 回的时候带 fold: true 的，也不摊开；
// E③. 套索挪所答的笔迹，摊开的那一段跟着落到没选中的字上：收成圈号，撤销摊回原处，恢复又收起。
// 只在无头 Edge 里用合成的输入试过，没在 iPad 上试过。
// 跑法：node tests/run_browser.mjs <临时目录> --only open_review；有一项不对退出码 1。
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'open-review', pages: 2 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const waitPen = () => sleep(1150);
async function landed(n, ms = 10000) {
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, ms);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
const item = (id) => S(`(() => { const a = S.page.ai.find((o) => o.id === ${JSON.stringify(id)}); return a ? JSON.parse(JSON.stringify(a)) : null; })()`);
const byText = (t) => S(`(() => { const a = S.page.ai.find((o) => o.type === 'write' && o.text === ${JSON.stringify(t)}); return a ? JSON.parse(JSON.stringify(a)) : null; })()`);
const cardId = () => js(`(() => { const c = document.querySelector('#answerCard'); return c.hidden ? null : (window.__ink.S.card || {}).id || null; })()`);
const badgeOf = (id) => js(`(() => { const g = [...document.querySelectorAll('#aiRoot .badge')].find((x) => !x.classList.contains('nbr-badge') && x.dataset.id === ${JSON.stringify(id)}); if (!g) return null;
  const r = g.querySelector('circle').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
const strokes = () => S('S.page.strokes.filter((s) => !s.erasedAt).length');
const rowsText = (a) => (a && a.spread ? a.spread.rows.map((r) => r.t || r.tex).join('|') : null);
const watchToasts = () => js(`(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (!t.hidden) window.__toasts.push(t.textContent); })
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true, attributes: true }); return 1; })()`);
// 屏幕上的一点用笔点一下（一小笔：页面坐标）
const penDot = (x, y) => T.pen([[x, y], [x + 2, y + 1], [x + 3, y + 1]]);
// 「再短点」的那一次投递直接经 /api/redo 起（点钮的那条路在 answer_redo.mjs 里查），AI 回一条重写
async function redo(id, text, extra = {}) {
  await T.saved();
  const r = await T.apiJson('/api/redo', { method: 'POST', body: JSON.stringify({ nb: 'scratch', page: await S('S.idx'), id, want: 'brief' }) });
  const sub = await T.waitSub('S1', 40);
  const a = (await item(id)) || {}, k = (a.more || []).length;
  const rep = await T.post('/bridge/reply', { sid: 'S1', submission: sub.id, items: [Object.assign({ type: 'write', card: a.n, text }, extra)] });
  const ok = await T.waitFor(`(window.__ink.S.page.ai.find((o) => o.id === ${JSON.stringify(id)}).more || []).length > ${k}`, 10000);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  T.ok(`（前提）重写「${text.slice(0, 8)}」接到卡片下面了`, Boolean(r && r.id) && rep.ok === true && ok && (await T.waitFor('window.__written', 20000)), [r, rep]);
  return { r, sub, rep };
}

if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }
await watchToasts();

// ================= 0. 第 1 页：红笔问题 g1，黑字 g2、g3、g4、g5；交上去
await T.tool('red');
await T.pen(T.line(120, 200, 260));
await T.tool('pen');
for (const y of [450, 700, 950, 1200]) await T.pen(T.line(120, y, 260));
await T.tap('#check');
const sub0 = await T.waitSub('S1'), meta0 = sub0 && T.metaOf(sub0);
T.ok('（前提）交上去了：五组', Boolean(meta0) && meta0.groups.length === 5, meta0 && meta0.groups.length);
const c0 = meta0.crop, px = (b) => [(b[0] - c0.x0) * c0.scale, (b[1] - c0.y0) * c0.scale, (b[2] - c0.x0) * c0.scale, (b[3] - c0.y0) * c0.scale];
const W1 = '九点出门：路上一个小时。', W2 = '先算单价再乘斤数。', W3 = '记得带伞。', W5 = '收着的回答。';
const HUGE = '框大到离谱也照样落下。', FAR = '框在纸外很远也照样落下。', SMALL = '放不进这个小框的一段话。';
const t0 = Date.now();
const rep0 = await T.post('/bridge/reply', { sid: 'S1', submission: sub0.id, items: [
  { type: 'write', anchor: 'g1', text: W1 }, { type: 'write', anchor: 'g2', text: W2 }, { type: 'write', anchor: 'g3', text: W3 },
  { type: 'write', anchor: 'g5', text: W5, fold: true },
  { type: 'write', anchor: 'g4', text: HUGE, place: [0, 0, 1e9, 1e9] },
  { type: 'write', anchor: 'g4', text: FAR, place: [5e8, 5e8, 1e9, 1e9] },
  { type: 'write', anchor: 'g4', text: SMALL, place: px([600, 1100, 700, 1120]) }] });
T.ok('（前提）服务收下了 7 条', rep0.ok === true && rep0.count === 7, rep0);

// ================= A. 像素框
const ok0 = await landed(7, 15000).catch(() => false);
const dt = Date.now() - t0;
T.ok('A. 远超纸面的像素框不卡住页面：7 条在 15 秒内落下、写完', ok0, dt);
const resp = await js(`new Promise((r) => { const t = performance.now(); setTimeout(() => r(performance.now() - t), 0); })`).catch(() => 99999);
T.ok('A. 落下以后页面照常响应', resp < 500, resp);
const huge = await byText(HUGE), far = await byText(FAR), small = await byText(SMALL), paper = await S('({ X0: S.X0, Y0: S.Y0, TW: S.TW, H: S.pageH })');
const inPaper = (a) => Boolean(a) && (!a.spread || (a.spread.x >= paper.X0 && a.spread.y >= paper.Y0 && a.spread.x + a.spread.w <= paper.TW && a.spread.y + a.spread.h <= paper.H));
T.ok('A. 盖住整张纸还大得多的框、整个在纸外很远的框：都落下了，摊开的话整个在纸里', inPaper(huge) && inPaper(far), [huge && huge.spread, far && far.spread, paper]);
T.ok('A. 整个在纸外的框：框里没地方，照常在所答笔迹旁边另找（不算放进了框）', Boolean(far) && (!far.spread || far.spread.side !== 'box'), far && far.spread);
const sb = small && small.spread;
T.ok('A. 比字块还小的框：不当成放进框里了（不伸出框外，照常在所答笔迹旁边另找）', Boolean(small) && (!sb || sb.side !== 'box'), sb);

// ================= B. 摊开的字上用笔点一下
const w3 = await byText(W3);
T.ok('（前提）圈号 3 摊在纸上', Boolean(w3 && w3.spread), w3);
const s3 = w3.spread, dotX = s3.x + 30, dotY = s3.y + s3.rows[0].y + 14;
await T.tool('red');
const n1 = await strokes();
await penDot(dotX, dotY);
T.ok('B. 红笔在摊开的字上点一小笔（小数点）：照常留在纸上', (await strokes()) === n1 + 1, [n1, await strokes()]);
T.ok('B. 红笔点的这一下不开卡片，也不收起这一段', (await cardId()) === null && Boolean((await item(w3.id)).spread), await cardId());
await T.tool('pen');
await waitPen();
await penDot(dotX + 40, dotY);
T.ok('B. 黑笔在摊开的字上点一下：照旧开卡片，不留笔迹', (await cardId()) === w3.id && (await strokes()) === n1 + 1, [await cardId(), await strokes()]);
await js(`window.__ink.closeCard()`);
const w5 = await byText(W5), b5 = await badgeOf(w5.id);
T.ok('（前提）圈号 4（收着）画着圈号', Boolean(b5));
const [bx, by] = await js(`(() => { const S = window.__ink.S, r = document.querySelector('#stage').getBoundingClientRect(); return [(${b5.cx} - r.left - S.view.tx) / S.view.s, (${b5.cy} - r.top - S.view.ty) / S.view.s]; })()`);
await T.tool('red');
await penDot(bx - 1, by);
T.ok('B. 红笔在圈号上点一下：照旧开卡片，不留笔迹（圈号上没有字可批）', (await cardId()) === w5.id && (await strokes()) === n1 + 1, [await cardId(), await strokes()]);
await js(`window.__ink.closeCard()`);
await T.tool('pen');

// ================= E①. 黑笔压住摊开的回答收起，较长的重写到了（收着），撤销那一笔：不把旧的摊回去
const w1 = await byText(W1);
T.ok('（前提）圈号 1 摊在纸上', Boolean(w1 && w1.spread));
const s1 = w1.spread;
await waitPen();
await T.pen(Array.from({ length: 14 }, (_, i) => [s1.x + 6 + i * 10, s1.y + s1.rows[0].y + 14 + (i % 2) * 0.6]));
T.ok('（前提）黑笔压上去：圈号 1 收起', !(await item(w1.id)).spread);
const LONGR = Array.from({ length: 14 }, (_, k) => `重写的第 ${k + 1} 行。`).join('\n');
await redo(w1.id, LONGR);
let a1 = await item(w1.id);
T.ok('（前提）较长的重写到了，接在卡片下面，收着', (a1.more || []).some((m) => m.text === LONGR) && !a1.spread, a1.spread);
await T.tap('#toolsUndo');
a1 = await item(w1.id);
T.ok('E①. 撤销压字的那一笔：不把旧的那几行摊回去（纸上要么收着，要么是最新的那一段）', !a1.spread || rowsText(a1) === LONGR.split('\n').join('|'), [rowsText(a1)]);
const drawn1 = await js(`[...document.querySelectorAll('#aiRoot g.ai-open[data-id="${w1.id}"] > text')].map((t) => t.textContent).join('|')`);
T.ok('E①. 纸上画的也不是旧的那一行', !drawn1.includes(W1), drawn1);

// ================= E②. 用户点「收起」过的：较短的重写到了也不自动摊开；AI 带 fold: true 的也不摊开
const w2 = await byText(W2);
T.ok('（前提）圈号 2 摊在纸上', Boolean(w2 && w2.spread));
await S(`(window.__ink.openCard(S.page.ai.find((o) => o.id === ${JSON.stringify(w2.id)})), 1)`);
await sleep(300);
await T.tap('#acSpread');
T.ok('（前提）点「收起」：圈号 2 收起', !(await item(w2.id)).spread);
await js(`window.__ink.closeCard()`);
await redo(w2.id, '短的重写。');
T.ok('E②. 用户收起过的：较短的重写到了，照旧收着', !(await item(w2.id)).spread, (await item(w2.id)).spread);
const w3b = await item(w3.id);
T.ok('（前提）圈号 3 还摊着', Boolean(w3b.spread));
await redo(w3.id, '带伞。', { fold: true });
T.ok('E②. AI 回重写时带 fold: true：收着，不摊开', !(await item(w3.id)).spread, (await item(w3.id)).spread);

// ================= E③. 套索挪所答的笔迹，摊开的那一段跟着落到没选中的字上：收成圈号；撤销摊回原处，恢复又收起
await T.openPage(1);
if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }
await T.pen(T.line(120, 300, 260));
await T.pen(T.line(120, 700, 260));
await T.tap('#check');
const sub3 = await T.waitSub('S1');
// 第 1 页上也有没交过的字（B 留下的红点）：两页一起交了，回在第 2 页要说是这次投递里的第几页
const pg3 = Object.entries((sub3 && T.metaOf(sub3).pages) || {}).find(([, p]) => p.page === 1);
await T.post('/bridge/reply', { sid: 'S1', submission: sub3.id, page: pg3 ? Number(pg3[0]) : undefined, items: [{ type: 'write', anchor: 'g1', text: '挪过去会压到下面那一行字。' }] });
T.ok('（前提）落到第 2 页', await landed(1), sub3 && T.metaOf(sub3).pages);
const wm = (await S('JSON.parse(JSON.stringify(S.page.ai))'))[0];
T.ok('（前提）摊在 g1 右边', Boolean(wm && wm.spread) && wm.spread.side === 'right', wm && wm.spread);
const sp0 = wm.spread;
const PEN = { pointerType: 'pen', button: 'left' };
const view = await js(`(() => { const S = window.__ink.S, r = document.querySelector('#stage').getBoundingClientRect(); return { l: r.left + S.view.tx, t: r.top + S.view.ty, s: S.view.s }; })()`);
const scr = (p) => [view.l + p[0] * view.s, view.t + p[1] * view.s];
const mouse = (type, p, buttons) => T.cdp('Input.dispatchMouseEvent', Object.assign({ type, x: p[0], y: p[1], buttons }, type === 'mouseMoved' ? {} : { clickCount: 1 }, PEN));
await T.tool('lasso');
const loop = [[100, 270], [392, 270], [392, 330], [100, 330], [100, 272]];
await mouse('mousePressed', scr(loop[0]), 1);
for (let k = 1; k < loop.length; k++) for (let i = 1; i <= 10; i++) await mouse('mouseMoved', scr([loop[k - 1][0] + ((loop[k][0] - loop[k - 1][0]) * i) / 10, loop[k - 1][1] + ((loop[k][1] - loop[k - 1][1]) * i) / 10]), 1);
await mouse('mouseReleased', scr(loop[loop.length - 1]), 0);
await sleep(300);
T.ok('（前提）套索选中了 g1', (await S('S.sel ? S.sel.ids.length : 0')) === 1);
// 往左下拖：g1 落到 g2 上方一点，摊开的那一段（在 g1 右边）正好压在 g2 那一行字上
const DX = -150, DY = 400, from = scr([250, 300]);
await mouse('mousePressed', from, 1);
for (let i = 1; i <= 12; i++) await mouse('mouseMoved', [from[0] + (DX * view.s * i) / 12, from[1] + (DY * view.s * i) / 12], 1);
await mouse('mouseReleased', [from[0] + DX * view.s, from[1] + DY * view.s], 0);
await sleep(400);
await T.tool('pen');
const U = await S('JSON.parse(JSON.stringify(S.undo[S.undo.length - 1] || null))');
T.ok('（前提）挪动定下了', Boolean(U) && U.t === 'move' && Math.abs(U.dy - DY) < 2, U && [U.t, U.dx, U.dy]);
let am = await item(wm.id);
T.ok('E③. 跟着挪过去压到了没选中的字：收成圈号', !am.spread && Boolean(await badgeOf(wm.id)), am.spread);
await T.tap('#toolsUndo');
am = await item(wm.id);
T.ok('E③. 撤销：笔迹回去，那一段摊回原处', JSON.stringify(am.spread) === JSON.stringify(sp0), [am.spread, sp0]);
await T.tap('#toolsRedo');
am = await item(wm.id);
T.ok('E③. 恢复：又挪过去、又收成圈号', !am.spread);

await T.finish();

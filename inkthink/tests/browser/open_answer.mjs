// 长回答摊在纸上（2026-11-17 用户定方向，细节是用户不在时暂定的；《产品定义》第 2 节「蓝字摊在纸上、回答长短怎么控制」）。查：
// 1. 空白本子：不太长、旁边有空的长回答摊在纸上——蓝字（和短批注同一种字、同一个颜色、同一个字号）、细线连到所答的笔迹、
//    不压用户的字、不压别的蓝字、在纸里；单独一行的 $$…$$ 排成公式；摊开的不画圈号、记为看过；
//    太长的（30 行）、AI 说收着的（fold）只标圈号；AI 说放下面（place: below）就在下面；给了一个像素框就放在框里；
//    框里放不下（压着字）照常找别处；
// 2. 交给 AI 的图（单页：平板画的；整本检测：电脑画的）里，摊开的那一段是蓝字本身（那块地方有蓝色的点），消息列表里标「（摊在纸上）」并说一句；
// 3. 套索挪所答的笔迹：摊开的那一段（字、细线）跟着挪同样的量，撤销回原处；
// 4. 黑笔写到摊开的字上：收回圈号（上方说一句），撤销摊回原处，恢复又收起；
// 5. 手指点摊开的字：开卡片，卡片底下「收起」；点了收成圈号，钮变「摊在纸上」，再点摊回原处；撤销、恢复；
//    太长的点「摊在纸上」：说太长，不摊；
// 6. 存盘、刷新后：摊开的样子、作者都在；
// 7. 旁边没空（整页写满）：只标圈号；点「摊在纸上」说旁边没空地方；
// 8. 书页上：短的长回答也只标圈号，卡片上没有「摊在纸上」。
// 只在无头 Edge 里用合成的输入试过（笔是 pointerType 为 pen 的鼠标事件，手指是 CDP 的触摸事件），没在 iPad 上试过。
// 跑法：node tests/run_browser.mjs <临时目录> --only open_answer；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'open-answer', pages: 2 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const waitPen = () => sleep(1150); // 笔刚用过的一秒内手指不算（手掌）
const hline = (x0, y, len, n = 14) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 0.6]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const meet = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const SIDES = ['right', 'below', 'left', 'above'];
async function landed(n) { // 等写回的批注落到这一页（一共 n 条），并且一条条写完
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 60000)) && ok;
}
const all = () => S(`JSON.parse(JSON.stringify(S.page.ai))`);
const item = (id) => S(`(() => { const a = S.page.ai.find((o) => o.id === ${JSON.stringify(id)}); return a ? JSON.parse(JSON.stringify(a)) : null; })()`);
// 批注层上画出来的摊开的一段：几行字、写了什么、字的颜色字体字号、第一行的 x、有没有细线
const drawnOpen = (id) => js(`(() => { const g = document.querySelector('#aiRoot g.ai-open[data-id="' + ${JSON.stringify(id)} + '"]'); if (!g) return null;
  const ts = [...g.querySelectorAll(':scope > text:not(.adopt-star)')], cs = ts[0] ? getComputedStyle(ts[0]) : null;
  return { n: ts.length, text: ts.map((t) => t.textContent).join('|'), fill: cs && cs.fill, font: cs && cs.fontFamily, fs: ts[0] && ts[0].getAttribute('font-size'),
    x: ts[0] ? Number(ts[0].getAttribute('x')) : null, lead: Boolean(g.querySelector('path.leader')), tex: document.querySelectorAll('#tex [data-id="' + ${JSON.stringify(id)} + '"]').length }; })()`);
const noteLook = (text) => js(`(() => { const S = window.__ink.S, a = S.page.ai.find((o) => o.text === ${JSON.stringify(text)}); const g = a && document.querySelector('#aiRoot g[data-id="' + a.id + '"]');
  const t = g && g.querySelector('text'); if (!t) return null; const cs = getComputedStyle(t); return { fill: cs.fill, font: cs.fontFamily, fs: t.getAttribute('font-size') }; })()`);
const badgeOf = (id) => js(`(() => { const g = [...document.querySelectorAll('#aiRoot .badge')].find((x) => !x.classList.contains('nbr-badge') && x.dataset.id === ${JSON.stringify(id)}); if (!g) return null;
  const r = g.querySelector('circle').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, seen: g.classList.contains('seen') }; })()`);
// 屏幕上一个元素画出来的框，换成页面坐标
const PG = `const st = document.querySelector('#stage').getBoundingClientRect(), V = window.__ink.S.view;
  const pg = (e) => { const r = e.getBoundingClientRect(); return [(r.left - st.left - V.tx) / V.s, (r.top - st.top - V.ty) / V.s, (r.right - st.left - V.tx) / V.s, (r.bottom - st.top - V.ty) / V.s]; };`;
// 摊开的每一段：压没压用户的字、别的蓝字、在不在纸里——按实际画出来的量（2026-11-18 外部审查：原来比的是摊开时找地方用的同一份
// 「占着的地方」，自己和自己比，找地方算错了也查不出来）。这一段：批注层上它的每一行字（<text>）、公式那一层排出来的公式；
// 用户的字：每一笔的点（加半个笔宽）；别的蓝字：批注层上别的条目画出来的字、圈号，公式那一层别的公式。连过去的细线不算
const clashes = () => js(`(() => { const S = window.__ink.S; ${PG}
  const meet = (a, b) => a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1, ok = (b) => b[2] > b[0] && b[3] > b[1];
  const ink = S.page.strokes.filter((s) => !s.erasedAt && s.pts.length).map((s) => { const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]), h = (s.w || 2) / 2;
    return [Math.min(...xs) - h, Math.min(...ys) - h, Math.max(...xs) + h, Math.max(...ys) + h]; });
  const mine = (id) => { const g = document.querySelector('#aiRoot g.ai-open[data-id="' + id + '"]');
    return [...(g ? g.querySelectorAll(':scope > text') : []), ...document.querySelectorAll('#tex .tx[data-id="' + id + '"] > .katex')].map(pg).filter(ok); };
  const others = (id) => [...document.querySelectorAll('#aiRoot g[data-id]')].filter((g) => g.dataset.id !== id && !g.classList.contains('nbr-badge'))
    .flatMap((g) => [...g.querySelectorAll('text, circle')]).concat([...document.querySelectorAll('#tex .tx')].filter((d) => d.dataset.id !== id)).map(pg).filter(ok);
  const out = [];
  for (const a of S.page.ai) { if (!a.spread || a.erasedAt) continue;
    const bs = mine(a.id), ob = others(a.id), tag = a.text.slice(0, 8);
    if (bs.length !== a.spread.rows.length) out.push([tag, '纸上画出来的行数不对', bs.length, a.spread.rows.length]);
    for (const b of bs) { const hi = ink.filter((o) => meet(b, o)), ho = ob.filter((o) => meet(b, o));
      if (hi.length) out.push([tag, '压字', b, hi]);
      if (ho.length) out.push([tag, '压蓝字', b, ho]);
      if (b[0] < S.X0 || b[2] > S.TW || b[1] < S.Y0 || b[3] > S.pageH) out.push([tag, '出纸', b]); } }
  return out; })()`);
// 摊开的一段里公式那一行（页面坐标），和公式那一层排出来的公式的框
const texRow = (a) => { const r = a.spread.rows.find((x) => x.tex !== undefined); return r ? [a.spread.x, a.spread.y + r.y, a.spread.x + a.spread.w, a.spread.y + r.y + r.h] : null; };
const textRows = (a) => { const r = a.spread.rows.filter((x) => x.tex === undefined); return r.length ? [a.spread.x, a.spread.y + r[0].y, a.spread.x + a.spread.w, a.spread.y + r[r.length - 1].y + r[r.length - 1].h] : null; };
const texDrawn = (id) => js(`(() => { ${PG} const e = document.querySelector('#tex .tx[data-id="${id}"] > .katex'); return e ? pg(e) : null; })()`);
const inside = (b, o, tol = 2) => Boolean(b && o) && b[0] >= o[0] - tol && b[1] >= o[1] - tol && b[2] <= o[2] + tol && b[3] <= o[3] + tol;
const cardUp = () => js(`(() => { const c = document.querySelector('#answerCard'); if (c.hidden) return null; const S = window.__ink.S, acts = document.querySelector('#acActs');
  const b = (q) => { const e = document.querySelector(q); return { text: e.textContent, hidden: e.hidden || getComputedStyle(e).display === 'none', disabled: e.disabled }; };
  return { id: S.card && S.card.id, acts: !acts.hidden, spread: b('#acSpread'), shorter: b('#acShorter'), longer: b('#acLonger') }; })()`);
const toasts = () => js(`window.__toasts.slice()`);
const clearToasts = () => js(`(window.__toasts = [], 1)`);
const watchToasts = () => js(`(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (!t.hidden) window.__toasts.push(t.textContent); })
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true, attributes: true }); return 1; })()`);
await watchToasts(); // 刷新页面后要重新装上
// 一张图（crop.jpg 或整本检测的 pNNN.png）里，几块页面坐标的框里各有多少蓝色的点
function bluePixels(file, k, boxes, mime) {
  const b64 = readFileSync(file).toString('base64');
  const px = (b) => [b[0] - k.x0, b[1] - k.y0, b[2] - k.x0, b[3] - k.y0].map((v) => v * k.scale);
  return js(`new Promise((res) => { const im = new Image(); im.onload = () => { const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const x = cv.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, im.width, im.height).data, blue = (i) => d[i + 2] - d[i] > 50 && d[i + 2] > 90, boxes = ${JSON.stringify(boxes.map(px))};
    res(boxes.map((b) => { let n = 0; for (let Y = Math.max(0, Math.floor(b[1])); Y < Math.min(im.height, b[3]); Y++) for (let X = Math.max(0, Math.floor(b[0])); X < Math.min(im.width, b[2]); X++) if (blue((Y * im.width + X) * 4)) n++; return n; })); };
    im.onerror = () => res(null); im.src = 'data:${mime};base64,${b64}'; })`);
}
// 套索（和 lasso.mjs 同一个办法：页面坐标换成屏幕坐标，pointerType 为 pen 的鼠标事件一个接一个发）
const PEN = { pointerType: 'pen', button: 'left' };
async function scr(pts) {
  const v = await js(`(() => { const S = window.__ink.S, r = document.querySelector('#stage').getBoundingClientRect(); return { l: r.left + S.view.tx, t: r.top + S.view.ty, s: S.view.s }; })()`);
  return pts.map((p) => [v.l + p[0] * v.s, v.t + p[1] * v.s]);
}
const mouse = (type, p, buttons) => T.cdp('Input.dispatchMouseEvent', Object.assign({ type, x: p[0], y: p[1], buttons }, type === 'mouseMoved' ? {} : { clickCount: 1 }, PEN));
const path = (pts, n = 12) => pts.slice(1).flatMap((b, k) => Array.from({ length: n }, (_, i) => [pts[k][0] + ((b[0] - pts[k][0]) * (i + 1)) / n, pts[k][1] + ((b[1] - pts[k][1]) * (i + 1)) / n]));
async function loop(corners) { const [p0] = await scr([corners[0]]); await mouse('mousePressed', p0, 1); let tip = p0; for (const q of await scr(path(corners))) { await mouse('mouseMoved', q, 1); tip = q; } await mouse('mouseReleased', tip, 0); await sleep(300); }
async function drag(from, sx, sy, steps = 12) {
  const [a] = await scr([from]);
  await mouse('mousePressed', a, 1);
  for (let i = 1; i <= steps; i++) await mouse('mouseMoved', [a[0] + (sx * i) / steps, a[1] + (sy * i) / steps], 1);
  await mouse('mouseReleased', [a[0] + sx, a[1] + sy], 0);
  await sleep(300);
}
const nums = (d) => (String(d).match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);

if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }

// ================= 0. 草稿本第 1 页：红笔问题 g1，黑字 g2…g5，交给 AI
await T.tool('red');
await T.pen(T.line(120, 200, 260));
await T.tool('pen');
for (const y of [420, 640, 860, 1080]) await T.pen(T.line(120, y, 260));
await T.tap('#check');
const sub0 = await T.waitSub('S1'), meta0 = sub0 && T.metaOf(sub0);
T.ok('（前提）交上去了：五组，g1 是红笔', Boolean(meta0) && meta0.groups.length === 5 && meta0.groups[0].red, meta0 && meta0.groups);
const c0 = meta0.crop, px = (b) => [(b[0] - c0.x0) * c0.scale, (b[1] - c0.y0) * c0.scale, (b[2] - c0.x0) * c0.scale, (b[3] - c0.y0) * c0.scale];
const G = (id) => meta0.groups.find((g) => g.id === id).bbox;
const PAGE = await S('({ X0: S.X0, Y0: S.Y0, TW: S.TW, H: S.pageH })');
T.ok('（前提）纸够高（下面几条要用到 1130 以上）', PAGE.H > 1200, PAGE);

// ================= 1. AI 回：一条短批注、六条长回答
const W1T = '九点出门比较稳：路上要一个小时。\n记得带伞。';
const W2T = Array.from({ length: 30 }, (_, k) => `第 ${k + 1} 条理由：单价不变时，买得越多花得越多。`).join('\n');
const W3T = '先算单价，再乘斤数：\n$$y = kx$$';
const W4T = '这条收着。';
const W5T = '放在右边这块空地上。';
const W6T = '想放的地方压着字，换个地方。';
const BOX5 = [600, 980, 990, 1130];
const rep1 = await T.post('/bridge/reply', { sid: 'S1', submission: sub0.id, items: [
  { type: 'note', anchor: 'g2', text: '短批注' },
  { type: 'write', anchor: 'g1', q: '几点出门？', text: W1T },
  { type: 'write', anchor: 'g2', q: '为什么？', text: W2T },
  { type: 'write', anchor: 'g3', text: W3T, place: 'below' },
  { type: 'write', anchor: 'g4', text: W4T, fold: true },
  { type: 'write', anchor: 'g5', text: W5T, place: px(BOX5) },
  { type: 'write', anchor: 'g5', text: W6T, place: px(G('g1')) }] });
T.ok('（前提）服务收下了 7 条', rep1.ok === true && rep1.count === 7, rep1);
T.ok('（前提）7 条落到这一页、写完了', await landed(7), await S('S.page.ai.map((a) => a.type)'));
let A = await all();
const W = (t) => A.find((a) => a.type === 'write' && a.text === t);
const [w1, w2, w3, w4, w5, w6] = [W1T, W2T, W3T, W4T, W5T, W6T].map(W);
T.ok('（前提）六条长回答都在，圈号 1–6', [w1, w2, w3, w4, w5, w6].every(Boolean) && [w1, w2, w3, w4, w5, w6].map((a) => a.n).join() === '1,2,3,4,5,6', A.map((a) => [a.type, a.n]));
T.ok('不太长、旁边有空的摊在纸上（1、3、5、6）；30 行的、AI 说收着的（2、4）只标圈号', Boolean(w1.spread && w3.spread && w5.spread && w6.spread) && !w2.spread && !w4.spread,
  [w1, w2, w3, w4, w5, w6].map((a) => Boolean(a.spread)));
T.ok('AI 说的「收着」不存进页面数据（fold、place 都不留）', A.every((a) => !('fold' in a) && !('place' in a)), A.map((a) => Object.keys(a)));
const g1 = G('g1'), g3 = G('g3');
T.ok('圈号 1 没说放哪：摊在所答的红笔问题右边，和它同一行（竖直方向叠着）', w1.spread.side === 'right' && w1.spread.x >= g1[2] && w1.spread.y < g1[3] && w1.spread.y + w1.spread.h > g1[1],
  [w1.spread, g1]);
T.ok('细线连到所答的笔迹（记在 spread.lead 里）', typeof w1.spread.lead === 'string' && w1.spread.lead.startsWith('M'), w1.spread.lead);
T.ok('两行字按原样分行；记着是到的时候自动摊的', same(w1.spread.rows.map((r) => r.t), ['九点出门比较稳：路上要一个小时。', '记得带伞。']) && w1.spread.by === 'auto', w1.spread.rows);
T.ok('AI 说放下面（place: below）：在所答那一行下面', w3.spread.side === 'below' && w3.spread.y >= g3[3], [w3.spread.side, w3.spread.y, g3]);
T.ok('$$…$$ 那一行排成公式（记的是 tex），在公式那一层画出来', w3.spread.rows.some((r) => r.tex === 'y = kx') && (await drawnOpen(w3.id)).tex === 1, [w3.spread.rows, await drawnOpen(w3.id)]);
const s5 = w5.spread;
T.ok('AI 给了一个像素框：摊在那个框里', s5.side === 'box' && s5.x >= BOX5[0] - 1 && s5.y >= BOX5[1] - 1 && s5.x + s5.w <= BOX5[2] + 1 && s5.y + s5.h <= BOX5[3] + 1, [s5, BOX5]);
T.ok('框里放不下（框在别人的字上）：照常在所答笔迹旁边另找，还是摊开', SIDES.includes(w6.spread.side), w6.spread.side);
const clash = await clashes();
T.ok('摊开的每一段（按纸上实际画出来的字、公式量）：不压用户的字、不压别的蓝字（短批注、圈号、别的摊开的）、在纸里', clash.length === 0, clash);
const tr3 = texRow(w3), td3 = await texDrawn(w3.id);
T.ok('公式那一行单独查：排出来的公式落在它那一行里，不伸出那一段', Boolean(tr3) && inside(td3, tr3) && td3[2] - td3[0] > 20, [td3, tr3]);
T.ok('摊开的记为看过，收着的没看过', w1.seen && w3.seen && w5.seen && w6.seen && !w2.seen && !w4.seen);
T.ok('作者记着（S1 的对话）', [w1, w3, w5, w6].every((a) => a.author && a.author.sid === 'S1'), w1.author);
const d1 = await drawnOpen(w1.id), nl = await noteLook('短批注');
T.ok('纸上画的是那两行字（不是圈号），有细线', Boolean(d1) && d1.n === 2 && d1.text === '九点出门比较稳：路上要一个小时。|记得带伞。' && d1.lead && !(await badgeOf(w1.id)), d1);
T.ok('和短批注同一种字、同一个颜色（蓝）、同一个字号', Boolean(nl) && d1.fill === nl.fill && d1.font === nl.font && d1.fs === nl.fs && d1.fill === 'rgb(47, 95, 174)', [d1, nl]);
T.ok('收着的两条画圈号，摊开的四条不画', Boolean(await badgeOf(w2.id)) && Boolean(await badgeOf(w4.id)) && !(await badgeOf(w3.id)) && !(await badgeOf(w5.id)) && !(await badgeOf(w6.id)));
await T.shot('b1-landed.png');

// ================= 2. 交给 AI 的图：单页（平板画的）、整本检测（电脑画的）里摊开的那一段是蓝字本身
await T.pen(T.line(600, 1300, 150));
await T.tap('#check');
const sub1 = await T.waitSub('S1'), meta1 = sub1 && T.metaOf(sub1);
const ob = (a) => [a.spread.x, a.spread.y, a.spread.x + a.spread.w, a.spread.y + a.spread.h];
// 圈号 3 的字那一行和公式那一行分开数（2026-11-18 外部审查：整段一起数，公式那一行没画也查不出来）
const bp1 = sub1 && (await bluePixels(join(T.DATA, 'submissions', sub1.id, 'crop.jpg'), meta1.crop, [ob(w1), textRows(w3), texRow(w3)], 'image/jpeg'));
T.ok('单页交给 AI 的图里，摊开的两段那里有蓝字（各 40 个以上蓝点）', Boolean(bp1) && bp1[0] > 40 && bp1[1] > 40, bp1);
T.ok('单页交给 AI 的图里，圈号 3 公式那一行单独数也有蓝字（公式的源码）', Boolean(bp1) && bp1[2] > 15, bp1);
const t1 = sub1 ? sub1.text : '';
T.ok('消息的列表里圈号 1 标「（摊在纸上）」，说一句图里是什么样；收着的圈号 2 不标', t1.includes('- 圈号 1（摊在纸上）（问：几点出门？）：九点出门比较稳') && t1.includes('- 圈号 2（问：为什么？）：')
  && t1.includes('标着「摊在纸上」的长回答，图里是它那一段蓝字本身，不是圈号。'), t1.slice(-900));
const scan = await T.post('/bridge/scan', { sid: 'S1', nb: 'scratch', pages: [1] });
const sk = scan.id ? T.metaOf(scan).pages['1'].crop : null;
const bp2 = sk && (await bluePixels(join(T.DATA, 'submissions', scan.id, 'p001.png'), sk, [ob(w1), ob(w5), texRow(w3)], 'image/png'));
T.ok('整本检测（电脑画的图）里，摊开的那一段也是蓝字', Boolean(bp2) && bp2[0] > 40 && bp2[1] > 40, [bp2, scan.error]);
T.ok('整本检测的图里，圈号 3 公式那一行单独数也有蓝字', Boolean(bp2) && bp2[2] > 15, bp2);
T.ok('整本检测的消息里也标「（摊在纸上）」', (scan.text || '').includes('圈号 1（摊在纸上）') && (scan.text || '').includes('标着「摊在纸上」的长回答'), (scan.text || '').slice(-600));

// ================= 3. 套索选中 g1 拖开：摊开的那一段跟着走同样的量；撤销回原处
const before3 = await item(w1.id);
await T.tool('lasso');
await loop([[100, 168], [392, 168], [392, 232], [100, 232]]);
const sel3 = await S('S.sel ? S.sel.ids.slice() : null');
T.ok('（前提）套索选中了 g1 那一笔', same(sel3, meta0.groups[0].ids), [sel3, meta0.groups[0].ids]);
await drag([250, 200], 40, 60);
const U3 = await S('JSON.parse(JSON.stringify(S.undo[S.undo.length - 1] || null))');
const after3 = await item(w1.id), d3 = await drawnOpen(w1.id);
const near = (u, v) => Math.abs(u - v) <= 0.051;
T.ok('（前提）撤销记录里多了一步「挪动」', Boolean(U3) && U3.t === 'move', U3 && U3.t);
const ld0 = nums(before3.spread.lead), ld1 = nums(after3.spread.lead);
T.ok('摊开的那一段跟着挪了同样的量：位置、细线每一个点；字、大小不变', Boolean(U3) && near(after3.spread.x, before3.spread.x + U3.dx) && near(after3.spread.y, before3.spread.y + U3.dy)
  && ld0.length === ld1.length && ld0.every((v, i) => near(ld1[i], v + (i % 2 ? U3.dy : U3.dx))) && same(after3.spread.rows, before3.spread.rows) && after3.spread.w === before3.spread.w,
  [before3.spread, after3.spread, U3 && [U3.dx, U3.dy]]);
T.ok('纸上画的字也在新地方', Boolean(d3) && near(d3.x, after3.spread.x), [d3 && d3.x, after3.spread.x]);
await T.shot('b3-lasso.png');
await T.tool('pen');
await T.tap('#toolsUndo');
T.ok('撤销：回到原处，样子一点没变', same((await item(w1.id)).spread, before3.spread), (await item(w1.id)).spread);

// ================= 4. 黑笔写到摊开的字上：收回圈号；撤销摊回原处；恢复又收起；再撤销
const sp1 = (await item(w1.id)).spread;
await clearToasts();
await T.pen(hline(sp1.x + 10, sp1.y + sp1.rows[0].y + 14, Math.min(160, sp1.rows[0].w - 20)));
let w1n = await item(w1.id);
T.ok('黑笔写到摊开的字上：收回圈号（纸上画圈号，没有那段字）', !w1n.spread && Boolean(await badgeOf(w1.id)) && !(await drawnOpen(w1.id)), w1n && w1n.spread);
T.ok('收回的圈号是空心的（看过）', Boolean((await badgeOf(w1.id)) && (await badgeOf(w1.id)).seen));
T.ok('上方说了一句', (await toasts()).includes('被字压到的回答收成了圈号，点圈号能看'), await toasts());
await T.shot('b4-folded.png');
await T.tap('#toolsUndo');
w1n = await item(w1.id);
T.ok('撤销这一笔：笔迹没了，摊回原处', same(w1n.spread, sp1) && (await S('S.page.strokes.filter((s) => !s.erasedAt).length')) === 6 && Boolean(await drawnOpen(w1.id)), w1n.spread);
await T.tap('#toolsRedo');
w1n = await item(w1.id);
T.ok('恢复这一笔：又收回圈号', !w1n.spread && Boolean(await badgeOf(w1.id)), w1n.spread);
await T.tap('#toolsUndo');
w1n = await item(w1.id);
T.ok('再撤销：又摊回原处，作者还在', same(w1n.spread, sp1) && w1n.author && w1n.author.sid === 'S1', [w1n.spread, w1n.author]);
// 红笔写在摊开的字上不收（那是批注它，交给 AI 时图里看得到）
await T.tool('red');
await T.pen(hline(sp1.x + 10, sp1.y + sp1.rows[1].y + 16, 60));
T.ok('红笔写在摊开的字上：不收', Boolean((await item(w1.id)).spread));
await T.tap('#toolsUndo');
await T.tool('pen');

// ================= 5. 手指点摊开的字开卡片；卡片底下「收起」「摊在纸上」；撤销、恢复
await waitPen();
const [tx, ty] = await T.screenOf(sp1.x + 30, sp1.y + sp1.rows[0].y + 14);
await T.fingerTapAt(tx, ty);
let cu = await cardUp();
T.ok('手指点摊开的字：开这条的卡片，底下一排「收起」「再短点」「展开讲」', Boolean(cu) && cu.id === w1.id && cu.acts && cu.spread.text === '收起' && !cu.spread.hidden
  && cu.shorter.text === '再短点' && cu.longer.text === '展开讲', cu);
await T.shot('b5-card-open.png');
await T.tap('#acSpread');
cu = await cardUp();
w1n = await item(w1.id);
T.ok('点「收起」：收成圈号，卡片还开着，钮变「摊在纸上」', !w1n.spread && Boolean(await badgeOf(w1.id)) && Boolean(cu) && cu.spread.text === '摊在纸上', [w1n.spread, cu]);
await T.tap('#acSpread');
w1n = await item(w1.id);
cu = await cardUp();
T.ok('再点「摊在纸上」：摊回原来那里（记着是用户点的），钮变回「收起」', Boolean(w1n.spread) && w1n.spread.x === sp1.x && w1n.spread.y === sp1.y && same(w1n.spread.rows, sp1.rows)
  && w1n.spread.by === 'user' && Boolean(cu) && cu.spread.text === '收起', [w1n.spread, sp1]);
await T.tap('#toolsUndo');
w1n = await item(w1.id);
T.ok('撤销：退回收着', !w1n.spread && Boolean(await badgeOf(w1.id)));
await T.tap('#toolsRedo');
w1n = await item(w1.id);
T.ok('恢复：又摊开', Boolean(w1n.spread) && w1n.spread.x === sp1.x && w1n.spread.y === sp1.y);
await js(`window.__ink.closeCard()`);
// 30 行的那条：卡片上点「摊在纸上」说太长，不摊
await waitPen();
const b2 = await badgeOf(w2.id);
await T.fingerTapAt(b2.cx, b2.cy);
await clearToasts();
cu = await cardUp();
T.ok('（前提）圈号 2 的卡片开了，底下是「摊在纸上」', Boolean(cu) && cu.id === w2.id && cu.spread.text === '摊在纸上' && !cu.spread.hidden, cu);
await T.tap('#acSpread');
T.ok('太长的点「摊在纸上」：说太长，不摊', !(await item(w2.id)).spread && (await toasts()).includes('这条太长（超过 24 行），摊开会占太多纸，留在卡片里看'), await toasts());
await js(`window.__ink.closeCard()`);

// ================= 6. 存盘、刷新：摊开的样子、作者都在
const keep = (await all()).filter((a) => a.type === 'write').map((a) => [a.id, a.spread || null, a.author || null]);
await T.saved();
const disk = T.pageFile('scratch', 0);
T.ok('存回电脑的页面文件里有 spread', Boolean(disk) && disk.ai.filter((a) => a.spread).length === 4, disk && disk.ai.map((a) => Boolean(a.spread)));
await T.reload();
await watchToasts();
if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }
const back = (await all()).filter((a) => a.type === 'write').map((a) => [a.id, a.spread || null, a.author || null]);
T.ok('刷新后：每条长回答摊开的样子、作者和刷新前一样', same(back, keep), back.map((b) => Boolean(b[1])));
T.ok('刷新后纸上照样画着那几段字', Boolean(await drawnOpen(w1.id)) && Boolean(await drawnOpen(w3.id)) && Boolean(await badgeOf(w2.id)));

// ================= 7. 第 2 页写满：长回答只标圈号；点「摊在纸上」说旁边没空地方
await T.openPage(1);
if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }
const P2 = await S('({ X0: S.X0, TW: S.TW, H: S.pageH })');
const zig = [];
for (let y = 160, k = 0; y <= P2.H - 200; y += 24, k++) zig.push([k % 2 ? P2.TW - 14 : P2.X0 + 14, y]);
await T.pen(zig);
await T.tap('#check');
const sub7 = await T.waitSub('S1');
// 10 行（不算太长，摊得开的上限）：纸底下剩的不到 200 高，放不下它
const W7T = Array.from({ length: 10 }, (_, k) => `第 ${k + 1} 行`).join('\n');
const rep7 = await T.post('/bridge/reply', { sid: 'S1', submission: sub7.id, items: [{ type: 'write', anchor: 'g1', text: W7T }] });
T.ok('（前提）收下了', rep7.ok === true, rep7);
T.ok('（前提）落到第 2 页', await landed(1), [await S('S.idx'), await S('S.page.ai.length'), T.errors.slice(-3)]);
const w7 = (await all()).find((a) => a.type === 'write');
T.ok('整页写满、旁边没空：只标圈号', Boolean(w7) && !w7.spread && Boolean(await badgeOf(w7.id)), w7);
// 圈号挤在右下角（右下角那一条工具压着它）：直接打开它的卡片（点圈号开卡片在第 5 步和 answer_card 里查）
await S(`(window.__ink.openCard(S.page.ai.find((a) => a.id === ${JSON.stringify(w7.id)})), 1)`);
await sleep(300);
T.ok('（前提）卡片开了，底下是「摊在纸上」', ((await cardUp()) || {}).id === w7.id && (await cardUp()).spread.text === '摊在纸上', await cardUp());
await clearToasts();
await T.tap('#acSpread');
T.ok('点「摊在纸上」：说旁边没有空地方，不摊', !(await item(w7.id)).spread && (await toasts()).includes('旁边没有空地方摊开它：先用套索把字挪开一点再试'), await toasts());
await js(`window.__ink.closeCard()`);

// ================= 8. 书页上：短的长回答也只标圈号，卡片上没有「摊在纸上」
const SRC = join(T.ROOT, 'src'), PDF = join(SRC, 'book.pdf');
mkdirSync(SRC, { recursive: true });
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
doc=fitz.open()
p=doc.new_page(width=1000,height=1300)
p.insert_text((60,120),'Shopping list for Saturday',fontsize=36)
doc.save(sys.argv[1])`, PDF]);
const imp = await T.post('/bridge/import', { sid: 'S1', path: PDF });
await T.openNotebook(imp.id, 0);
await T.tool('red');
await T.pen(T.line(60, 140, 300));
await T.tool('pen');
await T.tap('#check');
const sub8 = await T.waitSub('S1');
await T.post('/bridge/reply', { sid: 'S1', submission: sub8.id, items: [{ type: 'write', anchor: 'g1', text: '短的回答。' }] });
T.ok('（前提）落到书页上', await landed(1));
const w8 = (await all()).find((a) => a.type === 'write');
T.ok('书页上：短的长回答也只标圈号', Boolean(w8) && !w8.spread && Boolean(await badgeOf(w8.id)), w8);
await waitPen();
const b8 = await badgeOf(w8.id);
await T.fingerTapAt(b8.cx, b8.cy);
cu = await cardUp();
T.ok('书页上的卡片：没有「摊在纸上」，有「再短点」「展开讲」', Boolean(cu) && cu.spread.hidden && !cu.shorter.hidden && !cu.longer.hidden, cu);

await T.finish();

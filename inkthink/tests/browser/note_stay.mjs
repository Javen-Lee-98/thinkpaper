// 红笔批过的短批注留在纸上（2026-11-18 用户改的，《产品定义》第 2 节；细节是用户不在时暂定的）。改的是 2026-11-14 那条
// 「红笔写在短批注上，点「AI」时它收成圈号、变成卡片」。查：
// 1. 空白本子：红笔写在一条短批注上（一笔压着字、同一口气在框外又写一笔），远处另写一句红笔，点「AI」：
//    那条批注照旧在纸上（同样的排版、不是小蓝点），两笔红字照旧在纸上，没有新的圈号；投递里没有卡片的图；
//    书写过程里那一组写着「红笔（问题，写在蓝字批注「开头几个字…」上）」，远处那句只是「红笔（问题）」；交给 AI 的图里批注的蓝字、红字都在。
// 2. Claude 照别的红笔问题回（note，anchor 填那组红笔）：落在红字旁边，不压任何一笔字、不压别的蓝字。
// 3. 收起、放回是用户的事：手指点一条短批注的字，浮出它的小卡片，底下一个钮「收成蓝点」（点按范围 44，「再短点」「展开讲」不出）；
//    点了收成小蓝点（小卡片换成「放回纸上」）；撤销展开回来，恢复又收起；点小蓝点「放回纸上」回到原处。
//    原处被后来写的字占了：放回时在所指那块旁边重新找空白（细线连回去），不压字；撤销回到小蓝点。刷新后收起的还是小蓝点。
// 4. 黑笔点一下批注的字：浮出小卡片，这一点不留；红笔落在小卡片上：小卡片收起，不留红字。黑笔写过批注的字：照旧自动收成小蓝点，撤销展开回来。
// 5. 第 2 页：几页一起交时，写在第 2 页一条批注上的红字在整本消息里也写明写在哪条批注上，批注照旧在纸上。
// 6. 以前的数据：小蓝点浮出时写过、还没交的红字，点「AI」时照旧收成卡片（原来是短批注）；这种卡片（以及以前收成的）现在也能「摊在纸上」，
//    摊开的是原来那条批注的话，红字留在卡片里；「收起」回到圈号。
// 7. 放回纸上时四周都写满了：说一句旁边没有空地方，照旧是小蓝点。
// 笔是 pointerType 为 pen 的鼠标事件，手指是 CDP 的触摸事件；只在无头 Edge 里跑过，没在 iPad 上试过。
// 跑法：node tests/run_browser.mjs <临时目录> --only note_stay；有一项不对退出码 1。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'note-stay', pages: 2 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const waitPen = () => sleep(1150); // 笔刚用过的一秒内手指不算（手掌）
const hline = (x0, y, len, n = 14) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 0.6]);
const boxDist = (a, b) => Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
async function landed(n) { // 等写回的批注落到这一页（至少 n 条），并且一条条写完
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
async function send() { // 点「AI」交上去，返回投递和它的 meta
  await T.saved();
  await T.tap('#check');
  const sub = await T.waitSub('S1', 200), meta = sub && T.metaOf(sub);
  return { sub, meta };
}
// 一条批注：数据、纸上画出来的字（屏幕上的框）、是不是小蓝点、小蓝点在屏幕上的圆心
const note = (text) => js(`(() => { const S = window.__ink.S, a = S.page.ai.find((o) => o.text === ${JSON.stringify(text)}); if (!a) return null;
  const g = document.querySelector('#aiRoot > g[data-id="' + a.id + '"]'), pt = g && g.querySelector('circle.pt'), r = pt && pt.getBoundingClientRect();
  return Object.assign(JSON.parse(JSON.stringify(a)), { tb: a.lay ? window.__ink.noteTextBox(a) : null, isDot: window.__ink.isDot(a),
    words: g ? [...g.querySelectorAll(':scope > text:not(.adopt-star)')].map((t) => t.textContent) : [], lead: Boolean(g && g.querySelector('path.leader')),
    dotScreen: r ? [r.left + r.width / 2, r.top + r.height / 2] : null }); })()`);
const badges = () => js(`[...document.querySelectorAll('#aiRoot .badge')].filter((g) => !g.classList.contains('nbr-badge')).map((g) => g.dataset.id)`);
// 开着的卡片：是不是短批注浮出的小卡片、底下那一排各钮（看不见的为 null）
const card = () => js(`(() => { const c = document.querySelector('#answerCard'), S = window.__ink.S; if (c.hidden || !S.card) return null;
  const b = (s) => { const e = document.querySelector(s); if (!e || e.hidden || e.closest('[hidden]')) return null; const r = e.getBoundingClientRect();
    return { text: e.textContent, act: e.dataset.act || '', l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const r = c.getBoundingClientRect();
  return { id: S.card.id, note: S.card.note, pop: c.classList.contains('note-pop'), spread: b('#acSpread'), shorter: b('#acShorter'), longer: b('#acLonger'),
    l: r.left, t: r.top, r: r.right, b: r.bottom }; })()`);
// 沿圆角框的竖中线逐像素查：可见的 32 像素和上下各 6 像素都应点到这个钮。
const hit44 = (sel) => js(`(() => {
  const e = document.querySelector(${JSON.stringify(sel)}), r = e.getBoundingClientRect(), face = getComputedStyle(e, '::before');
  const top = r.top + parseFloat(face.top), h = parseFloat(face.height), x = (r.left + r.right) / 2;
  if (Math.abs(h - 32) > 0.1 || !Number.isFinite(top + h)) return false;
  for (let y = top - 5.5; y < top + h + 6; y++) {
    if (document.elementFromPoint(x, y)?.closest('button') !== e) return false;
  }
  return true;
})()`);
const tapSpreadEdge = async (lower) => {
  const [x, y] = await js(`(() => { const r = document.querySelector('#acSpread').getBoundingClientRect();
    return [(r.left + r.right) / 2, ${lower ? 'r.bottom - 1' : 'r.top + 1'}]; })()`);
  await T.fingerTapAt(x, y);
};
const tapNote = async (n) => { await waitPen(); const [x, y] = await T.screenOf((n.tb[0] + n.tb[2]) / 2, (n.tb[1] + n.tb[3]) / 2); await T.fingerTapAt(x, y); return card(); };
const tapDot = async (n) => { await waitPen(); await T.fingerTapAt(n.dotScreen[0], n.dotScreen[1]); return card(); };
const closeByTap = async () => { await waitPen(); const [x, y] = await T.screenOf(300, 1250); await T.fingerTapAt(x, y); };
const toastLog = () => js(`window.__toasts.slice()`);
await js(`(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (!t.hidden) window.__toasts.push(t.textContent); })
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true, attributes: true }); return 1; })()`);
// 这条批注的字压到了什么：用户的每一笔（点的外框加半个笔宽）、别的蓝字（批注层上别的条目的字、小圈、小点、符号）
const PG = `const st = document.querySelector('#stage').getBoundingClientRect(), V = window.__ink.S.view;
  const pg = (e) => { const r = e.getBoundingClientRect(); return [(r.left - st.left - V.tx) / V.s, (r.top - st.top - V.ty) / V.s, (r.right - st.left - V.tx) / V.s, (r.bottom - st.top - V.ty) / V.s]; };
  const ok = (b) => b[2] > b[0] && b[3] > b[1];`;
const clashes = (id) => js(`(() => { ${PG} const S = window.__ink.S, me = ${JSON.stringify(id)};
  const meet = (a, b) => a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1;
  const g = document.querySelector('#aiRoot > g[data-id="' + me + '"]'); if (!g) return ['没画出来'];
  const rows = [...g.querySelectorAll(':scope > text:not(.adopt-star)')].map(pg).filter(ok);
  if (!rows.length) return ['没有字'];
  const ink = S.page.strokes.filter((s) => !s.erasedAt && s.pts.length).map((s) => { const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]), h = (s.w || 2) / 2;
    return [Math.min(...xs) - h, Math.min(...ys) - h, Math.max(...xs) + h, Math.max(...ys) + h]; });
  const blue = [...document.querySelectorAll('#aiRoot > g[data-id]')].filter((x) => x !== g).flatMap((x) => [...x.querySelectorAll('text, circle, ellipse, path:not(.leader)')]).map(pg).filter((b) => b[2] >= b[0] && b[3] >= b[1]);
  const out = [];
  for (const r of rows) {
    const hi = ink.filter((o) => meet(r, o)), hb = blue.filter((o) => meet(r, o));
    if (hi.length) out.push(['压字', r, hi.slice(0, 3)]);
    if (hb.length) out.push(['压蓝字', r, hb.slice(0, 3)]);
  }
  return out; })()`);
// 交给 AI 的图（crop.jpg）里几块页面坐标的框各有多少蓝、红的点
function colorPixels(file, k, boxes) {
  const b64 = readFileSync(file).toString('base64');
  const px = (b) => [b[0] - k.x0, b[1] - k.y0, b[2] - k.x0, b[3] - k.y0].map((v) => v * k.scale);
  return js(`new Promise((res) => { const im = new Image(); im.onload = () => { const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const x = cv.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, im.width, im.height).data, boxes = ${JSON.stringify(boxes.map(px))};
    const blue = (i) => d[i + 2] - d[i] > 50 && d[i + 2] > 90, red = (i) => d[i] > 150 && d[i + 1] < 130 && d[i + 2] < 130;
    res(boxes.map((b) => { let nb = 0, nr = 0; for (let Y = Math.max(0, Math.floor(b[1])); Y < Math.min(im.height, b[3]); Y++) for (let X = Math.max(0, Math.floor(b[0])); X < Math.min(im.width, b[2]); X++) {
      const i = (Y * im.width + X) * 4; if (blue(i)) nb++; else if (red(i)) nr++; } return { blue: nb, red: nr }; })); };
    im.onerror = () => res(null); im.src = 'data:image/jpeg;base64,${b64}'; })`);
}
const SHOTS = [];

// ================= 0. 单页；三句红笔问题交上去；Claude 回三条短批注（第一条两行长）
if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }
await T.tool('red');
await T.pen(T.line(120, 200, 300));
await T.pen(T.line(120, 420, 300));
await T.pen(T.line(120, 640, 300));
await T.tool('pen');
const s1 = await send();
T.ok('（前提）交上去了：三句红笔问题', Boolean(s1.meta) && s1.meta.groups.length === 3 && s1.meta.groups.every((g) => g.red), s1.meta && s1.meta.groups);
const NOTE1 = '第二天上午先去博物馆，下午人少的时候再去公园散步。', NOTE2 = '记得带雨伞', NOTE3 = '车票要提前买';
await T.post('/bridge/reply', { sid: 'S1', submission: s1.sub.id, items: [
  { type: 'note', anchor: 'g1', text: NOTE1 }, { type: 'question', anchor: 'g2', text: NOTE2 }, { type: 'note', anchor: 'g3', text: NOTE3 }] });
T.ok('（前提）三条短批注落下、写完了', await landed(3));
await sleep(300);
let n1 = await note(NOTE1);
const n2 = await note(NOTE2), n3 = await note(NOTE3);
T.ok('（前提）三条都在纸上（不是小蓝点），第一条两行', Boolean(n1 && n2 && n3) && !n1.isDot && !n2.isDot && !n3.isDot && n1.lay.lines.length === 2, [n1 && n1.lay, n2 && n2.lay]);

// ================= 1. 第一条上写红字（一笔压着第一行几个字，同一口气在框外下面又写一笔）；远处另写一句红笔；点「AI」
const L = n1.lay;
await T.tool('red');
await T.pen(hline(L.x + 2 * L.fs, L.y + L.fs + 5, 5 * L.fs));
const yb = L.y + (L.lines.length - 1) * L.lh + L.fs * 1.2 + 30;
await T.pen([[L.x + 140, yb], [L.x + 150, yb - 8], [L.x + 160, yb], [L.x + 152, yb + 10], [L.x + 152, yb + 16]]);
const [mkA, mkB] = await S(`S.page.strokes.filter((s) => s.c === 'r').slice(-2).map((s) => JSON.parse(JSON.stringify(s)))`);
await sleep(2000); // 和上面那两笔隔开（另成一组）
await T.pen(T.line(120, 900, 250));
const farId = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tool('pen');
await T.saved();
{ const [x0, y0] = await T.screenOf(L.x - 40, L.y - 30), [x1, y1] = await T.screenOf(L.x + L.w + 20, yb + 50);
  const z = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: 2 } });
  const f = join(T.OUT, '1-red-on-note-before.png'); writeFileSync(f, Buffer.from(z.data, 'base64')); SHOTS.push(f); }
const s2 = await send(), meta2 = s2.meta;
T.ok('（前提）交上去了（单页）', Boolean(meta2) && meta2.kind !== 'scan' && Array.isArray(meta2.groups), meta2 && meta2.kind);
n1 = await note(NOTE1);
T.ok('那条批注照旧在纸上：同样的排版、两行字都画着、不是小蓝点、还是 note', Boolean(n1) && n1.type === 'note' && !n1.isDot && JSON.stringify(n1.lay) === JSON.stringify(L)
  && n1.words.length === 2 && !n1.from, n1 && [n1.type, n1.isDot, n1.words]);
const strokesNow = await S(`S.page.strokes.filter((s) => !s.erasedAt).map((s) => s.id)`);
T.ok('两笔红字照旧在纸上（没挪进卡片），远处那句也在', [mkA.id, mkB.id, farId].every((id) => strokesNow.includes(id)), strokesNow);
T.ok('没有新的圈号', (await badges()).length === 0, await badges());
const gOn = meta2 && meta2.groups.find((g) => g.ids.includes(mkA.id)), gFar = meta2 && meta2.groups.find((g) => g.ids.includes(farId));
T.ok('（前提）那两笔是同一组红笔、还要回答', Boolean(gOn) && gOn.red && !gOn.answered && gOn.ids.includes(mkB.id), gOn);
T.ok('投递里没有卡片的图（meta 没有 cards，目录里没有 card-*.png）', Boolean(meta2) && !meta2.cards
  && !readdirSync(join(T.DATA, 'submissions', s2.sub.id)).some((f) => f.startsWith('card')), meta2 && [meta2.cards, readdirSync(join(T.DATA, 'submissions', s2.sub.id))]);
const head = NOTE1.slice(0, 16) + '…';
const lineOn = gOn && s2.sub.text.split('\n').find((l) => l.startsWith(gOn.id + '｜')), lineFar = gFar && s2.sub.text.split('\n').find((l) => l.startsWith(gFar.id + '｜'));
T.ok('书写过程里那一组写明写在哪条批注上：「红笔（问题，写在蓝字批注「第二天上午先去博物馆，下午人少的时候…」上）」',
  Boolean(lineOn) && lineOn.includes(`｜红笔（问题，写在蓝字批注「${head}」上）`) && gOn.note_on === NOTE1, [lineOn, gOn && gOn.note_on]);
T.ok('远处那句只是「红笔（问题）」', Boolean(lineFar) && lineFar.includes('｜红笔（问题）') && !lineFar.includes('蓝字批注') && !gFar.note_on, lineFar);
T.ok('消息里不再说「卡片上的红字」「原来是你写在纸上的一条短批注」', !s2.sub.text.includes('卡片上的红字') && !s2.sub.text.includes('原来是你写在纸上的一条短批注'), s2.sub.text.slice(-800));
{
  const k = meta2.crop, jpg = join(T.DATA, 'submissions', s2.sub.id, 'crop.jpg');
  const xsA = mkA.pts.map((p) => p[0]), ysA = mkA.pts.map((p) => p[1]);
  const [txt, red] = await colorPixels(jpg, k, [[L.x, L.y + L.lh + 2, L.x + L.w, L.y + L.lh + L.fs * 1.2], [Math.min(...xsA) - 2, Math.min(...ysA) - 3, Math.max(...xsA) + 2, Math.max(...ysA) + 3]]);
  T.ok('交给 AI 的图里：那条批注的蓝字照旧在（第二行那里有蓝），红字也在', Boolean(txt && red) && txt.blue > 80 && red.red > 20, [txt, red]);
}
SHOTS.push(await T.shot('2-after-ai.png'));

// ================= 2. Claude 照别的红笔问题回：anchor 填那组红笔。落在红字旁边，不压字、不压别的蓝字
const R1 = '上午刚开门人最少，博物馆十点前最空。';
await T.post('/bridge/reply', { sid: 'S1', submission: s2.sub.id, items: [{ type: 'note', anchor: gOn.id, text: R1 }] });
T.ok('（前提）回应落下、写完了', await landed(4));
await sleep(300);
const r1 = await note(R1);
const redBox = (() => { const pts = mkA.pts.concat(mkB.pts); return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]; })();
T.ok('回应指着那两笔红字（on），在纸上（不是小蓝点）', Boolean(r1) && !r1.isDot && [mkA.id, mkB.id].every((id) => (r1.on || []).includes(id)), r1 && [r1.on, r1.isDot]);
const cl = r1 ? await clashes(r1.id) : ['没有'];
T.ok('回应不压任何一笔字、不压别的蓝字（第一条批注的字也不压）', cl.length === 0, cl);
T.ok('回应在红字旁边（离那两笔的外框不到 300）', Boolean(r1 && r1.tb) && boxDist(r1.tb, redBox) < 300, r1 && [r1.tb, redBox]);
T.ok('还是没有圈号；第一条批注照旧在纸上', (await badges()).length === 0 && !(await note(NOTE1)).isDot);
SHOTS.push(await T.shot('3-reply-beside-red.png'));

// ================= 3. 用户自己收起、放回（第二条）
let c = await tapNote(n2);
T.ok('手指点第二条的字：浮出它的小卡片，底下只有一个钮「收成蓝点」（「再短点」「展开讲」不出）', Boolean(c) && c.id === n2.id && c.note && c.pop
  && Boolean(c.spread) && c.spread.text === '收成蓝点' && c.spread.act === 'todot' && !c.shorter && !c.longer, c);
T.ok('「收成蓝点」看上去 32 高，点得到的范围 ≥ 44 高', await hit44('#acSpread'));
SHOTS.push(await T.shot('4-popout-fold-button.png'));
await tapSpreadEdge(true);
let x2 = await note(NOTE2);
c = await card();
T.ok('点「收成蓝点」：收成小蓝点（记着是用户收的），纸上没有它的字；小卡片还开着、钮换成「放回纸上」', x2.isDot && x2.dot.why === 'user' && x2.words.length === 0
  && Boolean(c) && c.id === n2.id && c.pop && Boolean(c.spread) && c.spread.text === '放回纸上' && c.spread.act === 'topaper', [x2.dot, x2.words, c]);
SHOTS.push(await T.shot('5-folded-popout-put-back.png'));
await T.tap('#toolsUndo');
await sleep(300);
x2 = await note(NOTE2);
T.ok('撤销：展开回来（原处、同样的排版），小卡片收起', !x2.isDot && JSON.stringify(x2.lay) === JSON.stringify(n2.lay) && x2.words.length === 1 && !(await card()), [x2.dot, x2.lay]);
await T.tap('#toolsRedo');
await sleep(300);
x2 = await note(NOTE2);
T.ok('恢复：又收成小蓝点', x2.isDot && x2.dot.why === 'user', x2.dot);
c = await tapDot(x2);
T.ok('手指点小蓝点：浮出小卡片，钮是「放回纸上」', Boolean(c) && c.id === n2.id && c.spread && c.spread.text === '放回纸上', c);
T.ok('「放回纸上」看上去 32 高，上下各多出 6 像素能点', await hit44('#acSpread'));
await tapSpreadEdge(false);
x2 = await note(NOTE2);
c = await card();
T.ok('点「放回纸上」：原处空着，回到原处（同样的排版、细线照旧），小卡片的钮换回「收成蓝点」', !x2.isDot && JSON.stringify(x2.lay) === JSON.stringify(n2.lay)
  && JSON.stringify(x2.paths) === JSON.stringify(n2.paths) && Boolean(c && c.spread) && c.spread.text === '收成蓝点', [x2.lay, n2.lay, c]);
// 原处被后来写的字占了
await T.tap('#acSpread');
await closeByTap();
x2 = await note(NOTE2);
T.ok('（前提）又收成了小蓝点，小卡片收起', x2.isDot && !(await card()));
await T.pen(hline(n2.lay.x + 40, n2.lay.y + 12, n2.lay.w + 30, 16)); // 黑笔写过它原来那几行字的地方（不碰小蓝点）
const blk2 = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
x2 = await note(NOTE2);
c = await tapDot(x2);
await T.tap('#acSpread');
x2 = await note(NOTE2);
const moved = !x2.isDot && (x2.lay.x !== n2.lay.x || x2.lay.y !== n2.lay.y);
const cl2 = await clashes(n2.id);
T.ok('原处被字占了：放回时另找空白（位置变了），不压字、不压别的蓝字', moved && cl2.length === 0, [x2.lay, n2.lay, cl2]);
T.ok('另找的地方离所指的那句不远，有细线连回去', x2.lead && boxDist(x2.tb, [120, 415, 420, 425]) < 300, [x2.lead, x2.tb]);
SHOTS.push(await T.shot('6-put-back-elsewhere.png'));
await closeByTap();
await T.tap('#toolsUndo');
await sleep(300);
x2 = await note(NOTE2);
T.ok('撤销：回到小蓝点（原来的排版留着）', x2.isDot && JSON.stringify(x2.lay) === JSON.stringify(n2.lay), [x2.dot, x2.lay]);
T.ok('（前提）那一笔黑字还在', await S(`S.page.strokes.some((s) => s.id === ${JSON.stringify(blk2)} && !s.erasedAt)`));
// 刷新后
T.ok('存上了', await T.saved());
await T.reload();
await js(`(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (!t.hidden) window.__toasts.push(t.textContent); })
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true, attributes: true }); return 1; })()`);
x2 = await note(NOTE2);
n1 = await note(NOTE1);
T.ok('刷新后：第二条还是小蓝点（用户收的），第一条和红字照旧在纸上', x2.isDot && x2.dot.why === 'user' && !n1.isDot && n1.words.length === 2
  && (await S(`[${JSON.stringify(mkA.id)}, ${JSON.stringify(mkB.id)}].every((id) => S.page.strokes.some((s) => s.id === id && !s.erasedAt))`)), [x2.dot, n1.isDot]);
c = await tapDot(x2);
T.ok('刷新后点小蓝点：浮出小卡片，钮是「放回纸上」', Boolean(c && c.spread) && c.spread.text === '放回纸上', c);
await closeByTap();

// ================= 4. 第三条：黑笔点一下浮出小卡片（不留这一点）；红笔落在小卡片上收起小卡片；黑笔写过字照旧自动收
let x3 = await note(NOTE3);
const nStrokes = await S('S.page.strokes.length');
await T.pen([[(x3.tb[0] + x3.tb[2]) / 2, (x3.tb[1] + x3.tb[3]) / 2], [(x3.tb[0] + x3.tb[2]) / 2 + 1, (x3.tb[1] + x3.tb[3]) / 2 + 1]]);
c = await card();
T.ok('黑笔点一下第三条的字：浮出它的小卡片，这一点不留作笔迹，批注照旧在纸上', Boolean(c) && c.id === n3.id && c.pop && (await S('S.page.strokes.length')) === nStrokes
  && !(await note(NOTE3)).isDot, [c, await S('S.page.strokes.length'), nStrokes]);
{
  const W = await js(`(() => { const c = document.querySelector('#answerCard').getBoundingClientRect(), st = document.querySelector('#stage').getBoundingClientRect(), V = window.__ink.S.view;
    const w = (x, y) => [(x - st.left - V.tx) / V.s, (y - st.top - V.ty) / V.s]; return [w(c.left + 20, c.top + 22), w(c.right - 20, c.top + 26)]; })()`);
  await T.tool('red');
  await T.pen(hline(W[0][0], W[0][1], W[1][0] - W[0][0], 8));
  await T.tool('pen');
}
x3 = await note(NOTE3);
T.ok('红笔落在小卡片上：小卡片收起，不留红字（批注上没有 marks，纸上也没多一笔）', !(await card()) && !(x3.marks && x3.marks.length) && (await S('S.page.strokes.length')) === nStrokes,
  [await card(), x3.marks, await S('S.page.strokes.length')]);
await T.pen(hline(x3.tb[0] - 10, (x3.tb[1] + x3.tb[3]) / 2, x3.tb[2] - x3.tb[0] + 20));
x3 = await note(NOTE3);
T.ok('黑笔写过第三条的字：照旧自动收成小蓝点（记着是被字压到的），屏幕上方说一句', x3.isDot && x3.dot.why === 'ink'
  && (await toastLog()).some((t) => t.includes('收成了小蓝点')), [x3.dot, await toastLog()]);
await T.tap('#toolsUndo');
await sleep(300);
x3 = await note(NOTE3);
T.ok('撤销这一笔：第三条展开回来', !x3.isDot && x3.words.length === 1, x3.dot);
T.ok('页面没有报错（第 1 页）', !T.errors.length, T.errors);

// ================= 5. 第 2 页：几页一起交时，写在第 2 页一条批注上的红字也写明写在哪条批注上
await T.openPage(1);
await T.tool('red');
await T.pen(T.line(120, 200, 300));
await T.tool('pen');
const s3 = await send();
T.ok('（前提）交上去了', Boolean(s3.meta), s3.meta && s3.meta.kind);
const NP = '牛奶买两盒';
if (s3.meta && s3.meta.kind === 'scan') {
  const gx = s3.meta.pages['2'] && s3.meta.pages['2'].gx, gid = gx && Object.keys(gx).find((k) => gx[k].red);
  await T.post('/bridge/reply', { sid: 'S1', submission: s3.sub.id, page: 2, items: [{ type: 'note', anchor: gid, text: NP }] });
} else {
  await T.post('/bridge/reply', { sid: 'S1', submission: s3.sub.id, items: [{ type: 'note', anchor: s3.meta.groups.find((g) => g.red).id, text: NP }] });
}
T.ok('（前提）第 2 页的批注落下了', await landed(1));
await sleep(300);
let p = await note(NP);
await T.tool('red');
await T.pen(hline(p.lay.x + 4, p.lay.y + p.lay.fs + 5, 70));
const mkP = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tool('pen');
await T.saved();
await T.openPage(0);
await T.pen(T.line(120, 1100, 200)); // 第 1 页也写一笔：点「AI」几页一起交
const s4 = await send();
T.ok('几页一起交：第 1、2 页都在', Boolean(s4.meta) && s4.meta.kind === 'scan' && Boolean(s4.meta.pages['1']) && Boolean(s4.meta.pages['2']), s4.meta && Object.keys(s4.meta.pages || {}));
T.ok('整本消息里第 2 页那组红笔写明写在批注「牛奶买两盒」上；没有卡片', Boolean(s4.sub) && s4.sub.text.includes('｜红笔（问题，写在蓝字批注「牛奶买两盒」上）')
  && !s4.sub.text.includes('原来是你写在纸上的一条短批注'), s4.sub && s4.sub.text.slice(0, 2500));
T.ok('第 2 页那一笔照旧当纸上的红笔交（在第 2 页的分组里）', Boolean(s4.meta) && Object.values(s4.meta.pages['2'].gx || {}).some((g) => g.red && g.ids.includes(mkP)), s4.meta && s4.meta.pages['2']);
await T.openPage(1);
p = await note(NP);
T.ok('翻回第 2 页：那条批注照旧在纸上，红字也在', Boolean(p) && p.type === 'note' && !p.isDot && (await S(`S.page.strokes.some((s) => s.id === ${JSON.stringify(mkP)} && !s.erasedAt)`)), p && p.type);

// ================= 6. 以前的数据：小蓝点浮出时写过、还没交的红字（现在写不上去了，用数据造一份）→ 点「AI」照旧收成卡片；这种卡片能「摊在纸上」
c = await tapNote(p);
await T.tap('#acSpread');
await closeByTap();
p = await note(NP);
T.ok('（前提）收成了小蓝点', p.isDot, p.dot);
await js(`(() => { const a = window.__ink.S.page.ai.find((o) => o.text === ${JSON.stringify(NP)});
  a.marks = [{ id: 'old-k1', blk: 'a', pts: [[30, 40, 0.5, 0], [60, 42, 0.5, 40], [90, 41, 0.5, 80]], t0: Date.now(), w: 2.1, c: 'r' }]; return 1; })()`);
const s5 = await send();
let w = await js(`(() => { const a = window.__ink.S.page.ai.find((o) => o.text === ${JSON.stringify(NP)}); return a ? JSON.parse(JSON.stringify(a)) : null; })()`);
T.ok('点「AI」：旧数据里那条（小蓝点上有还没交的红字）照旧收成圈号卡片（原来是短批注），红字在卡片上', Boolean(w) && w.type === 'write' && Boolean(w.from) && w.from.type === 'note'
  && (w.marks || []).some((m) => m.id === 'old-k1'), w && [w.type, Boolean(w.from), w.marks]);
T.ok('投递里有它的卡片图（标着原来是短批注）', Boolean(s5.meta && s5.meta.cards) && s5.meta.cards.some((k) => k.id === w.id && k.note === true), s5.meta && s5.meta.cards);
await waitPen();
{ const b = await js(`(() => { const g = document.querySelector('#aiRoot .badge[data-id="${w.id}"]'); if (!g) return null; const r = g.querySelector('circle').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (b) await T.fingerTapAt(b[0], b[1]); }
c = await card();
T.ok('点开这张卡片：底下有「摊在纸上」（以前这种卡片没有）', Boolean(c && c.spread) && c.id === w.id && c.spread.text === '摊在纸上' && c.spread.act === 'open' && !c.pop, c);
for (const [sel, name] of [['#acSpread', '摊在纸上'], ['#acShorter', '再短点'], ['#acLonger', '展开讲']]) {
  T.ok('长回答卡片的「' + name + '」看上去 32 高，上下各多出 6 像素能点', await hit44(sel));
}
await T.tap('#acSpread');
w = await js(`(() => { const a = window.__ink.S.page.ai.find((o) => o.text === ${JSON.stringify(NP)}); return a ? Object.assign(JSON.parse(JSON.stringify(a)), { open: window.__ink.isOpen(a) }) : null; })()`);
const openWords = await js(`[...document.querySelectorAll('#aiRoot > g[data-id="${w.id}"] text')].map((t) => t.textContent).join('')`);
T.ok('点「摊在纸上」：摊开了，纸上写的是原来那条批注的话；红字照旧在卡片上（没上纸）', w.open && openWords.includes(NP) && (w.marks || []).some((m) => m.id === 'old-k1')
  && !(await S(`S.page.strokes.some((s) => s.id === 'old-k1')`)), [w.open, openWords, w.marks]);
SHOTS.push(await T.shot('7-old-note-card-spread.png'));
c = await card();
T.ok('卡片的钮换成「收起」', Boolean(c && c.spread) && c.spread.text === '收起', c);
T.ok('「收起」换了名字，上下各多出 6 像素仍能点', await hit44('#acSpread'));
await T.tap('#acSpread');
T.ok('点「收起」：回到圈号', !(await js(`window.__ink.isOpen(window.__ink.S.page.ai.find((o) => o.id === ${JSON.stringify(w.id)}))`)) && (await badges()).includes(w.id));
await closeByTap();

// ================= 7. 放回纸上时四周都写满了：说一句，照旧是小蓝点（用数据铺满一页横线，只在这台的内存里，不存）
await T.openPage(0);
x2 = await note(NOTE2);
T.ok('（前提）第 1 页第二条还是小蓝点', x2.isDot);
const undoLen = await S('S.undo.length');
await js(`(() => { const S = window.__ink.S, now = Date.now(); for (let k = 0, y = S.Y0 + 4; y < 1400; y += 16, k++) S.page.strokes.push({ id: 'fill' + k, t0: now, w: 2.1,
  pts: [[S.X0 + 1, y, 0.5, 0], [S.TW - 1, y, 0.5, 30]] }); return 1; })()`);
c = await tapDot(x2);
await js('(window.__toasts = [], 1)');
await T.tap('#acSpread');
x2 = await note(NOTE2);
T.ok('四周写满了：说一句旁边没有空地方，照旧是小蓝点，撤销记录没多', x2.isDot && (await toastLog()).some((t) => t.startsWith('旁边没有空地方放回纸上')) && (await S('S.undo.length')) === undoLen,
  [x2.isDot, await toastLog(), await S('S.undo.length'), undoLen]);

console.error('截图：\n' + SHOTS.join('\n'));
T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

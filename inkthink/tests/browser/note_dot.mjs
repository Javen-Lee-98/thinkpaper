// 空白本子里短批注收成小蓝点（阶段 D1，《产品定义》第 3 节「短的回在原处」）：用户后来写的黑笔压到一条展开着的短批注，它自动收成
// 所指笔迹旁的一个小蓝点（没有数字；有数字的圈号是长回答）；点一下在旁边浮出来，点别处或落笔收回；不做手动收起。查：
// 1. 黑笔压到第一条：它收成小蓝点（数据里记着 dot：被哪一笔压到），点紧挨所指那句的右端、不压字；屏幕上方说一句；字没了，只剩一个点。
// 2. 手指点小蓝点：那条批注在旁边浮出来（一张窄的小卡片，原来那几行字，没有「问：」，和长回答的卡片样子不同），点上带一圈；
//    手指点别处：收回。笔点小蓝点：浮出来，这一点不留作笔迹；在别处落笔：收回，那一笔照常写上。
// 3. 红笔写在展开着的第二条上：不收（是批注、追问）。
// 4. 小蓝点浮出来时红笔写在上面：不收回，红字记在那条批注上（不上纸）；收回后点上带红点。黑笔落在浮出的小卡片上：收回，这一笔不留。
// 5. 黑笔压到第三条：也收成小蓝点。点「AI」：第一条（小卡片上写了红字）、第二条（纸上写了红字）都收成圈号变成卡片、连同红字交上去；
//    第一条的红字在卡片上和在小卡片上一样的位置（不错位）；第三条还是小蓝点。发给 Claude 的图里第三条是一个蓝点（原来那几行字那儿没有蓝字），
//    消息里说明了图里没有数字的小蓝点是什么、它的字在「之前写过的批注」里。圈号有数字、小蓝点没有，小蓝点比圈号小。
// 6. 橡皮碰到小蓝点：擦掉这条批注；撤销：回来。小蓝点旁画星号：采纳（深蓝带 ★）；撤销：收回。
// 7. 第 2 页：黑笔压到一条批注，它收成小蓝点；撤销这一笔：它展开回来。
// 8. 刷新后：小蓝点还是小蓝点、在原处，点开照样浮出来。英文界面：收成小蓝点时屏幕上方那句是英文。
// 笔是 pointerType 为 pen 的鼠标事件，手指是 CDP 的触摸事件；只在无头 Edge 里跑过，没在 iPad 上试过。
// 跑法：node tests/run_browser.mjs <临时目录> --only note_dot；有一项不对退出码 1。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'note-dot', pages: 2 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const waitPen = () => sleep(1150); // 笔刚用过的一秒内手指不算（手掌）
const line = (x0, y, len, n = 10) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 2]);
const meets = (p, q) => p[0] < q[2] && p[2] > q[0] && p[1] < q[3] && p[3] > q[1];
const seg = (pts, n = 8) => pts.slice(1).flatMap((b, k) => Array.from({ length: n }, (_, i) => [pts[k][0] + ((b[0] - pts[k][0]) * i) / n, pts[k][1] + ((b[1] - pts[k][1]) * i) / n])).concat([pts[pts.length - 1]]);
const star = (cx, cy, R = 22) => seg(Array.from({ length: 6 }, (_, k) => { const t = -Math.PI / 2 + (k * 4 * Math.PI) / 5; return [cx + R * Math.cos(t), cy + R * Math.sin(t)]; }), 10);
async function landed(n) {
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
const note = (text) => js(`(() => { const a = window.__ink.S.page.ai.find((o) => o.text === ${JSON.stringify(text)}); if (!a) return null;
  const g = document.querySelector('#aiRoot > g[data-id="' + a.id + '"]'), pt = g && g.querySelector('circle.pt'), r = pt && pt.getBoundingClientRect();
  return Object.assign(JSON.parse(JSON.stringify(a)), { tb: a.lay ? window.__ink.noteTextBox(a) : null, isDot: window.__ink.isDot(a), cls: g ? g.getAttribute('class') : '',
    words: g ? [...g.querySelectorAll('text:not(.adopt-star)')].map((t) => t.textContent) : [], star: Boolean(g && g.querySelector('.adopt-star')), red: Boolean(g && g.querySelector('.bdot')),
    dotScreen: r ? [r.left + r.width / 2, r.top + r.height / 2, r.width] : null }); })()`);
const strokes = () => S(`S.page.strokes.filter((s) => !s.erasedAt).map((s) => ({ id: s.id, c: s.c || '', b: [Math.min(...s.pts.map((p) => p[0])) - s.w, Math.min(...s.pts.map((p) => p[1])) - s.w, Math.max(...s.pts.map((p) => p[0])) + s.w, Math.max(...s.pts.map((p) => p[1])) + s.w] }))`);
const card = () => js(`(() => { const c = document.querySelector('#answerCard'); if (c.hidden) return null; const r = c.getBoundingClientRect(), S = window.__ink.S;
  const R = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  return { id: S.card && S.card.id, pop: c.classList.contains('note-pop'), l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, k: S.card && S.card.k, qHidden: document.querySelector('#acQ').hidden,
    bg: getComputedStyle(c).backgroundColor, border: getComputedStyle(c).borderTopStyle,
    lines: [...document.querySelectorAll('#acBody .ac-note text')].map((t) => Object.assign(R(t), { s: t.textContent })),
    marks: [...document.querySelectorAll('#acInk path:not(.live)')].map((p) => Object.assign(R(p), { id: p.dataset.id })) }; })()`);
const badges = () => js(`[...document.querySelectorAll('#aiRoot > .badge')].map((g) => { const c = g.querySelector('circle'), r = c.getBoundingClientRect();
  return { id: g.dataset.id, num: g.querySelector('.bdg text').textContent, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width }; })`);
const tapPaper = async () => { await waitPen(); const [x, y] = await T.screenOf(700, 1200); await T.fingerTapAt(x, y); };
const tapDot = async (text) => { await waitPen(); const n = await note(text); await T.fingerTapAt(n.dotScreen[0], n.dotScreen[1]); return card(); };
// 用笔在屏幕上（不是纸的坐标）画一笔：写在浮出的小卡片上
async function penScreen(pts, wait = 300) {
  const base = { pointerType: 'pen', button: 'left' };
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: pts[0][0], y: pts[0][1], buttons: 1, clickCount: 1 }, base));
  for (const p of pts.slice(1)) await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: p[0], y: p[1], buttons: 1 }, base));
  const l = pts[pts.length - 1];
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: l[0], y: l[1], buttons: 0, clickCount: 1 }, base));
  await sleep(wait);
}
const relTo = (m, ln, s) => [(m.l - ln.l) / s, (m.t - ln.t) / s, (m.r - ln.l) / s, (m.b - ln.t) / s];
const near = (a, b, d) => Boolean(a && b) && a.every((v, i) => Math.abs(v - b[i]) <= d);
const installLog = () => js(`(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (!t.hidden) window.__toasts.push(t.textContent); })
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true, attributes: true }); return 1; })()`);
const SHOTS = [];
const shot2 = async (file) => { const z = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 834, height: 1194, scale: 2 } });
  const f = join(T.OUT, file); writeFileSync(f, Buffer.from(z.data, 'base64')); SHOTS.push(f); return f; };
function pixels(file, box, type = 'jpeg') { // 一张图里一块（像素）里蓝色的点有多少
  const b64 = readFileSync(file).toString('base64');
  return js(`new Promise((res) => { const im = new Image(); im.onload = () => { const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const x = cv.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, im.width, im.height).data, bx = ${JSON.stringify(box)}; let blue = 0;
    for (let Y = Math.max(0, bx[1]); Y <= Math.min(im.height - 1, bx[3]); Y++) for (let X = Math.max(0, bx[0]); X <= Math.min(im.width - 1, bx[2]); X++) { const i = (Y * im.width + X) * 4;
      if (d[i + 2] - d[i] > 50 && d[i + 2] > 90) blue++; }
    res(blue); }; im.onerror = () => res(null); im.src = 'data:image/${type};base64,${b64}'; })`);
}
await installLog();
if (await S('S.flow')) { await js('window.__ink.toggleFlow()'); await sleep(600); }

// ================= 0. 三句红笔问题，Claude 回三条短批注（都落在右边）
await T.tool('red');
await T.pen(line(100, 200, 250));
await sleep(2000);
await T.pen(line(100, 400, 250));
await sleep(2000);
await T.pen(line(100, 600, 250));
await T.tool('pen');
await T.saved();
await T.tap('#check');
const sub1 = await T.waitSub('S1', 80), meta1 = sub1 && T.metaOf(sub1);
T.ok('（前提）交上去了：三句红笔问题', Boolean(meta1) && meta1.groups.length === 3, meta1 && meta1.groups);
const A1 = meta1.groups[0].bbox, A3 = meta1.groups[2].bbox;
const N1 = '先买菜再做饭', N2 = '米要淘两遍', N3 = '汤最后放盐';
await T.post('/bridge/reply', { sid: 'S1', submission: sub1.id, items: [{ type: 'note', anchor: 'g1', text: N1 }, { type: 'note', anchor: 'g2', text: N2 }, { type: 'note', anchor: 'g3', text: N3 }] });
T.ok('（前提）三条落下、写完了，都展开着', (await landed(3)) && [N1, N2, N3].every(Boolean) && !(await note(N1)).isDot && !(await note(N2)).isDot);

// ================= 1. 黑笔压到第一条（压住它右边那半）：收成小蓝点
let n1 = await note(N1);
await js('(window.__toasts = [], 1)');
await T.pen(line(n1.tb[0] + 40, (n1.tb[1] + n1.tb[3]) / 2, n1.tb[2] - n1.tb[0], 8));
const black1 = await S('S.page.strokes[S.page.strokes.length - 1].id');
n1 = await note(N1);
T.ok('黑笔压到第一条：它收成了小蓝点（dot 记着被哪一笔压到），类型还是短批注', n1.isDot && n1.dot.why === 'ink' && n1.dot.by === black1 && n1.type === 'note', n1);
T.ok('纸上那几行字没了，只剩一个点（没有数字）', n1.words.length === 0 && /ai-dot/.test(n1.cls) && Boolean(n1.dotScreen), n1);
let SB = await strokes();
const D1 = [n1.dot.at[0] - 10, n1.dot.at[1] - 10, n1.dot.at[0] + 10, n1.dot.at[1] + 10];
T.ok('小蓝点紧挨所指那句的右端、同一高度，不压字', n1.dot.at[0] - A1[2] > 8 && n1.dot.at[0] - A1[2] < 32 && Math.abs(n1.dot.at[1] - (A1[1] + A1[3]) / 2) < 6 && SB.every((s) => !meets(D1, s.b)), [n1.dot, A1]);
T.ok('屏幕上方说了一句：收成了小蓝点，点一下能看', (await js('window.__toasts')).includes('被字压到的批注收成了小蓝点，点一下能看'), await js('window.__toasts'));
T.ok('那一笔照常留在纸上', SB.some((s) => s.id === black1));
await T.waitFor(`document.querySelector('#toast').hidden`, 6000);
await shot2('1-dot-folded.png');

// ================= 2. 点小蓝点浮出来；点别处收回；笔点也行；在别处落笔收回
let C = await tapDot(N1);
T.ok('手指点小蓝点：那条批注在旁边浮出来（小卡片：原来那一行字，没有「问：」）', Boolean(C) && C.pop && C.id === n1.id && C.qHidden && C.lines.map((l) => l.s).join('|') === n1.lay.lines.join('|'), C);
T.ok('浮出来的小卡片和长回答的卡片分得开：窄（只有那几行宽）、浅黄底、虚线框', Boolean(C) && C.w < 300 && C.bg === 'rgb(255, 253, 246)' && C.border === 'dashed', C && [C.w, C.bg, C.border]);
n1 = await note(N1);
T.ok('小卡片紧挨着小蓝点；浮着的时候点上带一圈', Boolean(C) && /\bopen\b/.test(n1.cls) && Math.min(Math.abs(C.l - n1.dotScreen[0]), Math.abs(C.r - n1.dotScreen[0])) < 30
  && C.t < n1.dotScreen[1] + 40 && C.b > n1.dotScreen[1] - 40, [C, n1.dotScreen]);
await shot2('2-dot-open.png');
await tapPaper();
T.ok('手指点别处：收回（点上那一圈也没了）', !(await card()) && !/\bopen\b/.test((await note(N1)).cls));
const nS = (await strokes()).length;
await T.pen([[n1.dot.at[0], n1.dot.at[1]], [n1.dot.at[0] + 0.5, n1.dot.at[1] + 0.5]]);
C = await card();
T.ok('笔点一下小蓝点：浮出来，这一点不留作笔迹', Boolean(C) && C.id === n1.id && (await strokes()).length === nS, [C, (await strokes()).length, nS]);
await T.pen(line(120, 1300, 200));
T.ok('在别处落笔：收回，那一笔照常写上', !(await card()) && (await strokes()).length === nS + 1);
await T.tap('#toolsUndo');
T.ok('（前提）撤销掉那一笔', (await strokes()).length === nS);

// ================= 3. 红笔写在展开着的第二条上：不收
const n2 = await note(N2);
await T.tool('red');
await T.pen(line(n2.tb[0] + 4, n2.tb[1] + 22, 60));
const red2 = await S('S.page.strokes[S.page.strokes.length - 1].id');
T.ok('红笔写在展开着的第二条上：它不收（照旧是纸上的字），红字留在纸上', !(await note(N2)).isDot && (await note(N2)).words.length === 1 && (await strokes()).some((s) => s.id === red2));

// ================= 4. 小蓝点浮出来，红笔写在上面：不收回，红字记在这条批注上；黑笔落在小卡片上：收回、不留
C = await tapDot(N1);
const ln0 = C && C.lines[0];
await penScreen(line(ln0.l + 4, ln0.b + 3, Math.min(70, ln0.r - ln0.l - 8), 8));
C = await card();
n1 = await note(N1);
T.ok('红笔写在浮出的小卡片上：不收回，红字记在这条批注上（marks，最上面那块），纸上没有多出笔迹', Boolean(C) && C.id === n1.id && (n1.marks || []).length === 1
  && n1.marks[0].blk === 'a' && !n1.marks[0].req && Boolean(n1.popMap) && (await strokes()).length === nS + 1, [C && C.id, n1.marks, (await strokes()).length]);
const mk = n1.marks && n1.marks[0];
const relPop = C && C.marks.length === 1 ? relTo(C.marks[0], C.lines[0], C.k * n1.popMap.u) : null;
await T.tool('pen');
await penScreen(line(ln0.l + 4, ln0.b + 3, 40, 6));
T.ok('黑笔落在浮出的小卡片上：收回，这一笔不留（纸上、小卡片上都没有）', !(await card()) && (await strokes()).length === nS + 1 && ((await note(N1)).marks || []).length === 1);
T.ok('收回后小蓝点带红点（上面有还没交的红字）', (await note(N1)).red);

// ================= 5. 黑笔压到第三条；点「AI」：第一、二条变成卡片交上去，第三条还是小蓝点
let n3 = await note(N3);
await T.pen(line(n3.tb[0] + 40, (n3.tb[1] + n3.tb[3]) / 2, n3.tb[2] - n3.tb[0], 8));
n3 = await note(N3);
T.ok('黑笔压到第三条：也收成小蓝点', n3.isDot && n3.dot.why === 'ink');
await T.saved();
await T.tap('#check');
const sub2 = await T.waitSub('S1', 80), meta2 = sub2 && T.metaOf(sub2);
const w1 = await note(N1), w2 = await note(N2);
n3 = await note(N3);
T.ok('点「AI」：第一条（小卡片上写了红字）收成圈号、变成卡片，红字跟着，换算照小卡片的（fromMap 就是 popMap）', w1.type === 'write' && w1.from && w1.from.type === 'note'
  && (w1.marks || []).length === 1 && w1.marks[0].id === mk.id && JSON.stringify(w1.fromMap) === JSON.stringify(n1.popMap) && Number.isInteger(w1.n), w1);
T.ok('第二条（纸上写了红字）也变成了卡片', w2.type === 'write' && w2.from && (w2.marks || []).some((m) => m.id === red2), w2);
T.ok('第三条（没写红字）还是小蓝点', n3.isDot && n3.type === 'note', n3);
const cards2 = (meta2 && meta2.cards) || [];
T.ok('两张卡片连同红字交上去了（都标着原来是短批注）', cards2.length === 2 && cards2.every((c) => c.note === true) && cards2.some((c) => c.id === w1.id && JSON.stringify(c.marks) === JSON.stringify([mk.id])), cards2);
T.ok('消息里说明了图里没有数字的小蓝点是什么，第三条的字在「之前写过的批注」里', Boolean(sub2) && sub2.text.includes('图里没有数字的蓝色小圆点是收起来的短批注') && sub2.text.includes('- ' + N3), sub2 && sub2.text.slice(-700));
{ // 发给 Claude 的整页图：第三条那儿是一个蓝点，原来那几行字那儿没有蓝字
  const c = meta2.crop, img = join(T.DATA, 'submissions', sub2.id, 'crop.jpg'), px = (b) => [(b[0] - c.x0) * c.scale, (b[1] - c.y0) * c.scale, (b[2] - c.x0) * c.scale, (b[3] - c.y0) * c.scale].map(Math.round);
  const atDot = await pixels(img, px([n3.dot.at[0] - 6, n3.dot.at[1] - 6, n3.dot.at[0] + 6, n3.dot.at[1] + 6]));
  const atText = await pixels(img, px([Math.max(n3.tb[0], n3.dot.at[0] + 14), n3.tb[1], n3.tb[2], n3.tb[3]])); // 那几行字原来的地方（小蓝点挨着的那一小块除外）
  T.ok('发给 Claude 的图里第三条画成一个蓝点，原来那几行字那儿没有蓝字', atDot > 20 && atText < 15, [atDot, atText]);
}
// 圈号和小蓝点分得清
await sleep(600);
const B = await badges(), dot3 = (await note(N3)).dotScreen;
T.ok('圈号里有数字（两个），小蓝点没有数字、比圈号小', B.length === 2 && B.every((b) => /^\d+$/.test(b.num)) && (await note(N3)).words.length === 0 && dot3[2] < Math.min(...B.map((b) => b.w)) * 0.7,
  [B, dot3]);
await T.waitFor(`document.querySelector('#toast').hidden`, 6000);
await shot2('3-dot-and-badges.png');
// 第一条的卡片：红字相对那一行字的位置和在小卡片上时一样
await waitPen();
const b1 = B.find((b) => b.id === w1.id);
await T.fingerTapAt(b1.cx, b1.cy);
C = await card();
const relCard = C && C.marks.length === 1 ? relTo(C.marks[0], C.lines[0], C.k * w1.fromMap.u) : null;
T.ok('点开第一条的圈号：是长回答那种卡片（不是小卡片），原来那一行字和红字都在', Boolean(C) && !C.pop && C.lines.map((l) => l.s).join('|') === n1.lay.lines.join('|') && C.marks.length === 1, C);
T.ok('红字相对那一行字的位置和在小卡片上写的时候一样（差不到 1.5 个单位）', near(relCard, relPop, 1.5), [relPop, relCard]);
await tapPaper();

// ================= 6. 橡皮、撤销、采纳对小蓝点照常有用
n3 = await note(N3);
await T.tool('eraser');
await T.pen(line(n3.dot.at[0] - 6, n3.dot.at[1], 12, 4));
T.ok('橡皮碰到小蓝点：擦掉这条批注（点没了）', Boolean((await note(N3)).erasedAt) && !(await note(N3)).dotScreen, await note(N3));
await T.tap('#toolsUndo');
T.ok('撤销：小蓝点回来了', !(await note(N3)).erasedAt && Boolean((await note(N3)).dotScreen) && (await note(N3)).isDot);
await T.tool('red');
const nS2 = await S('S.page.strokes.length');
await T.pen(star(n3.dot.at[0] + 34, n3.dot.at[1]));
T.ok('小蓝点旁画星号：采纳（深蓝带 ★），这一笔不留', (await note(N3)).adopted === true && (await note(N3)).star && /adopted/.test((await note(N3)).cls) && (await S('S.page.strokes.length')) === nS2, await note(N3));
await T.tap('#toolsUndo');
T.ok('撤销：采纳收回', !(await note(N3)).adopted && !(await note(N3)).star);
await T.tool('pen');

// ================= 7. 第 2 页：黑笔压到一条批注，它收起；撤销这一笔，它展开回来
await T.openPage(1);
await T.tool('red');
await T.pen(line(100, 300, 250));
await T.tool('pen');
await T.saved();
await T.tap('#check');
const sub3 = await T.waitSub('S1', 80);
const N4 = '面条煮八分钟';
await T.post('/bridge/reply', { sid: 'S1', submission: sub3.id, items: [{ type: 'note', anchor: 'g1', text: N4 }] });
T.ok('（前提）第 2 页的批注落下了，展开着', (await landed(1)) && !(await note(N4)).isDot);
let n4 = await note(N4);
await T.pen(line(n4.tb[0] - 6, (n4.tb[1] + n4.tb[3]) / 2, n4.tb[2] - n4.tb[0] + 12, 8));
T.ok('黑笔压到：收成小蓝点', (await note(N4)).isDot);
await T.tap('#toolsUndo');
n4 = await note(N4);
T.ok('撤销这一笔：它展开回来（字又在纸上，没有 dot）', !n4.isDot && !n4.dot && n4.words.length === 1 && (await strokes()).length === 1, n4);
await T.saved();

// ================= 8. 刷新：小蓝点还是小蓝点、在原处，点开照样浮出来
await T.openPage(0);
const before = (await note(N3)).dot;
await T.saved();
await T.reload();
if (await S('S.idx') !== 0) await T.openPage(0);
n3 = await note(N3);
T.ok('刷新后：第三条还是小蓝点，在原处', n3.isDot && JSON.stringify(n3.dot.at) === JSON.stringify(before.at), [n3.dot, before]);
C = await tapDot(N3);
T.ok('刷新后点开：照样浮出来', Boolean(C) && C.pop && C.lines.map((l) => l.s).join('|') === n3.lay.lines.join('|'), C);
await tapPaper();
const disk = T.pageFile('scratch', 0), d3 = disk && disk.ai.find((a) => a.text === N3);
T.ok('页面文件里：收起的状态记在 dot 里，lay 照旧是那几行字的排版', Boolean(d3 && d3.dot) && d3.dot.why === 'ink' && d3.lay && d3.lay.lines.join() === N3, d3);

// 英文界面：收成小蓝点时那句提示是英文
await T.go('&lang=en');
await installLog();
if (await S('S.idx') !== 1) await T.openPage(1);
n4 = await note(N4);
await js('(window.__toasts = [], 1)');
await T.pen(line(n4.tb[0] - 6, (n4.tb[1] + n4.tb[3]) / 2, n4.tb[2] - n4.tb[0] + 12, 8));
const toasts = await js('window.__toasts');
T.ok('英文界面：收成小蓝点时屏幕上方那句是英文', (await note(N4)).isDot && toasts.includes('A note under your writing folded into a small blue dot. Tap it to read'), toasts);

console.error('截图：\n' + SHOTS.join('\n'));
T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

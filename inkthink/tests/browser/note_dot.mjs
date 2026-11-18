// 空白本子里短批注收成小蓝点（阶段 D1，《产品定义》第 3 节「短的回在原处」）：用户后来写的黑笔压到一条展开着的短批注，它自动收成
// 所指笔迹旁的一个小蓝点（没有数字；有数字的圈号是长回答）；点一下在旁边浮出来，点别处或落笔收回；也能手动放回纸上。查：
// 1. 黑笔压到第一条：它收成小蓝点（数据里记着 dot：被哪一笔压到），点紧挨所指那句的右端、不压字；屏幕上方说一句；字没了，只剩一个点。
// 2. 手指点小蓝点：那条批注在旁边浮出来（一张窄的小卡片，原来那几行字，没有「问：」，和长回答的卡片样子不同），点上带一圈；
//    手指点别处：收回。笔点小蓝点：浮出来，这一点不留作笔迹；在别处落笔：收回，那一笔照常写上。
// 3. 红笔写在展开着的第二条上：不收（是批注、追问）。
// 4. 红笔、黑笔落在浮出的小卡片里都收回。另放入一笔旧版小卡片里的红字，检查它还能照旧交出去。
// 5. 交稿后旧红字在卡片里不错位；写在第二条上的红字仍在纸上，消息写明批的是哪条蓝字。
//    第三条仍是蓝点，整页图画出点，消息附上原文。圈号有数字，比蓝点大。
//    旧卡片还能接着回；再写一笔红字交稿，只交没答过的那笔。
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

// 红笔和黑笔分别落在浮出的小卡片里：收回，两边都不多一笔。
for (const [tool, name] of [['red', '红笔'], ['pen', '黑笔']]) {
  await T.tool(tool);
  C = await tapDot(N1);
  const ln = C.lines[0];
  await penScreen(line(ln.l + 4, ln.b - 2, Math.min(70, ln.r - ln.l - 8), 8));
  n1 = await note(N1);
  T.ok(name + '落在小卡片的字上，卡片收回，纸上和卡片里都没多一笔', !(await card()) && n1.isDot && !n1.marks?.length && !n1.red && (await strokes()).length === nS + 1);
}

// 旧版允许在小卡片上写红字。给第一条放入那时存下的换算和笔迹，保留红点、投递和位置的兼容检查。
await js(`(() => { const a = window.__ink.S.page.ai.find((o) => o.id === ${JSON.stringify(n1.id)});
  a.popMap = { x0: a.lay.x - 6, y0: a.lay.y - 6, w: a.lay.w + 12, h: a.lay.h + 46, u: 1 };
  a.marks = [{ id: 'old-red', blk: 'a', c: 'r', w: 2, t0: Date.now(), pts: [[26, 30, .5, 0], [58, 32, .5, 40], [84, 30, .5, 80]] }];
})()`);
C = await tapDot(N1);
n1 = await note(N1);
const mk = n1.marks[0];
const relPop = C?.marks.length === 1 ? relTo(C.marks[0], C.lines[0], C.k * n1.popMap.u) : null;
T.ok('旧红字能在小卡片里看到', Boolean(relPop) && C.marks[0].id === mk.id);
await tapPaper();
T.ok('收回后小蓝点带红点（旧红字还没交）', (await note(N1)).red);

// 黑笔压到第三条；交稿后只有带旧红字的第一条变成卡片。
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
const on = meta2?.groups.find((g) => g.ids.includes(red2));
T.ok('第二条的蓝字和红笔仍在纸上，消息标明红笔写在这条蓝字上', w2.type === 'note' && !w2.isDot && w2.words.join('') === N2
  && (await strokes()).some((s) => s.id === red2 && s.c === 'r') && on?.red && !on.answered && on.note_on === N2
  && sub2.text.split('\n').some((l) => l.startsWith(on.id + '｜') && l.includes('写在蓝字批注「' + N2 + '」上')), on);
T.ok('第三条（没写红字）还是小蓝点', n3.isDot && n3.type === 'note', n3);
const cards2 = (meta2 && meta2.cards) || [];
T.ok('只交第一条旧卡片和它的红字（标着原来是短批注）', cards2.length === 1 && cards2.every((c) => c.note === true) && cards2.some((c) => c.id === w1.id && JSON.stringify(c.marks) === JSON.stringify([mk.id])), cards2);
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
T.ok('只有旧卡片有圈号，里面有数字；小蓝点没有数字、比圈号小', B.length === 1 && B.every((b) => /^\d+$/.test(b.num)) && (await note(N3)).words.length === 0 && dot3[2] < Math.min(...B.map((b) => b.w)) * 0.7,
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

// 旧卡片里的红字仍按卡片追问。这里接着用刚交过的旧数据，查看过的圈号也应重新提示有回应。
const oldQ = '为什么先买菜', oldReply = '先备齐食材。';
await js(`(() => {
  window.__hops = [];
  new MutationObserver(() => {
    for (const g of document.querySelectorAll('#aiRoot > .badge.fresh')) {
      const cs = getComputedStyle(g.querySelector('.bdg'));
      window.__hops.push([g.dataset.id, cs.animationName, cs.animationIterationCount]);
    }
  }).observe(document.querySelector('#aiRoot'), { childList: true, subtree: true });
})()`);
await T.post('/bridge/reply', { sid: 'S1', submission: sub2.id, items: [{ type: 'write', card: w1.n, q: oldQ, text: oldReply }] });
T.ok('旧卡片上的红字得到回应，还是原来的圈号', await T.waitFor(`window.__ink.S.page.ai.find((a) => a.id === ${JSON.stringify(w1.id)})?.more?.length === 1`, 10000)
  && (await badges()).length === 1);
const replied = await note(N1);
T.ok('旧卡片的原文和红字还在，新段记着回答的是哪一笔', replied.text === N1 && replied.marks[0].req === sub2.id && replied.more?.[0]?.q === oldQ
  && replied.more[0].text === oldReply && replied.more[0].on.join() === mk.id);
T.ok('旧圈号变回实心、跳两下，屏幕上方提示收到回应', !replied.seen && (await js('window.__hops')).some(([id, anim, count]) => id === w1.id && anim === 'badgeHop' && count === '2')
  && (await js('window.__toasts')).includes('Claude 回了 1 条'));
await T.saved();
await T.reload();
n1 = await note(N1);
const oldBadge = (await badges()).find((b) => b.id === w1.id);
await T.fingerTapAt(oldBadge.cx, oldBadge.cy);
await js("document.querySelector('#answerCard').scrollTop = 0");
C = await card();
T.ok('刷新后旧卡片仍显示原话、红字和接着的回应，红字位置没变', !C.pop && C.lines.map((l) => l.s).join('|') === n1.from.lay.lines.join('|')
  && C.marks.length === 1 && near(relTo(C.marks[0], C.lines[0], C.k * n1.fromMap.u), relPop, 1.5)
  && (await js("document.querySelector('#acMore .ac-mq').textContent")) === '红字：' + oldQ);
await T.tool('red');
const atReply = await js(`(() => { const ln = document.querySelector('#acMore .ac-mbody .ac-line'); ln.scrollIntoView({ block: 'center' });
  const r = ln.getBoundingClientRect(); return [r.left + 8, (r.top + r.bottom) / 2]; })()`);
await penScreen(line(atReply[0], atReply[1], 55));
const nextMark = (await note(N1)).marks.at(-1);
T.ok('接着写在回应上的一笔归在新段，还没有交', nextMark.id !== mk.id && nextMark.blk === replied.more[0].id && !nextMark.req);
await tapPaper();
await T.tool('pen');
await T.saved();
await T.tap('#check');
const nextSub = await T.waitSub('S1', 80), nextCards = nextSub && T.metaOf(nextSub).cards;
T.ok('再交旧卡片，只交新写的那一笔，消息里保留原文和上一段回应', nextCards?.length === 1 && nextCards[0].id === w1.id && nextCards[0].note
  && nextCards[0].marks.join() === nextMark.id && nextSub.text.includes('圈号 ' + w1.n + '（原来是短批注）：' + N1)
  && nextSub.text.includes('接着（回应红字「' + oldQ + '」）：' + oldReply));

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

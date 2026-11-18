// 长回答（2026-11-13）：纸上只留一个圈号，点开是浮出的卡片。查：
// （2026-11-17 起空白本子里不太长、旁边有空的长回答会摊在纸上：这里的长回答都带 fold: true，查的是收着（圈号）的样子；摊开的见 open_answer.mjs）
// 圈号落在所答笔迹右边、不压东西（没指明答哪句时落在这一轮最后一句红笔问题旁边，没有红笔问题才落在最后写的那组旁边）；没看过实心、看过空心；到达时跳两下、不自己打开、上方说一句；
// 点圈号（手指、笔）开卡片：紧挨圈号、整个在屏幕里、靠右下时翻过去，宽高有限、内容能滑、「问：」那行、KaTeX 公式、之前的版本；
// 点别处 / 落笔（那一笔照常写上）/ 挪纸 / 缩放 / 翻页 / 开抽屉都收起（笔刚用过一秒内落在纸上的手指当手掌，不收），再点同一个圈号是收起；笔点圈号不留笔迹；
// 橡皮擦掉圈号、撤销找回；红笔问题擦掉后圈号还在、还能点开；编号（擦掉的也占着号）；星号采纳；
// 存盘是新格式、刷新后还在、看过的记住了；连续模式下回在看得见的相邻页上的直接落下；
// 发给 Claude 的图里只有圈号、没有回答文字，下一次点「AI」的消息里有「圈号 1（问：…）」；往来稿里多出「第 N 页的回答」。
// 跑法：node tests/browser/answer_card.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, PY, sleep } from '../browser_lib.mjs';

const PAPER = join(process.argv[2] || join(tmpdir(), 'inkthink-browser-tests'), 'answer-card', 'paper');
const T = await boot({ name: 'answer-card', pages: 2, config: { paper_dir: PAPER, paper_delay: 0.5 } });
const js = T.evalJS;

// ---- 看页面的小工具
// 页面数据里的长回答（i 不给就是当前页；连续阅读时相邻页从缓存里取）
const answers = (i) => js(`(() => { const S = window.__ink.S, pg = ${i === undefined ? 'S.page' : `(${i} === S.idx ? S.page : (S.flowCache.get(${i}) || {}).page)`};
  return pg ? pg.ai.filter((a) => a.type === 'write') : null; })()`);
// 批注层上画出来的圈号：屏幕上的圆心、半径，颜色，数字
const badges = () => js(`[...document.querySelectorAll('#aiRoot .badge')].map((g) => { const c = g.querySelector('circle'), r = c.getBoundingClientRect(), t = g.querySelector('.bdg text');
  return { id: g.dataset.id, nbr: g.classList.contains('nbr-badge'), seen: g.classList.contains('seen'), adopted: g.classList.contains('adopted'), cx: r.left + r.width / 2, cy: r.top + r.height / 2, rr: r.width / 2,
    fill: getComputedStyle(c).fill, stroke: getComputedStyle(c).stroke, tfill: getComputedStyle(t).fill, num: t.textContent }; })`);
const badge = async (id) => (await badges()).find((b) => b.id === id);
// 卡片：屏幕上的位置和大小、能不能滑、里面写了什么、样子
const card = () => js(`(() => { const c = document.querySelector('#answerCard'); if (c.hidden) return null; const r = c.getBoundingClientRect(), cs = getComputedStyle(c);
  const q = document.querySelector('#acQ'), tex = c.querySelector('.ac-tex .katex'), older = document.querySelector('#acOlder');
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, sh: c.scrollHeight, ch: c.clientHeight, st: c.scrollTop,
    q: q.hidden ? null : q.textContent, qOpacity: Number(getComputedStyle(q).opacity), body: document.querySelector('#acBody').textContent, font: cs.fontFamily, color: cs.color, bg: cs.backgroundColor,
    border: cs.borderTopWidth, shadow: cs.boxShadow, tex: tex ? tex.getBoundingClientRect().width : 0,
    older: older.hidden ? null : { text: older.textContent, line: getComputedStyle(older).borderTopStyle + ' ' + getComputedStyle(older).borderTopWidth },
    vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight }; })()`);
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const strokeCount = () => S(`S.page.strokes.length`); // 连擦掉的也算
const seg = (pts, n = 8) => pts.slice(1).flatMap((b, k) => Array.from({ length: n }, (_, i) => [pts[k][0] + ((b[0] - pts[k][0]) * i) / n, pts[k][1] + ((b[1] - pts[k][1]) * i) / n])).concat([pts[pts.length - 1]]);
const star = (cx, cy, R = 22) => seg(Array.from({ length: 6 }, (_, k) => { const t = -Math.PI / 2 + (k * 4 * Math.PI) / 5; return [cx + R * Math.cos(t), cy + R * Math.sin(t)]; }), 10);
// 屏幕坐标 → 当前页的页面坐标
const worldOf = (x, y) => js(`(() => { const S = window.__ink.S, r = document.querySelector('#stage').getBoundingClientRect(); return [(${x} - r.left - S.view.tx) / S.view.s, (${y} - r.top - S.view.ty) / S.view.s]; })()`);
const fingerDrag = async (x, y, dx, dy) => {
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 5 }] });
  for (let k = 1; k <= 10; k++) { await T.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * k) / 10, y: y + (dy * k) / 10, id: 5 }] }); await sleep(16); }
  await sleep(300);
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
};
const waitPen = () => sleep(1150); // 笔刚用过的一秒内手指不算（手掌）
// 记下这段时间里屏幕上方出过的提示、刚出现的圈号（跳没跳）
await js(`(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (!t.hidden) window.__toasts.push(t.textContent); })
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true, attributes: true });
  window.__fresh = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType !== 1) continue;
    for (const g of [n, ...n.querySelectorAll('*')]) if (g.classList && g.classList.contains('badge') && g.classList.contains('fresh')) {
      const b = g.querySelector('.bdg'), cs = getComputedStyle(b); window.__fresh.push({ id: g.dataset.id, anim: cs.animationName, n: cs.animationIterationCount, nbr: g.classList.contains('nbr-badge') }); } } })
  .observe(document.querySelector('#aiRoot'), { childList: true, subtree: true }); return 1; })()`);
const resetLog = () => js(`(window.__toasts = [], window.__fresh = [], 1)`);
const log = () => js(`({ toasts: window.__toasts, fresh: window.__fresh })`);
// 发给 Claude 的那张图里，一块地方（页面坐标的框）有多少蓝色的点；不给框就是整张图里不在 allowed 这些框里的蓝点
function bluePixels(sub, boxes, allowed) {
  const k = T.metaOf(sub).crop, jpg = readFileSync(join(T.DATA, 'submissions', sub.id, 'crop.jpg')).toString('base64');
  const px = (b) => [b[0] - k.x0, b[1] - k.y0, b[2] - k.x0, b[3] - k.y0].map((v) => v * k.scale);
  return js(`new Promise((res) => { const im = new Image(); im.onload = () => { const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const x = cv.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, im.width, im.height).data, blue = (i) => d[i + 2] - d[i] > 50 && d[i + 2] > 90, boxes = ${JSON.stringify(boxes.map(px))}, ok = ${JSON.stringify((allowed || []).map(px))};
    const inside = (b, X, Y) => X >= b[0] && X <= b[2] && Y >= b[1] && Y <= b[3];
    const counts = boxes.map(() => 0); let stray = 0;
    for (let Y = 0; Y < im.height; Y++) for (let X = 0; X < im.width; X++) { const i = (Y * im.width + X) * 4; if (!blue(i)) continue;
      let hit = false; boxes.forEach((b, j) => { if (inside(b, X, Y)) { counts[j]++; hit = true; } }); if (!hit && !ok.some((b) => inside(b, X, Y))) stray++; }
    res({ counts, stray }); }; im.onerror = () => res(null); im.src = 'data:image/jpeg;base64,${jpg}'; })`);
}
const bbox = (meta, id) => meta.groups.find((g) => g.id === id).bbox;
const mid = (b) => (b[1] + b[3]) / 2;

// ================= 1. 第 1 页：红笔问题 g1，黑字 g2，红笔问题 g3，紧挨着 g3 右边一小段黑字 g4（圈号要让开它）。交上去
await T.tap('#tools [data-tool=red]');
await T.pen(T.line(120, 200, 300));
await T.tap('#tools [data-tool=pen]');
await T.pen(T.line(120, 320, 300));
await T.tap('#tools [data-tool=red]');
await T.pen(T.line(120, 440, 300));
await T.tap('#tools [data-tool=pen]');
await T.pen(T.line(440, 440, 40, 5));
await T.tap('#check');
const sub1 = await T.waitSub('S1'), meta1 = sub1 && T.metaOf(sub1);
T.ok('交上去了：四组，g1、g3 是红笔', Boolean(meta1) && meta1.groups.length === 4 && meta1.groups[0].red && meta1.groups[2].red && !meta1.groups[3].red, meta1 && meta1.groups);

// ================= 2. Claude 回两条长回答（指着 g1、g3）和一条短批注：圈号落下，不上纸排版文字，不自己打开
const LONG = ['先说结论：总价和买的斤数成正比。', '$$y = k \\bar{x}$$', '']
  .concat(Array.from({ length: 30 }, (_, k) => `第 ${k + 1} 条理由：单价不变时，买得越多花得越多，和在哪家店买无关（只要价格一样）。`)).join('\n');
await resetLog();
const rep1 = await T.post('/bridge/reply', { sid: 'S1', submission: sub1.id, items: [
  { type: 'write', fold: true, anchor: 'g1', q: '为什么是线性的？', text: LONG },
  { type: 'write', fold: true, anchor: 'g3', q: '单位对吗？', text: '对，单位是千克。' },
  { type: 'note', anchor: 'g2', text: '短批注' }] });
T.ok('服务收下了 3 条', rep1.ok === true && rep1.count === 3, rep1);
T.ok('3 条落到这一页', await T.waitFor(`window.__ink.S.page.ai.length === 3`, 10000), await S(`S.page.ai.map((a) => a.type)`));
await sleep(300);
let A = await answers();
const [w1, w2] = A, g1 = bbox(meta1, 'g1'), g3 = bbox(meta1, 'g3'), g4 = bbox(meta1, 'g4');
T.ok('两条长回答：圈号 1、2，都没看过', A.length === 2 && w1.n === 1 && w2.n === 2 && !w1.seen && !w2.seen, A.map((a) => [a.n, a.seen]));
T.ok('圈号 1 在所答的 g1 右端外侧（离字约 16）、和那一行一样高', Math.abs(w1.at[0] - (g1[2] + 16 + 13)) < 2.5 && Math.abs(w1.at[1] - mid(g1)) < 2, [w1.at, g1]);
T.ok('圈号 2：g3 右边紧挨着有黑字 g4，往右让开、不压它，还在那一行', w2.at[0] - 13 >= g4[2] && w2.at[0] < g4[2] + 60 && Math.abs(w2.at[1] - mid(g3)) < 2, [w2.at, g3, g4]);
T.ok('所答的笔迹记在 on 里', w1.on.length === 1 && w2.on.length === 1 && w1.on[0] === meta1.groups[0].ids[0] && w2.on[0] === meta1.groups[2].ids[0], [w1.on, w2.on]);
let B = await badges();
T.ok('纸上画了两个圈号，数字 1、2', B.length === 2 && B.map((b) => b.num).join() === '1,2', B);
T.ok('没看过的是实心：蓝底白字', B.every((b) => b.fill === 'rgb(47, 95, 174)' && b.tfill === 'rgb(255, 255, 255)'), B.map((b) => [b.fill, b.tfill]));
const sv = await S('S.view.s');
T.ok('圈号直径约 26 个页面单位', B.every((b) => Math.abs((b.rr * 2) / sv - 26) < 2), [B.map((b) => b.rr), sv]);
const paper = await js(`document.querySelector('#aiRoot').textContent + '|' + document.querySelector('#tex').textContent`);
T.ok('回答文字没有上纸（批注层和公式层里都没有）', !paper.includes('买的斤数') && !paper.includes('千克') && !paper.includes('单位对吗') && paper.includes('短批注'), paper.slice(0, 80));
T.ok('页面数据里没有排版（lay、hit 之类）', A.every((a) => !('lay' in a) && !('hit' in a) && !('paths' in a) && !('fold' in a)), A.map((a) => Object.keys(a)));
let L = await log();
T.ok('到达时两个圈号都跳了两下', L.fresh.filter((f) => f.anim === 'badgeHop' && f.n === '2').map((f) => f.id).sort().join() === [w1.id, w2.id].sort().join(), L.fresh);
T.ok('到了不自己打开卡片', (await card()) === null && !(await S('S.card')));
T.ok('屏幕上方说了一句「Claude 回了 2 条」', L.toasts.includes('Claude 回了 2 条') && (await js(`document.querySelector('#toast').getBoundingClientRect().top`)) < 200, L.toasts);

// ================= 3. 手指点圈号 2：卡片浮出来、记为看过；点别处收起，圈号 2 变空心（圈号 1 还是实心）
await waitPen();
let b2 = await badge(w2.id);
await T.fingerTapAt(b2.cx, b2.cy);
let C = await card();
T.ok('手指点圈号：卡片浮出来，顶上一行「问：单位对吗？」，下面是全文', Boolean(C) && C.q === '问：单位对吗？' && C.body === '对，单位是千克。', C);
T.ok('点开就记为看过', (await answers())[1].seen === true && !(await answers())[0].seen, (await answers()).map((a) => a.seen));
const [ex, ey] = [b2.cx - 200, b2.cy + 300];
await T.fingerTapAt(ex, ey);
T.ok('点纸上别处：卡片收起', (await card()) === null);
B = await badges();
T.ok('看过的圈号 2 变空心（白底蓝圈蓝字），没看过的圈号 1 还是实心', B[1].fill === 'rgb(255, 255, 255)' && B[1].stroke === 'rgb(47, 95, 174)' && B[1].tfill === 'rgb(47, 95, 174)'
  && B[0].fill === 'rgb(47, 95, 174)', B.map((b) => [b.num, b.fill, b.tfill]));
const SHOT1 = await T.shot('1-two-badges.png');
{ // 再截一张放大的：两个圈号那一块
  const r = await js(`(() => { const b = [...document.querySelectorAll('#aiRoot .badge circle')].map((c) => c.getBoundingClientRect()); return [b[0].left - 230, b[0].top - 30, b[1].right + 40, b[1].bottom + 30]; })()`);
  const z = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, r[0]), y: Math.max(0, r[1]), width: r[2] - Math.max(0, r[0]), height: r[3] - Math.max(0, r[1]), scale: 3 } });
  writeFileSync(join(T.OUT, '1-two-badges-zoom.png'), Buffer.from(z.data, 'base64'));
}

// ================= 4. 手指点圈号 1：长回答的卡片——位置、大小、能滑、「问：」、公式、样子
let b1 = await badge(w1.id);
await T.fingerTapAt(b1.cx, b1.cy);
C = await card();
T.ok('卡片紧挨圈号、在它右下方', Boolean(C) && Math.abs(C.l - (b1.cx + b1.rr + 6)) < 2.5 && Math.abs(C.t - (b1.cy - b1.rr * 0.4)) < 2.5, [C && [C.l, C.t], b1]);
T.ok('卡片整个在屏幕里', C.l >= 0 && C.t >= 0 && C.r <= C.vw && C.b <= C.vh, C);
T.ok('宽约半个屏幕（不超过 460 像素），最高半个屏幕', C.w <= 460 && Math.abs(C.w - Math.min(460, C.vw / 2)) < 2 && C.h <= C.vh / 2 + 1 && C.h > C.vh / 2 - 2, [C.w, C.h, C.vw, C.vh]);
T.ok('内容多：卡片里能上下滑（内容比卡片高）', C.sh > C.ch + 100, [C.sh, C.ch]);
T.ok('顶上一行较淡的「问：为什么是线性的？」', C.q === '问：为什么是线性的？' && C.qOpacity < 0.9, [C.q, C.qOpacity]);
T.ok('单独一行的 $$…$$ 用 KaTeX 排成了公式', C.tex > 30 && (await js(`Boolean(document.querySelector('#acBody .ac-tex .katex .mfrac, #acBody .ac-tex .katex .accent, #acBody .ac-tex .katex .mord'))`)) && !C.body.includes('$$'), [C.tex, C.body.slice(0, 60)]);
T.ok('全文都在（最后一条理由也在）', C.body.includes('第 30 条理由') && C.body.includes('先说结论'), C.body.slice(-40));
T.ok('蓝色手写体、白底、细框、轻微阴影', /Xiaolai/.test(C.font) && C.color === 'rgb(47, 95, 174)' && C.bg === 'rgb(255, 255, 255)' && C.border === '1px' && C.shadow !== 'none', [C.font, C.color, C.bg, C.border, C.shadow]);
// 2026-11-16 起卡片顶上有「上一条」「下一条」两个按钮（这一页有两条回答；怎么换见 card_nav.mjs）；2026-11-17 起底下一排
// 「摊在纸上」「再短点」「展开讲」（见 open_answer.mjs、answer_redo.mjs），别的按钮、输入框没有
T.ok('卡片上除了顶上的「上一条」「下一条」、底下一排「摊在纸上」「再短点」「展开讲」，没有别的按钮、没有输入框（在卡片上写红字见 card_marks.mjs）',
  (await T.count('#answerCard button:not(#acPrev):not(#acNext):not(#acSpread):not(#acShorter):not(#acLonger), #answerCard input, #answerCard textarea, #answerCard [contenteditable]')) === 0
  && (await T.text('#acActs')).replace(/\s+/g, '') === '摊在纸上再短点展开讲', await T.text('#acActs'));
const SHOT2 = await T.shot('2-card-open.png');
await T.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: C.l + C.w / 2, y: C.t + C.h / 2, deltaX: 0, deltaY: 400 });
await sleep(400);
const C2 = await card();
T.ok('在卡片里滑：卡片里的内容往上走，卡片还开着、纸面没动', Boolean(C2) && C2.st > 50, C2 && C2.st);
T.ok('点开过：圈号 1 也记为看过、变空心', (await answers())[0].seen === true && (await badge(w1.id)).fill === 'rgb(255, 255, 255)', await badge(w1.id));

// ================= 5. 什么时候收起：点别处、落笔（那一笔照常写上）、挪纸、缩放、翻页、开抽屉；再点同一个圈号是收起
const reopen = async () => { const b = await badge(w1.id); await T.fingerTapAt(b.cx, b.cy); return Boolean(await card()); };
await T.fingerTapAt(b1.cx - 150, b1.cy + 420);
T.ok('点别处：收起', (await card()) === null);
T.ok('再打开', await reopen());
const n5 = await strokeCount();
await T.pen(T.line(150, 700, 200));
T.ok('落笔：卡片收起，那一笔照常写上', (await card()) === null && (await strokeCount()) === n5 + 1 && (await S('S.page.strokes.at(-1).pts.length')) >= 5, [await strokeCount(), n5]);
await waitPen();
T.ok('再打开', await reopen());
const v5 = await S('S.view.ty');
await fingerDrag(300, 800, 0, -60);
T.ok('手指挪纸：卡片收起（纸挪了）', (await card()) === null && (await S('S.view.ty')) !== v5, [await S('S.view.ty'), v5]);
await T.openPage(0);
T.ok('再打开', await reopen());
const s5 = await S('S.view.s'), C5 = await card();
T.ok('（下一步的前提）滚轮落在卡片外面的纸上', Boolean(C5) && !(100 >= C5.l && 100 <= C5.r && 900 >= C5.t && 900 <= C5.b), C5);
await T.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 900, deltaX: 0, deltaY: 60, modifiers: 2 });
await sleep(300);
T.ok('缩放纸面（ctrl + 滚轮）：卡片收起', (await card()) === null && (await S('S.view.s')) !== s5, [await S('S.view.s'), s5]);
await T.openPage(0);
T.ok('再打开', await reopen());
await T.openPage(1);
T.ok('翻页：卡片收起', (await card()) === null && (await S('S.idx')) === 1);
await T.openPage(0);
T.ok('再打开', await reopen());
await T.tap('#nbChip');
T.ok('开抽屉：卡片收起', (await card()) === null && (await T.visible('#drawer')));
await T.tap('#nbChip');
T.ok('再打开', await reopen());
b1 = await badge(w1.id);
await T.fingerTapAt(b1.cx, b1.cy);
await sleep(300);
T.ok('卡片开着时再点同一个圈号：收起，不再打开', (await card()) === null);
await T.fingerTapAt(b1.cx, b1.cy);
T.ok('再点一次又打开', Boolean(await card()));

// ================= 6. 用笔点圈号：打开卡片，这一点不留笔迹；另一张卡片开着时换成这一张（一次只开一张）
await T.fingerTapAt(ex, ey);
b2 = await badge(w2.id);
await T.fingerTapAt(b2.cx, b2.cy);
T.ok('（前提）圈号 2 的卡片开着', ((await card()) || {}).q === '问：单位对吗？');
const n6 = await strokeCount();
const p1 = (await answers())[0].at;
await T.pen([[p1[0] + 1, p1[1]]]);
C = await card();
T.ok('笔点圈号 1：一次只开一张，换成圈号 1 的卡片', Boolean(C) && C.q === '问：为什么是线性的？' && (await T.count('#answerCard')) === 1, C && C.q);
T.ok('笔点圈号不留笔迹', (await strokeCount()) === n6, [await strokeCount(), n6]);

// ================= 7. 之前的版本（只有迁移来的旧数据带 older）：在下面加一条分隔线和「之前的版本」
await js(`(() => { const a = window.__ink.S.page.ai.find((o) => o.n === 1); a.older = [{ text: '旧的说法：和店家有关。', t: 1 }, { text: '更早的说法', t: 0 }]; return 1; })()`);
// 笔刚点过圈号（一秒内）落在纸上的手指当作手掌（2026-11-14：在卡片上写红字时手掌、手环会碰到纸），卡片不收；过了一秒再点才收
await T.fingerTapAt(ex, ey);
T.ok('笔刚用过（一秒内）手指点纸上别处：当作手掌，卡片不收', Boolean(await card()));
await waitPen();
await T.fingerTapAt(ex, ey);
T.ok('过了一秒再用手指点纸上别处：收起', (await card()) === null);
await waitPen();
b1 = await badge(w1.id);
await T.fingerTapAt(b1.cx, b1.cy);
C = await card();
T.ok('有之前的版本：下面一条分隔线、「之前的版本」，依次列出旧版', Boolean(C && C.older) && C.older.line === 'solid 1px' && /^之前的版本旧的说法：和店家有关。更早的说法$/.test(C.older.text), C && C.older);
await T.fingerTapAt(ex, ey);

// ================= 8. 再点「AI」：消息里有「圈号 1（问：…）：前 200 个字…」；发给 Claude 的图里圈号处有蓝色、没有回答文字
await T.saved();
await T.tap('#check');
const sub2 = await T.waitSub('S1'), meta2 = sub2 && T.metaOf(sub2);
T.ok('消息里写着之前的长回答：「圈号 1（问：为什么是线性的？）：…」「圈号 2（问：单位对吗？）：对，单位是千克。」', Boolean(sub2)
  && sub2.text.includes('- 圈号 1（问：为什么是线性的？）：先说结论：总价和买的斤数成正比。') && sub2.text.includes('- 圈号 2（问：单位对吗？）：对，单位是千克。')
  && sub2.text.includes('- 短批注') && !sub2.text.includes('第 30 条理由'), sub2 && sub2.text.slice(-500));
T.ok('平板交上去的「之前写过的批注」里，长回答带着圈号和问题', meta2.prev_notes.some((p) => p && p.n === 1 && p.q === '为什么是线性的？'), meta2.prev_notes);
A = await answers();
const note = await S(`(() => { const a = S.page.ai.find((o) => o.type === 'note'); return [a.lay.x - 8, a.lay.y - 6, a.lay.x + a.lay.w + 8, a.lay.y + a.lay.h + 6]; })()`);
const g2 = bbox(meta1, 'g2'), leader = [g2[2] - 10, mid(g2) - 30, 1030, mid(g2) + 30];
const bp = await bluePixels(sub2, A.map((a) => [a.at[0] - 16, a.at[1] - 16, a.at[0] + 16, a.at[1] + 16]), [note, leader]);
T.ok('发给 Claude 的图里两个圈号处都有蓝色', Boolean(bp) && bp.counts.every((c) => c > 40), bp);
T.ok('发给 Claude 的图里没有回答文字（圈号、短批注以外几乎没有蓝色）', Boolean(bp) && bp.stray < 20, bp);

// ================= 9. 连续模式：Claude 回在屏幕上看得见、但不是当前页的第 2 页上——直接落下，画出来，当前页不变
const D2 = await js(`window.__ink.flowStrip().find((n) => n.i === 1).D`);
await T.tap('#tools [data-tool=red]');
await T.pen(T.line(120, D2 + 150, 200));
await T.tap('#tools [data-tool=pen]');
T.ok('笔落在下面的第 2 页上：第 2 页成为当前页', (await S('S.idx')) === 1 && (await strokeCount()) === 1);
await T.tap('#check');
const sub3 = await T.waitSub('S1'), meta3 = sub3 && T.metaOf(sub3);
T.ok('只交了第 2 页', Boolean(meta3) && meta3.page === 1 && meta3.groups.length === 1, meta3 && [meta3.page, meta3.groups.length]);
await T.openPage(0);
const vis = await js(`Boolean(window.__ink.neighborOnScreen(1))`);
T.ok('回到第 1 页：第 2 页接在下面，屏幕上看得见', (await S('S.idx')) === 0 && vis);
const ty9 = await S('S.view.ty');
await resetLog();
await T.post('/bridge/reply', { sid: 'S1', submission: sub3.id, items: [{ type: 'write', fold: true, anchor: 'g1', q: '第二页的问题', text: '第二页的回答' }, { type: 'note', anchor: 'g1', text: '邻页短批注' }] });
const landed9 = await T.waitFor(`(window.__ink.S.flowCache.get(1) || { page: { ai: [] } }).page.ai.length === 2`, 10000);
await sleep(400);
L = await log();
const nb = (await badges()).filter((b) => b.nbr);
T.ok('第 2 页正显示在屏幕上：回复直接落到第 2 页（数据里有了），当前页还是第 1 页，屏幕没动', landed9 && (await S('S.idx')) === 0 && Math.abs((await S('S.view.ty')) - ty9) < 0.5, [landed9, await S('S.idx')]);
T.ok('第 2 页上的圈号画出来了、在屏幕上，跳了两下', nb.length === 1 && nb[0].num === '1' && nb[0].cy > 0 && nb[0].cy < (await js('innerHeight')) && L.fresh.some((f) => f.nbr && f.anim === 'badgeHop'), [nb, L.fresh]);
T.ok('提示「Claude 回了 1 条」，没有说「在别的页」', L.toasts.includes('Claude 回了 1 条') && !L.toasts.some((t) => t.includes('别的页')), L.toasts);
let disk2 = null;
for (let k = 0; k < 30 && !(disk2 && disk2.ai.length === 2); k++) { await sleep(250); disk2 = await T.apiJson('/api/page?nb=scratch&i=1'); }
T.ok('第 2 页的页面文件里存上了这两条（短批注也落下了）', Boolean(disk2) && disk2.ai.map((a) => a.type).sort().join() === 'note,write', disk2 && disk2.ai.map((a) => a.type));
await waitPen();
await T.fingerTapAt(nb[0].cx, nb[0].cy);
C = await card();
T.ok('手指点第 2 页上的圈号：第 2 页成为当前页，卡片打开', (await S('S.idx')) === 1 && Boolean(C) && C.q === '问：第二页的问题' && C.body === '第二页的回答', [await S('S.idx'), C && C.q]);
await T.fingerTapAt(100, 300);

// ================= 10. 圈号靠屏幕右下角：卡片翻到左边、上边，仍整个在屏幕里
const vh = await js('innerHeight'), [qx0, qy] = await worldOf(665, vh - 95), [qx1] = await worldOf(725, vh - 95);
await T.tap('#tools [data-tool=red]');
await T.pen(T.line(qx0, qy, qx1 - qx0));
await T.tap('#tools [data-tool=pen]');
await T.tap('#check');
const sub4 = await T.waitSub('S1'), meta4 = sub4 && T.metaOf(sub4);
const gq = meta4 && meta4.groups.find((g) => g.bbox[0] > qx0 - 20);
T.ok('第 2 页右下方那句红笔交上去了', Boolean(gq) && meta4.page === 1, meta4 && meta4.groups);
await T.post('/bridge/reply', { sid: 'S1', submission: sub4.id, items: [{ type: 'write', fold: true, anchor: gq.id, q: '靠右下角的问题', text: LONG }] });
await T.waitFor(`window.__ink.S.page.ai.filter((a) => a.type === 'write').length === 2`, 10000);
await sleep(300);
const w4 = (await answers()).find((a) => a.q === '靠右下角的问题');
await waitPen();
const b4 = await badge(w4.id);
await T.fingerTapAt(b4.cx, b4.cy);
C = await card();
T.ok('圈号靠屏幕右边和底边（前提）', Boolean(b4) && b4.cx > C.vw * 0.75 && b4.cy > C.vh * 0.85, [b4, C && [C.vw, C.vh]]);
T.ok('右边放不下：卡片翻到圈号左边（右沿对着圈号）', Boolean(C) && Math.abs(C.r - (b4.cx + b4.rr)) < 2 && C.l < b4.cx - 200, C && [C.l, C.r, b4.cx]);
T.ok('下面也放不下：卡片翻到上边，紧挨着圈号那一行的上面', C.b <= b4.cy - b4.rr && C.b > b4.cy - b4.rr - 12, [C.t, C.b, b4.cy]);
const q4 = [...(await T.screenOf(gq.bbox[0], gq.bbox[1])), ...(await T.screenOf(gq.bbox[2], gq.bbox[3]))];
T.ok('翻过去的卡片不盖住所答的那句红笔', q4[1] >= C.b || q4[3] <= C.t || q4[0] >= C.r || q4[2] <= C.l, [q4, [C.l, C.t, C.r, C.b]]);
T.ok('翻过去以后整个在屏幕里', C.l >= 0 && C.t >= 0 && C.r <= C.vw && C.b <= C.vh, C);
const SHOT3 = await T.shot('3-card-flipped.png');
await T.fingerTapAt(100, 300);

// ================= 11. 回到第 1 页：橡皮擦圈号、撤销找回；擦掉红笔问题后圈号还在、还能点开；编号（擦掉的也占着号）
await T.openPage(0);
const at2 = (await answers())[1].at;
await T.tap('#tools [data-tool=eraser]');
await T.pen([[at2[0] - 2, at2[1]], [at2[0] + 2, at2[1] + 1]]);
A = await answers();
T.ok('橡皮碰到圈号 2：这条回答擦掉了，纸上不画', A[1].erasedAt > 0 && !(await badge(A[1].id)) && Boolean(await badge(A[0].id)), A.map((a) => a.erasedAt || 0));
T.ok('别的不动：笔迹没擦', (await S('S.page.strokes.filter((s) => s.erasedAt).length')) === 0);
await T.tap('#toolsUndo');
T.ok('撤销：圈号 2 回来了', !(await answers())[1].erasedAt && Boolean(await badge(A[1].id)));
// 擦掉红笔问题 g1（圈号 1 回答的那句）
const at1 = (await answers())[0].at;
await T.pen(T.line(125, 200, 290, 12));
T.ok('红笔问题 g1 擦掉了', (await S(`S.page.strokes.filter((s) => s.erasedAt).length`)) === 1 && (await S(`S.page.strokes.find((s) => s.erasedAt).c`)) === 'r');
const after1 = (await answers())[0];
T.ok('所答的红笔问题擦掉后：圈号 1 还在原处', !after1.erasedAt && after1.at.join() === at1.join() && Boolean(await badge(after1.id)), after1);
await T.tap('#tools [data-tool=pen]');
await waitPen();
b1 = await badge(after1.id);
await T.fingerTapAt(b1.cx, b1.cy);
C = await card();
T.ok('照样能点开，顶上的「问：」还在', Boolean(C) && C.q === '问：为什么是线性的？', C && C.q);
await T.fingerTapAt(ex, ey);
// 擦掉圈号 1（不撤销），再来一条：编号是 3
await T.tap('#tools [data-tool=eraser]');
await T.pen([[at1[0] - 2, at1[1]], [at1[0] + 2, at1[1] + 1]]);
await T.tap('#tools [data-tool=pen]');
T.ok('圈号 1 擦掉了', (await answers())[0].erasedAt > 0);
await resetLog();
await T.post('/bridge/reply', { sid: 'S1', submission: sub2.id, items: [{ type: 'note', anchor: 'g2', text: '只有一条短的' }] });
await T.waitFor(`window.__ink.S.page.ai.some((a) => a.text === '只有一条短的')`, 10000);
await sleep(500);
T.ok('这一次只有短批注、没有长回答：不说「Claude 回了 N 条」', !(await log()).toasts.some((t) => /Claude 回了/.test(t)), (await log()).toasts);
await T.post('/bridge/reply', { sid: 'S1', submission: sub2.id, items: [{ type: 'write', fold: true, anchor: 'g2', text: '第三条回答' }] });
await T.waitFor(`window.__ink.S.page.ai.filter((a) => a.type === 'write').length === 3`, 10000);
A = await answers();
T.ok('两条回答是 1、2；擦掉 1 之后再来一条是 3（擦掉的也占着号）', A.map((a) => a.n).join() === '1,2,3' && A[0].erasedAt > 0, A.map((a) => [a.n, a.erasedAt || 0]));
T.ok('没有问题原文的回答：卡片顶上没有「问：」那行', await (async () => { await waitPen(); const b = await badge(A[2].id); await T.fingerTapAt(b.cx, b.cy); const c = await card(); await T.fingerTapAt(ex, ey); return Boolean(c) && c.q === null && c.body === '第三条回答'; })());

// ================= 12. 星号采纳：在圈号旁画星号＝采纳这条回答（深蓝），撤销收回
const s2 = (await answers())[1].at, n12 = await strokeCount();
await T.pen(star(s2[0] + 48, s2[1]));
let b12 = await badge(A[1].id);
T.ok('在圈号 2 旁画星号：采纳，圈号变深蓝（看过的：深蓝圈深蓝字），星号那一笔不留', (await answers())[1].adopted === true && b12.adopted && b12.stroke === 'rgb(31, 61, 122)' && b12.tfill === 'rgb(31, 61, 122)'
  && (await strokeCount()) === n12, [b12, await strokeCount(), n12]);
await T.tap('#toolsUndo');
b12 = await badge(A[1].id);
T.ok('撤销：不再是采纳', !(await answers())[1].adopted && !b12.adopted && b12.stroke === 'rgb(47, 95, 174)', b12);

// ================= 13. 存盘是新格式；刷新后还在，看过的记住了
T.ok('存上了', await T.saved());
await sleep(500);
const disk = T.pageFile('scratch', 0).ai.filter((a) => a.type === 'write');
// author：是哪个对话写的（2026-11-17 起，见 authors.mjs）
const OK = new Set(['id', 'type', 't', 'req', 'text', 'q', 'on', 'n', 'at', 'seen', 'older', 'adopted', 'erasedAt', 'dismissed', 'author']);
T.ok('页面文件里的长回答只有新格式的字段（没有 lay、hit、fold、shut、notes、revises、dock、placed……）', disk.length === 3 && disk.every((a) => Object.keys(a).every((k) => OK.has(k))
  && ['id', 't', 'req', 'text', 'on', 'n', 'at', 'seen'].every((k) => k in a)), disk.map((a) => Object.keys(a)));
T.ok('文件里记着圈号、位置、看过没有', disk.map((a) => `${a.n}:${a.seen}`).join() === '1:true,2:true,3:true' && disk.every((a) => Array.isArray(a.at) && a.at.length === 2), disk.map((a) => [a.n, a.at, a.seen]));
await T.reload();
B = (await badges()).filter((b) => !b.nbr);
T.ok('刷新后：没擦掉的两个圈号还在原处，擦掉的那个不画', B.map((b) => b.num).join() === '2,3' && JSON.stringify((await answers()).map((a) => a.at)) === JSON.stringify(disk.map((a) => a.at)), B.map((b) => b.num));
T.ok('刷新后：看过的记住了（空心）', B.every((b) => b.seen && b.fill === 'rgb(255, 255, 255)'), B.map((b) => [b.num, b.seen, b.fill]));

// ================= 14. 往来稿：纸面只有圈号，紧跟着「第 N 页的回答」，按圈号列出问和全文；把那一页渲染成 PNG
const PDF = join(PAPER, '草稿本', '往来.pdf');
const pdfText = () => (existsSync(PDF) ? JSON.parse(execFileSync(PY, ['-c', 'import pymupdf as fitz,sys,json; d=fitz.open(sys.argv[1]); print(json.dumps([p.get_text() for p in d]))', PDF]).toString('utf8')) : []);
let pt = [];
for (let k = 0; k < 40; k++) { try { pt = pdfText(); } catch (e) { pt = []; } if (pt.some((t) => t.startsWith('第 2 页的回答')) && pt.some((t) => t.includes('第三条回答'))) break; await sleep(500); }
const ia = pt.findIndex((t) => t.startsWith('第 1 页的回答')), ib = pt.findIndex((t) => t.startsWith('第 2 页的回答'));
T.ok('往来稿：第 1 页后面紧跟着「第 1 页的回答」，第 2 页后面紧跟着「第 2 页的回答」', ia === 1 && ib > ia + 1 && pt[ib - 1] !== undefined && !pt[ib - 1].startsWith('第'), pt.map((t) => t.slice(0, 12)));
T.ok('回答页按圈号列出问和全文（擦掉的不列）；纸面那一页没有回答文字', ia === 1 && pt[1].indexOf('圈号 2') < pt[1].indexOf('圈号 3') && pt[1].includes('问：单位对吗？') && pt[1].includes('对，单位是千克。')
  && pt[1].includes('第三条回答') && !pt[1].includes('为什么是线性的') && !pt[0].includes('千克'), pt.slice(0, 2));
T.ok('第 2 页的长回答在回答页上自动换行，放不下接着下一页（续）', ib > 0 && pt[ib].includes('问：靠右下角的问题') && pt[ib].includes('第二页的回答')
  && (pt[ib].includes('第 30 条理由') || (pt[ib + 1] || '').startsWith('第 2 页的回答（续）')), pt.slice(ib, ib + 2).map((t) => t.slice(0, 40)));
const PNG4 = join(T.OUT, '4-pdf-answer-page.png'), PNG4b = join(T.OUT, '4b-pdf-answer-page-2.png');
const render = (i, out) => execFileSync(PY, ['-c', 'import pymupdf as fitz,sys; d=fitz.open(sys.argv[1]); d[int(sys.argv[2])].get_pixmap(matrix=fitz.Matrix(1, 1)).save(sys.argv[3])', PDF, String(i), out]);
if (ib >= 0) render(ib, PNG4);
if (ia >= 0) render(ia, PNG4b);
T.ok('「第 2 页的回答」「第 1 页的回答」两页渲染成了 PNG', existsSync(PNG4) && existsSync(PNG4b), PNG4);

// ================= 15. 长回答没指明答的是哪句（2026-11-16 照《产品定义》第 3 节改）：圈号放在这一轮交上去的红笔问题里最后一句旁边，
// 不是最后写的那一组；之前几轮回答过的红笔不算问题；同一轮先落下的短批注指着的红笔仍是这一轮的问题；这一轮没有红笔问题，才放在最后写的那一组旁边。
// 在一个新建的空白本子里做（前面几页上的东西不挡着，「AI」也只交这一页）
const pad15 = await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title: '圈号放哪' }) });
await T.openNotebook(pad15.id, 0);
T.ok('（前提）打开了新建的空白本子', (await S('S.nb.id')) === pad15.id && (await S('S.page.strokes.length')) === 0, await S('S.nb.id'));
const write15 = async (red, y, len) => { await T.tap(`#tools [data-tool=${red ? 'red' : 'pen'}]`); await T.pen(T.line(120, y, len)); };
const writes15 = async (n) => (await T.waitFor(`window.__ink.S.page.ai.filter((a) => a.type === 'write').length === ${n}`, 10000)) && (await sleep(300), answers());
const rightOf = (a, b) => Math.abs(a.at[0] - (b[2] + 16 + 13)) < 2.5 && Math.abs(a.at[1] - mid(b)) < 2; // 紧挨着那一行的右端外侧、一样高
// 第一轮：红笔问题 g1，黑字 g2，红笔问题 g3（这一轮最后一句），黑字 g4（最后写的一组，在下面一行）
await write15(true, 150, 300);
await write15(false, 260, 300);
await write15(true, 370, 180);
await write15(false, 480, 400);
await T.tap('#check');
const s15a = await T.waitSub('S1'), m15a = s15a && T.metaOf(s15a);
T.ok('（前提）第一轮交上去四组：红、黑、红、黑', Boolean(m15a) && m15a.groups.map((g) => (g.red ? 'r' : 'k')).join('') === 'rkrk', m15a && m15a.groups);
await T.post('/bridge/reply', { sid: 'S1', submission: s15a.id, items: [{ type: 'write', fold: true, text: '没指明答哪句的回答' }, { type: 'write', fold: true, anchor: 'end', text: 'anchor 写了 end 的回答' }] });
const A15 = (await writes15(2)) || [];
const q3 = bbox(m15a, 'g3'), k4 = bbox(m15a, 'g4');
T.ok('没给 anchor：圈号在这一轮最后一句红笔问题 g3 的右端外侧、和它一样高，不在最后写的黑字 g4 旁边', A15.length === 2 && rightOf(A15[0], q3), [A15[0] && A15[0].at, q3, k4]);
T.ok('anchor 写成 end：也算没指明，圈号也在 g3 那一行（让开前一个圈号，往右挪）', A15.length === 2 && Math.abs(A15[1].at[1] - mid(q3)) < 2 && A15[1].at[0] > A15[0].at[0], [A15[1] && A15[1].at, q3]);
T.ok('这一轮交上去的红笔问题 g1、g3 都记成它回答了（照旧）', A15.length === 2 && A15[0].on.slice().sort().join() === m15a.groups[0].ids.concat(m15a.groups[2].ids).sort().join(), A15[0] && A15[0].on);
// 第二轮：只写了黑字 g5。g1、g3 上一轮答过了，这一轮没有红笔问题：放在最后写的那组 g5 旁边
await write15(false, 590, 300);
await T.tap('#check');
const s15b = await T.waitSub('S1'), m15b = s15b && T.metaOf(s15b);
T.ok('（前提）第二轮交上去五组，g1、g3 标着回答过，最后一组 g5 是黑字', Boolean(m15b) && m15b.groups.length === 5 && m15b.groups[0].answered && m15b.groups[2].answered && !m15b.groups[4].red,
  m15b && m15b.groups.map((g) => [g.id, g.red, g.answered]));
await T.post('/bridge/reply', { sid: 'S1', submission: s15b.id, items: [{ type: 'write', fold: true, text: '这一轮没有红笔问题' }] });
const B15 = (await writes15(3)) || [], k5 = bbox(m15b, 'g5');
T.ok('这一轮没有红笔问题（回答过的红笔不算）：圈号放在最后写的那组 g5 旁边', B15.length === 3 && rightOf(B15[2], k5), [B15[2] && B15[2].at, k5, q3]);
// 第三轮：红笔问题 g6，黑字 g7。Claude 先回一条指着 g6 的短批注，再回一条没给 anchor 的长回答（两次回写，同一轮）
await write15(true, 700, 180);
await write15(false, 810, 400);
await T.tap('#check');
const s15c = await T.waitSub('S1'), m15c = s15c && T.metaOf(s15c);
T.ok('（前提）第三轮交上去七组，g6 是红笔问题、g7 是黑字', Boolean(m15c) && m15c.groups.length === 7 && m15c.groups[5].red && !m15c.groups[5].answered && !m15c.groups[6].red,
  m15c && m15c.groups.map((g) => [g.id, g.red, g.answered]));
await T.post('/bridge/reply', { sid: 'S1', submission: s15c.id, items: [{ type: 'note', anchor: 'g6', text: '先到的短答' }] });
T.ok('（前提）指着 g6 的短批注先落下了', await T.waitFor(`window.__ink.S.page.ai.some((a) => a.text === '先到的短答')`, 10000));
await T.post('/bridge/reply', { sid: 'S1', submission: s15c.id, items: [{ type: 'write', fold: true, text: '后到的长答' }] });
const C15 = (await writes15(4)) || [], q6 = bbox(m15c, 'g6'), k7 = bbox(m15c, 'g7');
T.ok('同一轮先到的短批注不算「之前回答过」：圈号仍在这一轮最后一句红笔问题 g6 那一行、在它右边，不在 g7 旁边',
  C15.length === 4 && Math.abs(C15[3].at[1] - mid(q6)) < 2 && C15[3].at[0] > q6[2], [C15[3] && C15[3].at, q6, k7]);
const SHOT5 = await T.shot('5-badge-no-anchor.png');

console.error('截图：\n' + [SHOT1, join(T.OUT, '1-two-badges-zoom.png'), SHOT2, SHOT3, PNG4, PNG4b, SHOT5].join('\n'));
T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

// 卡片里换上一条、下一条（2026-11-16 用户定，《产品定义》第 2 节「交互上补的八样」；细节暂定，用户之后在平板上试）。查：
// 卡片顶上两个按钮「‹ 上一条」「下一条 ›」（界面的字体，贴在卡片顶上，内容滑动时不动），按这一页圈号的顺序换到相邻那条回答的卡片，
// 擦掉的回答跳过；小蓝点浮出的小卡片不出。2026-11-16 夜起能跨页（第 1、3、12 步）：到这一页的头、尾时翻到那个方向最近的有回答的页，
// 按钮上写出去哪一页；整本的头、尾才变灰；整本只有一条时两个都不出；
// 换了以后卡片的位置（和直接点那个圈号打开时一样）、卡片上的红字、接着的回应（没看过的滑到新的那一段）、记为看过，都照那一条自己的来；
// 手指、笔、鼠标点都行；手掌（接触面大的触点）、笔刚用过一秒内的手指碰到按钮不算点；
// 防手掌的那几条没坏：手掌（两个略晃的触点）落在卡片外不收卡片，干净地轻点卡片外立刻收；页面没有报错。
// 手指和手掌是 CDP 的触摸事件，笔是 pointerType 为 pen 的鼠标事件（不是 iPad 上真的笔和手）。
// 跑法：node tests/run_browser.mjs <临时目录> --only card_nav；有一项不对退出码 1。
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'card-nav', pages: 2 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const waitPen = () => sleep(1150); // 笔刚用过的一秒内手指不算（手掌）
const answers = () => S(`S.page.ai.filter((a) => a.type === 'write')`);
const answerN = async (n) => (await answers()).find((a) => a.n === n);
const badgeAt = (id) => js(`(() => { const c = document.querySelector('#aiRoot .badge[data-id="' + ${JSON.stringify(id)} + '"] circle'); if (!c) return null; const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const card = () => js(`(() => { const c = document.querySelector('#answerCard'); if (c.hidden) return null; const r = c.getBoundingClientRect(), S = window.__ink.S, nav = document.querySelector('#acNav');
  const nr = nav.getBoundingClientRect(), p = document.querySelector('#acPrev'), n = document.querySelector('#acNext');
  return { id: S.card && S.card.id, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, st: c.scrollTop, q: document.querySelector('#acQ').hidden ? null : document.querySelector('#acQt').textContent,
    body: document.querySelector('#acBody').textContent, nav: !nav.hidden && nr.height > 0, navTop: nr.top, navBottom: nr.bottom, navFont: getComputedStyle(nav).fontFamily,
    prev: p.textContent, next: n.textContent, prevOff: p.disabled, nextOff: n.disabled, prevOp: Number(getComputedStyle(p).opacity), nextOp: Number(getComputedStyle(n).opacity),
    marks: document.querySelectorAll('#acInk path:not(.live)').length,
    segs: [...document.querySelectorAll('#acMore .ac-seg')].map((d) => { const b = d.getBoundingClientRect(); return { t: b.top, b: b.bottom }; }) }; })()`);
const center = (sel) => T.centerOf(sel);
const tapNav = async (which) => { const c = await center(which === 'next' ? '#acNext' : '#acPrev'); await T.fingerTapAt(c[0], c[1]); };
const openBadge = async (id) => { await waitPen(); const b = await badgeAt(id); await T.fingerTapAt(b[0], b[1]); return card(); };
const penAt = async (pts, wait = 300) => {
  const base = { pointerType: 'pen', button: 'left' };
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: pts[0][0], y: pts[0][1], buttons: 1, clickCount: 1 }, base));
  for (const p of pts.slice(1)) await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: p[0], y: p[1], buttons: 1 }, base));
  const l = pts[pts.length - 1];
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: l[0], y: l[1], buttons: 0, clickCount: 1 }, base));
  await sleep(wait);
};
const hline = (x0, y, len, n = 14) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 0.6]);
const touchEv = (type, pts) => T.cdp('Input.dispatchTouchEvent', { type, touchPoints: pts });
const near = (a, b, d = 1.5) => Math.abs(a - b) <= d;
const cardIs = (id) => T.waitFor(`window.__ink.S.card && window.__ink.S.card.id === ${JSON.stringify(id)} && !document.querySelector('#answerCard').hidden`, 6000);

if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); } // 单页：第 2 页另翻过去

// ================= 0. 第 1 页：三句红笔问题、一行黑字；Claude 回三条长回答（圈号 1、2、3）和一条短批注。第 2 页：一句红笔、一条长回答
await T.tool('red');
await T.pen(T.line(120, 200, 300));
await T.pen(T.line(120, 420, 300));
await T.pen(T.line(120, 640, 300));
await T.tool('pen');
await T.pen(T.line(120, 860, 260));
await T.tap('#check');
const sub1 = await T.waitSub('S1'), meta1 = sub1 && T.metaOf(sub1);
T.ok('（前提）交上去了：三句红笔、一行黑字', Boolean(meta1) && meta1.groups.length === 4, meta1 && meta1.groups);
const LONG = ['第三条的回答，比较长。'].concat(Array.from({ length: 30 }, (_, k) => `第 ${k + 1} 行：这一条写得长，卡片里要滑着看。`)).join('\n');
await T.post('/bridge/reply', { sid: 'S1', submission: sub1.id, items: [
  { type: 'write', anchor: 'g1', q: '第一问', text: '第一条回答。' },
  { type: 'write', anchor: 'g2', q: '第二问', text: '第二条回答。' },
  { type: 'write', anchor: 'g3', q: '第三问', text: LONG },
  { type: 'note', anchor: 'g4', text: '短批注' }] });
T.ok('（前提）落下：三个圈号、一条短批注', await T.waitFor(`window.__ink.S.page.ai.filter((a) => a.type === 'write').length === 3 && window.__ink.S.page.ai.length === 4`, 10000));
await sleep(500);
const w1 = await answerN(1), w2 = await answerN(2), w3 = await answerN(3);
await T.openPage(1);
await T.tool('red');
await T.pen(T.line(120, 300, 300));
await T.tool('pen');
await T.tap('#check');
const sub2 = await T.waitSub('S1');
await T.post('/bridge/reply', { sid: 'S1', submission: sub2.id, items: [{ type: 'write', anchor: 'g1', q: '第二页的问', text: '第二页唯一的回答。' }] });
T.ok('（前提）第 2 页：一个圈号', await T.waitFor(`window.__ink.S.page.ai.filter((a) => a.type === 'write').length === 1`, 10000));
await sleep(400);
const p2 = (await answers())[0];

// ================= 1. 这一页只有一条回答、别的页还有（2026-11-16 夜起能跨页）：两个按钮都出；往前是第 1 页，往后到头了
let C = await openBadge(p2.id);
T.ok('第 2 页只有一条回答、第 1 页还有：卡片顶上有两个按钮，「‹ 上一条（第 1 页）」能点，「下一条 ›」是灰的（整本的尾）', Boolean(C) && C.id === p2.id && C.nav
  && C.prev === '‹ 上一条（第 1 页）' && !C.prevOff && C.next === '下一条 ›' && C.nextOff, C);
await T.fingerTapAt(120, 1000);
await T.openPage(0);

// ================= 2. 打开圈号 2：两个按钮都在、都能点；在卡片顶上，用界面的字体
C = await openBadge(w2.id);
T.ok('圈号 2 的卡片：顶上有「‹ 上一条」「下一条 ›」，两个都能点', Boolean(C) && C.id === w2.id && C.nav && C.prev === '‹ 上一条' && C.next === '下一条 ›' && !C.prevOff && !C.nextOff, C);
T.ok('按钮贴在卡片顶上，用界面的字体（不是蓝色手写体）', near(C.navTop, C.t + 1, 2) && !/Xiaolai/.test(C.navFont), [C.navTop, C.t, C.navFont]);
T.ok('点开就记为看过', (await answerN(2)).seen === true && !(await answerN(3)).seen);
await T.shot('card-nav-open.png');

// ================= 3. 下一条：换成圈号 3 的卡片，紧挨圈号 3（和直接点圈号 3 打开时同一个位置），记为看过；
//     圈号 3 是这一页最后一条，后面第 2 页还有：「下一条」写出去第 2 页（2026-11-16 夜起跨页，跨页的细节在第 12 步）
await tapNav('next');
C = await card();
T.ok('点「下一条」：换成圈号 3 的卡片（问：第三问）', Boolean(C) && C.id === w3.id && C.q === '第三问' && C.body.startsWith('第三条的回答'), C && [C.id, C.q]);
T.ok('圈号 3 记为看过', (await answerN(3)).seen === true);
T.ok('圈号 3 是这一页最后一条：「下一条」写着去第 2 页、能点，「上一条」能点', C.next === '下一条（第 2 页）›' && !C.nextOff && C.nextOp === 1 && !C.prevOff && C.prevOp === 1,
  [C.next, C.nextOff, C.nextOp, C.prevOff]);
const viaNav = { l: C.l, t: C.t };
await T.fingerTapAt(120, 1000);
T.ok('（干净地轻点卡片外：收起）', (await card()) === null);
C = await openBadge(w3.id);
T.ok('换过去的卡片和直接点圈号 3 打开的位置一样（紧挨圈号 3）', Boolean(C) && near(C.l, viaNav.l) && near(C.t, viaNav.t), [viaNav, C && [C.l, C.t]]);
await tapNav('next');
await cardIs(p2.id);
C = await card();
T.ok('点「下一条（第 2 页）」：翻到第 2 页，打开那一页的那条回答', (await S('S.idx')) === 1 && Boolean(C) && C.id === p2.id, [await S('S.idx'), C && C.id]);
await waitPen();
await tapNav('prev');
await cardIs(w3.id);
C = await card();
T.ok('再点「‹ 上一条（第 1 页）」：回到第 1 页，打开那一页最后一条（圈号 3）', (await S('S.idx')) === 0 && Boolean(C) && C.id === w3.id, [await S('S.idx'), C && C.id]);

// ================= 4. 上一条两次：回到圈号 1，「上一条」变灰
await tapNav('prev');
T.ok('点「上一条」：换成圈号 2', (await card()).id === w2.id);
await tapNav('prev');
C = await card();
T.ok('再点「上一条」：圈号 1，「上一条」变灰', C.id === w1.id && C.q === '第一问' && C.prevOff && !C.nextOff, C);

// ================= 5. 卡片上的红字照那一条自己的来：在圈号 1 的卡片上写一笔，换到 2 没有，换回 1 有
await T.tool('red');
const L1 = await js(`(() => { const r = document.querySelector('#acBody .ac-line').getBoundingClientRect(); return { l: r.left, b: r.bottom }; })()`);
await penAt(hline(L1.l + 10, L1.b + 3, 120));
T.ok('（前提）圈号 1 的卡片上写了一笔红字', ((await answerN(1)).marks || []).length === 1 && (await card()).marks === 1);
await waitPen();
await tapNav('next');
C = await card();
T.ok('换到圈号 2：卡片上没有红字（那一笔是圈号 1 的）', C.id === w2.id && C.marks === 0, C);
await tapNav('prev');
C = await card();
T.ok('换回圈号 1：那一笔红字又画出来了', C.id === w1.id && C.marks === 1, C);

// ================= 6. 笔刚用过（一秒内）用手指碰按钮：当手掌，不换；接触面大的触点（像手掌）碰按钮：不换
await penAt([[C.l + 30, C.b - 20]], 100); // 红笔在卡片里点一下（笔刚用过）
const n6 = ((await answerN(1)).marks || []).length;
await tapNav('next');
T.ok('笔刚用过（一秒内）手指点「下一条」：当手掌，不换', (await card()).id === w1.id);
await T.tap('#toolsUndo'); // 刚才那一点红字不要
T.ok('（撤掉刚才那一点）', ((await answerN(1)).marks || []).length === n6 - 1, (await answerN(1)).marks);
await waitPen();
const nx = await center('#acNext');
await touchEv('touchStart', [{ x: nx[0], y: nx[1], id: 31, radiusX: 60, radiusY: 60 }]);
await sleep(60);
await touchEv('touchEnd', []);
await sleep(300);
T.ok('接触面很大的触点（像手掌）碰「下一条」：不换，卡片还开着', Boolean(await card()) && (await card()).id === w1.id);
await tapNav('next');
T.ok('过了一秒、指尖干净地点「下一条」：换到圈号 2', (await card()).id === w2.id);

// ================= 7. 用笔点按钮：照样换，纸上、卡片上都不多笔迹；黑笔也一样（黑笔落在卡片里本来是收起卡片）
await T.tool('pen');
const strokes7 = await S('S.page.strokes.length'), marks7 = ((await answerN(2)).marks || []).length;
const pv = await center('#acPrev');
await penAt([[pv[0], pv[1]]]);
C = await card();
T.ok('黑笔点「上一条」：换到圈号 1，卡片没收', Boolean(C) && C.id === w1.id, C && C.id);
T.ok('笔点按钮不留笔迹（纸上、卡片上都没多）', (await S('S.page.strokes.length')) === strokes7 && ((await answerN(2)).marks || []).length === marks7 && ((await answerN(1)).marks || []).length === n6 - 1);
await T.tap('#acNext'); // 鼠标点
T.ok('鼠标点「下一条」：换到圈号 2', (await card()).id === w2.id);

// ================= 8. Claude 接着回了圈号 3（没看过）：从圈号 2 换过去，滑到新的那一段，那一段在按钮下面看得见
await T.post('/bridge/reply', { sid: 'S1', submission: sub1.id, items: [{ type: 'write', card: 3, q: '追问一句', text: '接着的回应。' }] });
T.ok('（前提）回应接在圈号 3 的卡片下面，圈号 3 又变成没看过', await T.waitFor(`(() => { const a = window.__ink.S.page.ai.find((o) => o.n === 3); return (a.more || []).length === 1 && !a.seen; })()`, 10000));
await sleep(300);
C = await card();
T.ok('（这时圈号 2 的卡片还开着）', Boolean(C) && C.id === w2.id, C);
await waitPen();
await tapNav('next');
C = await card();
const sg = C && C.segs[0];
T.ok('换到圈号 3：滑到了新的那一段，它的顶在按钮下面、卡片里看得见', Boolean(sg) && C.id === w3.id && C.st > 100 && sg.t >= C.navBottom - 1 && sg.t < C.b - 20, [C && C.st, sg, C && [C.navBottom, C.b]]);
T.ok('圈号 3 又记为看过', (await answerN(3)).seen === true);
// 卡片里的内容滑动时按钮不动
const nav0 = C.navTop;
await js(`document.querySelector('#answerCard').scrollTop = 0`);
await sleep(100);
await T.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: (C.l + C.r) / 2, y: C.b - 40, id: 5 }] });
for (let k = 1; k <= 10; k++) { await T.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: (C.l + C.r) / 2, y: C.b - 40 - k * 15, id: 5 }] }); await sleep(16); }
await T.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(300);
const C8 = await card();
T.ok('手指在卡片里往上滑：内容滑了，按钮还在卡片顶上', Boolean(C8) && C8.st > 100 && near(C8.navTop, nav0, 1) && C8.nav, [C8 && C8.st, C8 && C8.navTop, nav0]);

// ================= 9. 擦掉的回答跳过；撤销找回后又算上
await T.fingerTapAt(120, 1000);
await T.tool('eraser');
const at2 = (await answerN(2)).at;
await T.pen([[at2[0] - 2, at2[1]], [at2[0] + 2, at2[1] + 1]]);
await T.tool('pen');
T.ok('（前提）橡皮擦掉了圈号 2', (await answerN(2)).erasedAt > 0);
C = await openBadge(w1.id);
await tapNav('next');
T.ok('圈号 2 擦掉了：从圈号 1 点「下一条」直接到圈号 3', (await card()).id === w3.id);
await T.tap('#toolsUndo');
C = await card();
T.ok('卡片开着时撤销（圈号 2 回来）：按钮跟着变，圈号 3 的「上一条」到圈号 2', Boolean(C) && C.id === w3.id && !C.prevOff, C);
await tapNav('prev');
T.ok('点「上一条」：圈号 2', (await card()).id === w2.id);

// ================= 10. 防手掌的那几条没坏：换过卡片之后，手掌（两个略晃的触点）落在卡片外不收；干净的一下轻点卡片外立刻收
C = await card();
await sleep(1700);
const vh = await js('innerHeight'), P1 = [C.l + 40, Math.min(vh - 80, C.b + 150)], P2 = [C.l + 110, Math.min(vh - 50, C.b + 180)];
const v10 = await S('[S.view.tx, S.view.ty, S.view.s]');
await touchEv('touchStart', [{ x: P1[0], y: P1[1], id: 41 }, { x: P2[0], y: P2[1], id: 42 }]);
for (let k = 1; k <= 4; k++) { await touchEv('touchMove', [{ x: P1[0] + k * 2, y: P1[1] - k, id: 41 }, { x: P2[0] + k, y: P2[1] + k * 2, id: 42 }]); await sleep(40); }
await touchEv('touchEnd', []);
await sleep(300);
T.ok('手掌（两个略晃的触点）落在卡片外：卡片不收、纸不动', Boolean(await card()) && JSON.stringify(await S('[S.view.tx, S.view.ty, S.view.s]')) === JSON.stringify(v10), [Boolean(await card()), v10]);
await T.fingerTapAt(P1[0], P1[1]);
T.ok('干净地轻点卡片外：立刻收起', (await card()) === null);

// ================= 11. 小蓝点浮出来的小卡片不是回答：没有这两个按钮
const nb11 = await js(`(() => { const S = window.__ink.S, a = S.page.ai.find((o) => o.type === 'note'); return window.__ink.noteTextBox(a); })()`);
await T.pen(T.line(nb11[0] - 10, (nb11[1] + nb11[3]) / 2, nb11[2] - nb11[0] + 20));
const dot = await S(`(S.page.ai.find((o) => o.type === 'note').dot || {}).at || null`);
T.ok('（前提）黑笔压过短批注：收成小蓝点', Boolean(dot), dot);
await waitPen();
const dp = await T.screenOf(dot[0], dot[1]);
await T.fingerTapAt(dp[0], dp[1]);
C = await card();
T.ok('点小蓝点浮出的小卡片：没有「上一条」「下一条」', Boolean(C) && !C.nav && (await S('S.card.note')) === true, C);
await T.fingerTapAt(120, 1000);
await T.shot('card-nav.png');

// ================= 12. 跨页（2026-11-16 夜用户定，暂定）。新开一本 5 页：第 1 页一条、第 3 页一条、第 5 页两条（圈号 1 在纸的下面、
//     圈号 2 在上面），第 2、4 页没有。到这一页的头、尾时翻到那个方向最近的有回答的页（跳过没有的页），往后打开第一条、往前打开最后一条，
//     按钮上写出去哪一页；整本的头、尾才变灰；翻过去和点那一页的圈号一样（卡片紧挨圈号、记为看过）；圈号不在屏幕上时纸挪到看得见；
//     别的页有没有回答不用载那一页（刷新后用服务给的 ans）；擦掉的不算，整本只剩一条时两个按钮都不出；连续阅读也一样；防手掌照旧
const X = await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title: '跨页', paper: 'portrait' }) });
for (let k = 0; k < 4; k++) await T.api(`/api/notebook/addpage?nb=${encodeURIComponent(X.id)}`, { method: 'POST', body: '' });
await T.openNotebook(X.id, 0);
if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }
const sendOn = async (i, ys) => { await T.openPage(i); await T.tool('red'); for (const y of ys) await T.pen(T.line(120, y, 300)); await T.tool('pen'); await T.tap('#check'); return T.waitSub('S1'); };
const xs1 = await sendOn(0, [300]), xs3 = await sendOn(2, [400]), xs5 = await sendOn(4, [300, 1340]);
await T.post('/bridge/reply', { sid: 'S1', submission: xs1.id, items: [{ type: 'write', anchor: 'g1', q: '一', text: '第 1 页的回答。' }] });
await T.post('/bridge/reply', { sid: 'S1', submission: xs3.id, items: [{ type: 'write', anchor: 'g1', q: '三', text: '第 3 页的回答。' }] });
await T.post('/bridge/reply', { sid: 'S1', submission: xs5.id, items: [{ type: 'write', anchor: 'g2', q: '五下', text: '第 5 页下面那条（圈号 1）。' },
  { type: 'write', anchor: 'g1', q: '五上', text: '第 5 页上面那条（圈号 2）。' }] });
T.ok('（前提）第 5 页落下两条', await T.waitFor(`window.__ink.S.idx === 4 && window.__ink.S.page.ai.filter((a) => a.type === 'write').length === 2`, 10000));
const x5 = await answers(), x51 = x5.find((a) => a.n === 1), x52 = x5.find((a) => a.n === 2);
T.ok('（前提）第 5 页圈号 1 在纸的下面（y > 1300），圈号 2 在上面', Boolean(x51 && x52) && x51.at[1] > 1300 && x52.at[1] < 500, x5.map((a) => [a.n, a.at]));
await T.openPage(0);
T.ok('（前提）第 1 页落下一条', await T.waitFor(`window.__ink.S.page.ai.filter((a) => a.type === 'write').length === 1`, 10000));
const x1 = (await answers())[0];
await T.openPage(2);
T.ok('（前提）第 3 页落下一条', await T.waitFor(`window.__ink.S.page.ai.filter((a) => a.type === 'write').length === 1`, 10000));
const x3 = (await answers())[0];
await sleep(400);
await T.saved();
// 圈号在屏幕里、不在最下面那一截（卡片放得下）。连续阅读时换成当前页、屏幕不动的话，纸底下那个圈号不在屏幕里，不挪纸就过不了
const badgeShown = (id) => js(`(() => { const c = document.querySelector('#aiRoot .badge[data-id="' + ${JSON.stringify(id)} + '"] circle'); if (!c) return false; const r = c.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= innerHeight - 160 && r.left >= 0 && r.right <= innerWidth; })()`);
const badgeY = (id) => js(`(() => { const c = document.querySelector('#aiRoot .badge[data-id="' + ${JSON.stringify(id)} + '"] circle'); return c ? Math.round(c.getBoundingClientRect().top) : null; })()`);
const reopen = async (id) => { await js(`window.__ink.closeCard()`); return openBadge(id); }; // 在原处直接点那个圈号打开（比位置用）

// 12.1 第 3 页只有一条：两个按钮都出，都写着去哪一页
C = await openBadge(x3.id);
T.ok('第 3 页只有一条：「‹ 上一条（第 1 页）」「下一条（第 5 页）›」，都能点（第 2、4 页没有回答，跳过）', Boolean(C) && C.id === x3.id && C.nav
  && C.prev === '‹ 上一条（第 1 页）' && C.next === '下一条（第 5 页）›' && !C.prevOff && !C.nextOff, C);
// 12.2 防手掌：接触面大的触点、笔刚用过一秒内的手指碰「下一条（第 5 页）」：不翻
const nx12 = await center('#acNext');
await touchEv('touchStart', [{ x: nx12[0], y: nx12[1], id: 51, radiusX: 60, radiusY: 60 }]);
await sleep(60);
await touchEv('touchEnd', []);
await sleep(600);
T.ok('接触面很大的触点（像手掌）碰「下一条（第 5 页）」：不翻页、卡片还开着', (await S('S.idx')) === 2 && Boolean(await card()) && (await card()).id === x3.id);
C = await card();
await T.tool('red');
await penAt([[C.l + 30, C.b - 20]], 100); // 红笔在卡片里点一下（笔刚用过）
await tapNav('next');
await sleep(400);
T.ok('笔刚用过（一秒内）手指点「下一条（第 5 页）」：当手掌，不翻', (await S('S.idx')) === 2 && Boolean(await card()) && (await card()).id === x3.id);
await T.tap('#toolsUndo'); // 刚才那一点红字不要
await T.tool('pen');
T.ok('（撤掉了那一点红字，卡片还开着）', ((await S(`S.page.ai.find((a) => a.id === '${x3.id}').marks`)) || []).length === 0 && Boolean(await card()));
await waitPen();
// 12.3 往后跨页：第 5 页的第一条（圈号 1，在纸的下面）：纸挪到看得见它，卡片紧挨它（和直接点它一样），记为看过
await tapNav('next');
await cardIs(x51.id);
C = await card();
T.ok('点「下一条（第 5 页）」：翻到第 5 页，打开它的第一条（圈号 1）', (await S('S.idx')) === 4 && Boolean(C) && C.id === x51.id, [await S('S.idx'), C && C.id]);
T.ok('圈号 1 在纸的下面：翻过去后圈号在屏幕里、不在最下面（单页适配宽度时整页都在屏幕里，不用挪纸；连续阅读那一步要挪）', await badgeShown(x51.id), [await badgeY(x51.id), await S('S.view')]);
T.ok('第 5 页圈号 1 记为看过；按钮：「‹ 上一条（第 3 页）」「下一条 ›」（到圈号 2，同一页）', (await S(`S.page.ai.find((a) => a.id === '${x51.id}').seen`)) === true
  && C.prev === '‹ 上一条（第 3 页）' && C.next === '下一条 ›' && !C.prevOff && !C.nextOff, C);
const pos123 = { l: C.l, t: C.t };
await T.tap('#chipPage', 500);
T.ok('跨页翻过来的：点左上角的页码，出的小框里有「回到第 3 页」（输入页码翻页，见 page_jump.mjs）',
  await js(`!document.querySelector('#pageJump').hidden && !document.querySelector('#pjBack').hidden && document.querySelector('#pjBack').textContent === '回到第 3 页'`));
await T.tap('#chipPage', 400);
C = await reopen(x51.id);
T.ok('翻过去打开的卡片和直接点那个圈号打开的位置一样', Boolean(C) && near(C.l, pos123.l) && near(C.t, pos123.t), [pos123, C && [C.l, C.t]]);
await tapNav('next');
C = await card();
T.ok('再点「下一条」：同一页的圈号 2；它是整本最后一条，「下一条」变灰', Boolean(C) && C.id === x52.id && C.next === '下一条 ›' && C.nextOff && C.nextOp <= 0.5, C);
// 12.4 往前跨页：打开那一页的最后一条；第 1 页是整本的头，「上一条」变灰
await tapNav('prev');
await tapNav('prev');
await cardIs(x3.id);
T.ok('从第 5 页圈号 1 点「‹ 上一条（第 3 页）」：回到第 3 页那一条', (await S('S.idx')) === 2 && (await card()).id === x3.id);
await waitPen();
await tapNav('prev');
await cardIs(x1.id);
C = await card();
T.ok('再往前：第 1 页那一条；它是整本的头，「‹ 上一条」变灰，「下一条（第 3 页）›」能点', (await S('S.idx')) === 0 && Boolean(C) && C.id === x1.id
  && C.prev === '‹ 上一条' && C.prevOff && C.next === '下一条（第 3 页）›' && !C.nextOff, C);
// 12.5 刷新后（别的页都没载过）：还知道哪几页有回答（服务给的 ans）
await T.openPage(2);
await T.reload();
T.ok('（前提）刷新后在第 3 页，单页，别的页一页都没载', (await S('S.idx')) === 2 && !(await S('S.flow')) && (await S('S.flowCache.size')) === 0
  && JSON.stringify(await S(`S.nb.pageInfo.map((p) => p.ans || 0)`)) === '[1,0,1,0,2]', await S(`S.nb.pageInfo.map((p) => p.ans || 0)`));
C = await openBadge(x3.id);
T.ok('刷新后打开第 3 页那一条：照样写着去第 1 页、第 5 页', Boolean(C) && C.prev === '‹ 上一条（第 1 页）' && C.next === '下一条（第 5 页）›', C);
// 12.6 英文界面、744 宽：按钮写出去哪一页，两个按钮都在卡片里、字没被截掉
await T.cdp('Emulation.setDeviceMetricsOverride', { width: 744, height: 1133, deviceScaleFactor: 1, mobile: true });
await T.go('&lang=en');
C = await openBadge(x3.id);
const fitEn = await js(`(() => { const c = document.querySelector('#answerCard').getBoundingClientRect();
  return ['#acPrev', '#acNext'].every((q) => { const b = document.querySelector(q), r = b.getBoundingClientRect(); return b.scrollWidth <= b.clientWidth + 1 && r.left >= c.left && r.right <= c.right; }); })()`);
T.ok('英文界面：「‹ Previous (page 1)」「Next (page 5) ›」，744 宽时两个按钮都在卡片里、字没被截掉', Boolean(C) && C.prev === '‹ Previous (page 1)' && C.next === 'Next (page 5) ›' && fitEn, [C && C.prev, C && C.next, fitEn]);
await T.shot('card-nav-cross-en.png');
await T.cdp('Emulation.setDeviceMetricsOverride', { width: 834, height: 1194, deviceScaleFactor: 1, mobile: true });
await T.go();
// 12.7 连续阅读：一样能跨页，翻过去和点那个圈号一样
await js(`window.__ink.toggleFlow()`);
await sleep(1200);
await T.openPage(2);
await sleep(800);
C = await openBadge(x3.id);
T.ok('（前提）连续阅读，第 3 页那一条的卡片：写着去第 1 页、第 5 页', (await S('S.flow')) && Boolean(C) && C.prev === '‹ 上一条（第 1 页）' && C.next === '下一条（第 5 页）›', C);
await tapNav('next');
await cardIs(x51.id);
C = await card();
T.ok('连续阅读点「下一条（第 5 页）」：第 5 页成为当前页，打开圈号 1，圈号在屏幕里', (await S('S.idx')) === 4 && Boolean(C) && C.id === x51.id && (await badgeShown(x51.id)), [await S('S.idx'), C && C.id]);
const pos127 = { l: C.l, t: C.t };
C = await reopen(x51.id);
T.ok('连续阅读：翻过去打开的卡片和直接点那个圈号打开的位置一样', Boolean(C) && near(C.l, pos127.l) && near(C.t, pos127.t), [pos127, C && [C.l, C.t]]);
await tapNav('prev');
await cardIs(x3.id);
T.ok('连续阅读点「‹ 上一条（第 3 页）」：回到第 3 页那一条', (await S('S.idx')) === 2 && (await card()).id === x3.id);
await js(`window.__ink.closeCard()`);
await js(`window.__ink.toggleFlow()`);
await sleep(1000);
// 12.8 擦掉的不算：擦掉第 1 页那一条，第 3 页的「上一条」到头了；再擦掉第 5 页两条，整本只剩一条，两个按钮都不出（刷新后也一样）
const eraseBadge = async (a) => { await T.tool('eraser'); await T.pen([[a.at[0] - 2, a.at[1]], [a.at[0] + 2, a.at[1] + 1]]); await T.tool('pen'); };
await T.openPage(0);
await eraseBadge(x1);
T.ok('（前提）擦掉了第 1 页那一条', (await S(`S.page.ai.find((a) => a.id === '${x1.id}').erasedAt`)) > 0);
await T.openPage(2);
C = await openBadge(x3.id);
T.ok('第 1 页那一条擦掉了：第 3 页那一条的「‹ 上一条」变灰，「下一条（第 5 页）›」还在', Boolean(C) && C.nav && C.prev === '‹ 上一条' && C.prevOff && C.next === '下一条（第 5 页）›', C);
await js(`window.__ink.closeCard()`);
await T.openPage(4);
for (const a of [x51, x52]) await eraseBadge(a);
T.ok('（前提）擦掉了第 5 页两条', (await S(`S.page.ai.filter((a) => a.type === 'write' && a.erasedAt).length`)) === 2);
await T.openPage(2);
C = await openBadge(x3.id);
T.ok('整本只剩第 3 页这一条：卡片顶上没有「上一条」「下一条」', Boolean(C) && C.id === x3.id && !C.nav, C);
await T.saved();
await T.reload();
C = await openBadge(x3.id);
T.ok('刷新后（服务从存下的页算）：照样没有这两个按钮', Boolean(C) && C.id === x3.id && !C.nav && JSON.stringify(await S(`S.nb.pageInfo.map((p) => p.ans || 0)`)) === '[0,0,1,0,0]',
  [C, await S(`S.nb.pageInfo.map((p) => p.ans || 0)`)]);

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

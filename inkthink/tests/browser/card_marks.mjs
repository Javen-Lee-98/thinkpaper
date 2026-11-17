// 长回答卡片上的红字（2026-11-14 用户定，《产品定义》第 3 节「在卡片上用红笔批注、追问」）。查：
// 红笔落在卡片里：卡片不收、写在卡片上（跟着内容滑）、纸上不多笔迹，存盘后那条回答有 marks 和 sheet；
// 黑笔落在卡片里：卡片收起、哪里都不多笔迹；笔落在卡片外：卡片收起、纸上照常多一笔；
// 手指在卡片里上下滑、红字跟着走；笔刚用过时落下的手指（手掌）不滑；手掌先搭在纸上不收卡片，搭着时红笔照样在卡片上写、手掌再挪也不挪纸；
// 橡皮擦卡片上的红字、撤销找回；撤销刚写的一笔；卡片上的红字和纸上的笔迹在同一个撤销次序里；
// 收起后圈号带红点；刷新后红字还在、位置对；换一个屏幕大小（横屏），红字相对它压着的那行字不动；
// 点「AI」：投递里有那张卡片的图（蓝字、红字都在，红字在它批的那一行下面），消息里提到它和圈号，交出去后红点没了；
// Claude 用带 card 的 write 回：接在卡片下面一段，前面写着那句红字，上面的字和红字不动，圈号变回实心、跳两下、上方说一句，
// 点开滑到新的那一段，不出新圈号；再交一次时那些红字不再交；
// 只在卡片上写了红字、纸上没新笔迹的页，几页一起交时也交出去（整本消息里有那张卡片，红点没了）；
// 带「之前的版本」的卡片：在旧版上写红字，接上新的一段后「之前的版本」还在最底下，旧版上的红字没错位；
// 手指在卡片里滑过之后手掌落在卡片外（几个略晃的触点、一个短促的触点、接触面大的触点、被系统取消的触点）不收卡片，搭着时红笔照样写在卡片上；
// 干净的轻点、明确的挪纸和缩放、笔落在卡片外照旧收起，点工具条不收；页面没有报错。
// 手指和手掌是用 CDP 的触摸事件模拟的（不是 iPad 上真的手掌），笔是 pointerType 为 pen 的鼠标事件。
// 跑法：node tests/run_browser.mjs <临时目录> --only card_marks；有一项不对退出码 1。
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'card-marks', pages: 2 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const waitPen = () => sleep(1150); // 笔刚用过的一秒内手指不算（手掌）
const PORTRAIT = { width: 834, height: 1194, deviceScaleFactor: 1, mobile: true }, LANDSCAPE = { width: 1194, height: 834, deviceScaleFactor: 1, mobile: true };

// ---- 小工具
// 用笔在屏幕坐标上画一笔（pointerType 为 pen 的鼠标事件）
const penAt = async (pts, wait = 300) => {
  const base = { pointerType: 'pen', button: 'left' };
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: pts[0][0], y: pts[0][1], buttons: 1, clickCount: 1 }, base));
  for (const p of pts.slice(1)) await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: p[0], y: p[1], buttons: 1 }, base));
  const l = pts[pts.length - 1];
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: l[0], y: l[1], buttons: 0, clickCount: 1 }, base));
  await sleep(wait);
};
const hline = (x0, y, len, n = 14) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 0.6]);
const fingerDrag = async (x, y, dx, dy, id = 5) => {
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id }] });
  for (let k = 1; k <= 10; k++) { await T.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * k) / 10, y: y + (dy * k) / 10, id }] }); await sleep(16); }
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
};
const answers = () => S(`S.page.ai.filter((a) => a.type === 'write')`);
const answerN = async (n) => (await answers()).find((a) => a.n === n);
const badges = () => js(`[...document.querySelectorAll('#aiRoot .badge')].filter((g) => !g.classList.contains('nbr-badge')).map((g) => { const c = g.querySelector('circle'), r = c.getBoundingClientRect();
  return { id: g.dataset.id, num: g.querySelector('.bdg text').textContent, cx: r.left + r.width / 2, cy: r.top + r.height / 2, seen: g.classList.contains('seen'), dot: Boolean(g.querySelector('.bdot')),
    fill: getComputedStyle(c).fill }; })`);
const badge = async (id) => (await badges()).find((b) => b.id === id);
// 开着的卡片：屏幕上的框、滑到哪、缩放倍数、画出来的红字（屏幕上的框）
const card = () => js(`(() => { const c = document.querySelector('#answerCard'); if (c.hidden) return null; const r = c.getBoundingClientRect(), S = window.__ink.S;
  return { id: S.card && S.card.id, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, st: c.scrollTop, sh: c.scrollHeight, ch: c.clientHeight, k: S.card && S.card.k,
    marks: [...document.querySelectorAll('#acInk path:not(.live), #acInk circle:not(.live)')].map((p) => { const b = p.getBoundingClientRect(); return { id: p.dataset.id, l: b.left, t: b.top, r: b.right, b: b.bottom }; }),
    segs: [...document.querySelectorAll('#acMore .ac-seg')].map((d) => { const b = d.getBoundingClientRect(); return { blk: d.dataset.blk, t: b.top, b: b.bottom, mq: (d.querySelector('.ac-mq') || {}).textContent || null, text: d.querySelector('.ac-mbody').textContent }; }),
    older: document.querySelector('#acOlder').hidden ? null : (() => { const b = document.querySelector('#acOlder').getBoundingClientRect(); return { t: b.top, b: b.bottom }; })() }; })()`);
const rectOf = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; })()`);
// 一笔红字相对一行字的位置（卡片的固定宽度下的单位）：换屏幕大小、滑动、接上新段时应当不变
const relTo = (m, line, k) => [(m.l - line.l) / k, (m.t - line.t) / k, (m.r - line.l) / k, (m.b - line.t) / k];
const near = (a, b, d = 0.8) => Boolean(a && b) && a.every((v, i) => Math.abs(v - b[i]) <= d);
const openBadge = async (id) => { await waitPen(); const b = await badge(id); await T.fingerTapAt(b.cx, b.cy); return card(); };
const strokeCount = () => S('S.page.strokes.length');
const pageFile = () => T.pageFile('scratch', 0);
// 一张 PNG 里红色、蓝色的点：红点的外框和个数；band：只数这一段 y（像素）里的蓝点
function pixels(file, band) {
  const b64 = readFileSync(file).toString('base64');
  return js(`new Promise((res) => { const im = new Image(); im.onload = () => { const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const x = cv.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, im.width, im.height).data, band = ${JSON.stringify(band || null)}; let red = 0, blue = 0, inBand = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let Y = 0; Y < im.height; Y++) for (let X = 0; X < im.width; X++) { const i = (Y * im.width + X) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      if (r > 150 && g < 130 && b < 130) { red++; x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y); }
      else if (b - r > 50 && b > 90) { blue++; if (band && Y >= band[0] && Y <= band[1]) inBand++; } }
    res({ w: im.width, h: im.height, red, blue, inBand, box: [x0, y0, x1, y1] }); }; im.onerror = () => res(null); im.src = 'data:image/png;base64,${b64}'; })`);
}
// 记下屏幕上方出过的提示、刚出现（跳）的圈号（刷新页面后要重新装）
const installLog = () => js(`(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (!t.hidden) window.__toasts.push(t.textContent); })
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true, attributes: true });
  window.__fresh = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType !== 1) continue;
    for (const g of [n, ...n.querySelectorAll('*')]) if (g.classList && g.classList.contains('badge') && g.classList.contains('fresh')) {
      const b = g.querySelector('.bdg'), cs = getComputedStyle(b); window.__fresh.push({ id: g.dataset.id, anim: cs.animationName, n: cs.animationIterationCount }); } } })
  .observe(document.querySelector('#aiRoot'), { childList: true, subtree: true }); return 1; })()`);
await installLog();
const resetLog = () => js(`(window.__toasts = [], window.__fresh = [], 1)`);
const log = () => js(`({ toasts: window.__toasts, fresh: window.__fresh })`);

// ================= 0. 单页（第 2 页另翻过去），第 1 页：两句红笔问题，交上去；Claude 回两条长回答
if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }
await T.tool('red');
await T.pen(T.line(120, 200, 300));
await T.pen(T.line(120, 520, 300));
await T.tool('pen');
await T.tap('#check');
const sub1 = await T.waitSub('S1'), meta1 = sub1 && T.metaOf(sub1);
T.ok('（前提）交上去了：两句红笔', Boolean(meta1) && meta1.groups.length === 2 && meta1.groups.every((g) => g.red), meta1 && meta1.groups);
const LONG = ['先说结论：总价和重量成正比。', '第二句：和店家无关（只要单价一样）。', '$$y = k \\bar{x}$$', '']
  .concat(Array.from({ length: 24 }, (_, k) => `第 ${k + 3} 条理由：单价不变时，买得越多花得越多，称越准越好。`)).join('\n');
await T.post('/bridge/reply', { sid: 'S1', submission: sub1.id, items: [
  { type: 'write', anchor: 'g1', q: '为什么是线性的？', text: LONG },
  { type: 'write', anchor: 'g2', q: '单位对吗？', text: '新的说法：单位是千克。' }] });
T.ok('（前提）两条长回答落下：圈号 1、2', await T.waitFor(`window.__ink.S.page.ai.filter((a) => a.type === 'write').length === 2`, 10000));
await sleep(400);
const w1 = await answerN(1), w2 = await answerN(2);

// ================= 1. 红笔落在卡片里：卡片不收，写在卡片上，纸上不多笔迹；存盘后有 marks 和 sheet
let C = await openBadge(w1.id);
T.ok('（前提）手指点圈号 1：卡片开着', Boolean(C) && C.id === w1.id, C);
const k0 = C.k;
let L1 = await rectOf('#acBody .ac-line');
await T.tool('red');
const n0 = await strokeCount();
await penAt(hline(L1.l + 12, L1.b + 3, 150));
C = await card();
let A = await answerN(1);
T.ok('红笔落在卡片里：卡片没收起', Boolean(C) && C.id === w1.id, C);
T.ok('卡片上多了一笔红字（数据里一笔、卡片上画出一笔），纸上没多笔迹', (A.marks || []).length === 1 && C.marks.length === 1 && (await strokeCount()) === n0,
  [A.marks, C && C.marks.length, await strokeCount(), n0]);
const mA = A.marks[0];
T.ok('这一笔归在主回答那一块（blk a）、红色、坐标是固定宽度下的', mA.blk === 'a' && mA.c === 'r' && mA.pts.length >= 10 && mA.pts.every((p) => p[0] > 0 && p[0] < 440), mA);
const relA = relTo(C.marks[0], L1, C.k);
T.ok('画出来的红字在它批的那一行字下面（离行底不到几个单位）', relA[1] > (L1.b - L1.t) / C.k - 4 && relA[1] < (L1.b - L1.t) / C.k + 8, [relA, L1]);
const SHOT1 = await T.shot('1-card-red.png');
T.ok('存上了', await T.saved());
await sleep(300);
let disk = pageFile().ai.find((a) => a.id === w1.id);
const sheetRow = (sh, blk, txt) => { const b = (sh.blocks || []).find((x) => x.id === blk); const r = b && b.rows.find((x) => x.t && x.t.startsWith(txt)); return b && r ? { b, r } : null; };
let row1 = disk && disk.sheet && sheetRow(disk.sheet, 'a', '先说结论');
T.ok('页面文件里那条回答有 marks 和 sheet（固定宽度 440，主回答那一块里有「先说结论」那一行，有公式的 TeX）', Boolean(disk) && disk.marks.length === 1 && disk.sheet.w === 440 && Boolean(row1)
  && disk.sheet.blocks.some((b) => b.rows.some((r) => r.tex === 'y = k \\bar{x}')), disk && disk.sheet && disk.sheet.blocks.map((b) => [b.id, b.rows.length]));
// （快照里一行的高是字本身的高；行距 1.55 倍，行与行之间约 11 个单位的空：红字写在空里）
T.ok('排版快照和红字对得上：这一笔在「先说结论」那一行字的下边、下一行字的上边', Boolean(row1) && mA.pts[0][1] > row1.r.y + row1.r.h && mA.pts[0][1] < row1.r.y + row1.r.h + 12
  && mA.pts[0][0] > row1.r.x - 2, [mA.pts[0], row1 && row1.r]);

// ================= 2. 黑笔落在卡片里：收起，哪里都不多笔迹；笔落在卡片外：收起，纸上多一笔
await T.tool('pen');
await penAt(hline(C.l + 60, C.t + C.h / 2, 80));
T.ok('黑笔落在卡片里：卡片收起，纸上、卡片上都没多笔迹', (await card()) === null && (await strokeCount()) === n0 && (await answerN(1)).marks.length === 1,
  [await strokeCount(), (await answerN(1)).marks.length]);
C = await openBadge(w1.id);
let [px, py] = await T.screenOf(150, 900);
T.ok('（前提）这一点在卡片外', Boolean(C) && !(px >= C.l && px <= C.r && py >= C.t && py <= C.b), [px, py, C]);
await penAt(hline(px, py, 120));
T.ok('黑笔落在卡片外：卡片收起，纸上照常多一笔', (await card()) === null && (await strokeCount()) === n0 + 1, [await strokeCount(), n0]);

// ================= 3. 手指在卡片里上下滑，红字跟着走；笔刚用过时落下的手指不滑
C = await openBadge(w1.id);
L1 = await rectOf('#acBody .ac-line');
const before3 = relTo(C.marks[0], L1, C.k);
await fingerDrag((C.l + C.r) / 2, C.b - 40, 0, -150);
let C3 = await card();
const L1b = await rectOf('#acBody .ac-line');
T.ok('手指在卡片里往上滑：内容滑上去约 150 像素，卡片还开着', Boolean(C3) && Math.abs(C3.st - C.st - 150) < 4, [C.st, C3 && C3.st]);
T.ok('红字跟着内容一起滑：相对那一行字的位置不变', Boolean(C3) && near(relTo(C3.marks[0], L1b, C3.k), before3) && Math.abs((C3.marks[0].t - C.marks[0].t) + 150) < 4, [before3, C3 && relTo(C3.marks[0], L1b, C3.k)]);
T.ok('纸面没动、纸上没多笔迹', (await strokeCount()) === n0 + 1);
await T.tool('eraser');
await penAt([[(C3.l + C3.r) / 2, C3.b - 30]], 250); // 橡皮在卡片里空白处点一下（这一笔什么都没擦到）：笔刚用过
await fingerDrag((C3.l + C3.r) / 2, C3.b - 40, 0, -150, 6);
const C3b = await card();
T.ok('笔刚用过时（一秒内）落下的手指（手掌）：卡片不滑、也不收', Boolean(C3b) && Math.abs(C3b.st - C3.st) < 1, [C3.st, C3b && C3b.st]);
T.ok('橡皮点在空白处：什么都没擦', (await answerN(1)).marks.every((m) => !m.erasedAt));
// 手掌、手环先搭在纸上（模拟：卡片外的一个触点，晃 6 像素、按住不放）：卡片不收；搭着时红笔在卡片上写：写上，之后手掌再挪也不挪纸、不收卡片
await waitPen();
const vy0 = await S('S.view.ty');
await T.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: px, y: py + 60, id: 7 }] });
await sleep(80);
await T.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: px + 4, y: py + 64, id: 7 }] });
await sleep(600);
T.ok('手掌搭在纸上、晃了一点（不到 24 像素）：卡片不收', Boolean(await card()));
await T.tool('red');
const C3c = await card();
await penAt(hline(C3c.l + 40, (C3c.t + C3c.b) / 2, 80));
await T.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: px + 90, y: py + 160, id: 7 }] });
await sleep(100);
await T.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(300);
T.ok('手掌搭着时红笔在卡片上写：写上了；之后手掌挪了 100 多像素也不挪纸、不收卡片', Boolean(await card()) && (await answerN(1)).marks.length === 2
  && Math.abs((await S('S.view.ty')) - vy0) < 8, [Boolean(await card()), (await answerN(1)).marks.length, await S('S.view.ty'), vy0]);
await T.tap('#toolsUndo'); // 这一笔不留（后面按一笔数）
T.ok('（撤掉这一笔，卡片还开着）', (await answerN(1)).marks.length === 1 && Boolean(await card()));
await T.tool('eraser');

// ================= 4. 橡皮擦卡片上的红字，撤销找回；撤销刚写的一笔；和纸上的笔迹一个撤销次序
await waitPen();
await js(`document.querySelector('#answerCard').scrollTop = 0`);
await sleep(100);
C = await card();
const mm = C.marks[0];
await penAt(hline(mm.l - 4, (mm.t + mm.b) / 2, mm.r - mm.l + 8, 6));
C = await card();
T.ok('橡皮擦到卡片上的红字：擦掉了（数据里记 erasedAt），卡片上不画了，卡片没收', Boolean(C) && C.marks.length === 0 && (await answerN(1)).marks[0].erasedAt > 0, C && C.marks);
await T.tap('#toolsUndo');
C = await card();
T.ok('点撤销：找回来了，卡片还开着', Boolean(C) && C.marks.length === 1 && !(await answerN(1)).marks[0].erasedAt, C && C.marks);
await T.tool('red');
L1 = await rectOf('#acBody .ac-line');
await penAt(hline(L1.l + 30, L1.b + 14, 100));
T.ok('（前提）又写了一笔', (await answerN(1)).marks.length === 2 && (await card()).marks.length === 2);
await T.tap('#toolsUndo');
T.ok('撤销：刚写的那一笔没了，前一笔还在', (await answerN(1)).marks.length === 1 && (await card()).marks.length === 1 && (await answerN(1)).marks[0].id === mA.id);
// 卡片上写一笔、收起、纸上写一笔：撤销先撤纸上的，再撤卡片上的
await penAt(hline(L1.l + 30, L1.b + 14, 100));
await waitPen();
await T.fingerTapAt(px, py + 60);
T.ok('（前提）卡片上两笔，手指点纸上别处：收起', (await card()) === null && (await answerN(1)).marks.length === 2);
await T.tool('pen');
await T.pen(T.line(150, 1000, 150));
const n4 = await strokeCount();
await resetLog();
await T.tap('#toolsUndo');
T.ok('撤销一次：先撤掉纸上刚写的', (await strokeCount()) === n4 - 1 && (await answerN(1)).marks.length === 2);
await T.tap('#toolsUndo');
T.ok('再撤销一次：撤掉卡片上的那一笔（卡片收着，上方说一句）', (await answerN(1)).marks.length === 1 && (await log()).toasts.includes('撤销的是卡片上的红字'), [(await answerN(1)).marks.length, (await log()).toasts]);

// ================= 5. 收起后圈号带红点；刷新后红字还在、位置对
let B1 = await badge(w1.id), B2 = await badge(w2.id);
T.ok('卡片收着：圈号 1 带红点（有还没交的红字），圈号 2 没有', B1.dot && !B2.dot, [B1, B2]);
{
  const z = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: B1.cx - 60, y: B1.cy - 40, width: 120, height: 80, scale: 3 } });
  writeFileSync(join(T.OUT, '2-badge-dot.png'), Buffer.from(z.data, 'base64'));
}
T.ok('存上了', await T.saved());
await T.reload();
await installLog();
T.ok('刷新后：红字还在数据里', (await answerN(1)).marks.length === 1 && (await answerN(1)).marks[0].id === mA.id);
B1 = await badge(w1.id);
T.ok('刷新后：圈号 1 还带红点', Boolean(B1) && B1.dot, B1);
C = await openBadge(w1.id);
L1 = await rectOf('#acBody .ac-line');
T.ok('刷新后打开卡片：红字画出来了，相对那一行字的位置和写的时候一样', Boolean(C) && C.marks.length === 1 && near(relTo(C.marks[0], L1, C.k), relA), [relA, C && relTo(C.marks[0], L1, C.k)]);

// ================= 6. 换一个屏幕大小（横过来）：卡片按固定宽度排版、整体放大，红字还对着原来那一行
await T.cdp('Emulation.setDeviceMetricsOverride', LANDSCAPE);
await sleep(1200);
C = await openBadge(w1.id);
L1 = await rectOf('#acBody .ac-line');
const relL = C && relTo(C.marks[0], L1, C.k);
T.ok('横屏：卡片宽了、整体放大了（缩放倍数变了）', Boolean(C) && Math.abs(C.k - k0) > 0.05 && C.w > 440, [k0, C && C.k, C && C.w]);
T.ok('横屏：红字相对它压着的那一行字的位置不变（固定宽度下的单位）', near(relL, relA), [relA, relL]);
const SHOT4 = await T.shot('4-card-landscape.png');
await T.cdp('Emulation.setDeviceMetricsOverride', PORTRAIT);
await sleep(1200);
[px, py] = await T.screenOf(150, 900);

// ================= 7. 点「AI」：投递里有那张卡片的图，消息里提到它和圈号；交出去后红点没了
await T.fingerTapAt(px, py + 60);
await T.tap('#check');
const sub2 = await T.waitSub('S1'), meta2 = sub2 && T.metaOf(sub2);
const c2 = meta2 && (meta2.cards || [])[0];
T.ok('投递里带着圈号 1 的卡片：一张图，记着这次交的那一笔红字', Boolean(c2) && meta2.cards.length === 1 && c2.n === 1 && c2.id === w1.id && existsSync(c2.img)
  && JSON.stringify(c2.marks) === JSON.stringify([mA.id]), meta2 && meta2.cards);
T.ok('消息里：图的列表里有这张卡片，另有一句「圈号 1 的卡片上我用红笔写了批注，见图……：蓝字是你之前的回答，红字是我写的」和怎么回', Boolean(c2)
  && sub2.text.includes(`- 圈号 1 的卡片：${c2.img}（蓝字是你之前的回答，红字是我在卡片上写的）`)
  && sub2.text.includes(`圈号 1 的卡片上我用红笔写了批注，见图 ${c2.img}：蓝字是你之前的回答，红字是我写的。`) && sub2.text.includes('card 填 1') && sub2.text.includes('先用 Read 看这'),
  sub2 && sub2.text.slice(-700));
if (c2) copyFileSync(c2.img, join(T.OUT, '5-card-image-for-claude.png'));
// 给 Claude 的图：按平板存下的排版画蓝字、叠上红字；红字在「先说结论」那一行下面
disk = pageFile().ai.find((a) => a.id === w1.id);
row1 = sheetRow(disk.sheet, 'a', '先说结论');
const blkA = disk.sheet.blocks.find((b) => b.id === 'a');
const px2 = c2 && await pixels(c2.img, [Math.round((blkA.y + row1.r.y) * 2), Math.round((blkA.y + row1.r.y + row1.r.h) * 2)]);
const wantY = (blkA.y + mA.pts.reduce((s, p) => s + p[1], 0) / mA.pts.length) * 2;
T.ok('给 Claude 的卡片图：宽 880（固定宽度 440 的两倍），有蓝字，「先说结论」那一行有蓝字', Boolean(px2) && px2.w === 880 && px2.blue > 2000 && px2.inBand > 200, px2);
T.ok('给 Claude 的卡片图：有红字，红字在「先说结论」那一行下面、和平板上同一个位置（上下差不到 4 像素）', Boolean(px2) && px2.red > 100 && Math.abs((px2.box[1] + px2.box[3]) / 2 - wantY) < 4
  && px2.box[0] >= (mA.pts[0][0] - 4) * 2 && px2.box[0] <= (mA.pts[0][0] + 4) * 2, [px2 && px2.box, wantY, mA.pts[0]]);
T.ok('交出去了：圈号 1 的红点没了', await T.waitFor(`(() => { const g = document.querySelector('#aiRoot .badge[data-id="${w1.id}"]'); return g && !g.querySelector('.bdot'); })()`, 5000));
T.ok('红字记下了是哪一轮交的（req 是这次的投递编号）', (await answerN(1)).marks[0].req === sub2.id, (await answerN(1)).marks[0]);

// ================= 8. Claude 用带 card 的 write 回：接在卡片下面
await T.saved();
const before8 = await answerN(1);
await resetLog();
const rep = await T.post('/bridge/reply', { sid: 'S1', submission: sub2.id, items: [{ type: 'write', card: 1, q: '这句不对吧', text: '你说得对：应当是「成正比，比例系数是单价 k」。\n第二行：和店家无关。' }] });
T.ok('服务收下了这条回应', rep.ok === true && rep.count === 1, rep);
T.ok('回应接到圈号 1 的卡片下面（more 里一段）', await T.waitFor(`(window.__ink.S.page.ai.find((a) => a.n === 1).more || []).length === 1`, 10000));
await sleep(500);
A = await answerN(1);
const seg = A.more[0];
T.ok('这一段：前面是它回应的那句红字，这一轮交上去的那笔红字记进 on，记着是哪一轮', seg.q === '这句不对吧' && seg.req === sub2.id && JSON.stringify(seg.on) === JSON.stringify([mA.id]) && seg.text.startsWith('你说得对'), seg);
T.ok('上面原来的回答和红字原样不动', A.text === before8.text && A.q === before8.q && JSON.stringify(A.marks) === JSON.stringify(before8.marks));
T.ok('不出新的圈号：还是两条长回答、两个圈号', (await answers()).length === 2 && (await badges()).length === 2);
B1 = await badge(w1.id);
let L8 = await log();
T.ok('圈号 1 变回实心（没看过）、跳了两下', !A.seen && !B1.seen && B1.fill === 'rgb(47, 95, 174)' && L8.fresh.some((f) => f.id === w1.id && f.anim === 'badgeHop' && f.n === '2'), [A.seen, B1, L8.fresh]);
T.ok('屏幕上方说了一句「Claude 回了 1 条」', L8.toasts.includes('Claude 回了 1 条'), L8.toasts);
C = await openBadge(w1.id);
const sg = C && C.segs[0];
T.ok('点开：卡片下面多了一段，前面写着「红字：这句不对吧」', Boolean(sg) && C.segs.length === 1 && sg.mq === '红字：这句不对吧' && sg.text.startsWith('你说得对'), C && C.segs);
T.ok('点开时滑到了新的那一段（那一段的顶在卡片里看得见，卡片滑下去了）', Boolean(sg) && C.st > 100 && sg.t >= C.t - 1 && sg.t < C.b - 20, [C && C.st, sg, C && [C.t, C.b]]);
L1 = await rectOf('#acBody .ac-line');
T.ok('上面的红字没错位：相对「先说结论」那一行和原来一样', Boolean(C) && near(relTo(C.marks[0], L1, C.k), relA), [relA, C && relTo(C.marks[0], L1, C.k)]);
T.ok('点开看过：圈号变空心', (await answerN(1)).seen === true);
const SHOT3 = await T.shot('3-card-reply.png');
await waitPen();
await T.fingerTapAt(px, py + 60);

// ================= 9. 再交一次：那笔红字已经被回应过，不再交
await T.tap('#check');
const sub3 = await T.waitSub('S1'), meta3 = sub3 && T.metaOf(sub3);
T.ok('再点「AI」：没有卡片的图（红字回应过了），消息里不再提卡片上的红字', Boolean(meta3) && !meta3.cards && !sub3.text.includes('卡片上我用红笔'), meta3 && meta3.cards);
T.ok('消息里之前写过的长回答带上了接着的那一段', Boolean(sub3) && sub3.text.includes('- 圈号 1（问：为什么是线性的？）：先说结论') && sub3.text.includes('\n  - 接着（回应红字「这句不对吧」）：你说得对'),
  sub3 && sub3.text.slice(-600));

// ================= 10. 只在卡片上写了红字、纸上没新笔迹的页：几页一起交时也交出去
await T.tool('red');
C = await openBadge(w1.id);
await js(`(() => { const c = document.querySelector('#answerCard'), s = document.querySelector('#acMore .ac-seg'); c.scrollTop += s.getBoundingClientRect().top - c.getBoundingClientRect().top - 10; return 1; })()`);
await sleep(100);
const sgR = await rectOf('#acMore .ac-seg .ac-mbody .ac-line');
await penAt(hline(sgR.l + 10, sgR.b + 3, 90));
T.ok('（前提）在接上的那一段上写了一笔红字：归在那一段（blk 是那一段的 id）', (await answerN(1)).marks.length === 2 && (await answerN(1)).marks[1].blk === seg.id, (await answerN(1)).marks[1]);
const mC = (await answerN(1)).marks[1];
await waitPen();
await T.fingerTapAt(px, py + 60);
T.ok('收起后红点又出来了', (await badge(w1.id)).dot);
await T.saved();
await T.openPage(1);
await T.tool('pen');
await T.pen(T.line(120, 300, 250));
await T.saved();
await T.tap('#check');
const sub4 = await T.waitSub('S1'), meta4 = sub4 && T.metaOf(sub4);
T.ok('第 2 页写了新字、第 1 页只在卡片上写了红字：几页一起交，两页都在', Boolean(meta4) && meta4.kind === 'scan' && Boolean(meta4.pages['1']) && Boolean(meta4.pages['2']), meta4 && Object.keys(meta4.pages || {}));
const img4 = sub4 && (sub4.text.match(/圈号 1 的卡片上我用红笔写了批注，见图 (\S+?)：蓝字是你之前的回答，红字是我写的。/) || [])[1];
T.ok('整本消息里第 1 页有那张卡片的图，说明了带上 page', Boolean(img4) && existsSync(img4) && sub4.text.includes('card 填 1（再带上 page=1）'), sub4 && sub4.text.slice(0, 300));
const px4 = img4 && await pixels(img4);
T.ok('那张图里只画了这次交的那一笔（回应过的不画）：红点在接上的那一段那里', Boolean(px4) && px4.red > 50 && px4.box[1] > (blkA.y + mA.pts[0][1]) * 2 + 40, [px4 && px4.box]);
await T.openPage(0);
T.ok('回到第 1 页：那笔红字记下交过了（整本那一轮），红点没了', await T.waitFor(`(() => { const a = window.__ink.S.page.ai.find((o) => o.n === 1), m = (a.marks || []).find((x) => x.id === ${JSON.stringify(mC.id)});
  const g = document.querySelector('#aiRoot .badge[data-id="${w1.id}"]'); return m && m.req === ${JSON.stringify(sub4 && sub4.id)} && g && !g.querySelector('.bdot'); })()`, 8000),
  (await answerN(1)).marks);

// ================= 11. 带「之前的版本」的卡片（迁移来的旧数据才有）：在旧版上写红字，接上新段后旧版还在最底下、红字没错位
await js(`(() => { const a = window.__ink.S.page.ai.find((o) => o.n === 2); a.older = [{ text: '旧的说法：和店家有关。', t: 1 }]; return 1; })()`);
await T.tool('red');
C = await openBadge(w2.id);
let LO = await rectOf('#acOlist .ac-old .ac-line');
T.ok('（前提）圈号 2 的卡片底下有「之前的版本」', Boolean(C && C.older) && Boolean(LO));
await penAt(hline(LO.l + 6, LO.b + 3, 120));
const mD = (await answerN(2)).marks[0];
T.ok('写在旧版上的红字归在旧版那一块（o0）', Boolean(mD) && mD.blk === 'o0', mD);
C = await card();
const relD = relTo(C.marks[0], LO, C.k);
await waitPen();
await T.fingerTapAt(px, py + 60);
await T.saved();
await T.tap('#check');
const sub5 = await T.waitSub('S1'), meta5 = sub5 && T.metaOf(sub5);
T.ok('交上去：带着圈号 2 的卡片', Boolean(meta5) && (meta5.cards || []).some((c) => c.n === 2), meta5 && meta5.cards);
await T.post('/bridge/reply', { sid: 'S1', submission: sub5.id, items: [{ type: 'write', card: 2, q: '旧的为什么错', text: '旧版把店家当成了主要因素。' }] });
T.ok('接上新的一段', await T.waitFor(`(window.__ink.S.page.ai.find((a) => a.n === 2).more || []).length === 1`, 10000));
await sleep(400);
C = await openBadge(w2.id);
LO = await rectOf('#acOlist .ac-old .ac-line');
T.ok('「之前的版本」还在卡片最底下（在新的一段下面）', Boolean(C && C.older && C.segs.length === 1) && C.older.t >= C.segs[0].b - 1, C && [C.segs, C.older]);
T.ok('旧版上的红字没错位：相对旧版那一行和原来一样', Boolean(C) && near(relTo(C.marks[0], LO, C.k), relD), [relD, C && relTo(C.marks[0], LO, C.k)]);
await waitPen();
await T.fingerTapAt(px, py + 60);

// ================= 12. 手指在卡片里滑过之后，手掌、手环落在卡片外（2026-11-16 用户在平板上碰到：「需要先用手指上划来翻动，
// 但如果接下来是手触碰到屏幕在小标展开外的内容时，还没来得及书写就又关闭了」）。手掌、手环用 CDP 的触摸事件模拟：
// 几个同时按下、略晃的触点，一个很短的触点，一个接触面很大的触点，一个被系统取消的触点——iPad 上真的手掌是几个点、多大、先后隔多久，没在真机上量过
const PALM_GAP = 1700; // 等这么久再试：笔刚用过的一秒里落下的手指一律当手掌（PALM_MS），要让它过去，测到的才是别的几条
const touchEv = (type, pts) => T.cdp('Input.dispatchTouchEvent', { type, touchPoints: pts });
const tp = (p, id, r) => Object.assign({ x: p[0], y: p[1], id }, r ? { radiusX: r, radiusY: r } : {});
const onPaper = (x, y) => js(`(() => { const e = document.elementFromPoint(${x}, ${y}), c = document.querySelector('#answerCard').getBoundingClientRect();
  return Boolean(e) && document.querySelector('#stage').contains(e) && !(${x} >= c.left && ${x} <= c.right && ${y} >= c.top && ${y} <= c.bottom); })()`);
const viewNow = () => S('[S.view.tx, S.view.ty, S.view.s]');
// 手指在卡片里往上滑一段（先滑回顶上，好有地方滑）；返回滑之前和之后的卡片
// 前一项把卡片收了（没修好时）：重新打开，后面几项照样能测
const ensureOpen = async () => { if (!(await card())) await openBadge(w1.id); };
const scrollCard = async () => {
  await ensureOpen();
  await js(`document.querySelector('#answerCard').scrollTop = 0`);
  await sleep(80);
  const c0 = await card();
  await fingerDrag((c0.l + c0.r) / 2, c0.b - 40, 0, -80);
  return [c0, await card()];
};
await js(`(window.__pw = [], document.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') window.__pw.push(Math.max(e.width, e.height)); }, true), 1)`);
await T.tool('red');
C = await openBadge(w1.id);
const vh12 = await js('innerHeight');
const palmY = Math.min(vh12 - 60, C.b + 150), P1 = [C.l + 40, palmY], P2 = [C.l + 110, palmY + 30];
T.ok('（前提）卡片开着；模拟手掌的两点在卡片下面、在纸上', Boolean(C) && (await onPaper(...P1)) && (await onPaper(...P2)), [C, P1, P2]);

// 12.1 手指在卡片里滑 → 紧接着手掌（两个触点同时落下、各晃几个像素、按住）落在卡片外 → 卡片还开着 → 红笔落在卡片里写一笔 → 卡片还开着、这一笔在卡片上
let [c0, c1] = await scrollCard();
T.ok('（前提）手指在卡片里往上滑：内容滑上去了，卡片开着', Boolean(c1) && c1.st > c0.st + 40, [c0.st, c1 && c1.st]);
let v12 = await viewNow(), n12 = await strokeCount(), m12 = (await answerN(1)).marks.length;
await touchEv('touchStart', [tp(P1, 21), tp(P2, 22)]);
for (let k = 1; k <= 4; k++) { await touchEv('touchMove', [tp([P1[0] + k * 2, P1[1] - k], 21), tp([P2[0] + k, P2[1] + k * 2], 22)]); await sleep(40); }
await sleep(300);
T.ok('手指刚在卡片里滑过，手掌（两个触点、略晃）落在卡片外：卡片不收，纸不动', Boolean(await card()) && JSON.stringify(await viewNow()) === JSON.stringify(v12), [Boolean(await card()), v12, await viewNow()]);
let Cw = await card();
if (Cw) await penAt(hline(Cw.l + 40, (Cw.t + Cw.b) / 2, 90));
T.ok('手掌搭着，红笔落在卡片里写一笔：卡片还开着，这一笔在卡片上，纸上没多笔迹', Boolean(await card()) && (await answerN(1)).marks.length === m12 + 1 && (await strokeCount()) === n12,
  [Boolean(await card()), (await answerN(1)).marks.length, m12, await strokeCount(), n12]);
await touchEv('touchMove', [tp([P1[0] + 40, P1[1] - 30], 21), tp([P2[0] + 40, P2[1] - 30], 22)]);
await sleep(60);
await touchEv('touchEnd', []);
await sleep(300);
T.ok('写完手掌挪开、抬起：卡片还开着，纸不动', Boolean(await card()) && JSON.stringify(await viewNow()) === JSON.stringify(v12), [Boolean(await card()), v12, await viewNow()]);

// 12.2 手指在卡片里滑 → 马上用手指在卡片外干净地点一下 → 卡片立刻收起。
// 试过「滑过后 1.5 秒内卡片外的手指一律当手掌、不收」，用户在平板上说不好：「如果是希望收起时用手指点卡片外面无法收起可能会怀疑卡顿或者延迟问题」
await waitPen(); // 笔刚用过的一秒里手指在卡片里滑不动（当手掌），等它过去
[c0, c1] = await scrollCard();
T.ok('（前提）手指又在卡片里滑了一段', Boolean(c1) && c1.st > c0.st + 40, [c0.st, c1 && c1.st]);
await touchEv('touchStart', [tp(P1, 23)]);
await sleep(60);
await touchEv('touchEnd', []);
await sleep(300);
T.ok('手指刚在卡片里滑过，马上用手指干净地点一下卡片外：卡片立刻收起，不用等', (await card()) === null);

// 12.3 没先滑卡片：手掌（两个触点）落下、略晃，卡片也不收、纸不动；搭着时红笔照样写在卡片上
await ensureOpen();
await sleep(PALM_GAP);
v12 = await viewNow(); n12 = await strokeCount(); m12 = (await answerN(1)).marks.length;
await touchEv('touchStart', [tp(P1, 24), tp(P2, 25)]);
for (let k = 1; k <= 5; k++) { await touchEv('touchMove', [tp([P1[0] + k * 2, P1[1] - k * 2], 24), tp([P2[0] - k, P2[1] + k], 25)]); await sleep(40); }
await sleep(400);
T.ok('没先滑卡片，手掌（两个触点，晃 10 来个像素）落在卡片外：卡片不收，纸不动', Boolean(await card()) && JSON.stringify(await viewNow()) === JSON.stringify(v12), [Boolean(await card()), v12, await viewNow()]);
Cw = await card();
if (Cw) await penAt(hline(Cw.l + 40, (Cw.t + Cw.b) / 2 + 30, 90));
await touchEv('touchEnd', []);
await sleep(300);
T.ok('手掌搭着时红笔照样写在卡片上；抬起后卡片还开着', Boolean(await card()) && (await answerN(1)).marks.length === m12 + 1 && (await strokeCount()) === n12,
  [Boolean(await card()), (await answerN(1)).marks.length, m12, await strokeCount(), n12]);

// 12.4 接触面很大的一个触点（像手掌，宽约 120 像素）短促碰一下卡片外：不算轻点；12.5 被系统取消的触点（pointercancel）也不算轻点
await ensureOpen();
await sleep(PALM_GAP);
await js(`(window.__pw = [], 1)`);
await touchEv('touchStart', [tp(P1, 26, 60)]);
await sleep(60);
await touchEv('touchEnd', []);
await sleep(300);
const pw = await js('window.__pw');
T.ok('（前提）浏览器给出了这个触点的接触面（宽或高至少 100 像素）', pw.length === 1 && pw[0] >= 100, pw);
T.ok('接触面很大的触点（像手掌）短促碰一下卡片外：不算轻点，卡片不收', Boolean(await card()));
await ensureOpen();
await touchEv('touchStart', [tp(P1, 27)]);
await sleep(60);
await touchEv('touchCancel', []);
await sleep(300);
T.ok('系统取消的触摸（pointercancel，比如系统认出是手掌）：不算轻点，卡片不收', Boolean(await card()));

// 12.6 原来的不变：手指在卡片里滑过、隔一会儿，手指干净地点一下纸上别处，收起
[c0, c1] = await scrollCard();
await sleep(PALM_GAP);
await T.fingerTapAt(...P1);
T.ok('手指在卡片里滑过、隔一会儿，手指轻点纸上别处：卡片收起', (await card()) === null);
// 单指明确地挪纸：收起，纸挪了
C = await openBadge(w1.id);
v12 = await viewNow();
await fingerDrag(P1[0], P1[1], 0, -60);
T.ok('单指明确地挪纸（60 像素）：卡片收起，纸挪了', (await card()) === null && (await viewNow())[1] !== v12[1], [v12, await viewNow()]);
// 笔落在卡片外：收起，那一笔照常写在纸上（手指刚在卡片里滑过也一样）
C = await openBadge(w1.id);
await scrollCard();
n12 = await strokeCount();
const [qx, qy] = [C.l + 60, Math.min(vh12 - 80, C.b + 60)];
T.ok('（前提）落笔的地方在卡片外、在纸上', await onPaper(qx, qy), [qx, qy, await card()]);
await penAt(hline(qx, qy, 100));
T.ok('手指刚在卡片里滑过，笔落在卡片外：卡片收起，那一笔照常写在纸上', (await card()) === null && (await strokeCount()) === n12 + 1, [await strokeCount(), n12]);
// 点工具条换笔：卡片不收
C = await openBadge(w1.id);
await scrollCard();
const bar = (await T.visible('#rail')) ? '#rail [data-tool=pen]' : '#tools [data-tool=pen]';
await T.tap(bar);
T.ok('手指刚在卡片里滑过，点工具条换黑笔：卡片不收，换上了黑笔', Boolean(await card()) && (await S('S.tool')) === 'pen', [Boolean(await card()), await S('S.tool')]);
// 两指明确地缩放：收起，纸缩放了
await ensureOpen();
await sleep(PALM_GAP);
v12 = await viewNow();
await touchEv('touchStart', [tp(P1, 28), tp([P1[0] + 100, P1[1]], 29)]);
for (let k = 1; k <= 10; k++) { await touchEv('touchMove', [tp([P1[0] - k * 10, P1[1]], 28), tp([P1[0] + 100 + k * 10, P1[1]], 29)]); await sleep(16); }
await touchEv('touchEnd', []);
await sleep(400);
T.ok('两指明确地缩放（间距 100 → 300 像素）：卡片收起，纸放大了', (await card()) === null && (await viewNow())[2] > v12[2] * 1.3, [v12, await viewNow()]);
await T.openPage(0);

console.error('截图：\n' + [SHOT1, join(T.OUT, '2-badge-dot.png'), SHOT3, SHOT4, join(T.OUT, '5-card-image-for-claude.png')].join('\n'));
T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

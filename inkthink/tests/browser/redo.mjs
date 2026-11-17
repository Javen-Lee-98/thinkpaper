// 重做（界面上叫「恢复」，英文 Redo：2026-11-16 夜用户试过后改的名字；原来叫「重做」。2026-11-16 用户定，《产品定义》第 2 节「交互上补的八样」；细节暂定，用户之后在平板上试）。查：
// 撤销旁边一个「恢复」，样子和撤销一样（图标按钮，长按看说明），全屏时在右下角那一条里、退出全屏后在左侧工具栏里；撤销过才能点，否则是灰的；
// 撤销栈里的每一种都能重做：写一笔（连同它压成小蓝点的短批注）、橡皮擦（擦掉的时刻照旧）、星号采纳、✓ × 的决定、卡片上的红字（写和擦）、
// 清除本页 Claude 批注；连着撤几步再连着重做几步，次序对；撤销之后又有新的动作（写了一笔），重做的记录清掉；
// Ctrl+Shift+Z、Ctrl+Y 重做；翻页、连续阅读时跟撤销一样（单页翻走再回来清掉，连续阅读各页各记各的）；重做的结果存上了；
// 右下角那一条多了一个按钮，竖屏宽度下（中文、英文，834 和 744 宽）不出屏幕，拖到最右边、刷新后也不出。
// 笔是 pointerType 为 pen 的鼠标事件，手指是 CDP 的触摸事件（不是 iPad 上真的笔和手）。
// 跑法：node tests/run_browser.mjs <临时目录> --only redo；有一项不对退出码 1。
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'redo', pages: 2 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const waitPen = () => sleep(1150); // 笔刚用过的一秒内手指不算（手掌）
const liveIds = () => S(`S.page.strokes.filter((s) => !s.erasedAt).map((s) => s.id).join()`);
const redoOn = (sel = '#toolsRedo') => js(`!document.querySelector('${sel}').disabled`);
const toastText = () => js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
const item = (type) => S(`S.page.ai.find((a) => a.type === '${type}') || null`);
const seg = (pts, n = 8) => pts.slice(1).flatMap((b, k) => Array.from({ length: n }, (_, i) => [pts[k][0] + ((b[0] - pts[k][0]) * i) / n, pts[k][1] + ((b[1] - pts[k][1]) * i) / n])).concat([pts[pts.length - 1]]);
const star = (cx, cy, R = 22) => seg(Array.from({ length: 6 }, (_, k) => { const t = -Math.PI / 2 + (k * 4 * Math.PI) / 5; return [cx + R * Math.cos(t), cy + R * Math.sin(t)]; }), 10);
const penAt = async (pts, wait = 300) => { // 屏幕坐标上画一笔
  const base = { pointerType: 'pen', button: 'left' };
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: pts[0][0], y: pts[0][1], buttons: 1, clickCount: 1 }, base));
  for (const p of pts.slice(1)) await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: p[0], y: p[1], buttons: 1 }, base));
  const l = pts[pts.length - 1];
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: l[0], y: l[1], buttons: 0, clickCount: 1 }, base));
  await sleep(wait);
};
const hline = (x0, y, len, n = 14) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 0.6]);
const card = () => js(`(() => { const c = document.querySelector('#answerCard'); if (c.hidden) return null; const r = c.getBoundingClientRect();
  return { id: window.__ink.S.card && window.__ink.S.card.id, l: r.left, t: r.top, r: r.right, b: r.bottom, h: r.height,
    marks: [...document.querySelectorAll('#acInk path:not(.live)')].map((p) => { const b = p.getBoundingClientRect(); return { id: p.dataset.id, l: b.left, t: b.top, r: b.right, b: b.bottom }; }) }; })()`);
const key = (k, code, mods) => T.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers: mods, windowsVirtualKeyCode: code.charCodeAt(3) })
  .then(() => T.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mods, windowsVirtualKeyCode: code.charCodeAt(3) })).then(() => sleep(250));
const barRect = () => js(`(() => { const r = document.querySelector('#tools').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight }; })()`);
const inScreen = (r) => r.l >= 0 && r.t >= 0 && r.r <= r.vw && r.b <= r.vh;
// 长按一个图标按钮 0.8 秒：屏幕上方出的说明（这次松手不算点）
async function longPress(sel) {
  await js(`document.querySelector('#toast').hidden = true`);
  const c = await T.centerOf(sel);
  await T.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: c[0], y: c[1], button: 'left', buttons: 1, clickCount: 1 });
  await sleep(800);
  const said = await toastText();
  await T.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c[0], y: c[1], button: 'left', buttons: 0, clickCount: 1 });
  await sleep(400);
  return said;
}

if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); } // 先在单页里测（连续阅读在第 9 步）

// ================= 1. 按钮：全屏时右下角那一条里，紧挨撤销；样子和撤销一样；一开始是灰的、点不了
const btns = await js(`[...document.querySelectorAll('#tools button')].map((b) => b.dataset.tool || b.id).join()`);
T.ok('右下角那一条：撤销后面紧挨着「恢复」', btns === 'toolsBars,pen,red,eraser,lasso,toolsUndo,toolsRedo,check', btns);
const look = (sel) => js(`(() => { const b = document.querySelector('${sel}'), r = b.getBoundingClientRect(), c = getComputedStyle(b), s = b.querySelector('svg');
  return { w: Math.round(r.width), h: Math.round(r.height), bg: c.backgroundColor, border: c.borderTopWidth + ' ' + c.borderTopStyle, radius: c.borderTopLeftRadius, op: Number(c.opacity),
    icon: b.dataset.icon, lines: s ? s.querySelectorAll('path').length : 0, text: b.textContent.trim(), label: b.getAttribute('aria-label'), top: Math.round(r.top) }; })()`);
let U = await look('#toolsUndo'), R = await look('#toolsRedo');
T.ok('「恢复」是图标按钮（有图没有字，说明写「恢复」），和撤销一样大、同一行', R.icon === 'redo' && R.lines === 2 && R.text === '' && R.label === '恢复'
  && R.w === U.w && R.h === U.h && R.top === U.top && R.radius === U.radius && R.border === U.border, [U, R]);
T.ok('还没撤销过：「恢复」是灰的、不能点', !(await redoOn()) && R.op <= 0.5, R);

// ================= 2. 写一笔：撤销、重做；连着撤两步、再连着重做两步，次序对
await T.pen(T.line(120, 200, 300));
await T.pen(T.line(120, 300, 300));
const [sa, sb] = (await liveIds()).split(',');
const ptsB = await S(`JSON.stringify(S.page.strokes.find((s) => s.id === '${sb}').pts)`);
T.ok('（前提）写了两笔', Boolean(sa && sb), await liveIds());
T.ok('写完还没撤销：「恢复」还是灰的', !(await redoOn()));
await T.tap('#toolsUndo');
T.ok('撤销：第二笔没了，「恢复」亮了', (await liveIds()) === sa && (await redoOn()), await liveIds());
R = await look('#toolsRedo');
U = await look('#toolsUndo');
T.ok('亮着的「恢复」和撤销一个样子（不透明、底色、边框一样）', R.op === U.op && R.bg === U.bg && R.border === U.border, [U, R]);
T.ok('长按「恢复」：屏幕上方说「恢复」，松手不做回去', (await longPress('#toolsRedo')) === '恢复' && (await liveIds()) === sa && (await redoOn()), [await toastText(), await liveIds()]);
await T.tap('#toolsRedo');
T.ok('重做：第二笔回来了（同一笔、点一个不差），「恢复」又灰了', (await liveIds()) === `${sa},${sb}` && (await S(`JSON.stringify(S.page.strokes.find((s) => s.id === '${sb}').pts)`)) === ptsB && !(await redoOn()),
  await liveIds());
await T.tap('#toolsUndo');
await T.tap('#toolsUndo');
T.ok('连着撤销两次：两笔都没了', (await liveIds()) === '' && (await redoOn()), await liveIds());
await T.tap('#toolsRedo');
T.ok('重做一次：先回来的是第一笔', (await liveIds()) === sa && (await redoOn()), await liveIds());
await T.tap('#toolsRedo');
T.ok('再重做一次：第二笔也回来了，「恢复」灰了', (await liveIds()) === `${sa},${sb}` && !(await redoOn()), await liveIds());
await T.tap('#toolsRedo');
T.ok('灰的时候点了没用（两笔照旧）', (await liveIds()) === `${sa},${sb}`, await liveIds());

// ================= 3. 撤销之后又写了一笔：重做的记录清掉
await T.tap('#toolsUndo');
T.ok('（前提）撤销了第二笔，「恢复」亮着', (await liveIds()) === sa && (await redoOn()));
await T.pen(T.line(120, 400, 300));
const sc = (await liveIds()).split(',')[1];
T.ok('撤销之后又写了一笔：「恢复」灰了', !(await redoOn()));
await key('y', 'KeyY', 2);
T.ok('这时按 Ctrl+Y 也没用：撤销掉的第二笔不回来，提示「没有可以恢复的」', (await liveIds()) === `${sa},${sc}` && (await toastText()) === '没有可以恢复的', [await liveIds(), await toastText()]);

// ================= 4. 橡皮擦：撤销找回，重做又擦掉（擦掉的时刻照原样）
await T.tool('eraser');
await T.pen([[110, 400], [160, 401], [220, 400]]);
await T.tool('pen');
const at4 = await S(`S.page.strokes.find((s) => s.id === '${sc}').erasedAt || 0`);
T.ok('（前提）橡皮擦掉了第三笔', at4 > 0 && (await liveIds()) === sa, [at4, await liveIds()]);
await T.tap('#toolsUndo');
T.ok('撤销：擦掉的回来了', (await liveIds()) === `${sa},${sc}` && (await redoOn()));
await T.tap('#toolsRedo');
T.ok('重做：又擦掉了，记的还是原来擦的那一刻', (await liveIds()) === sa && (await S(`S.page.strokes.find((s) => s.id === '${sc}').erasedAt`)) === at4,
  [await liveIds(), await S(`S.page.strokes.find((s) => s.id === '${sc}').erasedAt`), at4]);

// ================= 5. Claude 回：一条长回答（圈号）、一条短批注、一条概念图上的新概念（带 ✓ ×）
await T.tool('red');
await T.pen(T.line(120, 560, 260));
await T.tool('pen');
await T.pen(T.line(120, 700, 200));
await T.tap('#check');
const sub = await T.waitSub('S1'), meta = sub && T.metaOf(sub);
const gRed = meta && meta.groups.find((g) => g.red), gBlack = meta && meta.groups.filter((g) => !g.red).pop();
T.ok('（前提）交上去了：有一句红笔、有黑字', Boolean(gRed && gBlack), meta && meta.groups);
await T.post('/bridge/reply', { sid: 'S1', submission: sub.id, items: [
  { type: 'write', anchor: gRed.id, q: '这一步对吗？', text: '对。\n第二行。' },
  { type: 'note', anchor: gBlack.id, text: '这里少了单位' },
  { type: 'node', anchor: gRed.id, text: '新概念', links: [gRed.id] }] });
T.ok('（前提）三条落到这一页', await T.waitFor(`window.__ink.S.page.ai.length === 3`, 10000), await S(`S.page.ai.map((a) => a.type)`));
await sleep(600);
const w = await item('write');

// 5.1 星号采纳（圈号旁画星号）：撤销、重做
await T.pen(star(w.at[0] + 48, w.at[1]));
T.ok('（前提）圈号旁画星号：采纳了', (await item('write')).adopted === true);
await T.tap('#toolsUndo');
T.ok('撤销：不再采纳，「恢复」亮了', !(await item('write')).adopted && (await redoOn()));
await T.tap('#toolsRedo');
T.ok('重做：又采纳了；圈号画成采纳的样子', (await item('write')).adopted === true && (await js(`document.querySelector('#aiRoot .badge[data-id="${w.id}"]').classList.contains('adopted')`)));

// 5.2 ✓ × 的决定：撤销、重做
await js(`(() => { const S = window.__ink.S; window.__ink.setVerdict(S.page.ai.find((a) => a.type === 'node'), 'yes'); return 1; })()`);
T.ok('（前提）新概念点了 ✓', (await item('node')).verdict === 'yes');
await T.tap('#toolsUndo');
T.ok('撤销：回到没定', !(await item('node')).verdict && (await redoOn()));
await T.tap('#toolsRedo');
T.ok('重做：又是 ✓（采纳），画成实线那一种', (await item('node')).verdict === 'yes' && (await js(`document.querySelector('#aiRoot [data-id="${(await item('node')).id}"]').classList.contains('v-yes')`)));

// 5.3 黑笔压到短批注（收成小蓝点）：撤销这一笔，批注展开；重做，这一笔回来、批注又收成小蓝点（还在原来那个位置）
const nb5 = await js(`(() => { const S = window.__ink.S, a = S.page.ai.find((o) => o.type === 'note'); return window.__ink.noteTextBox(a); })()`);
await T.pen(T.line(nb5[0] - 10, (nb5[1] + nb5[3]) / 2, nb5[2] - nb5[0] + 20));
const dot1 = (await item('note')).dot;
T.ok('（前提）黑笔压过短批注：它收成了小蓝点', Boolean(dot1 && dot1.at), dot1);
const sF = (await liveIds()).split(',').pop();
await T.tap('#toolsUndo');
T.ok('撤销这一笔：批注展开回来', !(await item('note')).dot && !(await liveIds()).includes(sF));
await T.tap('#toolsRedo');
const dot2 = (await item('note')).dot;
T.ok('重做：这一笔回来，批注又收成小蓝点，在原来那个位置', (await liveIds()).endsWith(sF) && Boolean(dot2) && JSON.stringify(dot2.at) === JSON.stringify(dot1.at) && dot2.by === sF, [dot1, dot2]);
T.ok('小蓝点画出来了', await js(`Boolean(document.querySelector('#aiRoot .ai-dot[data-id="${(await item('note')).id}"]'))`));

// 5.4 卡片上的红字：写一笔，撤销、重做（卡片开着）；橡皮擦掉，撤销、重做
await waitPen();
const bw = await js(`(() => { const c = document.querySelector('#aiRoot .badge[data-id="${w.id}"] circle').getBoundingClientRect(); return [c.left + c.width / 2, c.top + c.height / 2]; })()`);
await T.fingerTapAt(bw[0], bw[1]);
let C = await card();
T.ok('（前提）点圈号：卡片开着', Boolean(C) && C.id === w.id, C);
const L1 = await js(`(() => { const r = document.querySelector('#acBody .ac-line').getBoundingClientRect(); return { l: r.left, b: r.bottom }; })()`);
await T.tool('red');
await penAt(hline(L1.l + 12, L1.b + 3, 150));
const m1 = ((await item('write')).marks || [])[0];
T.ok('（前提）卡片上写了一笔红字', Boolean(m1) && (await card()).marks.length === 1, await card());
await T.tap('#toolsUndo');
T.ok('撤销：卡片上那一笔没了，卡片还开着', ((await item('write')).marks || []).length === 0 && (await card()).marks.length === 0 && (await redoOn()));
await T.tap('#toolsRedo');
C = await card();
T.ok('重做：那一笔回到卡片上（同一笔），卡片还开着', Boolean(C) && C.marks.length === 1 && C.marks[0].id === m1.id && JSON.stringify((await item('write')).marks[0].pts) === JSON.stringify(m1.pts), C);
await T.tool('eraser');
const mm = C.marks[0];
await penAt(hline(mm.l - 4, (mm.t + mm.b) / 2, mm.r - mm.l + 8, 6));
const at54 = (await item('write')).marks[0].erasedAt || 0;
T.ok('（前提）橡皮擦掉了卡片上的红字', at54 > 0 && (await card()).marks.length === 0);
await T.tap('#toolsUndo');
T.ok('撤销：找回来了', !(await item('write')).marks[0].erasedAt && (await card()).marks.length === 1);
await T.tap('#toolsRedo');
T.ok('重做：又擦掉了（擦的时刻照旧），卡片还开着', (await item('write')).marks[0].erasedAt === at54 && (await card()).marks.length === 0, (await item('write')).marks[0]);
await T.tap('#toolsUndo'); // 红字留着（下面收着卡片时撤销、重做要说一句）
await T.tool('pen');
await waitPen();
await T.fingerTapAt(120, 1050);
T.ok('（前提）卡片收起了', (await card()) === null);
await T.tap('#toolsUndo');
T.ok('卡片收着时撤销卡片上的那一笔：说「撤销的是卡片上的红字」', ((await item('write')).marks || []).length === 0 && (await toastText()) === '撤销的是卡片上的红字', await toastText());
await T.tap('#toolsRedo');
T.ok('卡片收着时重做：那一笔回到卡片上，说「恢复的是卡片上的红字」', (await item('write')).marks.length === 1 && (await toastText()) === '恢复的是卡片上的红字', await toastText());
await T.tap('#toolsRedo');
T.ok('（接着重做刚才那次擦）', (await item('write')).marks[0].erasedAt === at54);
await T.tap('#toolsUndo');

// 5.5 清除本页 Claude 批注：撤销整页回来，重做整页又清掉（清的时刻照旧）
await js(`(window.confirm = () => true, document.querySelector('#actClearAi').click(), 1)`);
await sleep(300);
const cleared = await S(`S.page.ai.map((a) => a.erasedAt || 0)`);
T.ok('（前提）清除本页 Claude 批注：三条都清掉了', cleared.length === 3 && cleared.every((t) => t > 0), cleared);
await T.tap('#toolsUndo');
T.ok('撤销：三条都回来了（采纳、✓、小蓝点照旧）', (await S(`S.page.ai.every((a) => !a.erasedAt)`)) && (await item('write')).adopted && (await item('node')).verdict === 'yes' && Boolean((await item('note')).dot));
await T.tap('#toolsRedo');
T.ok('重做：三条又清掉了，记的是原来清的那一刻', JSON.stringify(await S(`S.page.ai.map((a) => a.erasedAt || 0)`)) === JSON.stringify(cleared) && (await S(`S.page.ai.every((a) => a.dismissed)`)),
  await S(`S.page.ai.map((a) => a.erasedAt || 0)`));
T.ok('纸上不画了', (await T.count('#aiRoot .ai-item')) === 0, await T.count('#aiRoot .ai-item'));
await T.tap('#toolsUndo');
T.ok('（再撤销一次，批注回来）', await S(`S.page.ai.every((a) => !a.erasedAt)`));

// ================= 6. 键盘：Ctrl+Z 撤销，Ctrl+Shift+Z、Ctrl+Y 重做
await T.pen(T.line(120, 900, 200));
const sK = (await liveIds()).split(',').pop();
await key('z', 'KeyZ', 2);
T.ok('Ctrl+Z：撤销', !(await liveIds()).includes(sK));
await key('Z', 'KeyZ', 2 | 8);
T.ok('Ctrl+Shift+Z：重做', (await liveIds()).endsWith(sK));
await key('z', 'KeyZ', 2);
await key('y', 'KeyY', 2);
T.ok('Ctrl+Y：重做', (await liveIds()).endsWith(sK));

// ================= 7. 重做的结果存上了；刷新后在（撤销、重做记录本来就不跨刷新）
T.ok('存上了', await T.saved());
await sleep(300);
const disk = T.pageFile('scratch', 0);
T.ok('页面文件里：重做回来的那几笔在、重做擦掉的那一笔是擦掉的', [sa, sF, sK].every((id) => disk.strokes.some((s) => s.id === id && !s.erasedAt)) && disk.strokes.some((s) => s.id === sc && s.erasedAt === at4),
  disk.strokes.map((s) => [s.id, s.erasedAt || 0]));

// ================= 8. 单页：翻走再回来，撤销和重做的记录都清掉（和撤销一样）
await T.tap('#toolsUndo');
T.ok('（前提）撤销了一步，「恢复」亮着', await redoOn());
await T.openPage(1);
T.ok('翻到第 2 页：「恢复」灰了（那一页没撤销过）', !(await redoOn()));
await T.openPage(0);
T.ok('单页翻回第 1 页：「恢复」还是灰的（单页翻页时撤销记录本来就清掉）', !(await redoOn()) && (await S('S.undo.length')) === 0);

// ================= 9. 连续阅读：每页各记各的，翻走再回来，「恢复」还亮着、照样能重做
await js(`window.__ink.toggleFlow()`);
await sleep(1000);
await T.openPage(0);
await T.pen(T.line(120, 980, 200));
const s9 = (await liveIds()).split(',').pop();
await T.tap('#toolsUndo');
T.ok('（前提）连续阅读：写一笔、撤销，「恢复」亮着', (await redoOn()) && !(await liveIds()).includes(s9));
await T.openPage(1);
T.ok('翻到第 2 页：「恢复」灰了', !(await redoOn()));
await T.openPage(0);
T.ok('回到第 1 页：「恢复」又亮了', await redoOn());
await T.tap('#toolsRedo');
T.ok('重做：那一笔回来了', (await liveIds()).endsWith(s9));

// ================= 10. 退出全屏：左侧工具栏里撤销下面是「恢复」，和撤销一样；照样能用
await T.tap('#toolsBars');
const rail = await js(`[...document.querySelectorAll('#rail button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.dataset.tool || b.id).join()`);
T.ok('左侧工具栏：撤销下面紧挨着「恢复」', rail === 'pen,red,eraser,lasso,undo,redo,fsBtn', rail);
U = await look('#undo');
R = await look('#redo');
T.ok('左侧的「恢复」是图标按钮，和撤销一样大；这时是灰的（刚重做完）', R.icon === 'redo' && R.lines === 2 && R.text === '' && R.label === '恢复' && R.w === U.w && R.h === U.h && R.op <= 0.5 && !(await redoOn('#redo')), [U, R]);
await T.tap('#undo');
T.ok('点左侧的撤销：左侧的「恢复」亮了', (await redoOn('#redo')) && !(await liveIds()).includes(s9));
await T.tap('#redo');
T.ok('点左侧的「恢复」：那一笔回来了', (await liveIds()).endsWith(s9) && !(await redoOn('#redo')));
await T.tap('#fsBtn');

// ================= 11. 右下角那一条多了一个按钮：竖屏宽度下不出屏幕；拖到最右边、刷新后也不出
let br = await barRect();
T.ok('竖屏（834 宽）：右下角那一条整个在屏幕里', inScreen(br), br);
const grip = await T.centerOf('#toolsGrip');
await T.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip[0], y: grip[1], button: 'left', buttons: 1, clickCount: 1 });
for (let k = 1; k <= 8; k++) await T.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip[0] + k * 120, y: grip[1] - k * 10, button: 'left', buttons: 1 });
await T.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip[0] + 960, y: grip[1] - 80, button: 'left', buttons: 0, clickCount: 1 });
await sleep(300);
br = await barRect();
T.ok('按住把手往右拖过了头：停在屏幕右边里面', inScreen(br) && br.r > br.vw - 10, br);
await T.reload();
br = await barRect();
T.ok('刷新后摆回拖到的位置，还在屏幕里', inScreen(br) && br.r > br.vw - 10, br);
await T.cdp('Emulation.setDeviceMetricsOverride', { width: 744, height: 1133, deviceScaleFactor: 1, mobile: true });
await sleep(1000);
br = await barRect();
T.ok('窄一点的竖屏（744 宽）：还在屏幕里', inScreen(br), br);
await T.go('&lang=en');
await sleep(800);
br = await barRect();
T.ok('英文界面（字更长）、744 宽：还在屏幕里', inScreen(br), br);
T.ok('英文界面：「恢复」的说明是 Redo（右下角那一条和左侧工具栏上的两个都是）', (await js(`document.querySelector('#toolsRedo').getAttribute('aria-label')`)) === 'Redo'
  && (await js(`document.querySelector('#redo').getAttribute('aria-label')`)) === 'Redo',
  await js(`[document.querySelector('#toolsRedo').getAttribute('aria-label'), document.querySelector('#redo').getAttribute('aria-label')]`));
T.ok('英文界面：两句提示是 Nothing to redo、Redid red ink on an answer card', (await js(`window.InkLang.t('没有可以恢复的')`)) === 'Nothing to redo'
  && (await js(`window.InkLang.t('恢复的是卡片上的红字')`)) === 'Redid red ink on an answer card');
await T.pen(T.line(120, 1100, 200));
await T.tap('#toolsUndo');
T.ok('英文界面：长按「恢复」，屏幕上方说 Redo', (await longPress('#toolsRedo')) === 'Redo', await toastText());
// 「显示已删的页」里把页放回来的按钮（2026-11-16 夜起叫「还原」，以前也叫「恢复」）：英文是 Restore，不跟着变成 Redo
await T.api('/api/page/delete', { method: 'POST', body: JSON.stringify({ nb: 'scratch', i: 1 }) });
await T.go('&lang=en');
await T.tap('#nbChip', 700);
await js(`document.querySelector('#actHidden').scrollIntoView({ block: 'nearest' })`);
await T.tap('#actHidden', 800);
const restoreBtn = await js(`[...document.querySelectorAll('#hiddenList button')].map((b) => b.textContent.trim()).join()`);
T.ok('英文界面：已删页列表里的按钮是 Restore（不是 Redo）', restoreBtn === 'Restore', restoreBtn);
await T.tap('#nbChip', 600);
await T.cdp('Emulation.setDeviceMetricsOverride', { width: 834, height: 1194, deviceScaleFactor: 1, mobile: true });
await sleep(800);
br = await barRect();
T.ok('英文界面、834 宽：还在屏幕里', inScreen(br), br);
await T.shot('redo-toolbar-en.png');

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

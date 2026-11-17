// 新手引导（阶段 D2，《产品定义》第 7 节第 5 条）：一屏标注。真实的按钮旁各浮一个小标签（细线连到按钮），中间一张短说明；
// 第一次打开出一次（记在这台设备上），点「知道了」或落第一笔就消失（那一笔照常写上），点任何真实的按钮照常起作用、引导同时消失；
// 搭在纸上的手指不算；之后在「⋯」菜单和抽屉最下面能再看。标签跟着当时真在屏幕上的按钮：全屏时（打开时的样子）是左上角那一排
// 和右下角那一条（拖到哪儿跟到哪儿），退出全屏时是顶栏和左侧工具栏；转屏后重排。中文、英文两种界面。
// 这里量的是：每个标签都在、写的字对、连线一头在按钮上一头在标签上、离按钮不远；标签之间、标签和按钮之间不重叠；连线不穿过别的标签；
// 都在屏幕里；中间的说明不压标签。截图存在 <临时目录>/guide/out/ 下。
// 跑法：node tests/browser/guide.mjs [临时目录]；有一项不对退出码 1。
import { boot } from '../browser_lib.mjs';

const T = await boot({ name: 'guide', pages: 3, guide: true });
const js = T.evalJS;

// ---- 小工具
const shown = () => js(`!document.querySelector('#guide').hidden`);
const seen = () => js(`localStorage.getItem('inkthink.guideSeen')`);
// 引导这一层量出来的样子：标签（哪个按钮、字、屏幕上的框）、连线、中间的说明
const layout = () => js(`(() => {
  const R = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
  return {
    tags: [...document.querySelectorAll('#guideTags .g-tag')].map((t) => ({ key: t.dataset.for, text: t.textContent, b: R(t) })),
    lines: [...document.querySelectorAll('#guideLines line')].map((l) => ({ key: l.dataset.for, s: ['x1', 'y1', 'x2', 'y2'].map((k) => Number(l.getAttribute(k))) })),
    card: R(document.querySelector('#guideCard')), vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight };
})()`);
// 这几个元素里看得见的合起来的框（和页面里 shownRect 一样）
const rectOf = (sel) => js(`(() => { let o = null; for (const e of document.querySelectorAll(${JSON.stringify(sel)})) {
  if (e.hidden || e.closest('[hidden]') || !e.getClientRects().length) continue; const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
  const b = [r.left, r.top, r.right, r.bottom]; o = o ? [Math.min(o[0], b[0]), Math.min(o[1], b[1]), Math.max(o[2], b[2]), Math.max(o[3], b[3])] : b; } return o; })()`);
const meet = (a, b, m = 0) => a[0] < b[2] + m && b[0] < a[2] + m && a[1] < b[3] + m && b[1] < a[3] + m;
const inside = (p, b, m = 3) => p[0] >= b[0] - m && p[0] <= b[2] + m && p[1] >= b[1] - m && p[1] <= b[3] + m;
const gapOf = (a, b) => Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
const crosses = (s, b, m = 2) => { for (let i = 1; i < 40; i++) { const x = s[0] + ((s[2] - s[0]) * i) / 40, y = s[1] + ((s[3] - s[1]) * i) / 40; if (x > b[0] + m && x < b[2] - m && y > b[1] + m && y < b[3] - m) return true; } return false; };

const ZH = { menu: '本子和页面', turn: '翻页', pair: '单页 / 连续', add: '加一页', more: '更多', grip: '按住拖动', bars: '显示工具栏', full: '只留纸',
  pen: '黑笔', red: '红笔', eraser: '橡皮', lasso: '套索', undo: '撤销', check: '交给 Claude' };
const EN = { menu: 'Notebooks and pages', turn: 'Turn pages', pen: 'Black pen', red: 'Red pen', eraser: 'Eraser', lasso: 'Lasso', undo: 'Undo', check: 'Hand to Claude', bars: 'Show the toolbars' };
// 全屏（左上角那一排、右下角那一条）和退出全屏（顶栏、左侧工具栏）时各有哪些按钮
const FULL = [['menu', '#nbChip .chip-menu'], ['turn', '#chipPrev, #chipNext'], ['pair', '#chipPair'], ['add', '#chipAdd'], ['grip', '#toolsGrip'], ['bars', '#toolsBars'],
  ['pen', '#tools [data-tool=pen]'], ['red', '#tools [data-tool=red]'], ['eraser', '#tools [data-tool=eraser]'], ['lasso', '#tools [data-tool=lasso]'], ['undo', '#toolsUndo'], ['check', '#check']];
const BARS = [['pen', '#rail [data-tool=pen]'], ['red', '#rail [data-tool=red]'], ['eraser', '#rail [data-tool=eraser]'], ['lasso', '#rail [data-tool=lasso]'], ['undo', '#undo'], ['full', '#fsBtn'],
  ['menu', '#drawerBtn'], ['turn', '#prev, #next'], ['pair', '#barPair'], ['add', '#barAdd'], ['check', '#barCheck'], ['more', '#menuBtn']];
const PANELS = { full: ['#chipRow', '#tools'], bars: ['#bar', '#rail'] };

// 量一遍：must 是一定要有标签的按钮；words 是标签上该写的字
async function checkLayout(label, list, panels, must, words) {
  await T.sleep(500); // 每 0.4 秒量一次：等它排好
  const L = await layout(), bad = [];
  const buttons = [];
  for (const [key, sel] of list) { const r = await rectOf(sel); if (r) buttons.push({ key, r }); }
  const pr = (await Promise.all(panels.map(rectOf))).filter(Boolean);
  for (const k of must) if (!buttons.some((b) => b.key === k)) bad.push(`屏幕上没有 ${k} 这个按钮`);
  for (const b of buttons) {
    const t = L.tags.find((x) => x.key === b.key), ln = L.lines.find((x) => x.key === b.key);
    if (!t) { bad.push(`${b.key} 没有标签`); continue; }
    if (words[b.key] && t.text !== words[b.key]) bad.push(`${b.key} 的标签写着「${t.text}」`);
    if (!ln) { bad.push(`${b.key} 没有连线`); continue; }
    if (!inside([ln.s[0], ln.s[1]], b.r)) bad.push(`${b.key} 的连线不从按钮出发 ${JSON.stringify([ln.s, b.r])}`);
    if (!inside([ln.s[2], ln.s[3]], t.b)) bad.push(`${b.key} 的连线没连到标签 ${JSON.stringify([ln.s, t.b])}`);
    if (gapOf(t.b, b.r) > 180) bad.push(`${b.key} 的标签离按钮 ${Math.round(gapOf(t.b, b.r))}px`);
  }
  for (const t of L.tags) {
    if (t.b[0] < 0 || t.b[1] < 0 || t.b[2] > L.vw || t.b[3] > L.vh) bad.push(`${t.key} 的标签出了屏幕`);
    for (const o of buttons.map((b) => b.r).concat(pr)) if (meet(t.b, o, -1)) bad.push(`${t.key} 的标签压着按钮或那一排 ${JSON.stringify([t.b, o])}`);
    for (const u of L.tags) if (u !== t && meet(t.b, u.b, -1)) bad.push(`${t.key} 和 ${u.key} 的标签叠着`);
    for (const ln of L.lines) if (ln.key !== t.key && crosses(ln.s, t.b)) bad.push(`${ln.key} 的连线穿过 ${t.key} 的标签`);
    if (meet(t.b, L.card, -1)) bad.push(`中间的说明压着 ${t.key} 的标签`);
  }
  if (L.card[0] < 0 || L.card[2] > L.vw || L.card[1] < 0 || L.card[3] > L.vh) bad.push('中间的说明出了屏幕');
  T.ok(label, bad.length === 0, { bad: [...new Set(bad)].slice(0, 12), tags: L.tags.map((t) => t.key) });
  return L;
}
// 用笔在纸上画一笔（页面坐标）
const strokes = () => T.strokes();
// 打开抽屉（全屏时点左上角的本子名），滚到最下面，点「再看一遍新手引导」
async function reopenFromDrawer() {
  if (!(await T.visible('#drawer'))) await T.tap((await T.visible('#nbChip')) ? '#nbChip' : '#drawerBtn', 600);
  await js(`document.querySelector('#actGuide2').scrollIntoView({ block: 'nearest' })`);
  await T.sleep(200);
  await T.tap('#actGuide2', 600);
}

// 1. 第一次打开（全屏的样子）：引导出来，标签贴着左上角那一排和右下角那一条
T.ok('第一次打开：新手引导出来了', (await T.waitFor(`!document.querySelector('#guide').hidden`, 5000)) && (await js(`window.__ink.S.collapsed`)), await shown());
T.ok('还没点过「知道了」：这台设备上没记「看过了」', (await seen()) === null, await seen());
const card = await js(`document.querySelector('#guideCard').innerText`);
T.ok('中间的说明：黑笔、红笔、AI、蓝字和圈号都讲了', ['黑笔', '红笔', 'AI', '蓝字', '圈号', '知道了'].every((w) => card.includes(w)), card);
await checkLayout('全屏：每个按钮旁一个标签，字对、线连着、离得近、不叠、不压按钮', FULL, PANELS.full, ['menu', 'turn', 'pen', 'red', 'eraser', 'lasso', 'undo', 'check', 'bars'], ZH);
await T.shot('guide-full-zh.png');

// 2. 点「知道了」：消失，记下看过了；刷新后不再出来
await T.tap('#guideOk');
T.ok('点「知道了」：引导消失，记下看过了', !(await shown()) && (await seen()) === 'true', [await shown(), await seen()]);
await T.reload();
T.ok('刷新后不再出来', !(await shown()), await shown());

// 3. 从抽屉最下面再看一遍；用手指点纸不算；用笔落第一笔：引导消失，那一笔照常写上
await reopenFromDrawer();
T.ok('抽屉最下面「再看一遍新手引导」：引导出来，抽屉收起', (await shown()) && !(await T.visible('#drawer')), [await shown(), await T.visible('#drawer')]);
const fp = await T.screenOf(500, 700);
await T.fingerTapAt(fp[0], fp[1]);
T.ok('手指搭在纸上（没开「手指也能书写」）：引导还在', await shown(), await shown());
const n0 = await strokes();
await T.pen(T.line(200, 640, 260));
T.ok('用笔落第一笔：引导消失，这一笔写上了', !(await shown()) && (await strokes()) === n0 + 1, [await shown(), n0, await strokes()]);

// 4. 引导开着时点真实的按钮（右下角的红笔）：红笔选上了，引导同时消失
await reopenFromDrawer();
await T.tap('#tools [data-tool=red]');
T.ok('点右下角的红笔：换成了红笔，引导消失', !(await shown()) && (await js(`window.__ink.S.tool`)) === 'red', [await shown(), await js(`window.__ink.S.tool`)]);
await T.tap('#tools [data-tool=pen]');

// 5. 右下角那一条拖到左上方：再打开引导，那几个标签跟着它
const g0 = await T.centerOf('#toolsGrip');
const to = [120, 300];
await T.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: g0[0], y: g0[1], button: 'left', buttons: 1, clickCount: 1 });
for (let i = 1; i <= 10; i++) await T.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g0[0] + ((to[0] - g0[0]) * i) / 10, y: g0[1] + ((to[1] - g0[1]) * i) / 10, button: 'left', buttons: 1 });
await T.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to[0], y: to[1], button: 'left', buttons: 0, clickCount: 1 });
await T.sleep(300);
const moved = await rectOf('#tools');
T.ok('右下角那一条拖到了左上方', Boolean(moved) && moved[1] < 400 && moved[0] < 200, moved);
await reopenFromDrawer();
const Lm = await checkLayout('拖过的那一条：标签跟着它，照样不叠不压', FULL, PANELS.full, ['pen', 'red', 'check'], ZH);
const penTag = Lm.tags.find((t) => t.key === 'pen');
T.ok('黑笔的标签就在挪过去的那一条旁边', Boolean(penTag) && gapOf(penTag.b, moved) < 120, [penTag, moved]);
await T.shot('guide-full-moved.png');
// 开着时那一条又挪了（这里直接改位置，拖把手会先收起引导）：0.4 秒内标签跟过去
await js(`(() => { const b = document.querySelector('#tools'); b.style.left = '400px'; b.style.top = '700px'; })()`);
const moved2 = await rectOf('#tools');
await checkLayout('开着时那一条挪了：标签跟着重排', FULL, PANELS.full, ['pen', 'red', 'check'], ZH);
const penTag2 = (await layout()).tags.find((t) => t.key === 'pen');
T.ok('黑笔的标签跟到了新位置旁边', Boolean(penTag2) && gapOf(penTag2.b, moved2) < 120, [penTag2, moved2]);
await T.tap('#guideOk');
// 那一条放回右下角（清掉记着的位置）
await js(`localStorage.removeItem('inkthink.toolsPos')`);
await T.reload();

// 6. 退出全屏（顶栏和左侧工具栏）：从「⋯」菜单再看一遍
await T.tap('#toolsBars', 800);
T.ok('退出全屏了', !(await js(`window.__ink.S.collapsed`)), await js(`window.__ink.S.collapsed`));
await T.tap('#menuBtn');
T.ok('「⋯」菜单里有「再看一遍新手引导」', (await T.visible('#actGuide')) && (await T.text('#actGuide')) === '再看一遍新手引导', await T.text('#actGuide'));
await T.tap('#actGuide', 600);
T.ok('点了：引导出来，菜单收起', (await shown()) && !(await T.visible('#menu')), [await shown(), await T.visible('#menu')]);
await checkLayout('退出全屏：顶栏和左侧工具栏的按钮旁各一个标签，不叠、不压按钮', BARS, PANELS.bars, ['menu', 'turn', 'pen', 'red', 'eraser', 'lasso', 'undo', 'check', 'full', 'more'], ZH);
await T.shot('guide-bars-zh.png');
// 点顶栏的下一页：翻过去了，引导消失
const idx0 = await js(`window.__ink.S.idx`);
await T.tap('#next', 900);
T.ok('点顶栏的「›」：翻到下一页，引导消失', !(await shown()) && (await js(`window.__ink.S.idx`)) === idx0 + 1, [await shown(), idx0, await js(`window.__ink.S.idx`)]);

// 7. 转成横屏：开着的引导重排
await js(`window.__ink.openGuide()`);
await T.cdp('Emulation.setDeviceMetricsOverride', { width: 1194, height: 834, deviceScaleFactor: 1, mobile: true });
await T.sleep(800);
await checkLayout('横屏（退出全屏）：重排后照样贴着按钮、不叠', BARS, PANELS.bars, ['menu', 'pen', 'check'], ZH);
await T.cdp('Emulation.setDeviceMetricsOverride', { width: 834, height: 1194, deviceScaleFactor: 1, mobile: true });
await T.sleep(800);
// Esc 也能收起（接了键盘时）
await T.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await T.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await T.sleep(300);
T.ok('按 Esc：引导消失', !(await shown()), await shown());

// 8. 英文界面、在一台没看过的设备上第一次打开（回到全屏的样子）
await T.tap('#fsBtn', 800);
await js(`localStorage.removeItem('inkthink.guideSeen')`);
await T.go('&lang=en');
T.ok('英文界面第一次打开：引导出来', await T.waitFor(`!document.querySelector('#guide').hidden`, 5000), await shown());
const cardEn = await js(`document.querySelector('#guideCard').innerText`);
T.ok('英文的说明：没有中文', !/[㐀-鿿]/.test(cardEn) && /Black pen/.test(cardEn) && /Got it/.test(cardEn), cardEn);
await checkLayout('英文：标签是英文，照样不叠、不压按钮、连着按钮', FULL, PANELS.full, ['menu', 'pen', 'red', 'check'], EN);
await T.shot('guide-full-en.png');
await T.tap('#guideOk');
T.ok('英文界面点「Got it」：消失', !(await shown()) && (await seen()) === 'true', [await shown(), await seen()]);

await T.finish();

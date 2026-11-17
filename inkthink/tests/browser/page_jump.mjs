// 输入页码翻页（2026-11-16 夜用户定，《产品定义》第 2 节；细节暂定，用户之后在平板上试）。查：
// 点页码（全屏时左上角「☰ 本子名 页码」里的页码那几个字，退出全屏后顶栏上 ‹ › 中间的「3/12」）出一个小框：只输数字的输入框
// （inputmode=numeric，平板上出数字键盘）加「去」；输入 1 到总页数之间的数翻到那一页，超出范围时框里说一句、不翻；
// 回车也算「去」（不会当成点「AI」）；☰ 和本子名照旧开抽屉；框在页码下面、屏幕上方（键盘从下面弹出挡不住）、整个在屏幕里；
// 从别处跳过来的（这里用输入页码跳），框里多一行「回到第 N 页」，按页的键记（插页后还对），点了回去；
// 点框外面、再点页码、Esc 收起；只有一页的本子点页码不出；连续阅读也能跳；英文界面、744 宽也放得下。
// 别处跳过来的另外几种（点新回答的记号、小单子、卡片里跨页）在 new_answers.mjs、card_nav.mjs 里查「回到第 N 页」。
// 只在无头 Edge 里用合成的点按、键盘事件跑过：iPad 上数字键盘弹出来以后框在不在原处、会不会被系统挪动，这里测不到。
// 跑法：node tests/run_browser.mjs <临时目录> --only page_jump；有一项不对退出码 1。
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'page-jump', pages: 12 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const box = () => js(`(() => { const b = document.querySelector('#pageJump'); if (b.hidden) return null; const r = b.getBoundingClientRect(), i = document.querySelector('#pjInput'),
  e = document.querySelector('#pjErr'), k = document.querySelector('#pjBack'), row = document.querySelector(window.__ink.S.collapsed ? '#chipRow' : '#bar').getBoundingClientRect();
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, vw: document.documentElement.clientWidth, vh: innerHeight, rowBottom: row.bottom,
    text: b.querySelector('.pj-row').textContent.trim(), total: document.querySelector('#pjTotal').textContent, go: document.querySelector('#pjGo').textContent,
    mode: i.getAttribute('inputmode'), type: i.type, focused: document.activeElement === i, ph: i.placeholder, value: i.value, font: parseFloat(getComputedStyle(i).fontSize),
    err: e.hidden ? null : e.textContent, back: k.hidden ? null : k.textContent,
    fits: [...b.querySelectorAll('button, input, span')].filter((x) => x.getClientRects().length).every((x) => { const q = x.getBoundingClientRect(); return q.right <= r.right + 0.5 && q.left >= r.left - 0.5; }) }; })()`);
const inScreen = (B) => Boolean(B) && B.l >= 0 && B.r <= B.vw && B.t >= 0 && B.b <= B.vh;
const drawerOpen = () => T.visible('#drawer');
const type = async (s) => { await js(`(() => { const i = document.querySelector('#pjInput'); i.focus(); i.value = ''; return 1; })()`); if (s) await T.cdp('Input.insertText', { text: s }); await sleep(100); };
const key = (k, code) => T.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: k === 'Enter' ? 13 : 27 })
  .then(() => T.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: k === 'Enter' ? 13 : 27 })).then(() => sleep(300));
const at = (i) => T.waitFor(`window.__ink.S.page && window.__ink.S.idx === ${i}`, 6000);

if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); } // 先在单页里测（连续阅读在第 8 步）

// ================= 1. 全屏：左上角「☰ 本子名 页码」——☰、本子名开抽屉；页码出小框、不开抽屉
const chipLook = await js(`(() => { const p = document.querySelector('#chipPage'), c = getComputedStyle(p); return { text: p.textContent, border: c.borderTopWidth + ' ' + c.borderTopStyle }; })()`);
T.ok('全屏时左上角的页码写「1/12」，单独圈着一个细框（看得出和本子名不是一个东西）', chipLook.text === '1/12' && chipLook.border === '1px solid', chipLook);
await T.tap('#nbChip .chip-menu', 600);
T.ok('点 ☰：开抽屉，没出小框', (await drawerOpen()) && !(await box()));
await T.tap('#nbChip .chip-menu', 600);
await T.tap('#chipName', 600);
T.ok('点本子名：开抽屉，没出小框', (await drawerOpen()) && !(await box()));
await T.tap('#chipName', 600);
T.ok('（再点本子名：抽屉收起）', !(await drawerOpen()));
await T.tap('#chipPage', 500);
let B = await box();
T.ok('点页码：出小框，不开抽屉', Boolean(B) && !(await drawerOpen()), B);
T.ok('小框：「翻到第 [  ] 页（共 12 页）」和「去」；输入框只收数字（inputmode=numeric），已经点进去了，空着、浅字写着现在的第 1 页',
  Boolean(B) && B.text.startsWith('翻到第') && B.total === '页（共 12 页）' && B.go === '去' && B.mode === 'numeric' && B.type === 'text' && B.focused && B.value === '' && B.ph === '1', B);
T.ok('输入框的字不小于 16 像素（iPad 上小于 16 像素一点输入框就把页面放大）', B.font >= 16, B.font);
T.ok('小框在左上角那一排下面、屏幕上方（数字键盘从下面弹出，挡不住），整个在屏幕里，里面的东西没出框', B.t >= B.rowBottom && B.b < B.vh * 0.4 && inScreen(B) && B.fits, B);
T.ok('还没从别处跳过：没有「回到第 N 页」', B.back === null, B.back);
await T.shot('page-jump-full.png');
// 页码右边、本子名那块里面的一点（字外面）也算点页码：点得着的地方比字大一圈
await T.tap('#chipPage', 400);
T.ok('再点一下页码：小框收起', !(await box()));
const edge = await js(`(() => { const n = document.querySelector('#nbChip').getBoundingClientRect(), p = document.querySelector('#chipPage').getBoundingClientRect();
  const x = Math.round((p.right + n.right) / 2), y = Math.round(n.bottom - 3); const e = document.elementFromPoint(x, y); return { x, y, id: e && e.id }; })()`);
await T.tapAt(edge.x, edge.y, 500);
T.ok('点页码右边一点、本子名那块的边上（字外面）：也出小框', Boolean(await box()) && !(await drawerOpen()), edge);
// 有的浏览器把点到按钮里面的字的事件算在按钮身上（e.target 是 #nbChip 本身，不是页码）：这时按点的位置分，页码那块还是出小框、☰ 还是开抽屉
await T.tap('#chipPage', 400);
const clickOnChip = (sel) => js(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(), c = document.querySelector('#nbChip');
  c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); return 1; })()`).then(() => sleep(400));
await clickOnChip('#nbChip .chip-menu');
T.ok('点的事件算在整块身上时，位置在 ☰ 上：开抽屉，不出小框', (await drawerOpen()) && !(await box()));
await clickOnChip('#nbChip .chip-menu');
await clickOnChip('#chipPage');
T.ok('点的事件算在整块身上时，位置在页码上：出小框，不开抽屉', Boolean(await box()) && !(await drawerOpen()));

// ================= 2. 输入 7 点「去」：翻到第 7 页；不会当成快捷键、点「AI」
await type('7');
await T.tap('#pjGo', 300);
T.ok('输入 7 点「去」：翻到第 7 页，小框收起', (await at(6)) && !(await box()) && (await T.text('#chipPage')) === '7/12');

// ================= 3. 超出范围：框里说一句、不翻；只收数字；回车也算「去」
await T.tap('#chipPage', 500);
B = await box();
T.ok('从第 1 页跳过来：框里多一行「回到第 1 页」；浅字写着现在的第 7 页', Boolean(B) && B.back === '回到第 1 页' && B.ph === '7', B);
await type('13');
await T.tap('#pjGo', 400);
B = await box();
T.ok('输入 13（这本只有 12 页）点「去」：框里说「要输入 1 到 12 之间的页码」，不翻、框还开着', Boolean(B) && B.err === '要输入 1 到 12 之间的页码' && (await S('S.idx')) === 6, B);
await type('0');
await key('Enter', 'Enter');
B = await box();
T.ok('输入 0 按回车：一样说一句、不翻', Boolean(B) && B.err === '要输入 1 到 12 之间的页码' && (await S('S.idx')) === 6, B);
await type('');
await T.tap('#pjGo', 400);
T.ok('什么都没输点「去」：一样说一句、不翻', ((await box()) || {}).err === '要输入 1 到 12 之间的页码' && (await S('S.idx')) === 6);
await type('3');
for (const [k, code] of [['e', 'KeyE'], ['l', 'KeyL']]) { // 输入框里按字母键（e、l 平时是换橡皮、套索的快捷键）
  await T.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text: k, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
  await T.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
}
await sleep(200);
B = await box();
T.ok('输入框里按字母键：字母去掉，只留下「3」；也不当快捷键（还是黑笔）', Boolean(B) && B.value === '3' && B.err === null && (await S('S.tool')) === 'pen', [B, await S('S.tool')]);
await key('Enter', 'Enter');
T.ok('按回车：翻到第 3 页，小框收起', (await at(2)) && !(await box()));
await sleep(500);
T.ok('回车没有当成点「AI」（没有交上去）', !(await T.poll('S1')));

// ================= 4. 回到第 N 页：N 是跳之前的那一页；点了回去，回去也算一次跳
await T.tap('#chipPage', 500);
B = await box();
T.ok('从第 7 页跳过来：框里写「回到第 7 页」（不是更早的第 1 页）', Boolean(B) && B.back === '回到第 7 页', B);
await T.tap('#pjBack', 300);
T.ok('点「回到第 7 页」：回到第 7 页，小框收起', (await at(6)) && !(await box()));
await T.tap('#chipPage', 500);
T.ok('回去也算一次跳：框里写「回到第 3 页」', ((await box()) || {}).back === '回到第 3 页', await box());
// 收起：点框外面（手指点纸）、Esc
await T.fingerTapAt(400, 700, 400);
T.ok('手指点框外面的纸：小框收起，纸上没留下笔迹', !(await box()) && (await T.strokes()) === 0);
await T.tap('#chipPage', 500);
await key('Escape', 'Escape');
T.ok('按 Esc：收起', !(await box()));
// 自己翻到「回到」的那一页时，不出这一行
await T.openPage(2);
await T.tap('#chipPage', 500);
T.ok('自己翻回第 3 页：框里没有「回到第 3 页」那一行', Boolean(await box()) && (await box()).back === null, await box());
await type('7');
await T.tap('#pjGo', 300);
T.ok('（再跳到第 7 页）', await at(6));

// ================= 5. 按页的键记：在前面插一页，「回到」的页码跟着变，回到的还是原来那一页
const key3 = await S('S.nb.pageInfo[2].key');
await T.api('/api/page/insert', { method: 'POST', body: JSON.stringify({ nb: 'scratch', after: 0 }) });
await T.openNotebook('scratch', 7);
await T.tap('#chipPage', 500);
B = await box();
T.ok('在第 1 页后插了一页：原来的第 3 页成了第 4 页，框里写「回到第 4 页」、共 13 页', Boolean(B) && B.back === '回到第 4 页' && B.total === '页（共 13 页）', B);
await T.tap('#pjBack', 300);
T.ok('点「回到第 4 页」：回到的就是原来那一页（同一个键）', (await at(3)) && (await S('S.nb.pageInfo[S.idx].key')) === key3);

// ================= 6. 退出全屏：顶栏上的页码像个按钮，点了出小框（在顶栏下面、页码下面）；照样能跳
await T.tap('#toolsBars', 800);
const noLook = await js(`(() => { const p = document.querySelector('#pageNo'), c = getComputedStyle(p); return { text: p.textContent, border: c.borderTopWidth + ' ' + c.borderTopStyle, bg: c.backgroundColor }; })()`);
T.ok('顶栏上 ‹ › 中间的页码「4/13」：细框白底，像个按钮', noLook.text === '4/13' && noLook.border === '1px solid' && noLook.bg === 'rgb(255, 255, 255)', noLook);
await T.tap('#pageNo', 500);
B = await box();
const pn = await js(`(() => { const r = document.querySelector('#pageNo').getBoundingClientRect(); return { cx: (r.left + r.right) / 2, bottom: r.bottom }; })()`);
T.ok('点顶栏上的页码：小框在顶栏下面、页码正下方，在屏幕上方，整个在屏幕里', Boolean(B) && B.t >= B.rowBottom && B.t >= pn.bottom && B.l <= pn.cx && B.r >= pn.cx && B.b < B.vh * 0.4 && inScreen(B), [B, pn]);
T.ok('退出全屏时也有「回到第 8 页」', B.back === '回到第 8 页', B.back);
await T.shot('page-jump-bars.png');
await type('12');
// 框开着、已经打了字时转动 iPad（竖着变横着、再转回来）：框不收起、字还在，跟着挪到页码新的位置下面（横着时顶栏变宽，页码往右挪）
const pageNoAt = () => js(`(() => { const r = document.querySelector('#pageNo').getBoundingClientRect(); return { cx: (r.left + r.right) / 2, bottom: r.bottom }; })()`);
for (const [w, h, name] of [[1194, 834, '横着'], [834, 1194, '转回竖着']]) {
  await T.cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
  await sleep(600);
  const R = await box(), p = await pageNoAt();
  T.ok(`框开着时转动 iPad（${name}）：框还开着、打的「12」还在，还在页码正下方、整个在屏幕里`,
    Boolean(R) && R.value === '12' && R.t >= R.rowBottom && R.t >= p.bottom && R.l <= p.cx && R.r >= p.cx && inScreen(R), [R, p]);
}
await T.tap('#pjGo', 300);
T.ok('输入 12 点「去」：翻到最后一页，顶栏页码「12/13」', (await at(11)) && (await T.text('#pageNo')) === '12/13');
await T.tap('#pageNo', 500);
await T.tap('#pageNo', 400);
T.ok('再点一下顶栏上的页码：收起', !(await box()));

// ================= 7. 只有一页的本子：点页码不出小框（全屏时左上角没有页码，点那一块开抽屉）
const one = await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title: '一页', paper: 'portrait' }) });
await T.openNotebook(one.id, 0);
await T.tap('#pageNo', 500);
T.ok('只有一页（顶栏上写 1/1）：点页码不出小框', (await T.text('#pageNo')) === '1/1' && !(await box()));
await T.tap('#fsBtn', 800);
T.ok('全屏时只有一页：左上角不写页码', (await T.text('#chipPage')) === '' && !(await T.visible('#chipPage')));
await T.tap('#nbChip', 600);
T.ok('点左上角那一块：开抽屉，不出小框', (await drawerOpen()) && !(await box()));
await T.tap('#nbChip', 600);
await T.openNotebook('scratch', 0);

// ================= 8. 连续阅读：照样跳，那一页顶在屏幕上
await js(`window.__ink.toggleFlow()`);
await sleep(1000);
await T.openPage(0);
await T.tap('#chipPage', 500);
await type('9');
await T.tap('#pjGo', 1200);
const top9 = await S('Math.round(S.view.ty + S.Y0 * S.view.s)');
T.ok('连续阅读：输入 9 翻到第 9 页，那一页顶在屏幕上', (await at(8)) && (await S('S.flow')) && Math.abs(top9) <= 2, top9);
await T.tap('#chipPage', 500);
T.ok('连续阅读：框里写「回到第 1 页」', ((await box()) || {}).back === '回到第 1 页', await box());
await T.tap('#pjBack', 1200);
T.ok('点了回到第 1 页', await at(0));

// ================= 9. 英文界面、744 宽：字是英文，小框整个在屏幕里、字没出框
await T.cdp('Emulation.setDeviceMetricsOverride', { width: 744, height: 1133, deviceScaleFactor: 1, mobile: true });
await T.go('&lang=en');
await T.tap('#chipPage', 500);
await type('99');
await T.tap('#pjGo', 400);
B = await box();
T.ok('英文界面：「Go to page [ ] of 13」「Go」，超出范围时说 Enter a page number from 1 to 13', Boolean(B) && B.text.startsWith('Go to page') && B.total === 'of 13' && B.go === 'Go'
  && B.err === 'Enter a page number from 1 to 13', B);
T.ok('英文界面 744 宽：小框整个在屏幕里、字没出框、在屏幕上方', inScreen(B) && B.fits && B.b < B.vh * 0.4, B);
await type('5');
await T.tap('#pjGo', 1200);
await T.tap('#chipPage', 500);
B = await box();
T.ok('英文界面：「Back to page 1」', Boolean(B) && B.back === 'Back to page 1', B);
await T.shot('page-jump-en.png');

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

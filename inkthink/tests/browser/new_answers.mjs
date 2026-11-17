// 别的页有新回答的记号（2026-11-16 用户定，《产品定义》第 2 节「交互上补的八样」；细节暂定，用户之后在平板上试）。查：
// Claude 回在不是眼前这一页的页上（交完翻走了）：页码旁出一个记号，全屏时在左上角本子名后面、退出全屏后在顶栏的 ‹ 页码 › 后面。
// 样子（2026-11-16 夜用户试过后改）：只有一页有「● 第 2 页」，点了翻过去；几页都有「● 2 页有新回答 ▾」，点了在它下面出一张小单子，
// 每页一行「第 2 页」，点一行翻过去、收起单子，点外面收起；看过的页从单子和数目里去掉（第 11 步）。
// 回在眼前这一页上的不出；只有读法（纸上看不见）的不出；
// 那一页成为当前页，它的记号就消失；抽屉里那一页的缩略图上也带一个点；
// 刷新页面后还在（还没落到纸上的：服务在本子信息里标出来；连续阅读时已经落在屏幕上相邻页上、还没翻到的：记在这台设备上），看过的刷新后也不再出；
// 插一页后记号跟着那一页走（页码跟着变）；回在别的本子上的不在这一本上出，打开那一本时才出。
// 跑法：node tests/run_browser.mjs <临时目录> --only new_answers；有一项不对退出码 1。
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'new-answers', pages: 3 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
// 左上角（全屏）或顶栏（退出全屏）上的记号：看不看得见、写着什么、说明、在不在本子名 / 页码后面
const mark = (id = '#chipNew') => js(`(() => { const b = document.querySelector('${id}'); const c = getComputedStyle(b); if (b.hidden || c.display === 'none' || !b.getClientRects().length) return null;
  const r = b.getBoundingClientRect(), dot = b.querySelector('.na-dot'), d = dot.getBoundingClientRect(), prev = b.previousElementSibling.getBoundingClientRect();
  return { text: b.textContent.trim(), label: b.getAttribute('aria-label'), dot: getComputedStyle(dot).backgroundColor, dw: Math.round(d.width), color: c.color,
    afterPrev: r.left >= prev.right - 1 && Math.abs((r.top + r.bottom) / 2 - (prev.top + prev.bottom) / 2) < 3, prevId: b.previousElementSibling.id,
    inScreen: r.left >= 0 && r.right <= document.documentElement.clientWidth && r.top >= 0 }; })()`);
const thumbDots = () => js(`[...document.querySelectorAll('#thumbs .th')].map((d, i) => d.classList.contains('new-ans') && getComputedStyle(d, '::after').backgroundColor === 'rgb(47, 95, 174)' ? i + 1 : 0).filter(Boolean).join()`);
const toasts = () => js(`window.__toasts || []`);
// 「几页有新回答」的小单子：每行写什么、在不在记号正下方、在不在屏幕里；没开是 null
const listOf = () => js(`(() => { const b = document.querySelector('#newAnsList'); if (b.hidden) return null; const r = b.getBoundingClientRect(), S = window.__ink.S;
  const m = document.querySelector(S.collapsed ? '#chipNew' : '#barNew').getBoundingClientRect();
  return { rows: [...b.querySelectorAll('.row')].map((x) => x.textContent.trim()), l: r.left, t: r.top, r: r.right, b: r.bottom, vh: innerHeight,
    under: r.top >= m.bottom && r.left <= m.left + 1 && r.right > m.left, inScreen: r.left >= 0 && r.top >= 0 && r.right <= document.documentElement.clientWidth && r.bottom <= innerHeight }; })()`);
// 点页码出的输入页码的小框里那一行「回到第 N 页」（没有是 null），看完收起
const backRow = async () => { const sel = (await js('window.__ink.S.collapsed')) ? '#chipPage' : '#pageNo'; await T.tap(sel, 500);
  const t = await js(`(() => { const b = document.querySelector('#pjBack'); return document.querySelector('#pageJump').hidden || b.hidden ? null : b.textContent; })()`); await T.tap(sel, 400); return t; };
const logToasts = () => js(`(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (!t.hidden) window.__toasts.push(t.textContent); })
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true, attributes: true }); return 1; })()`);
const reply = (sub, items) => T.post('/bridge/reply', { sid: 'S1', submission: sub.id, items });
const writeRedAndSend = async (y) => { await T.tool('red'); await T.pen(T.line(120, y, 260)); await T.tool('pen'); await T.tap('#check'); return T.waitSub('S1'); };
const aiCount = (i) => S(`(${i} === S.idx ? S.page : (S.flowCache.get(${i}) || {}).page || { ai: [] }).ai.length`);

if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); } // 先在单页里测（连续阅读在第 7 步）

// ================= 1. 第 2 页、第 3 页各交一次，翻回第 1 页；Claude 回在第 2 页：左上角本子名后面出「● 2」
await T.openPage(1);
const sub2 = await writeRedAndSend(200);
await T.openPage(2);
const sub3 = await writeRedAndSend(200);
await T.openPage(0);
T.ok('（前提）第 2、3 页各交上去了，现在在第 1 页', Boolean(sub2 && sub3) && (await S('S.idx')) === 0);
T.ok('还没有回答：没有记号', !(await mark()));
await logToasts();
await reply(sub2, [{ type: 'note', anchor: 'g1', text: '第二页的短批注' }]);
T.ok('Claude 回在第 2 页：左上角出了记号', await T.waitFor(`!document.querySelector('#chipNew').hidden`, 8000));
let M = await mark();
T.ok('记号是一个小蓝点带「第 2 页」，蓝色，紧挨在本子名（带页码）后面、同一行', Boolean(M) && M.text === '第 2 页' && M.dot === 'rgb(47, 95, 174)' && M.dw >= 6 && M.color === 'rgb(47, 95, 174)'
  && M.afterPrev && M.prevId === 'nbChip' && M.inScreen, M);
T.ok('说明写着哪页有新回答、点了翻过去', M.label === 'Claude 在第 2 页有新回答，点一下翻过去', M.label);
T.ok('原来那句提示照旧（「Claude 在别的页写了批注」）', (await toasts()).some((t) => t.startsWith('Claude 在别的页写了批注')), await toasts());
T.ok('当前页还是第 1 页，回答没落到第 1 页', (await S('S.idx')) === 0 && (await aiCount(0)) === 0);

// ================= 2. 又回在第 3 页：「● 2 页有新回答 ▾」；回在眼前这一页（第 1 页）上的不出记号
await reply(sub3, [{ type: 'write', anchor: 'g1', text: '第三页的长回答' }]);
T.ok('又回在第 3 页：记号写「2 页有新回答 ▾」，说明里列着 2、3 两页', await T.waitFor(`document.querySelector('#chipNew .na-no').textContent === '2 页有新回答'`, 8000)
  && (await mark()).text === '2 页有新回答▾' && (await mark()).label === 'Claude 在第 2、3 页有新回答，点一下列出来', await mark());
const sub1 = await writeRedAndSend(300);
await reply(sub1, [{ type: 'note', anchor: 'g1', text: '第一页的短批注' }]);
T.ok('回在眼前这一页上：落下了，记号不变（不出第 1 页）', (await T.waitFor(`window.__ink.S.page.ai.length === 1`, 8000)) && (await mark()).text === '2 页有新回答▾', await mark());

// ================= 3. 抽屉里：第 2、3 页的缩略图上带一个点，第 1 页没有
await T.tap('#nbChip', 800);
T.ok('抽屉里第 2、3 页的缩略图右上角带一个蓝点', (await thumbDots()) === '2,3', await thumbDots());
await T.shot('new-answers-drawer.png');
await T.tap('#nbChip', 600);

// ================= 4. 刷新：记号还在（服务在本子信息里标着这两页还有没落到纸上的回答）
const info = await T.apiJson('/api/notebook?nb=scratch');
T.ok('本子信息里第 2、3 页标着有没落下的回答（只读，不取走）', info.pageInfo.map((p) => Boolean(p.newAns)).join() === 'false,true,true', info.pageInfo.map((p) => p.newAns));
await T.reload();
T.ok('刷新后记号还在：「2 页有新回答 ▾」', ((await mark()) || {}).text === '2 页有新回答▾', await mark());
await T.shot('new-answers-chip.png');

// ================= 5. 点记号：在它下面出一张小单子（第 2 页、第 3 页）；点「第 2 页」翻过去，回答落下，记号只剩「第 3 页」
await T.tap('#chipNew', 600);
let L = await listOf();
T.ok('点「2 页有新回答」：不翻页，在它下面出一张小单子，两行「第 2 页」「第 3 页」', (await S('S.idx')) === 0 && Boolean(L) && L.rows.join() === '第 2 页,第 3 页', L);
T.ok('小单子在记号正下方、屏幕上方，整个在屏幕里', Boolean(L) && L.under && L.inScreen && L.b < L.vh * 0.4, L);
await T.shot('new-answers-list.png');
await T.tap('#newAnsList .row[data-page="1"]', 1500);
T.ok('点「第 2 页」：翻到第 2 页、单子收起，那里的回答落下了', (await S('S.idx')) === 1 && !(await listOf()) && (await T.waitFor(`window.__ink.S.page.ai.length === 1`, 8000)));
T.ok('看到了第 2 页：它的记号消失，只剩「第 3 页」（没有 ▾）', ((await mark()) || {}).text === '第 3 页', await mark());
T.ok('从单子跳过来的：点页码出的小框里有「回到第 1 页」', await backRow() === '回到第 1 页', await backRow());

// ================= 6. 退出全屏：顶栏的 ‹ 页码 › 后面也有记号；点它翻到第 3 页；都看过了，记号没了，刷新后也不出
await T.tap('#toolsBars', 800);
M = await mark('#barNew');
T.ok('退出全屏：顶栏上 › 后面有同样的记号「第 3 页」', Boolean(M) && M.text === '第 3 页' && M.prevId === 'next' && M.afterPrev && M.dot === 'rgb(47, 95, 174)', M);
await T.tap('#barNew', 1500);
T.ok('只有一页有：点顶栏上的「第 3 页」直接翻到第 3 页，回答落下', (await S('S.idx')) === 2 && (await T.waitFor(`window.__ink.S.page.ai.length === 1`, 8000)) && !(await listOf()));
T.ok('点记号跳过来的：顶栏页码出的小框里有「回到第 2 页」', await backRow() === '回到第 2 页', await backRow());
T.ok('都看过了：顶栏上没有记号', !(await mark('#barNew')));
await T.tap('#fsBtn', 800);
T.ok('全屏的左上角也没有', !(await mark()));
await T.reload();
T.ok('刷新后也不出（看过了，服务那边也落下了）', !(await mark()) && (await T.apiJson('/api/notebook?nb=scratch')).pageInfo.every((p) => !p.newAns));

// ================= 7. 只有读法（纸上看不见）的回答：不出记号
await T.openPage(0);
await reply(sub3, [{ type: 'read', anchor: 'g1', text: '红笔那句的读法' }]);
await sleep(1500);
T.ok('回在第 3 页、只有读法：不出记号', !(await mark()));

// ================= 8. 连续阅读：回在屏幕上看得见的相邻页（不是当前页）上，直接落下，也出记号；刷新后还在（记在这台设备上）；翻到那一页后消失
await js(`window.__ink.toggleFlow()`);
await sleep(1200);
await T.openPage(0);
T.ok('（前提）连续阅读，当前是第 1 页，第 2 页接在下面、屏幕上看得见', (await S('S.flow')) && (await S('S.idx')) === 0 && (await js(`Boolean(window.__ink.neighborOnScreen(1))`)));
await reply(sub2, [{ type: 'note', anchor: 'g1', text: '第二页又一条' }]);
T.ok('回在看得见的第 2 页上：直接落下（第 2 页的数据里有了）', await T.waitFor(`((window.__ink.S.flowCache.get(1) || {}).page || { ai: [] }).ai.length === 2`, 10000));
T.ok('第 2 页不是当前页：出了记号「第 2 页」', await T.waitFor(`document.querySelector('#chipNew .na-no').textContent === '第 2 页' && !document.querySelector('#chipNew').hidden`, 5000), await mark());
await T.saved();
await sleep(500);
T.ok('（服务那边已经落下了：本子信息里第 2 页不再标着）', !(await T.apiJson('/api/notebook?nb=scratch')).pageInfo[1].newAns);
await T.reload();
T.ok('刷新后记号还在（记在这台设备上）', ((await mark()) || {}).text === '第 2 页', await mark());
await T.openPage(1);
T.ok('翻到第 2 页：记号消失', !(await mark()));
await T.openPage(0);
T.ok('再回到第 1 页：也不再出（看过了）', !(await mark()));
await T.reload();
T.ok('刷新后也不再出', !(await mark()) && (await S('S.idx')) === 0);

// ================= 9. 插一页：记号跟着那一页走，页码跟着变
await js(`window.__ink.toggleFlow()`);
await sleep(800);
await T.openPage(0);
await reply(sub3, [{ type: 'note', anchor: 'g1', text: '第三页又一条' }]);
T.ok('（前提）回在第 3 页：记号「第 3 页」', await T.waitFor(`document.querySelector('#chipNew .na-no').textContent === '第 3 页' && !document.querySelector('#chipNew').hidden`, 8000), await mark());
await T.api('/api/page/insert', { method: 'POST', body: JSON.stringify({ nb: 'scratch', after: 0 }) });
await T.openNotebook('scratch', 0);
T.ok('在第 1 页后插了一页：那一页现在是第 4 页，记号跟着写「第 4 页」', ((await mark()) || {}).text === '第 4 页', await mark());
await T.tap('#chipNew', 1500);
T.ok('点记号：翻到第 4 页（原来的第 3 页），回答落下', (await S('S.idx')) === 3 && (await T.waitFor(`window.__ink.S.page.ai.some((a) => a.text === '第三页又一条')`, 8000)));

// ================= 10. 回在别的本子上：这一本不出记号；打开那一本时，那一页有记号
const pad = await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title: '另一本' }) });
await T.openNotebook(pad.id, 0);
await T.api(`/api/notebook/addpage?nb=${encodeURIComponent(pad.id)}`, { method: 'POST', body: '' });
await T.openNotebook(pad.id, 1);
const subP = await writeRedAndSend(200);
await T.openNotebook('scratch', 0);
await reply(subP, [{ type: 'note', anchor: 'g1', text: '另一本第二页' }]);
await sleep(1500);
T.ok('回在别的本子上：这一本不出记号', !(await mark()));
await T.openNotebook(pad.id, 0);
T.ok('打开那一本（第 1 页）：第 2 页有记号「第 2 页」', ((await mark()) || {}).text === '第 2 页', await mark());

// ================= 11. 三页都有（2026-11-16 夜改的样子）：「3 页有新回答」，单子里三行、从小到大；点一行翻过去，看过的那页从单子和数目里去掉；
//      点外面、Esc、再点记号收起；单子开着时别的页又来了回答，单子跟着多一行。这里把「哪几页有新回答」直接记在这台设备上再打开这本
// （和页面自己记的是同一份：localStorage 的 newAns），不再一页页交、回
const many = await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title: '好几页' }) });
for (let k = 0; k < 5; k++) await T.api(`/api/notebook/addpage?nb=${encodeURIComponent(many.id)}`, { method: 'POST', body: '' });
const mkeys = (await T.apiJson(`/api/notebook?nb=${encodeURIComponent(many.id)}`)).pageInfo.map((p) => String(p.key));
const markPages = async (nbId, keys, at = 0) => { await js(`(() => { const all = JSON.parse(localStorage.getItem('inkthink.newAns') || '{}'); all[${JSON.stringify(nbId)}] = ${JSON.stringify(keys)};
  localStorage.setItem('inkthink.newAns', JSON.stringify(all)); return 1; })()`); await T.openNotebook(nbId, at); };
await markPages(many.id, [mkeys[5], mkeys[1], mkeys[3]]);
T.ok('第 2、4、6 页有新回答：记号写「3 页有新回答 ▾」，说明列出 2、4、6', ((await mark()) || {}).text === '3 页有新回答▾' && (await mark()).label === 'Claude 在第 2、4、6 页有新回答，点一下列出来', await mark());
await T.tap('#chipNew', 600);
T.ok('点记号：单子里三行，从小到大', ((await listOf()) || {}).rows.join() === '第 2 页,第 4 页,第 6 页', await listOf());
await T.fingerTapAt(500, 700, 400);
T.ok('手指点外面的纸：单子收起，没翻页', !(await listOf()) && (await S('S.idx')) === 0);
await T.tap('#chipNew', 600);
await T.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await T.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(300);
T.ok('按 Esc：单子收起', !(await listOf()));
await T.tap('#chipNew', 600);
await T.tap('#chipNew', 500);
T.ok('再点一下记号：单子收起', !(await listOf()));
await T.tap('#chipNew', 600);
await T.tap('#newAnsList .row[data-page="3"]', 1200);
T.ok('点「第 4 页」：翻到第 4 页，单子收起；记号变成「2 页有新回答」', (await S('S.idx')) === 3 && !(await listOf()) && ((await mark()) || {}).text === '2 页有新回答▾', await mark());
await T.tap('#chipNew', 600);
T.ok('单子里只剩第 2、6 页（看过的第 4 页去掉了）', ((await listOf()) || {}).rows.join() === '第 2 页,第 6 页', await listOf());
// 单子开着时翻到了第 2 页（看过了）：只剩第 6 页，单子收起，记号写「第 6 页」
await js(`window.__ink.openPage(1)`);
await sleep(1200);
T.ok('单子开着时翻到第 2 页：只剩第 6 页，单子收起，记号写「第 6 页」', !(await listOf()) && ((await mark()) || {}).text === '第 6 页', [await listOf(), await mark()]);
await T.tap('#chipNew', 1200);
T.ok('只剩一页：点「第 6 页」直接翻过去，记号没了', (await S('S.idx')) === 5 && !(await mark()) && !(await listOf()));

// ================= 12. 挤不挤：全屏左上角那一排、退出全屏后的顶栏，834 和 744 宽、中英文、本子名很长时，记号和别的按钮都在屏幕里，
//      按钮不被挤小、不压着右下角那一条；单子也在屏幕里
const longNb = await T.apiJson('/api/notebook/new', { method: 'POST',
  body: JSON.stringify({ title: '暑假旅行计划：从订车票、订酒店到每天的行程和预算的整理与对照记录（第二版，含附录和全部原始票据）' }) });
for (let k = 0; k < 11; k++) await T.api(`/api/notebook/addpage?nb=${encodeURIComponent(longNb.id)}`, { method: 'POST', body: '' });
const lkeys = (await T.apiJson(`/api/notebook?nb=${encodeURIComponent(longNb.id)}`)).pageInfo.map((p) => String(p.key));
// 全屏：左上角一排里看得见的按钮都在屏幕里、不小于 36×36、互不重叠，不压着右下角那一条；顶栏：不出横向滚动，按钮都在屏幕里、不小于 36 宽
const rowFits = () => js(`(() => { const vis = (e) => getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0, box = (e) => e.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  if (window.__ink.S.collapsed) { const bs = [...document.querySelectorAll('#chipRow > button, #chipRow .pair')].filter(vis), t = box(document.querySelector('#tools'));
    return { ids: bs.map((b) => b.id).join(), ok: bs.every((b) => { const r = box(b); return r.left >= 0 && r.right <= vw && r.height >= 36 && r.width >= 36 && !hit(r, t); })
      && bs.every((a, i) => bs.every((b, j) => i === j || !hit(box(a), box(b)))), na: Math.round(box(document.querySelector('#chipNew')).width) }; }
  // 顶栏上的本子名那块（缩得再窄）也不压到 ‹ 上
  const bar = document.querySelector('#bar'), bs = [...bar.querySelectorAll('button, #pageNo')].filter(vis), title = box(document.querySelector('#nbTitle')), prev = box(document.querySelector('#prev'));
  return { ids: bs.map((b) => b.id).join(), ok: bar.scrollWidth <= bar.clientWidth + 1 && bs.every((b) => { const r = box(b); return r.left >= 0 && r.right <= vw && r.width >= 36; })
    && bs.every((a, i) => bs.every((b, j) => i === j || !hit(box(a), box(b)))) && title.right <= prev.left + 0.5, na: Math.round(box(document.querySelector('#barNew')).width),
    title: [Math.round(title.left), Math.round(title.right), Math.round(prev.left)] }; })()`);
const FULL = 'nbChip,chipNew,chipPrev,chipNext,chipPair,chipAdd', BAR = 'drawerBtn,prev,pageNo,next,barNew,barSingle,barCont,barAdd,barCheck,menuBtn';
for (const lang of ['zh', 'en']) {
  for (const [w, h] of [[834, 1194], [744, 1133]]) {
    await T.cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
    if (lang === 'en') await T.go('&lang=en'); else await T.go();
    for (const n of [2, 1]) { // 几页、一页
      await markPages(longNb.id, n === 2 ? [lkeys[10], lkeys[11]] : [lkeys[11]], 0);
      for (const bars of [false, true]) {
        if (bars !== !(await S('S.collapsed'))) await T.tap(bars ? '#toolsBars' : '#fsBtn', 700);
        const f = await rowFits(), m = await mark(bars ? '#barNew' : '#chipNew');
        const want = n === 2 ? (lang === 'en' ? 'New on 2 pages▾' : '2 页有新回答▾') : (lang === 'en' ? 'Page 12' : '第 12 页');
        T.ok(`${lang === 'en' ? '英文' : '中文'} ${w} 宽、${bars ? '退出全屏的顶栏' : '全屏左上角'}、${n === 2 ? '两页' : '一页'}有新回答：记号写「${want}」，按钮都在屏幕里、没被挤小、互不重叠`,
          Boolean(m) && m.text === want && f.ok && f.ids === (bars ? BAR : FULL), [m && m.text, f]);
        if (n === 2) {
          await T.tap(bars ? '#barNew' : '#chipNew', 600);
          const L2 = await listOf();
          T.ok(`${lang === 'en' ? '英文' : '中文'} ${w} 宽、${bars ? '顶栏' : '全屏'}：单子在记号下面、整个在屏幕里，写「${lang === 'en' ? 'Page 11' : '第 11 页'}」`,
            Boolean(L2) && L2.under && L2.inScreen && L2.rows[0] === (lang === 'en' ? 'Page 11' : '第 11 页'), L2);
          if (w === 744) await T.shot(`new-answers-${lang}-${w}-${bars ? 'bars' : 'full'}.png`);
          await T.tap(bars ? '#barNew' : '#chipNew', 400);
        }
      }
      if (!(await S('S.collapsed'))) await T.tap('#fsBtn', 700);
    }
  }
}
await T.cdp('Emulation.setDeviceMetricsOverride', { width: 834, height: 1194, deviceScaleFactor: 1, mobile: true });

// ================= 13. 单子开着时转动 iPad（顶栏上，横着时顶栏变宽、记号往右挪）：单子不收起，跟着挪到记号新的位置下面
await markPages(longNb.id, [lkeys[10], lkeys[11]], 0);
if (await S('S.collapsed')) await T.tap('#toolsBars', 700);
await T.tap('#barNew', 600);
for (const [w, h, name] of [[1194, 834, '横着'], [834, 1194, '转回竖着']]) {
  await T.cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
  await sleep(600);
  const L3 = await listOf();
  T.ok(`单子开着时转动 iPad（${name}）：单子还开着，还在顶栏上的记号正下方、整个在屏幕里`, Boolean(L3) && L3.under && L3.inScreen && L3.rows.length === 2, L3);
}
await T.tap('#barNew', 400);
await T.tap('#fsBtn', 700);

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

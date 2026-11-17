// 拖缩略图换页序（2026-11-16 用户定，《产品定义》第 2 节「交互上补的八样」）：抽屉里的缩略图按住约半秒抓起，拖到两页之间（一条蓝色竖线
// 标出会落在哪）松手，页就挪到那里。只改页序（layout.json），各页的笔迹文件不动、不改名；当前打开的那一页挪走后眼前仍是同一页（按页的键跟着走），
// 页码跟着变，撤销记录、缩放和位置都留着；连续阅读时上下相邻的页按新的先后重取。放下后屏幕上方一句，带「撤销」（挪回原位）。
// 落在它自己前后的缝里、拖到缩略图外面松手：什么都不改。手指、笔都行；不到半秒就挪动的照旧滚动抽屉，轻点照旧翻到那页；
// 抓起后松手不算点击；拖到抽屉下边缘抽屉自己滚；还有字没存上时不挪。
// 只在无头 Edge 的合成触点上验过，没在 iPad 上试过。
// 跑法：node tests/browser/page_move.mjs [临时目录]；有一项不对退出码 1。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from '../browser_lib.mjs';

const N = 10;
const T = await boot({ name: 'page-move', open: false, pages: N }); // 草稿本 10 页：缩略图五行，抽屉能上下滚
const js = T.evalJS, DIR = join(T.DATA, 'notebooks', 'scratch');
// 每页一笔，id 是 s0、s1……（看得出哪一页是哪一页）
for (let k = 0; k < N; k++) {
  const pts = Array.from({ length: 8 }, (_, j) => [120 + 40 * j, 260 + 60 * k, 0.5, 30 * j]);
  await T.api(`/api/page?nb=scratch&i=${k}`, { method: 'PUT', body: JSON.stringify({ v: 1, strokes: [{ id: 's' + k, t0: 1700000000000 + k, w: 3, pts }], ai: [], reads: [] }) });
}
const keysNow = async () => (await T.apiJson('/api/notebook?nb=scratch')).pageInfo.map((p) => p.key);
const K = await keysNow(); // 原来的先后：K[j] 这一页上写着 s{j}
const inkFiles = () => Object.fromEntries(readdirSync(DIR).filter((f) => /^(page|blank)-[^.]+\.json$/.test(f)).map((f) => [f, readFileSync(join(DIR, f), 'utf8')]));
const layoutKeys = () => JSON.parse(readFileSync(join(DIR, 'layout.json'), 'utf8')).pages.map((e) => e.key);
const want = (order) => order.map((j) => K[j]); // 按原来的页号写出期望的先后
await T.go();

// ---- 小工具
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) await T.tap('#nbChip', 600); };
const thumbSel = (i) => `#thumbs .th:nth-child(${i + 1})`;
const rect = (i) => js(`(() => { const r = document.querySelector(${JSON.stringify(thumbSel(i))}).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 }; })()`);
const showThumbs = (i = 0) => js(`(() => { document.querySelector(${JSON.stringify(thumbSel(i))}).scrollIntoView({ block: 'center' }); return 1; })()`);
const touch = (type, x, y) => T.cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 4, radiusX: 8, radiusY: 8, force: 0.5 }] });
async function slide(from, to, steps = 12) {
  for (let k = 1; k <= steps; k++) { await touch('touchMove', from[0] + ((to[0] - from[0]) * k) / steps, from[1] + ((to[1] - from[1]) * k) / steps); await T.sleep(16); }
}
const penEv = (type, x, y, buttons) => T.cdp('Input.dispatchMouseEvent', { type, x, y, buttons, button: 'left', clickCount: 1, pointerType: 'pen' });
const state = () => js(`(() => { const S = window.__ink.S, bar = document.querySelector('.drag-bar'), ths = [...document.querySelectorAll('#thumbs .th')];
  return { idx: S.idx, chip: document.querySelector('#chipPage').textContent, ink: S.page.strokes.filter((s) => !s.erasedAt).map((s) => s.id), undo: S.undo.length,
    view: [Math.round(S.view.tx), Math.round(S.view.ty), Math.round(S.view.s * 1000)], keys: S.nb.pageInfo.map((p) => p.key),
    lifted: document.querySelectorAll('.lifted').length, ghost: document.querySelectorAll('.drag-ghost').length,
    bar: bar && !bar.hidden ? Math.round(bar.getBoundingClientRect().left + 2) : null, cur: ths.findIndex((e) => e.classList.contains('cur')),
    labels: ths.map((e) => e.querySelector('span').textContent).join(','), scroll: Math.round(document.querySelector('#drawer').scrollTop), drawer: !document.querySelector('#drawer').hidden }; })()`);
const toastNow = () => js(`(() => { const t = document.querySelector('#toast'); if (t.hidden) return null; const r = t.getBoundingClientRect();
  return { text: t.firstChild ? t.firstChild.textContent : '', btn: (t.querySelector('button') || {}).textContent || '', top: Math.round(r.top) }; })()`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 准备：翻到第 2 页（s1），在上面再写一笔（撤销里有一步），存好
await T.openPage(1);
await T.pen(T.line(150, 1200, 200));
await T.saved();
const before = await state(), files0 = inkFiles(); // 挪之前电脑上各页的笔迹文件（名字和内容）
T.ok('准备：在第 2 页，上面是 s1 和刚写的一笔，撤销里有一步', before.idx === 1 && before.ink[0] === 's1' && before.ink.length === 2 && before.undo === 1, before);

// 1. 手指按住第 1 张缩略图约半秒，拖到第 3、4 张之间：一条竖线标在那里；松手，第 1 页挪到第 3 页
await drawer(true);
await showThumbs(0);
const ver0 = await js(`new URL(document.querySelector('#thumbs img').src).searchParams.get('t')`), sc = (await state()).scroll;
let a = await rect(0), r2 = await rect(2), r3 = await rect(3);
await touch('touchStart', a.cx, a.cy);
await T.sleep(700);
let s = await state();
T.ok('按住约半秒：抓起来了（原处变淡，一个影子）', s.lifted === 1 && s.ghost === 1, s);
const gap = [(r2.r + r3.l) / 2, r3.cy];
await slide([a.cx, a.cy], gap);
s = await state();
T.ok('拖到第 3、4 张之间：竖线画在两张中间；抽屉没跟着手指滚', s.bar !== null && s.bar > r2.r - 1 && s.bar < r3.l + 1 && s.scroll === sc, [s, r2.r, r3.l, sc]);
await T.shot('1-drag-thumb.png');
await touch('touchEnd');
await T.sleep(1200);
s = await state();
let t = await toastNow();
const order1 = want([1, 2, 0, 3, 4, 5, 6, 7, 8, 9]);
T.ok('松手：第 1 页挪到了第 3 页（电脑上的页序也改了）', same(await keysNow(), order1) && same(layoutKeys(), order1) && same(s.keys, order1), [await keysNow(), s.keys]);
T.ok('各页的笔迹文件一个没改名、一个字没变', same(inkFiles(), files0), Object.keys(inkFiles()));
T.ok('眼前还是同一页（s1 和刚写的那一笔），页码变成 1/10，撤销记录、缩放和位置都留着', s.idx === 0 && same(s.ink, before.ink) && s.chip === '1/10' && s.undo === 1 && same(s.view, before.view), [before, s]);
T.ok('缩略图按新的先后重画，当前这一页标在第 1 张，页码还是 1 到 10', s.cur === 0 && s.labels === '1,2,3,4,5,6,7,8,9,10' && s.lifted === 0 && s.ghost === 0 && s.bar === null && s.drawer, s);
T.ok('屏幕上方一句「第 1 页挪到了第 3 页」，带「撤销」', t && t.text === '第 1 页挪到了第 3 页' && t.btn === '撤销' && t.top < 200, t);
const thumbOk = await T.waitFor(`[...document.querySelectorAll('#thumbs img')].slice(0, 4).every((i) => i.complete && i.naturalWidth > 0)`);
const ver1 = await js(`new URL(document.querySelector('#thumbs img').src).searchParams.get('t')`);
T.ok('缩略图取的是新的图（地址换了版本号，不拿缓存里别的页的图）', thumbOk && ver1 !== ver0, [thumbOk, ver0, ver1]);
// 连续阅读：下面相邻的页按新的先后重取（第 2 页是 s2）
const nb1 = await T.waitFor(`window.__ink.flowStrip().some((n) => n.i === 1)`);
const strip = await js(`window.__ink.flowStrip().map((n) => [n.i, (n.ent.page.strokes[0] || {}).id])`);
T.ok('连续阅读时下面接着的是新的第 2 页（原来的第 3 页，s2）', nb1 && strip.every(([i, id]) => id === 's' + [1, 2, 0, 3, 4, 5, 6, 7, 8, 9][i]), strip);
// 撤销还是撤在这一页上：撤掉刚写的那一笔
await js(`window.__ink.undo(); 1`);
await T.sleep(300);
s = await state();
T.ok('挪完点撤销：撤掉的是这一页上刚写的那一笔', same(s.ink, ['s1']) && s.idx === 0, s);
await T.saved();

// 2. 点提示里的「撤销」：挪回原位，眼前还是这一页（页码变回 2/10）
await T.tap('#toast button', 1200);
s = await state();
t = await toastNow();
T.ok('点「撤销」：页序回到原样，眼前还是 s1 那一页，页码 2/10，抽屉还开着', same(await keysNow(), K) && s.idx === 1 && s.chip === '2/10' && same(s.ink, ['s1']) && s.drawer, s);
T.ok('撤销后说一句「已挪回第 1 页」', t && t.text === '已挪回第 1 页', t);

// 3. 落在它自己前后的缝里、拖到缩略图外面：不画竖线，松手什么都不改
await showThumbs(0);
a = await rect(1);
await touch('touchStart', a.cx, a.cy);
await T.sleep(700);
await slide([a.cx, a.cy], [a.l + 10, a.cy]);
s = await state();
T.ok('拖到它自己左边的缝：不画竖线', s.lifted === 1 && s.bar === null, s);
await touch('touchEnd');
await T.sleep(800);
T.ok('在自己前后的缝里松手：页序不变', same(await keysNow(), K) && (await state()).ghost === 0, await keysNow());
a = await rect(1);
await touch('touchStart', a.cx, a.cy);
await T.sleep(700);
await slide([a.cx, a.cy], [700, 500]);
s = await state();
T.ok('拖到抽屉外面的纸上：不画竖线', s.bar === null && s.ghost === 1, s);
await touch('touchEnd');
await T.sleep(800);
s = await state();
T.ok('在缩略图外面松手：页序不变，抽屉还开着，没翻页', same(await keysNow(), K) && s.drawer && s.idx === 1 && s.ghost === 0, s);

// 4. 笔也能拖：笔按住第 4 张，拖到第 1 张左边松手：第 4 页挪到最前面，眼前的 s1 那一页变成第 3 页
await showThumbs(0);
a = await rect(3);
const r0 = await rect(0);
await penEv('mousePressed', a.cx, a.cy, 1);
await T.sleep(700);
for (let k = 1; k <= 10; k++) await penEv('mouseMoved', a.cx + ((r0.l + 8 - a.cx) * k) / 10, a.cy + ((r0.cy - a.cy) * k) / 10, 1);
s = await state();
T.ok('笔拖到第 1 张左边：竖线画在第 1 张左边', s.bar !== null && Math.abs(s.bar - (r0.l - 4)) <= 2, [s.bar, r0.l]);
await penEv('mouseReleased', r0.l + 8, r0.cy, 0);
await T.sleep(1200);
s = await state();
T.ok('笔松手：第 4 页挪到了最前面，眼前的 s1 那一页现在是第 3 页', same(await keysNow(), want([3, 0, 1, 2, 4, 5, 6, 7, 8, 9])) && s.idx === 2 && s.chip === '3/10' && same(s.ink, ['s1']), s);
await T.tap('#toast button', 1200);
T.ok('「撤销」：回到原样', same(await keysNow(), K) && (await state()).idx === 1, await keysNow());

// 5. 按住、不挪就松手：不算点击，不翻到那一页；轻点照旧翻到那一页
await showThumbs(0);
a = await rect(3);
await touch('touchStart', a.cx, a.cy);
await T.sleep(800);
await touch('touchEnd');
await T.sleep(800);
s = await state();
T.ok('按住半秒以上、不挪就松手：不翻页，页序不变', s.idx === 1 && same(await keysNow(), K) && s.ghost === 0, s);
await T.fingerTapAt(a.cx, a.cy, 1200);
s = await state();
T.ok('轻点一张缩略图：照旧翻到那一页', s.idx === 3 && s.ink[0] === 's3', s);
await T.openPage(1);
await drawer(true);

// 6. 不到半秒就挪动：是滚动抽屉，不抓起
await js(`document.querySelector('#drawer').scrollTop = 0; 1`);
await T.sleep(300);
a = await rect(2);
await touch('touchStart', a.cx, a.cy);
await slide([a.cx, a.cy], [a.cx, a.cy - 300], 10);
s = await state();
await touch('touchEnd');
await T.sleep(800);
const s6 = await state();
T.ok('按下就往上滑（不到半秒）：抽屉照常滚动，没有抓起，页序不变', s.lifted === 0 && s.ghost === 0 && s6.scroll > 100 && same(await keysNow(), K) && s6.idx === 1, [s, s6]);

// 7. 拖到抽屉下边缘：抽屉自己往下滚；拖到最后一张后面松手：挪到最后
await showThumbs(1);
a = await rect(1);
await touch('touchStart', a.cx, a.cy);
await T.sleep(700);
const low = await js(`(() => { const r = document.querySelector('#drawer').getBoundingClientRect(); return [r.left + r.width / 2, Math.min(r.bottom, innerHeight) - 10]; })()`);
await slide([a.cx, a.cy], low);
const sc0 = (await state()).scroll;
await T.sleep(1500);
const sc1 = (await state()).scroll;
T.ok('拖到抽屉下边缘：抽屉自己往下滚', sc1 > sc0 + 100, [sc0, sc1]);
const last = await rect(N - 1);
await slide(low, [last.r - 6, last.cy]);
s = await state();
T.ok('拖到最后一张的右半边：竖线画在它右边', s.bar !== null && Math.abs(s.bar - (last.r + 4)) <= 2, [s.bar, last.r]);
await touch('touchEnd');
await T.sleep(1200);
s = await state();
T.ok('松手：第 2 页（眼前这一页）挪到了最后，眼前还是它，页码 10/10', same(await keysNow(), want([0, 2, 3, 4, 5, 6, 7, 8, 9, 1])) && s.idx === 9 && s.chip === '10/10' && same(s.ink, ['s1']), s);
t = await toastNow();
T.ok('提示说「第 2 页挪到了第 10 页」', t && t.text === '第 2 页挪到了第 10 页', t);
await T.tap('#toast button', 1200);
T.ok('「撤销」：回到原样', same(await keysNow(), K) && (await state()).idx === 1, await keysNow());

// 8. 还有字没存上（存盘请求连不上）：不挪，说一句；连上以后照常
let failPut = false;
T.onCdp('Fetch.requestPaused', (p) => {
  if (failPut && p.request.method === 'PUT') T.cdp('Fetch.failRequest', { requestId: p.requestId, errorReason: 'InternetDisconnected' }).catch(() => {});
  else T.cdp('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
});
await T.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/page?*', requestStage: 'Request' }] });
failPut = true;
await drawer(false);
await T.pen(T.line(500, 1300, 150));
await T.sleep(2000);
await drawer(true);
await showThumbs(0);
a = await rect(0);
const b8 = await rect(2);
await touch('touchStart', a.cx, a.cy);
await T.sleep(700);
await slide([a.cx, a.cy], [b8.r - 6, b8.cy]);
await touch('touchEnd');
await T.sleep(1500);
t = await toastNow();
T.ok('还有字没存上：不挪，说「有字还没存上，等存好了再挪页」', same(await keysNow(), K) && t && t.text === '有字还没存上，等存好了再挪页', [t, await keysNow()]);
failPut = false;
await T.cdp('Fetch.disable');
const ok8 = await T.saved(15000);
const p8 = (await T.apiJson('/api/page?nb=scratch&i=1')).strokes.filter((x) => !x.erasedAt).map((x) => x.id);
T.ok('连上以后那一笔存到了原来那一页上（s1 那一页）', ok8 && p8.length === 2 && p8[0] === 's1', p8);

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

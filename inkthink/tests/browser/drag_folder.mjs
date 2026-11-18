// 把本子拖进文件夹（2026-11-16 用户定，《产品定义》第 2 节「交互上补的八样」）：在抽屉里按住一本约半秒抓起（手指、笔都行），那一行变淡、
// 一个影子跟着走；拖到文件夹那一行上，文件夹白底加粗边框，松手放进去；收着的文件夹上停约 0.7 秒自己展开；拖到抽屉下边缘时抽屉自己滚；
// 文件夹里的本子拖到文件夹外面松手是移出文件夹；放在不能放的地方回到原处、什么都不改。放下后屏幕上方一句，带「撤销」，点了回到原来的地方。
// 草稿本不能拖（推送本子 2026-11-17 起能拖，见 push_books.mjs）。按住不到半秒就挪动的照旧：滚动列表、左右滑着看名字。抓起后松手不算点击（不打开那本）。
// 抓起后手指再怎么挪，抽屉都不跟着滚（拦下了系统的滚动；没拦的话浏览器会接管滚动、发 pointercancel，放不下去）。
// 只在无头 Edge 的合成触点上验过；iPad Safari 上长按的系统菜单、滚动接管没法在这里验。
// 跑法：node tests/browser/drag_folder.mjs [临时目录]；有一项不对退出码 1。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from '../browser_lib.mjs';

const T = await boot({ name: 'drag-folder', open: false, pages: 10 }); // 草稿本 10 页：抽屉里缩略图多，抽屉能上下滚
const js = T.evalJS, FILE = join(T.DATA, 'notebooks', 'folders.json');
const LONG = '读书随手记：小学数学里鸡兔同笼问题的几种解法与画图方法对比';
const mk = async (title) => (await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title }) })).id;
const P1 = await mk('随笔'), P2 = await mk('想法'), P3 = await mk(LONG);
const folder = async (name, nb) => (await T.apiJson('/api/folders/new', { method: 'POST', body: JSON.stringify(nb ? { name, nb } : { name }) })).id;
const F1 = await folder('课题', P2), F2 = await folder('旧的');
await T.go();

// ---- 小工具
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) { await T.tap('#nbChip', 600); } };
const rowSel = (nb) => `#nbList .nb-item[data-nb=${JSON.stringify(nb)}]`;
const folderSel = (fid) => `#nbList .nf-item[data-fid=${JSON.stringify(fid)}]`;
const saved = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')).folders.map((f) => [f.name, f.items]) : []);
const where = (nb) => { const f = saved().find(([, items]) => items.includes(nb)); return f ? f[0] : ''; };
const center = async (sel) => { const c = await T.centerOf(sel); if (!c) throw new Error('页面上没有 ' + sel); return c; };
// 一根手指（触摸事件）
const touch = (type, x, y) => T.cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 3, radiusX: 8, radiusY: 8, force: 0.5 }] });
async function slide(from, to, steps = 12) {
  for (let k = 1; k <= steps; k++) { await touch('touchMove', from[0] + ((to[0] - from[0]) * k) / steps, from[1] + ((to[1] - from[1]) * k) / steps); await T.sleep(16); }
}
// 笔（pointerType pen 的鼠标事件）
const penEv = (type, x, y, buttons) => T.cdp('Input.dispatchMouseEvent', { type, x, y, buttons, button: 'left', clickCount: 1, pointerType: 'pen' });
const state = () => js(`(() => { const S = window.__ink.S, d = document.querySelector('#drawer');
  return { nb: S.nb.id, lifted: [...document.querySelectorAll('.lifted')].map((e) => e.dataset.nb || 'th'), ghost: document.querySelectorAll('.drag-ghost').length,
    drop: [...document.querySelectorAll('#nbList .nf-item.drop')].map((e) => e.dataset.fid), out: document.querySelector('#nbList').classList.contains('drop-out'),
    scroll: Math.round(d.scrollTop), drawer: !d.hidden }; })()`);
const toastNow = () => js(`(() => { const t = document.querySelector('#toast'); if (t.hidden) return null; const r = t.getBoundingClientRect();
  return { text: t.firstChild ? t.firstChild.textContent : '', btn: (t.querySelector('button') || {}).textContent || '', top: Math.round(r.top) }; })()`);
const resetScroll = () => js(`document.querySelector('#drawer').scrollTop = 0; 1`);

await drawer(true);
await T.sleep(400);
const st0 = await js(`({ sh: document.querySelector('#drawer').scrollHeight, ch: document.querySelector('#drawer').clientHeight })`);
T.ok('准备：抽屉比屏幕高，能上下滚；「课题」里是「想法」，「旧的」是空的', st0.sh > st0.ch + 300 && where(P2) === '课题' && where(P1) === '' && saved().length === 2, [st0, saved()]);

// 1. 手指按住「随笔」约半秒：那一行变淡、影子出来；拖到「课题」那一行上：「课题」白底加粗边框；抽屉不跟着手指滚；松手放进去
let a = await center(rowSel(P1));
await touch('touchStart', a[0], a[1]);
await T.sleep(300);
let s = await state();
T.ok('按住不到半秒：还没抓起', s.lifted.length === 0 && s.ghost === 0, s);
await T.sleep(400);
s = await state();
T.ok('按住约半秒：抓起来了（原处变淡，一个影子）', JSON.stringify(s.lifted) === JSON.stringify([P1]) && s.ghost === 1, s);
let b = await center(folderSel(F1));
await slide(a, b);
s = await state();
T.ok('拖到「课题」那一行上：它标出来；抽屉没跟着手指滚', JSON.stringify(s.drop) === JSON.stringify([F1]) && !s.out && s.scroll === 0, s);
const ring = await js(`(() => { const cs = getComputedStyle(document.querySelector(${JSON.stringify(folderSel(F1))})); return [cs.backgroundColor, cs.boxShadow]; })()`);
T.ok('指着的文件夹是白底加粗边框', ring[0] === 'rgb(255, 255, 255)' && /1\.5px/.test(ring[1]), ring);
await T.shot('1-drag-over-folder.png');
await touch('touchEnd');
await T.sleep(900);
s = await state();
let t = await toastNow();
T.ok('松手：「随笔」放进了「课题」（电脑上也记下了），影子没了，抽屉还开着', where(P1) === '课题' && s.ghost === 0 && s.lifted.length === 0 && s.drawer && s.drop.length === 0, [saved(), s]);
T.ok('抓起后的松手不算点击：没有打开「随笔」', s.nb === 'scratch', s.nb);
T.ok('屏幕上方一句「已放进「课题」」，带「撤销」', t && t.text === '已放进「课题」' && t.btn === '撤销' && t.top < 200, t);
// 「撤销」：回到文件夹外面
await T.tap('#toast button', 900);
t = await toastNow();
T.ok('点「撤销」：「随笔」回到文件夹外面，说一句；抽屉还开着', where(P1) === '' && t && t.text === '已放回文件夹外面' && (await state()).drawer, [saved(), t]);

// 2. 收着的文件夹：先把「旧的」折起来；拖着「随笔」停在它那一行上约 0.7 秒，它自己展开；松手放进去
await T.tap(folderSel(F2), 600);
T.ok('「旧的」折起来了', (await js(`document.querySelector(${JSON.stringify(folderSel(F2))}).getAttribute('aria-expanded')`)) === 'false');
a = await center(rowSel(P1));
await touch('touchStart', a[0], a[1]);
await T.sleep(700);
b = await center(folderSel(F2));
await slide(a, b);
await T.sleep(300);
const early = await js(`document.querySelector(${JSON.stringify(folderSel(F2))}).getAttribute('aria-expanded')`);
await T.sleep(700);
s = await state();
const opened = await js(`document.querySelector(${JSON.stringify(folderSel(F2))}).getAttribute('aria-expanded')`);
T.ok('停在收着的「旧的」上：0.3 秒时还收着，再过一会儿自己展开了；拖着的那一行还在（变淡）', early === 'false' && opened === 'true' && JSON.stringify(s.lifted) === JSON.stringify([P1])
  && JSON.stringify(s.drop) === JSON.stringify([F2]), [early, opened, s]);
b = await center(folderSel(F2));
await touch('touchMove', b[0], b[1]);
await touch('touchEnd');
await T.sleep(900);
T.ok('松手：「随笔」放进了「旧的」', where(P1) === '旧的' && (await T.count(rowSel(P1) + '.nested')) === 1, saved());

// 3. 文件夹里的「想法」拖到文件夹外面（文件夹外那本长名字的本子那一行）：整个列表画一圈虚线，松手移出文件夹；「撤销」放回「课题」
a = await center(rowSel(P2));
await touch('touchStart', a[0], a[1]);
await T.sleep(700);
b = await center(rowSel(P3));
await slide(a, b);
s = await state();
T.ok('文件夹里的本子拖到文件夹外面：列表画一圈虚线，没有文件夹标着', s.out && s.drop.length === 0, s);
await touch('touchEnd');
await T.sleep(900);
t = await toastNow();
T.ok('松手：「想法」移出了文件夹，说「已移出文件夹」，带「撤销」', where(P2) === '' && t && t.text === '已移出文件夹' && t.btn === '撤销', [saved(), t]);
await T.tap('#toast button', 900);
t = await toastNow();
T.ok('点「撤销」：「想法」回到「课题」', where(P2) === '课题' && t && t.text === '已放回「课题」', [saved(), t]);

// 4. 放在不能放的地方（抽屉外面的纸上）、或拖回自己的文件夹里：回到原处，什么都不改
let before = JSON.stringify(saved());
a = await center(rowSel(P2));
await touch('touchStart', a[0], a[1]);
await T.sleep(700);
await slide(a, [700, 600]);
s = await state();
T.ok('拖到抽屉外面：什么都不标', s.drop.length === 0 && !s.out && s.ghost === 1, s);
await touch('touchEnd');
await T.sleep(700);
s = await state();
T.ok('在抽屉外面松手：回到原处，文件夹一个字没改，抽屉还开着，影子没了', JSON.stringify(saved()) === before && s.ghost === 0 && s.lifted.length === 0 && s.drawer, [saved(), s]);
a = await center(rowSel(P2));
await touch('touchStart', a[0], a[1]);
await T.sleep(700);
b = await center(folderSel(F1));
await slide(a, b);
s = await state();
T.ok('拖到它本来就在的「课题」上：不标（放下去不会变）', s.drop.length === 0 && !s.out, s);
await touch('touchEnd');
await T.sleep(700);
T.ok('在本来的文件夹上松手：什么都不改', JSON.stringify(saved()) === before, saved());

// 5. 按住、不挪、松手：不算点击，不打开那本，什么都不改
a = await center(rowSel(P3));
await touch('touchStart', a[0], a[1]);
await T.sleep(800);
await touch('touchEnd');
await T.sleep(800);
s = await state();
T.ok('按住半秒以上、不挪就松手：不打开那本，什么都不改', s.nb === 'scratch' && JSON.stringify(saved()) === before && s.ghost === 0 && s.lifted.length === 0, s);
// 笔（电脑上的鼠标也一样）按下、抬起在同一处时浏览器照样发一次 click：抓起过的要把它吞掉
await penEv('mousePressed', a[0], a[1], 1);
await T.sleep(800);
const held = await state();
await penEv('mouseReleased', a[0], a[1], 0);
await T.sleep(800);
s = await state();
T.ok('笔按住半秒以上、原地抬起：抓起过，但不算点击，不打开那本', JSON.stringify(held.lifted) === JSON.stringify([P3]) && s.nb === 'scratch' && s.lifted.length === 0
  && JSON.stringify(saved()) === before, [held, s]);
// 笔轻点一下（不到半秒）：照常打开那本，再回到草稿本
await penEv('mousePressed', a[0], a[1], 1);
await penEv('mouseReleased', a[0], a[1], 0);
const opened5 = await T.waitFor(`window.__ink.S.nb.id === ${JSON.stringify(P3)} && window.__ink.S.page`);
T.ok('笔轻点一下（不到半秒）：照常打开那本', opened5, await js(`window.__ink.S.nb.id`));
await T.openNotebook('scratch');
await drawer(true);

// 6. 草稿本不能拖：按住也抓不起来
a = await center(rowSel('scratch'));
await touch('touchStart', a[0], a[1]);
await T.sleep(800);
s = await state();
await touch('touchEnd');
await T.sleep(800);
T.ok('按住草稿本：抓不起来', s.lifted.length === 0 && s.ghost === 0, s);
await drawer(true);

// 7. 不到半秒就挪动的照旧：上下滑是滚动抽屉，不抓起、不打开那本；左右滑长名字是看名字
await resetScroll();
a = await center(rowSel(P3));
await touch('touchStart', a[0], a[1]);
await slide(a, [a[0], a[1] - 260], 10);
s = await state();
await touch('touchEnd');
await T.sleep(800);
const s7 = await state();
T.ok('按下就往上滑（不到半秒）：抽屉照常滚动，没有抓起', s.lifted.length === 0 && s.ghost === 0 && s7.scroll > 100, [s, s7]);
T.ok('滑完没打开那本，文件夹没改', s7.nb === 'scratch' && JSON.stringify(saved()) === before, s7);
await resetScroll();
await T.sleep(300);
const nameSel = rowSel(P3) + ' .nb-name';
const n0 = await js(`document.querySelector(${JSON.stringify(nameSel)}).scrollLeft`);
const r3 = await js(`(() => { const r = document.querySelector(${JSON.stringify(nameSel)}).getBoundingClientRect(); return [r.left, r.right, r.top + r.height / 2]; })()`);
await touch('touchStart', r3[1] - 12, r3[2]);
await slide([r3[1] - 12, r3[2]], [r3[0] + 12, r3[2]]);
s = await state();
await touch('touchEnd');
await T.sleep(600);
const n1 = await js(`document.querySelector(${JSON.stringify(nameSel)}).scrollLeft`);
T.ok('按下就左右滑长名字：名字跟着走，没有抓起，没打开那本', n1 > n0 + 40 && s.lifted.length === 0 && (await state()).nb === 'scratch', [n0, n1, s]);

// 8. 笔也能拖：笔按住「课题」里的「想法」约半秒，拖到文件夹外面（长名字那一行）松手：移出文件夹
await resetScroll();
a = await center(rowSel(P2));
await penEv('mousePressed', a[0], a[1], 1);
await T.sleep(700);
s = await state();
b = await center(rowSel(P3));
for (let k = 1; k <= 10; k++) await penEv('mouseMoved', a[0] + ((b[0] - a[0]) * k) / 10, a[1] + ((b[1] - a[1]) * k) / 10, 1);
const s8 = await state();
await penEv('mouseReleased', b[0], b[1], 0);
await T.sleep(900);
T.ok('笔按住约半秒也能抓起；拖到文件夹外面松手：移出文件夹', JSON.stringify(s.lifted) === JSON.stringify([P2]) && s8.out && where(P2) === '' && (await state()).nb === 'scratch', [s, s8, saved()]);

// 9. 拖到抽屉下边缘停一会儿：抽屉自己往下滚；拖回列表外面松手，什么都不改
await resetScroll();
before = JSON.stringify(saved());
a = await center(rowSel(P2));
await touch('touchStart', a[0], a[1]);
await T.sleep(700);
const low = await js(`(() => { const r = document.querySelector('#drawer').getBoundingClientRect(); return [r.left + r.width / 2, Math.min(r.bottom, innerHeight) - 12]; })()`);
await slide(a, low);
const sc0 = (await state()).scroll;
await T.sleep(900);
const sc1 = (await state()).scroll;
T.ok('拖到抽屉下边缘：抽屉自己往下滚', sc1 > sc0 + 100, [sc0, sc1]);
await slide(low, [700, 600]);
await touch('touchEnd');
await T.sleep(700);
T.ok('拖回抽屉外面松手：什么都不改', JSON.stringify(saved()) === before && (await state()).ghost === 0, saved());

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

// 文件夹里的新建按钮（2026-11-18 用户定，《产品定义》第 2 节「抽屉里再补两样小的」：「可以在文件夹中添加一个新建本子的快捷按钮，
// 点击后直接在文件夹内新建本子」）。查：每个文件夹那一行上一个「＋」（线条图标，排在改名、删除前面），看上去 32 高，点得到的范围 ≥ 44×44，
// 不盖住旁边的改名图标和上下两行看得见的地方；长按出说明、不抓起那一行；点了走原来新建本子的那张卡片（问的照旧：名字、纸张方向），
// 卡片上多一行写着放进哪个文件夹；建好的本子在这个文件夹里（电脑上记着），收着的文件夹展开、看得到它；点「取消」什么都不建，
// 之后从抽屉底下「＋ 新建本子…」建的照旧在文件夹外面；卡片开着时那个文件夹在别处被删了：照样建，放在外面，提示说一句。英文界面也查。
// 只在无头 Edge 里用合成的点按试过。
// 跑法：node tests/run_browser.mjs <临时目录> --only folder_new；有一项不对退出码 1。截图存在 <临时目录>/folder-new/out/ 下。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from '../browser_lib.mjs';

const T = await boot({ name: 'folder-new', open: false });
const js = T.evalJS, FILE = join(T.DATA, 'notebooks', 'folders.json');
const mk = async (title) => (await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title }) })).id;
const P1 = await mk('随笔');
const F1 = (await T.apiJson('/api/folders/new', { method: 'POST', body: JSON.stringify({ name: '课题', nb: P1 }) })).id;
let F2 = (await T.apiJson('/api/folders/new', { method: 'POST', body: JSON.stringify({ name: '旧的' }) })).id;
await T.go();

// ---- 小工具
async function tap(sel, wait = 500) { // 先滚到看得见，确认这个位置点得到它再点
  const hit = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return '页面上没有'; e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t && (t === e || e.contains(t)) ? '' : '藏着或被盖住了'; })()`);
  if (hit) throw new Error(`点不到 ${sel}：${hit}`);
  await T.tap(sel, wait);
}
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) await tap('#nbChip', 600); };
const folderSel = (fid) => `#nbList .nf-item[data-fid=${JSON.stringify(fid)}]`;
const plusOf = (fid) => folderSel(fid) + ' .nf-add';
const saved = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { folders: [] });
const list = () => js(`[...document.querySelectorAll('#nbList > *')].map((r) => r.classList.contains('nf-item')
  ? '[' + r.querySelector('.nf-name').textContent + (r.getAttribute('aria-expanded') === 'true' ? ' 开' : ' 折') + ']'
  : (r.classList.contains('nested') ? '· ' : '') + r.querySelector('.nb-name').textContent + (r.classList.contains('cur') ? '（当前）' : ''))`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const toastNow = () => js(`(() => { const t = document.querySelector('#toast'); return t.hidden ? '' : (t.firstChild ? t.firstChild.textContent : ''); })()`);
// 一个元素看上去多大、实际点得到多大（和 hit_targets.mjs 一样：从中心往四个方向探，elementFromPoint 还是它就算点得到）
const reach = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null;
  const r = e.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const hit = (x, y) => { const t = document.elementFromPoint(x, y); return Boolean(t) && (t === e || e.contains(t)); };
  const go = (dx, dy) => { let k = 0; while (k < 120 && hit(cx + dx * (k + 1) / 2, cy + dy * (k + 1) / 2)) k++; return k / 2; };
  return { w: r.width, h: r.height, hitW: go(-1, 0) + go(1, 0), hitH: go(0, -1) + go(0, 1), cx, cy, top: r.top, bottom: r.bottom }; })()`);
const owner = (x, y) => js(`(() => { const t = document.elementFromPoint(${x}, ${y}); const b = t && t.closest ? t.closest('button, .nb-item, .nf-item') : null;
  return b ? (b.dataset.icon || b.dataset.nb || b.dataset.fid || b.className) : null; })()`);
async function typeTitle(text) {
  await tap('#newNbTitle', 200);
  await js(`document.querySelector('#newNbTitle').select(); 1`);
  await T.cdp('Input.insertText', { text });
}

// 1. 每个文件夹那一行上一个「＋」：排在改名、删除前面，线条图标，长按的说明；看上去 32 高，点得到 ≥ 44×44；不盖住旁边、上下的东西
await drawer(true);
const acts = await js(`[...document.querySelectorAll(${JSON.stringify(folderSel(F1) + ' .nb-acts button')})].map((b) => b.dataset.icon + ':' + b.getAttribute('aria-label') + ':' + Boolean(b.querySelector('svg path')))`);
T.ok('「课题」那一行右边：「＋」（在这个文件夹里新建本子）、改名、删除', same(acts, ['plus:在这个文件夹里新建本子:true', 'edit:改这个文件夹的名字:true',
  'trash:删除这个文件夹（里面的本子回到外面，本子本身不动）:true']), acts);
T.ok('每个文件夹都有一个「＋」', (await T.count('#nbList .nf-add')) === 2 && (await T.count(plusOf(F2))) === 1);
const pr = await reach(plusOf(F1));
T.ok('「＋」看上去 32 高，点得到的范围 ≥ 44 高、≥ 44 宽', Boolean(pr) && Math.abs(pr.h - 32) < 0.6 && pr.hitH >= 43.5 && pr.hitW >= 43.5, pr);
const er = await reach(folderSel(F1) + ' [data-icon=edit]');
const rowAbove = await js(`(() => { const r = document.querySelector('#nbList .nb-item[data-nb="scratch"]').getBoundingClientRect(); return r.bottom; })()`);
const rowBelow = await js(`(() => { const r = document.querySelector(${JSON.stringify(folderSel(F1))}).nextElementSibling.getBoundingClientRect(); return r.top; })()`);
T.ok('伸出去的范围不盖住旁边的改名图标、上下两行看得见的地方', (await owner(er.cx - er.w / 2 + 1, er.cy)) === 'edit' && (await owner(pr.cx, rowAbove - 1)) === 'scratch'
  && (await owner(pr.cx, rowBelow + 1)) === P1, [await owner(er.cx - er.w / 2 + 1, er.cy), await owner(pr.cx, rowAbove - 1), await owner(pr.cx, rowBelow + 1)]);
await T.shot('3-folder-plus.png');

// 2. 长按「＋」：出说明，不抓起那一行，也不打开新建的卡片
const p0 = [pr.cx, pr.cy];
await T.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p0[0], y: p0[1], id: 5 }] });
await T.sleep(750);
const heldLift = await T.count('#nbList .lifted');
const heldSay = await toastNow();
await T.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await T.sleep(500);
T.ok('长按「＋」：屏幕上方出它的说明，那一行没被抓起，卡片没打开', heldLift === 0 && heldSay === '在这个文件夹里新建本子' && !(await T.visible('#newNb')), [heldLift, heldSay]);

// 3. 先把「课题」折起来；点它的「＋」：抽屉收起，弹出新建本子的卡片——问的照旧（名字空着、纸张方向竖版），多一行写着放进「课题」
await tap(folderSel(F1) + ' .nf-name', 500);
T.ok('「课题」折起来了', same((await list()).slice(0, 2), ['草稿本（当前）', '[课题 折]']), await list());
const before = (await T.apiJson('/api/notebooks')).length;
await tap(plusOf(F1), 600);
T.ok('点「＋」：抽屉收起，弹出「新建本子」的卡片，名字空着、纸张方向是竖版（和抽屉底下新建的同一张）', (await T.visible('#newNb')) && !(await T.visible('#drawer'))
  && (await T.text('#newNb h3')) === '新建本子' && (await js(`document.querySelector('#newNbTitle').value`)) === '' && (await js(`document.querySelector('#newNbPaper').value`)) === 'portrait'
  && (await T.visible('#newNbTitle')) && (await T.visible('#newNbPaper')));
T.ok('卡片上多一行：建好放进文件夹「课题」', (await T.visible('#newNbIn')) && (await T.text('#newNbIn')) === '建好放进文件夹「课题」', await T.text('#newNbIn'));
await T.shot('4-folder-new-card.png');
// 4. 写名字、选横版，点「建立」：打开新的这本；电脑上它在「课题」里；抽屉里「课题」展开了，看得到它
await typeTitle('课题笔记');
await js(`(() => { const s = document.querySelector('#newNbPaper'); s.value = 'landscape'; s.dispatchEvent(new Event('change')); return 1; })()`);
await tap('#newNbOk', 300);
const opened = await T.waitFor(`window.__ink.S.nb && window.__ink.S.nb.title === '课题笔记' && window.__ink.S.page`);
const said = await toastNow();
const nbs = await T.apiJson('/api/notebooks'), fresh = nbs.find((n) => n.title === '课题笔记');
T.ok('点「建立」：建好了、打开了新的这本，屏幕上方说「已在「课题」里建立「课题笔记」」', opened && Boolean(fresh) && nbs.length === before + 1 && said === '已在「课题」里建立「课题笔记」', [opened, said]);
T.ok('电脑上：它在「课题」里（文件里记着），不在最外层', Boolean(fresh) && saved().folders.find((f) => f.id === F1).items.includes(fresh.id)
  && !((await T.apiJson('/api/folders')).top || []).includes(fresh.id), saved());
T.ok('纸张方向照选的（横版）', fresh && (await T.apiJson('/api/notebook?nb=' + encodeURIComponent(fresh.id))).paper === 'landscape');
await drawer(true);
T.ok('抽屉里「课题」展开了，新的这本在里面、是当前这本', same((await list()).slice(0, 4), ['草稿本', '[课题 开]', '· 随笔', '· 课题笔记（当前）']), await list());

// 5. 点「＋」再点「取消」：什么都不建；之后从抽屉底下「＋ 新建本子…」建的照旧在文件夹外面，卡片上没有那一行
await tap(plusOf(F2), 600);
T.ok('点「旧的」的「＋」：卡片上写着放进「旧的」', (await T.text('#newNbIn')) === '建好放进文件夹「旧的」');
await tap('#newNbCancel', 400);
T.ok('点「取消」：卡片收起，什么都没建', !(await T.visible('#newNb')) && (await T.apiJson('/api/notebooks')).length === before + 1);
await drawer(true);
await tap('#actNewNb', 600);
T.ok('抽屉底下「＋ 新建本子…」：卡片上没有「放进文件夹」那一行', (await T.visible('#newNb')) && !(await T.visible('#newNbIn')));
await typeTitle('外面的');
await tap('#newNbOk', 300);
await T.waitFor(`window.__ink.S.nb && window.__ink.S.nb.title === '外面的'`);
const outside = (await T.apiJson('/api/notebooks')).find((n) => n.title === '外面的');
T.ok('建的照旧在文件夹外面，提示照旧「已建立「外面的」」', Boolean(outside) && !saved().folders.some((f) => f.items.includes(outside.id)) && (await toastNow()) === '已建立「外面的」', saved());

// 6. 卡片开着时那个文件夹在别处删了：照样建，放在外面，提示说一句
await drawer(true);
await tap(plusOf(F2), 600);
await T.api('/api/folders/delete', { method: 'POST', body: JSON.stringify({ id: F2 }) });
await typeTitle('没地方放');
await tap('#newNbOk', 300);
await T.waitFor(`window.__ink.S.nb && window.__ink.S.nb.title === '没地方放'`);
const lost = (await T.apiJson('/api/notebooks')).find((n) => n.title === '没地方放');
T.ok('那个文件夹已经不在了：照样建好，放在外面，提示「已建立「没地方放」（那个文件夹已经不在了，放在了外面）」', Boolean(lost) && !saved().folders.some((f) => f.items.includes(lost.id))
  && (await toastNow()) === '已建立「没地方放」（那个文件夹已经不在了，放在了外面）', await toastNow());
T.ok('页面没有报错', !T.errors.length, T.errors);

// 7. 英文界面：「＋」的说明、卡片上那一行、提示、「⋯」里的上移下移都是英文（你起的名字不翻译）
F2 = (await T.apiJson('/api/folders/new', { method: 'POST', body: JSON.stringify({ name: '旧的' }) })).id;
await T.go('&lang=en');
await drawer(true);
T.ok('英文：「＋」的说明', (await js(`document.querySelector(${JSON.stringify(plusOf(F1))}).getAttribute('aria-label')`)) === 'New notebook in this folder');
await T.shot('5-en-drawer.png');
await tap(plusOf(F1), 600);
T.ok('英文：卡片上那一行（文件夹名不翻译）', (await T.text('#newNbIn')) === 'It goes into the folder “课题”', await T.text('#newNbIn'));
const cardLeft = await js(`(() => { const out = []; const w = document.createTreeWalker(document.querySelector('#newNb'), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (/[\\u3400-\\u9fff]/.test(n.nodeValue) && !/课题/.test(n.nodeValue)) out.push(n.nodeValue.trim()); return out; })()`);
T.ok('英文：卡片上没有中文（除了你起的文件夹名）', cardLeft.length === 0, cardLeft);
await T.shot('6-en-folder-new.png');
await tap('#newNbCancel', 400);
await drawer(true);
await tap(`#nbList .nb-item[data-nb=${JSON.stringify(P1)}] .nb-more`, 400);
const menuEn = await js(`[...document.querySelectorAll('#nbMenu button')].map((b) => b.textContent)`);
T.ok('英文：「⋯」里是 Move up、Move down', same(menuEn, ['Move to a folder…', 'Move up', 'Move down', 'Rename…', 'Copy this notebook…', 'Delete this notebook…']), menuEn);
await T.shot('7-en-menu.png');
const en = await js(`['已调整顺序', '已挪回原处', '已在「课题」里建立「笔记」', '已建立「笔记」（那个文件夹已经不在了，放在了外面）', '草稿本不能挪', '文件夹里不能再放文件夹',
  '没放成：草稿本不能挪'].map((s) => window.InkLang.t(s))`);
T.ok('英文：拖动、新建的提示和服务拒绝时说的', same(en, ['Order changed', 'Moved back', 'Created “笔记” in “课题”', 'Created “笔记” (that folder is gone, so it is not in any folder)',
  'The scratchpad cannot be moved', 'A folder cannot go inside another folder', 'Could not move: The scratchpad cannot be moved']), en);

T.ok('页面没有报错（英文）', !T.errors.length, T.errors);
await T.finish();

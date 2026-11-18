// 复制这本…、复制这一页…（2026-11-18 用户提的：「还希望保留复制草稿纸的功能，这样可以更改批注或者留一份有标注一份没标注」；
// 弹窗里定的「整本和单页都能复制，复制时选带什么」，《产品定义》第 2 节）。查：
// 1. 本子的「⋯」里「复制这本…」紧跟「改名…」；点了出一张卡片：标题「复制《原名》」，三选一（全部照样默认选中、不带 AI 的蓝字、只留黑笔），取消、复制。
//    取消什么都不建。
// 2. 三种各复制一次：副本排在原来那本后面；顶上说「已复制成《…》」带「打开」，点了打开副本，纸上的黑笔、红笔、AI 的蓝字
//    （短批注、圈号）对得上选的那种；原来那本一点没变。
// 3. 抽屉里页面那一排的「复制这一页」：同一张卡片（标题「复制第 N 页」），复制出的页接在这一页后面、翻过去，纸上对得上选的那种；
//    顶上说「已复制这一页」带「撤销」，点了新的那一页删掉（在「显示已删的页」里），翻回原来那一页。
// 4. 书页上那个图标灰着，点了说为什么、不出卡片；书能整本复制（副本是另一本书，底图、笔迹都在）。
// 5. 刷新后副本都还在、纸上的东西还在。6. 英文界面。
// 笔是 pointerType 为 pen 的鼠标事件；只在无头 Edge 里跑过。
// 跑法：node tests/run_browser.mjs <临时目录> --only copy；有一项不对退出码 1。截图存在 <临时目录>/copy/out/ 下。
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'copy', open: false });
const js = T.evalJS;
const SRC = join(T.ROOT, 'src'), PDF = join(SRC, '例会.pdf');
mkdirSync(SRC, { recursive: true });
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
doc=fitz.open()
for t in ['Weekly meeting: agenda','Second page']:
    p=doc.new_page(width=1000,height=562.5); p.insert_text((60,120),t,fontsize=40)
doc.save(sys.argv[1])`, PDF]);
const P = (await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title: '随笔' }) })).id;
await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title: '想法' }) }); // 排在「随笔」后面：副本要插在两本中间
const B = (await T.post('/bridge/import', { sid: 'S1', path: PDF })).id; // 一本书（第 4 节）
await T.go();
await T.openNotebook(P);

// ---- 小工具
async function tap(sel, wait = 500) { // 先滚到看得见，确认这个位置点得到它再点
  const hit = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return '页面上没有'; e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t && (t === e || e.contains(t)) ? '' : '藏着或被盖住了'; })()`);
  if (hit) throw new Error(`点不到 ${sel}：${hit}`);
  await T.tap(sel, wait);
}
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) await tap('#nbChip', 600); };
const rowSel = (nb) => `#nbList .nb-item[data-nb=${JSON.stringify(nb)}]`;
const names = () => js(`[...document.querySelectorAll('#nbList .nb-item')].map((r) => r.querySelector('.nb-name').textContent)`);
const toastNow = () => js(`(() => { const t = document.querySelector('#toast'); return t.hidden ? '' : (t.firstChild ? t.firstChild.textContent : ''); })()`);
const toastBtn = () => js(`(() => { const b = document.querySelector('#toast button'); return b && !document.querySelector('#toast').hidden ? b.textContent : ''; })()`);
const waitToast = async (re, ms = 10000) => { const t0 = Date.now(); for (;;) { const t = await toastNow(); if (re.test(t)) return t; if (Date.now() - t0 > ms) return t; await T.sleep(150); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
// 卡片：开没开、标题、三项（选中的带 ✓ 记号）、说明那一句、两个按钮
const card = () => js(`(() => { const c = document.querySelector('#copyAsk'); return { open: !c.hidden, title: document.querySelector('#copyAskTitle').textContent,
  opts: [...c.querySelectorAll('.cp-opt')].map((b) => b.dataset.mode + ':' + b.querySelector('.cp-l1').textContent + (b.classList.contains('on') && b.getAttribute('aria-checked') === 'true' ? ':选中' : '')),
  where: document.querySelector('#copyAskWhere').textContent, btns: [...c.querySelectorAll('.card-btns button')].map((b) => b.textContent),
  h: [...c.querySelectorAll('.cp-opt')].map((b) => Math.round(b.getBoundingClientRect().height)) }; })()`);
// 纸上（当前这一页）：笔迹画布上红的、黑的点有多少；批注层上画出来的 Claude 的东西（短批注、圈号……）是哪几条
const onPaper = () => js(`(() => { const c = document.querySelector('#ink'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let red = 0, dark = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 24) continue; if (d[i] > 150 && d[i + 1] < 100 && d[i + 2] < 100) red++; else if (d[i] + d[i + 1] + d[i + 2] < 200) dark++; }
  const ai = [...new Set([...document.querySelectorAll('#aiRoot [data-id]')].filter((g) => !g.classList.contains('nbr-badge')).map((g) => g.dataset.id))].sort();
  const S = window.__ink.S; return { red, dark, ai, nb: S.nb.id, title: S.nb.title, idx: S.idx, pages: S.nb.pages,
    ink: S.page.strokes.filter((s) => !s.erasedAt).map((s) => s.c || 'k').join('') }; })()`);
async function landed(n) { // 等写回的批注落到这一页（一共 n 条），并且一条条写完
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
// 「⋯」→「复制这本…」→ 选一种 → 「复制」，等顶上那一句
async function copyFromMenu(nb, mode) {
  await drawer(true);
  await tap(rowSel(nb) + ' .nb-more', 400);
  await tap('#nbMenu [data-act=copy]', 500);
  if (mode !== 'all') await tap(`#copyAsk .cp-opt[data-mode=${mode}]`, 200);
  await tap('#copyAskOk', 300);
  return waitToast(/^已复制成/);
}
const idOf = async (title) => ((await T.apiJson('/api/notebooks')).find((n) => n.title === title) || {}).id;

// 0. 准备：「随笔」上写一行黑的、一行红的，点「AI」交上去，Claude 回一条短批注、一条长回答（圈号）
await T.pen(T.line(150, 300, 220));
await T.tool('red');
await T.pen(T.line(150, 460, 220));
await T.tool('pen');
await T.saved();
await T.tap('#check');
const sub = await T.waitSub('S1', 80);
T.ok('（前提）交上去了', Boolean(sub), sub);
await T.post('/bridge/reply', { sid: 'S1', submission: sub.id, items: [{ type: 'note', anchor: 'g1', text: '单位对吗' },
  { type: 'write', anchor: 'g2', text: '因为两边的单位要一样。', fold: true }] });
T.ok('（前提）两条落到纸上了', await landed(2));
await T.saved();
const orig = await onPaper();
T.ok('（前提）原来那本纸上：黑的、红的都有，Claude 的两条画出来了', orig.red > 50 && orig.dark > 50 && orig.ai.length === 2, orig);

// 1. 「⋯」里「复制这本…」紧跟「改名…」；卡片的样子；取消什么都不建
await drawer(true);
await tap(rowSel(P) + ' .nb-more', 400);
const items = await js(`[...document.querySelectorAll('#nbMenu button')].map((b) => b.dataset.act + ':' + b.textContent)`);
T.ok('「⋯」里「复制这本…」紧跟在「改名…」后面，「删除这本…」还在最后', items.indexOf('copy:复制这本…') === items.indexOf('rename:改名…') + 1 && items.at(-1) === 'delete:删除这本…', items);
await tap('#nbMenu [data-act=copy]', 500);
let c = await card();
T.ok('卡片：标题「复制《随笔》」，三选一、「全部照样」默认选中，取消、复制', c.open && c.title === '复制《随笔》'
  && same(c.opts, ['all:全部照样:选中', 'noai:不带 AI 的蓝字', 'ink:只留黑笔（不带红字和蓝字）']) && same(c.btns, ['取消', '复制']), c);
T.ok('每一项点得到的高度 ≥ 44', c.h.every((h) => h >= 44), c.h);
T.ok('抽屉还开着（卡片盖在上面）', await T.visible('#drawer'));
await tap('#copyAsk .cp-opt[data-mode=ink]', 200);
c = await card();
T.ok('点「只留黑笔」：换成它选中，别的不选中', same(c.opts, ['all:全部照样', 'noai:不带 AI 的蓝字', 'ink:只留黑笔（不带红字和蓝字）:选中']), c.opts);
await T.shot('1-copy-card.png');
const n0 = (await T.apiJson('/api/notebooks')).length;
await tap('#copyAskCancel', 400);
T.ok('点「取消」：卡片收起，什么都没建', !(await card()).open && (await T.apiJson('/api/notebooks')).length === n0);
await tap(rowSel(P) + ' .nb-more', 400);
await tap('#nbMenu [data-act=copy]', 500);
T.ok('再打开：又是「全部照样」选中', (await card()).opts[0] === 'all:全部照样:选中', (await card()).opts);
await T.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await T.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await T.sleep(300);
T.ok('按 Esc：卡片收起，什么都没建，抽屉还开着', !(await card()).open && (await T.apiJson('/api/notebooks')).length === n0 && (await T.visible('#drawer')));

// 2. 三种各复制一次
const t1 = await copyFromMenu(P, 'all');
T.ok('全部照样：顶上说「已复制成《随笔 副本》」，带「打开」', t1 === '已复制成《随笔 副本》' && (await toastBtn()) === '打开', [t1, await toastBtn()]);
T.ok('副本排在原来那本后面（「想法」前面），抽屉还开着', same(await names(), ['草稿本', '随笔', '随笔 副本', '想法', '例会']) && (await T.visible('#drawer')), await names());
T.ok('复制完没有翻过去（还在原来那本）', (await S('S.nb.id')) === P);
await T.shot('2-copied-toast.png');
const C1 = await idOf('随笔 副本');
await tap('#toast button', 1500);
let p = await onPaper();
T.ok('点「打开」：打开了副本', p.nb === C1 && p.title === '随笔 副本', p);
T.ok('全部照样：黑的、红的、Claude 的两条都在纸上（和原来那本一样）', p.red > 50 && p.dark > 50 && same(p.ai, orig.ai), [p, orig.ai]);

await T.openNotebook(P);
const t2 = await copyFromMenu(P, 'noai');
const C2 = await idOf('随笔 副本 2');
T.ok('不带 AI 的蓝字：重名加 2，排在原来那本后面', t2 === '已复制成《随笔 副本 2》' && same(await names(), ['草稿本', '随笔', '随笔 副本 2', '随笔 副本', '想法', '例会']), [t2, await names()]);
await tap('#toast button', 1500);
p = await onPaper();
T.ok('不带 AI 的蓝字：黑的、红的都在，Claude 的一条都没有', p.nb === C2 && p.red > 50 && p.dark > 50 && p.ai.length === 0, p);

await T.openNotebook(P);
const t3 = await copyFromMenu(P, 'ink');
const C3 = await idOf('随笔 副本 3');
T.ok('只留黑笔：顶上说了', t3 === '已复制成《随笔 副本 3》', t3);
await tap('#toast button', 1500);
p = await onPaper();
T.ok('只留黑笔：只有黑的，没有红的、没有 Claude 的', p.nb === C3 && p.red === 0 && p.dark > 50 && p.ai.length === 0, p);

await T.openNotebook(P);
p = await onPaper();
T.ok('原来那本一点没变', p.nb === P && p.red > 50 && p.dark > 50 && same(p.ai, orig.ai), p);

// 3. 复制这一页
await drawer(true);
const pbtn = await js(`(() => { const b = document.querySelector('#actCopyPage'); return { label: b.getAttribute('aria-label'), icon: Boolean(b.querySelector('svg path')), off: b.classList.contains('off'),
  row: [...b.parentElement.querySelectorAll('button')].map((x) => x.id) }; })()`);
T.ok('页面那一排有「复制这一页」（线条图标，排在删除前面），空白纸上不灰', pbtn.icon && !pbtn.off && pbtn.label === '复制这一页…（选带什么，接在这一页后面）'
  && same(pbtn.row, ['actTurnL', 'actTurnR', 'actAddPortrait', 'actAddLandscape', 'actCopyPage', 'actDelPage']), pbtn);
await T.shot('5-page-icons.png');
await tap('#actCopyPage', 500);
c = await card();
T.ok('点了：同一张卡片，标题「复制第 1 页」，「全部照样」选中', c.open && c.title === '复制第 1 页' && c.opts[0] === 'all:全部照样:选中' && c.where === '复制出的页接在这一页后面，复制完翻过去。', c);
await tap('#copyAsk .cp-opt[data-mode=noai]', 200);
const key0 = await S('S.nb.pageInfo[0].key');
await tap('#copyAskOk', 300);
const tp = await waitToast(/^已复制这一页/);
await T.waitFor(`window.__ink.S.page && window.__ink.S.idx === 1`, 5000);
p = await onPaper();
T.ok('复制出的页接在后面、翻过去了：顶上说「已复制这一页」，带「撤销」', tp === '已复制这一页' && (await toastBtn()) === '撤销' && p.idx === 1 && p.pages === 2, [tp, p]);
const key1 = await S('S.nb.pageInfo[1].key');
T.ok('新的一页有自己的键，第 1 页还是原来那一页', key1 !== key0 && (await S('S.nb.pageInfo[0].key')) === key0, [key0, key1]);
T.ok('不带 AI 的蓝字：新的一页上黑的、红的都在，Claude 的没有', p.red > 50 && p.dark > 50 && p.ai.length === 0, p);
T.ok('撤销记录不带过来（新的一页从空的撤销记录开始）', (await S('S.undo.length')) === 0);
await T.shot('3-page-copied-undo.png');
await tap('#toast button', 1200);
await T.waitFor(`window.__ink.S.page && window.__ink.S.nb.pages === 1`, 5000);
p = await onPaper();
const hidden = await T.apiJson(`/api/page/hidden?nb=${encodeURIComponent(P)}`);
T.ok('点「撤销」：新的一页删掉了（在「显示已删的页」里），翻回原来那一页，纸上照旧', (await toastNow()) === '已撤销复制' && p.pages === 1 && p.idx === 0
  && hidden.some((h) => h.key === key1) && p.red > 50 && same(p.ai, orig.ai), [await toastNow(), p, hidden]);
// 再复制一页（全部照样）留着，刷新后看
await tap('#actCopyPage', 500);
await tap('#copyAskOk', 300);
await waitToast(/^已复制这一页/);
await T.waitFor(`window.__ink.S.page && window.__ink.S.idx === 1`, 5000);
await T.sleep(600);
p = await onPaper();
T.ok('全部照样复制一页：Claude 的两条也在新的一页上', p.idx === 1 && p.red > 50 && p.ai.length === 2, p);

// 4. 书：页面那一排的「复制这一页」灰着，点了说为什么；书能整本复制
await js(`document.querySelector('#toast').hidden = true`); // 上一句提示（还没到时候收起）先收起，下面看的是新的
await drawer(false); // 抽屉开着时笔落在抽屉上（会点到别的本子）
await T.openNotebook(B);
await T.pen(T.line(150, 300, 200));
await T.saved();
await drawer(true);
const off = await js(`(() => { const b = document.querySelector('#actCopyPage'); return { nb: window.__ink.S.nb.id, pi: window.__ink.S.nb.pageInfo[window.__ink.S.idx],
  off: b.classList.contains('off'), aria: b.getAttribute('aria-disabled') }; })()`);
T.ok('书页上「复制这一页」灰着', off.nb === B && off.off && off.aria === 'true', off);
await tap('#actCopyPage', 500);
T.ok('点了：说一句为什么，不出卡片', (await toastNow()) === '书页不能单独复制（可以在这本的「⋯」里复制整本）' && !(await card()).open, await toastNow());
const tb = await copyFromMenu(B, 'all');
T.ok('书整本复制：顶上说了', tb === '已复制成《例会 副本》', tb);
await tap('#toast button', 2000);
const bp = await onPaper();
const bgDark = await js(`(() => { const c = document.querySelector('#bg'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 200) n++; return n; })()`);
T.ok('打开书的副本：是另一本书，底图（原文件的字）和写的那一笔都在', bp.nb === 'book:例会 副本.pdf' && bp.dark > 20 && bgDark > 50 && (await S('S.nb.kind')) === 'book', [bp, bgDark]);

// 5. 刷新后还在
await T.reload();
await drawer(true);
const after = await names();
T.ok('刷新后：几本副本都还在，排在原来那本后面', same(after, ['草稿本', '随笔', '随笔 副本 3', '随笔 副本 2', '随笔 副本', '想法', '例会', '例会 副本']), after);
await T.openNotebook(C1);
p = await onPaper();
T.ok('刷新后打开「随笔 副本」：纸上的照旧', p.nb === C1 && p.red > 50 && same(p.ai, orig.ai), p);
T.ok('页面没有报错', !T.errors.length, T.errors);

// 6. 英文界面
await T.go('&lang=en');
await T.openNotebook(P);
await drawer(true);
await tap(rowSel(P) + ' .nb-more', 400);
const menuEn = await js(`[...document.querySelectorAll('#nbMenu button')].map((b) => b.textContent)`);
T.ok('英文：「⋯」里是 Copy this notebook…', menuEn.includes('Copy this notebook…'), menuEn);
await tap('#nbMenu [data-act=copy]', 500);
c = await card();
const cardLeft = await js(`(() => { const out = []; const w = document.createTreeWalker(document.querySelector('#copyAsk'), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (/[\\u3400-\\u9fff]/.test(n.nodeValue.replace('随笔', ''))) out.push(n.nodeValue.trim()); return out; })()`);
T.ok('英文：卡片（本子名是你起的，不翻译）', c.title === 'Copy “随笔”' && same(c.opts, ['all:Everything as it is:选中', "noai:Without the AI's blue writing", 'ink:Black ink only (no red, no blue)'])
  && same(c.btns, ['Cancel', 'Copy']) && cardLeft.length === 0, [c, cardLeft]);
await T.shot('4-en-copy-card.png');
await tap('#copyAskOk', 300);
const te = await waitToast(/^Copied as/);
T.ok('英文：副本叫「随笔 copy」，提示是英文、带 Open', te === 'Copied as “随笔 copy”' && (await toastBtn()) === 'Open', [te, await toastBtn()]);
T.ok('英文：「复制这一页」的说明', (await js(`document.querySelector('#actCopyPage').getAttribute('aria-label')`)) === 'Copy this page… (choose what to keep; the copy goes right after this page)');
await tap('#actCopyPage', 500);
T.ok('英文：复制一页的卡片标题', (await card()).title === 'Copy page 1' && (await card()).where === 'The copy goes right after this page, and you are taken to it.', await card());
await tap('#copyAskCancel', 300);
await T.shot('6-en-page-row.png');
const en = await js(`['已复制这一页', '已撤销复制', '没复制成：只有空白纸能复制：书页、推送的页还不能复制（可以复制整本）', '书页不能单独复制（可以在这本的「⋯」里复制整本）',
  '推送的页不能复制', '没复制成：推送的本子还不能复制（它的页是对话推来的图，每页记着发回哪个对话）', '复制《草稿本》'].map((s) => window.InkLang.t(s))`);
T.ok('英文：提示和服务拒绝时说的', same(en, ['Page copied', 'Copy undone',
  'Could not copy: Only blank paper can be copied: document pages and pushed pages cannot be copied yet (you can copy the whole notebook)',
  'A document page cannot be copied on its own (you can copy the whole notebook from its “⋯” menu)', 'Pushed pages cannot be copied',
  'Could not copy: Pushed notebooks cannot be copied yet (their pages are images pushed by sessions, and each page remembers which session it goes back to)',
  'Copy “Scratchpad”']), en);

T.ok('页面没有报错（英文）', !T.errors.length, T.errors);
await T.finish();

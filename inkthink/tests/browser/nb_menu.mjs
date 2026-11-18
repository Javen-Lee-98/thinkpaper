// 抽屉里一本右边的「⋯」（2026-11-16 用户定，《产品定义》第 2 节「交互上补的八样」）：原来排着的存回 PDF、文件夹、改名、删除四个图标
// 收成一个「⋯」，点开是一张写着字的小菜单——放进文件夹…、改名…、删除这本…，当前这本有原 PDF 时多一项「存回 PDF」。
// 查：每本只剩一个「⋯」（行里没有图标了），草稿本没有（推送本子 2026-11-17 起有）；菜单紧挨着「⋯」、在抽屉上面、整个在屏幕里，开着时「⋯」白底加粗边框；
// 同时只开一张（点另一本的「⋯」换成那本的）；点菜单外面收起、抽屉不收；再点同一个「⋯」收起；点「⋯」不会打开那本，点名字照常打开；
// 当前这本是从电脑上的 PDF 导入的：菜单里多一项「存回 PDF」，各项沿用原来图标的 id；别的那本的菜单里没有它；
// 点菜单里的一项：菜单收起、抽屉还开着，做的事照旧（放进文件夹 → 选文件夹的小列表；改名 → 问名字；删除 → 先问一句）。
// 跑法：node tests/browser/nb_menu.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'nb-menu', open: false });
const js = T.evalJS, SRC = join(T.ROOT, 'src');
mkdirSync(SRC, { recursive: true });
// 准备：两本自己建的本子、两份 PDF（像 Claude 那样导入，记着电脑上的原文件）、Claude 推过来的一页
const mk = async (title) => (await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title }) })).id;
const P1 = await mk('随笔'), P2 = await mk('想法');
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
for path in sys.argv[1:3]:
    doc=fitz.open(); p=doc.new_page(width=960,height=540); p.insert_text((60,120),"slide",fontsize=28); doc.save(path)
pix=fitz.Pixmap(fitz.csRGB, fitz.IRect(0,0,200,120), 0); pix.set_rect(pix.irect,(200,220,255)); pix.save(sys.argv[3])`, join(SRC, '例会.pdf'), join(SRC, '周报.pdf'), join(SRC, 'fig.png')]);
const B1 = (await T.post('/bridge/import', { sid: 'S1', path: join(SRC, '例会.pdf') })).id;
const B2 = (await T.post('/bridge/import', { sid: 'S1', path: join(SRC, '周报.pdf') })).id;
await T.post('/bridge/show', { sid: 'S1', path: join(SRC, 'fig.png'), title: '图' });
await T.go();

// ---- 小工具
// 真的点一下：先滚到看得见，确认这个位置点得到它（没藏着、没被盖住）再点
async function tap(sel, wait = 500) {
  const hit = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return '页面上没有'; e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t && (t === e || e.contains(t)) ? '' : '藏着或被盖住了'; })()`);
  if (hit) throw new Error(`点不到 ${sel}：${hit}`);
  await T.tap(sel, wait);
}
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) await tap('#nbChip', 500); };
const rowSel = (nb) => `#nbList .nb-item[data-nb=${JSON.stringify(nb)}]`;
const moreOf = (nb) => rowSel(nb) + ' .nb-more';
const menu = () => js(`(() => { const m = document.querySelector('#nbMenu'); return { open: !m.hidden, nb: m.dataset.nb || '',
  items: [...m.querySelectorAll('button')].map((b) => b.dataset.act + ':' + b.textContent + (b.id ? '#' + b.id : '')) }; })()`);
const onMarks = () => js(`[...document.querySelectorAll('#nbList .nb-more.on')].map((b) => b.closest('.nb-item').dataset.nb)`);
const answer = (kind, val) => js(`window.__asked = []; window.${kind} = (m) => { window.__asked.push(m); return ${JSON.stringify(val)}; }; 1`);

// 1. 每本只剩一个「⋯」，行里没有图标了（推送本子 2026-11-17 起和别的本子一样有；草稿本 2026-11-18 起也有，里面只有「复制这本…」）
await drawer(true);
const rows = await js(`[...document.querySelectorAll('#nbList .nb-item')].map((r) => ({ nb: r.dataset.nb, more: r.querySelectorAll('.nb-more').length,
  icons: r.querySelectorAll('[data-icon]').length, text: (r.querySelector('.nb-more') || {}).textContent || '' }))`);
T.ok('每本（草稿本、自己的本子、推送本子、导入的书）右边只有一个「⋯」，没有图标了', rows.length === 6 && rows.some((r) => r.nb.startsWith('board:'))
  && rows.some((r) => r.nb === 'scratch') && rows.every((r) => r.more === 1 && r.icons === 0 && r.text === '⋯'), rows);
await tap(moreOf('scratch'), 400);
T.ok('草稿本的「⋯」里只有「复制这本…」（不改名、不删、不进文件夹、不挪）', JSON.stringify((await menu()).items) === JSON.stringify(['copy:复制这本…#actCopyNb']), await menu());
await tap(moreOf('scratch'), 300);
const room = await js(`(() => { const r = document.querySelector(${JSON.stringify(rowSel(P1))}), n = r.querySelector('.nb-name'), m = r.querySelector('.nb-more');
  return { row: Math.round(r.getBoundingClientRect().width), name: Math.round(n.getBoundingClientRect().width), more: Math.round(m.getBoundingClientRect().width),
    label: m.getAttribute('aria-label'), h: Math.round(m.getBoundingClientRect().height) }; })()`);
T.ok('「⋯」不宽（名字占了这一行的大半），够得着手指（高 32 以上），长按的说明是「更多操作」', room.more <= 48 && room.name >= room.row - 70 && room.h >= 32 && room.label === '更多操作', room);

// 2. 点「⋯」：菜单紧挨着它、在抽屉上面、整个在屏幕里；开着时「⋯」白底加粗边框；不会打开那本
const before = await js(`window.__ink.S.nb.id`);
await tap(moreOf(P1), 400);
let m = await menu();
T.ok('点「随笔」的「⋯」：弹出它的菜单——放进文件夹…、上移、下移、改名…、复制这本…（2026-11-18）、删除这本…（不是当前这本，没有 id、没有存回 PDF）',
  m.open && m.nb === P1 && JSON.stringify(m.items) === JSON.stringify(['folder:放进文件夹…', 'up:上移', 'down:下移', 'rename:改名…', 'copy:复制这本…', 'delete:删除这本…']), m);
const geo = await js(`(() => { const p = document.querySelector('#nbMenu').getBoundingClientRect(), b = document.querySelector(${JSON.stringify(moreOf(P1))}).getBoundingClientRect(),
  cs = getComputedStyle(document.querySelector(${JSON.stringify(moreOf(P1))}));
  return { gap: Math.round(p.top - b.bottom), right: Math.round(Math.abs(p.right - b.right)), inScreen: p.left >= 0 && p.right <= innerWidth && p.top >= 0 && p.bottom <= innerHeight,
    above: Number(getComputedStyle(document.querySelector('#nbMenu')).zIndex) > Number(getComputedStyle(document.querySelector('#drawer')).zIndex),
    bg: cs.backgroundColor, ring: cs.boxShadow }; })()`);
T.ok('菜单紧挨着「⋯」（下面、靠右对齐）、整个在屏幕里、盖在抽屉上面', geo.gap >= 0 && geo.gap <= 8 && geo.right <= 2 && geo.inScreen && geo.above, geo);
T.ok('菜单开着时「⋯」是白底加粗边框（选中的样子，不整块涂色）', (await onMarks()).join() === P1 && geo.bg === 'rgb(255, 255, 255)' && /1\.5px/.test(geo.ring), geo);
T.ok('点「⋯」不会打开那本、不收起抽屉', (await js(`window.__ink.S.nb.id`)) === before && (await T.visible('#drawer')), await js(`window.__ink.S.nb.id`));
await T.shot('1-menu.png');

// 3. 再点同一个「⋯」：收起
await tap(moreOf(P1), 400);
T.ok('再点同一个「⋯」：菜单收起', !(await menu()).open && (await onMarks()).length === 0, await menu());
// 4. 同时只开一张：开着最下面那本书的菜单时点上面「随笔」的「⋯」（菜单往下开，盖不住上面那几行），换成「随笔」的菜单
await tap(moreOf(B2), 400);
T.ok('点最下面那本的「⋯」：开它的菜单', (await menu()).nb === B2 && (await onMarks()).join() === B2, await menu());
await tap(moreOf(P1), 400);
m = await menu();
T.ok('开着一张时点另一本的「⋯」：换成那本的菜单，同时只开一张', m.open && m.nb === P1 && (await T.count('#nbMenu')) === 1 && (await onMarks()).join() === P1, [m, await onMarks()]);
await tap(moreOf(P1), 400);
// 5. 点菜单外面（抽屉里的空处）：收起，抽屉还开着
await tap(moreOf(P1), 400);
await tap('.dr-head', 400);
T.ok('点菜单外面（抽屉里别处）：菜单收起，抽屉还开着', !(await menu()).open && (await T.visible('#drawer')) && (await onMarks()).length === 0, await menu());
// 点纸面：菜单和抽屉一起收起
await tap(moreOf(P1), 400);
await T.fingerTapAt(780, 900, 500);
T.ok('点纸面：菜单和抽屉一起收起', !(await menu()).open && !(await T.visible('#drawer')), await menu());

// 6. 当前这本是从 PDF 导入的：菜单里多一项「存回 PDF」，各项沿用原来的 id；另一本书的菜单里没有
await T.openNotebook(B1);
await drawer(true);
await tap(moreOf(B1), 400);
m = await menu();
T.ok('当前这本（从电脑上的 PDF 导入）：菜单里多一项「存回 PDF」，各项是原来那几个图标的 id',
  JSON.stringify(m.items) === JSON.stringify(['folder:放进文件夹…#actFolder', 'up:上移#actUp', 'down:下移#actDown', 'rename:改名…#actRename', 'copy:复制这本…#actCopyNb',
    'save:存回 PDF#actSavePdf', 'delete:删除这本…#actDelete']), m);
await tap(moreOf(B1), 300); // 收起（菜单往下开，盖着下面那本的「⋯」）
await tap(moreOf(B2), 400);
m = await menu();
T.ok('另一本书（不是当前这本）：没有「存回 PDF」，也没有那几个 id', JSON.stringify(m.items) === JSON.stringify(['folder:放进文件夹…', 'up:上移', 'down:下移', 'rename:改名…', 'copy:复制这本…', 'delete:删除这本…']), m);
await tap(moreOf(B2), 300);

// 7. 点菜单里的一项：菜单收起、抽屉还开着，做的事照旧
await tap(moreOf(P1), 400);
await tap('#nbMenu [data-act=folder]', 500);
T.ok('「放进文件夹…」：菜单收起，弹出选文件夹的小列表，抽屉还开着', !(await menu()).open && (await T.visible('#folderPick')) && (await T.visible('#drawer'))
  && (await js(`document.querySelector('#folderPick').dataset.nb`)) === P1, await menu());
await tap('#folderPickCancel', 300);
await answer('prompt', null);
await tap(moreOf(P2), 400);
await tap('#nbMenu [data-act=rename]', 500);
const askedR = await js(`window.__asked`);
T.ok('「改名…」：照旧问改成什么名字（取消就不改），抽屉还开着', askedR.length === 1 && /改成什么名字/.test(askedR[0]) && (await T.visible('#drawer'))
  && (await js(`[...document.querySelectorAll('#nbList .nb-name')].map((e) => e.title)`)).includes('想法'), askedR);
await answer('confirm', false);
await tap(moreOf(P2), 400);
await tap('#nbMenu [data-act=delete]', 500);
const askedD = await js(`window.__asked`);
T.ok('「删除这本…」：照旧先问一句（取消就不删）', askedD.length === 1 && askedD[0].startsWith('从列表里删除「想法」？') && (await T.apiJson('/api/notebooks')).some((n) => n.id === P2), askedD);

// 8. 点名字照常打开那本
await tap(rowSel(P1) + ' .nb-name', 1200);
T.ok('点一本的名字照常打开它', (await js(`window.__ink.S.nb.id`)) === P1, await js(`window.__ink.S.nb.id`));

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

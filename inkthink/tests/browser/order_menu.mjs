// 不拖也能改上下顺序：一本的「⋯」菜单里的「上移」「下移」（2026-11-18 用户定，《产品定义》第 2 节「抽屉里再补两样小的」；
// 和拖进文件夹留着「放进文件夹…」是同一个道理）。查：两项排在「放进文件夹…」后面；在它所在的那一层里换位置——最外层时文件夹算一个
// （上移越过整个文件夹，不会进去），文件夹里时只在文件夹里换（到头了不会移出去）；到头了的那一项灰掉、点了不动；草稿本上面不能再排东西；
// 点了以后菜单不收，在这本挪到的新位置旁边重新打开，可以接着点；不打开那本、不收抽屉；顺序记在电脑上，刷新后还在。
// 只在无头 Edge 里用合成的点按试过。
// 跑法：node tests/run_browser.mjs <临时目录> --only order_menu；有一项不对退出码 1。截图存在 <临时目录>/order-menu/out/ 下。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from '../browser_lib.mjs';

const T = await boot({ name: 'order-menu', open: false });
const js = T.evalJS, FILE = join(T.DATA, 'notebooks', 'folders.json');
const mk = async (title) => (await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title }) })).id;
const P1 = await mk('随笔'), P2 = await mk('想法'), P3 = await mk('读书笔记'), P4 = await mk('草图');
const F1 = (await T.apiJson('/api/folders/new', { method: 'POST', body: JSON.stringify({ name: '课题', nb: P2 }) })).id;
await T.api('/api/folders/move', { method: 'POST', body: JSON.stringify({ nb: P4, folder: F1 }) });
await T.go();

// ---- 小工具
async function tap(sel, wait = 500) { // 先滚到看得见，确认这个位置点得到它再点
  const hit = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return '页面上没有'; e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t && (t === e || e.contains(t)) ? '' : '藏着或被盖住了'; })()`);
  if (hit) throw new Error(`点不到 ${sel}：${hit}`);
  await T.tap(sel, wait);
}
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) await tap('#nbChip', 600); };
const rowSel = (nb) => `#nbList .nb-item[data-nb=${JSON.stringify(nb)}]`;
const saved = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { folders: [] });
const list = () => js(`[...document.querySelectorAll('#nbList > *')].map((r) => r.classList.contains('nf-item')
  ? '[' + r.querySelector('.nf-name').textContent + ']' : (r.classList.contains('nested') ? '· ' : '') + r.querySelector('.nb-name').textContent)`);
const menu = () => js(`(() => { const m = document.querySelector('#nbMenu'), b = document.querySelector('#nbList .nb-more.on');
  const p = m.getBoundingClientRect(), a = b ? b.getBoundingClientRect() : null;
  return { open: !m.hidden, nb: m.dataset.nb || '', items: [...m.querySelectorAll('button')].map((x) => x.dataset.act + (x.disabled ? '(灰)' : '')),
    anchor: b ? b.closest('.nb-item').dataset.nb : '', gap: a ? Math.round(p.top - a.bottom) : null }; })()`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// 打开某一本的菜单：开着别的那本的先点外面收起（菜单往下开，会盖住下面几行的「⋯」）
const openMenu = async (nb) => {
  const m = await menu();
  if (m.open && m.nb === nb) return;
  if (m.open) await tap('.dr-head', 300);
  await tap(rowSel(nb) + ' .nb-more', 400);
};

await drawer(true);
T.ok('准备：课题（想法、草图）、随笔、读书笔记', same(await list(), ['草稿本', '[课题]', '· 想法', '· 草图', '随笔', '读书笔记']), await list());

// 1. 「随笔」的菜单：放进文件夹…、上移、下移、改名…、删除这本…；它上面是文件夹、下面是读书笔记，两项都能点
await openMenu(P1);
let m = await menu();
T.ok('「⋯」菜单：放进文件夹…后面是上移、下移，都能点', m.open && same(m.items, ['folder', 'up', 'down', 'rename', 'copy', 'delete']), m);
T.ok('两项的字是「上移」「下移」', same(await js(`[...document.querySelectorAll('#nbMenu [data-act=up], #nbMenu [data-act=down]')].map((b) => b.textContent)`), ['上移', '下移']));
await T.shot('3-menu-up-down.png');
// 最后一本的「下移」灰掉
await tap(rowSel(P1) + ' .nb-more', 300);
await openMenu(P3);
T.ok('最后一本（读书笔记）：「下移」灰掉', same((await menu()).items, ['folder', 'up', 'down(灰)', 'rename', 'copy', 'delete']), await menu());
await tap(rowSel(P3) + ' .nb-more', 300);

// 2. 「随笔」点「下移」：和读书笔记换位置；菜单不收、在随笔的新位置旁边重新打开，现在它是最后一本，「下移」灰掉；点灰掉的不动
await openMenu(P1);
await tap('#nbMenu [data-act=down]', 900);
m = await menu();
T.ok('点「下移」：随笔排到读书笔记下面', same(await list(), ['草稿本', '[课题]', '· 想法', '· 草图', '读书笔记', '随笔']), await list());
T.ok('菜单没收，挨着随笔新位置上的「⋯」重新打开；到了最后，「下移」灰掉', m.open && m.nb === P1 && m.anchor === P1 && m.gap >= 0 && m.gap <= 8
  && same(m.items, ['folder', 'up', 'down(灰)', 'rename', 'copy', 'delete']), m);
T.ok('没有打开那本，抽屉还开着', (await js(`window.__ink.S.nb.id`)) === 'scratch' && (await T.visible('#drawer')));
T.ok('电脑上记下了：最外层是 课题、读书笔记、随笔', same(saved().top, [F1, P3, P1]), saved());
await T.tap('#nbMenu [data-act=down]', 700);
T.ok('点灰掉的「下移」：什么都不动', same(await list(), ['草稿本', '[课题]', '· 想法', '· 草图', '读书笔记', '随笔']) && same(saved().top, [F1, P3, P1]), await list());

// 3. 接着点「上移」两次：先和读书笔记换，再越过整个「课题」（文件夹算一个，不会放进去）；到了最上面（草稿本下面），「上移」灰掉
await openMenu(P1);
await tap('#nbMenu [data-act=up]', 900);
T.ok('点「上移」：随笔回到读书笔记上面', same(await list(), ['草稿本', '[课题]', '· 想法', '· 草图', '随笔', '读书笔记']), await list());
await tap('#nbMenu [data-act=up]', 900);
m = await menu();
T.ok('再点「上移」：随笔越过整个「课题」排到它上面，没有进文件夹', same(await list(), ['草稿本', '随笔', '[课题]', '· 想法', '· 草图', '读书笔记'])
  && same(saved().folders[0].items, [P2, P4]) && same(saved().top, [P1, F1, P3]), [await list(), saved()]);
T.ok('到了最上面（草稿本照旧在它上面）：「上移」灰掉', m.open && m.nb === P1 && same(m.items, ['folder', 'up(灰)', 'down', 'rename', 'copy', 'delete']), m);

// 4. 文件夹里的本子：只在文件夹里换；第一本的「上移」灰掉（不会移出文件夹）；「下移」和草图换；到了最后「下移」灰掉
await openMenu(P2);
T.ok('文件夹里第一本（想法）：「上移」灰掉，不会移出文件夹', same((await menu()).items, ['folder', 'up(灰)', 'down', 'rename', 'copy', 'delete']), await menu());
await tap('#nbMenu [data-act=down]', 900);
m = await menu();
T.ok('点「下移」：文件夹里换成草图、想法；菜单在想法旁边重新打开，「下移」灰掉（不会移出文件夹）', same(await list(), ['草稿本', '随笔', '[课题]', '· 草图', '· 想法', '读书笔记'])
  && m.open && m.nb === P2 && same(m.items, ['folder', 'up', 'down(灰)', 'rename', 'copy', 'delete']), [await list(), m]);
T.ok('电脑上记下了文件夹里的先后', same(saved().folders[0].items, [P4, P2]) && saved().folders[0].ordered === true, saved());

// 5. 点菜单外面收起；刷新后顺序还在
await tap('.dr-head', 400);
T.ok('点菜单外面：菜单收起，抽屉还开着', !(await menu()).open && (await T.visible('#drawer')));
const shown = await list();
await T.reload();
await drawer(true);
T.ok('刷新后顺序还在', same(await list(), shown), [await list(), shown]);

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

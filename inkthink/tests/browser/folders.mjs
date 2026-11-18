// 抽屉里的本子分文件夹（《产品定义》第 2 节，2026-11-14 用户定）：只有一层；底下「＋ 新建文件夹…」；每本右边的「⋯」菜单里有「放进文件夹…」
// （2026-11-16 起原来那个文件夹图标收进了「⋯」），点开的小列表能放进哪个文件夹、移出文件夹（在文件夹里时才有）、新建文件夹…；文件夹一行点一下折叠 / 展开，写着里面几本，
// 折叠状态记在这台设备上（刷新后还记得）；文件夹能改名、能删（删前问一句，里面的本子回到外面，本子本身不动）；
// 草稿本没有「⋯」（不进文件夹）；推送本子（2026-11-17 起「推送 · 文件夹名」）和别的本子一样排在里面、有「⋯」；
// 当前打开的本子在折叠着的文件夹里时那个文件夹自动展开；新建的本子在文件夹外面；
// 电脑上的 notebooks/folders.json 记的和抽屉里看到的一样；删掉一本、文件里有已经不在的本子，文件夹照常显示。
// 截图存在 <临时目录>/folders/out/ 下。
// 跑法：node tests/browser/folders.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'folders', open: false });
const js = T.evalJS, SRC = join(T.ROOT, 'src'), FILE = join(T.DATA, 'notebooks', 'folders.json');
mkdirSync(SRC, { recursive: true });
// 准备：三个自己建的本子、一本导入的书、对话推过来的一页（进它所在文件夹的推送本子「推送 · idea」）
const mk = async (title) => (await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title }) })).id;
const P1 = await mk('随笔'), P2 = await mk('想法'), P3 = await mk('读书笔记');
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
doc=fitz.open(); p=doc.new_page(width=960,height=540); p.insert_text((60,120),"slide",fontsize=28); doc.save(sys.argv[1])
pix=fitz.Pixmap(fitz.csRGB, fitz.IRect(0,0,200,120), 0); pix.set_rect(pix.irect,(200,220,255)); pix.save(sys.argv[2])`, join(SRC, '例会_v47.pdf'), join(SRC, 'fig.png')]);
await T.post('/bridge/import', { sid: 'S1', path: join(SRC, '例会_v47.pdf') });
await T.post('/bridge/show', { sid: 'S1', path: join(SRC, 'fig.png'), title: '图' });
const BOOK = 'book:例会_v47.pdf', PUSH = '推送 · idea';
await T.go();

// ---- 小工具
// 真的点一下：先滚到看得见，确认这个位置点得到它（没藏着、没被盖住）再点
async function tap(sel, wait = 600) {
  const hit = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return '页面上没有'; e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t && (t === e || e.contains(t)) ? '' : '藏着或被盖住了'; })()`);
  if (hit) throw new Error(`点不到 ${sel}：${hit}`);
  await T.tap(sel, wait);
}
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) await tap('#nbChip', 500); };
// 抽屉里的列表从上到下：文件夹一行写「[名字 几本 折/开]」，本子一行写「名字」（在文件夹里的前面带「· 」），还有它右边有没有「⋯」
const list = () => js(`[...document.querySelectorAll('#nbList > *')].map((r) => r.classList.contains('nf-item')
  ? { f: r.querySelector('.nf-name').textContent, n: r.querySelector('.nf-count').textContent, open: r.getAttribute('aria-expanded') === 'true', mark: r.querySelector('.nf-mark').textContent, fid: r.dataset.fid }
  : { nb: r.dataset.nb, name: r.querySelector('.nb-name').textContent, nested: r.classList.contains('nested'), more: Boolean(r.querySelector('.nb-more')),
      cur: r.classList.contains('cur') })`);
const short = (L) => L.map((r) => (r.f !== undefined ? `[${r.f} ${r.n} ${r.open ? '开' : '折'}]` : (r.nested ? '· ' : '') + r.name));
const saved = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null);
const fidOf = (name) => ((saved() || { folders: [] }).folders.find((f) => f.name === name) || {}).id;
const rowSel = (nb) => `#nbList .nb-item[data-nb=${JSON.stringify(nb)}]`;
const folderSel = (fid) => `#nbList .nf-item[data-fid=${JSON.stringify(fid)}]`;
const pickItems = () => js(`[...document.querySelectorAll('#folderPickList > *')].map((e) => ({ id: e.id, fid: e.dataset.fid || '', text: e.textContent, on: e.classList.contains('on') }))`);
// 一本的「⋯」→ 菜单里的某一项（folder 放进文件夹…、rename 改名…、delete 删除这本…）
async function menuOf(nb, act, wait = 500) {
  await tap(rowSel(nb) + ' .nb-more', 300);
  await tap(`#nbMenu [data-act=${act}]`, wait);
}
// 起名字的卡片：点名字那一格、全选删掉、打字、点「好」
async function typeName(name) {
  await T.waitFor(`!document.querySelector('#nameAsk').hidden`);
  await tap('#nameAskInput', 200);
  await js(`document.querySelector('#nameAskInput').select(); 1`);
  await T.cdp('Input.insertText', { text: name });
  await tap('#nameAskOk', 800);
}
const answer = (kind, val) => js(`window.__asked = []; window.${kind} = (m) => { window.__asked.push(m); return ${JSON.stringify(val)}; }; 1`);
// 页面上的列表和电脑上记的是不是同一回事：每个文件夹的名字、里面的本子（按列表的顺序）一样
async function sameAsFile() {
  const L = await list(), f = saved();
  const ui = [];
  let curF = null;
  for (const r of L) {
    if (r.f !== undefined) { curF = { name: r.f, items: [], n: r.n, open: r.open }; ui.push(curF); } else if (r.nested && curF) curF.items.push(r.nb);
  }
  const ids = new Set((await T.apiJson('/api/notebooks')).map((n) => n.id));
  const file = (f ? f.folders : []).map((x) => ({ name: x.name, items: x.items.filter((i) => ids.has(i)) }));
  const ok = ui.length === file.length && ui.every((u, k) => u.name === file[k].name && u.n === `${file[k].items.length} 本`
    && (!u.open || [...u.items].sort().join() === [...file[k].items].sort().join()));
  return { ok, ui, file };
}

// 1. 打开抽屉：草稿本在最上面（2026-11-18 起它也有「⋯」，里面只有「复制这本…」）；自己的本子、推送本子和书有，「⋯」菜单里第一项是「放进文件夹…」
await drawer(true);
let L = await list();
T.ok('还没有文件夹：草稿本在最上面，下面是自己的本子、推送本子（排在里面，不钉在上面）和书', JSON.stringify(short(L)) === JSON.stringify(['草稿本', '随笔', '想法', '读书笔记', PUSH, '例会_v47']), short(L));
T.ok('每一本都有「⋯」（草稿本、推送本子也有）', L.filter((r) => r.nb).every((r) => r.more) && L.some((r) => r.nb.startsWith('board:') && r.more), L);
await tap(rowSel(P1) + ' .nb-more', 300);
const menu1 = await js(`[...document.querySelectorAll('#nbMenu button')].map((b) => b.dataset.act + ':' + b.textContent)`);
T.ok('「⋯」点开的菜单：放进文件夹…、上移、下移（2026-11-18）、改名…、复制这本…（2026-11-18）、删除这本…',
  JSON.stringify(menu1) === JSON.stringify(['folder:放进文件夹…', 'up:上移', 'down:下移', 'rename:改名…', 'copy:复制这本…', 'delete:删除这本…']), menu1);
await tap(rowSel(P1) + ' .nb-more', 300); // 再点一下收起
T.ok('抽屉底部「＋ 新建本子…」旁边是「＋ 新建文件夹…」（文字按钮）', (await T.text('#actNewFolder')) === '＋ 新建文件夹…'
  && (await js(`document.querySelector('#actNewFolder').parentElement === document.querySelector('#actNewNb').parentElement`)));
// 电脑上本子的数据（除了 folders.json）的指纹：文件夹的操作前后一样，才算没动本子
const hashNb = () => execFileSync(PY, ['-c', `import pathlib,sys,hashlib
root=pathlib.Path(sys.argv[1])
print(hashlib.sha1(b"".join(str(p.relative_to(root)).encode() + p.read_bytes() for p in sorted((root/"notebooks").rglob("*")) if p.is_file() and p.name!="folders.json")).hexdigest())`, T.DATA]).toString().trim();
let before = hashNb();

// 2. 「＋ 新建文件夹…」：起名字的卡片（不是浏览器自带的输入框），建好的文件夹在列表里、是空的
await answer('prompt', null);
await tap('#actNewFolder');
T.ok('点「＋ 新建文件夹…」：弹出起名字的卡片，名字空着；没用浏览器自带的输入框', (await T.visible('#nameAsk')) && (await T.text('#nameAskTitle')) === '新建文件夹'
  && (await js(`document.querySelector('#nameAskInput').value`)) === '' && (await js(`window.__asked.length`)) === 0);
await typeName('课题');
const F1 = fidOf('课题');
L = await list();
T.ok('建好了：抽屉里多了「课题」文件夹（空的、开着），电脑上记下了', Boolean(F1) && JSON.stringify(short(L)) === JSON.stringify(['草稿本', '[课题 0 本 开]', '随笔', '想法', '读书笔记', PUSH, '例会_v47'])
  && (await T.visible('#drawer')), short(L));

// 3. 「随笔」的「⋯」→「放进文件夹…」：小列表里有「课题」、没有「移出文件夹」、有「新建文件夹…」；点「课题」放进去
await menuOf(P1, 'folder');
let pk = await pickItems();
const near = await js(`(() => { const p = document.querySelector('#folderPick').getBoundingClientRect(), b = document.querySelector(${JSON.stringify(rowSel(P1) + ' .nb-more')}).getBoundingClientRect();
  return { gap: Math.round(p.top - b.bottom), inScreen: p.left >= 0 && p.right <= innerWidth && p.bottom <= innerHeight, aboveDrawer: Number(getComputedStyle(document.querySelector('#folderPick')).zIndex) > Number(getComputedStyle(document.querySelector('#drawer')).zIndex) }; })()`);
T.ok('点「放进文件夹…」：紧挨着「⋯」弹出小列表——「课题」、分隔线、「新建文件夹…」（不在文件夹里，没有「移出文件夹」）；菜单收起', (await T.visible('#folderPick'))
  && !(await T.visible('#nbMenu')) && pk.map((r) => r.fid ? r.text : r.id || r.text).join('|') === `课题||fpNew` && !pk.some((r) => r.on), pk);
T.ok('小列表紧挨着「⋯」、整个在屏幕里、在抽屉上面', near.gap >= 0 && near.gap <= 8 && near.inScreen && near.aboveDrawer, near);
await tap('#folderPickList [data-fid]');
L = await list();
T.ok('放进去了：「随笔」缩进列在「课题」下面，「课题」写着 1 本；小列表收起，抽屉还开着', JSON.stringify(short(L)) === JSON.stringify(['草稿本', '[课题 1 本 开]', '· 随笔', '想法', '读书笔记', PUSH, '例会_v47'])
  && !(await T.visible('#folderPick')) && (await T.visible('#drawer')), short(L));
T.ok('电脑上记的：课题里是随笔', JSON.stringify(saved().folders.map((f) => [f.name, f.items])) === JSON.stringify([['课题', [P1]]]), saved());

// 4. 「想法」的「⋯」→「放进文件夹…」→「新建文件夹…」：起个名字，新建的文件夹里就是它
await menuOf(P2, 'folder');
await tap('#fpNew', 500);
await typeName('旧的');
const F2 = fidOf('旧的');
L = await list();
T.ok('从小列表里新建文件夹「旧的」，「想法」直接放进去', Boolean(F2) && JSON.stringify(short(L)) === JSON.stringify(['草稿本', '[课题 1 本 开]', '· 随笔', '[旧的 1 本 开]', '· 想法', '读书笔记', PUSH, '例会_v47']), short(L));

// 5. 在文件夹里的「随笔」：小列表里「课题」打 ✓，有「移出文件夹」；移出后回到外面
await menuOf(P1, 'folder');
pk = await pickItems();
T.ok('在文件夹里的本子：小列表里它在的「课题」打 ✓，多了「移出文件夹」', pk.find((r) => r.fid === F1).on && pk.find((r) => r.fid === F1).text.endsWith('✓')
  && !pk.find((r) => r.fid === F2).on && pk.some((r) => r.id === 'fpOut' && r.text === '移出文件夹'), pk);
await T.shot('3-folder-pick.png');
await tap('#fpOut');
L = await list();
T.ok('移出文件夹：「随笔」回到外面，「课题」变成 0 本', JSON.stringify(short(L)) === JSON.stringify(['草稿本', '[课题 0 本 开]', '[旧的 1 本 开]', '· 想法', '随笔', '读书笔记', PUSH, '例会_v47']), short(L));
// 再把「随笔」和书放进「课题」（书换过来的：从小列表里点）
for (const nb of [P1, BOOK]) {
  await menuOf(nb, 'folder');
  await tap(`#folderPickList [data-fid=${JSON.stringify(F1)}]`);
}
L = await list();
T.ok('「随笔」和导入的书放进「课题」', JSON.stringify(short(L)) === JSON.stringify(['草稿本', '[课题 2 本 开]', '· 随笔', '· 例会_v47', '[旧的 1 本 开]', '· 想法', '读书笔记', PUSH]), short(L));
let same = await sameAsFile();
T.ok('电脑上 folders.json 记的和抽屉里看到的一样', same.ok, same);
await T.shot('1-folders-open.png');

// 6. 点「课题」那一行：折叠，里面的本子不列出来、▸；再点展开；折叠状态刷新后还记得
await tap(folderSel(F1));
L = await list();
T.ok('点文件夹那一行：折叠，里面的本子不列出来，写着 2 本，▸', JSON.stringify(short(L)) === JSON.stringify(['草稿本', '[课题 2 本 折]', '[旧的 1 本 开]', '· 想法', '读书笔记', PUSH])
  && L.find((r) => r.f === '课题').mark.startsWith('▸'), short(L));
await tap(folderSel(F2));
T.ok('「旧的」也能折叠', JSON.stringify(short(await list())) === JSON.stringify(['草稿本', '[课题 2 本 折]', '[旧的 1 本 折]', '读书笔记', PUSH]), short(await list()));
await T.shot('1-folders-folded.png');
await tap(folderSel(F2));
T.ok('再点一下展开，▾', (await list()).find((r) => r.f === '旧的').open && (await list()).find((r) => r.f === '旧的').mark.startsWith('▾'), short(await list()));
await T.reload();
await drawer(true);
L = await list();
T.ok('刷新后还记得：「课题」折着、「旧的」开着（记在这台设备上）', JSON.stringify(short(L)) === JSON.stringify(['草稿本', '[课题 2 本 折]', '[旧的 1 本 开]', '· 想法', '读书笔记', PUSH]), short(L));
let afterHash = hashNb();
T.ok('新建、放进、移出、折叠：没改过别的文件（pads.json、各本子的文件夹一个字节没变）', before === afterHash, [before, afterHash]);

// 7. 当前打开的本子在折叠着的文件夹里：那个文件夹自动展开
await drawer(false);
await T.openNotebook(P1);
await drawer(true);
L = await list();
T.ok('打开折叠着的「课题」里的「随笔」：抽屉里「课题」自动展开，「随笔」是当前这本', L.find((r) => r.f === '课题').open && L.find((r) => r.nb === P1 && r.nested).cur, short(L));
await tap(folderSel(F1));
T.ok('展开以后照样能自己折起来', !(await list()).find((r) => r.f === '课题').open, short(await list()));
await tap(folderSel(F1));

// 8. 文件夹改名：「课题」那一行右边的铅笔
before = hashNb();
await tap(folderSel(F1) + ' [data-icon=edit]', 500);
T.ok('点文件夹的改名图标：起名字的卡片，默认填着现在的名字', (await T.visible('#nameAsk')) && (await T.text('#nameAskTitle')) === '文件夹改名'
  && (await js(`document.querySelector('#nameAskInput').value`)) === '课题');
await typeName('课题二');
T.ok('改名了：抽屉里和电脑上都是新名字，里面的本子不变', (await list()).some((r) => r.f === '课题二') && saved().folders.find((f) => f.id === F1).name === '课题二'
  && JSON.stringify(saved().folders.find((f) => f.id === F1).items) === JSON.stringify([P1, BOOK]), saved());

// 9. 删文件夹「旧的」：先问一句（点取消不删）；删了以后「想法」回到外面，本子本身还在
await answer('confirm', false);
await tap(folderSel(F2) + ' [data-icon=trash]', 500);
const asked9 = await js(`window.__asked`);
T.ok('删文件夹前问一句，说了里面的本子回到外面、本子本身不动；点取消不删', asked9.length === 1 && asked9[0] === '删除文件夹「旧的」？\n里面的 1 本回到外面，本子本身不动。'
  && Boolean(fidOf('旧的')), asked9);
await answer('confirm', true);
await tap(folderSel(F2) + ' [data-icon=trash]', 800);
L = await list();
T.ok('删了文件夹：「想法」回到外面，本子还在', !L.some((r) => r.f === '旧的') && L.some((r) => r.nb === P2 && !r.nested) && !fidOf('旧的')
  && (await T.apiJson('/api/notebooks')).some((n) => n.id === P2), short(L));
afterHash = hashNb();
T.ok('文件夹改名、删文件夹：没改过别的文件', before === afterHash, [before, afterHash]);

// 10. 新建的本子在文件夹外面；草稿本放不进文件夹（服务也拦）
await tap('#actNewNb');
await tap('#newNbTitle', 200);
await T.cdp('Input.insertText', { text: '新的一本' });
await tap('#newNbOk', 1500);
await drawer(true);
L = await list();
const fresh = L.find((r) => r.name === '新的一本');
T.ok('新建的本子在文件夹外面', Boolean(fresh) && !fresh.nested && !saved().folders.some((f) => f.items.includes(fresh.nb)), short(L));
const no = await T.api('/api/folders/move', { method: 'POST', body: JSON.stringify({ nb: 'scratch', folder: F1 }) });
T.ok('草稿本放不进文件夹（服务也拦）', no.status === 400, no.status);

// 11. 删掉文件夹里的一本：文件夹照常显示，少了它；文件里有已经不在的本子：照常显示、不报错
await answer('confirm', true);
await menuOf(BOOK, 'delete', 1500);
await drawer(true);
L = await list();
T.ok('删掉文件夹里的书：「课题二」照常显示，写着 1 本，里面只剩「随笔」', JSON.stringify(short(L).slice(0, 3)) === JSON.stringify(['草稿本', '[课题二 1 本 开]', '· 随笔']), short(L));
const raw = saved();
raw.folders[0].items.push('pad:ghost', 'book:不在了.pdf');
writeFileSync(FILE, JSON.stringify(raw), 'utf8');
await T.reload();
await drawer(true);
L = await list();
T.ok('文件里有已经不在的本子：照常显示，数目只算还在的', L.find((r) => r.f === '课题二').n === '1 本' && !L.some((r) => r.nb === 'pad:ghost'), short(L));
same = await sameAsFile();
T.ok('抽屉里看到的和电脑上记的（去掉不在的）还是一样', same.ok, same);

await T.finish();

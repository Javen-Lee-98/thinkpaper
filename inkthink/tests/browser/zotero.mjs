// 导入 Zotero 里的文献：导入面板的「Zotero」一栏，看最近添加和分类、搜标题、点一条导入成一本书；再点一次不多出一本；
// 点「AI」时告诉 Claude 这是哪篇文献。Zotero 用这里起的一个假的本机接口代替，不连真的 Zotero。
// boot 起的服务不带配置（Zotero 的地址只在启动时从配置里读，不配就是真 Zotero 的端口），所以这里另起一个带配置的服务，
// 页面只开在这个服务上；boot 的浏览器和小工具照用，boot 自己那个服务闲着不用。
// 跑法：node tests/browser/zotero.mjs [临时目录]；有一项不对退出码 1。
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, APP, PY, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'zotero', open: false });
const js = T.evalJS, Z = join(T.ROOT, 'z'), DATA = join(Z, 'data'), BOOKS = join(Z, 'books'), LIB = join(Z, 'lib');
for (const d of [DATA, BOOKS, LIB]) mkdirSync(d, { recursive: true });
// 文献的 PDF（两页 A4），放在「Zotero 的文件夹」里
const PDF = join(LIB, 'Li 等 - 2022 - Pythagorean theorem.pdf'), TITLE = 'A short proof of the Pythagorean theorem', BOOK = `Li 等 - 2022 - ${TITLE}`;
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
doc=fitz.open()
for t in ("A short proof of the Pythagorean theorem", "Page two"):
    p=doc.new_page(width=595,height=842); p.insert_text((72,100),t,fontsize=20)
doc.save(sys.argv[1])`, PDF]);

// ---- 假的 Zotero 本机接口：两篇文献（一篇有 PDF，一篇没有）、一个分类；记下服务来问过什么
const att = (k, t) => ({ href: `http://localhost:23119/api/users/1/items/${k}`, type: 'application/json', attachmentType: t });
const ITEMS = {
  K1: { key: 'K1', data: { itemType: 'journalArticle', title: TITLE, collections: ['C1'] }, meta: { creatorSummary: 'Li 等', parsedDate: '2022-03-01' }, links: { attachment: att('A1', 'application/pdf') } },
  K2: { key: 'K2', data: { itemType: 'patent', title: '无 PDF 的专利', collections: [] }, meta: { creatorSummary: '王', parsedDate: '2020' }, links: { attachment: att('A2', 'text/html') } },
};
const C1 = { key: 'C1', data: { name: '数学', parentCollection: false } }, zseen = [];
let zClosed = false; // true 时像 Zotero 没勾「允许其他应用程序通信」：一律 403
const zsrv = createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname.replace('/api/users/0', ''), q = (u.searchParams.get('q') || '').toLowerCase(), top = Object.values(ITEMS);
  zseen.push([p, Object.fromEntries(u.searchParams)]);
  if (zClosed) { res.writeHead(403); res.end('Local API is not enabled'); return; }
  let body = null;
  if (p === '/items/top') body = top.filter((it) => it.data.title.toLowerCase().includes(q));
  else if (p === '/collections/top') body = [C1];
  else if (p === '/collections/C1/collections') body = [];
  else if (p === '/collections/C1/items/top') body = top.filter((it) => it.data.collections.includes('C1'));
  else if (p === '/collections/C1') body = C1;
  else if (/^\/items\/K\d$/.test(p)) body = ITEMS[p.slice(7)];
  else if (/^\/items\/K\d\/children$/.test(p)) body = [];
  else if (p === '/items/A1/file/view/url') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(pathToFileURL(PDF).href); return; }
  if (body === null) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Total-Results': String(Array.isArray(body) ? body.length : 1) });
  res.end(JSON.stringify(body));
});
await new Promise((r) => zsrv.listen(0, '127.0.0.1', r));
const asked = (path) => zseen.filter((x) => x[0] === path).map((x) => x[1]);

// ---- 带配置的测试服务：配置里的 zotero 指向上面的假接口
const PORT = await new Promise((res) => { const s = tcpServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const B = `http://127.0.0.1:${PORT}`;
writeFileSync(join(Z, 'config.json'), JSON.stringify({ zotero: `http://127.0.0.1:${zsrv.address().port}` }), 'utf8');
const srv = spawn(PY, ['server.py', '--host', '127.0.0.1', '--port', String(PORT), '--data', DATA, '--books', BOOKS, '--config', join(Z, 'config.json')], { cwd: APP, stdio: 'ignore' });
process.on('exit', () => { try { execFileSync('taskkill', ['/PID', String(srv.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* 已经没了 */ } try { srv.kill(); } catch (e) { /* */ } });
for (let k = 0; ; k++) {
  try { if ((await fetch(`${B}/bridge/ping`)).status < 500) break; } catch (e) { /* 还没起来 */ }
  if (k > 100) throw new Error('带 Zotero 配置的测试服务没起来');
  await sleep(200);
}
const code = readFileSync(join(DATA, 'access_code.txt'), 'utf8').trim();
const api = async (path) => (await fetch(B + path, { headers: { 'X-Access': code } })).json();
const hello = () => fetch(`${B}/bridge/hello`, { method: 'POST', body: JSON.stringify({ sid: 'Z1', label: 'idea', cwd: LIB }) }).catch(() => {});
await hello();
const keep = setInterval(hello, 5000);
await T.cdp('Page.navigate', { url: `${B}/?k=${code}&lang=zh` });
await T.ready();
await T.cdp('Page.bringToFront');

// ---- 小工具
// 真的点一下：先滚到看得见，确认这个位置点得到它（没藏着、没被盖住）再点
async function tap(sel, wait = 600) {
  const hit = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return '页面上没有'; e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t && (t === e || e.contains(t)) ? '' : '藏着或被盖住了'; })()`);
  if (hit) throw new Error(`点不到 ${sel}：${hit}`);
  await T.tap(sel, wait);
}
// Zotero 一栏里列着什么：小标题前面加「— 」，没有 PDF 的标 [灰]，导入过的带上标记
const rows = () => js(`[...document.querySelectorAll('#zList .is-item, #zList .is-head')].map((r) => (r.classList.contains('is-head') ? '— ' + r.textContent
  : r.querySelector('.is-name').firstChild.textContent + (r.classList.contains('off') ? ' [灰]' : '') + (r.querySelector('.is-badge') ? ' [' + r.querySelector('.is-badge').textContent + ']' : '')))`);
const crumbs = () => T.text('#zCrumbs');
const crumbsAre = (text) => T.waitFor(`document.querySelector('#zCrumbs').textContent === ${JSON.stringify(text)} && document.querySelector('#zList .is-head, #zList .is-item')`);
// 按名字找一行，真的点一下
async function tapRow(name, wait = 300) {
  const c = await js(`(() => { const r = [...document.querySelectorAll('#zList .is-item')].find((x) => x.querySelector('.is-name').firstChild.textContent === ${JSON.stringify(name)});
    if (!r) return null; r.scrollIntoView({ block: 'nearest' }); const b = r.querySelector('.is-name').getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, t = document.elementFromPoint(x, y);
    return t && r.contains(t) ? [x, y] : null; })()`);
  if (!c) throw new Error('Zotero 一栏里点不到这一行：' + name);
  await T.tapAt(c[0], c[1], wait);
}
// 点一下搜索框，把里面的字换成 text（像键盘打字，会触发页面的输入事件）
const search = async (text) => { await tap('#zq', 200); await js(`document.querySelector('#zq').select(); 1`); await T.cdp('Input.insertText', { text }); };
const openPanel = async () => { if (!(await T.visible('#drawer'))) await tap('#nbChip', 500); await tap('#actUpload', 500); };
const st = () => js(`(() => { const S = window.__ink.S; return { id: S.nb.id, pages: S.nb.pages, bg: S.bgImg ? S.bgImg.naturalWidth : 0, chip: document.querySelector('#chipName').textContent + ' ' + document.querySelector('#chipPage').textContent,
  sheet: !document.querySelector('#importSheet').hidden }; })()`);
// 记下纸上出过的每一句提示，以及那时导入面板关了没有；取走后清空
await js(`(() => { window.__toasts = []; const t = document.querySelector('#toast');
  new MutationObserver(() => { if (!t.hidden && t.textContent) window.__toasts.push([t.textContent, document.querySelector('#importSheet').hidden]); }).observe(t, { childList: true, attributes: true, characterData: true, subtree: true }); return 1; })()`);
const toasts = () => js(`window.__toasts.splice(0)`);
const imported = () => T.waitFor(`window.__ink.S.nb.id === ${JSON.stringify(`book:${BOOK}.pdf`)} && window.__ink.S.page && !/^正在/.test(document.querySelector('#toast').textContent)`, 20000);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const books = () => readdirSync(BOOKS).filter((f) => f.endsWith('.pdf'));

// 1. 导入面板点「Zotero」一栏：最近添加两篇（没有 PDF 的灰掉）、下面是分类
await openPanel();
T.ok('导入面板先停在「电脑文件夹」，这时还没去问 Zotero', (await T.visible('#isFolder')) && !(await T.visible('#isZotero')) && zseen.length === 0, zseen);
await tap('#importSheet .is-tabs [data-tab=zotero]', 300);
await crumbsAre('Zotero');
const r1 = await rows();
T.ok('点「Zotero」：列出最近添加的两篇和分类，没有 PDF 的那篇是灰的', (await T.visible('#isZotero')) && !(await T.visible('#isFolder')) && (await T.visible('#zq'))
  && same(r1, ['— 最近添加', TITLE, '无 PDF 的专利 [灰]', '— 分类', '数学']), r1);
const small = await js(`[...document.querySelectorAll('#zList .is-item small')].map((x) => x.textContent)`);
T.ok('每篇下面写着作者、年份、类型', same(small, ['Li 等 · 2022 · 期刊文章', '王 · 2020 · 专利 · 没有 PDF']), small);
T.ok('服务问的是假接口：按添加时间取最近的、取顶层分类', asked('/items/top').length === 1 && asked('/items/top')[0].sort === 'dateAdded' && !asked('/items/top')[0].q && asked('/collections/top').length === 1, zseen);
await toasts();
await tapRow('无 PDF 的专利');
const t1 = await toasts();
T.ok('点没有 PDF 的那篇：只提示一句，不导入', t1.length === 1 && t1[0][0] === '这篇在 Zotero 里没有 PDF' && (await st()).id === 'scratch' && (await st()).sheet && books().length === 0, [t1, await st()]);

// 2. 搜标题：停手一会儿自己搜；搜不到的写「没有找到」
await search('zzz');
await crumbsAre('Zotero › 搜索“zzz”');
T.ok('搜一个没有的词：写「没有找到」', same(await rows(), ['— 没有找到']), await rows());
await search('Pythagorean');
await crumbsAre('Zotero › 搜索“Pythagorean”');
T.ok('搜标题里的词「Pythagorean」：找到那一篇', same(await rows(), ['— 找到 1 篇', TITLE]) && (await crumbs()) === 'Zotero › 搜索“Pythagorean”', [await rows(), await crumbs()]);
const q2 = asked('/items/top').filter((x) => x.q);
T.ok('搜的词交给了 Zotero（按标题、作者、年份搜）', same(q2.map((x) => [x.q, x.qmode]), [['zzz', 'titleCreatorYear'], ['Pythagorean', 'titleCreatorYear']]), q2);

// 3. 点路径最前面的「Zotero」回首页；进分类
await tap('#zCrumbs a:first-child', 300);
await crumbsAre('Zotero');
T.ok('点路径上的「Zotero」：回到首页，搜索框清空', same(await rows(), r1) && (await js(`document.querySelector('#zq').value`)) === '', await rows());
await tapRow('数学');
await crumbsAre('Zotero › 数学');
T.ok('点分类「数学」：只列这个分类里的那一篇', same(await rows(), [TITLE]) && asked('/collections/C1/items/top').length === 1, await rows());

// 4. 点那一篇：导入成一本书，名字是「第一作者 等 - 年份 - 标题」
await toasts();
await tapRow(TITLE);
await imported();
await T.sleep(500);
const t4 = await toasts(), s4 = await st();
T.ok('点了就关面板，纸上先写「正在导入《…》」，好了写「已导入」', t4.length >= 2 && t4[0][0] === `正在导入《${TITLE}》…` && t4[0][1] === true && t4[t4.length - 1][0] === `已导入《${BOOK}》`, t4);
T.ok('导入成一本两页的书并打开：名字是「作者 - 年份 - 标题」，有底图', s4.id === `book:${BOOK}.pdf` && s4.pages === 2 && s4.bg > 0 && s4.chip === `${BOOK} 1/2` && !s4.sheet, s4);
T.ok('电脑上 books 里是这篇的 PDF，内容和 Zotero 里那份一样（文件是向 Zotero 问来的）', same(books(), [`${BOOK}.pdf`]) && readFileSync(join(BOOKS, `${BOOK}.pdf`)).equals(readFileSync(PDF))
  && asked('/items/K1').length === 1 && asked('/items/A1/file/view/url').length === 1, [books(), zseen.slice(-3)]);
const src4 = JSON.parse(readFileSync(join(BOOKS, '_sources.json'), 'utf8'))[`${BOOK}.pdf`] || {};
T.ok('电脑上记着这是 Zotero 的哪一篇、原文件在哪', Boolean(src4.zotero) && same([src4.zotero.item, src4.zotero.att, src4.zotero.title, src4.zotero.creators, src4.zotero.year, src4.zotero.type], ['K1', 'A1', TITLE, 'Li 等', '2022', '期刊文章'])
  && src4.src.toLowerCase() === realpathSync.native(PDF).toLowerCase(), src4); // 临时目录可能是 ABCDEF~1 这样的 8.3 短路径：展开了再比

// 5. 在上面写一笔点「AI」：交上去的消息里说了是哪篇文献
await T.pen(T.line(120, 300, 300));
await tap('#check');
let sub = null;
for (let k = 0; k < 40 && !sub; k++) { sub = (await (await fetch(`${B}/bridge/poll?sid=Z1`)).json()).submission; if (!sub) await sleep(250); }
T.ok('点「AI」交上去的消息里写着 Zotero 文献和条目号', Boolean(sub) && sub.text.startsWith('【草稿纸】') && sub.text.includes(`Zotero 文献：Li 等 · 2022 · 期刊文章《${TITLE}》，条目 K1`), sub && sub.text.slice(0, 300));

// 6. 再打开导入面板：记住了 Zotero 一栏，那篇标着「已导入」；再点一次不多出一本
await openPanel();
await crumbsAre('Zotero');
const r6 = await rows();
T.ok('再打开导入面板：直接是 Zotero 一栏，那篇标着「已导入」', (await T.visible('#isZotero')) && !(await T.visible('#isFolder')) && r6[1] === `${TITLE} [已导入 ›]`, r6);
await toasts();
await tapRow(TITLE);
await imported();
const t6 = await toasts();
T.ok('再点一次：打开原来那本，不多出一本', t6[0][0] === `正在打开《${TITLE}》…` && t6[t6.length - 1][0] === `已打开《${BOOK}》` && same(books(), [`${BOOK}.pdf`])
  && (await api('/api/notebooks')).filter((n) => n.id.startsWith('book:')).length === 1 && (await T.strokes()) === 1, [t6, books()]);

// 7. Zotero 没开本机接口：面板里写出该怎么办
zClosed = true;
await openPanel();
await T.waitFor(`/Zotero 没开本机接口/.test(document.querySelector('#zList').textContent)`);
T.ok('Zotero 没开本机接口时：列表里写着去哪里勾选', /^Zotero 没开本机接口：设置 → 高级 → 勾选/.test(await T.text('#zList')) && (await T.count('#zList .is-item')) === 0, await T.text('#zList'));

clearInterval(keep);
zsrv.close();
await T.finish();

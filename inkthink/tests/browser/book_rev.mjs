// 书原地更新时页的键重新编号（2026-11-17 用户定）：书一更新，原文件那些页的键按新页码重排（新版在最前面加了一页：p0001 → p0002）。
// 平板在更新那一刻还有没存上的字（这里用拦请求让存页失败来造出来），这些字是按旧键排队的；现在平板记着每一页是这本第几次更新以后取的（gen），
// 存页时带上，服务按新旧页对照换成新版里的键再存——存到原来那一页上，不盖掉别的页（别的页上一次也是这台存的，以前直接就盖掉了）。
//   1. 收到「已更新」时存页还没存上：之后补存，存到那一页的新键上；排着队的那份不当成新版同一个键的那一页显示出来
//   2. 「已更新」的通知没收到（拦着）：存页的回话里知道了，整本重新打开，眼前还是那一页；这台存过以后手上那一页记着新键（取回答也按新键）
//   3. 「已更新」的通知没收到、也没有要存的：翻页取来的页是新版的，就知道了，整本重新打开
//   4. 写着的那一页在新版里没了：字不写进本子（不盖掉现在占着那个键的别的页），另存在电脑上，平板说一句看得懂的话，不卡在「正在重试」
//   5. 英文界面：新加的几句都有英文
// 只在无头 Edge 和合成输入上验过，没在 iPad 上试过。
// 跑法：node tests/browser/book_rev.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'book-rev', open: false });
const js = T.evalJS;
const SRC = join(T.ROOT, 'src'), PDF = join(SRC, '例会.pdf');
mkdirSync(SRC, { recursive: true });
const TITLE = { A: 'Intro: weekend trip planner', B: 'Method: simple travel budget', C: 'Result: total cost 300 yuan',
  X: 'Agenda for today and tomorrow', Y: 'Questions from the last meeting', Z: 'Appendix with the extra tables' };
const makePdf = (letters) => execFileSync(PY, ['-c', `import pymupdf as fitz,sys,json
doc=fitz.open()
for t in json.loads(sys.argv[2]):
    p=doc.new_page(width=1000,height=562.5); p.insert_text((60,120),t,fontsize=40)
doc.save(sys.argv[1])`, PDF, JSON.stringify(letters.split('').map((k) => TITLE[k]))]);
const DIR = join(T.DATA, 'notebooks', 'book-' + createHash('sha1').update('例会.pdf').digest('hex').slice(0, 12));
const NB = 'book:例会.pdf';

// ---- 小工具
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fileOf = (key) => join(DIR, 'page-' + key.slice(1) + '.json');
const inkOf = (key) => (existsSync(fileOf(key)) ? JSON.parse(readFileSync(fileOf(key), 'utf8')).strokes.filter((s) => !s.erasedAt).map((s) => s.id) : []);
const cdir = join(T.DATA, 'conflicts');
const kept = () => (existsSync(cdir) ? readdirSync(cdir) : []);
const state = async () => { await T.waitFor(`window.__ink.S.page`); return js(`(() => { const S = window.__ink.S;
  return { idx: S.idx, pages: S.nb.pages, gen: S.nb.gen, ink: S.page ? S.page.strokes.filter((s) => !s.erasedAt).map((s) => s.id) : [],
    trouble: !document.querySelector('#trouble').hidden }; })()`); };
const toastNow = () => js(`(() => { const t = document.querySelector('#toast'); return t.hidden || !t.firstChild ? '' : t.firstChild.textContent; })()`);
const lastId = () => js(`window.__ink.S.page.strokes.at(-1).id`);
const flowIds = () => js(`window.__ink.flowStrip().map((n) => [n.i, (n.ent.page.strokes[0] || {}).id || null]).sort((a, b) => a[0] - b[0])`);
const write = async (y) => { await T.pen(T.line(200, y, 260)); return lastId(); };
const importPdf = async (letters) => { makePdf(letters); return T.post('/bridge/import', { sid: 'S1', path: PDF }); };
const until = async (cond, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await T.sleep(100); } return false; };

// 拦这一页发出的请求：failPut 时存页一律失败（像网断了）；holdEvents 时取通知的请求扣住不放（这台收不到「已更新」）；
// holdNb 时取本子信息的请求扣住。存页、取回答的地址记下来
let failPut = false, holdEvents = false, holdNb = false;
const heldEv = [], heldNb = [], putUrls = [], pendingUrls = [];
T.onCdp('Fetch.requestPaused', (p) => {
  const u = p.request.url, id = p.requestId;
  if (/\/api\/page\?/.test(u) && p.request.method === 'PUT') {
    putUrls.push(u);
    if (failPut) { T.cdp('Fetch.failRequest', { requestId: id, errorReason: 'ConnectionRefused' }).catch(() => {}); return; }
  }
  if (holdEvents && /\/api\/events\?/.test(u)) { heldEv.push(id); return; }
  if (holdNb && /\/api\/notebook\?/.test(u)) { heldNb.push(id); return; }
  if (/\/api\/pending\?/.test(u)) pendingUrls.push(u);
  T.cdp('Fetch.continueRequest', { requestId: id }).catch(() => {});
});
const release = async (list) => { for (const id of list.splice(0)) await T.cdp('Fetch.continueRequest', { requestId: id }).catch(() => {}); };

// 准备：导入 A B C，各页写一笔、存好（各页上一次都是这台存的）
const imp = await importPdf('ABC');
T.ok('准备：导入成一本 3 页的书', imp.ok && imp.id === NB && imp.pages === 3, imp);
await T.go();
await T.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
await T.openNotebook(NB, 0);
const a1 = await write(400);
await T.openPage(1);
const b1 = await write(400);
await T.openPage(2);
const c1 = await write(400);
await T.openPage(1);
let ok = await T.saved();
T.ok('准备：三页各写了一笔，都存好了', ok && same(inkOf('p0000'), [a1]) && same(inkOf('p0001'), [b1]) && same(inkOf('p0002'), [c1]), [inkOf('p0000'), inkOf('p0001'), inkOf('p0002')]);
T.ok('存页时带着这一页的键和 gen（这本还没更新过：0）', putUrls.some((u) => /&key=p0001&gen=0$/.test(u)), putUrls.slice(-3));

// 1. 在 B 上写一笔，存不上；这时原文件在最前面加了一页 X、再导入（原地更新），这台收到「已更新」，整本重新打开
failPut = true;
const b2 = await write(470);
await T.sleep(1600);
const up1 = await importPdf('XABC');
T.ok('原地更新成 X A B C', up1.ok && up1.id === NB && up1.pages === 4, up1);
ok = await T.waitFor(`window.__ink.S.nb.pages === 4 && window.__ink.S.nb.gen === 1 && window.__ink.S.page`, 15000);
T.ok('这台收到「已更新」，换成了新版（4 页）；B 上那一笔还没存上', ok && same(inkOf('p0002'), [b1]) && (await js(`Boolean(window.__ink.S.saveTryAt)`)), [await state(), inkOf('p0002')]);
// 还没存上的时候直接打开第 3 页（B 现在在这里）：上面相邻的第 2 页（A，键 p0001）要从电脑上取，不能拿排着队的那份（B 的旧键也是 p0001）
await T.openNotebook(NB, 2);
ok = await T.waitFor(`window.__ink.flowStrip().some((n) => n.i === 1)`);
const strip1 = await flowIds();
T.ok('排着队的那份（B，旧键 p0001）没被当成新版的第 2 页（A，新键 p0001）显示出来', ok && strip1.some(([i, id]) => i === 1 && id === a1), strip1);
const mark1 = putUrls.length;
failPut = false;
ok = await T.saved(15000);
T.ok('能存了：B 上那一笔补存到 B 的新键（p0002）上', ok && same(inkOf('p0002'), [b1, b2]), inkOf('p0002'));
T.ok('A（现在的键是 p0001，上一次也是这台存的）一个字没动；没有另存的冲突', same(inkOf('p0001'), [a1]) && kept().length === 0, [inkOf('p0001'), kept()]);
T.ok('补存时带的是旧键和旧 gen（服务换的键）', putUrls.slice(mark1).some((u) => /&key=p0001&gen=0$/.test(u)), putUrls.slice(mark1));
await T.openNotebook(NB, 2);
let s = await state();
T.ok('平板上 B（第 3 页）两笔都在', same(s.ink, [b1, b2]) && s.idx === 2, s);
await T.shot('1-late-save.png');

// 2. 「已更新」的通知这台收不到：在 B 上写一笔，存不上；这时原文件又在最前面加了一页 Y、再导入
holdEvents = true;
await T.hello(); // 让正挂着的那次取通知先回来，下一次就扣住了
ok = await until(() => heldEv.length > 0);
T.ok('准备：取通知的请求扣住了', ok, heldEv.length);
failPut = true;
const b3 = await write(540);
await T.sleep(1600);
const up2 = await importPdf('YXABC');
T.ok('原地更新成 Y X A B C', up2.ok && up2.pages === 5, up2);
await T.sleep(800);
s = await state();
T.ok('这台不知道（还是 4 页、gen 1）', s.pages === 4 && s.gen === 1, s);
holdNb = true; // 存上以后这台会去取本子信息、整本重新打开：先扣住，看存完那一刻手上这一页记着的键
failPut = false;
ok = await T.saved(15000);
T.ok('能存了：B 上那一笔存到 B 的新键（p0003）上，A（现在 p0002）没动', ok && same(inkOf('p0003'), [b1, b2, b3]) && same(inkOf('p0002'), [a1]) && kept().length === 0, [inkOf('p0003'), inkOf('p0002'), kept()]);
ok = await until(() => heldNb.length > 0);
T.ok('存页的回话里知道了这本更新过，去取本子信息', ok, heldNb.length);
const before2 = pendingUrls.length;
await js(`window.__ink.processPending()`);
await T.sleep(500);
const pu = pendingUrls.slice(before2);
T.ok('存过以后手上这一页记着新键：取回答也按新键（p0003、gen 2）', pu.some((u) => /&key=p0003&gen=2$/.test(u)), pu);
holdNb = false;
await release(heldNb);
ok = await T.waitFor(`window.__ink.S.nb.gen === 2 && window.__ink.S.nb.pages === 5 && window.__ink.S.page`, 15000);
await T.sleep(400);
s = await state();
const t2 = await toastNow();
T.ok('整本重新打开成新版，眼前还是 B（现在第 4 页），三笔都在', ok && s.idx === 3 && same(s.ink, [b1, b2, b3]), s);
T.ok('平板上说了一句', t2 === '这本在别处更新成了新版：已重新打开', t2);

// 3. 通知还是收不到、这回也没有要存的：单页翻页，取来的页是新版的，就知道了
await js(`window.__ink.toggleFlow()`); // 单页：翻到哪一页都从电脑上取
await T.sleep(800);
const up3 = await importPdf('ZYXABC');
T.ok('原地更新成 Z Y X A B C', up3.ok && up3.pages === 6, up3);
await T.sleep(800);
T.ok('这台还不知道（gen 2）', (await state()).gen === 2, await state());
await T.openPage(0);
ok = await T.waitFor(`window.__ink.S.nb.gen === 3 && window.__ink.S.nb.pages === 6 && window.__ink.S.page`, 15000);
T.ok('翻页取来的是新版的页：这台就知道了，整本重新打开成新版', ok, await state());
holdEvents = false;
await release(heldEv);
await T.sleep(2500); // 扣着的通知（「已更新」三次）放出去，这台按通知再重新打开几次

// 4. 写着的那一页（B）在新版里没了：字不写进本子，不盖掉现在占着那个键的 C，另存在电脑上，平板说一句
await T.openPage(5);
const c2 = await write(470); // C 上也写一笔：C 上一次也是这台存的
await T.openPage(4);
ok = await T.saved();
T.ok('准备：在 C 上又写了一笔，眼前是 B（第 5 页，键 p0004）', ok && same(inkOf('p0005'), [c1, c2]) && same((await state()).ink, [b1, b2, b3]), [inkOf('p0005'), await state()]);
failPut = true;
const b4 = await write(610);
await T.sleep(1600);
const up4 = await importPdf('ZYXAC');
T.ok('原地更新成 Z Y X A C（B 没了）', up4.ok && up4.pages === 5, up4);
ok = await T.waitFor(`window.__ink.S.nb.gen === 4 && window.__ink.S.nb.pages === 5 && window.__ink.S.page`, 15000);
await js(`window.__toasts = []; new MutationObserver(() => window.__toasts.push(document.querySelector('#toast').textContent))
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true }); 1`);
failPut = false;
ok = ok && (await T.waitFor(`window.__toasts.some((x) => x.startsWith('这本在你写的时候更新成了新版'))`, 15000));
const toasts4 = await js(`window.__toasts`);
const k4 = kept();
const keptIds = k4.length === 1 ? JSON.parse(readFileSync(join(cdir, k4[0]), 'utf8')).strokes.map((x) => x.id) : [];
T.ok('C（现在键 p0004）一个字没动：B 的字没盖上去', same(inkOf('p0004'), [c1, c2]), inkOf('p0004'));
T.ok('B 上没存上的那份另存在电脑上（里面有刚写的那一笔）', k4.length === 1 && keptIds.includes(b4), [k4, keptIds]);
const want4 = `这本在你写的时候更新成了新版，这一页在新版里没有了，刚写的没存进本子。你这边没存上的字另存在电脑上：data/conflicts/${k4[0]}`;
T.ok('平板上说了一句看得懂的话（书更新了、这一页在新版里没了、另存在哪）', ok && toasts4.includes(want4), toasts4);
const removed = readdirSync(DIR).filter((f) => /^removed-.*-page-0004\.json$/.test(f));
T.ok('B 以前存好的字照旧在更新时另存了（removed-…）', removed.length === 1 && same(JSON.parse(readFileSync(join(DIR, removed[0]), 'utf8')).strokes.map((x) => x.id), [b1, b2, b3]), removed);
await T.sleep(9000); // 存不上时 5 秒后重试；8 秒还没存上顶上会出「正在重试」
s = await state();
T.ok('不重试、顶上不出「正在重试」', !s.trouble && (await T.saved(100)), s);
await T.shot('4-page-gone.png');

T.ok('页面没有报错', !T.errors.length, T.errors);

// 5. 英文界面：新加的几句都有英文
await T.cdp('Fetch.disable');
await T.go('&lang=en');
const zh = ['这本在别处更新成了新版：已重新打开', want4, 'gen 不对'];
const en = await js(`${JSON.stringify(zh)}.map((s) => window.InkLang.t(s))`);
T.ok('英文界面里这几句都换成了英文', en.every((x) => !/[㐀-鿿]/.test(x)), en);
T.ok('页面没有报错（英文界面）', !T.errors.length, T.errors);
await T.finish();

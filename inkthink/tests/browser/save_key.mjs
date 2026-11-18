// 存页按页的键，不按页码（2026-11-17 用户定，《产品定义》第 2 节「做了但还留着毛病的」第一样）：两台设备同时开着同一本，
// （2026-11-17 起空白本子里不太长、旁边有空的长回答会摊在纸上：这里的长回答都带 fold: true，查的是收着（圈号）的样子；摊开的见 open_answer.mjs）
// 另一台插了页、挪了页、删了页，这台还没刷新就接着写——字照样存到它原来那一页上，绝不存到别的页上。
// 这台存页时（或取一页时）才知道页序变了：换成新的页序，人留在同一页（页码跟着变），连续阅读时相邻的页按新的先后重取；
// 眼前这一页在别处删掉了：刚写的字存进删掉的那一页，说一句看得懂的话，翻到原来位置上的那一页，在「显示已删的页」里还原后字都在。
// 服务说那一页哪里都没有了（410）：说服务那句话，不卡在「正在重试」。同一批：点「AI」只交这一页时按键交对那一页；
// 几页一起交后的记账事件不记到别的页上；Claude 不指定投递写回时写在、落在眼前那一页上；加页加在眼前这一页后面、删页删的是眼前这一页；
// 自己删页的那一会儿又写的一笔存进删掉的那一页（以前会存到后面接上来的那一页上）。另一台设备用测试脚本直接调接口模拟（带另一个 X-Client）。
// 只在无头 Edge 和合成输入上验过，没在 iPad 上试过；两台设备是同一台电脑上的一个页面加脚本请求，不是两台真的平板。
// 跑法：node tests/browser/save_key.mjs [临时目录]；有一项不对退出码 1。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from '../browser_lib.mjs';

const N = 4;
const T = await boot({ name: 'save-key', open: false, pages: N });
const js = T.evalJS, DIR = join(T.DATA, 'notebooks', 'scratch');
// 每页一笔，id 是 s0、s1……（看得出哪一页是哪一页）
for (let k = 0; k < N; k++) {
  const pts = Array.from({ length: 8 }, (_, j) => [120 + 40 * j, 260 + 60 * k, 0.5, 30 * j]);
  await T.api(`/api/page?nb=scratch&i=${k}`, { method: 'PUT', body: JSON.stringify({ v: 1, strokes: [{ id: 's' + k, t0: 1700000000000 + k, w: 3, pts }], ai: [], reads: [] }) });
}
const keysNow = async () => (await T.apiJson('/api/notebook?nb=scratch')).pageInfo.map((p) => p.key);
const K = await keysNow(); // K[j] 这一页上写着 s{j}
await T.go();

// ---- 小工具
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// 另一台设备（另一个 X-Client）调接口
const other = async (path, body, method = 'POST') => (await T.api(path, { method, body: JSON.stringify(body), headers: { 'X-Client': 'other-ipad' } })).json();
const fileOf = (key) => join(DIR, (key[0] === 'p' ? 'page-' : 'blank-') + key.slice(1) + '.json');
const inkOf = (key) => (existsSync(fileOf(key)) ? JSON.parse(readFileSync(fileOf(key), 'utf8')).strokes.filter((s) => !s.erasedAt).map((s) => s.id) : []);
const inkFiles = () => Object.fromEntries(readdirSync(DIR).filter((f) => /^(page|blank)-[^.]+\.json$/.test(f)).map((f) => [f, readFileSync(join(DIR, f), 'utf8')]));
const changedFiles = (a, b) => Object.keys(b).filter((f) => a[f] !== b[f]).sort();
const layoutOf = () => JSON.parse(readFileSync(join(DIR, 'layout.json'), 'utf8'));
// 这台的样子（这一页还在载入时先等它载入好）
const state = async () => { await T.waitFor(`window.__ink.S.page`); return js(`(() => { const S = window.__ink.S;
  return { idx: S.idx, pages: S.nb.pages, chip: document.querySelector('#chipPage').textContent, keys: S.nb.pageInfo.map((p) => p.key),
    ink: S.page ? S.page.strokes.filter((s) => !s.erasedAt).map((s) => s.id) : [], undo: S.undo.length, lastSent: S.page ? S.page.lastSent : null,
    trouble: !document.querySelector('#trouble').hidden }; })()`); };
const toastNow = () => js(`(() => { const t = document.querySelector('#toast'); return t.hidden || !t.firstChild ? '' : t.firstChild.textContent; })()`);
const lastId = () => js(`window.__ink.S.page.strokes.at(-1).id`);
const flowIds = () => js(`window.__ink.flowStrip().map((n) => [n.i, (n.ent.page.strokes[0] || {}).id || null]).sort((a, b) => a[0] - b[0])`);
const fileName = (key) => fileOf(key).split(/[\\/]/).pop();

// 准备：翻到第 2 页（s1），写一笔，存好
await T.openPage(1);
await T.pen(T.line(150, 1200, 200));
const a1 = await lastId();
T.ok('准备：在第 2 页（s1）写了一笔，存好了', (await T.saved()) && same(inkOf(K[1]), ['s1', a1]), inkOf(K[1]));

// 1. 另一台在最前面插了一页；这台还以为自己在第 2 页（共 4 页），接着写一笔
let files0 = inkFiles();
await other('/api/page/insert', { nb: 'scratch', after: -1 });
let s = await state();
T.ok('另一台插了页，这台还不知道（还是 2/4）', s.idx === 1 && s.pages === 4 && s.chip === '2/4', s);
await T.pen(T.line(150, 1300, 200));
const a2 = await lastId();
let ok = (await T.saved()) && (await T.waitFor(`window.__ink.S.idx === 2 && window.__ink.S.nb.pages === 5`));
s = await state();
let t = await toastNow();
T.ok('字存到了原来那一页（s1 那一页），没存到现在的第 2 页（s0）上', same(inkOf(K[1]), ['s1', a1, a2]) && same(inkOf(K[0]), ['s0']), [inkOf(K[1]), inkOf(K[0])]);
T.ok('电脑上只改了那一页的笔迹文件', same(changedFiles(files0, inkFiles()), [fileName(K[1])]), changedFiles(files0, inkFiles()));
T.ok('这台换成了新的页序，人还在这一页：页码 3/5，字和撤销记录都在', ok && s.idx === 2 && s.chip === '3/5' && same(s.ink, ['s1', a1, a2]) && s.undo === 2 && same(s.keys, await keysNow()), s);
T.ok('屏幕上方说一句页序变了', t === '这本的页在别的设备上加过、删过或挪过：已换成新的页序，眼前还是这一页', t);
ok = await T.waitFor(`window.__ink.flowStrip().some((n) => n.i === 1) && window.__ink.flowStrip().some((n) => n.i === 3)`);
let strip = await flowIds();
T.ok('连续阅读时上下相邻的页按新的先后重取：上面是 s0，下面是 s2', ok && strip.some(([i, id]) => i === 1 && id === 's0') && strip.some(([i, id]) => i === 3 && id === 's2'), strip);
await T.shot('1-after-insert-elsewhere.png');

// 2. 另一台把这一页挪到了最后；这台接着写：存到它上面，这台跟着到第 5 页
files0 = inkFiles();
await other('/api/page/move', { nb: 'scratch', from: 2, to: 4, key: K[1] });
await T.pen(T.line(150, 1400, 200));
const a3 = await lastId();
ok = (await T.saved()) && (await T.waitFor(`window.__ink.S.idx === 4`));
s = await state();
T.ok('另一台挪了这一页：字照样存到它上面，电脑上只改了它', same(inkOf(K[1]), ['s1', a1, a2, a3]) && same(changedFiles(files0, inkFiles()), [fileName(K[1])]), [inkOf(K[1]), changedFiles(files0, inkFiles())]);
T.ok('这台跟着到了 5/5，眼前还是这一页', ok && s.chip === '5/5' && same(s.ink, ['s1', a1, a2, a3]) && same(s.keys, await keysNow()), s);

// 3. 另一台把这一页删了；这台接着写：字存进删掉的那一页，说一句，翻到原来位置上的那一页；还原后字都在
files0 = inkFiles();
await other('/api/page/delete', { nb: 'scratch', i: 4, key: K[1] });
await T.pen(T.line(150, 1500, 200));
const a4 = await lastId();
ok = (await T.saved()) && (await T.waitFor(`window.__ink.S.page && window.__ink.S.nb.pages === 4 && window.__ink.S.idx === 3`));
s = await state();
t = await toastNow();
T.ok('另一台删了这一页：刚写的字存进了删掉的那一页（电脑上只改了它），没写到别的页上',
  same(inkOf(K[1]), ['s1', a1, a2, a3, a4]) && same(changedFiles(files0, inkFiles()), [fileName(K[1])]) && !layoutOf().pages.some((e) => e.key === K[1]) && layoutOf().hidden.some((h) => h.entry.key === K[1]),
  [inkOf(K[1]), changedFiles(files0, inkFiles())]);
T.ok('平板上说：在别的设备上删掉了、字存在那一页里、在「显示已删的页」里还原', t === '第 5 页在别的设备上删掉了：刚写的字存在了那一页里，在抽屉的「显示已删的页」里还原就能看到', t);
T.ok('翻到了原来位置上的那一页（现在的第 4 页，s3），没有字没存上', ok && s.chip === '4/4' && s.ink[0] === 's3' && !s.trouble && same(s.keys, await keysNow()), s);
await T.shot('3-deleted-elsewhere.png');
if ((await T.visible('#drawer')) !== true) await T.tap('#nbChip', 600);
await T.tap('#actHidden', 600);
const rows = await js(`[...document.querySelectorAll('#hiddenList .hr span')].map((x) => x.textContent)`);
T.ok('「显示已删的页」里列着它，标着写过字', same(rows, ['空白页（写过字）']), rows);
await T.tap('#hiddenList .hr button', 1500);
ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.nb.pages === 5 && window.__ink.S.idx === 4`);
s = await state();
T.ok('点「还原」：那一页回来了，刚才写的字都在', ok && same(s.ink, ['s1', a1, a2, a3, a4]), s);
if (await T.visible('#drawer')) await T.tap('#nbChip', 600);

// 4. 另一台又在最前面插了一页；这台翻到第 1 页（不在手上，要从电脑上取）：取来的是另一页，这台就知道页序变了，换成新的
await other('/api/page/insert', { nb: 'scratch', after: -1 });
const K2 = await keysNow(); // [新插的, 上一次插的, s0, s2, s3, s1]
const NK = K2[0]; // 之后一直在这一页上
await T.openPage(0);
ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.nb.pages === 6`);
s = await state();
T.ok('翻页取来的是电脑上现在的第 1 页：这台换成了新的页序（6 页），不用等存页', ok && s.idx === 0 && same(s.keys, K2) && same(s.ink, []), s);
files0 = inkFiles();
await T.pen(T.line(150, 400, 200));
const a5 = await lastId();
T.ok('在上面写的字存到了眼前这一页（刚插进来的空白页），别的页没动', (await T.saved()) && same(inkOf(NK), [a5]) && same(changedFiles(files0, inkFiles()), [fileName(NK)]), [inkOf(NK), changedFiles(files0, inkFiles())]);

// 5. 点「AI」时只有眼前这一页有新写的，但这台的页码过时了：只交这一页，交对那一页（按键）
await other('/api/send-all', { nb: 'scratch', target: 'S1', only_new: false }); // 先把各页都交一次：之后只有新写的算新
const sub0 = await T.waitSub('S1');
T.ok('准备：各页都交过一次', Boolean(sub0) && T.metaOf(sub0).kind === 'scan', sub0 && T.metaOf(sub0).kind);
await T.sleep(800);
await T.pen(T.line(150, 520, 200));
const a5b = await lastId();
await T.saved();
await other('/api/page/insert', { nb: 'scratch', after: -1 }); // 这一页现在是第 2 页，这台还以为是第 1 页
await js(`window.__ink.check()`);
const sub1 = await T.waitSub('S1');
const m1 = sub1 ? T.metaOf(sub1) : {};
T.ok('点「AI」：只交了眼前这一页（不是几页一起交），交的是它现在的第 2 页、它的键', Boolean(sub1) && !m1.kind && m1.page === 1 && m1.page_key === NK, [m1.kind, m1.page, m1.page_key, NK]);
ok = await T.waitFor(`window.__ink.S.idx === 1 && window.__ink.S.nb.pages === 7`);
T.ok('交完存页时这台换成了新的页序（人还在这一页）', ok && same((await state()).ink, [a5, a5b]), await state());

// 6. 几页一起交以后的记账（lsent）：这台的页码过时时，不记到眼前这一页上
await T.sleep(500);
await other('/api/page/insert', { nb: 'scratch', after: -1 }); // 眼前这一页现在是第 3 页；电脑上的第 2 页是另一张空白页（这台以为是第 1 页）
const K3 = await keysNow();
const future = Date.now() + 3600 * 1000; // 比眼前这一页记着的「交到哪一笔」晚：记错页就看得出来
await other(`/api/page?nb=scratch&i=1&key=${K3[1]}`, { v: 1, strokes: [{ id: 'o1', t0: future, w: 3, pts: [[100, 700, 0.5, 0], [300, 700, 0.5, 30]] }], ai: [], reads: [] }, 'PUT');
const before = (await state()).lastSent;
await other('/api/send-all', { nb: 'scratch', target: 'S1', only_new: true });
const sub2 = await T.waitSub('S1');
await T.sleep(1500);
s = await state();
const p2 = sub2 ? Object.values(T.metaOf(sub2).pages || {}) : [];
T.ok('另一台几页一起交了（只有它写过的那一页，电脑上的第 2 页）', Boolean(sub2) && T.metaOf(sub2).kind === 'scan' && p2.length === 1 && p2[0].page === 1, sub2 && T.metaOf(sub2).pages);
T.ok('那一页的记账没记到这台眼前这一页上（页码对不上，按键认）', s.idx === 1 && same(s.ink, [a5, a5b]) && s.lastSent === before, [s.idx, s.lastSent, before]);

// 7. 服务说那一页哪里都没有了（410，带 pageGone）：说服务那句话，不卡在「正在重试」；之后照常存，刚写的那笔也在
await T.openNotebook('scratch', K3.indexOf(NK)); // 先换成新的页序，免得下面的提示被「页序变了」那句盖住
T.ok('重新打开这本：还在这一页', (await state()).idx === 2 && same((await state()).ink, [a5, a5b]), await state());
// 拦请求：mode 为 gone 时存页一律回 410；为 hold 时删页的请求先扣住（heldReq），由测试放行
let mode = 'gone', heldReq = null;
T.onCdp('Fetch.requestPaused', (p) => {
  if (mode === 'gone' && p.request.method === 'PUT') {
    T.cdp('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 410, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify({ error: '这一页已经不在这本里了，刚写的没存进本子。你这边没存上的字另存在电脑上：data/conflicts/x.json', pageGone: true })).toString('base64') }).catch(() => {});
  } else if (mode === 'hold' && p.request.url.includes('/api/page/delete')) heldReq = p.requestId;
  else T.cdp('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
});
await T.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/page?*', requestStage: 'Request' }] });
await T.pen(T.line(150, 640, 200));
const a6 = await lastId();
ok = await T.waitFor(`/哪里|不在这本里了/.test(document.querySelector('#toast').textContent)`);
t = await toastNow();
await T.sleep(9000); // 存不上时 5 秒后重试；8 秒还没存上顶上会出「正在重试」
s = await state();
T.ok('服务说那一页不在了：平板说服务那句话（另存在电脑上），不重试、顶上不出「正在重试」',
  ok && t === '这一页已经不在这本里了，刚写的没存进本子。你这边没存上的字另存在电脑上：data/conflicts/x.json' && !s.trouble && (await T.saved(100)), [t, s.trouble]);
mode = '';
await T.cdp('Fetch.disable');
await T.pen(T.line(150, 760, 200));
const a7 = await lastId();
T.ok('之后照常存：手上那份连同刚才没存上的那笔一起存上', (await T.saved()) && same(inkOf(NK), [a5, a5b, a6, a7]), inkOf(NK));

// 8. Claude 不指定投递、写到「平板当前那一页」：这台的页码过时了，也写在它眼前那一页上，而且马上落到纸上
const textsOf = (key) => (existsSync(fileOf(key)) ? JSON.parse(readFileSync(fileOf(key), 'utf8')).ai.map((a) => a.text) : []);
await other('/api/page/insert', { nb: 'scratch', after: -1 }); // 眼前这一页现在是第 4 页，这台还以为是第 3 页
const K4 = await keysNow();
// 电脑上现在的第 3 页（这台以为眼前这一页是第 3 页）也有一条还没落到纸上的回答：不能被这台当成眼前这一页的取来落下
const prevPending = join(DIR, fileName(K4[2]).replace(/\.json$/, '.pending.json'));
writeFileSync(prevPending, JSON.stringify([{ req: 'direct-test', level: null, items: [{ type: 'note', text: '给前一页的' }], groups: {}, gx: {},
  crop: { x0: 0, y0: 0, scale: 1 }, sel: null, rot: null, t: Date.now() }]), 'utf8');
const rep = await T.post('/bridge/reply', { sid: 'S1', items: [{ type: 'write', fold: true, text: '按键找到的那一页', anchor: 'end' }] });
T.ok('Claude 写回落在平板眼前那一页（现在的第 4 页）', rep.page === '草稿本第 4 页（空白草稿纸）', rep);
ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.some((a) => a.text === '按键找到的那一页')`);
ok = ok && (await T.saved()) && (await T.waitFor(`window.__ink.S.page && window.__ink.S.idx === 3 && window.__ink.S.nb.pages === 9`));
await T.sleep(800);
const here8 = await js(`window.__ink.S.page.ai.map((a) => a.text)`);
T.ok('平板上马上落在眼前这一页上、存到了它上面，前一页上没有；这台换成了新的页序', ok && textsOf(NK).includes('按键找到的那一页') && !textsOf(K4[2]).includes('按键找到的那一页'),
  [textsOf(NK), textsOf(K4[2]), await state()]);
T.ok('前一页那条还没落下的回答没被取来落到眼前这一页上（还在前一页的待处理里）', !here8.includes('给前一页的') && !textsOf(NK).includes('给前一页的') && existsSync(prevPending), [here8, existsSync(prevPending)]);

// 9. 这台的页码过时时，在眼前这一页后面加页：加在它后面（按键），不加在别的页后面
await other('/api/page/insert', { nb: 'scratch', after: -1 }); // 眼前这一页现在是第 5 页，这台还以为是第 4 页
const before9 = await keysNow();
if ((await T.visible('#drawer')) !== true) await T.tap('#nbChip', 600);
await T.tap('#actAddPortrait', 1500);
ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.nb.pages === 11`);
const K5 = await keysNow(), BK = K5.find((k) => !before9.includes(k));
s = await state();
T.ok('加的空白页紧跟在眼前这一页后面（第 6 页），翻到了它', ok && K5[4] === NK && K5.indexOf(BK) === 5 && s.idx === 5 && same(s.keys, K5), [K5.indexOf(NK), K5.indexOf(BK), s.idx]);

// 10. 这台的页码过时时删眼前这一页：删的是它（按键），不删别的页
await other('/api/page/insert', { nb: 'scratch', after: -1 }); // 眼前这一页（刚加的空白页）现在是第 7 页，这台还以为是第 6 页
await T.tap('#actDelPage', 1500);
ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.nb.pages === 11`);
s = await state();
T.ok('删掉的是眼前这一页（刚加的空白页），前一页（写过字的那一页）还在，翻到了它', ok && !layoutOf().pages.some((e) => e.key === BK) && layoutOf().hidden.some((h) => h.entry.key === BK)
  && layoutOf().pages[5].key === NK && s.idx === 5 && same(s.ink, inkOf(NK)), [layoutOf().pages.map((e) => e.key).indexOf(NK), s]);

// 11. 自己删页的那一会儿又写了一笔：这一笔存进删掉的那一页（不再存到后面接上来的那一页上），也不说「在别的设备上删掉了」
await js(`window.confirm = () => true; 1`); // 这一页写过字，删之前要问一句：答「确定」
// 记下这之后屏幕上方出过的每一句（一闪而过、被下一句盖掉的也记着）
await js(`window.__toasts = []; new MutationObserver(() => window.__toasts.push(document.querySelector('#toast').textContent))
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true }); 1`);
mode = 'hold';
heldReq = null;
await T.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/page/delete*', requestStage: 'Request' }] });
await T.tap('#actDelPage', 300);
for (let k = 0; k < 40 && !heldReq; k++) await T.sleep(100);
const caught = Boolean(heldReq);
await T.tap('#nbChip', 300); // 收起抽屉，在纸上写
const files11 = inkFiles();
await T.pen(T.line(150, 900, 200), 0);
const a8 = await lastId();
const dirty = await js(`window.__ink.S.dirty`);
mode = '';
await T.cdp('Fetch.continueRequest', { requestId: heldReq });
ok = await T.waitFor(`document.querySelector('#toast').textContent === '已删除这一页（可以还原）' && !document.querySelector('#toast').hidden`);
const saved11 = await T.saved();
await T.cdp('Fetch.disable');
s = await state();
T.ok('准备：删页的请求扣住了，这时写的一笔还没存', caught && dirty === true, [caught, dirty]);
T.ok('那一笔存进了删掉的那一页（电脑上只改了它），没存到后面接上来的那一页上', saved11 && inkOf(NK).includes(a8) && same(changedFiles(files11, inkFiles()), [fileName(NK)])
  && !layoutOf().pages.some((e) => e.key === NK) && !s.ink.includes(a8), [inkOf(NK), changedFiles(files11, inkFiles()), s.ink]);
const toasts11 = await js(`window.__toasts`);
T.ok('只说「已删除这一页」，一次也没说在别的设备上删掉了', ok && !toasts11.some((x) => /在别的设备上删掉了/.test(x)), toasts11);

T.ok('页面没有报错', !T.errors.length, T.errors);

// 12. 这台的页码过时时，这一页又在别的设备上改过了（版本冲突）：照旧不覆盖、另存一份，换成那边的版本——换上的是同一页（按键找），不是旧页码上的别的页
await T.sleep(1500); // 上一步存进删掉的那一页之后，这台还会再对一次页序（等它对完，免得下面另一台插页后它马上又对上了）
const CK = await js(`window.__ink.S.nb.pageInfo[window.__ink.S.idx].key`);
const ci = (await state()).idx;
await other(`/api/page?nb=scratch&i=${ci}&key=${CK}`, { v: 1, strokes: [{ id: 'o2', t0: Date.now(), w: 3, pts: [[100, 300, 0.5, 0], [300, 300, 0.5, 30]] }], ai: [], reads: [], rev: 0 }, 'PUT');
await other('/api/page/insert', { nb: 'scratch', after: -1 }); // 这一页现在是第 ci + 2 页
const cdir = join(T.DATA, 'conflicts'), kept0 = existsSync(cdir) ? readdirSync(cdir) : [];
await T.pen(T.line(150, 1000, 200));
const a9 = await lastId();
ok = await T.waitFor(`/别的设备上改过了/.test(document.querySelector('#toast').textContent)`) && (await T.waitFor(`window.__ink.S.page && window.__ink.S.idx === ${ci + 1}`));
await T.sleep(600);
s = await state();
const kept = (existsSync(cdir) ? readdirSync(cdir) : []).filter((f) => !kept0.includes(f));
const keptIds = kept.length === 1 ? JSON.parse(readFileSync(join(cdir, kept[0]), 'utf8')).strokes.map((x) => x.id) : [];
T.ok('冲突照旧：电脑上那一页还是那边的版本，这台没存上的那份另存了一份（里面有刚写的那一笔）', same(inkOf(CK), ['o2']) && keptIds.includes(a9), [inkOf(CK), kept, keptIds]);
T.ok('这台换成了那边的版本，是同一页（现在的页码），不是旧页码上的别的页', ok && same(s.ink, ['o2']) && s.idx === ci + 1 && same(s.keys, await keysNow()), s);

// 13. 英文界面：新加的几句都有英文
await T.go('&lang=en');
const zh = ['这本的页在别的设备上加过、删过或挪过：已换成新的页序，眼前还是这一页',
  '第 5 页在别的设备上删掉了：刚写的字存在了那一页里，在抽屉的「显示已删的页」里还原就能看到',
  '眼前这一页在别的设备上删掉了，翻到了第 2 页（在抽屉的「显示已删的页」里可以还原）',
  '这一页已经不在这本里了，刚写的没存进本子。你这边没存上的字另存在电脑上：data/conflicts/x.json',
  '没发出去：这一页已经从这本里删掉了（可能是在别的设备上删的），可以在抽屉的「显示已删的页」里还原',
  '没加成：这一页已经从这本里删掉了（可能是在别的设备上删的），可以在抽屉的「显示已删的页」里还原',
  '没删成：没有这一页', '页的键不对'];
const en = await js(`${JSON.stringify(zh)}.map((s) => window.InkLang.t(s))`);
T.ok('英文界面里这几句都换成了英文', en.every((x) => !/[㐀-鿿]/.test(x)), en);

T.ok('页面没有报错（英文界面）', !T.errors.length, T.errors);
await T.finish();

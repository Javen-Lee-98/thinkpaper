// 推送按项目文件夹各一本（2026-11-17 用户定，《产品定义》第 2 节「本子、对话、AI 的关系」）。查：
// 两个文件夹的对话各推一页：进各自的一本「推送 · 文件夹名」，平板上方的提示说是哪个文件夹的对话推的、不写 Claude；
// 这些本子排在普通本子里（不钉在最上面），都有「⋯」；同一个文件夹的两个对话推的页进同一本，抽屉里那一行写「这一页发往」、翻页跟着变，
// 在各自那一页上点「AI」交回各自的对话（另一个对话推的页不跟着交）；推的对话关了：点「AI」先问（话里说的是推这一页的那个），
// 选了以后它推的别的页也改发到选的那个、不再问，别的对话推的页不变；能改名（改名后再推还进这一本）、能拖进文件夹、能删（删了再推新开一本）；
// 只在本地的推送本子推不进去、也不另开一本；以前那本「Claude 推送」有页时照旧能打开、写、交（按整本的发往）、能删；
// 英文界面那几句是英文。只在无头 Edge 的合成输入上试过，没在 iPad 上试过。
// 跑法：node tests/run_browser.mjs <临时目录> --only push_books；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

const NAME = 'push-books', SP = process.argv[2] || join((await import('node:os')).tmpdir(), 'inkthink-browser-tests');
const PAPER = join(SP, NAME, 'proj', 'paper'), IDEA = join(SP, NAME, 'proj', 'idea');
const SESS = [
  { sid: 'A1', label: 'paper', cwd: PAPER },
  { sid: 'A2', label: 'paper', cwd: PAPER },
  { sid: 'B', label: 'idea', cwd: IDEA },
];
const T = await boot({ name: NAME, sessions: SESS, open: false });
const js = T.evalJS, sleep = T.sleep;
// boot 会清空这个测试的临时目录：文件夹、图在它之后建
const SRC = join(T.ROOT, 'src'), NBS = join(T.DATA, 'notebooks'), OLD = join(NBS, 'board');
for (const d of [PAPER, IDEA, SRC, OLD]) mkdirSync(d, { recursive: true });
const IMG = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k) => join(SRC, k + '.png'));
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
for f in sys.argv[1:]:
    pix=fitz.Pixmap(fitz.csRGB, fitz.IRect(0,0,400,300), 0); pix.set_rect(pix.irect,(235,240,255)); pix.save(f)`, ...IMG, join(OLD, 'bg-0000.png')]);
// 以前那本「Claude 推送」里已有的一页（2026-11-17 以前推的，没记是谁推的）：照旧的样子放进数据文件夹；那本记着发往 B
writeFileSync(join(OLD, 'index.json'), JSON.stringify({ pages: [{ title: '旧图', file: 'bg-0000.png', h: 750, src: join(SRC, 'old.png') }] }), 'utf8');
writeFileSync(join(OLD, 'settings.json'), JSON.stringify({ target: { sid: 'B', label: 'idea', cwd: IDEA } }), 'utf8');
await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title: '随笔' }) });
// 打字的先后：A1、A2 先，B 最近（选对话的单子里每个对话写最近打的一句话）
for (const [sid, hint] of [['A1', '改第二节的图'], ['A2', '核对参考文献'], ['B', '修存页']]) { await T.post('/bridge/active', { sid, hint }); await sleep(30); }
await T.go();

// ---- 小工具
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) await T.tap('#nbChip', 600); };
const rows = () => js(`[...document.querySelectorAll('#nbList > *')].map((r) => r.classList.contains('nf-item') ? { f: r.querySelector('.nf-name').textContent, fid: r.dataset.fid }
  : { nb: r.dataset.nb, name: r.querySelector('.nb-name').textContent, more: Boolean(r.querySelector('.nb-more')), nested: r.classList.contains('nested') })`);
const toastNow = () => js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').firstChild.textContent`);
const toastFor = async (title) => { await T.waitFor(`!document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.includes(${JSON.stringify(title)})`); return toastNow(); };
const sids = ['A1', 'A2', 'B'];
const sentToNow = async () => { const got = []; for (const s of sids) { const sub = await T.poll(s); if (sub) got.push(s); } return got.join('+'); };
const sentTo = async () => { for (let i = 0; i < 40; i++) { const got = await sentToNow(); if (got) return got; await sleep(250); } return ''; };
let lastSub = null;
const sentSub = async (sid) => { lastSub = await T.waitSub(sid); return lastSub; };
let y = 400;
const write = async () => { await T.tool('red'); await T.pen(T.line(120, y, 200)); y += 60; await T.saved(); await sleep(300); };
const row = () => T.text('#actTarget');
const nextPage = async () => { await T.tap((await T.visible('#chipNext')) ? '#chipNext' : '#next', 1200); };
const pickUp = () => T.waitFor(`!document.querySelector('#targetPick').hidden`, 5000);
const answer = (kind, val) => js(`window.__asked = []; window.${kind} = (m) => { window.__asked.push(m); return ${JSON.stringify(val)}; }; 1`);
const boards = () => (existsSync(join(NBS, 'boards.json')) ? JSON.parse(readFileSync(join(NBS, 'boards.json'), 'utf8')) : []);
const show = (sid, path, title) => T.post('/bridge/show', { sid, path, title });

// ================= 1. 两个文件夹的对话各推一页：进各自的一本，提示说是哪个文件夹的对话推的
const r1 = await show('A1', IMG[0], '图一');
const t1 = await toastFor('图一');
const r2 = await show('B', IMG[1], '图二');
const t2 = await toastFor('图二');
const NBP = r1.nb, NBI = r2.nb;
T.ok('paper 的对话推的进「推送 · paper」，idea 的对话推的进「推送 · idea」（两本）', r1.ok && r2.ok && /^board:/.test(NBP) && /^board:/.test(NBI) && NBP !== NBI
  && r1.nbTitle === '推送 · paper' && r2.nbTitle === '推送 · idea', [r1, r2]);
T.ok('平板上方的提示说是哪个文件夹的对话推的，不写 Claude', t1 === '「paper」里的对话推送了一页：图一' && t2 === '「idea」里的对话推送了一页：图二', [t1, t2]);

// ================= 2. 抽屉里：推送本子排在普通本子里，不钉在最上面；除了草稿本都有「⋯」
await drawer(true);
let L = await rows();
T.ok('抽屉里：草稿本在最上面，推送本子（连以前那本）排在自己建的本子后面', JSON.stringify(L.map((r) => r.name)) === JSON.stringify(['草稿本', '随笔', 'Claude 推送', '推送 · paper', '推送 · idea']), L);
T.ok('每本（连推送本子、2026-11-18 起连草稿本）都有「⋯」', L.every((r) => r.more), L);
// 推送本子不能复制（2026-11-18）：它的「⋯」里没有「复制这本…」，别的照旧
await T.tap(`#nbList .nb-item[data-nb=${JSON.stringify(NBP)}] .nb-more`, 400);
const pushMenu = await js(`[...document.querySelectorAll('#nbMenu button')].map((b) => b.dataset.act)`);
T.ok('推送本子的「⋯」里没有「复制这本…」', JSON.stringify(pushMenu) === '["folder","up","down","rename","delete"]', pushMenu);
await T.tap(`#nbList .nb-item[data-nb=${JSON.stringify(NBP)}] .nb-more`, 300);
await drawer(false);

// ================= 3. 同一个文件夹的另一个对话推的页进同一本；抽屉里那一行写这一页发往谁，翻页跟着变
const r3 = await show('A2', IMG[2], '图三');
const r4 = await show('A1', IMG[3], '图四');
T.ok('paper 里的另一个对话（A2）推的页也进「推送 · paper」', r3.nb === NBP && r3.page === 1 && r4.nb === NBP && r4.page === 2, [r3, r4]);
await T.openNotebook(NBP, 0);
const rowP0 = await row();
await nextPage();
const rowP1 = { idx: await js('window.__ink.S.idx'), text: await row() };
T.ok('第 1 页（A1 推的）：那一行写「这一页发往：paper『改第二节的图』」', rowP0 === '这一页发往：paper『改第二节的图』 ▾', rowP0);
T.ok('翻到第 2 页（A2 推的）：跟着变成「这一页发往：paper『核对参考文献』」', rowP1.idx === 1 && rowP1.text === '这一页发往：paper『核对参考文献』 ▾', rowP1);

// ================= 4. 在各自那一页上点「AI」：交回推这一页的对话；另一个对话推的页不跟着交
await T.openNotebook(NBP, 0);
await write();
await T.tap('#check');
const got4a = await sentTo();
T.ok('第 1 页点「AI」：交给推它的 A1（不是最近打字的 B），别的都没收到', got4a === 'A1', got4a);
await nextPage();
await write();
await T.tap('#check');
const s4 = await sentSub('A2');
await sleep(800);
T.ok('第 2 页点「AI」：交给推它的 A2；第 1 页（A1 推的）没跟着交过去', Boolean(s4) && s4.text.startsWith('【草稿纸】') && !s4.text.startsWith('【草稿纸·整本】')
  && s4.text.includes('页面：你推送到平板的「图三」') && (await sentToNow()) === '', s4 && s4.text.slice(0, 120));
const settingsOf = (nb) => { const f = join(NBS, nb.replace(':', '-'), 'settings.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; };
T.ok('这本没有记成整本发往谁（推页面时不再把整本绑给推的对话）', (await js('window.__ink.S.nb.target || null')) === null && !settingsOf(NBP).target, settingsOf(NBP));

// ================= 5. 推的对话（A1）关了：在它推的页上点「AI」先问；选了以后它推的页都改发、不再问，A2 推的页不变
T.stopHello();
setInterval(() => SESS.filter((s) => s.sid !== 'A1').forEach((s) => T.post('/bridge/hello', { sid: s.sid, label: s.label, cwd: s.cwd }).catch(() => {})), 5000);
await T.post('/bridge/bye', { sid: 'A1' });
const left = await T.waitFor(`!window.__ink.S.sessions.some((s) => s.sid === 'A1')`);
await T.openNotebook(NBP, 0);
const rowGone = await row();
T.ok('A1 关了：第 1 页那一行写「这一页发往：「paper」（不在了）」', left && rowGone === '这一页发往：「paper」（不在了） ▾', rowGone);
await write();
await T.tap('#check');
T.ok('点「AI」：先弹单子，不发', await pickUp());
const head5 = await T.text('#targetPickHead');
T.ok('单子顶上说的是推这一页的那个对话', head5 === '推这一页的「paper」对话现在不在了。它推的页改发往：', head5);
await sleep(800);
T.ok('没选之前谁都没收到', (await sentToNow()) === '', null);
await T.tap('#targetPickList button[data-sid=B]', 600);
T.ok('选了 B：这一页交给了 B', (await sentTo()) === 'B');
await T.openNotebook(NBP, 2);
const rowP2 = await row();
await write();
await T.tap('#check');
const got5 = await sentTo();
T.ok('A1 推的另一页（第 3 页）也改发到 B：那一行写「这一页发往：idea」，点「AI」不再问，直接交给 B', rowP2 === '这一页发往：idea ▾' && got5 === 'B'
  && (await js(`document.querySelector('#targetPick').hidden`)), [rowP2, got5]);
await T.openNotebook(NBP, 1);
const rowA2 = await row();
await write();
await T.tap('#check');
// （paper 里只剩 A2 一个对话了：叫法不再带它打的那句话）
T.ok('A2 推的那页不变：还写「这一页发往：paper」，交给 A2', rowA2 === '这一页发往：paper ▾' && (await sentTo()) === 'A2', rowA2);
const idxP = JSON.parse(readFileSync(join(NBS, NBP.replace(':', '-'), 'index.json'), 'utf8')).pages;
T.ok('电脑上：谁推的照旧记着，A1 推的两页另记了改发到 B', JSON.stringify(idxP.map((p) => [p.by.sid, (p.to || {}).sid || ''])) === JSON.stringify([['A1', 'B'], ['A2', ''], ['A1', 'B']]), idxP);

// ================= 6. 改名（改名后同一个文件夹再推还进这一本）、拖进文件夹
await drawer(true);
await answer('prompt', '论文的图');
await T.tap(`#nbList .nb-item[data-nb=${JSON.stringify(NBP)}] .nb-more`, 400);
await T.tap('#nbMenu [data-act=rename]', 1200);
await drawer(true);
L = await rows();
T.ok('「⋯」→「改名…」：推送本子改了名', L.some((r) => r.nb === NBP && r.name === '论文的图'), L);
const r6 = await show('A2', IMG[4], '图五');
T.ok('改名后 paper 里的对话再推：还进这一本', r6.nb === NBP && r6.nbTitle === '论文的图' && r6.page === 3, r6);
const fid = (await T.apiJson('/api/folders/new', { method: 'POST', body: JSON.stringify({ name: '课题' }) })).id;
await T.reload();
await drawer(true);
const touch = (type, x, yy) => T.cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: yy, id: 3, radiusX: 8, radiusY: 8, force: 0.5 }] });
const a6 = await T.centerOf(`#nbList .nb-item[data-nb=${JSON.stringify(NBP)}]`), b6 = await T.centerOf(`#nbList .nf-item[data-fid=${JSON.stringify(fid)}]`);
await touch('touchStart', a6[0], a6[1]);
await sleep(700);
const lifted = await js(`[...document.querySelectorAll('.lifted')].map((e) => e.dataset.nb)`);
for (let k = 1; k <= 12; k++) { await touch('touchMove', a6[0] + ((b6[0] - a6[0]) * k) / 12, a6[1] + ((b6[1] - a6[1]) * k) / 12); await sleep(16); }
await touch('touchEnd');
await sleep(900);
const folders6 = JSON.parse(readFileSync(join(NBS, 'folders.json'), 'utf8')).folders;
L = await rows();
T.ok('推送本子按住约半秒能抓起，拖到「课题」上松手：放进了文件夹', JSON.stringify(lifted) === JSON.stringify([NBP]) && folders6[0].items.includes(NBP)
  && L.some((r) => r.nb === NBP && r.nested), [lifted, folders6, L]);

// ================= 7. 删掉「推送 · idea」：挪开留着；idea 的对话再推，新开一本
await answer('confirm', true);
await T.tap(`#nbList .nb-item[data-nb=${JSON.stringify(NBI)}] .nb-more`, 400);
await T.tap('#nbMenu [data-act=delete]', 1500);
await drawer(true);
L = await rows();
const aside = readdirSync(NBS).filter((n) => n.startsWith('_deleted-') && n.endsWith(NBI.replace(':', '-')));
T.ok('「⋯」→「删除这本…」：从列表里拿掉了，电脑上挪开留着（能找回）', !L.some((r) => r.nb === NBI) && aside.length === 1
  && existsSync(join(NBS, aside[0], 'bg-0000.png')) && !boards().some((b) => 'board:' + b.id === NBI), [L, aside]);
const r7 = await show('B', IMG[5], '图六');
T.ok('删掉以后 idea 的对话再推：新开一本「推送 · idea」，从第 1 页开始', r7.ok && r7.nb !== NBI && /^board:/.test(r7.nb) && r7.nbTitle === '推送 · idea' && r7.page === 0, r7);

// ================= 8. 只在本地的推送本子：推不进去，也不另开一本
await T.apiJson('/api/notebook/setting', { method: 'POST', body: JSON.stringify({ nb: r7.nb, key: 'local', value: true }) });
const n8 = boards().length;
const bad = await T.postRaw('/bridge/show', { sid: 'B', path: IMG[6], title: '图七' });
const badBody = await bad.json();
T.ok('只在本地：推不进去（400），回的话不带本子名，没有另开一本', bad.status === 400 && /^这个文件夹的推送本子只在本地/.test(badBody.error || '') && !badBody.error.includes('推送 ·')
  && boards().length === n8 && JSON.parse(readFileSync(join(NBS, r7.nb.replace(':', '-'), 'index.json'), 'utf8')).pages.length === 1, [bad.status, badBody]);

// ================= 9. 以前那本「Claude 推送」：有页时照旧能打开、写、交（按整本记着的发往）；能删
await drawer(false);
await T.openNotebook('board', 0);
const old9 = await js(`({ id: window.__ink.S.nb.id, bg: Boolean(window.__ink.S.bgImg), title: window.__ink.S.nb.title })`);
const rowOld = await row();
T.ok('以前那本照旧能打开：底图在，那一行写「这本发往：idea」（整本的）', old9.id === 'board' && old9.bg && old9.title === 'Claude 推送' && rowOld === '这本发往：idea ▾', [old9, rowOld]);
y = 300;
await write();
await T.tap('#check');
const got9 = await sentTo();
T.ok('在旧的推送页上点「AI」：照旧按整本的发往交给 B', got9 === 'B', [got9, await toastNow(), await js('window.__ink.S.page.strokes.length')]);
await drawer(true);
await answer('confirm', true);
await T.tap('#nbList .nb-item[data-nb="board"] .nb-more', 400);
await T.tap('#nbMenu [data-act=delete]', 1500);
await drawer(true);
L = await rows();
T.ok('以前那本也能删：从列表里拿掉了，目录挪开留着', !L.some((r) => r.nb === 'board') && !existsSync(OLD) && readdirSync(NBS).some((n) => n.startsWith('_deleted-') && n.endsWith('-board')), L);
await drawer(false);

// ================= 10. 英文界面：提示、名字、那一行是英文
await T.go('&lang=en');
await T.openNotebook(NBP, 1);
await drawer(true);
const en = { row: await row(), names: (await rows()).map((r) => r.name || r.f) };
T.ok('英文界面：那一行写「This page sends to: …」；没改过名的推送本子叫「Pushed · idea」', en.row === 'This page sends to: paper ▾'
  && en.names.includes('Pushed · idea') && en.names.includes('论文的图'), en);
await drawer(false);
await show('A2', IMG[6], 'fig 7');
const tEn = await toastFor('fig 7');
T.ok('英文界面：推页面的提示是英文', tEn === 'A session in “paper” pushed a page: fig 7', tEn);

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

// 没选过对话的本子，第一次点「AI」先选发往哪个对话（2026-11-17 用户定，《产品定义》第 2 节）。查：
// 连着三个对话（论文文件夹里两个、别处一个，别处那个最近打过字——以前会悄悄发给它）；从「新文件」提示加进来一份论文文件夹里的文档：
//   抽屉里那一行写「还没选（点「AI」时选）」；写一笔点「AI」：不发，先弹出选对话的单子，顶上写「这本还没选发往哪个对话。发往：」；
//   单子里文件所在文件夹的那一组排在最前、标着「文件在这个文件夹里」，没有哪一行打着 ✓；谁都没收到；
//   选论文文件夹里的第二个对话：真的交给了它（别的都没收到），这本从此记成发往它，再点「AI」不再问；
// 草稿本（没有原文件）也一样先问，单子照旧按最近打字的排、不标文件夹；
// 服务也把关：没选过、连着不止一个、请求里没带对话——不收（410，带 pick），带了对话的照收；只连着一个对话时不问，直接发给它；
// 英文界面那几句是英文。只在无头 Edge 里试过。
// 跑法：node tests/run_browser.mjs <临时目录> --only target_first；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

const NAME = 'target-first', SP = process.argv[2] || join((await import('node:os')).tmpdir(), 'inkthink-browser-tests');
const PAPER = join(SP, NAME, 'proj', 'paper'), IDEA = join(SP, NAME, 'proj', 'idea');
const SESS = [
  { sid: 'P1', label: 'paper', cwd: PAPER },
  { sid: 'P2', label: 'paper', cwd: PAPER },
  { sid: 'I', label: 'idea', cwd: IDEA },
];
const T = await boot({ name: NAME, sessions: SESS, open: false });
const js = T.evalJS, sleep = T.sleep;
mkdirSync(PAPER, { recursive: true }); // boot 会清空这个测试的临时目录：文件在它之后建
mkdirSync(IDEA, { recursive: true });
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
for i, f in enumerate(sys.argv[1:]):
    doc=fitz.open(); p=doc.new_page(width=595,height=842); p.insert_text((72,100),'draft %d' % i,fontsize=20); doc.save(f)`, join(PAPER, '论文稿.pdf'), join(PAPER, '论文稿二.pdf')]);
// 打字的先后：P1、P2 先，I 最近（以前没绑过的本子会悄悄发给最近打字的 I）
await T.post('/bridge/active', { sid: 'P1', hint: '改第二节的图' });
await sleep(30);
await T.post('/bridge/active', { sid: 'P2', hint: '核对参考文献' });
await sleep(30);
await T.post('/bridge/active', { sid: 'I', hint: '修草稿纸的存页' });
// 论文文件夹里的一个对话（P1）报出了这份文件；用户在平板上点「加入」
await T.post('/bridge/offer', { sid: 'P1', files: [{ path: join(PAPER, '论文稿.pdf') }] });
const oid = (await T.apiJson('/api/offers'))[0].id;
const added = await T.apiJson('/api/offer-accept', { method: 'POST', body: JSON.stringify({ id: oid }), headers: { 'Content-Type': 'application/json' } });
await T.go();
await T.openNotebook(added.nb, 0);

const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) await T.tap('#nbChip'); await sleep(300); };
const items = () => js(`[...document.querySelectorAll('#targetPickList > *')].map((e) => ({ cls: e.className, sid: e.dataset.sid || '', id: e.id,
  check: Boolean(e.querySelector('.tp-check')), on: e.classList.contains('on'), text: e.textContent }))`);
const sentToNow = async () => { const got = []; for (const s of SESS) if (await T.poll(s.sid)) got.push(s.sid); return got.join('+'); };
const sentTo = async () => { for (let i = 0; i < 40; i++) { const got = await sentToNow(); if (got) return got; await sleep(250); } return ''; };
let y = 200;
const write = async () => { await T.pen(T.line(120, y, 220)); y += 80; await sleep(400); };
const pickUp = () => T.waitFor(`!document.querySelector('#targetPick').hidden`, 5000);

// ================= 1. 从「新文件」提示加进来的本子：没记成发往谁
T.ok('从「新文件」提示加进来的本子没有记成发往哪个对话（报出文件的 P1 只是同一个文件夹里碰巧先报的那个）', (await js(`window.__ink.S.nb.target || null`)) === null, await js(`window.__ink.S.nb.target || null`));
await drawer(true);
const row1 = await T.text('#actTarget');
T.ok('抽屉里那一行：这本发往：还没选（点「AI」时选）', row1 === '这本发往：还没选（点「AI」时选） ▾', row1);
await drawer(false);

// ================= 2. 写一笔点「AI」：先弹单子，不发
await write();
await T.tap('#check');
T.ok('点「AI」：先弹出选对话的单子', await pickUp());
const head = await T.text('#targetPickHead');
T.ok('顶上写「这本还没选发往哪个对话。发往：」', head === '这本还没选发往哪个对话。发往：', head);
const L = await items();
const heads = L.filter((r) => r.cls.split(' ')[0] === 'tp-folder');
T.ok('文件所在的文件夹（paper）排在最前、标着「文件在这个文件夹里」；别的文件夹（最近打字的 idea）排在后面、不标',
  heads.length === 2 && heads[0].text === 'paper · 文件在这个文件夹里' && /\bnear\b/.test(heads[0].cls) && heads[1].text === 'idea' && !/\bnear\b/.test(heads[1].cls), heads);
T.ok('每个对话排在自己的文件夹下面（论文文件夹里两个都在，最近打字的 P2 在前）', L.slice(0, 5).map((r) => r.sid || r.cls.split(' ')[0]).join() === 'tp-folder,P2,P1,tp-folder,I', L.map((r) => r.sid || r.cls));
T.ok('没有哪一行打着 ✓、是选中的样子（不替用户定）', !L.some((r) => r.check || r.on), L.filter((r) => r.check || r.on));
T.ok('最下面照样有「不发给 Claude（只在本地）」', L[L.length - 1].id === 'tpLocal', L[L.length - 1]);
await sleep(1200);
T.ok('这时谁都没收到', (await sentToNow()) === '', null);
await T.shot('2-first-pick.png');

// ================= 3. 选论文文件夹里的 P1（不是最近打字的，也不是排第一的）：交给它，从此记下
await T.tap('#targetPickList button[data-sid=P1]', 600);
const got3 = await sentTo();
T.ok('选了 P1：这一页交给了 P1，别的对话都没收到', got3 === 'P1', got3);
T.ok('这本从此记成发往 P1', (await js(`(window.__ink.S.nb.target || {}).sid`)) === 'P1' && (await T.apiJson('/api/notebook?nb=' + encodeURIComponent(added.nb))).target.sid === 'P1', await js(`window.__ink.S.nb.target`));
await write();
await T.tap('#check');
const got3b = await sentTo();
T.ok('再写一笔点「AI」：不再问，直接交给 P1', got3b === 'P1' && (await js(`document.querySelector('#targetPick').hidden`)), got3b);

// ================= 4. 草稿本（没有原文件）也先问；单子照旧按最近打字的排、不标文件夹
await T.openNotebook('scratch', 0);
await write();
await T.tap('#check');
T.ok('草稿本没选过对话：点「AI」也先弹单子', await pickUp());
const L4 = await items(), heads4 = L4.filter((r) => r.cls.split(' ')[0] === 'tp-folder').map((r) => r.text);
T.ok('草稿本没有原文件：文件夹照旧按最近打字的排（idea 在前），不标「文件在这个文件夹里」', JSON.stringify(heads4) === JSON.stringify(['idea', 'paper']), heads4);
await sleep(800);
T.ok('没选之前谁都没收到', (await sentToNow()) === '', null);
await T.tap('#targetPickList button[data-sid=I]', 600);
T.ok('选了 I：草稿本这一页交给了 I', (await sentTo()) === 'I');

// ================= 5. 英文界面：那几句是英文（另加进来一本没选过的）
await T.post('/bridge/offer', { sid: 'P2', files: [{ path: join(PAPER, '论文稿二.pdf') }] });
const oid2 = (await T.apiJson('/api/offers')).find((o) => o.name === '论文稿二.pdf').id;
const added2 = await T.apiJson('/api/offer-accept', { method: 'POST', body: JSON.stringify({ id: oid2 }), headers: { 'Content-Type': 'application/json' } });
await T.go('&lang=en');
await T.openNotebook(added2.nb, 0);
await drawer(true);
const rowEn = await T.text('#actTarget');
T.ok('英文界面：抽屉里那一行', rowEn === 'Sends to: not chosen yet (you pick when you tap AI) ▾', rowEn);
await drawer(false);
await write();
await T.tap('#check');
T.ok('英文界面：点 AI 也先弹单子', await pickUp());
const headEn = await T.text('#targetPickHead'), tagEn = await js(`(document.querySelector('#targetPickList .tp-near') || {}).textContent || ''`);
T.ok('英文界面：单子顶上那句和文件夹后面的标记是英文', headEn === 'No session has been chosen for this notebook yet. Send it to:' && tagEn === 'the file is in this folder', [headEn, tagEn]);
await T.tap('#targetPickList button[data-sid=P2]', 600);
T.ok('英文界面：选了 P2 就交给 P2', (await sentTo()) === 'P2');

await T.finish();

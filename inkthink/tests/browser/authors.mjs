// 蓝字记作者、交给别的对话时说明（2026-11-17 用户定，《产品定义》第 2 节「本子、对话、AI 的关系」：纸是跨对话、跨 AI 的共同记忆）。查：
// （2026-11-17 起空白本子里不太长、旁边有空的长回答会摊在纸上：这里的长回答都带 fold: true，查的是收着（圈号）的样子；摊开的见 open_answer.mjs）
// 1. 对话 A（paper 文件夹）写回的短批注、勾、长回答落到纸上：每条带着作者（A 的 sid、文件夹名、文件夹、AI = Claude），读法也带；
//    存回电脑的页面文件里也有；重新加载页面后还在；
// 2. 没记作者的批注（没说是哪个对话写回的，写到平板眼前这一页）：落下时什么都不记；
// 3. 这本改发到对话 B（idea 文件夹）再点「AI」：B 收到的消息里有那句说明，条数对（3 条）、说的是 A 的文件夹名「paper」，
//    列表里那两条标〔不是你写的〕、勾写出是什么和在哪一组，A 答过的红笔写「回答过：别的对话答的」；没记作者的那条不标、不数；
// 4. 改回 A 再点「AI」：没有那句、没有标记，标题照旧「你之前在这一页写过的批注」；
// 5. 橡皮擦掉 A 的短批注、撤销、恢复、再撤销：作者一直在；
// 6. 改发到 B，在 A 的短批注上写红字点「AI」（2026-11-18 起短批注留在纸上、不收成卡片）：它还是 A 写的一条短批注；
//    B 收到的消息里写明这组红笔写在哪条蓝字上，那条蓝字照旧标〔不是你写的〕；
//    B 回一条短批注（落在红字旁），又在 A 的长回答卡片下面接一段：两样记的都是 B；重新加载后都还在；
// 7. 改回 A 点「AI」：说有 2 条是「idea」的对话写的（B 的短批注、卡片下面 B 接的那一段），两处标〔不是你写的〕，A 自己的不标。
// 只在无头 Edge 里用合成的输入试过，没在 iPad 上试过。
// 跑法：node tests/run_browser.mjs <临时目录> --only authors；有一项不对退出码 1。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep } from '../browser_lib.mjs';

const NAME = 'authors', SP = process.argv[2] || join((await import('node:os')).tmpdir(), 'inkthink-browser-tests');
const PAPER = join(SP, NAME, 'proj', 'paper'), IDEA = join(SP, NAME, 'proj', 'idea');
const SESS = [{ sid: 'A', label: 'paper', cwd: PAPER }, { sid: 'B', label: 'idea', cwd: IDEA }];
const T = await boot({ name: NAME, sessions: SESS, open: false });
mkdirSync(PAPER, { recursive: true }); // boot 会清空这个测试的临时目录：文件夹在它之后建
mkdirSync(IDEA, { recursive: true });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const TAG = '〔不是你写的〕';
const A_AUTHOR = { sid: 'A', label: 'paper', cwd: PAPER, ai: 'Claude' };
const same = (a, b) => JSON.stringify(Object.keys(a || {}).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b || {}).sort().map((k) => [k, b[k]]));
const item = (id) => S(`(() => { const a = S.page.ai.find((o) => o.id === ${JSON.stringify(id)}); return a ? JSON.parse(JSON.stringify(a)) : null; })()`);
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) await T.tap('#nbChip'); await sleep(300); };
const target = async (sid) => { await drawer(true); await T.tap('#actTarget'); await T.tap(`#targetPickList button[data-sid=${sid}]`, 800); await drawer(false); };
const hline = (x0, y, len, n = 14) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 0.6]);
const waitPen = () => sleep(1150);
async function landed(n) { // 等写回的批注落到这一页（一共 n 条），并且一条条写完
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
// 点「AI」：交给谁（只等 sid 这一个对话），另一个对话这时有没有收到
async function sendTo(sid) {
  await T.tap('#check');
  const sub = await T.waitSub(sid, 60);
  const other = await T.poll(sid === 'A' ? 'B' : 'A');
  return { sub, text: sub ? sub.text : '', other };
}

// ================= 0. 草稿本先选好发往 A；单页；红笔问题 g1、黑字 g2，交给 A
await T.apiJson('/api/notebook/target', { method: 'POST', body: JSON.stringify({ nb: 'scratch', sid: 'A' }) });
await T.go();
if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }
await T.tool('red');
await T.pen(T.line(120, 200, 260));
await T.tool('pen');
await sleep(1600);
await T.pen(T.line(120, 420, 260));
const r0 = await sendTo('A');
const meta0 = r0.sub && T.metaOf(r0.sub);
T.ok('（前提）交给了 A：两组，g1 是红笔', Boolean(meta0) && meta0.groups.length === 2 && meta0.groups[0].red && !meta0.groups[1].red && !r0.other, meta0 && meta0.groups);

// ================= 1. A 写回短批注（答 g1）、勾（g2）、长回答（g2）和 g1 的读法：每条带着作者
const NOTE_A = '先看天气预报', LONG_A = '九点出门比较稳：路上要一个小时，十点前能到。';
const rep = await T.post('/bridge/reply', { sid: 'A', submission: r0.sub.id, items: [
  { type: 'note', anchor: 'g1', text: NOTE_A }, { type: 'tick', anchor: 'g2' }, { type: 'write', fold: true, anchor: 'g2', q: '这一步对吗？', text: LONG_A },
  { type: 'read', anchor: 'g1', text: '几点出门' }] });
T.ok('（前提）服务收下了 4 条', rep.ok === true && rep.count === 4, rep);
T.ok('（前提）三条落到纸上', await landed(3), await S('S.page.ai.map((a) => a.type)'));
let ai = await S('JSON.parse(JSON.stringify(S.page.ai))');
const noteA = ai.find((a) => a.type === 'note'), tickA = ai.find((a) => a.type === 'tick'), writeA = ai.find((a) => a.type === 'write');
T.ok('落到纸上的每一条都带着作者：A 的 sid、文件夹名、文件夹、AI（插件没报，记 Claude）', ai.length === 3 && ai.every((a) => same(a.author, A_AUTHOR)), ai.map((a) => a.author));
const reads = await S('JSON.parse(JSON.stringify(S.page.reads || []))');
T.ok('读法也记着是 A 读的', reads.length === 1 && same(reads[0].author, A_AUTHOR), reads);
T.ok('页面上不显示作者（批注层里没有 paper 这几个字）', !(await js(`document.querySelector('#aiRoot').textContent`)).includes('paper'));
await T.saved();
const disk1 = T.pageFile('scratch', 0);
T.ok('存回电脑的页面文件里每一条都带着作者', Boolean(disk1) && disk1.ai.length === 3 && disk1.ai.every((a) => same(a.author, A_AUTHOR)) && same((disk1.reads || [])[0]?.author, A_AUTHOR),
  disk1 && disk1.ai.map((a) => a.author));
await T.reload();
ai = await S('JSON.parse(JSON.stringify(S.page.ai))');
T.ok('重新加载页面后作者都还在', ai.length === 3 && ai.every((a) => same(a.author, A_AUTHOR)), ai.map((a) => a.author));

// ================= 2. 一条没记作者的（没说是哪个对话写回的，写到平板眼前这一页）：落下时什么都不记
const OLD = '旧的批注没记是谁写的';
const rep2 = await T.post('/bridge/reply', { sid: '', items: [{ type: 'note', box: [120, 600, 300, 620], text: OLD }] });
T.ok('（前提）收下了', rep2.ok === true, rep2);
T.ok('（前提）落到纸上', await landed(4));
const old = (await S('JSON.parse(JSON.stringify(S.page.ai))')).find((a) => a.text === OLD);
T.ok('没说是哪个对话写回的：这一条不记作者（不编）', Boolean(old) && !('author' in old), old);

// ================= 3. 改发到 B 再点「AI」：消息里说明 A 写的 3 条不是它写的
await target('B');
const r3 = await sendTo('B');
const t3 = r3.text;
T.ok('交给了 B，A 没收到', Boolean(r3.sub) && !r3.other, [Boolean(r3.sub), Boolean(r3.other)]);
T.ok('B 的消息里有那句说明：3 条、是「paper」的对话写的，勾写出是什么、在哪一组',
  t3.includes('这一页上有 3 条蓝色批注不是这个对话写的（是「paper」的对话写的），你没有它们的上下文：当成纸上已有的内容看，不要当成自己说过的话。'
    + '下面列出的批注里标着〔不是你写的〕的是其中 2 条；另外的是：勾（g2）。'), t3.slice(-900));
T.ok('列表里 A 的短批注、长回答标〔不是你写的〕，没记作者的那条不标、不数', t3.includes('这一页上之前写回的批注（标着〔不是你写的〕的是别的对话写的）：')
  && t3.includes(`- ${TAG}${NOTE_A}`) && t3.includes(`- 圈号 1${TAG}（问：这一步对吗？）：${LONG_A}`) && t3.includes(`- ${OLD}`) && !t3.includes(`${TAG}${OLD}`), t3.slice(-700));
T.ok('A 答过的红笔 g1：书写过程里写「回答过：别的对话答的」', /g1｜[^\n]*红笔（回答过：别的对话答的）/.test(t3), t3.split('\n').filter((l) => l.startsWith('g1')));

// ================= 4. 改回 A 再点「AI」：没有那句、没有标记
await target('A');
const r4 = await sendTo('A');
const t4 = r4.text;
T.ok('交给了 A，B 没收到', Boolean(r4.sub) && !r4.other);
T.ok('A 的消息里没有那句、没有标记，标题照旧', !t4.includes('不是这个对话写的') && !t4.includes(TAG) && !t4.includes('别的对话')
  && t4.includes('你之前在这一页写过的批注：\n- ') && t4.includes(`\n- ${NOTE_A}\n`) && t4.includes(`\n- ${OLD}`), t4.slice(-700));
T.ok('A 自己答的红笔照旧写「回答过」', /g1｜[^\n]*红笔（回答过）/.test(t4), t4.split('\n').filter((l) => l.startsWith('g1')));

// ================= 5. 橡皮擦掉 A 的短批注、撤销、恢复、再撤销：作者一直在
const L = noteA.lay;
await T.tool('eraser');
await T.pen(hline(L.x + 4, L.y + L.fs * 0.6, Math.min(L.w, 4 * L.fs), 8));
let n5 = await item(noteA.id);
T.ok('（前提）橡皮擦掉了 A 的短批注', Boolean(n5 && n5.erasedAt), n5);
await T.tool('pen');
await T.tap('#toolsUndo');
n5 = await item(noteA.id);
const u1 = Boolean(n5) && !n5.erasedAt && same(n5.author, A_AUTHOR);
await T.tap('#toolsRedo');
n5 = await item(noteA.id);
const r1 = Boolean(n5) && Boolean(n5.erasedAt) && same(n5.author, A_AUTHOR);
await T.tap('#toolsUndo');
n5 = await item(noteA.id);
const u2 = Boolean(n5) && !n5.erasedAt && same(n5.author, A_AUTHOR);
T.ok('撤销、恢复、再撤销：这一条一直带着 A 的作者', u1 && r1 && u2, [u1, r1, u2, n5 && n5.author]);

// ================= 6. 改发到 B，在 A 的短批注上写红字点「AI」：短批注留在纸上、还是 A 的；B 的消息里写明红笔写在哪条蓝字上
await target('B');
await T.tool('red');
await T.pen(hline(L.x + L.fs, L.y + L.fs + 5, 4 * L.fs));
await T.tool('pen');
const r6 = await sendTo('B');
const meta6 = r6.sub && T.metaOf(r6.sub);
const g6 = meta6 && meta6.groups.filter((g) => g.red && !g.answered).pop();
const kept = await item(noteA.id);
T.ok('A 的短批注留在纸上：还是一条短批注，没有收成卡片，还是 A 写的', Boolean(kept) && kept.type === 'note' && !kept.from && !kept.erasedAt && same(kept.author, A_AUTHOR), kept && [kept.type, kept.author]);
T.ok('B 的消息里写明这组红笔写在哪条蓝字上', Boolean(g6) && new RegExp(`${g6.id}｜[^\\n]*红笔（问题，写在蓝字批注「${NOTE_A}」上）`).test(r6.text), r6.text.split('\n').filter((l) => /红笔/.test(l)));
T.ok('那条蓝字在列表里照旧标〔不是你写的〕，消息里没有「卡片原来是」那句', r6.text.includes(`- ${TAG}${NOTE_A}`) && !r6.text.includes('的卡片原来是'), r6.text.slice(-900));
T.ok('总的那句照旧是 3 条（短批注、勾、长回答），没记作者的不数', r6.text.includes('这一页上有 3 条蓝色批注不是这个对话写的（是「paper」的对话写的）'), r6.text.slice(-900));
const NOTE_B = '下雨就带伞';
const rep6 = await T.post('/bridge/reply', { sid: 'B', submission: r6.sub.id, items: [
  { type: 'note', anchor: g6 ? g6.id : 'g1', text: NOTE_B },
  { type: 'write', card: 1, q: '下雨怎么办', text: '下雨就改去博物馆。' }] });
T.ok('（前提）B 的两条回应收下了', rep6.ok === true, rep6);
const longId = await S(`(S.page.ai.find((o) => o.type === 'write' && o.n === 1) || {}).id`);
T.ok('（前提）短批注落到纸上、另一段接到 A 的长回答卡片下面', (await T.waitFor(`(window.__ink.S.page.ai.find((o) => o.id === ${JSON.stringify(longId)}).more || []).length === 1
  && window.__ink.S.page.ai.some((o) => o.type === 'note' && o.text === ${JSON.stringify(NOTE_B)})`, 15000)));
const noteB = await S(`(() => { const a = S.page.ai.find((o) => o.type === 'note' && o.text === ${JSON.stringify(NOTE_B)}); return a ? JSON.parse(JSON.stringify(a)) : null; })()`);
const isB = (au) => Boolean(au) && au.sid === 'B' && au.label === 'idea' && au.cwd === IDEA;
T.ok('B 回在红字旁的短批注记的是 B', Boolean(noteB) && isB(noteB.author), noteB && noteB.author);
const seg = ((await item(longId)).more || [])[0];
T.ok('卡片下面接的那一段记的是 B，卡片本身还是 A', Boolean(seg) && isB(seg.author) && same((await item(longId)).author, A_AUTHOR), seg);
await T.saved();
await T.reload();
const card2 = await item(longId), kept2 = await item(noteA.id), noteB2 = await item(noteB && noteB.id);
T.ok('重新加载后：卡片还是 A、那一段还是 B；A 的短批注还是 A 的短批注；B 的短批注还是 B', Boolean(card2) && same(card2.author, A_AUTHOR) && card2.more && isB(card2.more[0].author)
  && Boolean(kept2) && kept2.type === 'note' && same(kept2.author, A_AUTHOR) && Boolean(noteB2) && isB(noteB2.author), [card2 && card2.author, card2 && card2.more, kept2 && kept2.type, noteB2 && noteB2.author]);

// ================= 7. 改回 A 点「AI」：B 的短批注和卡片下面 B 接的那一段不是 A 写的
await target('A');
const r7 = await sendTo('A');
const t7 = r7.text;
T.ok('A 的消息里说有 2 条是「idea」的对话写的', t7.includes('这一页上有 2 条蓝色批注不是这个对话写的（是「idea」的对话写的）'), t7.slice(-900));
T.ok('B 的短批注和那一段在列表里标〔不是你写的〕，A 自己的短批注和卡片不标', t7.includes(`- ${TAG}${NOTE_B}`) && t7.includes(`  - 接着${TAG}（回应红字「下雨怎么办」）：下雨就改去博物馆。`)
  && t7.includes(`\n- ${NOTE_A}\n`) && t7.includes(`- 圈号 1（问：这一步对吗？）：${LONG_A}`), t7.slice(-900));
await T.shot('7-page.png');

await T.finish();

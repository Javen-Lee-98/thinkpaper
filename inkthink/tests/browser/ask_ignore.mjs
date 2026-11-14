// 问话卡片的「忽略」「全部忽略」（2026-11-14 用户在 iPad 上试过后定；《产品定义》第 3 节「问话卡片」）：
// 问题卡片左下角一个文字按钮「忽略」：卡片消失，不算回答，下一张落下；和右上角的「稍后」分在两头、不重叠。
// 工具还在等的，告诉 Claude 用户忽略了、不要再问、按最稳妥的做法继续或停下说明；工具已经不等了的，不往对话里送消息。
// 排着不止一张时：卡片上和缩成的小条旁边各有「全部忽略（N 张）」，不再问一句，一次清掉：问题卡片按忽略、
// 字迹确认卡片按「看不清，跳过」、结果卡片按「知道了」。忽略了的刷新后不回来。改文件前问覆盖还是另存的卡片点了忽略：
// 这次不改，文件、留底、新文件都没有。英文界面的字。
// 跑法：node tests/browser/ask_ignore.mjs [临时目录]；有一项不对退出码 1。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from '../browser_lib.mjs';

const T = await boot({ name: 'ask-ignore' });
const js = T.evalJS, sid = 'S1';
const ask = async (body) => { await T.sleep(300); return T.post('/bridge/ask', Object.assign({ sid }, body)); };
const wait = (id, o) => T.post('/bridge/ask-wait', Object.assign({ id, wait: 20 }, o));
const cardUp = async (id) => { const ok = await T.waitFor(`window.__ink.S.qShown === ${JSON.stringify(id)} && !document.querySelector('#qcard').hidden`); await T.sleep(400); return ok; };
const allGone = () => T.waitFor(`document.querySelector('#qcard').hidden && document.querySelector('#qbar').hidden && !window.__ink.S.cards.length`);
const rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.hidden || !e.getClientRects().length) return null;
  const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
const meets = (a, b) => Boolean(a && b) && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const shot = async (f) => { await js(`document.querySelector('#toast').hidden = true`); return T.shot(f); };
const toastText = () => js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
// 卡片上看得见的按钮：每个的字和位置
const buttons = () => js(`[...document.querySelectorAll('#qcard button')].filter((b) => !b.hidden && b.offsetWidth).map((b) => { const r = b.getBoundingClientRect();
  return { t: b.textContent, id: b.id, l: r.left, t0: r.top, r: r.right, b: r.bottom }; })`);
const overlapAny = (bs) => bs.some((a, i) => bs.some((b, j) => i < j && a.l < b.r && b.l < a.r && a.t0 < b.b && b.t0 < a.b));

await T.pen(T.line(120, 900, 300));
await T.saved();

// 1. 一张问题卡片：左下角「忽略」，右上角「稍后」，不重叠、分在两头；工具还在等时点「忽略」：工具收到「用户忽略了」
const q1 = await ask({ question: '周六去哪家超市？', options: ['东门', '西门'] });
await cardUp(q1.id);
const b1 = await buttons(), ign = b1.find((b) => b.id === 'qcIgnore'), later = b1.find((b) => b.id === 'qcLater'), card = await rect('#qcard');
T.ok('问题卡片：左下角有「忽略」，只有一张时没有「全部忽略」', Boolean(ign) && ign.t === '忽略' && !b1.some((b) => b.id === 'qcAll'), b1);
T.ok('「忽略」在卡片左下、「稍后」在右上：分在两头，按钮互不重叠', Boolean(ign && later) && ign.l < card.l + card.w / 3 && later.r > card.r - card.w / 3 && ign.t0 > later.b && !overlapAny(b1), b1);
await shot('ignore-one.png');
const w1 = wait(q1.id);
await T.tap('#qcIgnore', 300);
const a1 = await w1;
T.ok('工具那边收到：用户忽略了、不要再问、按最稳妥的做法继续或停下说明、不要替用户做有风险的选择', Boolean(a1.answer) && a1.answer.ignored === true
  && a1.text.includes('用户忽略了这个问题，没有回答') && a1.text.includes('不要再问同一个问题') && a1.text.includes('按最稳妥的做法继续') && a1.text.includes('不要替用户做有风险的选择'), a1);
T.ok('卡片消失', await allGone());
await T.sleep(800);
T.ok('不另往对话里送消息', !(await T.poll(sid)));

// 2. 工具已经不等了才点「忽略」：不往对话里送消息，服务把卡片清掉
const q2 = await ask({ question: '游记要不要配照片？', options: ['配', '不配'] });
await cardUp(q2.id);
const p2 = await wait(q2.id, { wait: 0.3, last: true });
T.ok('工具先得到「还没答」', p2.pending === true, p2);
await T.tap('#qcIgnore', 300);
await T.sleep(1500);
T.ok('之后点「忽略」：卡片消失，对话里什么也没来', (await allGone()) && !(await T.poll(sid)) && (await T.apiJson('/api/asks')).length === 0);

// 3. 全部忽略：一张问题、一张字迹确认、一张结果排着；卡片上和小条旁边都有「全部忽略（3 张）」；点了一次清掉
const scan = await T.post('/bridge/scan', { sid });
const q3 = await ask({ question: '清单里加不加牛奶？', options: ['加', '不加'] });
await cardUp(q3.id);
const c3 = await T.post('/bridge/confirm', { sid, submission: scan.id, questions: [{ anchor: 'g1', guess: '鸡蛋', options: ['鸡蛋', '面包'] }] });
const r3 = await ask({ result: '会议纪要整理好了：一共三条。' });
T.ok('三张都排上了', await T.waitFor(`window.__ink.S.cards.length === 3`), await js(`window.__ink.S.cards.map((c) => c.kind)`));
const b3 = await buttons(), all3 = b3.find((b) => b.id === 'qcAll');
T.ok('卡片左下：「忽略」「全部忽略（3 张）」，和别的按钮不重叠', Boolean(all3) && all3.t === '全部忽略（3 张）' && b3.some((b) => b.id === 'qcIgnore') && !overlapAny(b3), b3);
await shot('ignore-all-card.png');
await T.tap('#qcLater');
const bar = await rect('#qbar'), barAll = await rect('#qbarAll');
T.ok('缩成小条：旁边有「全部忽略（3 张）」，不和小条、左上角那一排、右下角那一条重叠', (await T.text('#qbarAll')) === '全部忽略（3 张）' && Boolean(bar && barAll)
  && !meets(bar, barAll) && !meets(barAll, await rect('#chipRow')) && !meets(barAll, await rect('#tools')), [bar, barAll]);
await shot('ignore-all-bar.png');
await T.tap('#qbarAll', 600);
T.ok('点了一次：三张都清掉，不再问一句', await allGone(), await js(`window.__ink.S.cards.length`));
T.ok('提示「已忽略 3 张卡片」', /已忽略 3 张卡片/.test(await toastText()), await toastText());
T.ok('服务上也没有了', (await T.apiJson('/api/asks')).length === 0 && (await T.apiJson('/api/confirms')).length === 0);
const a3 = await wait(q3.id, { wait: 0 }), cw = await T.post('/bridge/confirm-wait', { id: c3.id, wait: 0 });
T.ok('问题卡片按忽略算', Boolean(a3.answer) && a3.answer.ignored === true, a3);
T.ok('字迹确认卡片按「看不清，跳过」算', Array.isArray(cw.answers) && cw.answers.every((x) => x.skip) && cw.text.includes('跳过'), cw);
await T.sleep(800);
T.ok('都不往对话里送消息', !(await T.poll(sid)));

// 4. 刷新：忽略了的不回来
await T.reload();
await T.sleep(1200);
T.ok('刷新后：忽略了的卡片不回来', (await js(`window.__ink.S.cards.length`)) === 0 && (await js(`document.querySelector('#qcard').hidden`)));

// 5. 改文件前问覆盖还是另存的卡片点「忽略」：这次不改——文件、留底、新文件都没有
const SRC = join(T.ROOT, 'docs'), MD = join(SRC, '买菜清单.md');
mkdirSync(SRC, { recursive: true });
writeFileSync(MD, '# 周末买菜清单\n\n- 西红柿 三个\n- 鸡蛋 一盒\n', 'utf8');
const before = readFileSync(MD), files0 = readdirSync(SRC);
const e5 = await T.post('/bridge/edit', { sid, path: MD });
await cardUp(e5.ask);
T.ok('改文件的卡片也有「忽略」', (await buttons()).some((b) => b.id === 'qcIgnore'));
const w5 = T.post('/bridge/edit-wait', { id: e5.ask, wait: 20 });
await T.tap('#qcIgnore', 300);
const g5 = await w5;
T.ok('工具那边收到：用户忽略了，这次不要改这个文件', g5.ignored === true && g5.text.includes('用户忽略了，这次不要改这个文件'), g5);
T.ok('文件没动、没有新文件、没有留底', readFileSync(MD).equals(before) && JSON.stringify(readdirSync(SRC)) === JSON.stringify(files0)
  && !(existsSync(join(T.DATA, 'keep')) && readdirSync(join(T.DATA, 'keep')).length), [readdirSync(SRC), existsSync(join(T.DATA, 'keep')) && readdirSync(join(T.DATA, 'keep'))]);

// 6. 英文界面：「Ignore」「Ignore all (2)」、小条旁边的、忽略后的提示
await T.go('&lang=en');
const q6 = await ask({ question: '买几个西红柿？', options: ['三个', '五个'] });
await cardUp(q6.id);
await ask({ question: 'Second question', options: ['A'] });
await T.waitFor(`window.__ink.S.cards.length === 2`);
await T.sleep(500);
const b6 = await buttons();
T.ok('英文：卡片上「Ignore」「Ignore all (2)」「Later」', b6.some((b) => b.t === 'Ignore') && b6.some((b) => b.t === 'Ignore all (2)') && b6.some((b) => b.t === 'Later'), b6);
await shot('ignore-en.png');
await T.tap('#qcLater');
T.ok('英文：小条旁边「Ignore all (2)」', (await T.text('#qbarAll')) === 'Ignore all (2)', await T.text('#qbarAll'));
await T.tap('#qbarAll', 600);
T.ok('英文：提示「Ignored 2 cards」', (await allGone()) && (await toastText()) === 'Ignored 2 cards', await toastText());

await T.finish();

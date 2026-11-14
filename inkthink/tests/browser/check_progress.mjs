// 「AI」按钮上的进度（《产品定义》第 2 节：AI → 已交 → Claude 在看 → 在改文件，回完变回「AI」；2026-11-14 以前叫「检查」）和只在本地的本子：
// 点了交上去变「已交」；插件报排队、进了对话、读了图、改文件、写回、结束，按钮上的字依次跟着变，只往前走不往回退，结束变回「AI」；
// 进度只写在按钮上：纸上不再出现「已发给……」那一块；
// 进行中再点照样能交，按钮显示新的那一轮、旧的那一轮的进展不再写上来；交不出去（没有连着的对话、网断了）立刻是「AI」；
// 一直没有下一步，到时间变回「AI」（等待时间在测试里调短），之后再来下一步接着显示；换本子、换页、退出全屏 / 全屏、
// 刷新页面后字是对的（刷新那会儿错过的几步补上）；英文界面的字（平时也是 AI）；各阶段按钮宽度不变、右下角那一条不挪；
// 进行中的样子（浅蓝底、蓝框）和只在本地的样子（灰底、锁、字看得清）；只在本地（在抽屉「这本发往」里选）的本子点了只提示、不发，换回别的本子恢复。
// 各阶段右下角那一条的截图存在 <临时目录>/check-progress/out/ 下。
// 跑法：node tests/browser/check_progress.mjs [临时目录]；有一项不对退出码 1。
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'check-progress', pages: 2, open: false });
const pad = await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title: '读书笔记' }) }); // 第二个本子
await T.go();
const js = T.evalJS;

// ---- 小工具
// 一个「AI」按钮现在的样子：字、阶段、进行中 / 锁着、宽度、颜色、锁的图标看不看得见
const look = (sel = '#check') => js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}), cs = getComputedStyle(b), r = b.getBoundingClientRect();
  const lk = b.querySelector('.ck-lock svg'), lr = lk && lk.getBoundingClientRect();
  return { text: b.textContent, stage: b.dataset.stage, busy: b.classList.contains('busy'), locked: b.classList.contains('locked'), disabled: b.disabled,
    aria: b.getAttribute('aria-disabled'), w: Math.round(r.width * 10) / 10, h: Math.round(r.height), bg: cs.backgroundColor, fg: cs.color, border: cs.borderTopColor,
    lock: Boolean(lr && lr.width >= 12 && lr.height >= 12), shown: cs.display !== 'none' && r.width > 0 }; })()`);
const text = async (sel = '#check') => (await look(sel)).text;
// 等按钮上的字变成 want（最多 ms 毫秒）
const waitText = (want, ms = 8000, sel = '#check') => T.waitFor(`document.querySelector(${JSON.stringify(sel)}).textContent === ${JSON.stringify(want)}`, ms);
// 右下角那一条在屏幕上的位置
const toolsBox = () => js(`(() => { const r = document.querySelector('#tools').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom].map((v) => Math.round(v)); })()`);
// 插件那一侧：报这一轮的进展；进了对话（取到并确认收到）；写回一条短批注
const report = (id, stage) => T.post('/bridge/progress', { sid: 'S1', id, stage });
const deliver = (id) => T.post('/bridge/ack', { sid: 'S1', id });
const replyNote = (id) => T.post('/bridge/reply', { sid: 'S1', submission: id, items: [{ type: 'note', anchor: 'g1', text: '短批注' }] });
// 这本（默认当前这本）最近交的那一轮的编号
const roundId = (nb) => js(`(() => { const S = window.__ink.S, r = S.rounds.get(${nb ? JSON.stringify(nb) : 'S.nb.id'}); return r ? r.id : null; })()`);
const subs = () => { const d = join(T.DATA, 'submissions'); return existsSync(d) ? readdirSync(d).length : 0; }; // 一共投递过几次
const toastText = () => js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
let y = 140;
const write = async () => { await T.pen(T.line(120, y, 260)); y = y > 1200 ? 160 : y + 70; };
const minWOf = (sel) => js(`parseFloat(document.querySelector(${JSON.stringify(sel)}).style.minWidth) || 0`); // 页面给按钮算好的最小宽度
// 写一笔、点「AI」，等它变成「已交」（交上去了），返回这一轮的编号
const checkNow = async (want = '已交') => { await write(); await T.tap('#check'); const ok = await waitText(want); return ok ? roundId() : null; };
// 纸上有没有发出去后的那块提示（2026-11-14 删了：进度只写在按钮上）：#aiRoot 里的临时块、写着「已发给」「排队中」的字
const paperNote = () => js(`(() => { const r = document.querySelector('#aiRoot'); return { temp: r.querySelectorAll('.ai-temp').length,
  said: /已发给|排队中|已送达|已写回/.test(r.textContent), waiting: 'waiting' in window.__ink.S }; })()`);
const noPaperNote = (p) => p.temp === 0 && !p.said && !p.waiting;
// 在抽屉里「这本发往」的列表里选：只在本地（'local'）或一个对话（对话编号）；选完收起抽屉
const pickTarget = async (what) => {
  if (!(await T.visible('#drawer'))) await T.tap('#nbChip');
  await sleep(300);
  await T.tap('#actTarget');
  await T.tap(what === 'local' ? '#tpLocal' : `#targetPickList button[data-sid="${what}"]`, 800);
  if (await T.visible('#drawer')) await T.tap('#nbChip');
  await sleep(300);
};
// 颜色的对比度（WCAG）：前景、背景都是 rgb(...)
const lum = (c) => { const v = c.match(/[\d.]+/g).slice(0, 3).map((x) => { const s = Number(x) / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const contrast = (a, b) => { const [x, z] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (z + 0.05); };
// 右下角那一条（或别的一块，比如顶栏）的截图（放大两倍）
const shotTools = async (file, sel = '#tools') => {
  const r = await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()`);
  const d = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, r[0] - 10), y: Math.max(0, r[1] - 10), width: r[2] + 20, height: r[3] + 20, scale: 2 } });
  writeFileSync(join(T.OUT, file), Buffer.from(d.data, 'base64'));
};
const widths = [], boxes = []; // 各阶段按钮的宽度、右下角那一条的位置
const note = async () => { widths.push((await look()).w); boxes.push((await toolsBox()).join(',')); };

// ================= 1. 平时：「AI」，蓝底白字；最小宽度放得下最长的那几个字
let L = await look();
T.ok('平时：按钮写「AI」，不是进行中、没锁，能点', L.text === 'AI' && L.stage === 'idle' && !L.busy && !L.locked && !L.disabled && L.aria === null, L);
const barIdle = await js(`document.querySelector('#barCheck').textContent`);
T.ok('顶栏上的那个平时也写「AI」', barIdle === 'AI', barIdle);
T.ok('平时：蓝底白字（字看得清）', L.bg === 'rgb(47, 95, 174)' && L.fg === 'rgb(255, 255, 255)' && contrast(L.bg, L.fg) >= 4.5, [L.bg, L.fg]);
const minW = await minWOf('#check');
T.ok('按钮有一个算好的最小宽度，平时就是这么宽（放得下「Claude 在看」）', minW >= 90 && Math.abs(L.w - minW) <= 1, [minW, L.w]);
const IDLE = L;
await note();
await shotTools('1-idle.png');

// ================= 2. 点「AI」：交上去变「已交」，浅蓝底蓝框；插件报的几步依次写上来，结束变回「AI」
const n0 = subs();
const id1 = await checkNow();
L = await look();
T.ok('点了「AI」、服务收下：按钮变「已交」，进行中的样子', Boolean(id1) && L.text === '已交' && L.stage === 'sent' && L.busy && subs() === n0 + 1, [id1, L]);
T.ok('进行中的样子：浅蓝底深蓝字、蓝框，和平时的蓝底分得出，字看得清', L.bg !== IDLE.bg && L.border === 'rgb(47, 95, 174)' && contrast(L.bg, L.fg) >= 4.5
  && contrast(L.bg, 'rgb(255, 253, 248)') < 1.5, [L.bg, L.fg, L.border, contrast(L.bg, L.fg)]);
let P = await paperNote();
T.ok('交上去以后纸上不出现「已发给……」那一块（进度只写在按钮上）', noPaperNote(P), P);
T.ok('屏幕上方照旧有一句「已交给「idea」」', await T.waitFor(`document.querySelector('#toast').textContent === '已交给「idea」'`, 2000), await T.text('#toast'));
await note();
await shotTools('2-sent.png');

await report(id1, 'queued');
T.ok('对话正忙、排在后面：按钮写「排队中」', await waitText('排队中'), await text());
L = await look();
T.ok('排队中也是进行中的样子', L.busy && L.stage === 'queued', L);
P = await paperNote();
T.ok('排队中：纸上还是什么都没写', noPaperNote(P), P);
await note();
await shotTools('3-queued.png');

const dl = await deliver(id1);
T.ok('进了对话（插件确认收到）：按钮回到「已交」', dl.ok === true && (await waitText('已交')), [dl, await text()]);
await note();

await report(id1, 'reading');
T.ok('Claude 读了交上去的图：按钮写「Claude 在看」', await waitText('Claude 在看'), await text());
await note();
await shotTools('4-reading.png');

await report(id1, 'working');
T.ok('Claude 在改文件：按钮写「在改文件」', await waitText('在改文件'), await text());
await note();
await shotTools('5-working.png');

const rp = await replyNote(id1);
T.ok('Claude 写回一条批注：落到纸上', rp.ok === true && (await T.waitFor(`window.__ink.S.page.ai.some((a) => a.text === '短批注')`)), rp);
await sleep(600);
T.ok('写回之后这一轮还没完：按钮还是「在改文件」（不退回「Claude 在看」，也不提前变回「AI」）', (await text()) === '在改文件', await text());
P = await paperNote();
T.ok('写回、改文件的时候纸上也没有进展的字（只有写回的那条批注）', noPaperNote(P), P);

await report(id1, 'done');
T.ok('这一轮结束：按钮变回「AI」，不再是进行中的样子', await waitText('AI'), await text());
L = await look();
T.ok('变回平时的样子（蓝底白字）', !L.busy && L.stage === 'idle' && L.bg === IDLE.bg && L.fg === IDLE.fg, L);
await note();
const wSpread = Math.max(...widths) - Math.min(...widths);
T.ok('AI / 已交 / 排队中 / Claude 在看 / 在改文件：按钮宽度一样（差不超过 1 像素）', wSpread <= 1, widths);
T.ok('右下角那一条在各阶段都没挪、没变宽', new Set(boxes).size === 1, boxes);

// ================= 3. 只往前走：先写回（没报读图）也至少是「Claude 在看」；之后再报读图不变
const id2 = await checkNow();
await replyNote(id2);
T.ok('没报「读了图」就写回了：按钮写「Claude 在看」（写回了就是看过了）', await waitText('Claude 在看'), await text());
await report(id2, 'working');
T.ok('之后改文件：「在改文件」', await waitText('在改文件'), await text());
await report(id2, 'reading');
await sleep(800);
T.ok('改过文件后才报「读了图」：还是「在改文件」，不往回退', (await text()) === '在改文件', await text());
await report(id2, 'done');
T.ok('结束：「AI」', await waitText('AI'), await text());

// ================= 4. 进行中再点：照样能交，按钮显示新的那一轮；旧的那一轮的进展不再写上来
const id3 = await checkNow();
await report(id3, 'reading');
T.ok('第一轮：Claude 在看', await waitText('Claude 在看'), await text());
L = await look();
T.ok('进行中按钮没有锁死：能点', !L.disabled && L.aria === null && L.busy, L);
const n4 = subs();
const id4 = await checkNow();
T.ok('进行中又写了一笔、再点「AI」：又交了一次，按钮显示新的这一轮「已交」', Boolean(id4) && id4 !== id3 && subs() === n4 + 1 && (await text()) === '已交', [id3, id4, subs() - n4, await text()]);
await report(id3, 'working');
await report(id3, 'done');
await sleep(900);
T.ok('旧的那一轮报「在改文件」「结束」：按钮还是新一轮的「已交」', (await text()) === '已交', await text());
await report(id4, 'reading');
T.ok('新的那一轮读了图：「Claude 在看」', await waitText('Claude 在看'), await text());
await report(id4, 'done');
T.ok('新的那一轮结束：「AI」', await waitText('AI'), await text());
P = await paperNote();
T.ok('交了两轮、都没往这一页写回：纸上也没有留下发出去的提示', noPaperNote(P), P);

// ================= 5. 交不出去：立刻是「AI」，原来的提示照旧
// 5a. 没有连着的对话（服务回错）
T.stopHello();
await T.post('/bridge/bye', { sid: 'S1' });
await T.waitFor(`window.__ink.S.sessions.length === 0`);
await write();
const n5 = subs();
await T.tap('#check');
await T.waitFor(`!document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.startsWith('没发出去')`);
L = await look();
const tip5 = await toastText();
T.ok('没有连着的对话：提示「没发出去：没有连上的……」，按钮立刻是「AI」、不是进行中，什么都没交', tip5.startsWith('没发出去：没有连上的 Claude Code 对话') && L.text === 'AI' && !L.busy && subs() === n5,
  [tip5, L.text, L.busy, subs() - n5]);
await T.hello();
const keep = setInterval(() => T.hello().catch(() => {}), 5000);
await T.waitFor(`window.__ink.S.sessions.length === 1`);
// 5b. 网断了
await T.cdp('Network.enable');
await T.cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await write();
await T.tap('#check', 1200);
const off = { toast: await toastText(), btn: await look() };
await T.cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
T.ok('网断了点「AI」：提示「没发出去」，按钮是「AI」、不是进行中', off.toast.startsWith('没发出去') && off.btn.text === 'AI' && !off.btn.busy, off);
await T.waitFor(`window.__ink.S.online && !window.__ink.S.dirty && !window.__ink.S.saveTryAt`, 15000);
// 5c. 这本上一轮还在走时再交、没交出去：按钮还是上一轮的那一步（上一轮确实还在走）
const id5 = await checkNow();
await report(id5, 'reading');
await waitText('Claude 在看');
await T.cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await write();
await T.tap('#check', 1200);
const off2 = { toast: await toastText(), btn: await look() };
await T.cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
T.ok('上一轮还在走时再交、没交出去：提示「没发出去」，按钮还是上一轮的「Claude 在看」', off2.toast.startsWith('没发出去') && off2.btn.text === 'Claude 在看' && off2.btn.busy, off2);
await T.waitFor(`window.__ink.S.online && !window.__ink.S.dirty && !window.__ink.S.saveTryAt`, 15000);
await report(id5, 'done');
T.ok('那一轮结束：「AI」', await waitText('AI', 10000), await text());

// ================= 6. 一直没有下一步：到时间变回「AI」（测试里把 10 分钟调成 2.5 秒）；从最近一步算起；之后再来下一步接着显示
T.ok('等待时间平时是 10 分钟', (await js(`window.__ink.S.roundWait`)) === 600000);
await js(`window.__ink.S.roundWait = 2500`);
const id6 = await checkNow();
await sleep(1500);
T.ok('交上去 1.5 秒：还是「已交」', (await text()) === '已交', await text());
await report(id6, 'queued');
await waitText('排队中');
await sleep(1600);
T.ok('排队后又过了 1.6 秒（离交上去已超过 2.5 秒）：还是「排队中」，等的时间从最近一步算', (await text()) === '排队中', await text());
T.ok('一直没有下一步：到时间变回「AI」，不是进行中的样子', (await waitText('AI', 4000)) && !(await look()).busy, await look());
P = await paperNote();
T.ok('等过头收回去时纸上也没有要收起的东西', noPaperNote(P), P);
await deliver(id6);
T.ok('后来终于进了对话：按钮接着显示「已交」', await waitText('已交'), await text());
await report(id6, 'done');
T.ok('结束：「AI」', await waitText('AI'), await text());
await js(`window.__ink.S.roundWait = 600000`);

// ================= 7. 换页、换本子、退出全屏 / 全屏：字都是对的
const id7 = await checkNow();
await report(id7, 'reading');
await waitText('Claude 在看');
await T.openPage(1);
T.ok('翻到第 2 页：还是这本这一轮的「Claude 在看」', (await text()) === 'Claude 在看' && (await js(`window.__ink.S.idx`)) === 1, await text());
await T.openPage(0);
await T.tap('#toolsBars', 800);
L = await look('#barCheck');
const barMin = await minWOf('#barCheck');
T.ok('退出全屏：顶栏上的「AI」按钮也写「Claude 在看」、进行中的样子，宽度就是算好的最小宽度', L.shown && L.text === 'Claude 在看' && L.busy
  && barMin >= 90 && Math.abs(L.w - barMin) <= 1, [L, barMin]);
await shotTools('9-bar-reading.png', '#bar');
await T.tap('#fsBtn', 800);
T.ok('回到全屏：右下角的还是「Claude 在看」', (await text()) === 'Claude 在看' && (await look()).shown, await look());
// 换到另一本（在抽屉里真的点一下）
await T.tap('#nbChip');
await sleep(300);
const c = await js(`(() => { const r = [...document.querySelectorAll('#nbList .nb-item')].find((x) => x.querySelector('.nb-name').textContent.includes('读书笔记'));
  if (!r) return null; const b = r.querySelector('.nb-name').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
if (c) await T.tapAt(c[0], c[1], 1500);
if (await T.visible('#drawer')) await T.tap('#nbChip');
L = await look();
T.ok('换到「读书笔记」（这本没交过）：按钮写「AI」、不是进行中', (await js(`window.__ink.S.nb.id`)) === pad.id && L.text === 'AI' && !L.busy, [await js(`window.__ink.S.nb.id`), L]);
y = 140;
const id7b = await checkNow();
T.ok('在「读书笔记」上点「AI」：这本的「已交」', Boolean(id7b) && (await roundId(pad.id)) === id7b, id7b);
await report(id7, 'working');
await sleep(900);
T.ok('草稿本那一轮在改文件：「读书笔记」上还是它自己的「已交」', (await text()) === '已交', await text());
await T.openNotebook('scratch');
T.ok('回到草稿本：按钮写草稿本那一轮的「在改文件」', (await text()) === '在改文件', await text());
await T.openNotebook(pad.id);
T.ok('再到「读书笔记」：「已交」', (await text()) === '已交', await text());
await report(id7b, 'done');
await waitText('AI');
await T.openNotebook('scratch');
T.ok('回到草稿本：还是「在改文件」（这本那一轮还没完）', (await text()) === '在改文件', await text());

// ================= 8. 刷新页面：没走完的那一轮接着显示；刷新那会儿错过的几步补上；结束了的不再显示
await T.reload();
T.ok('刷新后：按钮还是这一轮的「在改文件」', (await text()) === '在改文件' && (await look()).busy, await look());
await T.cdp('Page.navigate', { url: 'about:blank' }); // 页面关着（比如 iPad 把它放在后台）的时候，这一轮结束了
await sleep(500);
await report(id7, 'done');
await T.go();
T.ok('页面关着时这一轮结束了：再打开是「AI」', (await waitText('AI', 5000)) && !(await look()).busy, await look());
const id8 = await checkNow();
await report(id8, 'reading');
await waitText('Claude 在看');
await T.cdp('Page.navigate', { url: 'about:blank' });
await sleep(500);
await report(id8, 'working');
await T.go();
T.ok('页面关着时 Claude 开始改文件：再打开是「在改文件」', await waitText('在改文件', 5000), await text());
await report(id8, 'done');
T.ok('结束：「AI」；再刷新还是「AI」', (await waitText('AI')) && (await T.reload(), (await text()) === 'AI'), await text());

// ================= 9. 只在本地（在抽屉「这本发往」的列表里选最下面那一项）：按钮写「只在本地」、灰色带锁；点了只提示、不发；换到别的本子恢复
await T.openNotebook(pad.id);
await pickTarget('local');
await T.waitFor(`window.__ink.S.nb.local === true`);
L = await look();
T.ok('在抽屉「这本发往」里把「读书笔记」选成只在本地：按钮立刻写「只在本地」，锁着的样子', L.text === '只在本地' && L.stage === 'local' && L.locked && !L.busy && L.aria === 'true' && L.lock, L);
T.ok('只在本地是灰底灰字，字看得清，和平时、进行中都分得出', L.bg === 'rgb(235, 232, 225)' && L.bg !== IDLE.bg && contrast(L.bg, L.fg) >= 4.5, [L.bg, L.fg, contrast(L.bg, L.fg)]);
T.ok('只在本地时按钮宽度不变', Math.abs(L.w - IDLE.w) <= 1, [L.w, IDLE.w]);
T.ok('右下角那一条没挪', (await toolsBox()).join(',') === boxes[0], [await toolsBox(), boxes[0]]);
await shotTools('6-local.png');
const n9 = subs();
await write();
await T.saved();
await T.tap('#check', 800);
const tip9 = await toastText();
T.ok('点「只在本地」：提示这本不发给 Claude、要发到抽屉里「这本发往」选一个对话；什么都没交，按钮还是「只在本地」',
  tip9 === '《读书笔记》设为「只在本地」，不发给 Claude。要发的话，在抽屉里点「这本发往」选一个对话。' && subs() === n9 && (await text()) === '只在本地', [tip9, subs() - n9]);
await T.tap('#toolsBars', 800);
L = await look('#barCheck');
T.ok('退出全屏：顶栏上的也是「只在本地」带锁，宽度不变', L.shown && L.text === '只在本地' && L.locked && L.lock && Math.abs(L.w - barMin) <= 1, [L, barMin]);
await T.tap('#barCheck', 800);
T.ok('点顶栏上的「只在本地」：同样只提示、不发', (await toastText()).startsWith('《读书笔记》设为「只在本地」') && subs() === n9, [await toastText(), subs() - n9]);
await T.tap('#fsBtn', 800);
await T.openNotebook('scratch');
L = await look();
T.ok('换到草稿本：立刻恢复「AI」（蓝底、没锁）', L.text === 'AI' && !L.locked && L.aria === null && L.bg === IDLE.bg, L);
await T.openNotebook(pad.id);
T.ok('换回「读书笔记」：又是「只在本地」', (await text()) === '只在本地', await text());
// 草稿本一轮在走时把它设成只在本地：「只在本地」优先；再在列表里选回对话：取消只在本地
await T.openNotebook('scratch');
const id9 = await checkNow();
await report(id9, 'reading');
await waitText('Claude 在看');
await pickTarget('local');
await T.waitFor(`window.__ink.S.nb.local === true`);
T.ok('一轮在走时把这本选成只在本地：按钮写「只在本地」', (await text()) === '只在本地', await text());
await pickTarget('S1');
await T.waitFor(`window.__ink.S.nb.local === false`);
T.ok('在「这本发往」里再选回对话：取消只在本地，回到这一轮的「Claude 在看」', (await text()) === 'Claude 在看', await text());
await report(id9, 'done');
await waitText('AI');

// ================= 10. 英文界面：平时也是 AI，进度是英文，宽度照样不变
await T.go('&lang=en');
L = await look();
T.ok('英文：平时也是 AI', L.text === 'AI' && !L.busy, L);
const wEn = [L.w];
const idE = await (async () => { await write(); await T.tap('#check'); return (await waitText('Sent')) ? roundId() : null; })();
T.ok('英文：交上去是 Sent', Boolean(idE), await text());
wEn.push((await look()).w);
const seen = [];
for (const [stage, want] of [['queued', 'Queued'], ['reading', 'Reading'], ['working', 'Editing files']]) {
  await report(idE, stage);
  const ok = await waitText(want);
  seen.push(ok ? want : await text());
  wEn.push((await look()).w);
}
T.ok('英文：Queued → Reading → Editing files', seen.join('|') === 'Queued|Reading|Editing files', seen);
await shotTools('7-en-working.png');
await report(idE, 'done');
T.ok('英文：结束变回 AI', await waitText('AI'), await text());
await T.openNotebook(pad.id);
L = await look();
T.ok('英文：只在本地的本子是 Local only，带锁', L.text === 'Local only' && L.locked && L.lock, L);
wEn.push(L.w);
await shotTools('8-en-local.png');
T.ok('英文：各阶段按钮宽度一样（差不超过 1 像素）', Math.max(...wEn) - Math.min(...wEn) <= 1, wEn);
const enMin = await minWOf('#check');
T.ok('英文的字都放得下（没有一个比最小宽度宽）', Math.abs(Math.max(...wEn) - enMin) <= 1, [wEn, enMin]);

clearInterval(keep);
await T.finish();

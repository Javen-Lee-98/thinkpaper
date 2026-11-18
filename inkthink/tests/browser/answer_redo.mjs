// 卡片上的「再短点」「展开讲」（2026-11-17 用户定「事后一键」，细节是用户不在时暂定的；《产品定义》第 2 节「蓝字摊在纸上、回答长短怎么控制」）。查：
// 1. 收着的长回答（圈号 2，A 写的）：卡片底下有「再短点」「展开讲」；点「再短点」——上方说一句，那个钮写「已交」、两个钮都先不能点，
//    写它的对话 A 收到一次投递（只一次）：说点了圈号 2 的「再短点」、原来的回答、怎么写回（card 填 2）；B 什么都没收到；
//    刷新后再打开还是「已交」；
// 2. A 照说的回（write + card）：接在卡片下面（记着是「再短点」、是 A 写的），不出新的圈号；两个钮恢复；
// 3. 摊开的长回答（圈号 1）：点开卡片点「展开讲」；A 回的时候没写 card（服务按这次投递补上）：接在卡片下面，纸上摊的换成新的那一段；
// 3b.（2026-11-18 外部审查后补）「已交」：连点两下只交一份；到点（这里把十分钟调成 2.5 秒）卡片开着也恢复；
//    恢复后再点一次（新请求），旧请求的回应先到不清掉新请求的「已交」，新请求的回应到了才清；交的时候翻了页，「已交」记在原来那一页上；
// 3c. 卡片上的红字随一次「AI」交出去了，又点了「再短点」：重写的回应先到，不算回应了那些红字（on 是空的），那次「AI」的回应到了才算；
// 4. 写它的对话不在了（C 写的圈号 3，C 已经 20 秒没来）：这本原来发往 C，点「再短点」先弹出选对话的单子；选了 B，B 收到，
//    消息里说这条是「old」的对话写的（不是你）。
// 只在无头 Edge 里用合成的输入试过，没在 iPad 上试过。
// 跑法：node tests/run_browser.mjs <临时目录> --only answer_redo；有一项不对退出码 1。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep } from '../browser_lib.mjs';

const NAME = 'answer-redo', SP = process.argv[2] || join((await import('node:os')).tmpdir(), 'inkthink-browser-tests');
const PAPER = join(SP, NAME, 'proj', 'paper'), IDEA = join(SP, NAME, 'proj', 'idea'), OLD = join(SP, NAME, 'proj', 'old');
const T = await boot({ name: NAME, pages: 2, sessions: [{ sid: 'A', label: 'paper', cwd: PAPER }, { sid: 'B', label: 'idea', cwd: IDEA }], open: false });
for (const d of [PAPER, IDEA, OLD]) mkdirSync(d, { recursive: true }); // boot 会清空这个测试的临时目录：文件夹在它之后建
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const waitPen = () => sleep(1150);
async function landed(n) {
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
const item = (id) => S(`(() => { const a = S.page.ai.find((o) => o.id === ${JSON.stringify(id)}); return a ? JSON.parse(JSON.stringify(a)) : null; })()`);
const badgeOf = (id) => js(`(() => { const g = [...document.querySelectorAll('#aiRoot .badge')].find((x) => !x.classList.contains('nbr-badge') && x.dataset.id === ${JSON.stringify(id)}); if (!g) return null;
  const r = g.querySelector('circle').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
const cardUp = () => js(`(() => { const c = document.querySelector('#answerCard'); if (c.hidden) return null; const S = window.__ink.S;
  const b = (q) => { const e = document.querySelector(q); return { text: e.textContent, hidden: e.hidden, disabled: e.disabled, sent: e.classList.contains('sent') }; };
  return { id: S.card && S.card.id, body: c.innerText, shorter: b('#acShorter'), longer: b('#acLonger'), spread: b('#acSpread'),
    segs: [...document.querySelectorAll('#acMore .ac-seg')].map((d) => ({ mq: (d.querySelector('.ac-mq') || {}).textContent || null, text: d.querySelector('.ac-mbody').textContent })) }; })()`);
const watchToasts = () => js(`(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (!t.hidden) window.__toasts.push(t.textContent); })
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true, attributes: true }); return 1; })()`);
const toasts = () => js(`window.__toasts.slice()`);
const openBadge = async (id) => { await waitPen(); const b = await badgeOf(id); if (b) await T.fingerTapAt(b.cx, b.cy); return cardUp(); };
// 打开这一条的卡片：有圈号点圈号；摊在纸上的（第 2 步较短的重写回来后圈号 2 摊开了）直接打开（点摊开的字开卡片在第 3 步查）
const openAns = async (id) => { if (await badgeOf(id)) return openBadge(id);
  await js(`(window.__ink.openCard(window.__ink.S.page.ai.find((o) => o.id === ${JSON.stringify(id)})), 1)`); await sleep(300); return cardUp(); };
const writes = () => S(`S.page.ai.filter((a) => a.type === 'write').length`);
const noFlow = async () => { if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); } };

// ================= 0. 这本发往 A；红笔问题 g1、黑字 g2，交给 A；A 回两条长回答：短的（摊开）、长的（收着）
await T.apiJson('/api/notebook/target', { method: 'POST', body: JSON.stringify({ nb: 'scratch', sid: 'A' }) });
await T.go();
await noFlow();
await watchToasts();
await T.tool('red');
await T.pen(T.line(120, 200, 260));
await T.tool('pen');
await T.pen(T.line(120, 520, 260));
await T.tap('#check');
const sub0 = await T.waitSub('A', 60);
T.ok('（前提）交给了 A', Boolean(sub0), sub0);
const SHORT = '九点出门：路上一个小时。';
const LONG = Array.from({ length: 14 }, (_, k) => `第 ${k + 1} 句：慢慢讲清楚为什么。`).join('\n');
await T.post('/bridge/reply', { sid: 'A', submission: sub0.id, items: [
  { type: 'write', anchor: 'g1', q: '几点出门？', text: SHORT },
  { type: 'write', anchor: 'g2', q: '为什么？', text: LONG }] });
T.ok('（前提）两条落下', await landed(2));
const [w1, w2] = await S(`JSON.parse(JSON.stringify(S.page.ai.filter((a) => a.type === 'write')))`);
T.ok('（前提）圈号 1 摊开、圈号 2 收着，都是 A 写的', Boolean(w1.spread) && !w2.spread && w1.n === 1 && w2.n === 2 && w1.author.sid === 'A' && w2.author.sid === 'A', [w1, w2]);

// ================= 1. 圈号 2：点「再短点」
let C = await openBadge(w2.id);
T.ok('（前提）圈号 2 的卡片：底下有「再短点」「展开讲」，能点', Boolean(C) && C.id === w2.id && C.shorter.text === '再短点' && C.longer.text === '展开讲' && !C.shorter.disabled && !C.longer.disabled, C);
await T.tap('#acShorter');
C = await cardUp();
T.ok('点了「再短点」：上方说请 A 写短一点', (await toasts()).includes('已请「paper」把圈号 2 写短一点'), await toasts());
T.ok('那个钮写「已交」（浅蓝），两个钮都先不能点', Boolean(C) && C.shorter.text === '已交' && C.shorter.sent && C.shorter.disabled && C.longer.disabled && C.longer.text === '展开讲', C);
await T.shot('c1-sent.png');
const r1 = await T.waitSub('A', 40);
await sleep(800); // 多等一会儿：要是交了两份，第二份这时也到了
const again1 = await T.poll('A'), other1 = await T.poll('B');
const t1 = r1 ? r1.text : '';
T.ok('A 收到一次投递（没有第二份），B 没收到', Boolean(r1) && !again1 && !other1, [Boolean(r1), again1 && again1.id, Boolean(other1)]);
T.ok('消息说点了圈号 2 的「再短点」，附原来的回答和问题', t1.startsWith('【草稿纸·重写】我在平板上点了圈号 2 那张卡片上的「再短点」：请把这条回答写短一点')
  && t1.includes('原来的回答（问：为什么？）：\n第 1 句：慢慢讲清楚为什么。') && t1.includes('第 14 句'), t1.slice(0, 400));
// 2026-11-18 起（服务端在 stage-d 上改的）：重写的消息不再带「这次要的长短」那一句，最后一句写明再短也用 write
T.ok('消息里没有「这次要的长短」，最后一句说怎么写回（一条 write，card 填 2）', !t1.includes('这次要的长短')
  && t1.endsWith(`写回用 mcp__inkpad__ink_reply（submission="${r1 && r1.id}"）：一条 write（再短也用 write，不用 note），card 填 2，text 写重写后的整条回答；它接在那张卡片下面，不出新的圈号。`), t1.slice(-300));
T.ok('这一页纸上没变：没有新的圈号', (await writes()) === 2);
await T.saved();
await T.reload();
await noFlow();
await watchToasts();
C = await openBadge(w2.id);
T.ok('刷新后再打开：还是「已交」', Boolean(C) && C.shorter.text === '已交' && C.shorter.disabled, C);

// ================= 2. A 照说的回：接在卡片下面，不出新的圈号，钮恢复
const rep2 = await T.post('/bridge/reply', { sid: 'A', submission: r1.id, items: [{ type: 'write', card: 2, q: '再短点', text: '因为单价不变。' }] });
T.ok('（前提）收下了', rep2.ok === true, rep2);
T.ok('（前提）接到卡片下面', await T.waitFor(`(window.__ink.S.page.ai.find((o) => o.id === ${JSON.stringify(w2.id)}).more || []).length === 1`, 10000));
let a2 = await item(w2.id);
const seg2 = (a2.more || [])[0];
T.ok('接的那一段：新写的回答，记着是「再短点」、是 A 写的；AI 填的 q 不当成红字记', Boolean(seg2) && seg2.text === '因为单价不变。' && seg2.redo === 'brief' && !('q' in seg2)
  && seg2.author && seg2.author.sid === 'A', seg2);
T.ok('不出新的圈号', (await writes()) === 2);
C = await cardUp();
T.ok('卡片里看得到那一段，前面写「按「再短点」重写：」（不是「红字：」），钮恢复成「再短点」「展开讲」', Boolean(C) && C.segs.some((s) => s.text.includes('因为单价不变。') && s.mq === '按「再短点」重写：')
  && !C.body.includes('红字') && C.shorter.text === '再短点' && !C.shorter.disabled && !C.longer.disabled && !('ask' in a2), [C, a2.ask]);
await T.shot('c2-reply.png');
await js(`window.__ink.closeCard()`);

// ================= 3. 摊开的圈号 1：点开点「展开讲」；A 回的时候没写 card：服务补上，纸上摊的换成新的那一段
await waitPen();
const sp = w1.spread;
const [tx, ty] = await T.screenOf(sp.x + 20, sp.y + sp.rows[0].y + 14);
await T.fingerTapAt(tx, ty);
C = await cardUp();
T.ok('（前提）点摊开的字开了圈号 1 的卡片', Boolean(C) && C.id === w1.id && C.spread.text === '收起', C);
await T.tap('#acLonger');
const r3 = await T.waitSub('A', 40), t3 = r3 ? r3.text : '';
T.ok('点「展开讲」：A 收到，说是圈号 1 的「展开讲」（不带「这次要的长短」）', t3.startsWith('【草稿纸·重写】我在平板上点了圈号 1 那张卡片上的「展开讲」：请把这条回答展开讲')
  && !t3.includes('这次要的长短') && t3.includes('一条 write（再短也用 write，不用 note），card 填 1'), t3.slice(0, 300));
C = await cardUp();
T.ok('「展开讲」写「已交」', Boolean(C) && C.longer.text === '已交' && C.longer.sent, C);
const NEW = '九点出门比较稳：\n路上要一个小时，十点前能到；\n回来时避开晚高峰。';
const rep3 = await T.post('/bridge/reply', { sid: 'A', submission: r3.id, items: [{ type: 'write', q: '展开讲', text: NEW }] });
T.ok('（前提）收下了', rep3.ok === true, rep3);
T.ok('没写 card 也接到了圈号 1 的卡片下面', await T.waitFor(`(window.__ink.S.page.ai.find((o) => o.id === ${JSON.stringify(w1.id)}).more || []).length === 1`, 10000));
await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
T.ok('（前提）新的那一段写完了', await T.waitFor('window.__written', 20000));
const a1 = await item(w1.id), seg1 = (a1.more || [])[0];
T.ok('那一段记着是「展开讲」', Boolean(seg1) && seg1.redo === 'full' && seg1.text === NEW, seg1);
T.ok('纸上摊的换成新的那一段（三行），记着摊的是哪一段', Boolean(a1.spread) && a1.spread.rows.map((r) => r.t).join('|') === NEW.split('\n').join('|') && a1.spread.src === String(seg1.id), a1.spread);
const drawn = await js(`[...document.querySelectorAll('#aiRoot g.ai-open[data-id="${w1.id}"] > text')].map((t) => t.textContent).join('|')`);
T.ok('纸上画的是新的那三行', drawn === NEW.split('\n').join('|'), drawn);
T.ok('不出新的圈号', (await writes()) === 2);
await T.shot('c3-respread.png');
await js(`window.__ink.closeCard()`);

// ================= 3b. 「已交」
const askOf = async (id) => (await item(id) || {}).ask || null;
const reply = (sub, text, extra = {}) => T.post('/bridge/reply', { sid: 'A', submission: sub.id, items: [Object.assign({ type: 'write', card: 2, text }, extra)] });
const segsOf = async (id) => ((await item(id)) || {}).more || [];
// ① 连点两下（同一刻点两次，第一次的保存和请求都还没回来）：只交一份
C = await openAns(w2.id);
T.ok('（前提）打开了圈号 2 的卡片，两个钮能点', Boolean(C) && C.id === w2.id && !C.longer.disabled, C);
await js(`(() => { const b = document.querySelector('#acLonger'); b.click(); b.click(); return 1; })()`);
const d1 = await T.waitSub('A', 40);
await sleep(1200);
const d1b = await T.poll('A');
T.ok('连点两下「展开讲」：只交了一份', Boolean(d1) && !d1b, [d1 && d1.id, d1b && d1b.id]);
T.ok('点下去就写「已交」', ((await cardUp()) || {}).longer && (await cardUp()).longer.text === '已交', await cardUp());
await reply(d1, '展开讲的说法。');
T.ok('（前提）回应接上，钮恢复', await T.waitFor(`!(window.__ink.S.page.ai.find((o) => o.id === ${JSON.stringify(w2.id)}) || {}).ask`, 10000));
// ③ 到点恢复：卡片一直开着，也不用重新打开
const WAIT0 = await S('S.roundWait');
await S('(S.roundWait = 2500, 1)');
await T.tap('#acShorter');
const d2 = await T.waitSub('A', 40);
T.ok('（前提）点了「再短点」：已交', Boolean(d2) && (await cardUp()).shorter.text === '已交' && (await cardUp()).longer.disabled);
await sleep(3000);
C = await cardUp();
T.ok('到点（2.5 秒）没回：开着的卡片上两个钮恢复，能再点', Boolean(C) && C.id === w2.id && C.shorter.text === '再短点' && !C.shorter.disabled && !C.longer.disabled, C);
// ② 恢复后再点一次（新请求）：旧请求的回应先到，不清掉新请求的「已交」
await T.tap('#acShorter');
const d3 = await T.waitSub('A', 40);
const ask3 = await askOf(w2.id);
T.ok('（前提）又交了一份：「已交」记着新请求', Boolean(d3) && Boolean(ask3) && ask3.req === d3.id, [ask3, d3 && d3.id]);
await reply(d2, '旧请求的回应。');
T.ok('（前提）旧请求的回应接上了', await T.waitFor(`(window.__ink.S.page.ai.find((o) => o.id === ${JSON.stringify(w2.id)}).more || []).some((m) => m.text === '旧请求的回应。')`, 10000));
const ask3b = await askOf(w2.id);
C = await cardUp();
T.ok('旧请求的回应先到：新请求的「已交」还在', Boolean(ask3b) && ask3b.req === d3.id && Boolean(C) && C.shorter.text === '已交', [ask3b, C && C.shorter]);
await reply(d3, '新请求的回应。');
T.ok('新请求的回应到了：「已交」清掉', await T.waitFor(`!(window.__ink.S.page.ai.find((o) => o.id === ${JSON.stringify(w2.id)}) || {}).ask`, 10000));
await S(`(S.roundWait = ${WAIT0}, 1)`);
await js(`window.__ink.closeCard()`);
// ④ 交的时候（请求还没回来）翻到第 2 页：「已交」记在原来那一页（第 1 页）上、存回电脑，第 2 页不动
await js(`(() => { const f = window.fetch; window.__slowRedo = true;
  window.fetch = (u, o) => (String(u).includes('/api/redo') && window.__slowRedo ? new Promise((r) => setTimeout(r, 1500)).then(() => f(u, o)) : f(u, o)); return 1; })()`);
C = await openAns(w2.id);
await T.tap('#acShorter', 100);
await js(`window.__ink.openPage(1)`);
const d4 = await T.waitSub('A', 40);
await sleep(800);
await T.saved();
const f1 = T.pageFile('scratch', 0), f2 = T.pageFile('scratch', 1);
const onDisk = f1 && f1.ai.find((a) => a.id === w2.id);
T.ok('交的时候翻了页：第 1 页存回电脑的那一条记着「已交」和这次的请求', Boolean(d4) && Boolean(onDisk) && onDisk.ask && onDisk.ask.want === 'brief' && onDisk.ask.req === d4.id, [d4 && d4.id, onDisk && onDisk.ask]);
T.ok('第 2 页没被改动（没有长回答、没多东西）', !f2 || !(f2.ai || []).length, f2 && f2.ai);
await js(`(window.__slowRedo = false, 1)`);
await T.openPage(0);
await noFlow();
T.ok('翻回第 1 页：还是「已交」', Boolean(await askOf(w2.id)) && (await askOf(w2.id)).req === d4.id);
await reply(d4, '翻页时交的那份的回应。');
T.ok('它的回应到了：「已交」清掉', await T.waitFor(`!(window.__ink.S.page.ai.find((o) => o.id === ${JSON.stringify(w2.id)}) || {}).ask`, 10000));

// ================= 3c. 卡片上的红字随「AI」交出去了，又点了「再短点」：重写的回应先到，不算回应了那些红字
const penAt = async (pts, wait = 300) => {
  const base = { pointerType: 'pen', button: 'left' };
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: pts[0][0], y: pts[0][1], buttons: 1, clickCount: 1 }, base));
  for (const p of pts.slice(1)) await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: p[0], y: p[1], buttons: 1 }, base));
  const l = pts[pts.length - 1];
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: l[0], y: l[1], buttons: 0, clickCount: 1 }, base));
  await sleep(wait);
};
C = await openAns(w2.id);
await T.tool('red');
const body = await js(`(() => { const r = document.querySelector('#acBody').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })()`);
await penAt(Array.from({ length: 12 }, (_, i) => [body[0] + 30 + i * 8, body[1] + 30 + (i % 2)]));
await T.tool('pen');
const marks = ((await item(w2.id)).marks || []).filter((m) => !m.erasedAt);
T.ok('（前提）卡片上写了一笔红字', marks.length === 1, marks.length);
await js(`window.__ink.closeCard()`);
await T.tap('#check');
const dA = await T.waitSub('A', 40);
T.ok('（前提）点「AI」：红字随这次交给了 A', Boolean(dA) && T.metaOf(dA).kind !== 'redo' && ((await item(w2.id)).marks || []).some((m) => m.req === dA.id), dA && dA.id);
C = await openAns(w2.id);
await T.tap('#acShorter');
const dB = await T.waitSub('A', 40);
T.ok('（前提）又点「再短点」：A 收到重写的那一份', Boolean(dB) && T.metaOf(dB).kind === 'redo');
const n0 = (await segsOf(w2.id)).length;
await reply(dB, '重写的回应先到。');
T.ok('（前提）重写的回应接上了', await T.waitFor(`(window.__ink.S.page.ai.find((o) => o.id === ${JSON.stringify(w2.id)}).more || []).length === ${n0 + 1}`, 10000));
let segs = await segsOf(w2.id);
T.ok('重写的那一段不算回应了卡片上的红字（on 是空的）', segs[n0].redo === 'brief' && Array.isArray(segs[n0].on) && segs[n0].on.length === 0, segs[n0]);
await reply(dA, '回应你写在卡片上的红字。', { q: '红字那句' });
T.ok('（前提）那次「AI」的回应接上了', await T.waitFor(`(window.__ink.S.page.ai.find((o) => o.id === ${JSON.stringify(w2.id)}).more || []).length === ${n0 + 2}`, 10000));
segs = await segsOf(w2.id);
T.ok('那次「AI」的回应才算回应了那笔红字', !segs[n0 + 1].redo && (segs[n0 + 1].on || []).includes(marks[0].id), segs[n0 + 1]);
await js(`window.__ink.closeCard()`);

// ================= 4. 写它的对话不在了：先选对话，再交
await T.post('/bridge/hello', { sid: 'C', label: 'old', cwd: OLD });
await T.apiJson('/api/notebook/target', { method: 'POST', body: JSON.stringify({ nb: 'scratch', sid: 'C' }) });
await T.reload();
await noFlow();
await T.tool('red');
await T.pen(T.line(120, 900, 260));
await T.tool('pen');
await T.tap('#check');
const sub4 = await T.waitSub('C', 60);
T.ok('（前提）交给了 C', Boolean(sub4), sub4);
await T.post('/bridge/reply', { sid: 'C', submission: sub4.id, items: [{ type: 'write', anchor: 'g1', q: '要带什么？', text: LONG, fold: true }] });
T.ok('（前提）C 的回答落下（圈号 3）', await landed(3));
const w3 = (await S(`JSON.parse(JSON.stringify(S.page.ai.filter((a) => a.type === 'write')))`)).find((a) => a.n === 3);
T.ok('（前提）圈号 3 是 C 写的', Boolean(w3) && w3.author.sid === 'C', w3 && w3.author);
await T.saved();
await sleep(21500); // C 不再来：过了 20 秒就当对话已关
await T.reload();
await noFlow();
await watchToasts();
T.ok('（前提）平板上的对话里没有 C 了', !(await S(`(S.sessions || []).some((s) => s.sid === 'C')`)) && (await S(`(S.sessions || []).length`)) === 2, await S('S.sessions'));
C = await openBadge(w3.id);
T.ok('（前提）圈号 3 的卡片开了', Boolean(C) && C.id === w3.id, C);
await T.tap('#acShorter');
T.ok('写它的对话不在了、这本发往的也不在了：先弹出选对话的单子', await T.visible('#targetPick'), await T.text('#targetPickHead'));
T.ok('还没交出去（钮没写「已交」）', !(await item(w3.id)).ask);
await T.shot('c4-pick.png');
await T.tap('#targetPickList button[data-sid=B]', 800);
const r4 = await T.waitSub('B', 40), t4 = r4 ? r4.text : '';
T.ok('选了 B：B 收到，说点了圈号 3 的「再短点」', t4.startsWith('【草稿纸·重写】我在平板上点了圈号 3 那张卡片上的「再短点」'), t4.slice(0, 200));
T.ok('消息里说这条是「old」的对话写的（不是你），附原文', t4.includes('这条回答是「old」的对话写的（不是你）') && t4.includes('原来的回答（问：要带什么？）'), t4.slice(0, 500));
T.ok('上方说请了 B', (await toasts()).includes('已请「idea」把圈号 3 写短一点'), await toasts());
T.ok('圈号 3 记着交了（「已交」）', Boolean((await item(w3.id)).ask) && (await item(w3.id)).ask.want === 'brief');

await T.finish();

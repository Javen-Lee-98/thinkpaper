// 在导入的 PDF 上追问右栏的短批注。太宽的一组按普通红笔交，靠近蓝字的一组写明所批的那句话。
// 长回答在红字旁出自己的圈号；再查英文界面、连续模式的相邻页、存盘、撤销和橡皮。
// 只在无头 Edge 里跑过；笔是 pointerType 为 pen 的鼠标事件，手指是 CDP 的触摸事件。
// 跑法：node tests/run_browser.mjs <临时目录> --only note_followup_book；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'note-followup-book', query: '&lang=en' });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const waitPen = () => sleep(1150);
const hline = (x0, y, len, n = 14) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 0.6]);
const CJK = /[㐀-鿿＀-￯　-〿]/;
async function landed(n) {
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
const noteOf = (text) => js(`(() => { const S = window.__ink.S, a = S.page.ai.find((o) => o.text === ${JSON.stringify(text)} && o.type !== 'write'); if (!a) return null;
  const g = document.querySelector('#aiRoot g[data-id="' + a.id + '"]');
  const lines = g ? [...g.querySelectorAll('text:not(.adopt-star)')].map((t) => { const r = t.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, s: t.textContent }; }) : [];
  return { id: a.id, type: a.type, lay: a.lay, box: a.box, lines, s: S.view.s }; })()`);
const item = (id) => S(`(() => { const a = S.page.ai.find((o) => o.id === ${JSON.stringify(id)}); return a ? JSON.parse(JSON.stringify(a)) : null; })()`);
const badge = (id) => js(`(() => { const g = [...document.querySelectorAll('#aiRoot .badge')].find((x) => !x.classList.contains('nbr-badge') && x.dataset.id === ${JSON.stringify(id)}); if (!g) return null;
  const r = g.querySelector('circle').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, dot: Boolean(g.querySelector('.bdot')), seen: g.classList.contains('seen') }; })()`);
const openBadge = async (id) => { await waitPen(); const b = await badge(id); if (b) await T.fingerTapAt(b.cx, b.cy); };
const closeCardByTap = async () => { await waitPen(); const [x, y] = await T.screenOf(500, 900); await T.fingerTapAt(x, y); };
const strokeScreen = async (st) => { const xs = st.pts.map((p) => p[0]), ys = st.pts.map((p) => p[1]);
  const [l, t] = await T.screenOf(Math.min(...xs), Math.min(...ys)), [r, b] = await T.screenOf(Math.max(...xs), Math.max(...ys)); return { l, t, r, b }; };
const relTo = (m, line, s) => [(m.l - line.l) / s, (m.t - line.t) / s, (m.r - line.l) / s, (m.b - line.t) / s];
const near = (a, b, d) => Boolean(a && b) && a.every((v, i) => Math.abs(v - b[i]) <= d);
await js(`(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (!t.hidden) window.__toasts.push(t.textContent); })
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true, attributes: true }); return 1; })()`);

// ---- 两页的 PDF（1000 宽，纸上的坐标和 PDF 的坐标一样）：买菜清单、周末野餐
const SRC = join(T.ROOT, 'src'), PDF = join(SRC, 'weekend.pdf');
mkdirSync(SRC, { recursive: true });
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
doc=fitz.open()
p=doc.new_page(width=1000,height=1300)
p.insert_text((60,120),'Shopping list for Saturday',fontsize=36)
p.insert_text((60,200),'apples, milk, bread, eggs',fontsize=30)
p.insert_text((60,300),'Picnic at the lake on Sunday',fontsize=34)
q=doc.new_page(width=1000,height=1300)
q.insert_text((60,120),'Packing list: tent, water, snacks',fontsize=34)
doc.save(sys.argv[1])`, PDF]);
const imp = await T.post('/bridge/import', { sid: 'S1', path: PDF });
await T.openNotebook(imp.id, 0);
T.ok('（前提）导入了两页的书，连续模式，英文界面', Boolean(imp.id) && (await S('S.flow')) && (await S('S.nb.pages')) === 2 && (await S('Boolean(S.bgImg)')) && (await js('window.InkLang.lang')) === 'en',
  [imp, await S('S.flow')]);

// ================= 0. 第 1 页：红笔划在 apples, milk 下面，交上去；Claude 回两条短批注：一条指着这句红笔，一条指着印刷的 Picnic 那一行（box）
await T.tool('red');
await T.pen(T.line(60, 212, 240));
await T.tool('pen');
await T.saved();
await T.tap('#check');
const sub1 = await T.waitSub('S1', 80), meta1 = sub1 && T.metaOf(sub1);
T.ok('（前提）交上去了：一句红笔', Boolean(meta1) && meta1.groups.length === 1 && meta1.groups[0].red, meta1 && meta1.groups);
const c = meta1.crop, px = (b) => [(b[0] - c.x0) * c.scale, (b[1] - c.y0) * c.scale, (b[2] - c.x0) * c.scale, (b[3] - c.y0) * c.scale];
const NA = 'Milk: get two cartons.', NB = 'Bring a blanket, two bottles of water and some fruit for everyone.';
await T.post('/bridge/reply', { sid: 'S1', submission: sub1.id, items: [{ type: 'note', anchor: 'g1', text: NA }, { type: 'note', box: px([55, 268, 520, 310]), text: NB }] });
T.ok('（前提）两条短批注落在右边一栏、写完了', await landed(2));
await sleep(300);
let nB = await noteOf(NB);
const nA = await noteOf(NA);
T.ok('（前提）书页开出了右边一栏，两条批注都在栏里；指着印刷文字的那条有好几行、没指着笔迹', Boolean(nA && nB) && nB.lay.x > 1000 && nA.lay.x > 1000 && nB.lay.lines.length >= 2 && !(await item(nB.id)).on
  && (await S('S.M')) > 0, nB && [nB.lay, nB.box]);

// ================= 1. 拉得很远：指着印刷文字的那条上写红字，一笔压在第一行几个词下面，同一口气往左写出很长一笔（写到了正文上）。
//    这一组伸进正文太远，按普通问题交；两笔仍在同一组
const L = nB.lay;
await T.tool('red');
await T.pen(hline(L.x + 4, L.y + L.fs + 5, 120));
await T.pen(hline(L.x - 20, L.y + L.fs + 20, -400, 20));
const far = await S(`S.page.strokes.filter((s) => s.c === 'r').slice(-2).map((s) => s.id)`);
await T.tool('pen');
await T.saved();
await T.tap('#check');
const sub2a = await T.waitSub('S1', 80), meta2a = sub2a && T.metaOf(sub2a);
T.ok('拉得很远：点「AI」后那条批注照旧在纸上（没变卡片），投递里没有卡片', Boolean(meta2a) && !meta2a.cards && (await item(nB.id)).type === 'note' && (await noteOf(NB)).lines.length === L.lines.length,
  [meta2a && meta2a.cards, (await item(nB.id)).type]);
T.ok('那两笔还在纸上，作为一组普通的红笔交上去了（整组，没拆开）', (await S(`${JSON.stringify(far)}.every((id) => S.page.strokes.some((s) => s.id === id && !s.erasedAt))`))
  && Boolean(meta2a) && meta2a.groups.some((g) => g.red && !g.answered && !g.note_on && g.ids.length === far.length && far.every((id) => g.ids.includes(id))
    && sub2a.text.split('\n').some((l) => l.startsWith(g.id + '｜') && l.includes('｜红笔（问题）'))), meta2a && meta2a.groups.map((g) => [g.id, g.red, g.ids]));
const toasts1 = await js('window.__toasts.slice()');
T.ok('英文界面：交上去的提示是英文', toasts1.some((t) => t.startsWith('Handed to')) && !toasts1.some((t) => CJK.test(t)), toasts1);

// ================= 1b. 写出框一点（往左写出约一百多个单位）：仍算对右栏这条蓝字的追问
nB = await noteOf(NB);
const sP = nB.s, line0P = nB.lines[0], twMax = Math.max(...nB.lines.map((l) => (l.r - l.l) / sP));
const reach = Math.max(60, Math.round(440 - twMax)); // 蓝字和这组红字合起来约 470 宽，还在算作追问的范围内
await T.tool('red');
await T.pen(hline(L.x + 4, L.y + L.fs + L.lh + 5, 100)); // 压着第二行的下沿
await T.pen(hline(L.x - 20, L.y + L.fs + L.lh + 18, -reach, 12)); // 同一口气往左写出框
const reds = await S(`S.page.strokes.filter((s) => s.c === 'r').slice(-2).map((s) => JSON.parse(JSON.stringify(s)))`);
await T.tool('pen');
await T.saved();
const relP = await Promise.all(reds.map(async (st) => relTo(await strokeScreen(st), line0P, sP)));
await js('(window.__toasts = [], 1)');
await T.tap('#check');
const sub2 = await T.waitSub('S1', 80), meta2 = sub2 && T.metaOf(sub2);
const ids = reds.map((s) => s.id), on = meta2?.groups.find((g) => g.ids.includes(ids[0]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
T.ok('写出框一点的两笔同组；消息在这组写明它批的是哪条蓝字', on?.red && !on.answered && on.note_on === NB && same(on.ids, ids)
  && sub2.text.split('\n').some((l) => l.startsWith(on.id + '｜') && l.includes('写在蓝字批注「' + NB.slice(0, 16) + '…」上')), on);
const after = await noteOf(NB), active = await S(`S.page.strokes.filter((s) => !s.erasedAt)`);
T.ok('蓝字仍在右栏原处，指向原来那行印刷文字，没有圈号或卡片图', after?.id === nB.id && same(after.box, nB.box)
  && same(after.lay, L) && same(after.lines.map((l) => l.s), L.lines) && !(await badge(nB.id)) && !meta2.cards);
T.ok('两组红字仍在纸上，写出框的一笔也完整保留', far.every((id) => active.some((s) => s.id === id))
  && reds.every((st) => same(active.find((s) => s.id === st.id)?.pts, st.pts)));
const relAfter = await Promise.all(reds.map(async (st) => relTo(await strokeScreen(st), after.lines[0], after.s)));
T.ok('两笔红字相对右栏第一行的位置没变', relAfter.every((r, i) => near(r, relP[i], 2.5)), [relP, relAfter]);
await waitPen();
const first = after.lines[0];
await T.fingerTapAt((first.l + first.r) / 2, (first.t + first.b) / 2);
T.ok('书页右栏点短批注没有收成蓝点的入口', await js(`document.querySelector('#answerCard').hidden`));

// 书页上的长回答有自己的圈号，打开后照英文界面显示。
await js('(window.__toasts = [], 1)');
const answer = 'The grass by the lake is often wet in the morning.';
await T.post('/bridge/reply', { sid: 'S1', submission: sub2.id, items: [{ type: 'write', anchor: on.id, q: 'Why a blanket?', text: answer }] });
T.ok('长回答落在书页上了', await landed(3));
const reply = await S(`S.page.ai.find((a) => a.text === ${JSON.stringify(answer)})`);
T.ok('长回答在红字旁出自己的圈号，原批注仍在右栏', reply?.type === 'write' && reply.id !== nB.id && Boolean(await badge(reply.id)) && !reply.from
  && same(reply.on, ids) && reply.at[0] >= on.bbox[0] && reply.at[0] <= on.bbox[2] + 300
  && Math.abs(reply.at[1] - on.bbox[3]) < 300 && (await noteOf(NB))?.id === nB.id, reply);
const toasts3 = await js('window.__toasts.slice()');
T.ok('屏幕上方的提示是英文（Claude replied with 1 answer）', toasts3.includes('Claude replied with 1 answer'), toasts3);
await openBadge(reply.id);
const cardText = await js(`document.querySelector('#answerCard').innerText`);
T.ok('卡片里有英文问题和回答，整张卡片没有中文', cardText.includes('Why a blanket?') && cardText.includes('Q:') && cardText.replace(/\s+/g, ' ').includes(answer) && !CJK.test(cardText), cardText);
console.error('截图：' + await T.shot('6-book-card.png'));
await closeCardByTap();

// ================= 4. 连续模式下几页一起交：第 1 页另一条批注上写红字，翻到第 2 页写字、点「AI」
const nA2 = await noteOf(NA);
await T.tool('red');
await T.pen(hline(nA2.lay.x + 4, nA2.lay.y + nA2.lay.fs + 5, 90));
const mkA = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tool('pen');
await T.saved();
await T.openPage(1);
T.ok('（前提）翻到了第 2 页，第 1 页在相邻页的缓存里', (await S('S.idx')) === 1 && (await S('S.flowCache.has(0)')));
await T.pen(T.line(120, 600, 200));
await T.saved();
await js('(window.__toasts = [], 1)');
await T.tap('#check');
const sub3 = await T.waitSub('S1', 80), meta3 = sub3 && T.metaOf(sub3);
T.ok('几页一起交：两页都在', Boolean(meta3) && meta3.kind === 'scan' && Boolean(meta3.pages['1']) && Boolean(meta3.pages['2']), meta3 && Object.keys(meta3.pages || {}));
const gid = Object.keys(meta3?.pages?.['1']?.gx || {}).find((k) => meta3.pages['1'].gx[k].ids.includes(mkA));
T.ok('整本消息标明第 1 页这组红字写在买牛奶的批注上', gid && sub3.text.split('\n').some((l) => l.includes(gid + '｜') && l.includes('写在蓝字批注「' + NA.slice(0, 16) + '…」上')));
const cached = await S(`S.flowCache.get(0).page`);
const disk = await T.apiJson(`/api/page?nb=${encodeURIComponent(imp.id)}&i=0`);
function stillOnPage(page) {
  const a = page.ai.find((o) => o.id === nA.id);
  return a?.type === 'note' && !a.dot && same(a.lay, nA.lay) && page.strokes.some((s) => s.id === mkA && !s.erasedAt);
}
T.ok('相邻页的缓存里，原处有蓝字，红笔仍是纸上的一笔', stillOnPage(cached));
T.ok('电脑上第 1 页也存着同样的蓝字和红笔', stillOnPage(disk));
const toasts4 = await js('window.__toasts.slice()');
T.ok('英文界面：几页一起交的提示是英文', toasts4.length > 0 && !toasts4.some((t) => CJK.test(t)), toasts4);
await T.openPage(0);
T.ok('翻回第 1 页，右栏批注仍指着原来的笔迹，红笔也在', (await noteOf(NA))?.lines.length === nA.lines.length
  && same((await item(nA.id)).on, meta1.groups[0].ids) && stillOnPage(await S('S.page')));

// 撤销纸上那笔红字，再擦右栏的批注。
await T.tap('#toolsUndo');
T.ok('撤销只撤掉写在蓝字上的那一笔，右栏的字还在', !(await S(`S.page.strokes.some((s) => s.id === ${JSON.stringify(mkA)} && !s.erasedAt)`))
  && (await noteOf(NA))?.lines.length === nA.lines.length);
await T.tool('eraser');
await T.pen(hline(nA.lay.x + 4, nA.lay.y + nA.lay.fs / 2, 15));
T.ok('橡皮擦掉右栏的批注，字不再画出来', Boolean((await item(nA.id)).erasedAt) && !(await noteOf(NA)).lines.length);
await T.tap('#toolsUndo');
T.ok('撤销后，找回原处的几行蓝字', !(await item(nA.id)).erasedAt && same((await noteOf(NA)).lines.map((l) => l.s), nA.lay.lines));
await T.tool('pen');

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

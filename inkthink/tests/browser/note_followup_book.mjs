// 纸上的短批注上写红字（2026-11-14，细节暂定）：书页上（导入的 PDF，批注排在页面右边一栏）、连续模式、英文界面。查：
// 1. 指着印刷文字（box）的一条短批注上写红字，同一口气往左写出很长一笔（写到了正文上）：带上它卡片要缩到 0.8 以下，
//    这一组整组不算——批注不变，那两笔照旧作为一组普通的红笔交上去（2026-11-14 第二轮暂定）。
//    再写一组只往左写出一百多个单位的：点「AI」收成圈号，圈号在所指那块印刷文字的右边；卡片缩到 0.8–1 之间，
//    红字一笔不少、都在卡片里，相对它压着的字的位置和纸上一样；投递里有这张卡片。
// 2. Claude 用 write + card 回：英文界面里屏幕上方的提示、卡片里「红字：」那一行都是英文；卡片里没有中文（这一页的内容都是英文）。
// 3. 连续模式下几页一起交：第 1 页另一条批注上写了红字，翻到第 2 页写字、点「AI」——第 1 页（手上缓存着的相邻页）那条也先变成卡片、
//    存到电脑上，整本消息里有它；相邻页的缓存里是新的样子；翻回第 1 页圈号在、红点没了。
// 只在无头 Edge 里跑过；笔是 pointerType 为 pen 的鼠标事件，手指是 CDP 的触摸事件。
// 跑法：node tests/run_browser.mjs <临时目录> --only note_followup_book；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
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
const card = () => js(`(() => { const c = document.querySelector('#answerCard'); if (c.hidden) return null; const r = c.getBoundingClientRect(), S = window.__ink.S, a = window.__ink.cardItem();
  const R = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  const pg = document.querySelector('#acPage').getBoundingClientRect(), sz = document.querySelector('#acSizer').getBoundingClientRect();
  return { id: S.card && S.card.id, l: r.left, t: r.top, r: r.right, b: r.bottom, k: S.card && S.card.k, u: a && a.fromMap ? a.fromMap.u : null, text: c.innerText,
    page: { l: pg.left, t: pg.top, r: pg.right, b: pg.top + sz.height },
    lines: [...document.querySelectorAll('#acBody .ac-note text')].map((t) => Object.assign(R(t), { s: t.textContent })),
    marks: [...document.querySelectorAll('#acInk path:not(.live), #acInk circle:not(.live)')].map((p) => Object.assign(R(p), { id: p.dataset.id })),
    segs: [...document.querySelectorAll('#acMore .ac-seg')].map((d) => ({ mq: (d.querySelector('.ac-mq') || {}).textContent || null, text: d.querySelector('.ac-mbody').textContent })) }; })()`);
const openBadge = async (id) => { await waitPen(); const b = await badge(id); if (!b) return null; await T.fingerTapAt(b.cx, b.cy); return card(); };
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
//    带上这一组，卡片要缩到一半左右才放得下（u < 0.8）：这一组整组不算冲着这条批注，批注不变，那两笔照旧是普通的红笔交上去
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
  && Boolean(meta2a) && meta2a.groups.some((g) => g.red && !g.answered && far.every((id) => g.ids.includes(id))), meta2a && meta2a.groups.map((g) => [g.id, g.red, g.ids]));
const toasts1 = await js('window.__toasts.slice()');
T.ok('英文界面：交上去的提示是英文', toasts1.some((t) => t.startsWith('Handed to')) && !toasts1.some((t) => CJK.test(t)), toasts1);

// ================= 1b. 写出框一点（往左写出约一百多个单位）：带上这一组卡片缩到 0.8–1 之间，照常收成圈号 1 的卡片
nB = await noteOf(NB);
const sP = nB.s, line0P = nB.lines[0], twMax = Math.max(...nB.lines.map((l) => (l.r - l.l) / sP));
const reach = Math.max(60, Math.round(440 - twMax)); // 让这一块约 470 宽：u ≈ 0.87
await T.tool('red');
await T.pen(hline(L.x + 4, L.y + L.fs + L.lh + 5, 100)); // 压着第二行的下沿
await T.pen(hline(L.x - 20, L.y + L.fs + L.lh + 18, -reach, 12)); // 同一口气往左写出框
const reds = await S(`S.page.strokes.filter((s) => s.c === 'r').slice(-2).map((s) => JSON.parse(JSON.stringify(s)))`);
await T.tool('pen');
await T.saved();
const relP = await Promise.all(reds.map(async (st) => relTo(await strokeScreen(st), line0P, sP)));
await js('(window.__toasts = [], 1)');
await T.tap('#check');
const sub2 = await T.waitSub('S1', 80), meta2 = sub2 && T.metaOf(sub2), c2 = meta2 && (meta2.cards || [])[0];
let wB = await item(nB.id);
T.ok('点「AI」：那条批注收成了圈号 1 的卡片，只带进这一组的两笔（上一轮拉得很远的那两笔交过了、还在纸上）', Boolean(wB) && wB.type === 'write' && wB.n === 1
  && wB.marks.map((m) => m.id).join() === reds.map((s) => s.id).join() && !(await S(`S.page.strokes.some((s) => ${JSON.stringify(reds.map((s) => s.id))}.includes(s.id))`))
  && (await S(`${JSON.stringify(far)}.every((id) => S.page.strokes.some((s) => s.id === id))`)), wB);
T.ok('写出框一点：卡片缩到 0.8–1 之间（u < 0.95，确实缩了），换算后的红字都在卡片的固定宽度里', Boolean(wB) && wB.fromMap.u >= 0.8 && wB.fromMap.u < 0.95
  && wB.marks.every((m) => m.pts.every((p) => p[0] >= 16 && p[0] <= 424 && p[1] >= 0)), wB && [wB.fromMap, twMax, reach]);
const box = wB.from.box;
T.ok('指着印刷文字：圈号在那块印刷文字的右边、那一行的高度', Boolean(wB) && wB.at[0] > box[2] + 10 && wB.at[0] < box[2] + 70 && Math.abs(wB.at[1] - (box[1] + box[3]) / 2) < 10, [wB.at, box]);
T.ok('投递里有这张卡片（原来是短批注、两笔红字）', Boolean(c2) && c2.note === true && c2.n === 1 && c2.marks.length === 2 && existsSync(c2.img), meta2 && meta2.cards);

// ================= 2. 点开卡片：最上面是原来那几行；两笔红字都在卡片里，相对它压着的字和纸上一样（整体缩小了一点）
let C = await openBadge(nB.id);
T.ok('点开卡片：最上面是原来那几行（同样换行）', Boolean(C) && C.lines.map((l) => l.s).join('|') === L.lines.join('|'), C && C.lines.map((l) => l.s));
const kU = C ? C.k * C.u : 1;
const relC = C ? reds.map((st) => { const m = C.marks.find((x) => x.id === st.id); return m && relTo(m, C.lines[0], kU); }) : [];
T.ok('两笔红字相对第一行字的位置和纸上一样（页面单位；缩小了，差不到 2.5）', relC.length === 2 && relC.every((r, i) => near(r, relP[i], 2.5)), [relP, relC]);
console.error(`  （量到的偏差，页面单位：${relC.map((r, i) => (r ? Math.max(...r.map((v, j) => Math.abs(v - relP[i][j]))).toFixed(2) : '?')).join('、')}；k=${C && C.k.toFixed(3)}，u=${C && C.u}）`);
T.ok('写出框的那一笔完整显示在卡片里（左右都没被裁掉）', Boolean(C) && C.marks.every((m) => m.l >= C.l + 1 && m.r <= C.r - 1 && m.t >= C.page.t && m.b <= C.page.b), C && [C.marks, C.l, C.r]);
console.error('截图：' + await T.shot('6-book-card.png'));
await closeCardByTap();

// ================= 3. Claude 用 write + card 回：英文界面里提示和「红字：」那一行都是英文
await js('(window.__toasts = [], 1)');
await T.post('/bridge/reply', { sid: 'S1', submission: sub2.id, items: [{ type: 'write', card: 1, q: 'Why a blanket?', text: 'The grass by the lake is often wet in the morning.' }] });
T.ok('回应接在这张卡片下面', await T.waitFor(`(window.__ink.S.page.ai.find((a) => a.n === 1).more || []).length === 1`, 10000));
await sleep(500);
const toasts3 = await js('window.__toasts.slice()');
T.ok('屏幕上方的提示是英文（Claude replied with 1 answer）', toasts3.includes('Claude replied with 1 answer'), toasts3);
C = await openBadge(nB.id);
T.ok('卡片里接着的一段前面写着「Your red note: Why a blanket?」，整张卡片没有中文', Boolean(C && C.segs[0]) && C.segs[0].mq === 'Your red note: Why a blanket?' && !CJK.test(C.text), C && [C.segs, C.text]);
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
T.ok('整本消息里第 1 页那条批注已经是圈号 2 的卡片（原来是短批注、带上 page=1）', Boolean(sub3) && sub3.text.includes('圈号 2 的卡片原来是你写在纸上的一条短批注') && sub3.text.includes('card 填 2（再带上 page=1）'),
  sub3 && sub3.text.slice(0, 1200));
const cachedA = await S(`(() => { const e = S.flowCache.get(0); const a = e && e.page.ai.find((o) => o.id === ${JSON.stringify(nA.id)}); return a ? { type: a.type, n: a.n, marks: (a.marks || []).map((m) => m.id) } : null; })()`);
T.ok('相邻页的缓存里也是新的样子（圈号 2，红字在卡片上）', Boolean(cachedA) && cachedA.type === 'write' && cachedA.n === 2 && cachedA.marks.join() === mkA, cachedA);
const disk = await T.apiJson(`/api/page?nb=${encodeURIComponent(imp.id)}&i=0`);
const dA = disk.ai.find((a) => a.id === nA.id);
T.ok('电脑上第 1 页存的也是新的样子；纸上没有那一笔了', Boolean(dA) && dA.type === 'write' && dA.from.type === 'note' && !disk.strokes.some((s) => s.id === mkA), dA);
const toasts4 = await js('window.__toasts.slice()');
T.ok('英文界面：几页一起交的提示是英文', toasts4.length > 0 && !toasts4.some((t) => CJK.test(t)), toasts4);
await T.openPage(0);
T.ok('翻回第 1 页：圈号 2 在、圈在所指那句红笔的右边，红点没了（记下交过了）', await T.waitFor(`(() => { const a = window.__ink.S.page.ai.find((o) => o.n === 2); const g = a && document.querySelector('#aiRoot .badge[data-id="' + a.id + '"]');
  return g && !g.querySelector('.bdot') && a.at[0] > 300 && a.at[0] < 370 && Math.abs(a.at[1] - 212) < 10 && a.marks.every((m) => m.req === ${JSON.stringify(sub3 && sub3.id)}); })()`, 8000), await item(nA.id));

// ================= 5. 撤销、橡皮：这一页最近一步是写在那条批注上的那一笔（交的时候挪进了卡片）——撤销把它从卡片上撤掉（说一句）；
//    橡皮碰到收成的圈号＝擦掉这一整条，撤销能找回
await js('(window.__toasts = [], 1)');
await T.tap('#toolsUndo');
await sleep(300);
T.ok('撤销：那一笔从卡片上撤掉了（卡片还在），屏幕上方说的是英文「Undid red ink on an answer card」', (await item(nA.id)).type === 'write' && (await item(nA.id)).marks.length === 0
  && (await js('window.__toasts.slice()')).includes('Undid red ink on an answer card'), [(await item(nA.id)).marks, await js('window.__toasts.slice()')]);
const atA = (await item(nA.id)).at;
await T.tool('eraser');
await T.pen([[atA[0] - 2, atA[1]], [atA[0] + 2, atA[1] + 1]]);
T.ok('橡皮碰到收成的圈号：这一整条擦掉了（圈号不画了）', Boolean((await item(nA.id)).erasedAt) && !(await badge(nA.id)));
await T.tap('#toolsUndo');
await sleep(300);
T.ok('撤销：找回来了（圈号又在）', !(await item(nA.id)).erasedAt && Boolean(await badge(nA.id)));
await T.tool('pen');

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

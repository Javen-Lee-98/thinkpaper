// 红笔在短批注上追问：查交稿前后、回应和刷新后，原来的蓝字和红笔仍在原处。
// 还查红笔压到两条、写出批注很远、撤销和擦除、交稿失败再交，以及翻页后几页一起交。
// 笔是 pointerType 为 pen 的鼠标事件，手指是 CDP 的触摸事件；只在无头 Edge 里跑过。
// 跑法：node tests/run_browser.mjs <临时目录> --only note_followup；有一项不对退出码 1。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'note-followup', pages: 2 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
// ---- 小工具
const hline = (x0, y, len, n = 14) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 0.6]);
const seg = (pts, n = 8) => pts.slice(1).flatMap((b, k) => Array.from({ length: n }, (_, i) => [pts[k][0] + ((b[0] - pts[k][0]) * i) / n, pts[k][1] + ((b[1] - pts[k][1]) * i) / n])).concat([pts[pts.length - 1]]);
const star = (cx, cy, R = 22) => seg(Array.from({ length: 6 }, (_, k) => { const t = -Math.PI / 2 + (k * 4 * Math.PI) / 5; return [cx + R * Math.cos(t), cy + R * Math.sin(t)]; }), 10);
async function landed(n) { // 等写回的批注落到这一页（一共 n 条），并且一条条写完
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
// 一条短批注（纸上的，不是收成的卡片）：数据和纸上画出来的每一行字（屏幕上的框）
const noteOf = (text) => js(`(() => { const S = window.__ink.S, a = S.page.ai.find((o) => o.text === ${JSON.stringify(text)} && o.type !== 'write'); if (!a) return null;
  const g = document.querySelector('#aiRoot g[data-id="' + a.id + '"]');
  const lines = g ? [...g.querySelectorAll('text:not(.adopt-star)')].map((t) => { const r = t.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, s: t.textContent }; }) : [];
  return { id: a.id, type: a.type, lay: a.lay, adopted: Boolean(a.adopted), lines, s: S.view.s, drawn: Boolean(g) }; })()`);
const item = (id) => S(`(() => { const a = S.page.ai.find((o) => o.id === ${JSON.stringify(id)}); return a ? JSON.parse(JSON.stringify(a)) : null; })()`);
const noBadge = () => js(`!document.querySelector('#aiRoot > .badge')`);
const liveStrokes = () => S(`S.page.strokes.filter((s) => !s.erasedAt)`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const groupOf = (meta, id) => meta?.groups?.find((g) => g.ids.includes(id));
// 同一组在投递数据和给 AI 看的那一行里都要指向同一条批注。
function labeled(sub, g, words) {
  if (!g?.red || g.answered || g.note_on !== words) return false;
  const head = words.length > 16 ? words.slice(0, 16) + '…' : words;
  return sub.text.split('\n').some((l) => l.includes(g.id + '｜') && l.includes('｜红笔（问题，写在蓝字批注「' + head + '」上）'));
}
// 一笔在屏幕上的框（按笔迹的点，不算笔画粗细）
const strokeScreen = async (st) => { const xs = st.pts.map((p) => p[0]), ys = st.pts.map((p) => p[1]);
  const [l, t] = await T.screenOf(Math.min(...xs), Math.min(...ys)), [r, b] = await T.screenOf(Math.max(...xs), Math.max(...ys)); return { l, t, r, b }; };
// 一笔相对一行字的位置，换成页面单位（s：屏幕上一个页面单位多少像素）
const relTo = (m, line, s) => [(m.l - line.l) / s, (m.t - line.t) / s, (m.r - line.l) / s, (m.b - line.t) / s];
const near = (a, b, d) => Boolean(a && b) && a.every((v, i) => Math.abs(v - b[i]) <= d);
const toastText = () => js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
const installLog = () => js(`(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (!t.hidden) window.__toasts.push(t.textContent); })
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true, attributes: true });
  return 1; })()`);
const resetLog = () => js(`(window.__toasts = [], 1)`);
// 截一块屏幕（放大 2 倍）：x、y、w、h 是屏幕像素
const clipShot = async (file, x, y, w, h) => {
  const z = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, x), y: Math.max(0, y), width: w, height: h, scale: 2 } });
  writeFileSync(join(T.OUT, file), Buffer.from(z.data, 'base64'));
  return join(T.OUT, file);
};
// 在交出去的整页图里数蓝字或红字的像素。框用页面坐标，按投递记录换算。
function inkInCrop(file, crop, areas) {
  const boxes = areas.map((b) => b.map((v, i) => Math.round((v - (i % 2 ? crop.y0 : crop.x0)) * crop.scale)));
  const src = 'data:image/jpeg;base64,' + readFileSync(file).toString('base64');
  return js(`new Promise((resolve, reject) => {
    const im = new Image();
    im.onerror = () => reject(new Error('打开交出去的整页图失败'));
    im.onload = () => {
      const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
      const ctx = cv.getContext('2d'); ctx.drawImage(im, 0, 0);
      resolve(${JSON.stringify(boxes)}.map(([x0, y0, x1, y1]) => {
        const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
        let blue = 0, red = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 2] - d[i] > 50 && d[i + 2] > 90) blue++;
          if (d[i] > 150 && d[i + 1] < 130 && d[i + 2] < 130) red++;
        }
        return { blue, red };
      }));
    };
    im.src = ${JSON.stringify(src)};
  })`);
}
await installLog();
const SHOTS = [];
// 拦请求（Fetch.enable 时才拦）：failIf(请求) 为真的让它连不上，其余照常放行
let failIf = null;
T.onCdp('Fetch.requestPaused', (p) => {
  if (failIf && failIf(p.request)) T.cdp('Fetch.failRequest', { requestId: p.requestId, errorReason: 'InternetDisconnected' }).catch(() => {});
  else T.cdp('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
});

// ================= 0. 单页；第 1 页三句红笔问题，交上去；Claude 回三条短批注（第一条两行长）
if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }
await T.tool('red');
await T.pen(T.line(120, 200, 300));
await T.pen(T.line(120, 420, 300));
await T.pen(T.line(120, 640, 300));
await T.tool('pen');
await T.tap('#check');
const sub1 = await T.waitSub('S1', 80), meta1 = sub1 && T.metaOf(sub1);
T.ok('（前提）交上去了：三句红笔问题', Boolean(meta1) && meta1.groups.length === 3 && meta1.groups.every((g) => g.red), meta1 && meta1.groups);
const NOTE1 = '第二天上午先去博物馆，下午人少的时候再去公园散步。', NOTE2 = '记得带雨伞', NOTE3 = '车票要提前买';
await T.post('/bridge/reply', { sid: 'S1', submission: sub1.id, items: [
  { type: 'note', anchor: 'g1', text: NOTE1 }, { type: 'question', anchor: 'g2', text: NOTE2 }, { type: 'note', anchor: 'g3', text: NOTE3 }] });
T.ok('（前提）三条短批注落下、写完了', await landed(3));
await sleep(300);
let n1 = await noteOf(NOTE1);
const n2 = await noteOf(NOTE2), n3 = await noteOf(NOTE3);
// 空白本子不留批注栏了（阶段 D1 第二部分）：第一条在所指那句红笔问题（右端 420）的右边，不再在页边那一栏（x > 1000）
T.ok('（前提）第一条在所指那句的右边、两行（纸上的换行），第二条是 question', Boolean(n1 && n2 && n3) && n1.lay.lines.length === 2 && n1.lines.length === 2
  && n1.lay.x > 420 && n1.lay.x < 420 + 60 && n2.type === 'question', n1 && [n1.lay, n1.lines.length]);

// ================= 1. 第一条上写红字：一笔压在第一行的几个字下面，同一口气在框外（下面）又写一笔；第二条上写黑笔；第三条旁画星号；远处写一句红笔
const L = n1.lay;
await T.tool('red');
await T.pen(hline(L.x + 2 * L.fs, L.y + L.fs + 5, 5 * L.fs)); // 压着第一行第 3–7 个字的下沿
const yb = L.y + (L.lines.length - 1) * L.lh + L.fs * 1.2 + 30; // 最后一行字底下 30：出了放宽的那一圈（10）
await T.pen([[L.x + 140, yb], [L.x + 150, yb - 8], [L.x + 160, yb], [L.x + 152, yb + 10], [L.x + 152, yb + 16]]);
const reds1 = await S(`S.page.strokes.filter((s) => s.c === 'r').slice(-2).map((s) => JSON.parse(JSON.stringify(s)))`);
const [mkA, mkB] = reds1;
T.ok('（前提）这两笔是同一组（同一口气写的），第二笔在批注的字框外', (await js(`(() => { const gs = window.__ink.computeGroups(window.__ink.S.page.strokes); const ids = ${JSON.stringify(reds1.map((s) => s.id))};
  return gs.some((g) => ids.every((id) => g.strokes.some((s) => s.id === id))); })()`)) && Math.min(...mkB.pts.map((p) => p[1])) > L.y + L.lh + L.fs * 1.2 + 10, reds1.map((s) => s.pts[0]));
await T.tool('pen');
// 黑笔紧挨着第二条写（字底下 5，在红笔算「写在批注上」的那一圈里）。阶段 D1 第二部分起空白本子里黑笔压到字会把批注收成小蓝点
// （见 note_dot.mjs），所以这里改成紧挨着、不压字：查的仍是「黑笔不会让批注变成卡片」；第二条留在纸上，第 7 段还要在它上面写红字
await T.pen(hline(n2.lay.x - 4, n2.lay.y + (n2.lay.lines.length - 1) * n2.lay.lh + n2.lay.fs * 1.2 + 5, 90));
const blackId = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tool('red');
const nStrokes = await S('S.page.strokes.length');
await T.pen(star(n3.lines[0] ? n3.lay.x + (n3.lines[0].r - n3.lines[0].l) / n3.s + 34 : n3.lay.x + 160, n3.lay.y + 14));
T.ok('第三条旁画星号：是采纳（深蓝带 ★），这一笔不留作笔迹', (await noteOf(NOTE3)).adopted && (await S('S.page.strokes.length')) === nStrokes, [(await noteOf(NOTE3)).adopted, await S('S.page.strokes.length'), nStrokes]);
await sleep(2000); // 和上面那两笔隔开（另成一组）
await T.pen(T.line(120, 900, 250)); // 离批注远的地方：普通的红笔问题
const farId = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tool('pen');
await T.saved();
// 纸上这时的样子：第一行字的框、两笔红字的框（屏幕上）
n1 = await noteOf(NOTE1);
const sP = n1.s, line0P = n1.lines[0];
const relPA = relTo(await strokeScreen(mkA), line0P, sP), relPB = relTo(await strokeScreen(mkB), line0P, sP);
{ const [x0, y0] = await T.screenOf(L.x - 40, L.y - 30), [x1, y1] = await T.screenOf(L.x + L.w + 10, yb + 50); SHOTS.push(await clipShot('1-paper-before.png', x0, y0, x1 - x0, y1 - y0)); }

// ================= 点「AI」
await resetLog();
await T.tap('#check');
const sub2 = await T.waitSub('S1', 80), meta2 = sub2 && T.metaOf(sub2);
T.ok('（前提）交上去了', Boolean(meta2));
const nn1 = await noteOf(NOTE1), nn2 = await noteOf(NOTE2), nn3 = await noteOf(NOTE3);
T.ok('交稿后原来两行蓝字的内容、排版和位置都没变，纸上没有圈号', nn1?.id === n1.id && nn1.type === 'note' && same(nn1.lay, L)
  && same(nn1.lines, n1.lines) && await noBadge(), nn1);
const paper = await liveStrokes();
T.ok('压着字和写在框外的两笔红字仍在原处；黑笔和远处的红笔也在', reds1.every((s) => same(paper.find((p) => p.id === s.id)?.pts, s.pts))
  && [blackId, farId].every((id) => paper.some((s) => s.id === id)));
T.ok('黑笔紧挨着第二条写：不变（照旧是纸上的批注，没收成卡片，也没收成小蓝点）', Boolean(nn2) && nn2.type === 'question' && nn2.lines.length === 1
  && !(await item(n2.id)).dot, nn2);
T.ok('星号采纳的第三条：不变（照旧是纸上的批注，带着采纳）', Boolean(nn3) && nn3.type === 'note' && nn3.adopted && nn3.lines.length === 1, nn3);
const on = groupOf(meta2, mkA.id), far = groupOf(meta2, farId);
T.ok('框里框外两笔是同一组，消息在这一组写明原批注', labeled(sub2, on, NOTE1) && same(on.ids, [mkA.id, mkB.id]) && !meta2.cards, on);
T.ok('远处那句仍是普通红笔问题', far?.red && !far.answered && !far.note_on
  && sub2.text.split('\n').some((l) => l.includes(far.id + '｜') && l.includes('｜红笔（问题）')), far);
await T.saved();
const disk2 = T.pageFile('scratch', 0);
T.ok('存盘后蓝字和两笔红字仍在原处', same(disk2.ai.find((a) => a.id === n1.id)?.lay, L)
  && reds1.every((s) => same(disk2.strokes.find((p) => p.id === s.id)?.pts, s.pts)));
const area = (st) => {
  const xs = st.pts.map((p) => p[0]), ys = st.pts.map((p) => p[1]);
  return [Math.min(...xs) - 3, Math.min(...ys) - 3, Math.max(...xs) + 3, Math.max(...ys) + 3];
};
const [blue, inside, outside] = await inkInCrop(join(T.DATA, 'submissions', sub2.id, 'crop.jpg'), meta2.crop,
  [[L.x, L.y + L.lh, L.x + L.w, L.y + L.lh + L.fs * 1.2], area(mkA), area(mkB)]);
T.ok('交出去的整页图里有第二行蓝字，框内和框外的两笔红字也都在', blue.blue > 80 && inside.red > 10 && outside.red > 5, [blue, inside, outside]);
const answer = '上午刚开门，人最少。';
const rep = await T.post('/bridge/reply', { sid: 'S1', submission: sub2.id, items: [{ type: 'note', anchor: on.id, text: answer }] });
T.ok('服务收下了这条回应', rep.ok === true && rep.count === 1, rep);
T.ok('回应写到纸上了', await landed(4));
const reply = await noteOf(answer), r = await item(reply.id);
T.ok('回应指着这两笔红字，在旁边另起一条蓝字', reply.id !== n1.id && reply.lines.length > 0 && !r.dot && same(r.on, on.ids)
  && Math.hypot(Math.max(on.bbox[0] - (r.lay.x + r.lay.w), r.lay.x - on.bbox[2], 0),
    Math.max(on.bbox[1] - (r.lay.y + r.lay.h), r.lay.y - on.bbox[3], 0)) < 300, r);
T.ok('原批注仍是那两行，纸上没有圈号', same((await noteOf(NOTE1)).lines, nn1.lines) && await noBadge());
SHOTS.push(await T.shot('2-reply-on-paper.png'));
T.ok('存上了', await T.saved());
await T.reload();
await installLog();
n1 = await noteOf(NOTE1);
const after = await liveStrokes();
T.ok('刷新后原批注和回应都在，两笔红字相对蓝字的位置没变', same(n1.lay, L) && same((await item(reply.id)).on, on.ids)
  && reds1.every((s) => same(after.find((p) => p.id === s.id)?.pts, s.pts))
  && near(relTo(await strokeScreen(mkA), n1.lines[0], n1.s), relPA, 2) && near(relTo(await strokeScreen(mkB), n1.lines[0], n1.s), relPB, 2));
await T.tool('red');
await T.pen(hline(r.lay.x + 4, r.lay.y + r.lay.fs + 5, 70));
const again = (await liveStrokes()).at(-1).id;
await T.tool('pen');
await T.saved();
await T.tap('#check');
const sub3 = await T.waitSub('S1', 80), meta3 = sub3 && T.metaOf(sub3);
T.ok('再追问指向新回应，原来那组已经答过', labeled(sub3, groupOf(meta3, again), answer) && groupOf(meta3, mkA.id)?.answered && !meta3.cards);

// ================= 5. 第 2 页：两条挨着的批注、一笔压两条；擦掉、撤销的不算；交稿失败不丢
await T.openPage(1);
await T.tool('red');
await T.pen(T.line(120, 200, 300));
await sleep(2000); // 两句隔开（挨得近，不隔开就成了一组）
await T.pen(T.line(120, 245, 300));
await T.pen(T.line(120, 600, 300));
await T.tool('pen');
await T.saved();
await T.tap('#check');
const sub4 = await T.waitSub('S1', 80), meta4 = sub4 && T.metaOf(sub4);
T.ok('（前提）第 2 页交上去了：三句红笔问题', Boolean(meta4) && meta4.page === 1 && meta4.groups.length === 3, meta4 && meta4.groups);
const NA = '牛奶买两盒', NB = '面包要全麦的', NC = '鸡蛋买十个';
await T.post('/bridge/reply', { sid: 'S1', submission: sub4.id, items: [{ type: 'note', anchor: 'g1', text: NA }, { type: 'note', anchor: 'g2', text: NB }, { type: 'note', anchor: 'g3', text: NC }] });
T.ok('（前提）三条短批注落下、写完了', await landed(3));
const nA = await noteOf(NA), nB = await noteOf(NB), nC = await noteOf(NC);
T.ok('（前提）前两条上下挨着（隔不到 20）', Boolean(nA && nB) && nB.lay.y - (nA.lay.y + nA.lay.h) < 20 && nB.lay.y > nA.lay.y, [nA && nA.lay, nB && nB.lay]);
// 写在第三条上又擦掉一笔、又撤销一笔
// （写在第三条字的上沿外面一点：在放宽的那一圈里、不在批注自己占的框里，橡皮落在这一笔上时擦的是笔迹，不是批注）
await T.tool('red');
const er = hline(nC.lay.x + 10, nC.lay.y - 5, 80);
await T.pen(er);
const erId = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tool('eraser');
await T.pen(er.map((p) => [p[0], p[1]]));
T.ok('（前提）橡皮擦掉了写在批注上的那一笔（批注本身没被擦）', await S(`Boolean(S.page.strokes.find((s) => s.id === ${JSON.stringify(erId)}).erasedAt)`) && Boolean(await noteOf(NC)) && !(await item(nC.id)).erasedAt,
  [await S(`S.page.strokes.find((s) => s.id === ${JSON.stringify(erId)})`), await item(nC.id)]);
await T.tool('red');
await T.pen(hline(nC.lay.x + 10, nC.lay.y + 18, 60));
const unId = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tap('#toolsUndo');
T.ok('（前提）又写了一笔、点撤销撤掉了', unId !== erId && !(await S(`S.page.strokes.some((s) => s.id === ${JSON.stringify(unId)})`)));
await T.tool('pen');
await T.saved();
await T.tap('#check');
const sub5 = await T.waitSub('S1', 80), meta5 = sub5 && T.metaOf(sub5);
T.ok('擦掉、撤销掉的红字不算：点「AI」后第三条照旧是纸上的批注，投递里没有卡片', Boolean(meta5) && !meta5.cards && !groupOf(meta5, erId)?.note_on && !groupOf(meta5, unId) && (await item(nC.id)).type === 'note' && (await noteOf(NC)).lines.length === 1,
  [Boolean(meta5), meta5 && meta5.cards, (await item(nC.id)).type, await toastText()]);
// 一笔两条都压到：从第一条的字底下起笔，往下到第二条，再沿第二条的字横着写一长段
await T.tool('red');
const yA = nA.lay.y + nA.lay.fs * 1.2 + 4, yB = nB.lay.y + 14;
const both = seg([[nA.lay.x + 30, yA], [nA.lay.x + 30, yB], [nA.lay.x + 180, yB]], 10);
await T.pen(both);
const bothId = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
// 第三条上写两组：近的一组算追问；往下拖出很远的一组算普通问题。
await sleep(2000);
await T.pen(hline(nC.lay.x + 6, nC.lay.y + nC.lay.fs + 5, 70));
const nearC = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await sleep(2000);
await T.pen(seg([[nC.lay.x + 40, nC.lay.y + 10], [nC.lay.x + 40, nC.lay.y + 310]], 30));
const tallC = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tool('pen');
await T.saved();
// 交稿失败：拦下 /api/send，让它连不上
failIf = (r) => r.url.includes('/api/send');
await T.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/send*', requestStage: 'Request' }] });
await resetLog();
await T.tap('#check');
T.ok('交稿失败：提示没发出去', await T.waitFor(`(window.__toasts || []).some((t) => t.startsWith('没发出去'))`, 8000), await js('window.__toasts'));
async function retryPageIntact() {
  const strokes = await liveStrokes();
  const notes = await Promise.all([NA, NB, NC].map(noteOf));
  return notes.every((n) => n?.type === 'note' && n.lines.length === 1)
    && [bothId, nearC, tallC].every((id) => strokes.some((s) => s.id === id)) && await noBadge();
}
T.ok('交稿失败，三条蓝字和待交的三笔红字都还在纸上', await retryPageIntact());
T.ok('没有新的投递', !(await T.poll('S1')));
await T.saved();
await T.reload();
await installLog();
T.ok('失败后刷新，三条批注和那三笔仍在纸上', await retryPageIntact());
await T.cdp('Fetch.disable');
failIf = null;
await T.tap('#check');
const sub6 = await T.waitSub('S1', 80), meta6 = sub6 && T.metaOf(sub6);
T.ok('再交成功：压到两条的那组归压得多的第二条', labeled(sub6, groupOf(meta6, bothId), NB) && !meta6.cards);
T.ok('靠近第三条的红字归第三条', labeled(sub6, groupOf(meta6, nearC), NC));
const tall = groupOf(meta6, tallC);
T.ok('拖得很远的一组仍是普通红笔问题', tall?.red && !tall.answered && !tall.note_on && same(tall.ids, [tallC]), tall);

// 第 1 页采纳过的批注上写红字，翻到第 2 页一起交。
await T.openPage(0);
const n3b = await noteOf(NOTE3);
await T.tool('red');
await T.pen(hline(n3b.lay.x + 4, n3b.lay.y + n3b.lay.fs + 5, 70));
const mk3 = await S(`S.page.strokes[S.page.strokes.length - 1].id`);
await T.tool('pen');
await T.saved();
await T.openPage(1);
await T.pen(T.line(120, 1000, 200));
await T.saved();
await T.tap('#check');
const sub7 = await T.waitSub('S1', 80), meta7 = sub7 && T.metaOf(sub7);
T.ok('几页一起交（整本那种）：两页都在', Boolean(meta7) && meta7.kind === 'scan' && Boolean(meta7.pages['1']) && Boolean(meta7.pages['2']), meta7 && Object.keys(meta7.pages || {}));
const disk7 = T.pageFile('scratch', 0), w3 = disk7.ai.find((a) => a.id === n3.id);
const scanGroup = (meta, id) => Object.entries(meta?.pages?.['1']?.gx || {}).find(([, g]) => g.red && g.ids.includes(id))?.[0];
const gid7 = scanGroup(meta7, mk3);
T.ok('整本消息里第 1 页这组红字写明冲着采纳过的蓝字', gid7 && sub7.text.split('\n').some((l) => l.includes(gid7 + '｜') && l.includes('写在蓝字批注「' + NOTE3 + '」上')));
T.ok('第 1 页文件里仍有采纳过的批注和那一笔红字', w3?.type === 'note' && w3.adopted && same(w3.lay, n3.lay) && disk7.strokes.some((s) => s.id === mk3 && !s.erasedAt));
await T.openPage(0);
T.ok('翻回第 1 页还能看见带星号的批注', (await noteOf(NOTE3))?.adopted && (await noteOf(NOTE3)).lines.length === 1 && await noBadge());

// 平板取相邻页失败，服务仍按存好的页认出追问；随后单页再交。
const n2b = await noteOf(NOTE2);
await T.tool('red');
await T.pen(hline(n2b.lay.x + 4, n2b.lay.y + n2b.lay.fs + 5, 70));
const mk2 = await S(`(() => { const s = S.page.strokes[S.page.strokes.length - 1]; return { id: s.id, t1: s.t0 + s.pts[s.pts.length - 1][3] }; })()`);
await T.tool('pen');
await T.saved();
await T.openPage(1);
await T.pen(T.line(120, 1100, 200));
await T.saved();
failIf = (r) => r.method === 'GET' && /\/api\/page\?nb=scratch&i=0$/.test(r.url);
await T.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/page*', requestStage: 'Request' }] });
await T.tap('#check');
const sub8 = await T.waitSub('S1', 80), meta8 = sub8 && T.metaOf(sub8);
await T.cdp('Fetch.disable');
failIf = null;
const gid8 = scanGroup(meta8, mk2.id);
T.ok('取不到相邻页时，整本消息仍标明第 1 页这组红字写在哪条批注上', meta8?.kind === 'scan' && gid8
  && sub8.text.split('\n').some((l) => l.includes(gid8 + '｜') && l.includes('写在蓝字批注「' + NOTE2 + '」上')));
await T.openPage(0);
T.ok('翻回第 1 页：这一页记下了交到哪一笔为止（lastSent 不早于那一笔写完），第二条批注照旧在纸上', await T.waitFor(`window.__ink.S.page.lastSent >= ${mk2.t1}`, 8000)
  && (await item(n2.id)).type === 'question', [await S('S.page.lastSent'), mk2.t1]);
await T.saved();
await T.tap('#check');
const sub9 = await T.waitSub('S1', 80), meta9 = sub9 && T.metaOf(sub9);
T.ok('再单页交，没答过的问题仍指向原批注，红字仍在纸上', meta9?.page === 0 && labeled(sub9, groupOf(meta9, mk2.id), NOTE2)
  && (await noteOf(NOTE2))?.type === 'question' && (await liveStrokes()).some((s) => s.id === mk2.id) && !meta9.cards);

console.error('截图：\n' + SHOTS.join('\n'));
T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

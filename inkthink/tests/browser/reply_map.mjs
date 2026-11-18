// 概念图：Claude 给我画的箭头补关系词（label），建议加概念（node）、连线（link）、分组（group），都画成虚线带 ✓ ×；
// 同意的变实线、不同意的变淡；新概念放在空处不压字；决定随下一次点「AI」带回（带着是哪一种）；擦掉箭头，关系词跟着不画。
// 跑法：node tests/browser/reply_map.mjs [临时目录]；有一项不对退出码 1。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'reply-map' });

const ring = (cx, cy, rx, ry) => Array.from({ length: 25 }, (_, i) => [cx + rx * Math.cos((i / 24) * 2 * Math.PI), cy + ry * Math.sin((i / 24) * 2 * Math.PI)]);
const seg = (pts, n = 8) => pts.slice(1).flatMap((b, k) => Array.from({ length: n }, (_, i) => [pts[k][0] + ((b[0] - pts[k][0]) * i) / n, pts[k][1] + ((b[1] - pts[k][1]) * i) / n])).concat([pts[pts.length - 1]]);
const meets = (p, q) => p[0] < q[2] && p[2] > q[0] && p[1] < q[3] && p[3] > q[1];
const inside = (p, q, pad = 0) => p[0] >= q[0] - pad && p[1] >= q[1] - pad && p[2] <= q[2] + pad && p[3] <= q[3] + pad;
// 这一页上 Claude 在概念图上写的每一条，按种类取：数据里的决定、占的地方，和纸上画出来的样子（线、字、✓ × 钮、状态）
const mapItems = async () => Object.fromEntries((await T.evalJS(`window.__ink.S.page.ai.map((a) => { const g = document.querySelector('#aiRoot [data-id="' + a.id + '"]'), q = (s) => g && g.querySelector(s);
  const c = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const U = (els) => { let b = null; for (const e of els) { const r = e.getBBox(), k = [r.x, r.y, r.x + r.width, r.y + r.height]; b = b ? [Math.min(b[0], k[0]), Math.min(b[1], k[1]), Math.max(b[2], k[2]), Math.max(b[3], k[3])] : k; } return b; };
  return { id: a.id, type: a.type, text: a.text || '', verdict: a.verdict || null, sent: Boolean(a.sent), box: a.vbox || a.box, lay: a.lay && [a.lay.x, a.lay.y, a.lay.x + a.lay.w, a.lay.y + a.lay.h],
    drawn: Boolean(g), cls: g ? g.getAttribute('class') : '', opacity: g ? Number(getComputedStyle(g).opacity) : -1, dash: q('path.dash') ? getComputedStyle(q('path.dash')).strokeDasharray : '',
    pb: g ? U(g.querySelectorAll(':scope > path')) : null, first: q('path') ? U([q('path')]) : null, npath: g ? g.querySelectorAll(':scope > path').length : 0,
    words: g ? Array.from(g.querySelectorAll(':scope > text:not(.vstat)')).map((t) => t.textContent).join('') : '', stat: (q('text.vstat') || {}).textContent || '',
    marks: g ? Array.from(g.querySelectorAll('.vbtn text')).map((t) => t.textContent).join('') : '', yes: c(q('.vbtn.yes circle')), no: c(q('.vbtn.no circle')) }; })`)).map((a) => [a.type, a]));
const strokeBoxes = () => T.evalJS(`window.__ink.S.page.strokes.filter((s) => !s.erasedAt).map((s) => { const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; })`);
const strokeCount = () => T.evalJS(`window.__ink.S.page.strokes.length`); // 连擦掉的也算：手势那一笔不该留下
async function landed(n) { // 等写回的 n 条落到这一页，并且一条条写完
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await T.evalJS(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
const toastGone = () => T.waitFor(`document.querySelector('#toast').hidden`, 6000); // 屏幕上方那条提示会挡住它底下的钮（见 reply_suggest 里记的已知问题）：等它消失再点
// 用笔在一个框里打勾（(cx, cy) 附近起笔）或横划
const penTick = (cx, cy) => T.pen(seg([[cx - 12, cy - 2], [cx - 4, cy + 8], [cx + 14, cy - 14]]));
const penStrike = (cx, cy) => T.pen(seg([[cx - 28, cy], [cx + 28, cy + 2]]));

// 1. 黑笔画一张小概念图：A（圈）—箭头→ B（圈），A 下面还有 C（圈）。箭头紧挨着两个圈，隔两秒再画才分成单独一组
await T.pen(ring(160, 160, 50, 30));
await T.pen(ring(560, 160, 50, 30));
await sleep(2000);
await T.pen(T.line(220, 160, 270));
await T.pen(ring(160, 420, 50, 30));
await T.tap('#check');
const sub1 = await T.waitSub('S1'), meta1 = sub1 && T.metaOf(sub1);
T.ok('四组笔迹交上去了：圈 A、圈 B、箭头、圈 C', Boolean(meta1) && meta1.groups.length === 4, meta1 && meta1.groups.map((g) => [g.id, g.bbox]));
const G = Object.fromEntries(meta1.groups.map((g) => [g.id, g.bbox])), A = G.g1, Bx = G.g2, AR = G.g3, C = G.g4;

// 2. Claude 写回：箭头补关系词；建议在 B 旁加一个概念并连到 B；建议 A → C 连线；建议 A、C 归一类
const rep = await T.post('/bridge/reply', { sid: 'S1', submission: sub1.id, items: [
  { type: 'label', anchor: 'g3', text: '导致' },
  { type: 'node', anchor: 'g2', text: '作业太多', links: ['g2'] },
  { type: 'link', from: 'g1', to: 'g4', text: '包含' },
  { type: 'group', anchors: ['g1', 'g4'], text: '源头' }] });
T.ok('服务收下了 4 条', rep.ok === true && rep.count === 4, rep);
T.ok('4 条都落到这一页、写完了', await landed(4), await T.evalJS(`window.__ink.S.page.ai.map((a) => a.type)`));
let M = await mapItems();
const SB = await strokeBoxes(), kinds = ['label', 'node', 'link', 'group'];
T.ok('四种都画在纸上，都是虚线，各带 ✓ × 两个钮，还没定', kinds.every((k) => M[k] && M[k].drawn && M[k].dash !== 'none' && M[k].dash !== '' && M[k].marks === '✓×' && !M[k].verdict && / v-none/.test(M[k].cls) && M[k].stat === ''), kinds.map((k) => M[k] && [k, M[k].dash, M[k].marks, M[k].cls]));

// 关系词：写在我那条箭头的上方、箭头中段，不压着两个圈
T.ok('关系词「导致」写在箭头上方、中段，下面一道虚线', M.label.words === '导致' && M.label.lay[3] <= AR[1] + 1 && M.label.lay[1] > AR[1] - 90 && M.label.lay[0] > AR[0] && M.label.lay[2] < AR[2]
  && !meets(M.label.lay, A) && !meets(M.label.lay, Bx) && M.label.pb[1] >= M.label.lay[3] - 2 && M.label.pb[3] <= AR[1] + 3, [M.label.lay, M.label.pb, AR]);
// 新概念：虚线椭圆里写着字，放在 B 旁边的空处，不压我的字和别的批注，不出纸；有一条虚线连到 B
const others = kinds.filter((k) => k !== 'node' && k !== 'group').map((k) => M[k].lay);
T.ok('新概念「作业太多」是个虚线椭圆，字写在里面', M.node.words === '作业太多' && M.node.npath === 2 && inside(M.node.lay, M.node.box, 4) && inside(M.node.first, M.node.box, 8) && M.node.first[2] - M.node.first[0] > 80, [M.node.box, M.node.first, M.node.lay]);
T.ok('新概念放在空处：不压我的字、不压别的批注、不出纸', SB.every((s) => !meets(M.node.box, s)) && others.every((o) => !meets(M.node.box, o)) && inside(M.node.box, [0, 0, 1000, 1414]), [M.node.box, SB, others]);
const gap = Math.max(M.node.box[0] - Bx[2], Bx[0] - M.node.box[2], M.node.box[1] - Bx[3], Bx[1] - M.node.box[3]);
T.ok('新概念挨着 B（隔着一点空），有一条虚线从它连到 B', gap > 10 && gap < 200 && M.node.pb[0] <= Math.max(Bx[2], M.node.box[0]) + 12 && M.node.pb[2] >= Math.min(Bx[2], M.node.box[2]) - 12, [gap, M.node.pb, Bx]);
// 连线：从 A 到 C 的虚线箭头，在两个圈之间，关系词写在线旁边
T.ok('连线：从 A 指到 C 的虚线箭头，关系词「包含」写在旁边', M.link.words === '包含' && M.link.npath === 2 && M.link.first[1] >= A[3] - 2 && M.link.first[3] <= C[1] + 2 && M.link.first[3] - M.link.first[1] > 120
  && M.link.first[0] > A[0] - 20 && M.link.first[2] < A[2] + 20 && M.link.lay[1] > A[3] && M.link.lay[3] < C[1] && !meets(M.link.lay, M.link.first), [M.link.first, M.link.lay, A, C]);
// 分组：一个虚线框把 A、C 都框在里面，类名写在框上
T.ok('分组：虚线框把 A 和 C 框在一起，没把 B 框进去，类名「源头」写在框的上边', M.group.words === '源头' && inside(A, M.group.pb, 2) && inside(C, M.group.pb, 2) && !meets(M.group.pb, Bx)
  && M.group.pb[2] - M.group.pb[0] < A[2] - A[0] + 50 && M.group.lay[3] <= M.group.box[1] + 2 && M.group.lay[0] >= M.group.box[0], [M.group.pb, M.group.lay, A, C]);
T.ok('四条都在屏幕里', kinds.every((k) => M[k].yes && M[k].yes[0] > 0 && M[k].yes[0] < 834 && M[k].yes[1] > 0 && M[k].yes[1] < 1194), kinds.map((k) => M[k].yes));
// 一页上几组 ✓ × 钮互不相叠（阶段 D1 修的，原来标着已知不过）。连线的关系词写在线的左边还是右边是随机的（跟着这条批注的编号），
// 落在右边时它的钮原本和分组框的钮在同一处；这里不管落在哪边都查，必定会叠的那种布局在第 8 步固定出来查
const vscale = await T.evalJS('window.__ink.S.view.s'), circles = kinds.flatMap((k) => [M[k].yes, M[k].no].map((c) => [k, c]));
T.ok('四条建议的 ✓ × 钮互不相叠', circles.every(([k, c], i) => circles.every(([k2, c2], j) => j <= i || Math.hypot(c[0] - c2[0], c[1] - c2[1]) >= 30 * vscale - 1)), circles);

// 3. 手指点新概念的 ✓：变实线；用笔在连线的关系词上横划：变淡，还是虚线；这一笔不留
const n0 = await strokeCount();
await T.fingerTapAt(...M.node.yes);
const toast3 = await T.evalJS(`document.querySelector('#toast').textContent`);
await penStrike((M.link.box[0] + M.link.box[2]) / 2, (M.link.box[1] + M.link.box[3]) / 2);
M = await mapItems();
T.ok('点 ✓ 同意新概念：虚线变成实线，不变淡', M.node.verdict === 'yes' && M.node.dash === 'none' && / v-yes/.test(M.node.cls) && M.node.opacity === 1, M.node);
T.ok('提示说决定下次点「AI」时带给 Claude', /采纳/.test(toast3) && /下次点「AI」/.test(toast3), toast3);
T.ok('横划不同意连线：变淡，还是虚线', M.link.verdict === 'no' && / v-no/.test(M.link.cls) && M.link.opacity < 0.6 && M.link.dash !== 'none', M.link);
T.ok('横划的那一笔没有留在纸上，别的两条还没定', (await strokeCount()) === n0 && !M.label.verdict && !M.group.verdict, [n0, await strokeCount()]);

// 4. 用笔在关系词上打勾、在分组框的右下角里打勾：都变实线；撤销收回最后一个，再打一次
await penTick((M.label.box[0] + M.label.box[2]) / 2, (M.label.box[1] + M.label.box[3]) / 2);
await penTick(M.group.box[2] - 30, M.group.box[3] - 26);
M = await mapItems();
T.ok('打勾同意关系词：下面那道线变实线', M.label.verdict === 'yes' && M.label.dash === 'none', M.label);
T.ok('在分组框里打勾：同意的是分组（不是框里的连线），框变实线', M.group.verdict === 'yes' && M.group.dash === 'none' && M.link.verdict === 'no', [M.group.verdict, M.link.verdict]);
await T.tap('#toolsUndo');
T.ok('撤销：分组回到没定、又是虚线', !(await mapItems()).group.verdict && (await mapItems()).group.dash !== 'none', (await mapItems()).group);
await penTick(M.group.box[2] - 30, M.group.box[3] - 26);
T.ok('这几笔打勾都没有留在纸上', (await strokeCount()) === n0 && (await mapItems()).group.verdict === 'yes', await strokeCount());
await sleep(1500);
const early = await T.poll('S1');
T.ok('定了以后没有自己发出去', !early, early && early.id);

// 5. 再点「AI」：四条决定带回给 Claude，各带着是哪一种；消息里按种类写着采纳 / 不采纳
await T.saved();
await T.tap('#check');
const sub2 = await T.waitSub('S1'), vs = (sub2 && T.metaOf(sub2).verdicts) || [];
T.ok('决定带回去了，带着种类', JSON.stringify(vs.map((v) => [v.id, v.kind, v.verdict, v.text])) === JSON.stringify([['s1', 'label', 'yes', '导致'], ['s2', 'node', 'yes', '作业太多'], ['s3', 'link', 'no', '包含'], ['s4', 'group', 'yes', '源头']]), vs);
T.ok('消息里逐条写着：关系词、概念、分组采纳，连线不采纳', Boolean(sub2) && ['s1建议的关系词「导致」：采纳', 's2建议加的概念「作业太多」：采纳', 's3建议的连线「包含」：不采纳', 's4建议的分组「源头」：采纳'].every((t) => sub2.text.includes('- ' + t)), sub2 && sub2.text.slice(-600));
T.ok('消息里说明采纳的已变成实线、不采纳的已变淡', /修改建议的决定：图里标 s1、s2、s3、s4 的虚线是你在概念图上建议加的东西/.test(sub2.text) && /采纳的在平板上已变成实线/.test(sub2.text) && /不采纳的已变淡/.test(sub2.text), sub2.text.slice(-400));
// 服务那边一收到这次投递，上面 waitSub 就回来了；页面要等「交上去」的回话到了才把这四条标成带出去了——等它一下再看
// （2026-11-18：整套一起跑时这一条偶尔抢在回话前面看，单独跑也碰到过一次）
for (let k = 0; k < 25; k++) { M = await mapItems(); if (kinds.every((x) => M[x].sent)) break; await sleep(200); }
T.ok('带出去以后：四条都不能再点，纸上写着已采纳 / 不采纳', kinds.every((k) => M[k].sent && M[k].marks === '' && / sent/.test(M[k].cls)) && M.node.stat === '已采纳' && M.label.stat === '已采纳' && M.group.stat === '已采纳' && M.link.stat === '不采纳', kinds.map((k) => [k, M[k].sent, M[k].marks, M[k].stat]));
T.ok('带出去以后同意的还是实线，不同意的还是虚线', M.node.dash === 'none' && M.label.dash === 'none' && M.group.dash === 'none' && M.link.dash !== 'none', kinds.map((k) => M[k].dash));

// 6. 擦掉我画的箭头（橡皮只在箭头中段擦，离两个圈远一点）：关系词跟着不画（别的三条照旧）；撤销：回来
await T.tap('#tools [data-tool=eraser]');
await T.pen(T.line(280, 160, 110));
M = await mapItems();
T.ok('擦掉箭头：关系词跟着不画，别的三条还在', (await strokeCount()) === n0 && SB.length - (await strokeBoxes()).length === 1 && !M.label.drawn && M.node.drawn && M.link.drawn && M.group.drawn, kinds.map((k) => [k, M[k].drawn]));
await T.tap('#toolsUndo');
T.ok('撤销：箭头和关系词都回来了', (await strokeBoxes()).length === SB.length && (await mapItems()).label.drawn, (await mapItems()).label);
await T.tap('#tools [data-tool=pen]');

// 7. 存到电脑上；刷新后同意的还是实线、不同意的还是虚线
T.ok('自己存上了', await T.saved(), await T.evalJS(`({ dirty: window.__ink.S.dirty, saving: window.__ink.S.saving })`));
const disk = Object.fromEntries(T.pageFile('scratch', 0).ai.map((a) => [a.type, a]));
T.ok('页面文件里四条都在，记着决定和已带出', kinds.every((k) => disk[k] && disk[k].sent === true && disk[k].verdict === (k === 'link' ? 'no' : 'yes') && disk[k].paths.length > 0), kinds.map((k) => disk[k] && [k, disk[k].verdict, disk[k].sent]));
await T.reload();
M = await mapItems();
T.ok('刷新后四条还在：同意的实线、不同意的虚线，字没变', kinds.every((k) => M[k] && M[k].drawn) && M.node.dash === 'none' && M.group.dash === 'none' && M.link.dash !== 'none'
  && M.label.words === '导致' && M.node.words === '作业太多' && M.link.words === '包含' && M.group.words === '源头', kinds.map((k) => M[k] && [k, M[k].drawn, M[k].dash, M[k].words]));

// 8. 固定出一个会叠的布局（阶段 D1 修「分组框和框里连线的 ✓ × 钮叠在一起」时加的）：第 2 页上再画两个圈，Claude 建议从上面那个连到
//    下面那个（带关系词）、把两个归一类；把连线关系词那一块挪到分组框右边那条边的正中——原来两组钮的位置算出来正好是同一处。
//    查：两组钮不叠，先来的连线在原处，后来的分组让开、仍紧挨着分组框；手指点哪个钮就是哪个
await T.api('/api/notebook/addpage?nb=scratch', { method: 'POST', body: '' });
await T.reload();
if (await T.evalJS('window.__ink.S.flow')) { await T.evalJS('window.__ink.toggleFlow()'); await sleep(600); }
await T.openPage(1);
await T.pen(ring(160, 160, 50, 30));
await T.pen(ring(160, 420, 50, 30));
await T.tap('#check');
const sub3 = await T.waitSub('S1'), meta3 = sub3 && T.metaOf(sub3);
T.ok('（前提）第 2 页交上去了：两个圈', Boolean(meta3) && meta3.groups.length === 2, meta3 && meta3.groups);
const rep3 = await T.post('/bridge/reply', { sid: 'S1', submission: sub3.id, items: [
  { type: 'link', from: 'g1', to: 'g2', text: '包含' },
  { type: 'group', anchors: ['g1', 'g2'], text: '水果' }] });
T.ok('（前提）两条都落下了', rep3.ok === true && (await landed(2)), rep3);
const fixed = await T.evalJS(`(() => { const S = window.__ink.S, L = S.page.ai.find((a) => a.type === 'link'), G = S.page.ai.find((a) => a.type === 'group');
  const R = G.vbox || G.box, cy = (R[1] + R[3]) / 2, w = L.vbox[2] - L.vbox[0], h = L.vbox[3] - L.vbox[1], v = [R[2] - w, cy - h / 2, R[2], cy + h / 2];
  L.vbox = v.slice(); L.box = v.slice(); if (L.lay) { L.lay.x = v[0] + 6; L.lay.y = v[1] + 4; } L.hit = [Math.min(L.hit[0], v[0]), Math.min(L.hit[1], v[1]), Math.max(L.hit[2], v[2]), Math.max(L.hit[3], v[3])];
  window.__ink.renderAI();
  // 原来的算法（各算各的）：框右边放得下就放在右边、和框竖直居中
  const home = (b) => [b[2] + 8 + 15, (b[1] + b[3]) / 2];
  return { link: L.id, group: G.id, L: v, R, homeL: home(v), homeG: home(R), TW: S.TW }; })()`);
T.ok('（前提）这个布局下两组钮原来算出来是同一处', fixed.homeL[0] === fixed.homeG[0] && fixed.homeL[1] === fixed.homeG[1] && fixed.R[2] + 8 + 60 + 8 <= fixed.TW - 6, fixed);
const btns = () => T.evalJS(`(() => { const out = {}; for (const id of [${JSON.stringify(fixed.link)}, ${JSON.stringify(fixed.group)}]) { const g = document.querySelector('#aiRoot [data-id="' + id + '"]');
  out[id] = ['yes', 'no'].map((v) => { const c = g.querySelector('.vbtn.' + v + ' circle'), r = c.getBoundingClientRect(); return { x: +c.getAttribute('cx'), y: +c.getAttribute('cy'), sx: r.left + r.width / 2, sy: r.top + r.height / 2 }; }); } return out; })()`);
const Bt = await btns(), lb = Bt[fixed.link], gb = Bt[fixed.group], all4 = lb.concat(gb);
T.ok('两组 ✓ × 钮不叠（四个圆两两隔开一个圆的宽度以上）', all4.every((c, i) => all4.every((d, j) => j <= i || Math.hypot(c.x - d.x, c.y - d.y) >= 30)), Bt);
T.ok('先来的连线那组在原处（关系词右边、竖直居中）', Math.abs(lb[0].x - fixed.homeL[0]) < 0.01 && Math.abs(lb[0].y - fixed.homeL[1]) < 0.01, [lb[0], fixed.homeL]);
const pr = [gb[0].x - 15, gb[0].y - 15, gb[1].x + 15, gb[1].y + 15], R = fixed.R, sep = Math.max(pr[0] - R[2], R[0] - pr[2], pr[1] - R[3], R[1] - pr[3]);
T.ok('后来的分组那组让开了，仍紧挨着分组框（隔不到 12）、离原处不远', sep >= 0 && sep <= 12 && Math.hypot(gb[0].x - fixed.homeG[0], gb[0].y - fixed.homeG[1]) < 120, { pr, R, sep, home: fixed.homeG });
// 看得出哪一对属于哪条建议（D1 第二部分加的）：让开的那组不和别的钮上下挨着排，还有一条细虚线连到自己的框，线头的小点落在框边上
const minApart = Math.min(...lb.flatMap((c) => gb.map((d) => Math.hypot(c.x - d.x, c.y - d.y))));
T.ok('两组钮不再上下挨着（相隔 60 以上）', minApart >= 60, minApart);
const links = await T.evalJS(`(() => { const out = {}; for (const id of [${JSON.stringify(fixed.link)}, ${JSON.stringify(fixed.group)}]) { const e = document.querySelector('#aiRoot [data-id="' + id + '"] .vlink circle');
  out[id] = e ? [+e.getAttribute('cx'), +e.getAttribute('cy')] : null; } return out; })()`);
const end = links[fixed.group], onEdge = (p, b) => Boolean(p) && ((Math.abs(p[0] - b[0]) < 1 || Math.abs(p[0] - b[2]) < 1) && p[1] >= b[1] - 1 && p[1] <= b[3] + 1
  || (Math.abs(p[1] - b[1]) < 1 || Math.abs(p[1] - b[3]) < 1) && p[0] >= b[0] - 1 && p[0] <= b[2] + 1);
const Lb = fixed.L;
T.ok('让开的那组（分组）有一条细线连到分组框，线头落在分组框的边上、不在连线那块关系词的框上', onEdge(end, R) && !(end[1] >= Lb[1] - 1 && end[1] <= Lb[3] + 1 && end[0] >= Lb[0] - 1 && end[0] <= Lb[2] + 1), { end, R, L: Lb });
T.ok('在原处的那组（连线）不画这条线', links[fixed.link] === null, links);
{ const z = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 834, height: 1194, scale: 2 } }); // 两倍大，看得清那条细线
  writeFileSync(join(T.OUT, '8-vote-owners.png'), Buffer.from(z.data, 'base64')); console.error('截图：\n' + join(T.OUT, '8-vote-owners.png')); }
const decided = () => T.evalJS(`(() => { const S = window.__ink.S; return { link: (S.page.ai.find((a) => a.id === ${JSON.stringify(fixed.link)}) || {}).verdict || null, group: (S.page.ai.find((a) => a.id === ${JSON.stringify(fixed.group)}) || {}).verdict || null }; })()`);
await sleep(1200);
await T.fingerTapAt(gb[0].sx, gb[0].sy);
let dd = await decided();
T.ok('手指点分组的 ✓：定的是分组，连线没动', dd.group === 'yes' && dd.link === null, dd);
await toastGone();
const Bt2 = await btns();
await T.fingerTapAt(Bt2[fixed.link][1].sx, Bt2[fixed.link][1].sy);
dd = await decided();
T.ok('手指点连线的 ×：定的是连线，分组还是同意', dd.link === 'no' && dd.group === 'yes', dd);

await T.finish();

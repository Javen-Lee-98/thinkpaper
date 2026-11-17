// 笔迹分组：平板页面（static/app.js 的 computeGroups）和服务端（pages._cluster）是同一套规则（2026-11-14 页面跟上服务端）：
// 按时间分组之后，同一行上接着写的（停顿过的词、一句话）并成一组，回头补的一点一横并回它所属的那组（记 late、lateAt、tw）。查：
// 1. 同一份合成笔迹（tests/fixtures/grouping.json，tests/test_grouping.py 生成）：页面和服务端各分一次组，每组的笔迹 id、late、lateAt、tw、
//    t0、t1、外框、revisit 完全一样，也和夹具里写的该分成的样子一样。
// 2. 用笔真写一页：英文一行（词中间停过、词间停过）、下一行、回头给第一行补一点、一句红笔问题。点「AI」：
//    交上去的分组是 3 组，第一组带 late、lateAt、tw；书写过程写着「其中 1 笔是 … 回头补的」，下一组「之前停顿」（按 tw 算，不按补的那一点）；
//    服务端按存好的这一页自己分组，编号和每组的笔迹一样；整本检测这一页，组号和每组的笔迹也一样。截两张图：交给 Claude 的图（带编号）、
//    纸上画出分组框和编号。
// 3. 短批注上的红字按新的分组算（noteFollowups）：一个词写在批注上、停了 2.5 秒接着写到批注外——整个词进卡片（以前后半截留在纸上）；
//    一句很长的红字从正文写进批注、中间停过——整句留在纸上、照旧是一组普通的红笔（以前压着批注的那半句被收进卡片）。
// 笔是 pointerType 为 pen 的鼠标事件；只在无头 Edge 里跑过。
// 跑法：node tests/run_browser.mjs <临时目录> --only grouping；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep, PY, APP } from '../browser_lib.mjs';

const T = await boot({ name: 'grouping', pages: 2 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const FIXTURE = join(APP, 'tests', 'fixtures', 'grouping.json');

// ---- 两边各分一次组，每组记下要比的字段
// 服务端：pages._cluster（外框不取整）和 compute_groups（revisit、擦掉几笔）
const PY_GROUPS = `import json, sys
sys.path.insert(0, '.')
import pages
out = {}
for c in json.load(open(sys.argv[1], encoding='utf-8')):
    raw, cg = pages._cluster(c['strokes']), pages.compute_groups(c['strokes'])
    out[c['name']] = [{'id': x['id'], 'ids': sorted(s['id'] for s in g['strokes']), 'late': g.get('late', 0), 'lateAt': g.get('lateAt'), 'tw': g['tw'],
                       't0': g['t0'], 't1': g['t1'], 'bbox': g['bbox'], 'revisit': x['revisit'], 'n': x['n'], 'erased': x['erased']} for g, x in zip(raw, cg)]
print(json.dumps(out))`;
function serverGroups(cases) {
  const f = join(T.ROOT, 'groups-in.json');
  writeFileSync(f, JSON.stringify(cases), 'utf8');
  return JSON.parse(execFileSync(PY, ['-c', PY_GROUPS, f], { cwd: APP, encoding: 'utf8' }));
}
function pageGroups(cases) {
  return js(`(() => { const out = {}; for (const c of ${JSON.stringify(cases)}) {
    out[c.name] = window.__ink.computeGroups(c.strokes).map((g) => ({ id: g.id, ids: g.strokes.map((s) => s.id).sort(), late: g.late || 0, lateAt: g.lateAt ?? null, tw: g.tw,
      t0: g.t0, t1: g.t1, bbox: g.bbox, revisit: g.revisit, n: g.n, erased: g.erased })); }
    return out; })()`);
}
const FIELDS = ['id', 'ids', 'late', 'lateAt', 'tw', 't0', 't1', 'bbox', 'revisit', 'n', 'erased'];
// 两边哪里不一样：[[第几组, 字段, 服务端, 页面]]；组数不同时整个列出
function diff(a, b) {
  if (!a || !b || a.length !== b.length) return [['组数', a && a.length, b && b.length]];
  const out = [];
  a.forEach((g, i) => { for (const k of FIELDS) if (JSON.stringify(g[k]) !== JSON.stringify(b[i][k])) out.push([g.id, k, g[k], b[i][k]]); });
  return out;
}

// ================= 1. 同一份夹具，两边各分一次
const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const cases = fx.cases.map((c) => ({ name: c.name, strokes: c.strokes }));
const py = serverGroups(cases), pg = await pageGroups(cases);
T.ok('（前提）夹具里有要求的几种情形', ['pause_in_word', 'late_dot_and_bar', 'two_lines', 'two_colors', 'far_apart', 'bracket_and_text', 'line_and_text',
  'drawing_and_text', 'chinese_line', 'english_line'].every((n) => cases.some((c) => c.name === n)) && cases.length >= 12, cases.map((c) => c.name));
for (const c of fx.cases) {
  const d = diff(py[c.name], pg[c.name]);
  T.ok(`两边一致：${c.name}（${c.about}）`, d.length === 0, d);
  const want = { groups: (pg[c.name] || []).map((g) => g.ids), late: (pg[c.name] || []).map((g) => g.late), tw: (pg[c.name] || []).map((g) => g.tw) };
  T.ok(`  页面分成了该分的样子：${c.name}`, JSON.stringify(want) === JSON.stringify(c.expect), [want, c.expect]);
}

// ================= 2. 用笔真写一页，点「AI」
const H = 40, SP = H * 0.55; // 字高、字母间距（和夹具一样）
const letterPts = (x, y, h = H) => Array.from({ length: 12 }, (_, k) => [x + h * 0.25 + h * 0.22 * Math.cos(k * 0.6), y + h * 0.5 + h * 0.3 * Math.sin(k * 0.6)]);
// 用笔画一笔（页面坐标）：屏幕换算一次取好，比 T.pen 少问几十次页面
async function pen(points, wait = 250) {
  const v = await js(`(() => { const S = window.__ink.S, r = document.querySelector('#stage').getBoundingClientRect(); return { l: r.left + S.view.tx, t: r.top + S.view.ty, s: S.view.s }; })()`);
  const sp = points.map((p) => [v.l + p[0] * v.s, v.t + p[1] * v.s]), base = { pointerType: 'pen', button: 'left' };
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: sp[0][0], y: sp[0][1], buttons: 1, clickCount: 1 }, base));
  for (const p of sp.slice(1)) await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: p[0], y: p[1], buttons: 1 }, base));
  const l = sp[sp.length - 1];
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: l[0], y: l[1], buttons: 0, clickCount: 1 }, base));
  await sleep(wait);
  return S(`S.page.strokes[S.page.strokes.length - 1].id`);
}
const writeWord = async (x, y, n, h = H) => { const ids = []; for (let k = 0; k < n; k++) ids.push(await pen(letterPts(x + k * h * 0.55, y, h))); return ids; };

if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }
const w1a = await writeWord(100, 100, 4);           // 第一行：一个词写到一半停了 2.5 秒
await sleep(2500);
const w1b = await writeWord(100 + 4 * SP, 100, 3);
await sleep(2500);                                  // 词间停 2.5 秒，空不到半个字高
const w2 = await writeWord(100 + 7 * SP + 0.35 * H, 100, 3);
await sleep(2500);
const line2 = await writeWord(100, 100 + 1.6 * H, 5); // 下一行
await sleep(2500);
const dotId = await pen([[100 + SP + H * 0.3, 96], [102 + SP + H * 0.3, 98]]); // 回头给第一行第 2 个字母补一点
await sleep(2500);
await T.tool('red');
const red = await writeWord(100, 320, 4);           // 一句红笔问题
await T.tool('pen');
await T.saved();
const line1 = [...w1a, ...w1b, ...w2, dotId];
const live = await js(`window.__ink.computeGroups(window.__ink.S.page.strokes).map((g) => ({ id: g.id, ids: g.strokes.map((s) => s.id), late: g.late || 0 }))`);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
T.ok('（页面）这一页分成 3 组：第一行（连同停顿过的后半截、下一个词、补的一点）、第二行、红笔', live.length === 3 && same(live[0].ids, line1) && live[0].late === 1
  && same(live[1].ids, line2) && same(live[2].ids, red), live);
await T.tap('#check');
const sub = await T.waitSub('S1', 80), meta = sub && T.metaOf(sub);
const mg = (meta && meta.groups) || [];
const g1 = mg[0] || {}, g2 = mg[1] || {};
const strokes1 = await S(`S.page.strokes.map((s) => ({ id: s.id, t0: s.t0, t1: s.t0 + s.pts[s.pts.length - 1][3] }))`);
const endOf = (ids) => Math.max(...strokes1.filter((s) => ids.includes(s.id)).map((s) => s.t1));
const dotT0 = (strokes1.find((s) => s.id === dotId) || {}).t0;
T.ok('交上去的分组：3 组，编号 g1–g3，每组的笔迹对', mg.length === 3 && mg.map((g) => g.id).join() === 'g1,g2,g3' && same(g1.ids, line1) && same(g2.ids, line2)
  && same(mg[2].ids, red) && mg[2].red, mg.map((g) => [g.id, g.ids && g.ids.length, g.late]));
T.ok('第一组带着 late 1、lateAt（补那一点的时刻）、tw（不算那一点、写完的时刻，在第二行之前）；t1 连那一点在内', g1.late === 1 && g1.lateAt === dotT0
  && g1.tw === endOf([...w1a, ...w1b, ...w2]) && g1.tw < g2.t0 && g1.t1 === endOf(line1) && g1.t1 > g2.t0, [g1.late, g1.lateAt, dotT0, g1.tw, g1.t1, g2.t0]);
T.ok('没补过的组不带 late、lateAt、tw', mg.slice(1).every((g) => !('late' in g) && !('lateAt' in g) && !('tw' in g)), mg.slice(1));
const lineOf = (text, id) => (text.split('\n').find((l) => l.replace(/^[★\s]+/, '').startsWith(id + '｜')) || '');
const tl1 = lineOf(sub.text, 'g1'), tl2 = lineOf(sub.text, 'g2');
T.ok('书写过程：g1 写着「其中 1 笔是 mm:ss 回头补的」，没有「回头补写」', /其中 1 笔是 \d\d:\d\d 回头补的/.test(tl1) && !tl1.includes('回头补写'), tl1);
T.ok('书写过程：g2「之前停顿」（按 g1 写完的时刻算，不按后来补的那一点）', /之前停顿 \d+ 秒/.test(tl2) && !tl2.includes('紧接上一组'), tl2);
// 服务端按存好的这一页自己分组：编号、每组的笔迹和平板发来的一样
const disk = T.pageFile('scratch', 0);
const srv = serverGroups([{ name: 'p', strokes: disk.strokes }]).p;
T.ok('服务端按存好的这一页分组：编号、每组的笔迹、late、lateAt、tw 和平板交上来的一样', srv.length === mg.length && srv.every((g, i) => g.id === mg[i].id && same(g.ids, mg[i].ids)
  && g.late === (mg[i].late || 0) && g.lateAt === (mg[i].lateAt ?? null) && (g.late ? g.tw === mg[i].tw : true)), [srv.map((g) => [g.id, g.ids.length, g.late, g.tw]), mg.map((g) => [g.id, g.ids.length, g.late, g.tw])]);
// 整本检测这一页（Claude 那边取的）：组号和每组的笔迹也一样
const scan = await T.post('/bridge/scan', { sid: 'S1', nb: 'scratch', pages: [1] });
const sm = scan.id ? T.metaOf(scan) : {}, gx = ((sm.pages || {})['1'] || {}).gx || {};
T.ok('整本检测这一页：组号、每组的笔迹和「AI」交上去的一样，书写过程里也写着回头补的', Object.keys(gx).join() === 'g1,g2,g3' && mg.every((g) => same(gx[g.id].ids, g.ids))
  && /g1｜.*其中 1 笔是 \d\d:\d\d 回头补的/.test(scan.text || ''), [Object.keys(gx), scan.error || (scan.text || '').slice(0, 600)]);
// 截图 1：交给 Claude 的那张图（编号 g1–g3 标在每组左上角）
const crop = join(T.OUT, 'grouping-1-sent-image.jpg');
copyFileSync(join(T.DATA, 'submissions', sub.id, 'crop.jpg'), crop);
// 截图 2：纸上画出新规则的分组框和编号（测试临时叠的一层，截完就去掉）
await js(`(() => { const S = window.__ink.S, r = document.querySelector('#stage').getBoundingClientRect(), v = S.view, box = document.createElement('div');
  box.id = '__groups'; box.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:99999';
  for (const g of window.__ink.computeGroups(S.page.strokes)) { const b = g.bbox, d = document.createElement('div');
    d.style.cssText = 'position:fixed;border:2px solid ' + (g.c === 'r' ? '#d23c2e' : '#2f8f4e') + ';left:' + (r.left + v.tx + (b[0] - 4) * v.s) + 'px;top:' + (r.top + v.ty + (b[1] - 4) * v.s) + 'px;width:'
      + ((b[2] - b[0] + 8) * v.s) + 'px;height:' + ((b[3] - b[1] + 8) * v.s) + 'px';
    const t = document.createElement('div'); t.textContent = g.id + (g.late ? '（补 ' + g.late + ' 笔）' : ''); t.style.cssText = 'position:absolute;left:0;top:-20px;font:600 14px sans-serif;color:#333;background:#fffd;white-space:nowrap';
    d.appendChild(t); box.appendChild(d); }
  document.body.appendChild(box);
  const st = document.createElement('style'); st.id = '__groupsCss'; st.textContent = '#bar,#rail,#chipRow,#tools,#verchip{visibility:hidden!important}'; // 截图时藏起压在纸上的按钮条
  document.head.appendChild(st); return 1; })()`);
await sleep(200);
const [bx0, by0] = await T.screenOf(60, 40), [bx1, by1] = await T.screenOf(560, 380);
const z = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, bx0), y: Math.max(0, by0), width: bx1 - bx0, height: by1 - by0, scale: 2 } });
const boxes = join(T.OUT, 'grouping-2-boxes-on-paper.png');
writeFileSync(boxes, Buffer.from(z.data, 'base64'));
await js(`(document.getElementById('__groups').remove(), document.getElementById('__groupsCss').remove(), 1)`);
console.error('截图：\n' + crop + '\n' + boxes);

// ================= 3. 短批注上的红字按新的分组算
await T.openPage(1);
await T.tool('red');
await T.pen(T.line(120, 200, 300));
// 第二句写得长、快到纸的右边（阶段 D1 第二部分起空白本子不留批注栏，批注落在所指那句旁边的空白里）：它的批注只能放在它下面，
// 批注左边是空白——下面那句红字才能「从空白处写进批注」而不压着这句问题（以前批注在页边那一栏，左边就是正文的空白）
await T.pen(T.line(560, 600, 700));
await T.tool('pen');
await T.saved();
await T.tap('#check');
const sub3 = await T.waitSub('S1', 80), meta3 = sub3 && T.metaOf(sub3);
T.ok('（前提）第 2 页交上去了：两句红笔问题', Boolean(meta3) && meta3.page === 1 && meta3.groups.length === 2, meta3 && meta3.groups);
const NA = '牛奶买两盒', NB = '面包要全麦的';
await T.post('/bridge/reply', { sid: 'S1', submission: sub3.id, items: [{ type: 'note', anchor: 'g1', text: NA }, { type: 'note', anchor: 'g2', text: NB }] });
const landed = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= 2`, 10000);
await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
T.ok('（前提）两条短批注落下、写完了', landed && (await T.waitFor('window.__written', 40000)));
await sleep(300);
// 批注的字在纸上的右端（页面坐标）：按画出来的那一行字量
const noteOf = (text) => js(`(() => { const S = window.__ink.S, a = S.page.ai.find((o) => o.text === ${JSON.stringify(text)} && o.type !== 'write'); if (!a) return null;
  const t = document.querySelector('#aiRoot g[data-id="' + a.id + '"] text'), r = t && t.getBoundingClientRect();
  return { id: a.id, type: a.type, lay: a.lay, right: r ? a.lay.x + (r.right - r.left) / S.view.s : null }; })()`);
const item = (id) => S(`(() => { const a = S.page.ai.find((o) => o.id === ${JSON.stringify(id)}); return a ? JSON.parse(JSON.stringify(a)) : null; })()`);
const nA = await noteOf(NA), nB = await noteOf(NB);
T.ok('（前提）两条批注各一行：第一条在第一句（右端 420）右边，第二条在第二句（y 600）下面、左边离纸边 430 以上', Boolean(nA && nB) && nA.lay.x > 420 && nA.lay.x < 480
  && Math.abs(nA.lay.y + 25 - 200) < 25 && nB.lay.y > 610 && nB.lay.x - 430 > 20 && nA.lay.lines.length === 1 && nB.lay.lines.length === 1 && nA.right > nA.lay.x,
  [nA && nA.lay, nB && nB.lay]);
const h = 24, sp = h * 0.55; // 红字比批注的字（21 号）稍大一点
await T.tool('red');
// 第一条上：一个词的前半截压着批注最后几个字，停 2.5 秒，后半截接着写到批注外（离字超过放宽的那一圈 10）
const partA = await writeWord(nA.right - 40, nA.lay.y + 2, 3, h);
await sleep(2500);
const partB = await writeWord(nA.right + 12, nA.lay.y + 2, 3, h);
// 第二条上：一句红字从正文写进批注，分三截写、中间各停 2.5 秒；最后一截压着批注的头几个字
const sentence = [];
const xs0 = nB.lay.x - 430, words = 8;
for (let k = 0; k < words; k++) {
  if (k === 3 || k === 6) await sleep(2500);
  sentence.push(...(await writeWord(xs0 + k * (4 * sp + 10), nB.lay.y + 2, 4, h)));
}
await T.tool('pen');
await T.saved();
const marks = await S(`S.page.strokes.filter((s) => s.c === 'r').map((s) => ({ id: s.id, t0: s.t0, t1: s.t0 + s.pts[s.pts.length - 1][3], x0: Math.min(...s.pts.map((p) => p[0])), x1: Math.max(...s.pts.map((p) => p[0])) }))`);
const mk = (id) => marks.find((m) => m.id === id) || {};
T.ok('（前提）按原来的规则这两截是两组：中间停了 1.8 秒以上；后半截一笔也没碰到批注（离字右端超过 10）', mk(partB[0]).t0 - mk(partA[2]).t1 > 1800
  && partB.every((id) => mk(id).x0 > nA.right + 10), [mk(partB[0]).t0 - mk(partA[2]).t1, partB.map((id) => mk(id).x0), nA.right]);
const gNow = await js(`window.__ink.computeGroups(window.__ink.S.page.strokes).map((g) => g.strokes.map((s) => s.id))`);
T.ok('（页面）现在的分组：这个词是一组，这句话是一组', gNow.some((ids) => same(ids, [...partA, ...partB])) && gNow.some((ids) => same(ids, sentence)), gNow.map((ids) => ids.length));
T.ok('（前提）这句话从正文写进批注：最后一截压着批注的字，整句比卡片放得下的（约 510）宽', sentence.slice(-8).some((id) => mk(id).x1 > nB.lay.x + 2)
  && Math.max(nB.right, ...sentence.map((id) => mk(id).x1)) - Math.min(...sentence.map((id) => mk(id).x0)) > 520, [nB.lay.x, nB.right, sentence.map((id) => [mk(id).x0, mk(id).x1])]);
await T.tap('#check');
const sub4 = await T.waitSub('S1', 80), meta4 = sub4 && T.metaOf(sub4);
const wA = await item(nA.id), wB = await item(nB.id);
const onPaper = await S(`S.page.strokes.map((s) => s.id)`);
T.ok('写在第一条上的那个词：整个词（停顿前后两截）都收进了卡片，纸上一笔不剩', Boolean(wA) && wA.type === 'write' && same((wA.marks || []).map((m) => m.id), [...partA, ...partB])
  && ![...partA, ...partB].some((id) => onPaper.includes(id)), [wA && wA.type, wA && (wA.marks || []).map((m) => m.id), partA, partB]);
T.ok('投递里有这张卡片，交的是这个词的 6 笔', Boolean(meta4) && (meta4.cards || []).length === 1 && meta4.cards[0].id === nA.id && same(meta4.cards[0].marks, [...partA, ...partB]),
  meta4 && meta4.cards);
T.ok('从正文写进第二条的那句话：整句留在纸上，第二条照旧是纸上的批注', Boolean(wB) && wB.type === 'note' && sentence.every((id) => onPaper.includes(id)), [wB && wB.type, sentence.filter((id) => !onPaper.includes(id))]);
T.ok('这句话作为一组普通的红笔交上去了（整句一组，没拆开）', Boolean(meta4) && meta4.groups.some((g) => g.red && !g.answered && same(g.ids, sentence)),
  meta4 && meta4.groups.map((g) => [g.id, g.red, g.ids.length]));

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

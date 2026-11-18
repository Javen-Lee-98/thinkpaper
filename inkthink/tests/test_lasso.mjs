// static/lasso.js 的测试：node --test tests/test_lasso.mjs
// 套索里的纯计算：点在不在圈里（按绕数，绕两圈、8 字都算里面）、哪几笔被圈中（一半以上的点在圈里；擦掉的不算）、
// 挪一笔的点（只改 x、y，挪过去再挪回来分毫不差）、挪 SVG 路径、挪 Claude 的一条东西（每一种坐标字段）、哪几条怎么跟着走、
// 只挪箭头连线的一头（和照 app.js 的算法在新的两头上重画的一样）、撤销恢复时照原样放回的字段、拖动夹在纸内。
// 画圈、拖动、撤销重做、跟着走的蓝字在页面上的样子，在浏览器测试 tests/browser/lasso.mjs 里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const L = createRequire(import.meta.url)('../static/lasso.js');

const SQUARE = [[0, 0], [100, 0], [100, 100], [0, 100]];
const line = (x0, y, x1, n = 11, t0 = 0) => Array.from({ length: n }, (_, i) => [Math.round((x0 + ((x1 - x0) * i) / (n - 1)) * 10) / 10, y, 0.5, t0 + i * 16]);
const clone = (v) => JSON.parse(JSON.stringify(v));

test('门槛：一半', () => {
  assert.equal(L.SHARE, 0.5);
});

test('点在不在圈里：方块、凹进去的、绕两圈的、8 字的', () => {
  assert.equal(L.inPolygon(50, 50, SQUARE), true);
  assert.equal(L.inPolygon(150, 50, SQUARE), false);
  assert.equal(L.inPolygon(-1, 50, SQUARE), false);
  // 凹进去的 U：中间那道缺口是外面
  const U = [[0, 0], [30, 0], [30, 70], [70, 70], [70, 0], [100, 0], [100, 100], [0, 100]];
  assert.equal(L.inPolygon(50, 30, U), false);
  assert.equal(L.inPolygon(15, 30, U), true);
  assert.equal(L.inPolygon(50, 85, U), true);
  // 同一个方块绕了两圈（按奇偶算会变成外面）：还在里面
  assert.equal(L.inPolygon(50, 50, SQUARE.concat(SQUARE)), true);
  // 8 字：两边的圈里都算
  const EIGHT = [[0, 0], [100, 100], [200, 0], [200, 100], [100, 0], [0, 100]];
  assert.equal(L.inPolygon(30, 50, EIGHT), true);
  assert.equal(L.inPolygon(170, 50, EIGHT), true);
  assert.equal(L.inPolygon(100, -10, EIGHT), false);
});

test('哪几笔被圈中：一半以上的点在圈里的；擦掉的、没点的不算；圈不到三个点什么都不选', () => {
  const strokes = [
    { id: 'in', pts: line(10, 50, 90) },               // 全在里面
    { id: 'half', pts: line(45, 30, 145, 11) },        // 11 个点里 6 个在里面（x 45–95）
    { id: 'less', pts: line(80, 70, 180, 11) },        // 3 个在里面
    { id: 'out', pts: line(200, 50, 300) },            // 全在外面
    { id: 'erased', pts: line(10, 20, 90), erasedAt: 5 },
    { id: 'empty', pts: [] },
    { id: 'dot', pts: [[40, 40, 0.5, 0]] },            // 一个点的一笔（句号）
    { id: 'red', c: 'r', pts: line(20, 80, 60) },
  ];
  assert.deepEqual(L.pick(strokes, SQUARE), ['in', 'half', 'dot', 'red']);
  // 正好一半：10 个点里 5 个在里面也算
  assert.deepEqual(L.pick([{ id: 'h', pts: line(55, 50, 145, 10) }], SQUARE), ['h']);
  assert.deepEqual(L.pick(strokes, [[0, 0], [100, 100]]), []);
  assert.deepEqual(L.pick(strokes, []), []);
  assert.deepEqual(L.pick(strokes, [[500, 500], [600, 500], [600, 600]]), []);
});

test('挪一个数：一位小数的挪过去再挪回来分毫不差；别的照原样加', () => {
  assert.equal(L.shiftNum(10.3, 5.2), 15.5);
  assert.equal(L.shiftNum(L.shiftNum(10.3, 5.2), -5.2), 10.3);
  assert.equal(L.shiftNum(0.1, 0.2), 0.3); // 不是 0.30000000000000004
  const v = 1 / 3;
  assert.ok(Math.abs(L.shiftNum(L.shiftNum(v, 5.2), -5.2) - v) < 1e-9);
});

test('挪一笔的点：新的数组，只改 x、y，轻重、时刻照旧；原来的不动', () => {
  const pts = [[10.3, 20.1, 0.42, 0], [11.7, 21.9, 0.5, 16], [13, 23, 0.61, 40]];
  const keep = clone(pts);
  const moved = L.shiftPts(pts, 100.4, -7.3);
  assert.notEqual(moved, pts);
  assert.deepEqual(pts, keep);
  assert.deepEqual(moved, [[110.7, 12.8, 0.42, 0], [112.1, 14.6, 0.5, 16], [113.4, 15.7, 0.61, 40]]);
  assert.deepEqual(L.shiftPts(moved, -100.4, 7.3), keep);
});

test('挪 SVG 路径：M L Q C 两两成对；H V；A 只挪终点；开头的 m 只挪第一对；相对的不挪；挪回去一样', () => {
  assert.equal(L.shiftPath('M10 20 Q30 40 50 60', 5, -3), 'M15 17 Q35 37 55 57');
  assert.equal(L.shiftPath('M10.5 20 L30 40 C1 2 3 4 5 6', 1, 1), 'M11.5 21 L31 41 C2 3 4 5 6 7');
  assert.equal(L.shiftPath('M0 0 H50 V20 Z', 10, 100), 'M10 100 H60 V120 Z');
  assert.equal(L.shiftPath('M0 0 A5 5 0 1 0 10 10', 1, 2), 'M1 2 A5 5 0 1 0 11 12');
  assert.equal(L.shiftPath('m10 10 5 5 l3 3', 1, 2), 'm11 12 5 5 l3 3');
  assert.equal(L.shiftPath('M1 2 3 4', 10, 20), 'M11 22 13 24'); // M 后面接着的几对是隐含的 L（绝对）
  assert.equal(L.shiftPath('M-5.5 -3 L-1 -2', 0.5, 0.5), 'M-5 -2.5 L-0.5 -1.5');
  // 页面生成的样子：sketchLine 连着两段
  const d = 'M120.3 40.1 Q170.2 38.9 220.4 41.2 M121 45 Q171.1 44.6 219.8 46.3';
  const there = L.shiftPath(d, 137.6, -42.3);
  assert.equal(L.shiftPath(there, -137.6, 42.3), d);
  assert.equal(L.shiftPath('', 1, 1), '');
});

test('挪 Claude 的一条东西：每一种坐标字段都挪，共用一个数组的字段不挪两次，别的字段不动，挪回去和原来一样', () => {
  const v = [300, 100, 380, 140];
  const a = {
    id: 'x1', type: 'node', text: '新概念', on: ['s1'], t: 5, req: 'r1',
    box: v, vbox: v, sym: v, hit: [290.5, 95, 390, 150], labelOf: [10, 20, 30, 40],
    lay: { x: 302, y: 105, w: 76, h: 30, lines: ['新概念'], fs: 22, lh: 28 },
    paths: [{ d: 'M300 120 C310 100 370 100 380 120', cls: 'dash', w: 2 }, { d: 'M300 120 Q250 150 200 160', cls: 'dash', w: 1.8 }],
    marks: [{ id: 'm1', blk: 'a', pts: [[5, 6, 0.5, 0]] }], sheet: { w: 440, h: 100, blocks: [] },
  };
  const b0 = clone(a);
  L.shiftItem(a, 20, -10);
  assert.deepEqual(a.box, [320, 90, 400, 130]);
  assert.deepEqual(a.vbox, [320, 90, 400, 130]); // 和 box 原来是同一个数组：只挪了一次
  assert.deepEqual(a.sym, [320, 90, 400, 130]);
  assert.deepEqual(a.hit, [310.5, 85, 410, 140]);
  assert.deepEqual(a.labelOf, [30, 10, 50, 30]);
  assert.deepEqual([a.lay.x, a.lay.y, a.lay.w, a.lay.h, a.lay.lines], [322, 95, 76, 30, ['新概念']]);
  assert.equal(a.paths[0].d, 'M320 110 C330 90 390 90 400 110');
  assert.equal(a.paths[1].d, 'M320 110 Q270 140 220 150');
  assert.deepEqual([a.paths[0].cls, a.paths[0].w], ['dash', 2]);
  assert.deepEqual(a.marks, b0.marks); // 卡片里的坐标：不挪
  assert.deepEqual(a.sheet, b0.sheet);
  for (const k of ['id', 'type', 'text', 'on', 't', 'req']) assert.deepEqual(a[k], b0[k]);
  L.shiftItem(a, -20, 10);
  assert.deepEqual(a, b0);

  // 圈号（长回答）：圆心 at；短批注收成的卡片带着原来那条（from）和换算（fromMap）
  const w = { id: 'w1', type: 'write', text: '长回答', on: ['s1'], n: 2, at: [512.4, 88], seen: true,
    from: { id: 'w1', type: 'note', lay: { x: 400, y: 60, w: 100, h: 37, lines: ['一句'], fs: 21, lh: 29 }, box: [10, 10, 50, 50], hit: [394, 56, 506, 101],
      paths: [{ d: 'M50 30 Q200 40 396 70', cls: 'leader', w: 1.3 }], dot: { at: [60, 30], t: 1, why: 'ink' } },
    fromMap: { x0: 392, y0: 54, w: 120, h: 50, u: 1 } };
  const w0 = clone(w);
  L.shiftItem(w, -12.4, 30);
  assert.deepEqual(w.at, [500, 118]);
  assert.deepEqual([w.from.lay.x, w.from.lay.y], [387.6, 90]);
  assert.deepEqual(w.from.box, [-2.4, 40, 37.6, 80]);
  assert.equal(w.from.paths[0].d, 'M37.6 60 Q187.6 70 383.6 100');
  assert.deepEqual(w.from.dot.at, [47.6, 60]);
  assert.deepEqual([w.fromMap.x0, w.fromMap.y0, w.fromMap.w, w.fromMap.u], [379.6, 84, 120, 1]);
  L.shiftItem(w, 12.4, -30);
  assert.deepEqual(w, w0);

  // 小蓝点：dot.at，浮出小卡片的换算 popMap；示意图、图：labels、fig
  const n = { id: 'n1', type: 'note', on: ['s1'], dot: { at: [100, 200], t: 9, why: 'ink', by: 's9' }, popMap: { x0: 90, y0: 190, w: 200, h: 80, u: 1 },
    lay: { x: 110, y: 210, w: 150, h: 37 }, box: [1, 2, 3, 4], hit: [104, 206, 266, 251], paths: [] };
  L.shiftItem(n, 1, 2);
  assert.deepEqual([n.dot.at, n.dot.by, n.popMap.x0, n.popMap.y0, n.popMap.w], [[101, 202], 's9', 91, 192, 200]);
  const f = { id: 'f1', type: 'figure', fig: { x: 48, y: 100, w: 600, h: 400 }, labels: [{ x: 300, y: 508, w: 80, text: '图注', fs: 20 }], hit: [40, 92, 656, 544] };
  L.shiftItem(f, 10, 20);
  assert.deepEqual([f.fig, f.labels[0]], [{ x: 58, y: 120, w: 600, h: 400 }, { x: 310, y: 528, w: 80, text: '图注', fs: 20 }]);
  // 摊在纸上的长回答（2026-11-17）：spread 的 x、y 和细线 lead 都挪；每一行的相对位置、大小不动；圈号的位置 at 也挪
  const sp = { id: 's', type: 'write', at: [500, 100], spread: { x: 400, y: 80, w: 200, h: 66, side: 'right', by: 'auto', rows: [{ y: 0, h: 29, w: 120, t: '一行' }], lead: 'M380 90 Q390 90 398 92' } };
  const sp0 = clone(sp);
  L.shiftItem(sp, 10, -5);
  assert.deepEqual([sp.at, sp.spread.x, sp.spread.y, sp.spread.lead, sp.spread.rows, sp.spread.w], [[510, 95], 410, 75, 'M390 85 Q400 85 408 87', sp0.spread.rows, 200]);
  L.shiftItem(sp, -10, 5);
  assert.deepEqual(sp, sp0);
  // 不认识的、坏的字段：不动、不报错
  const odd ={ id: 'o', type: 'circle', box: [1, 2, 3], lay: { x: 'a', y: 1 }, at: [1], paths: [null, { cls: 'x' }] };
  const odd0 = clone(odd);
  L.shiftItem(odd, 5, 5);
  assert.deepEqual(odd, odd0);
});

test('带坐标的字段取下来、放回去：深拷贝；不是一位小数的坐标挪过去再放回原样，分毫不差；多出来、少了的字段也照原样', () => {
  const a = { id: 'a1', type: 'arrow', on: ['s1'], on2: ['s2'], text: '推出', box: [10.123456789, 20, 30, 40], hit: [1, 2, 3, 4],
    lay: { x: 123.45678901234, y: 77.7777777, w: 50, h: 24, lines: ['推出'] }, paths: [{ d: 'M1.25 2 Q3 4 5 6', w: 2 }, { d: 'M7 8 L9 10' }], sym: undefined };
  const a0 = clone(a), pre = L.fieldsOf(a);
  assert.deepEqual(Object.keys(pre), ['box', 'hit', 'lay', 'paths']); // 只取带坐标的字段（text、on 这些不取；值是 undefined 的当没有）
  assert.deepEqual(pre, { box: a.box, hit: a.hit, lay: a.lay, paths: a.paths });
  assert.notEqual(pre.lay, a.lay); // 是拷贝
  assert.deepEqual(clone(a), a0);  // 取的时候不改它
  L.shiftItem(a, 137.6, -0.7);
  const post = L.fieldsOf(a);
  L.shiftItem(a, -137.6, 0.7);
  assert.notEqual(JSON.stringify(a), JSON.stringify(a0)); // 加了又减：最后一位差了（这就是要照原样放回去的原因）
  L.putFields(a, pre);
  assert.deepEqual(clone(a), a0);
  L.putFields(a, post);
  assert.deepEqual(L.fieldsOf(a), post);
  // 放回去的是拷贝：之后改它身上的，快照不跟着变
  L.putFields(a, pre);
  a.lay.x = 1;
  assert.equal(pre.lay.x, 123.45678901234);
  // 快照里没有的带坐标字段从它身上拿掉，有的加上；别的字段不动
  const n = { id: 'n', type: 'note', text: '一句', box: [1, 2, 3, 4], lay: { x: 5, y: 6 }, paths: [{ d: 'M1 2 Q3 4 5 6', cls: 'leader' }] };
  L.putFields(n, { box: [1, 2, 3, 4], lay: { x: 5, y: 9 }, paths: [], hit: [0, 0, 1, 1] });
  assert.deepEqual(n, { id: 'n', type: 'note', text: '一句', box: [1, 2, 3, 4], lay: { x: 5, y: 9 }, paths: [], hit: [0, 0, 1, 1] });
  L.putFields(n, { box: [1, 2, 3, 4] });
  assert.deepEqual(n, { id: 'n', type: 'note', text: '一句', box: [1, 2, 3, 4] });
  assert.deepEqual(L.FIELDS, ['box', 'vbox', 'hit', 'sym', 'labelOf', 'at', 'lay', 'fig', 'labels', 'paths', 'dot', 'popMap', 'fromMap', 'from', 'spread']); // spread：摊在纸上的长回答（2026-11-17）
});

test('哪几条怎么跟着走：指着的、没擦掉的笔迹全在选中的里面才整条走；箭头、连线两头分开看', () => {
  const sel = new Set(['a', 'b']), live = new Set(['a', 'b', 'c']);
  const M = (a, f) => L.followMode(a, sel, live, f);
  assert.equal(M({ type: 'note', on: ['a'] }), 'go');
  assert.equal(M({ type: 'note', on: ['a', 'b'] }), 'go');
  assert.equal(M({ type: 'note', on: ['a', 'c'] }), '');      // 还指着别的笔迹
  assert.equal(M({ type: 'note', on: ['a', 'gone'] }), 'go'); // 指着的另一笔擦掉了、不在了：只看还在的
  assert.equal(M({ type: 'note', on: ['gone'] }), '');        // 指着的都没了（纸上本来就不画）
  assert.equal(M({ type: 'note' }), '');                      // 没指着笔迹（box、页面末尾）
  assert.equal(M({ type: 'write', on: [] }), '');
  assert.equal(M({ type: 'suggest', on: ['a'], onDoc: true }), ''); // 指着书页上的印刷文字
  assert.equal(M({ type: 'proposal', on: ['a'] }), '');
  // 箭头、连线：终点 on、起点 on2
  assert.equal(M({ type: 'arrow', on: ['b'], on2: ['a'] }), 'go');        // 两头都选中：整条走
  assert.equal(M({ type: 'arrow', on: ['c'], on2: ['a'] }), 'from');      // 只有起点那头选中
  assert.equal(M({ type: 'arrow', on: ['a'], on2: ['c'] }), 'to');        // 只有终点那头选中
  assert.equal(M({ type: 'link', on: ['b'], on2: ['c'] }), 'to');
  assert.equal(M({ type: 'link', on: ['c'], on2: ['b'] }), 'from');
  assert.equal(M({ type: 'arrow', on: ['a'] }), 'to');                    // 起点指着印刷文字（没记笔迹）：那头不动
  assert.equal(M({ type: 'arrow', on2: ['a'] }), 'from');
  assert.equal(M({ type: 'arrow', on: ['a', 'c'], on2: ['b'] }), 'from'); // 终点那组只选中了一部分：终点不动
  assert.equal(M({ type: 'arrow', on: ['a', 'c'], on2: ['c'] }), '');
  assert.equal(M({ type: 'arrow', on: ['c'], on2: ['c'] }), '');
  assert.equal(M({ type: 'arrow' }), '');
  assert.equal(M({ type: 'arrow', on: ['a', 'gone'], on2: ['c'] }), 'to'); // 擦掉了的不算
  // 概念图上建议的新概念：连线的那一头也要在选中的里面
  const node = { type: 'node', on: ['a'], paths: [{ d: 'M0 0 C1 1 2 2 3 3' }, { d: 'M10 10 Q20 20 30 40' }] };
  assert.equal(M(node, (p) => p[0] === 30 && p[1] === 40), 'go');
  assert.equal(M(node, () => false), '');
  assert.equal(M(node), '');
  assert.equal(M({ type: 'node', on: ['a'], paths: [{ d: 'M0 0 C1 1 2 2 3 3' }] }), 'go'); // 没有连线
  assert.deepEqual(L.linkEnds(node), [[30, 40]]);
});

// 照 app.js 的 arrowPaths 造一条箭头（同一个算法，抄一份对着查；bow 的正负 sign 代替随机数）
function arrowGeo(p1, p2, sign) {
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, bow = len * 0.12 * sign;
  const r = (v) => Math.round(v * 10) / 10;
  const c = [(p1[0] + p2[0]) / 2 + nx * bow, (p1[1] + p2[1]) / 2 + ny * bow];
  const ang = Math.atan2(p2[1] - c[1], p2[0] - c[0]), hl = 15;
  const h1 = [p2[0] - hl * Math.cos(ang - 0.45), p2[1] - hl * Math.sin(ang - 0.45)], h2 = [p2[0] - hl * Math.cos(ang + 0.45), p2[1] - hl * Math.sin(ang + 0.45)];
  const lx = (p1[0] + p2[0]) / 2 + nx * (bow / 2 + 14 * Math.sign(bow)), ly = (p1[1] + p2[1]) / 2 + ny * (bow / 2 + 14 * Math.sign(bow));
  return { shaft: `M${r(p1[0])} ${r(p1[1])} Q${r(c[0])} ${r(c[1])} ${r(p2[0])} ${r(p2[1])}`, head: `M${r(h1[0])} ${r(h1[1])} L${r(p2[0])} ${r(p2[1])} L${r(h2[0])} ${r(h2[1])}`, lx, ly };
}
const ptsOf = (d) => (String(d).match(/-?\d*\.?\d+/g) || []).map(Number);
const near = (u, v, e = 0.11) => Math.abs(u - v) <= e;
const sameLine = (d, e, tol, msg) => { const u = ptsOf(d), v = ptsOf(e); assert.equal(u.length, v.length, msg); u.forEach((x, i) => assert.ok(near(x, v[i], tol), `${msg}：${d} 对 ${e}`)); };

test('箭头只有一头跟着走：那一头挪过去，另一头一点不动；和照 arrowPaths 在新的两头上重画的一样；挪回来回到原样', () => {
  const g = arrowGeo([100, 100], [300, 100], 1);
  const a = { id: 'a', type: 'arrow', on: ['t'], on2: ['f'], text: '推出', box: [300, 80, 360, 120], paths: [{ d: g.shaft, w: 2 }, { d: g.head, w: 2 }],
    hit: [90, 90, 310, 110], lay: { x: g.lx, y: g.ly - 18, w: 200, h: 24, lines: ['推出'], fs: 18, lh: 24 } };
  const a0 = clone(a);
  assert.equal(L.bendItem(a, 'to', 0, 200), true);
  const s = L.shaftOf(a);
  assert.deepEqual(s.p1, [100, 100]); // 起点不动
  assert.deepEqual(s.p2, [300, 300]); // 终点挪了 (0, 200)
  const g2 = arrowGeo([100, 100], [300, 300], 1);
  sameLine(a.paths[0].d, g2.shaft, 0.11, '线身');
  sameLine(a.paths[1].d, g2.head, 0.2, '箭头');
  assert.ok(near(a.lay.x, g2.lx, 0.2) && near(a.lay.y, g2.ly - 18, 0.2), JSON.stringify([a.lay, g2.lx, g2.ly])); // 关系词跟着线的中段
  assert.deepEqual(a.box, [300, 280, 360, 320]); // 箭头的 box 是终点那块：跟着终点走
  assert.deepEqual(a.hit, [90, 90, 310, 310]);   // 首尾外面 10
  assert.deepEqual([a.paths[0].w, a.paths[1].w, a.text, a.on, a.on2, a.lay.w, a.lay.lines], [2, 2, '推出', ['t'], ['f'], 200, ['推出']]);
  // 挪回来：回到原样（数字差不过 0.1；箭头、关系词差不过 0.2）
  L.bendItem(a, 'to', 0, -200);
  sameLine(a.paths[0].d, a0.paths[0].d, 0.11, '挪回来的线身');
  sameLine(a.paths[1].d, a0.paths[1].d, 0.2, '挪回来的箭头');
  assert.ok(near(a.lay.x, a0.lay.x, 0.2) && near(a.lay.y, a0.lay.y, 0.2));
  assert.deepEqual(a.box, a0.box);

  // 起点那头跟着走：终点、终点那块不动；箭头跟着线的走向转
  const b = clone(a0);
  L.bendItem(b, 'from', -100, 50);
  const t = L.shaftOf(b), g3 = arrowGeo([0, 150], [300, 100], 1);
  assert.deepEqual([t.p1, t.p2], [[0, 150], [300, 100]]);
  sameLine(b.paths[0].d, g3.shaft, 0.11, '起点挪了的线身');
  sameLine(b.paths[1].d, g3.head, 0.2, '起点挪了的箭头');
  assert.deepEqual(b.box, a0.box);
  // 弯向另一边的照样弯向另一边；没有关系词、没有 box 的也行
  const gn = arrowGeo([100, 100], [300, 100], -1), n = { type: 'arrow', paths: [{ d: gn.shaft }, { d: gn.head }], hit: [0, 0, 1, 1] };
  L.bendItem(n, 'to', 0, 200);
  sameLine(n.paths[0].d, arrowGeo([100, 100], [300, 300], -1).shaft, 0.11, '弯向另一边');
  // 换成新的数组、对象：原来的那几个不变
  const c = clone(a0), keep = { paths: c.paths, p0: c.paths[0], lay: c.lay, box: c.box, hit: c.hit };
  L.bendItem(c, 'to', 10, 10);
  assert.deepEqual([keep.paths, keep.p0, keep.lay, keep.box, keep.hit], [a0.paths, a0.paths[0], a0.lay, a0.box, a0.hit]);
  // 认不出的线：不改，返回 false
  const odd = { type: 'arrow', paths: [{ d: 'M1 2 C3 4 5 6 7 8' }], box: [1, 2, 3, 4] }, odd0 = clone(odd);
  assert.equal(L.bendItem(odd, 'to', 5, 5), false);
  assert.deepEqual(odd, odd0);
  assert.equal(L.bendItem({ type: 'arrow' }, 'to', 5, 5), false);
  assert.equal(L.bendItem(clone(a0), 'go', 5, 5), false);
});

test('概念图上建议的连线只有一头跟着走：关系词连同 ✓ × 钮围着的框按新线排；点、擦的范围连着关系词那块', () => {
  const g = arrowGeo([100, 100], [300, 100], 1), w = 44, h = 30;
  const spot = (geo, p1, p2) => { // 照 buildMap 排关系词：弯线中点外侧，按字的宽高再让开（抄一份对着查）
    const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2, Lh = Math.hypot(geo.lx - mx, geo.ly - my), u = [(geo.lx - mx) / Lh, (geo.ly - my) / Lh];
    const k = -14 + 8 + Math.abs(u[0]) * w / 2 + Math.abs(u[1]) * h / 2;
    return [geo.lx + u[0] * k, geo.ly + u[1] * k];
  };
  const c0 = spot(g, [100, 100], [300, 100]), lay = { x: c0[0] - w / 2, y: c0[1] - h / 2, w, h, lines: ['导致'], fs: 20, lh: 26 };
  const v = [lay.x - 6, lay.y - 4, lay.x + w + 6, lay.y + h + 4].map((x) => Math.round(x * 10) / 10);
  const a = { id: 'k', type: 'link', on: ['t'], on2: ['f'], text: '导致', box: v, vbox: v, paths: [{ d: g.shaft, cls: 'dash', w: 2 }, { d: g.head, w: 2 }], lay,
    hit: [Math.min(90, v[0]), Math.min(90, v[1]), Math.max(310, v[2]), Math.max(110, v[3])] };
  L.bendItem(a, 'from', 0, -200);
  const g2 = arrowGeo([100, -100], [300, 100], 1), c2 = spot(g2, [100, -100], [300, 100]);
  sameLine(a.paths[0].d, g2.shaft, 0.11, '连线');
  assert.equal(a.paths[0].cls, 'dash');
  assert.ok(near(a.lay.x, c2[0] - w / 2, 0.2) && near(a.lay.y, c2[1] - h / 2, 0.2), JSON.stringify([a.lay, c2]));
  const v2 = [a.lay.x - 6, a.lay.y - 4, a.lay.x + w + 6, a.lay.y + h + 4];
  a.vbox.forEach((x, i) => assert.ok(near(x, v2[i], 0.2), JSON.stringify([a.vbox, v2])));
  assert.deepEqual(a.box, a.vbox);
  assert.notEqual(a.box, a.vbox); // 两个各是各的数组
  assert.deepEqual(a.hit, [Math.min(90, a.vbox[0]), Math.min(-110, a.vbox[1]), Math.max(310, a.vbox[2]), Math.max(110, a.vbox[3])]);
});

test('拖动夹在纸内：到纸边为止；本来就出了纸边的那一边不再往外，也不拉回来', () => {
  const paper = [0, 0, 1000, 1400];
  assert.deepEqual(L.clampDelta([100, 100, 200, 200], paper, 50, -30), [50, -30]);
  assert.deepEqual(L.clampDelta([100, 100, 200, 200], paper, 5000, 5000), [800, 1200]);
  assert.deepEqual(L.clampDelta([100, 100, 200, 200], paper, -5000, -5000), [-100, -100]);
  assert.deepEqual(L.clampDelta([-20, 100, 200, 200], paper, -50, 0), [0, 0]);     // 左边本来就出了纸：不再往左
  assert.deepEqual(L.clampDelta([-20, 100, 200, 200], paper, 30, 0), [30, 0]);    // 往右照常
  assert.deepEqual(L.clampDelta([-20, 100, 1100, 200], paper, 30, 0), [0, 0]);    // 比纸还宽：左右都不动
});

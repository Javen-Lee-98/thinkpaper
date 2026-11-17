// static/lasso.js 的测试：node --test tests/test_lasso.mjs
// 套索里的纯计算：点在不在圈里（按绕数，绕两圈、8 字都算里面）、哪几笔被圈中（一半以上的点在圈里；擦掉的不算）、
// 挪一笔的点（只改 x、y，挪过去再挪回来分毫不差）、挪 SVG 路径、挪 Claude 的一条东西（每一种坐标字段）、哪几条跟着走、拖动夹在纸内。
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
  // 不认识的、坏的字段：不动、不报错
  const odd = { id: 'o', type: 'circle', box: [1, 2, 3], lay: { x: 'a', y: 1 }, at: [1], paths: [null, { cls: 'x' }] };
  const odd0 = clone(odd);
  L.shiftItem(odd, 5, 5);
  assert.deepEqual(odd, odd0);
});

test('坐标取下来、放回去：不是一位小数的坐标挪过去再放回原数，分毫不差；先后和挪的时候一样', () => {
  const a = { id: 'a1', type: 'arrow', on: ['s1'], on2: ['s2'], box: [10.123456789, 20, 30, 40], hit: [1, 2, 3, 4],
    lay: { x: 123.45678901234, y: 77.7777777, w: 50, h: 24, lines: ['推出'] }, paths: [{ d: 'M1.25 2 Q3 4 5 6', w: 2 }, { d: 'M7 8 L9 10' }] };
  const a0 = clone(a), pre = L.coordsOf(a);
  assert.deepEqual(pre, [10.123456789, 20, 30, 40, 1, 2, 3, 4, 123.45678901234, 77.7777777, 'M1.25 2 Q3 4 5 6', 'M7 8 L9 10']);
  assert.deepEqual(a, a0); // 取的时候不改它
  L.shiftItem(a, 137.6, -0.7);
  const post = L.coordsOf(a);
  L.shiftItem(a, -137.6, 0.7);
  assert.notEqual(JSON.stringify(a), JSON.stringify(a0)); // 加了又减：最后一位差了（这就是要照原数放回去的原因）
  L.putCoords(a, pre);
  assert.deepEqual(a, a0);
  L.putCoords(a, post);
  assert.deepEqual(L.coordsOf(a), post);
});

test('哪几条跟着走：指着的、没擦掉的笔迹全在选中的里面才跟', () => {
  const sel = new Set(['a', 'b']), live = new Set(['a', 'b', 'c']);
  assert.equal(L.follows({ type: 'note', on: ['a'] }, sel, live), true);
  assert.equal(L.follows({ type: 'note', on: ['a', 'b'] }, sel, live), true);
  assert.equal(L.follows({ type: 'note', on: ['a', 'c'] }, sel, live), false);  // 还指着别的笔迹
  assert.equal(L.follows({ type: 'note', on: ['a', 'gone'] }, sel, live), true); // 指着的另一笔擦掉了、不在了：只看还在的
  assert.equal(L.follows({ type: 'note', on: ['gone'] }, sel, live), false);     // 指着的都没了（纸上本来就不画）
  assert.equal(L.follows({ type: 'note' }, sel, live), false);                   // 没指着笔迹（box、页面末尾）
  assert.equal(L.follows({ type: 'write', on: [] }, sel, live), false);
  assert.equal(L.follows({ type: 'arrow', on: ['b'], on2: ['a'] }, sel, live), true);
  assert.equal(L.follows({ type: 'arrow', on: ['c'], on2: ['a'] }, sel, live), false);
  assert.equal(L.follows({ type: 'suggest', on: ['a'], onDoc: true }, sel, live), false); // 指着书页上的印刷文字
  assert.equal(L.follows({ type: 'proposal', on: ['a'] }, sel, live), false);
  // 概念图上建议的新概念：连线的那一头也要在选中的里面
  const node = { type: 'node', on: ['a'], paths: [{ d: 'M0 0 C1 1 2 2 3 3' }, { d: 'M10 10 Q20 20 30 40' }] };
  assert.equal(L.follows(node, sel, live, (p) => p[0] === 30 && p[1] === 40), true);
  assert.equal(L.follows(node, sel, live, () => false), false);
  assert.equal(L.follows(node, sel, live), false);
  assert.equal(L.follows({ type: 'node', on: ['a'], paths: [{ d: 'M0 0 C1 1 2 2 3 3' }] }, sel, live), true); // 没有连线
  assert.deepEqual(L.linkEnds(node), [[30, 40]]);
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

// static/brush.js 的测试：node --test tests/test_brush.mjs
// 平板上显示笔迹用的笔触（用户在试写页上选定的「笔触 1、细」）。查：线是顺的（点很稀也不是折线）；
// 主体比原来的画法粗（才黑），从头到尾一样粗、不看快慢；起笔不收，抬笔后收笔略尖、写的时候不收；报轻重的笔照样分粗细；
// 一个点画成圆点、拐急弯补圆点；SVG 的轮廓和 canvas 的一样。合不合手感测不了，要人在平板上写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const B = require('../static/brush.js');

const BASE = 2.1, FLAT = 0.12; // 笔的基本粗细（笔迹数据里的 w）；用户的笔每个点的轻重都是 0.12
const OLD = BASE * (0.45 + 0.9 * FLAT); // 原来的画法这样的笔实际多粗（约 1.17；app.js 的 penWidth，发给 Claude 的图还用它）
// 一条横线：从 x0 到 x1，每隔 step 一个点，每个点隔 dt 毫秒，轻重 pr
const hline = (x0, x1, step, dt, pr = FLAT) => Array.from({ length: Math.round((x1 - x0) / step) + 1 }, (_, i) => [x0 + i * step, 200, pr, i * dt]);
// 半径 r 的四分之一圆，只取 n 段（点很稀）
const arc = (r, n, dt = 16) => Array.from({ length: n + 1 }, (_, i) => { const a = (i / n) * Math.PI / 2; return [300 + r * Math.cos(a), 300 + r * Math.sin(a), FLAT, i * dt]; });
const mid = (line) => line[Math.floor(line.length / 2)];
const done = (pts) => B.taper(B.centerline(pts, BASE), true);
const NORMAL = () => hline(100, 300, 2.4, 16); // 0.15 单位/毫秒：平常写字的快慢
const FAST = () => hline(100, 300, 8, 16);     // 0.5：甩出去
const SLOW = () => hline(100, 300, 0.5, 16);   // 0.03：很慢

test('选定的是「笔触 1、细」：主体 0.85 × 0.8 倍、收笔最细处 0.55、最长 5 个单位', () => {
  assert.ok(Math.abs(B.PEN.w - 0.85 * 0.8) < 1e-9, String(B.PEN.w));
  assert.equal(B.PEN.outTip, 0.55);
  assert.equal(B.PEN.outLen, 5);
  assert.deepEqual(Object.keys(B).sort(), ['PEN', 'centerline', 'draw', 'outline', 'svgPath', 'taper'], '没选中的候选、对照用的旧画法都删了');
});

test('点很稀的弧线画出来是弯的，不是折线', () => {
  const r = 100, pts = arc(r, 4); // 四分之一圆只有 5 个点，相邻两点之间的直线离圆弧最远约 1.9
  const chordGap = r * (1 - Math.cos(Math.PI / 16));
  const line = B.centerline(pts, BASE);
  const worst = Math.max(...line.map((o) => Math.abs(Math.hypot(o.x - 300, o.y - 300) - r)));
  assert.ok(chordGap > 1.8, '这个例子里折线本来会偏 ' + chordGap);
  assert.ok(worst < 0.6, '中心线离真正的圆弧最远 ' + worst);
  assert.ok(line.length > 60, '中心线取的点够密：' + line.length);
  for (let i = 2; i < line.length; i++) { // 相邻三点的拐角都很小
    const a = line[i - 2], b = line[i - 1], c = line[i];
    const d1 = Math.hypot(b.x - a.x, b.y - a.y), d2 = Math.hypot(c.x - b.x, c.y - b.y);
    if (d1 < 1e-6 || d2 < 1e-6) continue;
    const cos = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (d1 * d2);
    assert.ok(cos > 0.995, `第 ${i} 个点处拐得太急：${cos}`);
  }
});

test('不报轻重的笔：主体比原来的画法粗（才黑），从头到尾一样粗，快慢不影响，轻重是哪个固定值都一样', () => {
  const w = mid(done(NORMAL())).w;
  assert.ok(Math.abs(w - BASE * 0.68) < 1e-9, '主体 ' + w);
  assert.ok(w > OLD * 1.2, `主体 ${w}，原来 ${OLD}`);
  const line = done(NORMAL()), L = line[line.length - 1].s;
  for (const o of line) if (L - o.s > 8) assert.ok(Math.abs(o.w - w) < 1e-9, `离收笔 ${L - o.s} 处粗细 ${o.w}`);
  assert.ok(Math.abs(mid(done(SLOW())).w - mid(done(FAST())).w) < 1e-9, '快慢一样粗');
  const a = mid(done(hline(100, 300, 2.4, 16, 0.12))).w, b = mid(done(hline(100, 300, 2.4, 16, 0.5))).w;
  assert.ok(Math.abs(a - b) < 1e-9, `固定 0.12 和固定 0.5 一样粗：${a} ${b}`);
});

test('报轻重的笔：重的地方粗、轻的地方细', () => {
  const pts = Array.from({ length: 84 }, (_, i) => [100 + i * 2.4, 200, i < 42 ? 0.15 : 0.9, i * 16]);
  const line = B.centerline(pts, BASE);
  const light = line[Math.floor(line.length * 0.25)].w, heavy = line[Math.floor(line.length * 0.75)].w;
  assert.ok(heavy > light * 1.4, `轻 ${light}，重 ${heavy}`);
});

test('起笔不收；抬笔后收笔略尖（最细处约主体的 0.55），只占末尾几个单位', () => {
  for (const pts of [NORMAL(), FAST(), SLOW()]) {
    const line = done(pts), m = mid(line).w, L = line[line.length - 1].s;
    assert.ok(Math.abs(line[0].w - m) < 1e-9, `起笔处 ${line[0].w} 和中间 ${m} 一样粗`);
    const end = line[line.length - 1].w;
    assert.ok(end < m * 0.6 && end > m * 0.5, `收笔处 ${end}，中间 ${m}`);
    for (let i = line.length - 4; i < line.length; i++) assert.ok(line[i].w <= line[i - 1].w + 1e-9, '收笔是越来越细的');
    const thin = line.filter((o) => o.w < m - 1e-9);
    assert.ok(L - thin[0].s <= 8 + 1e-9, `变细的只有末尾 ${L - thin[0].s} 个单位`);
  }
});

test('还在写的时候笔尖处不收尖，抬笔后才收', () => {
  const live = B.taper(B.centerline(FAST(), BASE), false), fin = done(FAST());
  assert.ok(Math.abs(live[live.length - 1].w - mid(live).w) < 1e-9, '正在写：笔尖处和中间一样粗');
  assert.ok(fin[fin.length - 1].w < mid(fin).w * 0.6, '抬笔后：收笔处变尖');
  const o1 = B.outline(FAST(), BASE, false), o2 = B.outline(FAST(), BASE, true), n = o1.left.length - 1;
  const width = (o, k) => Math.hypot(o.left[k][0] - o.right[k][0], o.left[k][1] - o.right[k][1]);
  assert.ok(width(o1, n) > width(o2, n) * 1.5, `轮廓末端：写的时候 ${width(o1, n)}，抬笔后 ${width(o2, n)}`);
});

test('收笔的尖长短跟着抬笔的快慢：甩出去的长，顿住的短', () => {
  const taperLen = (pts) => {
    const line = done(pts), full = mid(line).w, L = line[line.length - 1].s;
    return L - line.findLast((o) => o.w > full * 0.97).s; // 从这里往后开始变细
  };
  const a = taperLen(FAST()), b = taperLen(SLOW());
  assert.ok(a > b * 2, `甩出去的 ${a} 比顿住的 ${b} 长得多`);
});

test('轮廓两边到中心线的距离就是半个粗细；一个点画成圆点；拐急弯的地方补了圆点', () => {
  const o = B.outline(NORMAL(), BASE, true), k = Math.floor(o.line.length / 2);
  assert.ok(Math.abs(Math.hypot(o.left[k][0] - o.right[k][0], o.left[k][1] - o.right[k][1]) - o.line[k].w) < 1e-6);
  assert.equal(o.left.length, o.line.length);
  const dot = B.outline([[10, 10, FLAT, 0]], BASE, true);
  assert.equal(dot.left.length, 0);
  assert.equal(dot.dots.length, 1);
  assert.ok(dot.dots[0][2] > OLD / 2, '一个点也比原来的点大');
  const corner = [...hline(100, 160, 4, 8), ...Array.from({ length: 15 }, (_, i) => [160 - (i + 1) * 4, 200 + (i + 1) * 0.5, FLAT, 130 + i * 8])]; // 写过去再折回来
  assert.ok(B.outline(corner, BASE, true).dots.length > 2, '折回来的地方补了圆点');
});

test('只有 x、y 的点（问话卡片的手写那块以前就是这样）也能画，不报错', () => {
  const pts = Array.from({ length: 30 }, (_, i) => [10 + i * 2, 20 + Math.sin(i / 5) * 4]);
  const o = B.outline(pts, 3.8, true);
  assert.ok(o.left.length > 30 && o.left.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])));
});

test('SVG 的路径（卡片上的红字）：身子和圆点在一条路径里，绕向一致（按 nonzero 填实不挖空）', () => {
  const d = B.svgPath(NORMAL(), BASE, true);
  assert.match(d, /^M[\d. ]+ L/);
  assert.ok((d.match(/A/g) || []).length >= 4, '两头的圆头各两段弧');
  assert.ok(!/A[\d.]+ [\d.]+ 0 1 1 /.test(d), '圆都按同一个方向画');
  // 身子的绕向：按 y 朝下的屏幕坐标算有向面积，和 sweep-flag 为 0 的圆一样是负的
  const o = B.outline(NORMAL(), BASE, true), poly = o.left.concat(o.right.slice().reverse());
  let area = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; area += p[0] * q[1] - q[0] * p[1]; }
  assert.ok(area < 0, '身子的有向面积 ' + area);
  const live = B.svgPath(NORMAL(), BASE, false);
  assert.notEqual(live, d, '正写着的（不收尖）和抬笔后的不一样');
  assert.match(B.svgPath([[5, 5, FLAT, 0]], BASE, true), /^M[\d.]+ [\d.]+ A/, '一个点是一个圆');
});

test('draw：抬了笔的记住路径（同一笔再画不重算），点数变了重算；正写着的不记', () => {
  const calls = [];
  class P2D { constructor() { this.ops = 0; } moveTo() { this.ops++; } lineTo() { this.ops++; } closePath() {} arc() { this.ops++; } }
  globalThis.Path2D = P2D;
  delete require.cache[require.resolve('../static/brush.js')];
  const B2 = require('../static/brush.js');
  const ctx = { fill: (p) => calls.push(p), beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {} };
  const pts = NORMAL();
  B2.draw(ctx, pts, BASE, '#000', true);
  const first = calls.slice();
  B2.draw(ctx, pts, BASE, '#000', true);
  assert.equal(calls.length, 4);
  assert.ok(first[0] instanceof P2D && calls[2] === first[0] && calls[3] === first[1], '第二次用的是记下的同一条路径');
  pts.push([302, 200, FLAT, 2000]);
  B2.draw(ctx, pts, BASE, '#000', true);
  assert.ok(calls[4] !== first[0], '点多了一个：重算');
  calls.length = 0;
  B2.draw(ctx, pts, BASE, '#000', false);
  assert.ok(calls.length === 2 && calls.every((c) => c === undefined), '正写着的直接画在 ctx 上，不记');
  delete globalThis.Path2D;
});

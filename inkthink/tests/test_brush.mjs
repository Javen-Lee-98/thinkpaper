// static/brush.js 的测试：node --test tests/test_brush.mjs
// 查：线是顺的（点很稀也不是折线）；两头有笔锋（抬笔后才收尖），中间一大段是足粗的；
// 不报轻重的笔，粗细由快慢来定，而且主体比原来的画法粗（才黑）。合不合手感测不了，要人在平板上写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const B = createRequire(import.meta.url)('../static/brush.js');

const BASE = 2.1, FLAT = 0.12; // 用户的笔每个点的轻重都是 0.12
// 一条横线：从 x0 到 x1，每隔 step 一个点，每个点隔 dt 毫秒，轻重 pr
const hline = (x0, x1, step, dt, pr = FLAT) => Array.from({ length: Math.round((x1 - x0) / step) + 1 }, (_, i) => [x0 + i * step, 200, pr, i * dt]);
// 半径 r 的四分之一圆，只取 n 段（点很稀）
const arc = (r, n, dt = 16) => Array.from({ length: n + 1 }, (_, i) => { const a = (i / n) * Math.PI / 2; return [300 + r * Math.cos(a), 300 + r * Math.sin(a), FLAT, i * dt]; });
const mid = (line) => line[Math.floor(line.length / 2)];
const done = (pts, kind) => B.taper(B.centerline(pts, BASE, kind), kind, true);
const NORMAL = () => hline(100, 300, 2.4, 16); // 0.15 单位/毫秒：平常写字的快慢
const FAST = () => hline(100, 300, 8, 16);     // 0.5：甩出去
const SLOW = () => hline(100, 300, 0.5, 16);   // 0.03：很慢

test('点很稀的弧线画出来是弯的，不是折线', () => {
  const r = 100, pts = arc(r, 4); // 四分之一圆只有 5 个点，相邻两点之间的直线离圆弧最远约 1.9
  const chordGap = r * (1 - Math.cos(Math.PI / 16));
  const line = B.centerline(pts, BASE, 'pen');
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

test('不报轻重的笔：三种笔触的主体都比原来的画法粗，才黑', () => {
  const old = B.pressWidth(BASE, FLAT); // 原来的线实际这么粗（约 1.17）
  for (const kind of ['even', 'pen', 'bold']) {
    const w = mid(done(NORMAL(), kind)).w;
    assert.ok(w > old * 1.3, `${kind}：平常快慢时主体 ${w}，原来 ${old}`);
  }
  assert.ok(mid(done(NORMAL(), 'bold')).w > mid(done(NORMAL(), 'pen')).w * 1.2, '笔触 3 比笔触 2 粗');
  // 就算甩得很快，也不比原来的线细
  for (const kind of ['pen', 'bold']) assert.ok(mid(done(FAST(), kind)).w >= old, `${kind}：很快的地方 ${mid(done(FAST(), kind)).w}`);
});

test('不报轻重的笔：粗细跟着快慢走（慢处粗、快处细）；笔触 1 不看快慢；轻重是哪个固定值都一样', () => {
  for (const kind of ['pen', 'bold']) {
    const s = mid(done(SLOW(), kind)).w, n = mid(done(NORMAL(), kind)).w, f = mid(done(FAST(), kind)).w;
    assert.ok(s > n * 1.3 && n > f * 1.25, `${kind}：慢 ${s}，平常 ${n}，快 ${f}`);
  }
  assert.ok(Math.abs(mid(done(SLOW(), 'even')).w - mid(done(FAST(), 'even')).w) < 1e-6, '笔触 1 快慢一样粗');
  const a = mid(done(hline(100, 300, 2.4, 16, 0.12), 'pen')).w, b = mid(done(hline(100, 300, 2.4, 16, 0.5), 'pen')).w;
  assert.ok(Math.abs(a - b) < 1e-6, `固定 0.12 和固定 0.5 一样粗：${a} ${b}`);
});

test('报轻重的笔：重的地方粗、轻的地方细', () => {
  const pts = Array.from({ length: 84 }, (_, i) => [100 + i * 2.4, 200, i < 42 ? 0.15 : 0.9, i * 16]);
  const line = B.centerline(pts, BASE, 'pen');
  const light = line[Math.floor(line.length * 0.25)].w, heavy = line[Math.floor(line.length * 0.75)].w;
  assert.ok(heavy > light * 1.4, `轻 ${light}，重 ${heavy}`);
});

test('抬笔后两头有笔锋，中间一大段是足粗的', () => {
  for (const kind of ['pen', 'bold']) {
    const line = done(FAST(), kind), m = mid(line).w, L = line[line.length - 1].s;
    assert.ok(line[0].w < m * 0.75, `${kind}：起笔处 ${line[0].w} 比中间 ${m} 细`);
    assert.ok(line[line.length - 1].w < m * 0.4, `${kind}：收笔处 ${line[line.length - 1].w} 比中间细得多`);
    for (let i = 1; i < 4; i++) assert.ok(line[i].w >= line[i - 1].w - 1e-9, `${kind}：入笔是越来越粗的`);
    for (let i = line.length - 4; i < line.length; i++) assert.ok(line[i].w <= line[i - 1].w + 1e-9, `${kind}：收笔是越来越细的`);
    const full = line.filter((o) => o.w > m * 0.95);
    assert.ok(full[full.length - 1].s - full[0].s > L * 0.5, `${kind}：足粗的一段占了一半以上`);
  }
  const e = done(FAST(), 'even');
  assert.ok(Math.abs(e[0].w - mid(e).w) < 1e-6 && e[e.length - 1].w < mid(e).w * 0.8, '笔触 1：起笔不收，收笔略尖');
});

test('很短的一笔（一个点画、一小横）：笔锋按比例缩，中间仍是足粗的', () => {
  const line = done(hline(100, 112, 2.4, 16), 'pen'); // 只有 12 个单位长
  const top = Math.max(...line.map((o) => o.w));
  assert.ok(top > B.pressWidth(BASE, FLAT) * 1.3, '短笔画的主体也比原来粗：' + top);
});

test('还在写的时候笔尖处不收尖，抬笔后才收', () => {
  const live = B.taper(B.centerline(FAST(), BASE, 'pen'), 'pen', false), fin = done(FAST(), 'pen');
  assert.ok(Math.abs(live[live.length - 1].w - mid(live).w) < 0.05, '正在写：笔尖处和中间一样粗');
  assert.ok(fin[fin.length - 1].w < mid(fin).w * 0.4, '抬笔后：收笔处是尖的');
});

test('收笔的笔锋长短跟着抬笔的快慢：甩出去的长，顿住的短', () => {
  const taperLen = (pts) => {
    const line = done(pts, 'pen'), full = mid(line).w, L = line[line.length - 1].s;
    return L - line.findLast((o) => o.w > full * 0.9).s; // 从这里往后开始变细
  };
  const a = taperLen(FAST()), b = taperLen(SLOW());
  assert.ok(a > b * 2, `甩出去的笔锋 ${a} 比顿住的 ${b} 长得多`);
});

test('轮廓两边到中心线的距离就是半个粗细；一个点画成圆点；拐急弯的地方补了圆点', () => {
  const o = B.outline(NORMAL(), BASE, 'pen', true), k = Math.floor(o.line.length / 2);
  assert.ok(Math.abs(Math.hypot(o.left[k][0] - o.right[k][0], o.left[k][1] - o.right[k][1]) - o.line[k].w) < 1e-6);
  assert.equal(o.left.length, o.line.length);
  const dot = B.outline([[10, 10, FLAT, 0]], BASE, 'pen', true);
  assert.equal(dot.left.length, 0);
  assert.equal(dot.dots.length, 1);
  assert.ok(dot.dots[0][2] > B.pressWidth(BASE, FLAT) / 2, '一个点也比原来的点大');
  const corner = [...hline(100, 160, 4, 8), ...Array.from({ length: 15 }, (_, i) => [160 - (i + 1) * 4, 200 + (i + 1) * 0.5, FLAT, 130 + i * 8])]; // 写过去再折回来
  assert.ok(B.outline(corner, BASE, 'pen', true).dots.length > 2, '折回来的地方补了圆点');
});

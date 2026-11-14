// static/gesture.js 的测试：node --test tests/test_gesture.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const G = createRequire(import.meta.url)('../static/gesture.js');

// 沿着几个拐点连成一笔，每段取 n 个点，带一点手抖
function stroke(corners, n = 12, jitter = 0.8) {
  let seed = 7;
  const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 2 * jitter;
  const pts = [];
  for (let i = 0; i < corners.length - 1; i++) {
    const [a, b] = [corners[i], corners[i + 1]];
    for (let k = 0; k < n; k++) pts.push([a[0] + (b[0] - a[0]) * k / n + r(), a[1] + (b[1] - a[1]) * k / n + r()]);
  }
  pts.push(corners[corners.length - 1]);
  return pts;
}
const circle = (cx, cy, rx, ry, n = 48, turn = 1.0) => Array.from({ length: n + 1 }, (_, i) => {
  const t = (i / n) * Math.PI * 2 * turn;
  return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
});

test('打勾：短短往下，再长长往右上', () => {
  assert.equal(G.classify(stroke([[100, 100], [112, 116], [140, 76]])), 'tick');
  assert.equal(G.classify(stroke([[10, 40], [18, 52], [46, 10]], 8, 1.5)), 'tick');
});

test('横划：又长又扁', () => {
  assert.equal(G.classify(stroke([[100, 200], [220, 204]])), 'strike');
  assert.equal(G.classify(stroke([[100, 200], [160, 196], [230, 203]])), 'strike');
});

test('叉的两笔：各自是斜线，并且交叉', () => {
  const a = stroke([[100, 100], [140, 140]]), b = stroke([[140, 100], [100, 140]]);
  assert.equal(G.classify(a), 'diag');
  assert.equal(G.classify(b), 'diag');
  assert.ok(G.crosses(a, b));
  assert.ok(!G.crosses(a, stroke([[200, 100], [240, 140]])));
});

test('星号：一笔五个角，首尾接上', () => {
  const R = 30, star = [];
  for (let k = 0; k <= 5; k++) {
    const t = -Math.PI / 2 + k * (4 * Math.PI / 5);
    star.push([200 + R * Math.cos(t), 200 + R * Math.sin(t)]);
  }
  assert.equal(G.classify(stroke(star, 10, 0.6)), 'star');
});

// 红笔画闭合圈当发送范围的做法删了（2026-11-12）：圈不再是手势，画的圈就是一笔普通的字
test('闭合圈不是手势：大圈、扁圈、小圈都照常当笔迹', () => {
  assert.equal(G.classify(circle(300, 300, 120, 70)), null);
  assert.equal(G.classify(circle(300, 300, 120, 70, 48, 1.05)), null);     // 多画了一点
  for (const [rx, ry] of [[150, 50], [200, 40], [300, 60]]) {               // 圈一行字的扁圈，从哪儿起笔都一样
    for (const a0 of [0, 1, Math.PI / 2]) {
      const pts = circle(300, 300, rx, ry, 48).map((_, i, all) => all[(i + Math.round((a0 / (Math.PI * 2)) * 48)) % 48]);
      assert.equal(G.classify(pts.concat([pts[0]])), null, `${rx}×${ry} 从 ${a0} 起笔`);
    }
  }
  assert.equal(G.classify(circle(300, 300, 14, 26)), null);                 // 写的 0
});

test('普通书写不当手势', () => {
  assert.equal(G.classify(stroke([[0, 0], [2, 3]])), null);                                   // 一个点
  assert.equal(G.classify(stroke([[100, 100], [100, 160]])), null);                            // 一竖
  assert.equal(G.classify(stroke([[100, 100], [130, 90], [110, 130], [150, 120], [120, 160]])), null); // 弯弯绕绕的字
  assert.equal(G.classify(circle(300, 300, 12, 12)), null);                                    // 小圈（像字母 o）
  assert.equal(G.classify(stroke([[100, 100], [130, 130], [160, 100]])), null);                 // V 字两边一样高
  assert.equal(G.classify(stroke([[100, 120], [160, 80], [220, 120]])), null);                  // 一道拱
});

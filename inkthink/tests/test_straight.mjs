// static/straight.js 的测试：node --test tests/test_straight.mjs
// 画线停住变直里的纯计算：够不够格变直（又长又差不多直；弯的、短的、来回描的、绕圈的不行）、吸水平 / 竖直、定下来存成哪些点。
// 什么时候算停住（定时器）、变直后终点跟笔、开关，在浏览器测试 tests/browser/straight.mjs 里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const Z = createRequire(import.meta.url)('../static/straight.js');

// 从 a 到 b 的 n 段，每个点 [x, y, 轻重, 毫秒]；wob 是左右晃的幅度（垂直于线，一笔里慢慢地左右晃一个半来回）
function seg(a, b, n = 40, wob = 0, pr = 0.12, dt = 16, t0 = 0) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
  return Array.from({ length: n + 1 }, (_, i) => {
    const u = i / n, w = wob * Math.sin(u * Math.PI * 3);
    return [a[0] + dx * u + nx * w, a[1] + dy * u + ny * w, pr, t0 + i * dt];
  });
}
// 弦从 a 到 b、拱高 h 的一段弧
function bow(a, b, h, n = 40) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
  return Array.from({ length: n + 1 }, (_, i) => { const u = i / n, w = 4 * h * u * (1 - u); return [a[0] + dx * u + nx * w, a[1] + dy * u + ny * w, 0.12, i * 16]; });
}
const circle = (cx, cy, r, n = 48) => Array.from({ length: n + 1 }, (_, i) => { const t = (i / n) * Math.PI * 2; return [cx + r * Math.cos(t), cy + r * Math.sin(t), 0.12, i * 16]; });
const join = (...parts) => { const out = []; let t = 0; for (const p of parts) for (const q of (out.length ? p.slice(1) : p)) out.push([q[0], q[1], q[2], t += 16]); out[0][3] = 0; return out; };
function distToLine(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1]; return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.hypot(dx, dy); }

test('门槛：停住半秒、5 个屏幕像素；长至少 80；偏离不超过 12%；路程不超过 1.25 倍；5° 以内吸正', () => {
  assert.equal(Z.HOLD_MS, 500);
  assert.equal(Z.STILL_PX, 5);
  assert.equal(Z.MIN_LEN, 80);
  assert.equal(Z.MAX_DEV, 0.12);
  assert.equal(Z.MAX_PATH, 1.25);
  assert.equal(Z.SNAP_DEG, 5);
});

test('又长又差不多直：够格（晃一点、拱一点都算）', () => {
  assert.ok(Z.lineLike(seg([100, 100], [400, 160])));
  assert.ok(Z.lineLike(seg([100, 100], [400, 160], 40, 6)), '左右晃 6（线长 306 的 2%）');
  assert.ok(Z.lineLike(bow([100, 100], [400, 100], 25)), '拱高 25（线长的 8%）');
  assert.ok(Z.lineLike(seg([500, 500], [500, 200])), '从下往上的竖线');
  assert.ok(Z.lineLike(seg([500, 300], [100, 300])), '从右往左的横线');
  assert.ok(Z.lineLike(seg([100, 100], [181, 100], 20)), '刚过 80');
});

test('短的不够格：「一」「1」「—」这种短划', () => {
  assert.ok(!Z.lineLike(seg([100, 100], [140, 102], 12)), '一（40）');
  assert.ok(!Z.lineLike(seg([100, 100], [103, 150], 12)), '1（50）');
  assert.ok(!Z.lineLike(seg([100, 100], [179, 100], 20)), '79');
  assert.ok(!Z.lineLike([[100, 100, 0.12, 0]]), '一个点');
  assert.ok(!Z.lineLike([]));
});

test('弯的、拐弯的不够格', () => {
  assert.ok(!Z.lineLike(bow([100, 100], [400, 100], 45)), '拱高 45（线长的 15%）');
  assert.ok(!Z.lineLike(join(seg([100, 400], [400, 400]), seg([400, 400], [400, 100]))), '一笔画的 L（两条轴）');
  assert.ok(!Z.lineLike(join(seg([100, 100], [250, 160]), seg([250, 160], [400, 100]))), 'V 字');
  assert.ok(!Z.lineLike(seg([100, 100], [400, 100], 40, 40)), '左右晃 40（线长的 13%）');
});

test('来回描的、绕圈的不够格', () => {
  assert.ok(!Z.lineLike(join(seg([100, 100], [400, 100]), seg([400, 100], [250, 100]))), '去 300 回 150：线长 150、路 450');
  assert.ok(!Z.lineLike(join(seg([100, 100], [400, 100]), seg([400, 100], [100, 100]), seg([100, 100], [400, 100]))), '来回描三遍');
  assert.ok(!Z.lineLike(circle(300, 300, 80)), '画圈：首尾接上，线长是 0');
  assert.ok(!Z.lineLike(circle(300, 300, 80, 40).slice(0, 31)), '画了四分之三的圈');
});

test('笔尖给了就按笔尖算：起点到笔尖', () => {
  const p = seg([100, 100], [140, 100], 10);
  assert.ok(!Z.lineLike(p));
  assert.ok(Z.lineLike(p.concat(seg([140, 100], [300, 100], 20).slice(1)), [300, 100]));
  assert.ok(!Z.lineLike(seg([100, 100], [400, 100]), [400, 250]), '笔尖跑到线外面去了：偏离太大');
});

test('停住时手抖的那点来回：给了 tol 就不算成路', () => {
  const line = seg([100, 100], [200, 100], 30);
  const shake = Array.from({ length: 60 }, (_, i) => [200 + (i % 2 ? 1.2 : -1.2), 100 + (i % 3) * 0.8 - 0.8, 0.12, 500 + i * 8]);
  const held = line.concat(shake);
  assert.ok(!Z.lineLike(held), '不给 tol：手抖的 60 个点算成了路，就不直了（这是要 tol 的原因）');
  assert.ok(Z.lineLike(held, null, 8.3), 'tol 是停住的半径（5 像素折成页面单位，适配宽度时约 8.3）');
  // tol 不能把真的来回描抹掉：来回的幅度比 tol 大得多
  assert.ok(!Z.lineLike(join(seg([100, 100], [400, 100]), seg([400, 100], [250, 100])), null, 8.3));
  assert.ok(!Z.lineLike(join(seg([100, 100], [400, 100]), seg([400, 100], [250, 100])), null, 1000), 'tol 最多算 TOL_MAX');
});

test('吸正：5° 以内吸成正水平、正竖直，另一个坐标不动；超过 5° 不吸', () => {
  const a = [100, 100];
  assert.deepEqual(Z.snap(a, [400, 100 + 300 * Math.tan((4.9 * Math.PI) / 180)]), [400, 100]);
  assert.deepEqual(Z.snap(a, [-200, 100 - 300 * Math.tan((4.9 * Math.PI) / 180)]), [-200, 100], '往左、往上一点');
  assert.deepEqual(Z.snap(a, [100 + 300 * Math.tan((4.9 * Math.PI) / 180), 400]), [100, 400]);
  assert.deepEqual(Z.snap(a, [100 - 300 * Math.tan((4.9 * Math.PI) / 180), -200]), [100, -200], '往上、往左一点');
  const b = [400, 100 + 300 * Math.tan((5.2 * Math.PI) / 180)];
  assert.deepEqual(Z.snap(a, b), b, '5.2° 不吸');
  assert.deepEqual(Z.snap(a, [400, 400]), [400, 400], '45° 不吸');
});

test('定下来的点：起点不变、终点是吸过的笔尖，都在直线上，格式和普通的一笔一样', () => {
  const raw = seg([100.3, 200.7], [400, 260], 50, 4, 0.12, 16);
  const raw0 = JSON.stringify(raw);
  const out = Z.straighten(raw);
  assert.equal(JSON.stringify(raw), raw0, '不改原来的点');
  assert.deepEqual(out[0], [100.3, 200.7, 0.12, 0], '起点就是原来的第一个点，时刻 0');
  assert.deepEqual(out[out.length - 1], [400, 260, 0.12, raw[raw.length - 1][3]], '终点是笔尖，时刻是原来最后一个点的');
  for (const p of out) {
    assert.equal(p.length, 4);
    assert.ok(p.every(Number.isFinite));
    assert.ok(Math.abs(p[0] * 10 - Math.round(p[0] * 10)) < 1e-6 && Math.abs(p[1] * 10 - Math.round(p[1] * 10)) < 1e-6, '坐标一位小数');
    assert.ok(distToLine(p, out[0], out[out.length - 1]) <= 0.08, '在直线上（只差一位小数的舍入）');
  }
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i][3] >= out[i - 1][3], '时刻不倒退');
    assert.ok(Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]) <= Z.STEP + 0.15, '点不稀');
  }
});

test('定下来的点：吸正的是正水平、正竖直；笔尖给了就到笔尖；轻重取平均', () => {
  const h = Z.straighten(seg([100, 300], [400, 312], 30), [400, 312]);
  assert.ok(h.every((p) => p[1] === 300), '正水平：每个点的 y 都是起点的');
  assert.equal(h[h.length - 1][0], 400);
  const v = Z.straighten(seg([600, 100], [588, 500], 30));
  assert.ok(v.every((p) => p[0] === 600), '正竖直：每个点的 x 都是起点的');
  assert.equal(v[v.length - 1][1], 500);
  const f = Z.straighten(seg([100, 100], [300, 200], 30), [250.04, 350.06]);
  assert.deepEqual(f[f.length - 1].slice(0, 2), [250, 350.1], '终点跟着给的笔尖（一位小数）');
  const pr = seg([100, 100], [300, 200], 3).map((p, i) => [p[0], p[1], [0.2, 0.4, 0.6, 0.9][i], p[3]]);
  assert.ok(Z.straighten(pr).every((p) => p[2] === 0.53), '报轻重的笔：取平均 0.525 → 0.53');
});

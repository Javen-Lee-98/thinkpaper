// 笔势识别：只看刚写完的这一笔（页面坐标的点 [x, y, …]），认出打勾、横划、斜线（叉的一笔）、星号。
// 认不出就返回 null，照常当笔迹。手势只在特定地方起作用（落在建议框里、蓝字旁），由调用方决定。
// 平板和 node 测试共用（tests/test_gesture.mjs）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Gesture = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function box(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
    return [x0, y0, x1, y1];
  }

  function length(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return s;
  }

  // 按弧长重新取点，去掉笔停顿时堆在一起的点，转角好算
  function resample(pts, step) {
    if (pts.length < 2) return pts.map((p) => [p[0], p[1]]);
    const out = [[pts[0][0], pts[0][1]]];
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      let [ax, ay] = [pts[i - 1][0], pts[i - 1][1]];
      const [bx, by] = [pts[i][0], pts[i][1]];
      let seg = Math.hypot(bx - ax, by - ay);
      while (carry + seg >= step) {
        const t = (step - carry) / seg;
        ax += (bx - ax) * t;
        ay += (by - ay) * t;
        out.push([ax, ay]);
        seg = Math.hypot(bx - ax, by - ay);
        carry = 0;
      }
      carry += seg;
    }
    const l = pts[pts.length - 1];
    if (Math.hypot(l[0] - out[out.length - 1][0], l[1] - out[out.length - 1][1]) > step * 0.3) out.push([l[0], l[1]]);
    return out;
  }

  // 尖角个数：方向变化超过 limit 度的地方（相邻的算一个）
  function sharpTurns(pts, limit) {
    const r = resample(pts, Math.max(4, length(pts) / 40));
    let n = 0, inTurn = false;
    for (let i = 2; i < r.length - 2; i++) {
      const a = Math.atan2(r[i][1] - r[i - 2][1], r[i][0] - r[i - 2][0]);
      const b = Math.atan2(r[i + 2][1] - r[i][1], r[i + 2][0] - r[i][0]);
      let d = Math.abs(a - b) * 180 / Math.PI;
      if (d > 180) d = 360 - d;
      if (d > limit) { if (!inTurn) n++; inTurn = true; } else inTurn = false;
    }
    return n;
  }

  function classify(pts) {
    if (!pts || pts.length < 2) return null;
    const [x0, y0, x1, y1] = box(pts), w = x1 - x0, h = y1 - y0, big = Math.max(w, h);
    const s = pts[0], e = pts[pts.length - 1], len = length(pts), chord = Math.hypot(e[0] - s[0], e[1] - s[1]);
    if (big < 10) return null;
    // 横划：又长又扁、几乎直
    if (w >= 36 && h <= Math.max(16, w * 0.22) && len <= chord * 1.25) return 'strike';
    // 斜线：叉的一笔，直、斜着
    const dx = Math.abs(e[0] - s[0]), dy = Math.abs(e[1] - s[1]);
    if (big >= 14 && big <= 160 && len <= chord * 1.2 && dy > dx * 0.45 && dy < dx * 2.2) return 'diag';
    const closed = chord < big * 0.3;
    // 星号：小、几乎闭合、四五个尖角（画的圈尖角不超过两个，不会混；圈就是普通的一笔）
    if (closed && big >= 14 && big <= 140 && sharpTurns(pts, 100) >= 4) return 'star';
    // 打勾：先往下（右下），到最低点，再往右上，结尾比起点高
    if (big <= 150 && !closed) {
      let k = 0;
      for (let i = 1; i < pts.length; i++) if (pts[i][1] > pts[k][1]) k = i;
      const low = pts[k], frac = len ? length(pts.slice(0, k + 1)) / len : 0;
      const down = low[1] - s[1], up = low[1] - e[1];
      if (frac > 0.08 && frac < 0.6 && low[0] > s[0] - 4 && e[0] > low[0] + w * 0.3 && down > h * 0.15 && up > h * 0.6 && up > down
          && sharpTurns(pts, 100) <= 2) return 'tick';
    }
    return null;
  }

  // 两条线段相交（叉的两笔是否交叉）
  function crosses(a, b) {
    const s1 = a[0], e1 = a[a.length - 1], s2 = b[0], e2 = b[b.length - 1];
    const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    return cross(s1, e1, s2) * cross(s1, e1, e2) < 0 && cross(s2, e2, s1) * cross(s2, e2, e1) < 0;
  }

  return { classify, crosses, box, length, sharpTurns };
});

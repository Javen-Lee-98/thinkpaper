// 笔触：把一笔的点（位置、轻重、时刻）画成像钢笔写的样子——线条是顺的，粗细有起伏，起笔收笔有笔锋。
// 一笔的数据不变，还是 [[x, y, 轻重 0–1, 离落笔多少毫秒], …]；这里只管怎么画。
// 平板页面和 node 测试共用（tests/test_brush.mjs）。
//
// 2026-11-13 查用户的真实笔迹（2520 笔）：他的笔不报轻重，每个点都是 0.12，所以原来的线从头到尾一样粗、
// 只有约 1.2 个单位（屏幕上不到 1 像素），看着发灰；在这么细的线上加笔锋也看不出来。
// 所以：轻重没有变化的笔，粗细改由快慢来定（慢处粗、快处细，像钢笔出水）；线的主体比原来粗一些，才黑、才显得出笔锋。
// 笔会报轻重的（比如 Apple Pencil），轻重照样算进去。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Brush = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // 三种候选（用户在试写页上选一种）。长度都是页面坐标（纸宽 1000）。
  //   w        线主体的粗细是「笔的基本粗细」的几倍（基本粗细 2.1；原来的线实际是 0.56 倍）
  //   slow / fast  写得很慢、很快的地方，粗细各是主体的几倍（都是 1 就是不看快慢）
  //   inLen / outLen  入笔、收笔的笔锋最长多长（短的一笔里按比例缩，入笔不超过全长的 20%，收笔不超过 30%）
  //   inTip / outTip  笔锋最细处是主体的几分之几
  const KINDS = {
    even: { w: 0.85, slow: 1, fast: 1, inLen: 0, outLen: 5, inTip: 1, outTip: 0.55 },        // 匀：只是变顺、变粗变黑（约是原来的 1.5 倍粗），收笔略尖
    pen: { w: 1.0, slow: 1.45, fast: 0.72, inLen: 5, outLen: 14, inTip: 0.6, outTip: 0.25 },  // 钢笔：慢处粗快处细，有笔锋
    bold: { w: 1.3, slow: 1.6, fast: 0.68, inLen: 6, outLen: 18, inTip: 0.5, outTip: 0.18 },  // 钢笔·重：更粗、起伏和笔锋更明显
  };
  const STEP = 1.2;     // 中心线每隔这么远取一个点
  const V_MID = 0.15;   // 平常写字的快慢（页面单位 / 毫秒；用户真实笔迹的中位数）
  const V_SLOW = 0.04, V_FAST = 0.45;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // 原来的画法：粗细只随轻重变
  const pressWidth = (base, p) => base * (0.45 + 0.9 * (p || 0.5));

  // 去掉挨得太近的点（笔停住时会堆在一起），免得方向算不出来
  function clean(pts) {
    const out = [];
    for (const p of pts) {
      const q = out[out.length - 1];
      if (q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.3) { q[2] = Math.max(q[2], p[2] || 0.5); continue; }
      out.push([p[0], p[1], p[2] || 0.5, p[3] || 0]);
    }
    return out;
  }

  // 每个原始点上的快慢（页面坐标 / 毫秒），前后各三个点取平均（时刻只精确到毫秒、一帧一报，不抹平会一跳一跳）
  function speeds(p) {
    const v = new Array(p.length).fill(0);
    for (let i = 1; i < p.length; i++) {
      const dt = p[i][3] - p[i - 1][3], ds = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      v[i] = dt > 0 ? ds / dt : v[i - 1];
    }
    if (p.length > 1) v[0] = v[1];
    const s = v.slice();
    for (let i = 0; i < v.length; i++) {
      let a = 0, n = 0;
      for (let k = Math.max(0, i - 3); k <= Math.min(v.length - 1, i + 3); k++) { a += v[k]; n++; }
      s[i] = a / n;
    }
    return s;
  }

  // 快慢 → 粗细的倍数：很慢是 K.slow，平常是 1，很快是 K.fast
  function speedFactor(v, K) {
    if (v <= V_MID) return K.slow + (1 - K.slow) * clamp((v - V_SLOW) / (V_MID - V_SLOW), 0, 1);
    return 1 + (K.fast - 1) * clamp((v - V_MID) / (V_FAST - V_MID), 0, 1);
  }

  // 这支笔报不报轻重：一笔里每个点的轻重都一样，就是不报
  function flatPressure(p) {
    let lo = Infinity, hi = -Infinity;
    for (const q of p) { if (q[2] < lo) lo = q[2]; if (q[2] > hi) hi = q[2]; }
    return hi - lo < 0.02;
  }

  // 过这些点的一条顺的线（Catmull-Rom），每隔 STEP 取一个点；点稀（写得快、采样少）的地方也是弯的，不是折线。
  // 返回 [{x, y, w 粗细, s 离起点多远, v 快慢}]，w 这时还没加笔锋。
  function centerline(pts, base, kind) {
    const p = clean(pts), K = KINDS[kind] || KINDS.pen;
    if (p.length === 0) return [];
    const v = speeds(p), flat = flatPressure(p);
    // 报轻重的笔：轻的 0.7 倍到重的 1.4 倍；不报的不算
    const wOf = (i) => base * K.w * speedFactor(v[i], K) * (flat ? 1 : clamp(0.7 + 0.7 * p[i][2], 0.7, 1.4));
    if (p.length === 1) return [{ x: p[0][0], y: p[0][1], w: base * K.w, s: 0, v: 0 }];
    const out = [];
    let s = 0;
    // 第一段、最后一段外面没有点：照着头三个（末三个）点的弯法往外补一个，两头才不会被拉直
    const ext = (b, c, d) => (d ? [3 * b[0] - 3 * c[0] + d[0], 3 * b[1] - 3 * c[1] + d[1]] : [2 * b[0] - c[0], 2 * b[1] - c[1]]);
    const head = ext(p[0], p[1], p[2]), tail = ext(p[p.length - 1], p[p.length - 2], p[p.length - 3]);
    for (let i = 0; i < p.length - 1; i++) {
      const a = i > 0 ? p[i - 1] : head, b = p[i], c = p[i + 1], d = i + 2 < p.length ? p[i + 2] : tail;
      const len = Math.hypot(c[0] - b[0], c[1] - b[1]), n = Math.max(1, Math.ceil(len / STEP));
      const w0 = wOf(i), w1 = wOf(i + 1);
      for (let k = 0; k < n; k++) {
        const t = k / n, t2 = t * t, t3 = t2 * t;
        const x = 0.5 * ((2 * b[0]) + (-a[0] + c[0]) * t + (2 * a[0] - 5 * b[0] + 4 * c[0] - d[0]) * t2 + (-a[0] + 3 * b[0] - 3 * c[0] + d[0]) * t3);
        const y = 0.5 * ((2 * b[1]) + (-a[1] + c[1]) * t + (2 * a[1] - 5 * b[1] + 4 * c[1] - d[1]) * t2 + (-a[1] + 3 * b[1] - 3 * c[1] + d[1]) * t3);
        const q = out[out.length - 1];
        if (q) s += Math.hypot(x - q.x, y - q.y);
        out.push({ x, y, w: w0 + (w1 - w0) * t, s, v: v[i] + (v[i + 1] - v[i]) * t });
      }
    }
    const e = p[p.length - 1], q = out[out.length - 1];
    s += Math.hypot(e[0] - q.x, e[1] - q.y);
    out.push({ x: e[0], y: e[1], w: wOf(p.length - 1), s, v: v[p.length - 1] });
    // 粗细前后抹平（前后各约 5 个单位），起伏是缓的，不出一节一节的疙瘩
    const r = Math.max(1, Math.round(5 / STEP)), w = out.map((o) => o.w);
    for (let i = 0; i < out.length; i++) {
      let acc = 0, n = 0;
      for (let k = Math.max(0, i - r); k <= Math.min(out.length - 1, i + r); k++) { acc += w[k]; n++; }
      out[i].w = acc / n;
    }
    return out;
  }

  // 加上笔锋：入笔由细到粗；done（抬笔了）时收笔由粗到尖。还在写的时候笔尖处不收（是圆头）。
  // 笔锋只占一笔的两头：入笔不超过全长的 20%，收笔不超过 30%，中间一大段是足粗的，线才黑。
  function taper(line, kind, done) {
    const K = KINDS[kind] || KINDS.pen, n = line.length;
    if (n < 2) return line;
    const L = line[n - 1].s;
    const lin = Math.min(K.inLen, L * 0.2);
    let lout = done ? K.outLen : 0;
    if (lout > 0) {
      // 抬笔前最后一小段的快慢：甩出去的（撇、捺、钩）长，顿住的短
      let vEnd = 0, cnt = 0;
      for (let i = n - 1; i >= 0 && L - line[i].s < 8; i--) { vEnd += line[i].v; cnt++; }
      vEnd = cnt ? vEnd / cnt : 0;
      lout = Math.min(lout * clamp(vEnd / V_MID, 0.35, 1.6), L * 0.3);
    }
    const ease = (u) => Math.pow(clamp(u, 0, 1), 0.7);
    for (const o of line) {
      let f = 1;
      if (lin > 0) f *= K.inTip + (1 - K.inTip) * ease(o.s / lin);
      if (lout > 0) f *= K.outTip + (1 - K.outTip) * ease((L - o.s) / lout);
      o.w *= f;
    }
    return line;
  }

  // 一笔的轮廓：左边一串点、右边一串点（两头各有一个圆头），外加拐急弯处补的圆点。
  // 画的时候把轮廓填实，粗细怎么变都没有接痕。
  function outline(pts, base, kind, done) {
    const line = taper(centerline(pts, base, kind), kind, done), n = line.length;
    if (n === 0) return { line, left: [], right: [], dots: [] };
    if (n === 1 || line[n - 1].s < 0.6) return { line, left: [], right: [], dots: [[line[0].x, line[0].y, Math.max(line[0].w, line[n - 1].w) / 2]] };
    const left = [], right = [], dots = [];
    let px = 0, py = 0;
    for (let i = 0; i < n; i++) {
      const a = line[Math.max(0, i - 1)], b = line[Math.min(n - 1, i + 1)];
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) { dx = px; dy = py; } else { dx /= d; dy /= d; }
      if (i > 0 && dx * px + dy * py < 0.5) dots.push([line[i].x, line[i].y, line[i].w / 2]); // 拐急弯：补一个圆点，轮廓不会缺一块
      px = dx; py = dy;
      const h = line[i].w / 2;
      left.push([line[i].x - dy * h, line[i].y + dx * h]);
      right.push([line[i].x + dy * h, line[i].y - dx * h]);
    }
    dots.push([line[0].x, line[0].y, line[0].w / 2], [line[n - 1].x, line[n - 1].y, line[n - 1].w / 2]); // 两头的圆头
    return { line, left, right, dots };
  }

  // 画一笔。ctx 已经换算到页面坐标。done 为 false 是正在写的这一笔（笔尖处先不收）。
  function draw(ctx, pts, base, kind, color, done) {
    const o = outline(pts, base, kind, done !== false);
    ctx.fillStyle = color;
    if (o.left.length) {
      ctx.beginPath();
      ctx.moveTo(o.left[0][0], o.left[0][1]);
      for (let i = 1; i < o.left.length; i++) ctx.lineTo(o.left[i][0], o.left[i][1]);
      for (let i = o.right.length - 1; i >= 0; i--) ctx.lineTo(o.right[i][0], o.right[i][1]);
      ctx.closePath();
      ctx.fill();
    }
    for (const d of o.dots) {
      ctx.beginPath();
      ctx.arc(d[0], d[1], Math.max(d[2], 0.05), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 现在的画法（对照用）：一小段一小段直线，每段各自的粗细，圆头
  function legacy(ctx, pts, base, color) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], pressWidth(base, pts[0][2]) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      ctx.lineWidth = pressWidth(base, (a[2] + b[2]) / 2);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }

  return { KINDS, pressWidth, centerline, taper, outline, draw, legacy };
});

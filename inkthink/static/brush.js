// 笔触：把一笔的点（位置、轻重、时刻）画成顺的、够黑的线，收笔略尖。只管平板上怎么显示，一笔的数据不变，
// 还是 [[x, y, 轻重 0–1, 离落笔多少毫秒], …]。发给 Claude 的图、服务端画的图（整本检测、往来稿、存回 PDF）不用它，照旧。
// 平板页面（static/app.js）和 node 测试（tests/test_brush.mjs）共用。
//
// 2026-11-13 查用户的真实笔迹（2520 笔）：他的笔不报轻重，每个点都是 0.12，原来的线从头到尾一样粗、只有约 1.2 个单位
// （屏幕上不到 1 像素），看着发灰。用户在临时的试写页上比了三种候选，选定「笔触 1（匀：线条顺，从头到尾一样粗，收笔略尖）、细」：
// 线主体是笔的基本粗细（2.1）的 0.85 × 0.8 倍，不看快慢；收笔的尖在抬笔以后才有。2026-11-14（阶段 D1）做进正式页面，
// 试写页和没选中的两种候选删了。笔会报轻重的（比如 Apple Pencil），轻重照样算进粗细。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Brush = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // 长度都是页面坐标（纸宽 1000）
  const PEN = {
    w: 0.68,      // 线主体的粗细是「笔的基本粗细」的几倍（试写页上的「笔触 1」0.85 × 「细」0.8；原来的画法实际是 0.56 倍）
    outLen: 5,    // 收笔的尖最长多长（再按抬笔前的快慢缩放：甩出去的长、顿住的短；不超过全长的 30%）
    outTip: 0.55, // 收笔最细处是主体的几分之几
  };
  const STEP = 1.2;     // 中心线每隔这么远取一个点
  const V_MID = 0.15;   // 平常写字的快慢（页面单位 / 毫秒；用户真实笔迹的中位数）
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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

  // 每个原始点上的快慢（页面坐标 / 毫秒），前后各三个点取平均（时刻只精确到毫秒、一帧一报，不抹平会一跳一跳）。
  // 只用来定收笔的尖有多长
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

  // 这支笔报不报轻重：一笔里每个点的轻重都一样，就是不报
  function flatPressure(p) {
    let lo = Infinity, hi = -Infinity;
    for (const q of p) { if (q[2] < lo) lo = q[2]; if (q[2] > hi) hi = q[2]; }
    return hi - lo < 0.02;
  }

  // 过这些点的一条顺的线（Catmull-Rom），每隔 STEP 取一个点；点稀（写得快、采样少）的地方也是弯的，不是折线。
  // 返回 [{x, y, w 粗细, s 离起点多远, v 快慢}]，w 这时还没收尖。
  function centerline(pts, base) {
    const p = clean(pts);
    if (p.length === 0) return [];
    const v = speeds(p), flat = flatPressure(p);
    // 报轻重的笔：轻的 0.7 倍到重的 1.4 倍；不报的不算
    const wOf = (i) => base * PEN.w * (flat ? 1 : clamp(0.7 + 0.7 * p[i][2], 0.7, 1.4));
    if (p.length === 1) return [{ x: p[0][0], y: p[0][1], w: base * PEN.w, s: 0, v: 0 }];
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
    if (flat) return out; // 不报轻重：处处一样粗，不用抹平
    // 报轻重的：粗细前后抹平（前后各约 5 个单位），起伏是缓的，不出一节一节的疙瘩
    const r = Math.max(1, Math.round(5 / STEP)), w = out.map((o) => o.w);
    for (let i = 0; i < out.length; i++) {
      let acc = 0, n = 0;
      for (let k = Math.max(0, i - r); k <= Math.min(out.length - 1, i + r); k++) { acc += w[k]; n++; }
      out[i].w = acc / n;
    }
    return out;
  }

  // 收笔：done（抬笔了）时由粗到略尖；还在写的时候笔尖处不收（是圆头），抬笔那一刻才收。起笔不收。
  function taper(line, done) {
    const n = line.length;
    if (n < 2 || !done) return line;
    const L = line[n - 1].s;
    // 抬笔前最后一小段的快慢：甩出去的（撇、捺、钩）长，顿住的短
    let vEnd = 0, cnt = 0;
    for (let i = n - 1; i >= 0 && L - line[i].s < 8; i--) { vEnd += line[i].v; cnt++; }
    vEnd = cnt ? vEnd / cnt : 0;
    const lout = Math.min(PEN.outLen * clamp(vEnd / V_MID, 0.35, 1.6), L * 0.3);
    if (lout <= 0) return line;
    const ease = (u) => Math.pow(clamp(u, 0, 1), 0.7);
    for (const o of line) o.w *= PEN.outTip + (1 - PEN.outTip) * ease((L - o.s) / lout);
    return line;
  }

  // 一笔的轮廓：左边一串点、右边一串点（两头各有一个圆头），外加拐急弯处补的圆点。
  // 画的时候把轮廓填实，粗细怎么变都没有接痕。
  function outline(pts, base, done) {
    const line = taper(centerline(pts, base), done), n = line.length;
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

  // 轮廓画进路径（canvas 的 ctx 或 Path2D）。身子一块、圆点另一块，各自填实：放在同一块里，绕向相反的地方会被挖空
  function traceBody(o, p) {
    if (!o.left.length) return;
    p.moveTo(o.left[0][0], o.left[0][1]);
    for (let i = 1; i < o.left.length; i++) p.lineTo(o.left[i][0], o.left[i][1]);
    for (let i = o.right.length - 1; i >= 0; i--) p.lineTo(o.right[i][0], o.right[i][1]);
    p.closePath();
  }
  function traceDots(o, p) {
    for (const d of o.dots) {
      const r = Math.max(d[2], 0.05);
      p.moveTo(d[0] + r, d[1]);
      p.arc(d[0], d[1], r, 0, Math.PI * 2);
    }
  }

  // 抬了笔的笔迹记住它的路径，重画整页时不再从头算：按点的数组认，点数或粗细变了就重算（笔迹数据不改，改了也认得出）
  const cache = typeof WeakMap === 'function' && typeof Path2D === 'function' ? new WeakMap() : null;

  // 画一笔。ctx 已经换算到页面坐标；base 是这一笔记下的笔的粗细（笔迹数据里的 w）。done 为 false 是正在写的这一笔（笔尖处先不收）。
  function draw(ctx, pts, base, color, done) {
    done = done !== false;
    ctx.fillStyle = color;
    if (done && cache) {
      let c = cache.get(pts);
      if (!c || c.n !== pts.length || c.base !== base) {
        const o = outline(pts, base, true);
        c = { n: pts.length, base, body: new Path2D(), dots: new Path2D() };
        traceBody(o, c.body);
        traceDots(o, c.dots);
        cache.set(pts, c);
      }
      ctx.fill(c.body);
      ctx.fill(c.dots);
      return;
    }
    const o = outline(pts, base, done);
    ctx.beginPath();
    traceBody(o, ctx);
    ctx.fill();
    ctx.beginPath();
    traceDots(o, ctx);
    ctx.fill();
  }

  // 同一个轮廓写成 SVG 的 path（卡片上的红字用）：圆点和身子绕同一个方向，放在一条路径里按 nonzero 填实不会被挖空
  function svgPath(pts, base, done) {
    const o = outline(pts, base, done !== false), f = (v) => (Math.round(v * 100) / 100).toString();
    let d = '';
    if (o.left.length) d += 'M' + o.left.concat(o.right.slice().reverse()).map((q) => `${f(q[0])} ${f(q[1])}`).join(' L') + ' Z';
    for (const c of o.dots) { // 轮廓（左边往前、右边往回）的绕向和逆时针的圆一致
      const r = Math.max(c[2], 0.05), R = f(r);
      d += ` M${f(c[0] + r)} ${f(c[1])} A${R} ${R} 0 1 0 ${f(c[0] - r)} ${f(c[1])} A${R} ${R} 0 1 0 ${f(c[0] + r)} ${f(c[1])} Z`;
    }
    return d.trim();
  }

  return { PEN, centerline, taper, outline, draw, svgPath };
});

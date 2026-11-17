// 画线停住变直（2026-11-16 用户定，《产品定义》第 2 节「交互上补的八样」第二批）：用笔画一条线，笔不抬、停住约半秒，
// 这一笔到此为止又长又差不多直，就变成从起点到笔尖的一条直线；之后笔还没抬，终点跟着笔尖走（起点不动），抬笔定下来；
// 接近水平、竖直的吸成正水平、正竖直（画坐标轴用）。不停住的笔迹一点不动。
// 这里只有纯计算：够不够格变直（lineLike）、吸不吸（snap）、定下来存成哪些点（straighten）。什么时候算停住（定时器）在 static/app.js。
// 平板和 node 测试（tests/test_straight.mjs）共用。下面的门槛都是暂定，用户在平板上试过再定。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Straight = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const HOLD_MS = 500;   // 停住多久（暂定）
  // 停住：这段时间里笔尖离停下的那一点不超过这么多个屏幕像素（CSS 像素）。手抖是手上的事，按屏幕量，和纸放大多少无关；
  // iPad 上约 1 毫米（暂定，没在 iPad 上量过手停住时抖多少）
  const STILL_PX = 5;
  // 长：起点到笔尖至少这么多页面单位（纸宽 1000，分组的「相距不到 60」是同一个尺度）。竖着的 iPad 适配宽度时约 9 毫米，
  // 比平常写的一个字的一横长；「一」「1」「—」这种短划够不着（暂定）
  const MIN_LEN = 80;
  const MAX_DEV = 0.12;  // 差不多直：每个点离「起点—笔尖」那条线段不超过线段长的这么多（暂定）
  const MAX_PATH = 1.25; // 差不多直：走过的路不超过线段长的这么多倍，来回描的、绕圈的过不了（暂定）
  const SNAP_DEG = 5;    // 离水平、竖直不到这么多度：吸成正水平、正竖直（暂定）
  const STEP = 2;        // 定下来的直线每隔约这么远（页面单位）存一个点
  const TOL_MAX = 10;    // 量走过的路时不算的手抖最多这么大（页面单位；见 lineLike）

  const r1 = (v) => Math.round(v * 10) / 10; // 和笔迹数据一样：坐标保留一位小数

  // 点 p 到线段 ab 的距离
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  // 这一笔（点 pts，[[x, y, …], …]；笔尖现在在 tip，不给就是最后一个点）够不够格变直：起点到笔尖不短于 MIN_LEN，
  // 每个点离起点—笔尖那条线段不超过它长的 MAX_DEV，走过的路不超过它长的 MAX_PATH 倍。
  // tol：量走过的路时，离上一个算进去的点不到这么远的点不算（笔停住时手抖的那点来回不该算成路，否则停得越久越「不直」）；
  // 最多算 TOL_MAX。app.js 给的是停住的那个半径（STILL_PX 折成页面单位）
  function lineLike(pts, tip, tol) {
    if (!pts || !pts.length) return false;
    const a = pts[0], b = tip || pts[pts.length - 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(L >= MIN_LEN)) return false;
    const all = tip ? pts.concat([tip]) : pts, skip = Math.min(TOL_MAX, Math.max(0, tol || 0));
    let path = 0, kept = a;
    for (let i = 1; i < all.length; i++) {
      const p = all[i];
      if (segDist(p, a, b) > MAX_DEV * L) return false;
      const d = Math.hypot(p[0] - kept[0], p[1] - kept[1]);
      if (d >= skip || i === all.length - 1) { path += d; kept = p; }
    }
    return path <= MAX_PATH * L;
  }

  // 终点吸正：从 a 到 b 离水平不到 SNAP_DEG 度，就吸成和 a 一样高；离竖直不到 SNAP_DEG 度，就吸成和 a 一样的 x。
  // 吸的时候笔尖的另一个坐标不动（画坐标轴时轴画到笔尖那么长）
  function snap(a, b) {
    const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]), k = Math.tan((SNAP_DEG * Math.PI) / 180);
    if (dy <= k * dx) return [b[0], a[1]];
    if (dx <= k * dy) return [a[0], b[1]];
    return [b[0], b[1]];
  }

  // 定下来的直线存成哪些点：起点就是原来的第一个点，终点是吸过的笔尖，中间每隔约 STEP 一个点；还是 [x, y, 轻重, 毫秒]，
  // 坐标一位小数；轻重取这一笔原来各点的平均；时刻从 0 匀匀地走到原来最后一个点的时刻（起止时间不变，不倒退）。
  // 一笔就是普通的一笔：不加字段，笔触画法、书写回放、交给 Claude 的书写过程都照常
  function straighten(pts, tip) {
    const a = pts[0], last = pts[pts.length - 1], e = snap(a, tip || last);
    const b = [r1(e[0]), r1(e[1])], t1 = last[3] || 0;
    const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / STEP) + 1);
    let pr = 0;
    for (const p of pts) pr += p[2];
    pr = Math.round((pr / pts.length) * 100) / 100;
    const out = [];
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      out.push([r1(a[0] + (b[0] - a[0]) * u), r1(a[1] + (b[1] - a[1]) * u), pr, Math.round(t1 * u)]);
    }
    return out;
  }

  return { HOLD_MS, STILL_PX, MIN_LEN, MAX_DEV, MAX_PATH, SNAP_DEG, STEP, TOL_MAX, lineLike, snap, straighten };
});

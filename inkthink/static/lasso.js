// 套索（2026-11-16 用户定，《产品定义》第 2 节「交互上补的八样」第二批）：选了「套索」，用笔画一圈，圈里没擦掉的笔迹被选中，
// 按住框里拖到别处；只指着这几笔的 Claude 的东西跟着平移同样的量。
// 这里只有纯计算：点在不在圈里（inPolygon）、哪几笔被圈中（pick）、挪一笔的点（shiftPts）、挪 Claude 的一条东西（shiftItem，
// 连同它的 SVG 路径 shiftPath）、哪几条跟着走（follows）、拖动时夹在纸内（clampDelta）。什么时候算选中、怎么画、撤销重做，在 static/app.js。
// 平板和 node 测试（tests/test_lasso.mjs）共用。门槛是暂定，用户在平板上试过再定。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Lasso = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SHARE = 0.5; // 一笔的点有不少于这么多（一半）在圈里：选中（暂定）

  const r1 = (v) => Math.round(v * 10) / 10; // 笔迹数据的坐标保留一位小数
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const onGrid = (v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;

  // 点 (x, y) 在不在圈 poly（[[x, y], …]，末一点自动连回第一点）里。按绕数算，不为 0 就在里面：
  // 绕了两圈的、画成 8 字的，圈住的地方都算在里面（按奇偶算的话，绕两圈的那一块会被当成外面）
  function inPolygon(x, y, poly) {
    const n = poly.length;
    let w = 0;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const left = (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]); // 大于 0：点在 a→b 的左边
      if (a[1] <= y) { if (b[1] > y && left > 0) w++; } else if (b[1] <= y && left < 0) w--;
    }
    return w !== 0;
  }

  // 哪几笔被圈中：没擦掉、有点的笔迹里，点有不少于 SHARE（一半）在圈里的。返回它们的 id，按 strokes 里的先后。
  // 圈不到三个点（点了一下、画了一道）就是什么都没圈
  function pick(strokes, poly) {
    if (!Array.isArray(poly) || poly.length < 3) return [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of poly) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const out = [];
    for (const s of strokes || []) {
      if (!s || s.erasedAt || !Array.isArray(s.pts) || !s.pts.length) continue;
      let k = 0;
      for (const p of s.pts) if (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1 && inPolygon(p[0], p[1], poly)) k++;
      if (k > 0 && k >= SHARE * s.pts.length) out.push(s.id);
    }
    return out;
  }

  // 一个坐标挪 d：原来是一位小数的（笔迹、大多数排版）挪完照样是一位小数，挪过去再挪回来分毫不差；别的照原样加
  function shiftNum(v, d) {
    const w = v + d;
    return onGrid(v) && onGrid(d) ? r1(w) : w;
  }

  // 一笔的点整体挪 (dx, dy)：返回新的点数组（画笔触的缓存按点数组认，换一个数组它才重算轮廓），每个点只改 x、y，轻重、时刻照旧
  function shiftPts(pts, dx, dy) {
    return pts.map((p) => { const q = p.slice(); q[0] = shiftNum(p[0], dx); q[1] = shiftNum(p[1], dy); return q; });
  }

  // SVG 路径里的坐标整体挪 (dx, dy)。Claude 的东西画出来的路径都是绝对坐标的 M / L / Q / C（数字两两成对），这里另外认得
  // H、V、S、T、A、Z 和小写的相对坐标（相对的不用挪，只有路径开头那个 m 的第一对是绝对的），免得以后哪种路径被挪坏。
  // 数字写回去时保留原来的小数位数（至少一位），命令和数字之间、数字和数字之间用一个空格隔开（和页面生成路径的写法一样）
  const PARAMS = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };
  const TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  function shiftTok(t, d) {
    const v = parseFloat(t);
    if (/[eE]/.test(t)) return String(v + d);
    const dec = Math.min(6, Math.max(1, (t.split('.')[1] || '').length, (String(d).split('.')[1] || '').length));
    return String(Number((v + d).toFixed(dec)));
  }
  function shiftPath(d, dx, dy) {
    const toks = String(d || '').match(TOKEN);
    if (!toks) return d;
    let out = '', cmd = '', k = 0, nCmd = 0, afterCmd = false;
    for (const t of toks) {
      if (/^[A-Za-z]$/.test(t)) {
        cmd = t; k = 0; nCmd++;
        out += (out ? ' ' : '') + t;
        afterCmd = true;
        continue;
      }
      const up = cmd.toUpperCase(), n = PARAMS[up] || 0, i = n ? k % n : k;
      let role = '';
      if (cmd && cmd === up) { // 绝对坐标
        if (up === 'H') role = 'x';
        else if (up === 'V') role = 'y';
        else if (up === 'A') role = i === 5 ? 'x' : i === 6 ? 'y' : '';
        else if (n) role = i % 2 ? 'y' : 'x';
      } else if (cmd === 'm' && nCmd === 1 && k < 2) role = k ? 'y' : 'x'; // 路径开头的 m：第一对是绝对坐标
      const s = role === 'x' ? shiftTok(t, dx) : role === 'y' ? shiftTok(t, dy) : t;
      out += (afterCmd ? '' : ' ') + s;
      afterCmd = false;
      k++;
    }
    return out;
  }

  // Claude 的一条东西整体挪 (dx, dy)：它身上每一种页面坐标都挪（各类型逐一核对过，见 app.js 的 buildItem 和各个 build*）——
  // 框 box、vbox（✓ × 钮围着的框）、hit（点、擦的范围）、sym（画出来的符号）、labelOf（关系词所在的那条箭头）；
  // 圈号的圆心 at；排版 lay、图 fig、示意图里的字 labels 的 x、y；路径 paths 的 d；小蓝点 dot.at；
  // 小蓝点浮出的小卡片、短批注收成的卡片最上面那块的换算 popMap、fromMap 的 x0、y0（和纸上那几行一起挪，卡片里画出来的一点不变）；
  // 短批注收成卡片时原样留下的那条 from（递归）。卡片上的红字 marks、排版快照 sheet 是卡片里的坐标，不挪。
  // 换成新的数组、对象，不在原处改：有的条目几个字段共用同一个数组（概念图的建议 box 和 vbox 是同一个），原处改会挪两次。
  // 走一遍这些字段（mapCoords）：X、Y 换一个横、竖坐标，D 换一条路径；挪（shiftItem）、取下来（coordsOf）、放回去（putCoords）都用它，
  // 字段只在这里列一次，先后也一样
  const BOX_KEYS = ['box', 'vbox', 'hit', 'sym', 'labelOf'];
  function mapCoords(a, X, Y, D) {
    if (!a || typeof a !== 'object') return;
    const isBox = (b) => Array.isArray(b) && b.length === 4 && b.every(num);
    const isPt = (p) => Array.isArray(p) && p.length === 2 && p.every(num);
    const xy = (o) => (o && typeof o === 'object' && num(o.x) && num(o.y) ? Object.assign({}, o, { x: X(o.x), y: Y(o.y) }) : o);
    const x0y0 = (o) => (o && typeof o === 'object' && num(o.x0) && num(o.y0) ? Object.assign({}, o, { x0: X(o.x0), y0: Y(o.y0) }) : o);
    for (const k of BOX_KEYS) if (isBox(a[k])) { const b = a[k]; a[k] = [X(b[0]), Y(b[1]), X(b[2]), Y(b[3])]; }
    if (isPt(a.at)) a.at = [X(a.at[0]), Y(a.at[1])];
    if (a.lay) a.lay = xy(a.lay);
    if (a.fig) a.fig = xy(a.fig);
    if (Array.isArray(a.labels)) a.labels = a.labels.map(xy);
    if (Array.isArray(a.paths)) a.paths = a.paths.map((p) => (p && typeof p.d === 'string' ? Object.assign({}, p, { d: D(p.d) }) : p));
    if (a.dot && typeof a.dot === 'object' && isPt(a.dot.at)) a.dot = Object.assign({}, a.dot, { at: [X(a.dot.at[0]), Y(a.dot.at[1])] });
    if (a.popMap) a.popMap = x0y0(a.popMap);
    if (a.fromMap) a.fromMap = x0y0(a.fromMap);
    if (a.from && typeof a.from === 'object') mapCoords(a.from, X, Y, D);
  }
  function shiftItem(a, dx, dy) {
    mapCoords(a, (v) => shiftNum(v, dx), (v) => shiftNum(v, dy), (d) => shiftPath(d, dx, dy));
    return a;
  }
  // 一条东西身上的页面坐标，按 mapCoords 走的先后排成一列（不改它）。撤销、重做时照它原样放回去（putCoords）：
  // 有的坐标不是一位小数（箭头旁那句话的位置之类），加了又减会差最后一位，放回原数才分毫不差
  function coordsOf(a) {
    const out = [], take = (v) => { out.push(v); return v; };
    if (a && typeof a === 'object') mapCoords(JSON.parse(JSON.stringify(a)), take, take, take);
    return out;
  }
  function putCoords(a, list) {
    let i = 0;
    const next = () => list[i++];
    mapCoords(a, next, next, next);
    return a;
  }

  // 概念图上建议加的概念（node）连到别的组的虚线：每条的终点。第一条路径是椭圆本身，后面的是连线（M 起点 Q 控制点 终点）
  function linkEnds(a) {
    const out = [];
    for (const p of (a && Array.isArray(a.paths) ? a.paths : []).slice(1)) {
      const n = (String((p && p.d) || '').match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
      if (n.length >= 4) out.push([n[n.length - 2], n[n.length - 1]]);
    }
    return out;
  }

  // Claude 的这一条跟不跟着选中的笔迹走：它指着的、没擦掉的笔迹（on，箭头、连线另有起点 on2）至少有一笔，而且全在选中的里面（sel）。
  // live 是这一页没擦掉的笔迹 id。还指着别的笔迹的、没指着笔迹的（指着印刷文字的 box、页面末尾、图和公式本来就不记 on）、
  // 指着书页上印刷文字的修改建议（onDoc）、以前的「挪动、收起」提议（proposal，不画）都不跟。
  // 概念图上建议的新概念（node）还连到别的组（连线的另一头只记在路径里，没记是哪几笔）：linkOk(终点) 说那一头也在选中的里面才跟
  function follows(a, sel, live, linkOk) {
    if (!a || typeof a !== 'object' || a.type === 'proposal' || a.onDoc) return false;
    const ids = [].concat(Array.isArray(a.on) ? a.on : [], Array.isArray(a.on2) ? a.on2 : []).filter((id) => live.has(id));
    if (!ids.length || !ids.every((id) => sel.has(id))) return false;
    if (a.type === 'node') for (const p of linkEnds(a)) if (!linkOk || !linkOk(p)) return false;
    return true;
  }

  // 拖动夹在纸内：box 是拖着走的这一块 [x0, y0, x1, y1]（选中的笔迹连同跟着走、看得见的蓝字），bounds 是纸 [x0, y0, x1, y1]。
  // 返回夹过的 [dx, dy]。本来就出了纸边的那一边不能再往外挪，也不硬拉回来
  function clampDelta(box, bounds, dx, dy) {
    const lx = Math.min(0, bounds[0] - box[0]), hx = Math.max(0, bounds[2] - box[2]);
    const ly = Math.min(0, bounds[1] - box[1]), hy = Math.max(0, bounds[3] - box[3]);
    return [Math.max(lx, Math.min(hx, dx)), Math.max(ly, Math.min(hy, dy))];
  }

  return { SHARE, inPolygon, pick, shiftNum, shiftPts, shiftPath, shiftItem, coordsOf, putCoords, linkEnds, follows, clampDelta };
});

// 套索（2026-11-16 用户定，《产品定义》第 2 节「交互上补的八样」第二批）：选了「套索」，用笔画一圈，圈里没擦掉的笔迹被选中，
// 按住框里拖到别处；只指着这几笔的 Claude 的东西跟着平移同样的量；箭头、连线只有一头指着这几笔的，那一头跟着走（2026-11-17）。
// 这里只有纯计算：点在不在圈里（inPolygon）、哪几笔被圈中（pick）、挪一笔的点（shiftPts）、挪 Claude 的一条东西（shiftItem，
// 连同它的 SVG 路径 shiftPath）、哪几条怎么跟着走（followMode）、只挪箭头连线的一头（bendItem）、撤销恢复时照原样放回的坐标字段
// （fieldsOf、putFields）、拖动时夹在纸内（clampDelta）。什么时候算选中、怎么画、书页页边的短批注怎么排、撤销重做，在 static/app.js。
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
  // 走一遍这些字段（mapCoords）：X、Y 换一个横、竖坐标，D 换一条路径。撤销、恢复时照原样放回的是这些字段整个的样子（FIELDS、fieldsOf）
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
    // 摊在纸上的长回答（2026-11-17）：那一段的左上角挪，各行是相对它的、不用挪；连到所答笔迹的细线（lead，一条路径）跟着挪
    if (a.spread && typeof a.spread === 'object' && num(a.spread.x) && num(a.spread.y)) {
      a.spread = Object.assign({}, a.spread, { x: X(a.spread.x), y: Y(a.spread.y) }, typeof a.spread.lead === 'string' ? { lead: D(a.spread.lead) } : {});
    }
    if (a.from && typeof a.from === 'object') mapCoords(a.from, X, Y, D);
  }
  function shiftItem(a, dx, dy) {
    mapCoords(a, (v) => shiftNum(v, dx), (v) => shiftNum(v, dy), (d) => shiftPath(d, dx, dy));
    return a;
  }
  // 一条东西身上带页面坐标的字段（mapCoords 走的那些），整个取下来一份（深拷贝，不改它；值是 undefined 的当没有）。撤销、恢复时照它原样
  // 放回去（putFields）：有的坐标不是一位小数（箭头旁那句话的位置之类），加了又减会差最后一位；书页页边的短批注挪动时细线是重画的、
  // 可能多一条少一条（app.js 的 colShift），只有整个放回去才分毫不差
  const FIELDS = BOX_KEYS.concat(['at', 'lay', 'fig', 'labels', 'paths', 'dot', 'popMap', 'fromMap', 'from', 'spread']);
  const copy = (v) => JSON.parse(JSON.stringify(v));
  function fieldsOf(a) {
    const out = {};
    if (a && typeof a === 'object') for (const k of FIELDS) if (a[k] !== undefined) out[k] = copy(a[k]);
    return out;
  }
  // 放回去：f 里有的字段换成它（一份拷贝），没有的从 a 上拿掉；别的字段不动
  function putFields(a, f) {
    for (const k of FIELDS) { if (f && f[k] !== undefined) a[k] = copy(f[k]); else delete a[k]; }
    return a;
  }

  // 箭头、连线（arrow；概念图上建议的连线 link）画出来的线：第一条路径是线身「M 起点 Q 控制点 终点」（app.js 的 arrowPaths），
  // 第二条是终点处的箭头「M 一边 L 终点 L 另一边」。返回 { p1, c, p2, head: [一边, 另一边] | null }；线身认不出来返回 null
  const NUM = '([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)', SEP = '[\\s,]+';
  const SHAFT = new RegExp(`^\\s*M\\s*${NUM}${SEP}${NUM}\\s*Q\\s*${NUM}${SEP}${NUM}${SEP}${NUM}${SEP}${NUM}\\s*$`);
  const HEAD = new RegExp(`^\\s*M\\s*${NUM}${SEP}${NUM}\\s*L\\s*${NUM}${SEP}${NUM}\\s*L\\s*${NUM}${SEP}${NUM}\\s*$`);
  function shaftOf(a) {
    const ps = a && Array.isArray(a.paths) ? a.paths : [];
    const m = ps[0] && typeof ps[0].d === 'string' ? ps[0].d.match(SHAFT) : null;
    if (!m) return null;
    const v = m.slice(1).map(Number), h = ps[1] && typeof ps[1].d === 'string' ? ps[1].d.match(HEAD) : null, u = h && h.slice(1).map(Number);
    return { p1: [v[0], v[1]], c: [v[2], v[3]], p2: [v[4], v[5]], head: u ? [[u[0], u[1]], [u[4], u[5]]] : null };
  }

  // 关系词按线排在哪（和 app.js 的 arrowPaths、buildMap 同一个算法，改那边要跟着改这里）：线身弯出去的那一侧，离首尾连线的中点
  // 「弯出去的量的一半 + 14」；连线（link）的关系词再按字的宽高（lay.w、lay.h）往外让，返回字那一块的中心；箭头（arrow）返回字的左端
  function labelSpot(type, p1, c, p2, lay) {
    const D = [p2[0] - p1[0], p2[1] - p1[1]], len = Math.hypot(D[0], D[1]) || 1, n = [-D[1] / len, D[0] / len];
    const m = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2], bow = (c[0] - m[0]) * n[0] + (c[1] - m[1]) * n[1];
    const off = bow / 2 + 14 * Math.sign(bow || 1), l = [m[0] + n[0] * off, m[1] + n[1] * off];
    if (type !== 'link' || !lay || !num(lay.w) || !num(lay.h)) return l;
    const L = Math.hypot(l[0] - m[0], l[1] - m[1]) || 1, u = [(l[0] - m[0]) / L, (l[1] - m[1]) / L];
    const k = -14 + 8 + Math.abs(u[0]) * lay.w / 2 + Math.abs(u[1]) * lay.h / 2;
    return [l[0] + u[0] * k, l[1] + u[1] * k];
  }

  // 箭头、连线只有一头跟着选中的笔迹走（2026-11-17 用户说可以处理的毛病：原来整条留在原处，被挪走的那一头落在空白上）。
  // end 是 'to'（终点、带箭头的那头，对应 on）或 'from'（起点，对应 on2）：那一头的端点挪 (dx, dy)，另一头一点不动，线跟着变斜、变长。
  // 弯的样子不变：控制点在首尾连线上的位置（沿线、垂直于线，都按连线长量）照旧；箭头那两笔按终点处线的走向转过去，长短、张开的角度不变；
  // 关系词（lay）、连线的 ✓ × 钮围着的框（box、vbox）按 labelSpot 在新线上该在的地方挪过去（挪的量是新旧两处之差，原来排字时让开的一点照旧）；
  // 点、擦的范围 hit 按新的首尾重算（arrowPaths、buildMap 的算法：首尾外面 10，连线连同关系词那一块）；箭头的 box（终点那块）终点跟着走时挪。
  // 换成新的数组、对象，不在原处改。线身认不出来（不是「M Q」一段）返回 false，什么都不改（留在原处）
  function bendItem(a, end, dx, dy) {
    const g = shaftOf(a);
    if (!g || (end !== 'to' && end !== 'from')) return false;
    const f = (v) => String(r1(v)), isBox = (b) => Array.isArray(b) && b.length === 4 && b.every(num);
    const mv = (p) => [shiftNum(p[0], dx), shiftNum(p[1], dy)];
    const p1 = end === 'from' ? mv(g.p1) : g.p1, p2 = end === 'to' ? mv(g.p2) : g.p2;
    const D = [g.p2[0] - g.p1[0], g.p2[1] - g.p1[1]], L2 = D[0] * D[0] + D[1] * D[1], q = [g.c[0] - g.p1[0], g.c[1] - g.p1[1]];
    const u = L2 ? (q[0] * D[0] + q[1] * D[1]) / L2 : 0.5, w = L2 ? (q[1] * D[0] - q[0] * D[1]) / L2 : 0; // 沿线、垂直于线（向左为正）
    const E = [p2[0] - p1[0], p2[1] - p1[1]];
    const c = [r1(p1[0] + u * E[0] - w * E[1]), r1(p1[1] + u * E[1] + w * E[0])];
    const paths = a.paths.slice();
    paths[0] = Object.assign({}, a.paths[0], { d: `M${f(p1[0])} ${f(p1[1])} Q${f(c[0])} ${f(c[1])} ${f(p2[0])} ${f(p2[1])}` });
    if (g.head) {
      const unit = (x, y) => { const l = Math.hypot(x, y); return l > 1e-9 ? [x / l, y / l] : null; };
      const t0 = unit(g.p2[0] - g.c[0], g.p2[1] - g.c[1]) || unit(D[0], D[1]) || [1, 0];
      const t1 = unit(p2[0] - c[0], p2[1] - c[1]) || unit(E[0], E[1]) || t0;
      const turn = (h) => { // 在终点处线的走向上（沿线 s、向左 t）的位置不变
        const r = [h[0] - g.p2[0], h[1] - g.p2[1]], s = r[0] * t0[0] + r[1] * t0[1], t = r[1] * t0[0] - r[0] * t0[1];
        return [p2[0] + s * t1[0] - t * t1[1], p2[1] + s * t1[1] + t * t1[0]];
      };
      const h1 = turn(g.head[0]), h2 = turn(g.head[1]);
      paths[1] = Object.assign({}, a.paths[1], { d: `M${f(h1[0])} ${f(h1[1])} L${f(p2[0])} ${f(p2[1])} L${f(h2[0])} ${f(h2[1])}` });
    }
    a.paths = paths;
    const s0 = labelSpot(a.type, g.p1, g.c, g.p2, a.lay), s1 = labelSpot(a.type, p1, c, p2, a.lay), lx = s1[0] - s0[0], ly = s1[1] - s0[1];
    if (a.lay && num(a.lay.x) && num(a.lay.y)) a.lay = Object.assign({}, a.lay, { x: a.lay.x + lx, y: a.lay.y + ly });
    if (a.type === 'link') { for (const k of ['box', 'vbox']) if (isBox(a[k])) { const b = a[k]; a[k] = [r1(b[0] + lx), r1(b[1] + ly), r1(b[2] + lx), r1(b[3] + ly)]; } }
    else if (end === 'to' && isBox(a.box)) a.box = [shiftNum(a.box[0], dx), shiftNum(a.box[1], dy), shiftNum(a.box[2], dx), shiftNum(a.box[3], dy)];
    if (isBox(a.hit)) {
      let h = [Math.min(p1[0], p2[0]) - 10, Math.min(p1[1], p2[1]) - 10, Math.max(p1[0], p2[0]) + 10, Math.max(p1[1], p2[1]) + 10];
      if (a.type === 'link' && isBox(a.vbox)) h = [Math.min(h[0], a.vbox[0]), Math.min(h[1], a.vbox[1]), Math.max(h[2], a.vbox[2]), Math.max(h[3], a.vbox[3])];
      a.hit = h.map(r1);
    }
    return true;
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

  // Claude 的这一条怎么跟着选中的笔迹走：'go' 整条平移，'to'、'from' 只有箭头、连线的那一头跟着走（bendItem），'' 不跟。
  // 一般的：它指着的、没擦掉的笔迹（on）至少有一笔，而且全在选中的里面（sel），整条平移。live 是这一页没擦掉的笔迹 id。
  // 还指着别的笔迹的、没指着笔迹的（指着印刷文字的 box、页面末尾、图和公式本来就不记 on）、指着书页上印刷文字的修改建议（onDoc）、
  // 以前的「挪动、收起」提议（proposal，不画）都不跟。
  // 箭头、连线（arrow、link）两头分开看：终点指着的笔迹记在 on，起点的记在 on2。一头指着的（没擦掉的）全在选中的里面，那一头跟着走；
  // 两头都是，整条平移；另一头指着没选中的笔迹、只选中了一部分、或者指着印刷文字（那一头没记笔迹），那一头不动（2026-11-17）。
  // 概念图上建议的新概念（node）还连到别的组（连线的另一头只记在路径里，没记是哪几笔）：linkOk(终点) 说那一头也在选中的里面才跟
  function followMode(a, sel, live, linkOk) {
    if (!a || typeof a !== 'object' || a.type === 'proposal' || a.onDoc) return '';
    const alive = (v) => (Array.isArray(v) ? v : []).filter((id) => live.has(id));
    const all = (ids) => ids.length > 0 && ids.every((id) => sel.has(id));
    if (a.type === 'arrow' || a.type === 'link') {
      const to = all(alive(a.on)), from = all(alive(a.on2));
      return to && from ? 'go' : to ? 'to' : from ? 'from' : '';
    }
    if (!all(alive(a.on).concat(alive(a.on2)))) return '';
    if (a.type === 'node') for (const p of linkEnds(a)) if (!linkOk || !linkOk(p)) return '';
    return 'go';
  }

  // 拖动夹在纸内：box 是拖着走的这一块 [x0, y0, x1, y1]（选中的笔迹连同跟着走、看得见的蓝字），bounds 是纸 [x0, y0, x1, y1]。
  // 返回夹过的 [dx, dy]。本来就出了纸边的那一边不能再往外挪，也不硬拉回来
  function clampDelta(box, bounds, dx, dy) {
    const lx = Math.min(0, bounds[0] - box[0]), hx = Math.max(0, bounds[2] - box[2]);
    const ly = Math.min(0, bounds[1] - box[1]), hy = Math.max(0, bounds[3] - box[3]);
    return [Math.max(lx, Math.min(hx, dx)), Math.max(ly, Math.min(hy, dy))];
  }

  return { SHARE, inPolygon, pick, shiftNum, shiftPts, shiftPath, shiftItem, FIELDS, fieldsOf, putFields, shaftOf, labelSpot, bendItem, linkEnds, followMode, clampDelta };
});

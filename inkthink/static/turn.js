// 旋转这一页的换算（纯计算，不碰界面；平板和 Node 测试共用）。
// 页面坐标里正文宽度总是 1000：底图转 90° 后长宽对调，再按宽度缩放回 1000。
// 矩阵同 canvas 的 [a, b, c, d, e, f]：x' = a·x + c·y + e，y' = b·x + d·y + f。
(function (root) {
  'use strict';
  const W = 1000;
  const r1 = (v) => Math.round(v * 10) / 10;

  // 底图转了 rot 度时在页面上的高度（h0：没转时的高度）
  function heightAt(rot, h0) {
    return rot % 180 ? (W * W) / h0 : h0;
  }

  // 转一次 90°（dir 1 顺时针，-1 逆时针）；hc：转之前底图的高度
  function step(dir, hc) {
    const k = W / hc;
    return dir > 0 ? [0, k, -k, 0, k * hc, 0] : [0, -k, k, 0, 0, k * W];
  }

  // 先 m1 再 m2
  function compose(m2, m1) {
    return [
      m2[0] * m1[0] + m2[2] * m1[1], m2[1] * m1[0] + m2[3] * m1[1],
      m2[0] * m1[2] + m2[2] * m1[3], m2[1] * m1[2] + m2[3] * m1[3],
      m2[0] * m1[4] + m2[2] * m1[5] + m2[4], m2[1] * m1[4] + m2[3] * m1[5] + m2[5],
    ];
  }

  // 转角 from 的页面坐标 → 转角 to 的（顺时针一步步转过去）
  function between(from, to, h0) {
    let m = [1, 0, 0, 1, 0, 0], r = ((from % 360) + 360) % 360;
    const end = ((to % 360) + 360) % 360;
    while (r !== end) {
      m = compose(step(1, heightAt(r, h0)), m);
      r = (r + 90) % 360;
    }
    return m;
  }

  function apply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  // 转 90° 的倍数时矩形还是矩形：两个对角换算后取外框
  function box(m, b) {
    const p = apply(m, b[0], b[1]), q = apply(m, b[2], b[3]);
    return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
  }

  // 批注路径只有绝对坐标的 M / L / Q / C，数字两两成对
  function path(m, d) {
    const out = [], toks = String(d).match(/[A-Za-z]|-?\d*\.?\d+/g) || [];
    let cmd = '', nums = [];
    const flush = () => {
      if (!cmd) return;
      const ps = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const p = apply(m, nums[i], nums[i + 1]);
        ps.push(r1(p[0]) + ' ' + r1(p[1]));
      }
      out.push(cmd + ps.join(' '));
    };
    for (const t of toks) {
      if (/[A-Za-z]/.test(t)) { flush(); cmd = t; nums = []; } else nums.push(parseFloat(t));
    }
    flush();
    return out.join(' ');
  }

  // 长回答的圈号半径（和 app.js 的 BADGE_R 一样）
  const BADGE_R = 13;

  // 整页转 90°：笔迹、批注当场换算，纸的大小按内容重新算。改的是 page 本身。
  // o：{ h0 没转时的底图高度, mainW 转之前的正文区宽度（页边从这里开始） }
  function turnPage(page, dir, o) {
    const rot = page.rot || 0, hc = heightAt(rot, o.h0), m = step(dir, hc), k = W / hc;
    const nr = (rot + (dir > 0 ? 90 : 270)) % 360, nh = heightAt(nr, o.h0);
    const B = [0, 0, W, nh];
    const grow = (b) => { B[0] = Math.min(B[0], b[0]); B[1] = Math.min(B[1], b[1]); B[2] = Math.max(B[2], b[2]); B[3] = Math.max(B[3], b[3]); };

    for (const st of page.strokes) {
      st.pts = st.pts.map((p) => { const q = apply(m, p[0], p[1]); return [r1(q[0]), r1(q[1])].concat(p.slice(2)); });
      st.w = Math.round((st.w || 2.1) * k * 100) / 100;
      delete st._box;
      if (!st.erasedAt && st.pts.length) {
        const xs = st.pts.map((p) => p[0]), ys = st.pts.map((p) => p[1]);
        grow([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
    }

    // 页边上的批注另外摆；长回答的圈号跟着页面转（圆心换算）；其余（下划线、圈、箭头）整体换算，文字保持正着
    // 收成小蓝点的短批注（阶段 D1，空白本子）：点和圈号一样按圆心换算；它那几行字（lay）照下面的办法挪，
    // 浮出来写过红字时记下的换算（popMap）跟着那几行字一起挪，红字不错位
    const margin = [], lay0 = new Map();
    for (const a of page.ai) {
      if (a.type === 'write') {
        // 摊在纸上的长回答（2026-11-17）：转页后那一段和所答笔迹的相对位置对不上了，收回圈号（用户能在卡片上再点「摊在纸上」）
        if (a.spread) delete a.spread;
        if (Array.isArray(a.at) && a.at.length === 2) {
          a.at = apply(m, a.at[0], a.at[1]).map(r1);
          if (!a.erasedAt) grow([a.at[0] - BADGE_R, a.at[1] - BADGE_R, a.at[0] + BADGE_R, a.at[1] + BADGE_R]);
        }
        continue;
      }
      if (a.dot && Array.isArray(a.dot.at) && a.dot.at.length === 2) {
        a.dot.at = apply(m, a.dot.at[0], a.dot.at[1]).map(r1);
        if (!a.erasedAt && !a.dismissed) grow([a.dot.at[0] - 10, a.dot.at[1] - 10, a.dot.at[0] + 10, a.dot.at[1] + 10]);
      }
      if (a.lay && a.popMap) lay0.set(a, [a.lay.x, a.lay.y]);
      if (a.lay && a.lay.x >= o.mainW - 1) { margin.push(a); continue; }
      if (a.box) a.box = box(m, a.box).map(r1);
      for (const p of a.paths || []) p.d = path(m, p.d);
      if (a.lay) {
        const c = apply(m, a.lay.x + a.lay.w / 2, a.lay.y + a.lay.h / 2);
        a.lay.x = r1(c[0] - a.lay.w / 2);
        a.lay.y = r1(c[1] - a.lay.h / 2);
      }
      if (a.hit) a.hit = box(m, a.hit).map(r1);
      if (a.sym) a.sym = box(m, a.sym).map(r1); // 批改符号本身占的地方
      if (a.vbox) a.vbox = box(m, a.vbox).map(r1); // 概念图上的建议：✓ × 钮跟着的框
      if (a.fig) { // 图：按中心换算，图还是正着放；占的地方跟着图
        const c = apply(m, a.fig.x + a.fig.w / 2, a.fig.y + a.fig.h / 2), f = a.fig, cap = a.text ? 36 : 0;
        f.x = r1(c[0] - f.w / 2);
        f.y = r1(c[1] - f.h / 2);
        a.hit = a.box = a.sym = [f.x - 8, f.y - 8, f.x + f.w + 8, f.y + f.h + Math.max(0, cap) + 8].map(r1);
        for (const lb of a.labels || []) { lb.x = r1(f.x + f.w / 2 - (lb.w || 0) / 2); lb.y = r1(f.y + f.h + 8); }
        if (!a.dismissed) grow(a.hit);
        continue;
      }
      for (const lb of a.labels || []) { // 示意图里的字：按中心换算，字还是横着写
        const c = apply(m, lb.x + (lb.w || 0) / 2, lb.y + lb.fs / 2);
        lb.x = r1(c[0] - (lb.w || 0) / 2);
        lb.y = r1(c[1] - lb.fs / 2);
      }
      if (a.hit && !a.dismissed) grow(a.hit);
    }

    const xw = B[2] > W ? Math.ceil(B[2] + 40 - W) : 0, mainW = W + xw;
    for (const a of margin) {
      const L = a.lay, x = r1(mainW + (L.x - o.mainW));
      const leader = (a.paths || []).find((p) => p.cls === 'leader');
      let y;
      if (leader) {
        const n = String(leader.d).match(/-?\d*\.?\d+/g).map(parseFloat);
        const p = apply(m, n[0], n[1]);
        y = r1(p[1] - L.lh * 0.7);
        leader.d = `M${r1(p[0])} ${r1(p[1])} L${r1(x - 8)} ${r1(y + L.lh * 0.55)}`;
      } else {
        y = r1(L.y * nh / hc);
      }
      Object.assign(L, { x, y });
      for (const p of a.paths || []) if (p !== leader) p.d = path(m, p.d); // 修改建议框在正文上的虚线框
      if (a.box) a.box = box(m, a.box).map(r1);
      a.hit = [r1(x - 6), r1(y - 4), r1(x + L.w), r1(y + L.h + 4)];
      if (!a.dismissed) grow([B[0], a.hit[1], B[2], a.hit[3]]);
    }
    for (const [a, p0] of lay0) {
      a.popMap.x0 = r1(a.popMap.x0 + a.lay.x - p0[0]);
      a.popMap.y0 = r1(a.popMap.y0 + a.lay.y - p0[1]);
    }

    page.rot = nr;
    page.ox = B[0] < 0 ? Math.ceil(-B[0] + 40) : 0;
    page.oy = B[1] < 0 ? Math.ceil(-B[1] + 40) : 0;
    page.xw = xw;
    page.h = B[3] > nh ? Math.ceil(B[3] + 80) : 0;
    return { rot: nr, baseH: nh };
  }

  const api = { heightAt, step, between, apply, box, path, turnPage };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Turn = api;
})(typeof window !== 'undefined' ? window : this);

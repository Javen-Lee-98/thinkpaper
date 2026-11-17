// static/turn.js 的测试：node --test tests/test_turn.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const T = createRequire(import.meta.url)('../static/turn.js');

const near = (a, b, eps = 0.11) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const nearPt = (p, q) => { near(p[0], q[0]); near(p[1], q[1]); };

test('底图转 90° 后的高度：宽度仍是 1000，长宽对调后按宽度缩放', () => {
  near(T.heightAt(90, 562.5), 1777.8);
  near(T.heightAt(270, 562.5), 1777.8);
  assert.equal(T.heightAt(180, 562.5), 562.5);
  assert.equal(T.heightAt(0, 1414), 1414);
});

test('右转一次：左上角到右上角，左下角到左上角；左转相反', () => {
  const r = T.step(1, 562.5), l = T.step(-1, 562.5);
  nearPt(T.apply(r, 0, 0), [1000, 0]);
  nearPt(T.apply(r, 0, 562.5), [0, 0]);
  nearPt(T.apply(l, 0, 0), [0, 1777.8]);
  nearPt(T.apply(l, 1000, 0), [0, 0]);
});

test('between：0→90 等于右转一次；90→0 再 0→90 回到原处', () => {
  const a = T.between(0, 90, 562.5), b = T.between(90, 0, 562.5);
  nearPt(T.apply(a, 100, 200), T.apply(T.step(1, 562.5), 100, 200));
  const p = T.apply(a, 100, 200);
  nearPt(T.apply(b, p[0], p[1]), [100, 200]);
  assert.deepEqual(T.between(180, 180, 562.5), [1, 0, 0, 1, 0, 0]);
});

test('框和路径的换算', () => {
  const m = T.step(1, 562.5);
  const b = T.box(m, [0, 0, 100, 50]);
  near(b[0], 1000 - 50 * 1000 / 562.5); near(b[1], 0); near(b[2], 1000); near(b[3], 100 * 1000 / 562.5);
  assert.equal(T.path(m, 'M0 0 L1000 562.5'), 'M1000 0 L0 1777.8');
  assert.equal(T.path(m, 'M0 0 Q0 562.5 1000 562.5'), 'M1000 0 Q0 0 0 1777.8');
});

const wrap = (t) => [t];
const page = (extra) => Object.assign({ strokes: [], ai: [], reads: [], h: 0, xw: 0, ox: 0, oy: 0, rot: 0 }, extra);

test('整页右转再左转：笔迹回到原处，笔宽、转角复原', () => {
  const p = page({ strokes: [{ id: 's', t0: 1, w: 2.1, pts: [[100, 100, 0.5, 0], [140, 110, 0.5, 30]], _box: [1, 2, 3, 4] }] });
  const r = T.turnPage(p, 1, { h0: 562.5, mainW: 1000, wrap });
  assert.equal(r.rot, 90); near(r.baseH, 1777.8);
  assert.equal(p.rot, 90);
  nearPt(p.strokes[0].pts[0], [1000 / 562.5 * 462.5, 1000 / 562.5 * 100]);
  assert.equal(p.strokes[0].pts[0][2], 0.5); // 压力、时间原样
  assert.equal(p.strokes[0]._box, undefined); // 缓存的外框作废
  near(p.strokes[0].w, 3.73, 0.01);
  T.turnPage(p, -1, { h0: 562.5, mainW: 1000, wrap });
  assert.equal(p.rot, 0);
  nearPt(p.strokes[0].pts[0], [100, 100]);
  nearPt(p.strokes[0].pts[1], [140, 110]);
  near(p.strokes[0].w, 2.1, 0.01);
});

test('转到纸外的内容：纸往那边扩（ox/oy/xw/h 按内容重新算）', () => {
  const p = page({ h: 2100, strokes: [{ id: 's', t0: 1, w: 2, pts: [[500, 2000, 0.5, 0]] }] });
  T.turnPage(p, 1, { h0: 1414, mainW: 1000, wrap });
  const x = 1000 / 1414 * (1414 - 2000);
  nearPt(p.strokes[0].pts[0], [x, 1000 / 1414 * 500]);
  assert.ok(p.ox >= -x + 40 - 1 && p.ox <= -x + 41, `ox=${p.ox}`);
  assert.equal(p.oy, 0);
  assert.equal(p.xw, 0);
  assert.equal(p.h, 0); // 没有超出转后的底图下边
});

test('页边批注留在页边，挪到引线指着的高度；字号不变', () => {
  const note = { id: 'n', type: 'note', text: '单位', lay: { x: 1044, y: 300, w: 336, h: 37, lines: ['单位'], fs: 21, lh: 29 },
    paths: [{ d: 'M106 120 Q500 200 1036 316', cls: 'leader', w: 1.3 }], hit: [1038, 296, 1380, 341], box: [100, 110, 200, 130] };
  const p = page({ mg: true, ai: [note] });
  T.turnPage(p, 1, { h0: 562.5, mainW: 1000, wrap });
  const k = 1000 / 562.5;
  assert.equal(note.lay.x, 1044 + p.xw);
  near(note.lay.y, k * 106 - 29 * 0.7);
  assert.ok(note.paths[0].d.startsWith('M' + Math.round(k * (562.5 - 120) * 10) / 10 + ' '), note.paths[0].d);
  assert.equal(note.lay.fs, 21);
});

test('长回答的圈号跟着页面转（圆心和笔迹一样换算），转回来回到原处；文字不上纸，没有排版可换', () => {
  const ans = { id: 'w', type: 'write', text: '一段回答', q: '问？', n: 1, at: [529, 300], seen: false, on: ['s'] };
  const st = { id: 's', t0: 1, w: 2, pts: [[400, 300, 0.5, 0], [500, 300, 0.5, 30]] };
  const p = page({ strokes: [st], ai: [ans] });
  T.turnPage(p, 1, { h0: 562.5, mainW: 1000 });
  const k = 1000 / 562.5;
  nearPt(ans.at, [k * (562.5 - 300), k * 529]); // (529, 300) 转到 (k·(h0 − 300), k·529)
  near(ans.at[1] - st.pts[1][1], k * 29); // 和所答的那一笔的相对位置跟着转
  assert.deepEqual(Object.keys(ans).sort(), ['at', 'id', 'n', 'on', 'q', 'seen', 'text', 'type']); // 不多出 lay、hit 之类
  T.turnPage(p, -1, { h0: 562.5, mainW: 1000 });
  nearPt(ans.at, [529, 300]);
});

test('收成小蓝点的短批注：点跟着页面转（圆心换算），浮出来时记下的换算跟着那几行字挪；转回来都回到原处', () => {
  const lay = { x: 420, y: 290, w: 200, h: 37, lines: ['车票要提前买'], fs: 21, lh: 29 };
  const n = { id: 'n', type: 'note', text: '车票要提前买', on: ['s'], lay: { ...lay }, hit: [414, 286, 620, 331], box: [100, 290, 400, 310],
    paths: [{ d: 'M402 300 L418 300', cls: 'leader', w: 1.3 }], dot: { at: [410, 300], t: 1, why: 'ink' }, popMap: { x0: 414, y0: 286, w: 200, h: 80, u: 1 } };
  const st = { id: 's', t0: 1, w: 2, pts: [[100, 300, 0.5, 0], [400, 300, 0.5, 30]] };
  const p = page({ strokes: [st], ai: [n] });
  T.turnPage(p, 1, { h0: 562.5, mainW: 1000 });
  const k = 1000 / 562.5;
  nearPt(n.dot.at, [k * (562.5 - 300), k * 410]);
  near(n.dot.at[1] - st.pts[1][1], k * 10); // 和所指那一笔的相对位置跟着转
  near(n.popMap.x0 - n.lay.x, 414 - 420); // 换算和那几行字的相对位置不变
  near(n.popMap.y0 - n.lay.y, 286 - 290);
  assert.equal(n.popMap.w, 200);
  T.turnPage(p, -1, { h0: 562.5, mainW: 1000 });
  nearPt(n.dot.at, [410, 300]);
  nearPt([n.lay.x, n.lay.y], [420, 290]);
  nearPt([n.popMap.x0, n.popMap.y0], [414, 286]);
});

test('修改建议在页边：文字留在页边，正文上的虚线框跟着页面转', () => {
  const sg = { id: 's', type: 'suggest', text: '改为：ρ', lay: { x: 1044, y: 300, w: 336, h: 37, lines: ['改为：ρ'], fs: 21, lh: 29 },
    paths: [{ d: 'M106 120 L1036 316', cls: 'leader', w: 1.3 }, { d: 'M94 104 L206 104 L206 136 L94 136 L94 104', cls: 'sbox', w: 1.6 }],
    hit: [1038, 296, 1380, 341], box: [100, 110, 200, 130] };
  const p = page({ mg: true, ai: [sg] });
  T.turnPage(p, 1, { h0: 562.5, mainW: 1000, wrap });
  const k = 1000 / 562.5, n = sg.paths[1].d.match(/-?\d*\.?\d+/g).map(Number);
  near(n[0], k * (562.5 - 104), 0.2); // (94, 104) 转到 (k·(h0 − 104), k·94)
  near(n[1], k * 94, 0.2);
  assert.deepEqual(sg.box.map(Math.round), [Math.round(k * (562.5 - 130)), Math.round(k * 100), Math.round(k * (562.5 - 110)), Math.round(k * 200)]);
});

test('批改符号跟着转：符号本身占的框（sym）、✓ × 钮的框（vbox）、旁边的字一起换算', () => {
  const mk = { id: 'm', type: 'cross', text: '反了', box: [100, 110, 200, 130], sym: [208, 107, 234, 133],
    paths: [{ d: 'M210 109 L232 131', w: 2.6 }], lay: { x: 244, y: 106, w: 40, h: 30, lines: ['反了'], fs: 20, lh: 26 },
    hit: [100, 106, 284, 136], on: ['s1'], vbox: [208, 107, 234, 133] };
  const p = page({ ai: [mk] });
  T.turnPage(p, 1, { h0: 562.5, mainW: 1000, wrap });
  const k = 1000 / 562.5;
  assert.deepEqual(mk.sym.map(Math.round), [Math.round(k * (562.5 - 133)), Math.round(k * 208), Math.round(k * (562.5 - 107)), Math.round(k * 234)]);
  T.turnPage(p, -1, { h0: 562.5, mainW: 1000, wrap });
  mk.sym.forEach((v, i) => near(v, [208, 107, 234, 133][i], 0.2));
  assert.deepEqual(mk.vbox, mk.sym); // 概念图建议的 ✓ × 钮跟着的框也换算
});

test('示意图里的字跟着转：按中心换算，字还是横着写', () => {
  const sk = { id: 'k', type: 'sketch', box: [100, 300, 700, 600], hit: [100, 300, 700, 600], sym: [100, 300, 700, 600],
    paths: [{ d: 'M120 320 L680 320', w: 2 }], labels: [{ x: 300, y: 400, w: 120, text: '买西瓜', fs: 20 }] };
  const p = page({ ai: [sk] });
  T.turnPage(p, 1, { h0: 562.5, mainW: 1000, wrap });
  const k = 1000 / 562.5, lb = sk.labels[0];
  near(lb.x + lb.w / 2, k * (562.5 - 410), 0.2); // 中心 (360, 410) 转到 (k·(h0 − 410), k·360)
  near(lb.y + lb.fs / 2, k * 360, 0.2);
  assert.equal(lb.w, 120); // 宽度、字号不变
  T.turnPage(p, -1, { h0: 562.5, mainW: 1000, wrap });
  near(lb.x, 300, 0.2);
  near(lb.y, 400, 0.2);
});

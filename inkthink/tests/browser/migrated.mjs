// 迁移旧数据（tools/migrate_cards.py）迁出来的一页，在现在的页面上：
// 照重构前 app.js 写出来的样子造一页旧数据（指着红笔问题的整段回答、红笔问题擦掉后收起的回答连同上面的批注、
// 被改写过的一串加上画在旧版文字上的修改建议、收在回答栏里的回答、页边短批注、judged 里收起的旧笔迹），
// 当场用脚本迁（不手写结果），再打开页面查：圈号落在该在的位置、空心实心对、点开卡片有全文和「之前的版本」、
// 纸上没有整段蓝字、原来藏着的批注笔迹看得见、judged 里的照旧不画、短批注不动、页面没报错。
// 跑法：node tests/run_browser.mjs <临时目录> --only migrated；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, APP, PY, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'migrated', open: false });
const js = T.evalJS;
const T0 = 1793300000000, REQ = '20261030-041539-e825';
const BLUE = 'rgb(47, 95, 174)', WHITE = 'rgb(255, 255, 255)';

// ---- 照旧格式造数据（和 tests/test_migrate.py 的造法一样）
const stroke = (id, t0, x, y, o = {}) => Object.assign({ id, t0, w: 2.1, pts: Array.from({ length: o.n || 8 }, (_, k) => [x + 8 * k, y + (k % 2), 0.12, 30 * k]) },
  o.red ? { c: 'r' } : {}, o.erased ? { erasedAt: o.erased } : {});
const box = (s) => { const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]); return [Math.min(...xs) - s.w, Math.min(...ys) - s.w, Math.max(...xs) + s.w, Math.max(...ys) + s.w]; };
function onPaper(id, t, text, y, o = {}) { // 旧 relayWrite 排在纸上的整段回答
  const x = 48, qn = o.q ? 1 : 0, h = (4 + qn) * 34 + 14;
  const a = { id, req: REQ, type: 'write', t, level: null };
  if (o.on) a.on = o.on;
  if (o.q) a.q = o.q;
  Object.assign(a, { text, lay: Object.assign({ x, y, w: 904, h, lines: (o.q ? ['问：' + o.q] : []).concat(['……', '……', '……', '……']), fs: 24, lh: 34 }, qn ? { qn: 1 } : {}),
    paths: [{ d: `M${x - 20} ${y + 6} Q${x - 21} ${y + h / 2} ${x - 20} ${y + h - 8}`, cls: 'bar', w: 1.8 }], hit: [x - 26, y - 4, x + 904, y + h + 4],
    fold: '▸ ' + (o.q ? '问：' + o.q : text.slice(0, 12)) + ' · 4 行' });
  return Object.assign(a, o.extra || {});
}
const q1 = stroke('q1', T0, 120, 200, { red: true, n: 20 });
const q2 = stroke('q2', T0 + 100, 120, 480, { red: true, n: 12, erased: T0 + 1500 });
const n1 = stroke('n1', T0 + 2500, 600, 560, { n: 10 }), n2 = stroke('n2', T0 + 2600, 600, 600, { n: 10 }); // 写在第 2 段回答上的批注（随收起藏着）
const j1 = stroke('j1', T0, 300, 1200, { n: 20 });
const LONG1 = '先说结论：总价和买的斤数成正比。\n$$y = k \\bar{x}$$\n\n理由：单价不变时，买得越多花得越多。';
const ai = [
  { id: 'c1', req: REQ, type: 'note', t: T0 + 900, level: null, on: ['q1'], text: '页边短批注', box: [118, 190, 276, 212],
    lay: { x: 1022, y: 186, w: 336, h: 37, lines: ['页边短批注'], fs: 21, lh: 29 }, paths: [{ d: 'M280 200 Q650 199 1014 202', cls: 'leader', w: 1.3 }], hit: [1016, 182, 1358, 227] },
  onPaper('w1', T0 + 1000, LONG1, 240, { q: '为什么是线性的？', on: ['q1'] }),
  Object.assign(onPaper('w2', T0 + 2000, '第二条回答：问题擦掉以后收起来了。', 520, { q: '单位对吗？', on: ['q2'] }), { notes: ['n1', 'n2'], shut: true }),
  Object.assign(onPaper('w3a', T0 + 3000, '第一版：和店家有关。', 760, { extra: { revisedBy: 'w3b' } }), { notes: [], shut: true }),
  { id: 's1', req: REQ, type: 'suggest', t: T0 + 3500, level: null, on: ['q1'], ans: 'w3a', text: '改为：和店家无关（只要单价一样）', box: [60, 770, 400, 800],
    lay: { x: 1022, y: 770, w: 336, h: 66, lines: ['改为：和店家无关', '（只要单价一样）'], fs: 21, lh: 29 },
    paths: [{ d: 'M406 785 L1014 785', cls: 'leader', w: 1.3 }, { d: 'M54 764 L406 764 L406 806 L54 806 L54 764', cls: 'sbox', w: 1.6 }], hit: [1016, 766, 1358, 840], verdict: 'yes', sent: true },
  onPaper('w3b', T0 + 4000, '第二版：和店家无关，只要单价一样。', 824, { extra: { revises: 'w3a' } }),
  { id: 'w4', req: REQ, type: 'write', t: T0 + 5000, level: null, text: '收在回答栏里的回答，纸上没有位置。', dock: true },
];
const judged = [{ stamp: '2026-10-30T04:50:54', folded: { strokes: [j1], ai: [{ id: 'x1', req: REQ, type: 'note', t: T0, level: null, on: ['j1'], text: '收起的旧批注',
  box: [300, 1190, 460, 1210], lay: { x: 1022, y: 1190, w: 336, h: 37, lines: ['收起的旧批注'], fs: 21, lh: 29 }, paths: [], hit: [1016, 1186, 1358, 1231] }] },
  moved: { strokes: {}, ai: {} }, nFold: 2, nMove: 0, nKeep: 0 }];
const OLD = { v: 1, strokes: [q1, q2, n1, n2], ai, reads: [], h: 1600, lastSent: T0 + 900, judged };
const DIR = join(T.DATA, 'notebooks', 'scratch'), FILE = join(DIR, 'page-0000.json');
mkdirSync(DIR, { recursive: true });
writeFileSync(FILE, JSON.stringify(OLD), 'utf8');

// ---- 当场用脚本迁：先试跑（不写），再 --apply
const mig = (extra) => execFileSync(PY, [join(APP, 'tools', 'migrate_cards.py'), '--data', T.DATA, '--port', '9', ...extra],
  { cwd: APP, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) }).toString('utf8');
const before = readFileSync(FILE, 'utf8');
const dry = mig([]);
T.ok('试跑：报告里这一页 5 条旧的长回答 → 4 个圈号，文件没动', dry.includes('旧的长回答 5 条 → 圈号 4 个') && readFileSync(FILE, 'utf8') === before, dry.slice(-400));
const out = mig(['--apply', '--originals', join(T.ROOT, 'originals')]);
T.ok('--apply：迁完、复查过了，原件留着', out.includes('写完从磁盘读回来复查') && readFileSync(join(T.ROOT, 'originals', 'notebooks', 'scratch', 'page-0000.json'), 'utf8') === before, out.slice(-300));
const disk = JSON.parse(readFileSync(FILE, 'utf8')), W = disk.ai.filter((a) => a.type === 'write');
const OK = new Set(['id', 'type', 't', 'req', 'text', 'q', 'on', 'n', 'at', 'seen', 'older', 'adopted', 'erasedAt', 'dismissed']);
T.ok('页面文件里：4 条长回答，都只有新格式的字段；画在旧版上的建议并进去了', W.map((a) => a.id).join() === 'w1,w2,w3b,w4' && W.every((a) => Object.keys(a).every((k) => OK.has(k)))
  && !disk.ai.some((a) => a.id === 's1' || a.ans), disk.ai.map((a) => [a.id, Object.keys(a).join('/')]));
T.ok('短批注一个字不动，judged 原样留着', JSON.stringify(disk.ai[0]) === JSON.stringify(ai[0]) && JSON.stringify(disk.judged) === JSON.stringify(judged));

// 照细则该在哪：红笔问题还在 → 它最后一行右边；擦掉了 / 本来没指着 → 原来那段回答的左上角；回答栏里的 → 页面右上角
const bq = box(q1);
const WANT = { w1: [bq[2] + 16 + 13, (bq[1] + bq[3]) / 2], w2: [48 + 13, 520 + 13], w3b: [48 + 13, 760 + 13], w4: [1000 - 13 - 8, 13 + 8] };
const near = (a, b, d = 0.11) => Math.abs(a[0] - b[0]) < d && Math.abs(a[1] - b[1]) < d;
T.ok('圈号位置：1 在红笔问题旁，2、3 在原来回答的左上角，4 在页面右上角', W.every((a) => near(a.at, WANT[a.id])), W.map((a) => [a.id, a.at, WANT[a.id]]));
T.ok('编号按 Claude 回的先后 1–4；在纸上的看过（空心），只在栏里的没看过（实心）', W.map((a) => `${a.n}:${a.seen}`).join() === '1:true,2:true,3:true,4:false', W.map((a) => [a.n, a.seen]));

// ---- 打开页面
await T.go();
await T.waitFor(`window.__ink.S.page.ai.filter((a) => a.type === 'write').length === 4`, 10000);
await sleep(500);
const badges = () => js(`[...document.querySelectorAll('#aiRoot .badge')].filter((g) => !g.classList.contains('nbr-badge')).map((g) => { const c = g.querySelector('circle'), r = c.getBoundingClientRect(), t = g.querySelector('.bdg text');
  return { id: g.dataset.id, cx: r.left + r.width / 2, cy: r.top + r.height / 2, rr: r.width / 2, fill: getComputedStyle(c).fill, stroke: getComputedStyle(c).stroke, tfill: getComputedStyle(t).fill, num: t.textContent }; })`);
let B = await badges();
T.ok('纸上画了 4 个圈号，数字 1–4', B.length === 4 && B.map((b) => b.num).join() === '1,2,3,4', B.map((b) => b.num));
const scr = [];
for (const a of W) scr.push(await T.screenOf(a.at[0], a.at[1]));
T.ok('圈号画在数据里记的位置上（屏幕上差不到 1.5 像素）', B.every((b, k) => Math.hypot(b.cx - scr[k][0], b.cy - scr[k][1]) < 1.5), B.map((b, k) => [b.num, b.cx, b.cy, scr[k]]));
T.ok('看过的 1–3 是空心（白底蓝圈蓝字），没看过的 4 是实心（蓝底白字）', B.slice(0, 3).every((b) => b.fill === WHITE && b.stroke === BLUE && b.tfill === BLUE)
  && B[3].fill === BLUE && B[3].tfill === WHITE, B.map((b) => [b.num, b.fill, b.tfill]));
const vw = await js('document.documentElement.clientWidth');
T.ok('圈号都在屏幕里（右上角那个也没出纸、没出屏）', B.every((b) => b.cx - b.rr >= 0 && b.cx + b.rr <= vw && b.cy - b.rr >= 0), B.map((b) => [b.cx, b.cy, b.rr]));

// 纸上没有整段蓝字：批注层、公式层里没有回答的文字，没有回答左边那条竖线
const layer = await js(`document.querySelector('#aiRoot').textContent + '|' + document.querySelector('#tex').textContent`);
const texts = ['买的斤数', '第二条回答', '第一版', '第二版', '收在回答栏', '为什么是线性的', '单位对吗', '改为：和店家无关'];
T.ok('纸上没有回答文字（批注层和公式层里都没有），只有短批注和圈号数字', texts.every((s) => !layer.includes(s)) && layer.includes('页边短批注') && !layer.includes('收起的旧批注'), layer.slice(0, 120));
T.ok('纸上没有回答左边那条竖线、没有建议框', (await T.count('#aiRoot path.bar, #aiRoot path.sbox')) === 0 && (await T.count('#tex .katex')) === 0);

// 原来随收起的回答藏着的批注笔迹：现在是普通笔迹，画出来了；judged 里收起的照旧不画
const inkAlpha = (s) => js(`(() => { const v = window.__ink.S.view, c = document.querySelector('#ink'), k = c.width / c.clientWidth, x = c.getContext('2d'); let best = 0;
  for (const p of ${JSON.stringify(s.pts)}) { const d = x.getImageData(Math.round((v.tx + p[0] * v.s) * k) - 2, Math.round((v.ty + p[1] * v.s) * k) - 2, 5, 5).data;
    for (let i = 3; i < d.length; i += 4) best = Math.max(best, d[i]); } return best; })()`);
const ids = await js(`window.__ink.S.page.strokes.filter((s) => !s.erasedAt).map((s) => s.id)`);
const alpha = [await inkAlpha(n1), await inkAlpha(n2), await inkAlpha(q1), await inkAlpha(j1)];
// （缩到一屏宽时线只有一个多像素粗，最浓的那点在 150–180 左右；和同一页上普通的红笔问题比）
T.ok('原来藏着的两笔批注露出来了：在页面数据里、画在笔迹画布上，和别的笔迹差不多浓', ids.includes('n1') && ids.includes('n2')
  && Math.min(alpha[0], alpha[1]) >= 100 && Math.min(alpha[0], alpha[1]) >= 0.75 * alpha[2], [ids, alpha]);
T.ok('judged 里收起的旧笔迹照旧不显示（不在页面笔迹里、画布上那里是空的）', !ids.includes('j1') && alpha[3] === 0, alpha[3]);
await T.shot('migrated-page.png');

// ---- 点开卡片
const card = () => js(`(() => { const c = document.querySelector('#answerCard'); if (c.hidden) return null; const q = document.querySelector('#acQ'), o = document.querySelector('#acOlder');
  return { q: q.hidden ? null : q.textContent, body: document.querySelector('#acBody').textContent, tex: Boolean(c.querySelector('#acBody .ac-tex .katex')),
    older: o.hidden ? null : [...document.querySelectorAll('#acOlist .ac-old')].map((d) => d.textContent), head: o.hidden ? null : o.querySelector('.ac-oh').textContent }; })()`);
await T.fingerTapAt(B[2].cx, B[2].cy);
let C = await card();
T.ok('点圈号 3（改写过的那一串）：卡片里是最新一版的全文', Boolean(C) && C.body === '第二版：和店家无关，只要单价一样。' && C.q === null, C);
T.ok('卡片下面「之前的版本」：先是画在旧版上的修改建议，再是第一版', Boolean(C && C.older) && C.head === '之前的版本'
  && JSON.stringify(C.older) === JSON.stringify(['修改建议：改为：和店家无关（只要单价一样）（你同意了这条）', '第一版：和店家有关。']), C && C.older);
await T.shot('migrated-card-3.png');
await T.fingerTapAt(B[0].cx + 150, B[0].cy + 900);
await T.fingerTapAt(B[0].cx, B[0].cy);
C = await card();
T.ok('点圈号 1：顶上「问：为什么是线性的？」，正文全文，单独一行的公式排好了，没有之前的版本', Boolean(C) && C.q === '问：为什么是线性的？' && C.body.includes('先说结论：总价和买的斤数成正比。')
  && C.body.includes('理由：单价不变时，买得越多花得越多。') && C.tex && !C.body.includes('$$') && C.older === null, C);
await T.shot('migrated-card-1.png');
await T.fingerTapAt(B[0].cx + 150, B[0].cy + 900);
await T.fingerTapAt(B[3].cx, B[3].cy);
C = await card();
T.ok('点圈号 4（原来在回答栏里）：卡片打开，有全文', Boolean(C) && C.body === '收在回答栏里的回答，纸上没有位置。', C);
await T.fingerTapAt(B[0].cx + 150, B[0].cy + 900);
B = await badges();
T.ok('看过以后圈号 4 变空心', B[3].fill === WHITE && B[3].tfill === BLUE, B[3]);
T.ok('存上了：页面文件里圈号 4 记为看过，别的不变', (await T.saved()) && await (async () => { await sleep(400); const p = JSON.parse(readFileSync(FILE, 'utf8'));
  return p.ai.filter((a) => a.type === 'write').map((a) => `${a.n}:${a.seen}`).join() === '1:true,2:true,3:true,4:true' && JSON.stringify(p.judged) === JSON.stringify(judged); })());

T.ok('页面没有报错', !T.errors.length, T.errors);
console.error('截图：' + ['migrated-page.png', 'migrated-card-3.png', 'migrated-card-1.png'].map((f) => join(T.OUT, f)).join('\n'));
await T.finish();

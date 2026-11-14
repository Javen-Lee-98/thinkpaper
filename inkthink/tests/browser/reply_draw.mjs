// Claude 画的三样：示意图（只给结构，电脑上的服务排版）、电脑上生成的图、排好的公式（KaTeX）。
// 都显示出来、不压住已有的字、缩放后还对齐、存盘内容对、刷新后还在、再「检查」时发给 Claude 的图里有它们。
// 跑法：node tests/browser/reply_draw.mjs [临时目录]；有一项不对退出码 1。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'reply-draw' });
const TEX = 'S = \\frac{a+b}{2} \\cdot h = 6 \\times 4';
// 一张「电脑上生成的图」：600 × 300，左半绿、右半白（绿色和黑笔、红笔、蓝字都分得开）
const PNG = join(T.OUT, 'curve.png');
spawnSync(PY, ['-c', 'import sys, fitz; pm = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 600, 300), 0); pm.clear_with(255); pm.set_rect(fitz.IRect(0, 0, 300, 300), (30, 160, 60)); pm.save(sys.argv[1])', PNG]);

// 这一页上 Claude 画的每一样：页面数据，加上它在屏幕上画出来的样子（外框、图、字、线）；还有公式那一层
const blocks = () => T.evalJS(`(() => { const S = window.__ink.S, out = { view: S.view.s }, rc = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  for (const a of S.page.ai) { const g = document.querySelector('#aiRoot [data-id="' + a.id + '"]'); out[a.type] = Object.assign(JSON.parse(JSON.stringify(a)), { dom: g && { g: rc(g), img: rc(g.querySelector('image.fig')),
    href: (g.querySelector('image.fig') || { getAttribute: () => '' }).getAttribute('href').split('&')[0], texts: Array.from(g.querySelectorAll('text')).map((t) => [t.textContent].concat(rc(t))), paths: g.querySelectorAll('path').length, dash: g.querySelectorAll('path.dash').length } }); }
  const tx = document.querySelector('#tex .tx'), k = tx && tx.querySelector('.katex');
  out.tex = tx && { rect: rc(tx), katex: rc(k), frac: tx.querySelectorAll('.katex .mfrac').length, font: k ? getComputedStyle(k).fontFamily : '', text: tx.textContent };
  out.strokes = S.page.strokes.filter((s) => !s.erasedAt).map((s) => { const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; });
  return out; })()`);
async function landed(n) { // 等写回的 n 条落到这一页，并且一笔笔画完
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await T.evalJS(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
const meets = (p, q) => p[0] < q[2] && p[2] > q[0] && p[1] < q[3] && p[3] > q[1];
// 三样在屏幕上的位置和它们的页面坐标对得上（公式、图差不到 3 像素；示意图里的字是手写体带一点歪，放宽到 8）
async function aligned(B) {
  const near = (a, b, d = 3) => Math.abs(a[0] - b[0]) < d && Math.abs(a[1] - b[1]) < d;
  const lb = B.sketch.labels[0], t = B.sketch.dom.texts.find((x) => x[0] === lb.text);
  return { formula: near(B.tex.rect, await T.screenOf(B.formula.lay.x, B.formula.lay.y)),
    figure: near(B.figure.dom.img, await T.screenOf(B.figure.fig.x, B.figure.fig.y)) && Math.abs(B.figure.dom.img[2] - B.figure.fig.w * B.view) < 3,
    sketch: Boolean(t) && near(t.slice(1), await T.screenOf(lb.x, lb.y), 8) };
}
// 发给 Claude 的那张图里，几块地方各有多少绿色、蓝色的点（隔一个点数一个）：返回 [[数了几个点, 绿, 蓝], …]
function colours(img, rects) {
  const r = spawnSync(PY, ['-c', `import sys, json, fitz
pm = fitz.Pixmap(sys.argv[1]); n, s, w, out = pm.n, pm.samples, pm.width, []
for x0, y0, x1, y1 in json.loads(sys.argv[2]):
    t = g = b = 0
    for y in range(max(0, int(y0)), min(pm.height, int(y1)), 2):
        for x in range(max(0, int(x0)), min(w, int(x1)), 2):
            i = (y * w + x) * n; R, G, B = s[i], s[i + 1], s[i + 2]; t += 1
            g += G > 120 and R < 100 and B < 120; b += B > 120 and B - R > 50
    out.append([t, g, b])
print(json.dumps(out))`, img, JSON.stringify(rects)], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch (e) { return [[0, 0, 0, r.stderr.slice(-300)]]; }
}
// 两根手指在屏幕上 (cx, cy) 两侧张开：从相距 d0 到 d1（放大）
async function pinch(cx, cy, d0, d1) {
  const pts = (d) => [{ x: cx - d / 2, y: cy, id: 1 }, { x: cx + d / 2, y: cy, id: 2 }];
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(d0) });
  for (let k = 1; k <= 6; k++) await T.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d0 + ((d1 - d0) * k) / 6) });
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(600);
}

// 1. 红笔问一句，黑笔写两行（第三行紧挨在第二行下面），点「检查」
await T.tap('#tools [data-tool=red]');
await T.pen(T.line(120, 160, 300));
await T.tap('#tools [data-tool=pen]');
await T.pen(T.line(120, 280, 400));
await T.pen(T.line(120, 420, 400));
T.ok('写了三笔', existsSync(PNG) && (await T.strokes()) === 3, [existsSync(PNG), await T.strokes()]);
await T.tap('#check');
const sub1 = await T.waitSub('S1'), meta1 = sub1 && T.metaOf(sub1);
T.ok('交上去了，三组笔迹', Boolean(meta1) && meta1.groups.length === 3, meta1 && meta1.groups);
const before = colours(join(T.DATA, 'submissions', sub1.id, 'crop.jpg'), [[0, 0, 9999, 9999]])[0];
T.ok('这时发给 Claude 的图里还没有蓝色和绿色', before[0] > 1000 && before[1] === 0 && before[2] === 0, before);

// 2. Claude 写回：示意图只给结构（三个节点、两条连线、一个分组、一句图注），放在第二行下面；一张图；一个公式
const rep = await T.post('/bridge/reply', { sid: 'S1', submission: sub1.id, items: [
  { type: 'sketch', anchor: 'g2', text: '做晚饭', nodes: ['去超市', '洗蔬菜', '炒青菜'], edges: [{ from: '去超市', to: '洗蔬菜', text: '回家' }, { from: '洗蔬菜', to: '炒青菜' }],
    groups: [{ nodes: ['去超市', '洗蔬菜'], text: '准备' }] },
  { type: 'figure', path: PNG, text: '每月开销' },
  { type: 'formula', tex: TEX }] });
T.ok('服务收下了 3 条', rep.ok === true && rep.count === 3, rep);
T.ok('三样都落到这一页、画完了', await landed(3), await T.evalJS(`window.__ink.S.page.ai.map((a) => a.type)`));
let B = await blocks();
const sk = B.sketch, fg = B.figure, fm = B.formula, lab = (t) => sk.labels.find((l) => l.text === t);

// 3. 示意图：节点、连线上的字、分组名、图注都写出来了；服务排的版是从左到右；分组是虚线框
const want = ['去超市', '洗蔬菜', '炒青菜', '回家', '准备', '做晚饭'];
T.ok('示意图：六处字都写在纸上', Boolean(sk && sk.dom) && want.every((t) => sk.dom.texts.some((x) => x[0] === t && x[3] > 0)), sk && sk.dom && sk.dom.texts.map((x) => x[0]));
T.ok('示意图：三个节点从左到右排在一行，连线上的字在前两个之间', want.every(lab) && lab('去超市').x < lab('洗蔬菜').x && lab('洗蔬菜').x < lab('炒青菜').x
  && Math.abs(lab('去超市').y - lab('炒青菜').y) < 10 && lab('回家').x > lab('去超市').x && lab('回家').x < lab('洗蔬菜').x + lab('洗蔬菜').w, sk && sk.labels);
T.ok('示意图：画了三个方框和两条带箭头的线，分组是虚线框', sk.dom.paths >= 16 && sk.dom.dash >= 4 && sk.dom.paths === sk.paths.length, sk.dom);
T.ok('示意图：图注在图的最下面、居中', lab('做晚饭').y > Math.max(lab('去超市').y, lab('准备').y) && Math.abs(lab('做晚饭').x + lab('做晚饭').w / 2 - (sk.hit[0] + sk.hit[2]) / 2) < 6, [lab('做晚饭'), sk.hit]);

// 4. 图：真的从电脑上取来了（600 × 300），按 2:1 显示，图注写在图下面
const loaded = await T.evalJS(`new Promise((res) => { const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.onerror = () => res(null); im.src = document.querySelector('#aiRoot image.fig').getAttribute('href'); })`);
T.ok('图：平板从电脑上取到了这张图', /^\/api\/figure\?f=[0-9a-f]{16}\.png/.test(fg.dom.href) && Boolean(loaded) && loaded[0] === 600 && loaded[1] === 300, [fg.dom.href, loaded]);
T.ok('图：按原图的宽高比画在纸上', fg.dom.img[2] > 150 && Math.abs(fg.dom.img[2] / fg.dom.img[3] - 2) < 0.02 && Math.abs(fg.fig.w / fg.fig.h - 2) < 0.02, [fg.dom.img, fg.fig]);
const cap = fg.dom.texts.find((x) => x[0] === '每月开销');
T.ok('图：图注写在图的正下方', Boolean(cap) && cap[2] >= fg.dom.img[1] + fg.dom.img[3] - 2 && Math.abs(cap[1] + cap[3] / 2 - (fg.dom.img[0] + fg.dom.img[2] / 2)) < 8, [cap, fg.dom.img]);

// 5. 公式：KaTeX 真的排出来了（有分数的上下结构、用的是 KaTeX 的字体、比一行字高），不是把源码原样写上去
T.ok('公式：KaTeX 排出来了，有分数结构', Boolean(B.tex && B.tex.katex) && B.tex.frac === 1 && /KaTeX_Main/.test(B.tex.font), B.tex);
T.ok('公式：排出来有宽有高（分数比一行字高），纸上看不到反斜杠源码', B.tex.katex[2] > 80 * B.view && B.tex.katex[3] > 26 * 1.5 * B.view && !B.tex.text.includes('\\frac'), [B.tex.katex, B.view, B.tex.text]);
T.ok('公式：记下的占位和排出来的差不多（宽差不到一成，高放得下）', fm.tex === TEX && Math.abs(fm.lay.w * B.view - B.tex.katex[2]) < 0.1 * B.tex.katex[2] && fm.lay.h * B.view >= B.tex.katex[3] - 2, [fm.lay, B.tex.katex]);
T.known('公式：记下的宽度放得下排出来的公式', fm.lay.w * B.view >= B.tex.katex[2] - 1,
  '打开页面后的第一个公式是在 KaTeX 字体载入之前量的宽度，偏窄约 5%（这个公式记 277，排出来 292），量错的还会留在缓存里；static/app.js:3746–3758 measureTex，打开页面时只等了手写体（app.js:5558）',
  [fm.lay.w, B.tex.katex[2] / B.view]);

// 6. 不压住已有的字，三样之间也不叠着；示意图放在所指的第二行下面，而且让开了紧挨着的第三行
const hits = [sk.hit, fg.hit, fm.hit];
T.ok('三样都没有压住我写的字', hits.every((h) => B.strokes.every((s) => !meets(h, s))), [hits, B.strokes]);
T.ok('三样之间不叠着，从上到下依次排开', !meets(sk.hit, fg.hit) && !meets(fg.hit, fm.hit) && sk.hit[3] <= fg.hit[1] && fg.hit[3] <= fm.hit[1], hits);
T.ok('示意图在第二行下面，并且让到了第三行下面', sk.hit[1] > B.strokes[1][3] && sk.hit[1] > B.strokes[2][3], [sk.hit, B.strokes]);
T.ok('三样都在纸的正文区里、都在屏幕上', hits.every((h) => h[0] >= 0 && h[2] <= 1000) && [sk.dom.g, fg.dom.g, B.tex.rect].every((r) => r[0] >= 0 && r[1] >= 0 && r[0] + r[2] <= 834 && r[1] + r[3] <= 1194), [hits, sk.dom.g, fg.dom.g, B.tex.rect]);
const a1 = await aligned(B);
T.ok('没缩放时：公式、图、示意图的字都落在各自的位置上', a1.formula && a1.figure && a1.sketch, a1);

// 7. 存盘内容：示意图带着字和线，图记着文件和大小（电脑上有这张图），公式存的是源码；所指的字擦掉了，图照样留着
T.ok('自己存上了', await T.saved(), await T.evalJS(`({ dirty: window.__ink.S.dirty, saving: window.__ink.S.saving })`));
const dk = Object.fromEntries(T.pageFile('scratch', 0).ai.map((a) => [a.type, a]));
T.ok('页面文件：示意图带着六处字和画好的线', Boolean(dk.sketch) && want.every((t) => dk.sketch.labels.some((l) => l.text === t)) && dk.sketch.paths.length >= 16 && dk.sketch.text === '做晚饭', dk.sketch && dk.sketch.labels);
T.ok('页面文件：图记着文件名、原图大小和图注，电脑上存着这张图', Boolean(dk.figure) && /^[0-9a-f]{16}\.png$/.test(dk.figure.img) && dk.figure.iw === 600 && dk.figure.ih === 300
  && dk.figure.text === '每月开销' && existsSync(join(T.DATA, 'figures', dk.figure.img)), dk.figure);
T.ok('页面文件：公式存的是 LaTeX 源码和位置', Boolean(dk.formula) && dk.formula.tex === TEX && dk.formula.lay.w > 80 && dk.formula.lay.h >= 40, dk.formula);
await T.tap('#tools [data-tool=eraser]');
await T.pen(T.line(130, 280, 380));
T.ok('擦掉示意图所指的第二行：示意图照样留着', (await T.strokes()) === 2 && (await T.count('#aiRoot .ai-sketch')) === 1, [await T.strokes(), await T.count('#aiRoot .ai-sketch')]);
await T.tap('#toolsUndo');
await T.tap('#tools [data-tool=pen]');

// 8. 刷新后三样还在；两根手指张开放大后，还是各自对齐
await T.saved();
await T.reload();
await T.waitFor(`document.querySelector('#tex .tx .katex') && document.querySelector('#aiRoot image.fig')`);
B = await blocks();
const a2 = await aligned(B);
T.ok('刷新后三样还在，位置对得上', Boolean(B.sketch && B.figure && B.formula) && B.tex.frac === 1 && B.sketch.dom.texts.length === 6 && a2.formula && a2.figure && a2.sketch, a2);
const s0 = B.view, c = await T.screenOf(500, 700);
await sleep(600); // 笔刚用过的一秒里落下的手指当成手掌，不算
await pinch(c[0], c[1], 120, 260);
B = await blocks();
const a3 = await aligned(B);
T.ok('两指张开：纸放大了', B.view > s0 * 1.5, [s0, B.view]);
T.ok('放大后：公式、图、示意图的字还是各自对齐', a3.formula && a3.figure && a3.sketch, a3);
T.ok('放大后公式和图跟着变大', B.tex.katex[2] > 80 * s0 * 1.5 && Math.abs(B.figure.dom.img[2] - B.figure.fig.w * B.view) < 3, [B.tex.katex, B.figure.dom.img]);

// 9. 再点「检查」：发给 Claude 的图里有这三样（图的那块是绿的，示意图和公式那两块有蓝色的线和字），消息里列着它们
await T.tap('#check');
const sub2 = await T.waitSub('S1'), meta2 = sub2 && T.metaOf(sub2);
T.ok('又交上去了一次', Boolean(meta2) && sub2.id !== sub1.id, sub2 && sub2.id);
const k = meta2.crop, px = (b) => [(b[0] - k.x0) * k.scale, (b[1] - k.y0) * k.scale, (b[2] - k.x0) * k.scale, (b[3] - k.y0) * k.scale];
const f = B.figure.fig, [cf, cs, cm] = colours(join(T.DATA, 'submissions', sub2.id, 'crop.jpg'), [px([f.x, f.y, f.x + f.w, f.y + f.h]), px(B.sketch.hit), px(B.formula.hit)]);
T.ok('发给 Claude 的图里有那张图（左半是绿的）', cf[0] > 500 && cf[1] / cf[0] > 0.4 && cf[1] / cf[0] < 0.6, cf);
T.ok('发给 Claude 的图里有示意图（蓝色的线和字）', cs[2] > 300, cs);
T.ok('发给 Claude 的图里有公式（蓝字）', cm[2] > 30, cm);
T.ok('消息里列着示意图的图注、图注和公式源码', ['做晚饭', '每月开销', TEX].every((t) => sub2.text.includes(t)) && /你之前在这一页写过的批注/.test(sub2.text), sub2.text.slice(-400));

await T.finish();

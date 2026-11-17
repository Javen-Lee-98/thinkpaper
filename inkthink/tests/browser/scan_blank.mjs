// 空白本子服务端画的图（阶段 E）：平板上阶段 D1 起整屏是纸，服务端给空白本子画的图（整本检测、缩略图、确认卡片的截图、往来稿）
// 也整页是纸——没有右边那一栏的米色底；以前排在那一栏位置的旧批注（x 大于 1000，留在原处）也在图里。
// Claude 照整本检测那张图里的像素回一个 box：落到平板这一页上的位置是对的。
// 同一处（红笔那一笔）在平板点「AI」交的那张图（平板自己画的）和服务端画的图里，各按各自记下的换算（crop）换回页面坐标，是同一个地方。
// 只在无头 Edge 里跑过；笔是 pointerType 为 pen 的鼠标事件。
// 跑法：node tests/run_browser.mjs <临时目录> --only scan_blank；有一项不对退出码 1。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'scan-blank', open: false });
const js = T.evalJS;
const T0 = 1793300000000, REQ = '20261101-101010-ab12';
const stroke = (id, t0, x, y, n, red) => Object.assign({ id, t0, w: 2.1, pts: Array.from({ length: n }, (_, k) => [x + 12.5 * k, y + (k % 2) * 6, 0.5, 30 * k]) }, red ? { c: 'r' } : {});
const q1 = stroke('q1', T0, 120, 300, 25, true), k1 = stroke('k1', T0 + 5000, 120, 480, 33, false);
const OLD = { x: 1040, y: 600, w: 300, h: 66 }; // 以前排在右侧栏位置的旧批注（x 大于 1000），连线拉向 k1
const ai = [{ id: 'o1', req: REQ, type: 'note', t: T0 + 6000, level: null, on: ['k1'], text: '记得带购物袋', box: [118, 478, 522, 488],
  lay: { x: OLD.x, y: OLD.y, w: OLD.w, h: OLD.h, lines: ['记得带购物袋', '周六上午去'], fs: 21, lh: 29 },
  paths: [{ d: 'M528 484 Q780 560 1032 612', cls: 'leader', w: 1.3 }], hit: [OLD.x - 6, OLD.y - 4, OLD.x + OLD.w + 6, OLD.y + OLD.h + 4] }];
const DIR = join(T.DATA, 'notebooks', 'scratch');
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'page-0000.json'), JSON.stringify({ v: 1, strokes: [q1, k1], ai, reads: [], lastSent: T0 + 6000 }), 'utf8');
await T.go();
if (await js('window.__ink.S.flow')) { await js('window.__ink.toggleFlow()'); await sleep(600); }
await sleep(500);

// 一张图（文件）里：米色（书页那一栏的底色）的点数；红、蓝两种颜色的点的外框（像素）
const look = (file) => T.evalJS(`new Promise((res) => { const im = new Image(); im.onload = () => { const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
  const x = cv.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, im.width, im.height).data; let beige = 0; const R = [1e9, 1e9, -1, -1], B = [1e9, 1e9, -1, -1];
  const grow = (b, i) => { const px = (i / 4) % im.width, py = Math.floor(i / 4 / im.width); b[0] = Math.min(b[0], px); b[1] = Math.min(b[1], py); b[2] = Math.max(b[2], px + 1); b[3] = Math.max(b[3], py + 1); };
  for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2];
    if (Math.abs(r - 250) <= 2 && Math.abs(g - 248) <= 2 && Math.abs(b - 243) <= 2) beige++;
    if (r - g > 80 && r - b > 80) grow(R, i); if (b - r > 60 && b - g > 30) grow(B, i); }
  res({ w: im.width, h: im.height, beige, red: R[2] >= 0 ? R : null, blue: B[2] >= 0 ? B : null }); };
  im.onerror = () => res(null); im.src = 'data:image/${file.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(file).toString('base64')}'; })`);
const toPage = (b, c) => [c.x0 + b[0] / c.scale, c.y0 + b[1] / c.scale, c.x0 + b[2] / c.scale, c.y0 + b[3] / c.scale];
const toPx = (b, c) => [(b[0] - c.x0) * c.scale, (b[1] - c.y0) * c.scale, (b[2] - c.x0) * c.scale, (b[3] - c.y0) * c.scale];
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const box = (s) => [Math.min(...s.pts.map((p) => p[0])), Math.min(...s.pts.map((p) => p[1])), Math.max(...s.pts.map((p) => p[0])), Math.max(...s.pts.map((p) => p[1]))];

// ================= 1. 整本检测：空白本子的图整页是纸，旧批注在图里
const scan = await T.post('/bridge/scan', { sid: 'S1', nb: 'scratch', pages: [1] });
const img = ((scan.text || '').split('\n').find((l) => l.startsWith('图：')) || '').slice(2).split('（')[0];
const crop = scan.id ? JSON.parse(readFileSync(join(T.DATA, 'submissions', scan.id, 'meta.json'), 'utf8')).pages['1'].crop : null;
T.ok('（前提）整本检测取到了这一页的图和换算', Boolean(img) && Boolean(crop), [scan.error, img, crop]);
const L1 = await look(img);
T.ok('服务端画的图里没有右边那一栏的米色底', L1 && L1.beige === 0, L1);
T.ok('以前排在那一栏位置的旧批注（x 大于 1000）在图里：图里的蓝字换回页面坐标，落在那条批注的位置',
  L1 && L1.blue && toPage(L1.blue, crop)[2] > OLD.x + 60 && toPage(L1.blue, crop)[3] >= OLD.y + 30 && L1.w >= (OLD.x + OLD.w - crop.x0) * crop.scale - 2, [L1, crop]);

// ================= 2. Claude 照这张图里的像素回一个 box（荧光笔，盖住那条旧批注第一行）：平板上落在对的位置
const want = [OLD.x, OLD.y + 2, OLD.x + 140, OLD.y + 28];
const rep = await T.post('/bridge/reply', { sid: 'S1', submission: scan.id, page: 1, items: [{ type: 'highlight', box: toPx(want, crop).map((v) => Math.round(v * 10) / 10) }] });
T.ok('（前提）服务收下了这一条', rep.ok === true && rep.count === 1, rep);
T.ok('落到这一页了', await T.waitFor(`window.__ink.S.page.ai.some((a) => a.type === 'highlight')`, 10000), await js('window.__ink.S.page.ai.map((a) => a.type)'));
const hb = await js(`window.__ink.S.page.ai.find((a) => a.type === 'highlight').box`);
T.ok('平板上那一块就是 Claude 在图里框的那一块（页面坐标差不到 1）', Array.isArray(hb) && near(hb, want, 1), [hb, want]);

// ================= 3. 同一处，两张图换回来是同一个页面坐标：红笔那一笔
await T.saved();
await T.tap('#check');
const sub = await T.waitSub('S1', 80), meta = sub && T.metaOf(sub);
T.ok('（前提）点「AI」交上去了', Boolean(meta), sub);
const L2 = await look(join(T.DATA, 'submissions', sub.id, 'crop.jpg'));
const fromTablet = L2 && L2.red ? toPage(L2.red, meta.crop) : null, fromServer = L1 && L1.red ? toPage(L1.red, crop) : null;
// 比两边那一笔的中心（两边画线的粗细、线头、JPEG 压缩不一样，外框的两端会差几个单位；中心不受这些影响）和长短
const mid = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
T.ok('平板画的图（点「AI」交的）和服务端画的图（整本检测）里，红笔那一笔换回页面坐标是同一个地方（中心差不到 2，长短差不到 12）',
  Boolean(fromTablet && fromServer) && near(mid(fromTablet), mid(fromServer), 2) && Math.abs((fromTablet[2] - fromTablet[0]) - (fromServer[2] - fromServer[0])) < 12,
  { fromTablet, fromServer, tabletCrop: meta.crop, serverCrop: crop });
T.ok('……也就是数据里那一笔的位置（差不到 5：线宽和抗锯齿）', Boolean(fromServer) && near(fromServer, box(q1), 5), { fromServer, stroke: box(q1) });
T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

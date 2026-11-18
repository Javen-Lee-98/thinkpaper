// 空白本子放大以后挪纸：整屏都画成纸、纸边看不见，所以左、右、上三边不按那条看不见的边卡住——
// 可以一直挪到屏幕上只剩四分之一还是原来的纸；露出来的空白上落笔，纸就长过去，又能接着挪。往下照旧；书页照旧（纸边最多离屏幕边 60 像素）。
// 起因（2026-11-18 用户）：放大很多倍写字时「无法向右拖动…即使看起来右侧完全有空间」。
// 跑法：node tests/browser/blank_pan.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'blank-pan', open: false });
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
doc=fitz.open()
p=doc.new_page(width=595,height=842); p.insert_text((60,100),"值日表",fontsize=30)
doc.save(sys.argv[1])`, join(T.BOOKS, 'one.pdf')]);
await T.go();
const js = T.evalJS;
// 纸的四条边在屏幕（纸面那一块）上的位置，和那一块的大小
const edges = () => js(`(() => { const S = window.__ink.S, st = document.querySelector('#stage'), v = S.view;
  return { L: v.tx + S.X0 * v.s, R: v.tx + S.TW * v.s, T: v.ty + S.Y0 * v.s, B: v.ty + S.pageH * v.s, VW: st.clientWidth, VH: st.clientHeight, s: v.s,
    fitS: S.fitS, TW: S.TW, X0: S.X0, Y0: S.Y0, xw: S.page.xw || 0, ox: S.page.ox || 0, oy: S.page.oy || 0, n: S.page.strokes.filter((x) => !x.erasedAt).length }; })()`);
const origin = () => js(`(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return [r.left, r.top]; })()`);
// 一根手指从 (x0, y0) 拖到 (x1, y1)（纸面那一块里的坐标）
async function drag(x0, y0, x1, y1) {
  const [ox, oy] = await origin();
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: ox + x0, y: oy + y0, id: 1 }] });
  for (let k = 1; k <= 10; k++) { await T.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: ox + x0 + ((x1 - x0) * k) / 10, y: oy + y0 + ((y1 - y0) * k) / 10, id: 1 }] }); await T.sleep(16); }
  await T.sleep(300);
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await T.sleep(250);
}
// 朝一个方向一直拖到拖不动为止（最多 14 次），返回最后的样子
async function dragUntilStuck(dx, dy, pick) {
  let last = null;
  for (let k = 0; k < 14; k++) {
    const e0 = await edges();
    await drag(e0.VW / 2 - dx / 2, e0.VH / 2 - dy / 2, e0.VW / 2 + dx / 2, e0.VH / 2 + dy / 2);
    const e1 = await edges();
    if (last !== null && Math.abs(pick(e1) - last) < 0.5) return e1;
    last = pick(e1);
  }
  return edges();
}
// 两根手指张开：放大约 k 倍
async function pinch(k) {
  const [ox, oy] = await origin(), e = await edges(), cx = ox + e.VW / 2, cy = oy + e.VH / 2, d0 = 60;
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - d0, y: cy, id: 1 }, { x: cx + d0, y: cy, id: 2 }] });
  for (let i = 1; i <= 10; i++) { const d = d0 + ((d0 * k - d0) * i) / 10; await T.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }] }); await T.sleep(16); }
  await T.sleep(200);
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await T.sleep(300);
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const midY = (e) => (e.VH / 2 - e.T) / e.s + e.Y0; // 屏幕正中那一行在纸上的高度（放大以后纸上的 y=300 不一定在屏幕里）

// 1. 草稿本（空白本子）放大三倍多，手指往左拖到拖不动：纸的右边挪到了屏幕四分之一处（原来只能到离右边 60 像素）
await T.sleep(1200); // 页面刚打开的头一秒里手指拖不动纸（已知的毛病，记在 palm.mjs 最后一步）
const e0 = await edges();
await pinch(3.4);
const z = await edges();
T.ok('（前提）两根手指张开：放大到适配宽度的三倍上下', z.s > e0.s * 2.8 && z.s < e0.s * 4, [e0.s, z.s]);
const r1 = await dragUntilStuck(-560, 0, (e) => e.R);
T.ok('放大后往左拖到头：纸的右边到了屏幕宽的四分之一处，右边四分之三是纸外面的空白', near(r1.R, r1.VW * 0.25) && r1.R < r1.VW - 200, r1);

// 2. 在露出来的空白上写一笔：纸往右长过去，把这一笔包进来；再拖，又能往右多挪出一截
const tw0 = r1.TW;
await T.pen(T.line(tw0 + 60, midY(r1), 90), 400);
const g1 = await edges();
T.ok('纸外面的空白上写一笔：这一笔留下了，纸往右长了（长到把它包进来还有余地）', g1.n === r1.n + 1 && g1.xw >= 400 && g1.TW - 60 >= tw0 + 150, g1);
T.ok('写的时候屏幕没动', near(g1.s, r1.s, 0.001) && near(g1.L, r1.L, 0.5), [r1.L, g1.L]);
const r2 = await dragUntilStuck(-560, 0, (e) => e.R);
T.ok('纸长了以后接着往左拖：又能挪到新的右边在屏幕四分之一处', near(r2.R, r2.VW * 0.25) && r2.L < g1.L - 300, [g1.L, r2]);

// 3. 往右拖到头：纸的左边到了屏幕四分之三处；在左边的空白上写一笔，纸往左长
const l1 = await dragUntilStuck(560, 0, (e) => e.L);
T.ok('往右拖到头：纸的左边到了屏幕宽的四分之三处', near(l1.L, l1.VW * 0.75), l1);
await T.pen(T.line(l1.X0 - 150, midY(l1), 90), 400);
const g2 = await edges();
T.ok('左边的空白上写一笔：纸往左长了，原来的字没挪地方', g2.n === l1.n + 1 && g2.ox >= 400 && g2.X0 <= l1.X0 - 400 && near(g2.R, l1.R, 0.5), g2);

// 4. 往下拖到头（看上面）：纸的上边到了屏幕高的四分之三处；往上拖到头（看下面）照旧——纸的下边不高过离屏幕底 60 像素
const t1 = await dragUntilStuck(0, 700, (e) => e.T);
T.ok('往下拖到头：纸的上边到了屏幕高的四分之三处', near(t1.T, t1.VH * 0.75), t1);
const b1 = await dragUntilStuck(0, -700, (e) => e.B);
T.ok('往上拖到头：照旧，纸的下边停在离屏幕底 60 像素', near(b1.B, b1.VH - 60), b1);

// 5. 存到电脑上、刷新后：长出来的纸和那两笔都在
await T.saved();
await T.reload();
const s1 = await edges();
T.ok('刷新后：往右、往左长出来的纸和两笔字都在', s1.xw >= 400 && s1.ox >= 400 && s1.xw === g2.xw && s1.ox === g2.ox && s1.n === 2, s1);

// 6. 书页（有自己的版面、纸边看得见）：照旧，放大后往左、往右拖到头，纸边最多离屏幕边 60 像素
await T.openNotebook('book:one.pdf');
await T.sleep(1200);
await pinch(3.4);
const k1 = await dragUntilStuck(-560, 0, (e) => e.R);
T.ok('书页放大后往左拖到头：纸的右边停在离屏幕右边 60 像素', near(k1.R, k1.VW - 60), k1);
const k2 = await dragUntilStuck(560, 0, (e) => e.L);
T.ok('书页放大后往右拖到头：纸的左边停在离屏幕左边 60 像素', near(k2.L, 60), k2);

await T.finish();

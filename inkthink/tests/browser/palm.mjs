// 写字时手掌、手环碰到屏幕不挪纸（用户写字的手上戴手环）：
// 笔刚用过的一秒内落下的手指不当成挪纸；先搭上来、已经在挪纸的手指，笔一落下就不再跟着它动，写出来的字不歪；
// 手都抬起、过了一秒，单指照常能挪纸。
// 跑法：node tests/browser/palm.mjs [临时目录]；有一项不对退出码 1。
import { boot } from '../browser_lib.mjs';

const T = await boot({ name: 'palm' });
const js = T.evalJS;
const view = () => js(`(() => { const v = window.__ink.S.view; return [Math.round(v.tx), Math.round(v.ty), Math.round(v.s * 1000)]; })()`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// 一根「手指」（手掌、手环在浏览器看来也是它）；坐标都是屏幕上的
const touch = (type, x, y) => T.cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 7, radiusX: 12, radiusY: 12, force: 0.5 }] });
async function drag(x0, y0, dx, dy, steps = 6) { for (let i = 1; i <= steps; i++) { await touch('touchMove', x0 + (dx * i) / steps, y0 + (dy * i) / steps); await T.sleep(16); } }
// 笔（屏幕坐标），可以落下不抬起
const penEv = (type, x, y, buttons) => T.cdp('Input.dispatchMouseEvent', { type, x, y, buttons, button: 'left', clickCount: 1, pointerType: 'pen' });
async function penLine(x0, y0, x1, y1) {
  await penEv('mousePressed', x0, y0, 1);
  for (let i = 1; i <= 8; i++) await penEv('mouseMoved', x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8, 1);
  await penEv('mouseReleased', x1, y1, 0);
}

// 1. 平时：一根手指拖，纸跟着动
await T.sleep(1200);
let v0 = await view();
await touch('touchStart', 300, 700);
await drag(300, 700, 0, -120);
await touch('touchEnd');
await T.sleep(300);
let v1 = await view();
T.ok('平时一根手指拖，纸跟着动', v1[1] < v0[1] && v1[2] === v0[2], [v0, v1]);

// 2. 笔刚写完（一秒内）落下的「手指」：不挪纸
await penLine(200, 300, 420, 300);
T.ok('写了一笔', (await T.strokes()) === 1, await T.strokes());
v0 = await view();
await T.sleep(150);
await touch('touchStart', 520, 900);
await drag(520, 900, 30, -140);
await touch('touchEnd');
await T.sleep(300);
v1 = await view();
T.ok('笔刚抬起就碰到屏幕的手掌、手环：纸不动', same(v0, v1), [v0, v1]);
T.ok('手掌、手环也没有留下笔迹', (await T.strokes()) === 1, await T.strokes());

// 3. 手先搭上来（已经过了一秒，算手指，纸跟着动了一点），接着笔落下：从这一刻起不再跟着它动，写的这一笔是直的。
//    第 1 步已经把纸往上拖到了头，所以这里手先往下带 20（纸有地方动），写的时候再往上、往右滑
await T.sleep(1200);
const vRest = await view();
await touch('touchStart', 560, 930);
await drag(560, 930, 0, 20, 3);
await penEv('mousePressed', 200, 420, 1);
const vPen = await view(); // 笔落下那一刻的画面
for (let i = 1; i <= 8; i++) {
  await penEv('mouseMoved', 200 + i * 30, 420, 1);
  await touch('touchMove', 560 + i * 4, 950 - i * 15); // 手环一边写一边滑
}
const vWrite = await view();
await penEv('mouseReleased', 440, 420, 0);
await drag(560 + 32, 950 - 120, 20, -60); // 笔抬起后手还在滑
await touch('touchEnd');
await T.sleep(300);
const vEnd = await view();
T.ok('先搭上来的手（过了一秒）带着纸动了一点', vPen[1] > vRest[1], [vRest, vPen]);
T.ok('笔落下后，先搭上来的手再怎么滑纸都不动', same(vPen, vWrite) && same(vPen, vEnd), [vPen, vWrite, vEnd]);
const flat = await js(`(() => { const s = window.__ink.S.page.strokes.filter((x) => !x.erasedAt).pop(), ys = s.pts.map((p) => p[1]), xs = s.pts.map((p) => p[0]);
  return { dy: Math.round((Math.max(...ys) - Math.min(...ys)) * 10) / 10, dx: Math.round(Math.max(...xs) - Math.min(...xs)), n: s.pts.length }; })()`);
T.ok('这一笔是直的，没有被带歪', (await T.strokes()) === 2 && flat.dy < 1.5 && flat.dx > 200, flat);

// 4. 手都抬起、过了一秒：单指照常能挪纸
await T.sleep(1200);
v0 = await view();
await touch('touchStart', 300, 700);
await drag(300, 700, 0, 90);
await touch('touchEnd');
await T.sleep(300);
v1 = await view();
T.ok('过了一秒，一根手指又能挪纸', v1[1] > v0[1], [v0, v1]);

// 5. 页面刚打开、还没用过笔的头一秒里，手指照样能挪纸（以前把「没用过笔」当成了「打开那一刻用过笔」，挪不动）。
//    要赶在打开后一秒内落指才测得到；机器慢、页面开得久就跳过这一项
await T.go('', { wait: false });
const fresh = await T.waitFor(`performance.now() < 800 && window.__ink && window.__ink.S.page && window.__ink.S.online`, 5000);
if (fresh) {
  v0 = await view();
  await touch('touchStart', 300, 700);
  const at = await js(`[Math.round(performance.now()), window.__ink.S.penAt || 0]`);
  await drag(300, 700, 0, -120);
  await touch('touchEnd');
  await T.sleep(300);
  v1 = await view();
  if (at[0] < 1000) T.ok('刚打开页面、还没用过笔：手指马上就能挪纸', v1[1] < v0[1], { at, v0, v1 });
} else process.stderr.write('  （页面打开用了 0.8 秒以上，「刚打开手指就能挪纸」这一项这次没测到）\n');
await T.ready();

// 手指连点两下：画面大小、位置都不变（2026-11-16 用户定去掉「双击切换整页 / 适配宽度」：看不见的手势，碰巧撞上时画面突然跳变）
await T.sleep(1200);
const d0 = await view();
for (let k = 0; k < 2; k++) { await touch('touchStart', 320, 760); await T.sleep(50); await touch('touchEnd'); await T.sleep(90); }
await T.sleep(400);
const d1 = await view();
T.ok('手指连点两下：画面大小和位置都不变', same(d0, d1), [d0, d1]);

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

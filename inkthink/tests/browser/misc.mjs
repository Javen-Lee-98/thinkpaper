// 几件零碎的：（a）另一台设备改过这一页后，这台拿着旧版本存会被拒，换成那边的版本，没存上的另存；
// （b）「⋯」菜单里回放本页书写过程；（c）「手指也能书写」开关；（d）全屏时碰到屏幕顶端被系统接管后还能接着写。
// 跑法：node tests/browser/misc.mjs [临时目录]；有一项不对退出码 1。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from '../browser_lib.mjs';

const T = await boot({ name: 'misc', pages: 3 });
const S = (expr) => T.evalJS(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const toastText = () => T.evalJS(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
const view = () => S(`[Math.round(S.view.tx), Math.round(S.view.ty), Number(S.view.s.toFixed(3))]`);
const lastStart = () => S(`(() => { const s = S.page.strokes.at(-1); return s ? [Math.round(s.pts[0][0]), Math.round(s.pts[0][1]), s.pts.length] : null; })()`);
const near = (p, x, y, d = 3) => Boolean(p) && Math.abs(p[0] - x) <= d && Math.abs(p[1] - y) <= d;
const diskPage = () => T.pageFile('scratch', 0);
const waitDisk = async (ok, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const p = diskPage(); if (p && ok(p)) return true; await T.sleep(250); } return false; };
// 电脑上草稿本第 i 页现在存着什么；等到它有 n 笔
const pageApi = (i) => T.apiJson(`/api/page?nb=scratch&i=${i}`);
const savedOn = async (i, n, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await pageApi(i)).strokes.length === n) return true; await T.sleep(250); } return false; };
// 笔迹画布上，纸上 y 这一行附近有多少有墨的点（回放时看哪一笔画出来了）；不给 y 就数整张
const inkAt = (y) => T.evalJS(`(() => { const v = window.__ink.S.view, c = document.querySelector('#ink'), k = c.width / c.clientWidth;
  const top = ${y === undefined ? 0 : `Math.round((v.ty + ${y - 20} * v.s) * k)`}, h = ${y === undefined ? 'c.height' : `Math.round(40 * v.s * k)`};
  const d = c.getContext('2d').getImageData(0, top, c.width, h).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++; return n; })()`);
// 手指从屏幕上一点拖到另一点；lift 为 false 就是没有抬手（被系统接管了）
const finger = async (a, b, lift = true, id = 3) => {
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a[0], y: a[1], id }] });
  for (let i = 1; i <= 6; i++) await T.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a[0] + (b[0] - a[0]) * i / 6, y: a[1] + (b[1] - a[1]) * i / 6, id }] });
  if (lift) await T.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await T.sleep(350);
};
// 笔在屏幕上落下、挪几下，但不抬起（被系统接管了）
const penStuck = async (pts) => {
  const base = { pointerType: 'pen', button: 'left', buttons: 1 };
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: pts[0][0], y: pts[0][1], clickCount: 1 }, base));
  for (const p of pts.slice(1)) await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: p[0], y: p[1] }, base));
  await T.sleep(200);
};

// ---- (a) 页面版本冲突
await T.pen(T.line(100, 200, 200));
T.ok('写一笔存上：版本 1，记着是这台写的', await waitDisk((p) => p.strokes.length === 1 && p.rev === 1 && typeof p.by === 'string' && p.by.length > 0), diskPage());
const p1 = diskPage();
const other = await T.api('/api/page?nb=scratch&i=0', { method: 'PUT', headers: { 'X-Client': 'other-ipad' },
  body: JSON.stringify(Object.assign({}, p1, { strokes: [p1.strokes[0], Object.assign({}, p1.strokes[0], { id: 'o1' }), Object.assign({}, p1.strokes[0], { id: 'o2' })] })) });
T.ok('另一台设备拿着最新版本存了三笔：版本 2', other.status === 200 && diskPage().rev === 2 && diskPage().by === 'other-ipad' && diskPage().strokes.length === 3, [other.status, diskPage().rev]);
await T.pen(T.line(100, 320, 200));
const lost = await S(`S.page.strokes.at(-1).id`);
T.ok('这台拿着旧版本存被拒，平板上说了', await T.waitFor(`/别的设备上改过了/.test(document.querySelector('#toast').textContent) && !document.querySelector('#toast').hidden`)
  && /已换成那边的版本/.test(await toastText()) && (await T.visible('#toast')), await toastText());
T.ok('平板换成了那边的版本（三笔）', await T.waitFor(`window.__ink.S.page && window.__ink.S.page.strokes.map((s) => s.id).slice(1).join() === 'o1,o2'`), await S(`S.page.strokes.map((s) => s.id)`));
T.ok('电脑上那一页还是那边的版本，没被盖掉', diskPage().rev === 2 && diskPage().strokes.length === 3, diskPage().rev);
const cdir = join(T.DATA, 'conflicts'), cfiles = existsSync(cdir) ? readdirSync(cdir) : [];
const keptIds = cfiles.length === 1 ? JSON.parse(readFileSync(join(cdir, cfiles[0]), 'utf8')).strokes.map((s) => s.id) : [];
T.ok('没存上的那份另存在 conflicts 里，里面有刚写的那一笔', cfiles.length === 1 && keptIds.length === 2 && keptIds[1] === lost, [cfiles, keptIds]);
await T.pen(T.line(100, 440, 200));
T.ok('之后照常写、照常存：四笔，版本 3', (await T.strokes()) === 4 && (await waitDisk((p) => p.strokes.length === 4 && p.rev === 3)), [diskPage().strokes.length, diskPage().rev]);

// ---- (b) 回放：先退出全屏才有「⋯」
T.ok('全屏时没有「⋯」', !(await T.visible('#menuBtn')) && (await T.visible('#toolsBars')));
await T.tap('#toolsBars');
T.ok('点「退出全屏」后顶栏上有「⋯」', (await T.visible('#menuBtn')) && !(await S(`S.collapsed`)));
await T.openPage(1);
for (const y of [300, 500, 700]) await T.pen(T.line(150, y, 400, 24), 900); // 三笔，隔一会儿写一笔
const ids0 = await S(`S.page.strokes.map((s) => s.id).join()`), full = [await inkAt(300), await inkAt(500), await inkAt(700), await inkAt()];
await T.tap('#menuBtn');
T.ok('「⋯」菜单里有「回放本页书写过程」', (await T.visible('#menu')) && (await T.visible('#actReplay')) && /回放本页书写过程/.test(await T.text('#actReplay')), await T.text('#actReplay'));
await T.tap('#actReplay', 0);
// 回放的时候隔一小会儿看一眼：三笔各画出来了没有（'100' 就是只有第一笔）
const seen = [];
let replaying = false, toastOn = '';
for (const t0 = Date.now(); Date.now() - t0 < 12000;) {
  const st = await T.evalJS(`(() => { const S = window.__ink.S, v = S.view, c = document.querySelector('#ink'), ctx = c.getContext('2d'), k = c.width / c.clientWidth;
    const has = (y) => { const d = ctx.getImageData(0, Math.round((v.ty + (y - 20) * v.s) * k), c.width, Math.round(40 * v.s * k)).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) return 1; return 0; };
    return { on: Boolean(S.replay), key: '' + has(300) + has(500) + has(700) }; })()`);
  if (st.on && !replaying) { replaying = true; toastOn = await toastText(); }
  if (replaying && !st.on) break;
  if (st.on && seen.at(-1) !== st.key) seen.push(st.key);
  await T.sleep(25);
}
T.ok('点了就开始回放，屏幕上说在回放', replaying && /回放中/.test(toastOn), [replaying, toastOn]);
const order = seen.filter((k) => k !== '000').join('>');
T.ok('笔迹按写的先后一笔一笔重新画出来', order === '100>110>111', seen);
const same = (a, b) => a.every((n, i) => Math.abs(n - b[i]) <= Math.max(2, b[i] * 0.02)); // 重画一遍，边上差一两个点不算
const after = [await inkAt(300), await inkAt(500), await inkAt(700), await inkAt()];
T.ok('放完自己停下，画面和回放前一样', !(await S(`Boolean(S.replay)`)) && same(after, full), [full, after]);
T.ok('回放没动笔迹数据，没有东西要存', (await S(`S.page.strokes.map((s) => s.id).join()`)) === ids0 && !(await S(`S.dirty`)), await S(`S.dirty`));
await T.tap('#menuBtn');
await T.tap('#actReplay', 150);
const mid = [await S(`Boolean(S.replay)`), await inkAt(700)];
await T.pen(T.line(150, 900, 400));
T.ok('回放中落笔不写字，只是停下回放、画面恢复', mid[0] && mid[1] === 0 && (await T.strokes()) === 3 && !(await S(`Boolean(S.replay)`)) && (await inkAt(900)) === 0
  && same([await inkAt()], [full[3]]), [mid, await T.strokes(), await inkAt(900), await inkAt()]);

// ---- (c) 「手指也能书写」：默认手指拖是挪纸，打开后手指能写，记在设备上
await T.sleep(1200); // 笔刚用过一秒内的手指算手掌，等它过去
const A = await T.screenOf(300, 600), B = await T.screenOf(520, 610), UP = [A[0], A[1] - 40];
let v0 = await view();
await finger(A, UP);
let v1 = await view();
T.ok('默认：手指拖是挪纸，不写字', (await T.strokes()) === 3 && v1[1] < v0[1] - 15 && v1[2] === v0[2], [v0, v1]);
await T.tap('#menuBtn');
T.ok('「⋯」菜单里有「手指也能书写」，默认没勾', (await T.visible('#optFinger')) && (await T.evalJS(`document.querySelector('#optFinger').checked`)) === false);
await T.tap('#optFinger');
T.ok('点一下勾上，记在这台设备上', (await T.evalJS(`document.querySelector('#optFinger').checked`)) === true && (await S(`S.fingerDraw`)) === true && (await T.evalJS(`localStorage.getItem('inkthink.finger')`)) === 'true');
v0 = await view();
const fa = await T.screenOf(300, 800), fb = await T.screenOf(520, 810);
await finger(fa, fb);
T.ok('打开后手指能写字，纸不动', (await T.strokes()) === 4 && near(await lastStart(), 300, 800) && JSON.stringify(await view()) === JSON.stringify(v0), [await T.strokes(), await lastStart()]);
T.ok('手指写的也存到电脑上', await savedOn(1, 4), (await pageApi(1)).strokes.length);
await T.reload();
await finger(await T.screenOf(300, 900), await T.screenOf(520, 910));
await T.tap('#menuBtn');
T.ok('刷新后开关还开着，手指照样能写', (await S(`S.fingerDraw`)) === true && (await T.evalJS(`document.querySelector('#optFinger').checked`)) === true
  && (await T.strokes()) === 5 && near(await lastStart(), 300, 900), [await T.strokes(), await lastStart()]);
await T.tap('#optFinger');
v0 = await view();
await finger(await T.screenOf(300, 600), await T.screenOf(300, 560));
v1 = await view();
T.ok('关掉后手指又是挪纸、不写字', (await S(`S.fingerDraw`)) === false && (await T.evalJS(`localStorage.getItem('inkthink.finger')`)) === 'false' && (await T.strokes()) === 5 && v1[1] < v0[1] - 15, [await T.strokes(), v0, v1]);

// ---- (d) 全屏时碰到屏幕顶端被系统接管（收不到抬笔、抬手）之后还能接着写
await T.openPage(2);
await T.tap('#fsBtn', 900);
T.ok('点「全屏」：浏览器进了全屏，只剩纸', (await T.evalJS(`Boolean(document.fullscreenElement)`)) && (await S(`S.collapsed`)) && !(await T.visible('#bar')), await T.evalJS(`Boolean(document.fullscreenElement)`));
await T.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 5, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' });
await T.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 5, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
T.ok('全屏时屏幕最顶端归系统，不落笔', (await T.strokes()) === 0 && !(await S(`Boolean(S.cur)`)), await T.strokes());
await penStuck([[400, 40], [400, 16]]); // 笔往顶端划，被系统接管：没有抬笔
const half = await S(`Boolean(S.cur)`);
await T.pen(T.line(200, 500, 300));
let ls = await lastStart();
T.ok('笔没抬起就被接管后，下一笔照常写在笔尖下面，不接在半截上', half && (await T.strokes()) === 1 && near(ls, 200, 500) && ls[2] >= 5 && !(await S(`Boolean(S.cur)`)), [half, await T.strokes(), ls]);
await T.sleep(1200);
v0 = await view();
await finger([400, 40], [400, 150], false, 7); // 手指从顶端往下拉，被系统接管：没有抬手
await T.evalJS(`document.exitFullscreen().then(() => 1, () => 0)`); // 系统退出了全屏
await T.sleep(900);
T.ok('系统退出全屏后页面还是只有纸', !(await T.evalJS(`Boolean(document.fullscreenElement)`)) && (await S(`S.collapsed`)) && (await T.visible('#tools')));
await T.pen(T.line(200, 650, 300));
ls = await lastStart();
T.ok('手没抬起就被接管后，笔照常能写，落在笔尖下面', (await T.strokes()) === 2 && near(ls, 200, 650) && ls[2] >= 5, [await T.strokes(), ls]);
await T.sleep(1200);
v0 = await view();
await finger(await T.screenOf(300, 900), await T.screenOf(300, 860), true, 8);
v1 = await view();
T.ok('之后手指拖还是挪纸（没把被接管的那根手指算成两指缩放）', v1[2] === v0[2] && v1[1] < v0[1] - 15 && (await T.strokes()) === 2, [v0, v1]);
await T.evalJS(`(document.body.style.transform = 'translateY(50px)', 1)`); // 退出全屏后页面被系统往下挪了 50 像素
await T.pen(T.line(300, 800, 200));
ls = await lastStart();
await T.evalJS(`(document.body.style.transform = '', 1)`);
T.ok('页面被系统挪了位置，笔还是落在笔尖下面', (await T.strokes()) === 3 && near(ls, 300, 800), ls);
T.ok('这几笔都存到电脑上了', await savedOn(2, 3), (await pageApi(2)).strokes.length);

await T.finish();

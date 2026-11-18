// 点按范围至少 44（2026-11-17 用户定，《产品定义》第 2 节「设计参考里的两样」；DESIGN.md 的 touch-target）。查：
// 按钮看上去的大小没变（右下角那一条 40、左上角那一排和顶栏 36），能点到的范围往外伸到了 44 高；紧挨着的按钮之间只隔 2–6，
// 横向各让一半，至少 42；伸出去的部分不盖住旁边按钮看得见的地方，也不多吞纸（离按钮 8 像素的地方照样能写字）；
// 点在按钮外面那一圈上真的算点了它（翻页、撤销）。新文件一组里的「加入」「忽略」到 42（样式规则用一个临时放上去的按钮量）。
// 只在无头 Edge 里用合成的点按量过：手指、笔在 iPad 上实际好不好点，这里测不到。
// 跑法：node tests/run_browser.mjs <临时目录> --only hit_targets；有一项不对退出码 1。
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'hit-targets', pages: 3 });
const js = T.evalJS;

// 一个元素看上去多大（w、h），实际点得到多大（hitW、hitH）：从它的中心往四个方向半像素半像素地探，
// document.elementFromPoint 还是它（或它里面的东西）就算点得到
const reach = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null;
  const r = e.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const hit = (x, y) => { const t = document.elementFromPoint(x, y); return Boolean(t) && (t === e || e.contains(t)); };
  const go = (dx, dy) => { let k = 0; while (k < 120 && hit(cx + dx * (k + 1) / 2, cy + dy * (k + 1) / 2)) k++; return k / 2; };
  return { w: r.width, h: r.height, hitW: go(-1, 0) + go(1, 0), hitH: go(0, -1) + go(0, 1), left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx, cy }; })()`);
const owner = (x, y) => js(`(() => { const t = document.elementFromPoint(${x}, ${y}); const b = t && t.closest ? t.closest('button, label') : null; return b ? (b.id || b.dataset.tool || b.className) : (t ? t.id || t.tagName : null); })()`);
const penDot = async (x, y) => { // 用笔在屏幕上的一点画一小段
  const base = { pointerType: 'pen', button: 'left' };
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x, y, buttons: 1, clickCount: 1 }, base));
  for (let k = 1; k <= 6; k++) await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: x + k * 5, y: y + k, buttons: 1 }, base));
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: x + 30, y: y + 6, buttons: 0, clickCount: 1 }, base));
  await sleep(300);
};
const idx = () => js(`window.__ink.S.idx`);
const near = (v, want) => Math.abs(v - want) < 0.6;

if (await js(`window.__ink.S.flow`)) { await js(`window.__ink.toggleFlow()`); await sleep(800); } // 单页里量（左上角那一排的样子一样）
T.ok('（前提）全屏：左上角一排、右下角一条都在', (await T.visible('#chipRow')) && (await T.visible('#tools')));

// ================= 1. 右下角那一条：看上去 40 高，点得到 44 高；横向至少 42；不盖住旁边按钮看得见的地方
for (const sel of ['#tools [data-tool=pen]', '#tools [data-tool=red]', '#tools [data-tool=eraser]', '#tools [data-tool=lasso]', '#toolsUndo', '#toolsRedo', '#check', '#toolsBars']) {
  const r = await reach(sel);
  T.ok(`右下角那一条 ${sel}：看上去还是 40 高，点得到的范围 ≥ 44 高、≥ 42 宽`, Boolean(r) && near(r.h, 40) && r.hitH >= 43.5 && r.hitW >= 41.5, r);
}
const pen = await reach('#tools [data-tool=pen]'), red = await reach('#tools [data-tool=red]');
T.ok('黑笔右边沿里面一点还是黑笔的，红笔左边沿里面一点还是红笔的（伸出去的范围没盖住旁边按钮看得见的地方）',
  (await owner(pen.right - 1, pen.cy)) === 'pen' && (await owner(red.left + 1, red.cy)) === 'red', [await owner(pen.right - 1, pen.cy), await owner(red.left + 1, red.cy)]);

// ================= 2. 左上角那一排：看上去 36 高，点得到 44 高；「单页 / 连续」那一对只往上下伸
for (const sel of ['#chipPrev', '#chipNext', '#chipAdd']) {
  const r = await reach(sel);
  T.ok(`左上角 ${sel}：看上去还是 36 高，点得到的范围 ≥ 44 高、≥ 42 宽`, Boolean(r) && near(r.h, 36) && r.hitH >= 43.5 && r.hitW >= 41.5, r);
}
const single = await reach('#chipSingle'), flowBtn = await reach('#chipRow .pair button:last-child');
T.ok('左上角「单页 / 连续」那一对：各 36 高，点得到 ≥ 44 高；两个之间谁也不盖住谁看得见的地方',
  Boolean(single) && Boolean(flowBtn) && near(single.h, 36) && single.hitH >= 43.5 && flowBtn.hitH >= 43.5
  && (await owner(single.right - 1, single.cy)) === 'chipSingle' && (await owner(flowBtn.left + 1, flowBtn.cy)) !== 'chipSingle', [single, flowBtn]);

// ================= 3. 点在按钮外面那一圈上，真的算点了它；再往外就是纸
const next = await reach('#chipNext');
T.ok('（前提）现在在第 1 页', (await idx()) === 0);
await T.tapAt(next.cx, next.bottom + 3, 1500);
T.ok('点在「›」下沿外 3 像素：翻到了第 2 页（以前那里是纸）', (await idx()) === 1, await idx());
const n0 = await T.strokes();
await penDot(next.cx, next.bottom + 8);
T.ok('离「›」下沿 8 像素的地方用笔写：照样写在纸上（没被按钮吞掉）', (await T.strokes()) === n0 + 1 && (await idx()) === 1, [n0, await T.strokes(), await idx()]);
const undo = await reach('#toolsUndo');
await T.tapAt(undo.cx, undo.top - 1.5, 500);
T.ok('点在「撤销」上沿外 1.5 像素：刚写的那一笔撤掉了（以前那里是这一条的留白）', (await T.strokes()) === n0, [n0, await T.strokes()]);

// ================= 4. 新文件一组里的「加入」「忽略」：点得到 42 高（样式规则用一个临时放上去的按钮量）
await js(`(() => { const d = document.createElement('div'); d.className = 'of-acts'; d.id = 'probeActs'; d.style.cssText = 'position:fixed;left:300px;top:260px;z-index:99';
  d.innerHTML = '<button id="probeBtn">加入</button>'; document.body.appendChild(d); return 1; })()`);
const probe = await reach('#probeBtn');
T.ok('新文件一组里的按钮：看上去还是 30 高，点得到 ≥ 42 高', Boolean(probe) && near(probe.h, 30) && probe.hitH >= 41.5, probe);
await js(`document.querySelector('#probeActs').remove()`);

// ================= 5. 退出全屏：顶栏上的按钮 36 高，点得到 44 高；抽屉里的勾选行 ≥ 44 高
await T.tap('#toolsBars', 800);
T.ok('（前提）退出全屏后顶栏在', await T.visible('#bar'));
for (const sel of ['#drawerBtn', '#prev', '#next', '#barAdd', '#barCheck', '#menuBtn']) {
  const r = await reach(sel);
  T.ok(`顶栏 ${sel}：看上去还是 36 高，点得到的范围 ≥ 44 高`, Boolean(r) && near(r.h, 36) && r.hitH >= 43.5, r);
}
const bs = await reach('#barSingle'), bf = await reach('#bar .pair button:last-child');
T.ok('顶栏「单页 / 连续」那一对：点得到 ≥ 44 高；两个之间谁也不盖住谁看得见的地方',
  Boolean(bs) && Boolean(bf) && bs.hitH >= 43.5 && bf.hitH >= 43.5 && (await owner(bs.right - 1, bs.cy)) === 'barSingle' && (await owner(bf.left + 1, bf.cy)) !== 'barSingle', [bs, bf]);
const bar = await js(`(() => { const b = document.querySelector('#bar'); return { sw: b.scrollWidth, cw: b.clientWidth, sh: b.scrollHeight, ch: b.clientHeight }; })()`);
T.ok('顶栏没有因此多出滚动条（伸出去的范围都在顶栏里面）', bar.sh <= bar.ch, bar);
await T.tap('#drawerBtn', 700);
await js(`(() => { document.querySelector('#drReads').closest('.dr-check').scrollIntoView({ block: 'center' }); return 1; })()`);
await sleep(300);
const chk = await reach('#drawer .dr-check');
T.ok('抽屉里的勾选行：点得到的范围 ≥ 44 高', Boolean(chk) && chk.h >= 35.5 && chk.hitH >= 43.5, chk);
const was = await js(`document.querySelector('#drReads').checked`);
await T.tapAt(chk.cx, chk.top - 2, 400);
T.ok('点在勾选行上沿外 2 像素：勾上了（再点一次取消）', (await js(`document.querySelector('#drReads').checked`)) === !was, was);
await T.tapAt(chk.cx, chk.top - 2, 400);

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

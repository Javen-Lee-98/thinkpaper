// 笔触试写页（临时页面 static/brush.html）：能用笔写、能切换三种候选和现在的画法、能选细中粗、写过的字跟着换、
// 抬笔后收笔处变尖、手指不写字、撤销和清空。合不合手感测不了，要人在平板上写。
// 跑法：node tests/browser/brush_page.mjs [临时目录]；有一项不对退出码 1。
import { boot } from '../browser_lib.mjs';

const T = await boot({ name: 'brush-page', open: false });
await T.go('', { raw: true, path: 'static/brush.html', wait: false });
T.ok('试写页打开了', await T.waitFor(`window.__brush && window.Brush && document.querySelectorAll('#bar [data-kind]').length === 4`));

// 用笔从 (x0, y) 画到 (x1, y)，屏幕坐标；steps 越少写得越「快」
async function penLine(x0, x1, y, steps = 24) {
  const base = { pointerType: 'pen', button: 'left' };
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: x0, y, buttons: 1, clickCount: 1 }, base));
  for (let i = 1; i <= steps; i++) await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / steps, y, buttons: 1 }, base));
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: x1, y, buttons: 0, clickCount: 1 }, base));
  await T.sleep(200);
}
// 屏幕上 x 这一列、y 上下 12 像素里有几个深色像素（就是这一处线有多粗）
const thick = (x, y) => T.evalJS(`(() => { const c = document.getElementById('ink'), d = window.devicePixelRatio || 1;
  const px = c.getContext('2d').getImageData(Math.round(${x} * d), Math.round((${y} - 12) * d), 1, Math.round(24 * d)).data;
  let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i] < 200) n += (255 - px[i]) / 255; return Math.round(n / d * 100) / 100; })()`); // 按有多黑来算（半深的边也算一部分），纸上的浅色点阵不算
const kind = () => T.evalJS(`window.__brush.kind`);
const count = () => T.evalJS(`window.__brush.strokes.length`);

// 1. 默认是笔触 2；写一笔
T.ok('默认选中笔触 2，按钮加了框', (await kind()) === 'pen' && (await T.evalJS(`document.querySelector('#bar [data-kind=pen]').classList.contains('on')`)));
await penLine(150, 500, 300);
T.ok('写上了一笔，记了位置、轻重、时刻', (await count()) === 1 && (await T.evalJS(`window.__brush.strokes[0].pts.length > 8 && window.__brush.strokes[0].pts[0].length === 4`)));
const midSharp = await thick(325, 300), endSharp = await thick(498, 300), startSharp = await thick(152, 300);
T.ok('中间有线', midSharp >= 1, midSharp);
T.ok('笔触 2：收笔处比中间细', endSharp < midSharp, { mid: midSharp, end: endSharp });
T.ok('笔触 2：起笔处不比中间粗', startSharp <= midSharp, { mid: midSharp, start: startSharp });
await T.shot('pen.png');

// 1b. 细 / 中 / 粗：写过的字跟着变粗变细（「现在的」不受影响）
T.ok('默认是「中」', (await T.evalJS(`window.__brush.size`)) === 1 && (await T.evalJS(`document.querySelector('#bar [data-size=\"1\"]').classList.contains('on')`)));
await T.tap('#bar [data-size=\"1.3\"]');
const midThick = await thick(325, 300);
await T.tap('#bar [data-size=\"0.8\"]');
const midThin = await thick(325, 300);
T.ok('粗的比中的粗，细的比中的细', midThick > midSharp && midThin < midSharp, { thin: midThin, mid: midSharp, thick: midThick });
await T.tap('#bar [data-size=\"1\"]');

// 2. 换成「现在的」：写过的字跟着换，两头和中间一样粗
T.ok('点得到「现在的」', await T.tap('#bar [data-kind=legacy]'));
const midOld = await thick(325, 300), endOld = await thick(498, 300);
T.ok('换成现在的画法', (await kind()) === 'legacy' && (await T.text('#what')).includes('现在的画法'));
T.ok('现在的画法：收笔处和中间一样粗', midOld >= 1 && Math.abs(endOld - midOld) <= 0.5, { mid: midOld, end: endOld });

// 3. 笔触 1、笔触 3 也能选，选了说明跟着变
await T.tap('#bar [data-kind=even]');
T.ok('笔触 1', (await kind()) === 'even' && (await T.text('#what')).startsWith('笔触 1'));
const endSoft = await thick(498, 300);
await T.tap('#bar [data-kind=bold]');
T.ok('笔触 3', (await kind()) === 'bold' && (await T.text('#what')).startsWith('笔触 3'));
T.ok('笔触 1 的收笔没有笔触 2 那么尖', endSoft >= endSharp, { soft: endSoft, sharp: endSharp });

// 4. 手指碰到不写字
await T.fingerTapAt(300, 500);
await T.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 520, id: 1 }] });
await T.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 320, y: 520, id: 1 }] });
await T.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await T.sleep(200);
T.ok('手指划过不留笔迹', (await count()) === 1 && (await thick(260, 520)) === 0, await count());

// 5. 红笔、撤销、清空
await T.tap('#red');
await penLine(150, 400, 400);
T.ok('红笔写的一笔是红的', (await count()) === 2 && (await T.evalJS(`window.__brush.strokes[1].c`)) === 'r');
await T.tap('#undo');
T.ok('撤销去掉最后一笔', (await count()) === 1 && (await thick(275, 400)) === 0);
await T.tap('#clear');
T.ok('清空后纸上没有笔迹', (await count()) === 0 && (await thick(325, 300)) === 0);

await T.finish();

// 回答要多长的三档开关（2026-11-17 用户定「事先一档」，样子是用户不在时暂定的；《产品定义》第 2 节「蓝字摊在纸上、回答长短怎么控制」）。查：
// 1. 全屏时右下角那一条上「AI」左边一个钮，写着现在这一档（默认「讲清楚」）和 ▾，看着像菜单；点开在它上面出一张小单子，
//    三档各一行（名字和一句说明），现在这一档打着勾；点别处、按 Esc 收起；
// 2. 默认档点「AI」：消息里没有「这次要的长短」那句；选「点一下」：钮上写「点一下」，存在这台设备上，点「AI」的消息里有那一句；
// 3. 刷新后还是「点一下」；换档时钮不变宽变窄；
// 4. 退出全屏：顶栏上「AI」左边同一个开关，写着「点一下」；点开在它下面；选「展开讲」两个钮都变；两页都有新写的、点「AI」几页一起交，消息里有「展开讲」那句；
// 5. 英文界面：钮上、单子里都是英文，没有中文。
// 只在无头 Edge 里用合成的输入试过，没在 iPad 上试过。
// 跑法：node tests/run_browser.mjs <临时目录> --only answer_size；有一项不对退出码 1。
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'answer-size', pages: 2 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const CJK = /[㐀-鿿＀-￯　-〿]/;
const BRIEF = '这次要的长短：点一下——只给记号和一两句短批注，不展开讲。';
const FULL = '这次要的长短：展开讲——完整地讲，该推的推一遍、每步写出依据，长的写成 write。';
const rect = (q) => js(`(() => { const e = document.querySelector(${JSON.stringify(q)}); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(), c = getComputedStyle(e);
  if (c.display === 'none' || !r.width) return null; return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, text: e.textContent, label: e.getAttribute('aria-label'),
    radius: c.borderTopLeftRadius, border: c.borderTopWidth + ' ' + c.borderTopStyle }; })()`);
const pick = () => js(`(() => { const p = document.querySelector('#sizePick'); if (p.hidden) return null; const r = p.getBoundingClientRect();
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, role: p.getAttribute('role'), label: p.getAttribute('aria-label'), text: p.innerText,
    rows: [...p.querySelectorAll('.sz-row')].map((x) => { const b = x.getBoundingClientRect(); return { size: x.dataset.size, on: x.classList.contains('on'), name: x.querySelector('.tp-l1').textContent,
      desc: x.querySelector('.tp-l2').textContent, h: b.height, check: getComputedStyle(x, '::after').content,
      whole: x.querySelector('.tp-l2').scrollWidth <= x.querySelector('.tp-l2').clientWidth + 1 }; }) }; })()`);
const stored = () => js(`localStorage.getItem('inkthink.size')`);
async function send() { // 写一笔、点「AI」，等交上去的消息
  await T.pen(T.line(120, 200 + Math.random() * 600, 200));
  await T.tap('#check');
  const sub = await T.waitSub('S1', 60);
  return sub ? sub.text : '';
}
async function pickRow(size) { await T.tap(`#sizePick .sz-row[data-size=${size}]`); await sleep(200); }

if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }

// ================= 1. 全屏：右下角那一条上，「AI」左边
const btns = await js(`[...document.querySelectorAll('#tools button')].map((b) => b.dataset.tool || b.id).join()`);
T.ok('右下角那一条：「AI」左边是这个开关', btns.endsWith('sizeBtn,check'), btns);
let sb = await rect('#sizeBtn'), ck = await rect('#check');
T.ok('默认写着「讲清楚」和 ▾，没存过档', Boolean(sb) && sb.text === '讲清楚▾' && (await stored()) === null, [sb, await stored()]);
T.ok('和「AI」同一行、一样高，在它左边，不叠着', Boolean(sb && ck) && Math.abs(sb.t - ck.t) < 1 && Math.abs(sb.h - ck.h) < 1 && sb.r <= ck.l, [sb, ck]);
// 点得到多大（和 hit_targets.mjs 同一个量法：从中心往上下左右探，elementFromPoint 还是它就算）
const reach = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null;
  const r = e.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const hit = (x, y) => { const t = document.elementFromPoint(x, y); return Boolean(t) && (t === e || e.contains(t)); };
  const go = (dx, dy) => { let k = 0; while (k < 120 && hit(cx + dx * (k + 1) / 2, cy + dy * (k + 1) / 2)) k++; return k / 2; };
  return { h: r.height, hitW: go(-1, 0) + go(1, 0), hitH: go(0, -1) + go(0, 1) }; })()`);
const rs = await reach('#sizeBtn');
T.ok('点得到的范围：高 ≥ 44（看上去和「AI」一样 40 高）', Boolean(rs) && rs.hitH >= 43.5 && rs.hitW >= 60, rs);
T.ok('长按说明写着它是做什么的', sb.label === '回答要多长：点开选', sb.label);
await T.tap('#sizeBtn');
let P = await pick();
T.ok('点开：在它上面出一张小单子（右沿对齐、整个在屏幕里），是菜单', Boolean(P) && P.b <= sb.t && Math.abs(P.r - sb.r) < 2 && P.t >= 0 && P.role === 'menu', [P, sb]);
T.ok('三档各一行：名字和一句说明，每行高至少 44', Boolean(P) && P.rows.map((r) => r.name).join() === '点一下,讲清楚,展开讲' && P.rows.every((r) => r.desc.length > 4 && r.h >= 44 && r.whole), P && P.rows);
T.ok('现在这一档（讲清楚）打着勾，别的没有', Boolean(P) && P.rows.map((r) => r.on).join() === 'false,true,false' && P.rows[1].check.includes('✓') && !P.rows[0].check.includes('✓'), P && P.rows);
await T.shot('a1-pick.png');
const [ox, oy] = await T.screenOf(700, 900);
await T.tapAt(ox, oy);
T.ok('点别处：收起，档没变', (await pick()) === null && (await S('S.size')) === 'clear');
await T.tap('#sizeBtn');
await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(150);
T.ok('按 Esc：收起', (await pick()) === null);
await T.tap('#sizeBtn');
await T.tap('#sizeBtn');
T.ok('再点同一个钮：收起', (await pick()) === null);

// ================= 2. 默认档交上去：没有那一句；选「点一下」交上去：有那一句
let t2 = await send();
T.ok('默认（讲清楚）交上去：消息里没有「这次要的长短」', t2.length > 0 && !t2.includes('这次要的长短'), t2.slice(-400));
const w0 = (await rect('#sizeBtn')).w;
await T.tap('#sizeBtn');
await pickRow('brief');
sb = await rect('#sizeBtn');
T.ok('选「点一下」：小单子收起，钮上写「点一下」，存在这台设备上', (await pick()) === null && sb.text === '点一下▾' && (await stored()) === '"brief"', [sb.text, await stored()]);
T.ok('换档时钮不变宽变窄', Math.abs(sb.w - w0) < 0.5, [w0, sb.w]);
await T.saved();
t2 = await send();
T.ok('「点一下」交上去：消息里有那一句', t2.includes(BRIEF), t2.slice(-500));
T.ok('那一句在最后那句（怎么写回）前面，只有一次', t2.split(BRIEF).length === 2 && t2.indexOf(BRIEF) < t2.lastIndexOf('\n\n') + 2, t2.slice(-500));
await T.shot('a2-brief.png');

// ================= 3. 刷新后还是「点一下」
await T.reload();
if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }
T.ok('刷新后还是「点一下」', (await rect('#sizeBtn')).text === '点一下▾' && (await S('S.size')) === 'brief');

// ================= 4. 退出全屏：顶栏上同一个开关；选「展开讲」；几页一起交
await T.tap('#toolsBars');
const bar = await js(`[...document.querySelectorAll('#bar button')].filter((b) => getComputedStyle(b).display !== 'none' && b.getClientRects().length).map((b) => b.id).join()`);
let bs = await rect('#barSize');
const bc = await rect('#barCheck');
T.ok('退出全屏：顶栏上「AI」左边是同一个开关，写着「点一下」', Boolean(bs && bc) && bs.text === '点一下▾' && bs.r <= bc.l && Math.abs(bs.t - bc.t) < 2 && bar.includes('barSize,barCheck'), [bs, bc, bar]);
await T.tap('#barSize');
P = await pick();
T.ok('顶栏上的点开：在它下面', Boolean(P) && P.t >= bs.b && P.rows[0].on, [P, bs]);
await T.shot('a3-bar-pick.png');
await pickRow('full');
T.ok('选「展开讲」：顶栏上、右下角那一条上的都写「展开讲」，存下了', (await rect('#barSize')).text === '展开讲▾' && (await js(`document.querySelector('#sizeBtn .sz-name').textContent`)) === '展开讲'
  && (await stored()) === '"full"');
// 顶栏挤不下（窄屏）：开关收成三格小格子（亮几格是第几档），别的按钮不挤小、顶栏不出横向滚动
const barLook = () => js(`(() => { const b = document.querySelector('#barSize'), bar = document.querySelector('#bar');
  const lit = [...b.querySelectorAll('.sz-meter i')].filter((i) => getComputedStyle(i).backgroundColor === 'rgb(34, 34, 34)').length;
  return { tight: b.classList.contains('tight'), name: getComputedStyle(b.querySelector('.sz-name')).display, lit, w: b.getBoundingClientRect().width,
    fits: bar.scrollWidth <= bar.clientWidth + 1, small: [...bar.querySelectorAll('button')].filter((x) => x.getClientRects().length && x.getBoundingClientRect().width < 35.5).map((x) => x.id) }; })()`);
T.ok('834 宽的顶栏放得下：开关写着名字（没收成小格子）', !(await barLook()).tight, await barLook());
let vw = 834, bl = null;
for (; vw >= 520; vw -= 20) {
  await T.cdp('Emulation.setDeviceMetricsOverride', { width: vw, height: 1000, deviceScaleFactor: 1, mobile: true });
  await sleep(250);
  bl = await barLook();
  if (bl.tight) break;
}
T.ok('窄到放不下名字时：收成三格小格子，亮 3 格（展开讲），顶栏不出横向滚动、没有按钮被挤小', Boolean(bl) && bl.tight && bl.name === 'none' && bl.lit === 3 && bl.w >= 36 && bl.fits && !bl.small.length, [vw, bl]);
await T.shot('a3b-bar-tight.png');
await T.cdp('Emulation.setDeviceMetricsOverride', { width: 834, height: 1194, deviceScaleFactor: 1, mobile: true });
await sleep(300);
T.ok('宽回来：又写着名字', !(await barLook()).tight);
await T.tap('#fsBtn');
// 第 2 页也写一笔，几页一起交
await T.openPage(1);
await T.pen(T.line(120, 300, 200));
await T.saved();
await T.openPage(0);
await T.pen(T.line(120, 1000, 200));
await T.saved();
// 用户的入口：点「AI」，别的页也有新写的就一起交（2026-11-18 外部审查：原来直接调 sendAll，没走点「AI」这条路）
T.ok('（前提）回到全屏，右下角的「AI」在', Boolean(await rect('#check')));
await T.tap('#check');
const sub4 = await T.waitSub('S1', 80);
const t4 = sub4 ? sub4.text : '', pg4 = sub4 ? Object.values(T.metaOf(sub4).pages || {}).map((p) => p.page).sort().join() : '';
T.ok('点「AI」几页一起交（第 1、2 页）：消息里有「展开讲」那一句', pg4 === '0,1' && t4.includes('第 2 页') && t4.includes(FULL) && !t4.includes(BRIEF), [pg4, t4.slice(0, 300)]);

// ================= 5. 英文界面
await T.go('&lang=en');
if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }
sb = await rect('#sizeBtn');
await T.tap('#sizeBtn');
P = await pick();
T.ok('英文界面：钮上写 In depth（这台设备上存的是展开讲）', Boolean(sb) && sb.text === 'In depth▾' && sb.label === 'Answer length: tap to choose', sb);
T.ok('英文界面：小单子里三档都是英文、没有中文', Boolean(P) && P.rows.map((r) => r.name).join() === 'Hint,Explain,In depth' && !CJK.test(P.text) && !CJK.test(P.label), P);
T.ok('英文界面：每档的说明整句看得见（没截成省略号）', Boolean(P) && P.rows.every((r) => r.whole), P && P.rows);
await T.shot('a4-english.png');
await pickRow('clear');
T.ok('英文界面换成 Explain', (await rect('#sizeBtn')).text === 'Explain▾' && (await stored()) === '"clear"');

await T.finish();

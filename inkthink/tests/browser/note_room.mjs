// 空白本子的短批注自己找空白（阶段 D1，《产品定义》第 3 节「短的回在原处」）：不预留批注栏，在所指的笔迹旁找一块空白放下，
// 用细线连过去；周围都满了就直接以小蓝点落下。书页照旧排在页面右边一栏。查：
// 1. 右边有空：落在所指那句的右边、和它齐平，不压任何笔迹，有一条细线连过去；一页连着来四条（两条指着同一句、一条两行）：
//    互不相压，也不压笔迹，都在纸上。
// 2. 擦掉一条再来一条（指着同一句）：新的落在擦掉的那条原来的地方（擦掉的蓝字不占位，2026-11-15 用户的页面上出过这事）。
// 3. 右边写满了：落在下面（和所指的那句横向对得上），不压字；紧挨在那句下面的那一行（接着往下写的地方）空着。
// 4. 四周都写满了：直接以小蓝点落下——数据里记着收起（dot），纸上只有一个没有数字的小点、没有字，点紧挨所指那句的右端、不压字。
// 5. 所指的那句写在很靠右的地方（原来批注栏的位置）：批注不压它，也不压别的字（2026-11-14 用户截图里的毛病）。
// 6. 书页（导入的 PDF）：批注照旧排在页面右边一栏；擦掉一条再来一条，新的落在原来那个高度（不被挤到下面）；
//    用户的字写进了那一栏、批注锚在它上面：批注不压它。
// 笔是 pointerType 为 pen 的鼠标事件；只在无头 Edge 里跑过。
// 跑法：node tests/run_browser.mjs <临时目录> --only note_room；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'note-room', pages: 4 });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);
const line = (x0, y, len, n = 10) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y + (i % 2) * 2]);
const meets = (p, q) => p[0] < q[2] && p[2] > q[0] && p[1] < q[3] && p[3] > q[1];
async function landed(n) { // 等写回的批注落到这一页（一共 n 条），并且一条条写完
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
// 这一页的短批注：数据、纸上那几行字占的框（按实际字宽）、画出来的样子（几行字、几条连线、是不是小蓝点）
const notes = () => js(`window.__ink.S.page.ai.filter((a) => a.type === 'note' || a.type === 'question').map((a) => {
  const g = document.querySelector('#aiRoot > g[data-id="' + a.id + '"]');
  return { id: a.id, text: a.text, lay: a.lay, dot: a.dot || null, erased: Boolean(a.erasedAt), tb: window.__ink.noteTextBox(a),
    words: g ? g.querySelectorAll(':scope > text:not(.adopt-star)').length : 0, leaders: g ? g.querySelectorAll('path.leader').length : 0,
    dotDrawn: Boolean(g && g.classList.contains('ai-dot')), num: g ? (g.querySelector('.bdg text') || {}).textContent || '' : '' }; })`);
const noteOf = async (text) => (await notes()).find((n) => n.text === text);
const strokeBoxes = () => S(`S.page.strokes.filter((s) => !s.erasedAt).map((s) => { const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]);
  return { id: s.id, c: s.c || '', b: [Math.min(...xs) - s.w, Math.min(...ys) - s.w, Math.max(...xs) + s.w, Math.max(...ys) + s.w] }; })`);
const paper = () => S('({ X0: S.X0, Y0: S.Y0, TW: S.TW, W: S.W, pageH: S.pageH })');
async function send() { // 点「AI」交上去，返回投递和分组（组号 → 外框、是不是红笔）
  await T.saved();
  await T.tap('#check');
  const sub = await T.waitSub('S1', 80), meta = sub && T.metaOf(sub);
  return { sub, meta, g: meta ? Object.fromEntries(meta.groups.map((g) => [g.id, g])) : {} };
}
const SHOTS = [];
const shot2 = async (file) => { const z = await T.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 834, height: 1194, scale: 2 } });
  const f = join(T.OUT, file); (await import('node:fs')).writeFileSync(f, Buffer.from(z.data, 'base64')); SHOTS.push(f); return f; };
const waitToast = () => T.waitFor(`document.querySelector('#toast').hidden`, 6000);

if (await S('S.flow')) { await js('window.__ink.toggleFlow()'); await sleep(600); }

// ================= 1. 第 1 页：三句红笔问题，右边都空着；Claude 回四条（两条指着第一句，一条两行长）
await T.tool('red');
await T.pen(line(100, 200, 250));
await sleep(2000);
await T.pen(line(100, 300, 250));
await sleep(2000);
await T.pen(line(100, 400, 250));
await T.tool('pen');
const s1 = await send();
T.ok('（前提）第 1 页交上去了：三句红笔问题', Boolean(s1.meta) && s1.meta.groups.length === 3, s1.meta && s1.meta.groups);
const A1 = s1.g.g1.bbox, A2 = s1.g.g2.bbox, A3 = s1.g.g3.bbox;
const N1 = '带上水壶', N1b = '再带一顶帽子', N2 = '这一句可以写得更长一点：天气预报说周六下午可能有阵雨', N3 = '几点出发？';
await T.post('/bridge/reply', { sid: 'S1', submission: s1.sub.id, items: [
  { type: 'note', anchor: 'g1', text: N1 }, { type: 'note', anchor: 'g2', text: N2 }, { type: 'question', anchor: 'g3', text: N3 }, { type: 'note', anchor: 'g1', text: N1b }] });
T.ok('（前提）四条短批注落下、写完了', await landed(4));
let ns = await notes(), SB = await strokeBoxes(), P = await paper();
const n1 = ns.find((n) => n.text === N1), n2 = ns.find((n) => n.text === N2), n3 = ns.find((n) => n.text === N3), n1b = ns.find((n) => n.text === N1b);
T.ok('右边有空：第一条落在所指那句（g1）的右边，隔着一小段，和它齐平', Boolean(n1) && !n1.dot && n1.tb[0] > A1[2] + 8 && n1.tb[0] < A1[2] + 40
  && n1.tb[1] < A1[3] && n1.tb[3] > A1[1], [n1 && n1.tb, A1]);
T.ok('两行长的那条也落在它那句（g2）的右边，排成两行', Boolean(n2) && !n2.dot && n2.lay.lines.length === 2 && n2.tb[0] > A2[2] && n2.tb[0] < A2[2] + 60 && n2.tb[1] < A2[3] + 40, [n2 && n2.lay, A2]);
T.ok('第三条（问句）落在 g3 的右边', Boolean(n3) && !n3.dot && n3.tb[0] > A3[2] && n3.tb[0] < A3[2] + 60 && n3.tb[1] < A3[3] && n3.tb[3] > A3[1], [n3 && n3.tb, A3]);
T.ok('四条都画在纸上（是字，不是小蓝点），每条都有一条细线连到它那句', ns.length === 4 && ns.every((n) => !n.dot && n.words === n.lay.lines.length && n.leaders === 1),
  ns.map((n) => [n.text, n.words, n.leaders, Boolean(n.dot)]));
T.ok('四条都不压任何笔迹', ns.every((n) => SB.every((s) => !meets(n.tb, s.b))), [ns.map((n) => n.tb), SB.map((s) => s.b)]);
T.ok('四条互不相压（指着同一句的两条也分开了）', ns.every((n, i) => ns.every((m, j) => j <= i || !meets(n.tb, m.tb))), ns.map((n) => [n.text, n.tb]));
T.ok('四条都在纸上（没有出纸的左右边，最宽 300）', ns.every((n) => n.tb[0] >= P.X0 && n.tb[2] <= P.TW && n.lay.w <= 304), [ns.map((n) => n.tb), P]);
await waitToast();
await shot2('1-room-right.png');

// ================= 2. 擦掉第一条，再来一条指着同一句的：落在擦掉的那条原来的地方
const L1 = n1.lay;
await T.tool('eraser');
await T.pen(line(L1.x + 6, L1.y + 18, 40, 6));
T.ok('（前提）橡皮擦掉了第一条（只擦了它）', (await noteOf(N1)).erased && !(await noteOf(N1b)).erased && (await strokeBoxes()).length === 3, await notes());
await T.tool('pen');
const s2 = await send();
const N4 = '水壶装满温水';
await T.post('/bridge/reply', { sid: 'S1', submission: s2.sub.id, items: [{ type: 'note', anchor: 'g1', text: N4 }] });
T.ok('（前提）新的一条落下了', await landed(5));
const n4 = await noteOf(N4);
T.ok('新的一条落在擦掉的那条原来的地方（擦掉的蓝字不占位）', Boolean(n4) && !n4.dot && Math.abs(n4.lay.x - L1.x) < 1 && Math.abs(n4.lay.y - L1.y) < 1, [n4 && n4.lay, L1]);

// ================= 3. 第 2 页：先在右边写满（黑笔五行），再写一句红笔问题：批注落在下面
await T.openPage(1);
for (const y of [455, 480, 505, 530, 555]) await T.pen(line(380, y, 990, 8));
await sleep(2000);
await T.tool('red');
await T.pen(line(100, 505, 250));
await T.tool('pen');
const s3 = await send();
const red3 = s3.meta && s3.meta.groups.find((g) => g.red), B3 = red3 && red3.bbox;
T.ok('（前提）第 2 页交上去了：右边的五行黑笔、一句红笔', Boolean(B3) && s3.meta.groups.filter((g) => !g.red).reduce((n, g) => n + g.n, 0) === 5
  && s3.meta.groups.filter((g) => g.red).length === 1, s3.meta && s3.meta.groups.map((g) => [g.id, g.red, g.bbox]));
const N5 = '记得带伞';
await T.post('/bridge/reply', { sid: 'S1', submission: s3.sub.id, items: [{ type: 'note', anchor: red3.id, text: N5 }] });
T.ok('（前提）落下了', await landed(1));
const n5 = await noteOf(N5);
SB = await strokeBoxes();
T.ok('右边满了：落在那句的下面（是字，不是小蓝点），横向和那句对得上', Boolean(n5) && !n5.dot && n5.tb[1] > B3[3] && n5.tb[0] < B3[2] && n5.tb[2] > B3[0], [n5 && n5.tb, B3]);
T.ok('不压任何笔迹（右边那五行也没压到）', Boolean(n5) && SB.every((s) => !meets(n5.tb, s.b)), [n5 && n5.tb]);
T.ok('紧挨在那句下面的那一行空着，留给接着往下写（批注和那句隔开约一行）', Boolean(n5) && n5.tb[1] > B3[3] + 30 && n5.tb[1] < B3[3] + 160, [n5 && n5.tb, B3]);
await waitToast();
await shot2('2-room-below.png');

// ================= 4. 第 3 页：一片写得满满的（满宽的横线，每行隔 24），中间一句红笔问题：直接以小蓝点落下
await T.openPage(2);
for (let y = 412; y <= 1012; y += 24) if (y !== 700) await T.pen(line(10, y, 1360, 6), 120);
await sleep(2000);
await T.tool('red');
await T.pen(line(500, 700, 100, 6));
await T.tool('pen');
const s4 = await send();
const red4 = s4.meta && s4.meta.groups.find((g) => g.red), B4 = red4 && red4.bbox;
T.ok('（前提）第 3 页交上去了', Boolean(B4), s4.meta && s4.meta.groups.length);
const N6 = '这里要换一种说法';
await T.post('/bridge/reply', { sid: 'S1', submission: s4.sub.id, items: [{ type: 'note', anchor: red4.id, text: N6 }] });
T.ok('（前提）落下了', await landed(1));
await sleep(300);
const n6 = await noteOf(N6);
SB = await strokeBoxes();
T.ok('四周都满了：数据里记着收成了小蓝点（dot，因为放不下）', Boolean(n6 && n6.dot) && n6.dot.why === 'room' && Array.isArray(n6.dot.at), n6);
T.ok('纸上只有一个小蓝点：没有字、没有连线、没有数字', Boolean(n6) && n6.dotDrawn && n6.words === 0 && n6.leaders === 0 && !/\d/.test(n6.num), n6);
const d6 = n6 && [n6.dot.at[0] - 10, n6.dot.at[1] - 10, n6.dot.at[0] + 10, n6.dot.at[1] + 10];
T.ok('小蓝点紧挨着所指那句的右端（和它同一高度）', Boolean(d6) && d6[0] > B4[2] && d6[0] < B4[2] + 30 && Math.abs(n6.dot.at[1] - (B4[1] + B4[3]) / 2) < 6, [n6 && n6.dot, B4]);
T.ok('小蓝点不压字', Boolean(d6) && SB.every((s) => !meets(d6, s.b)), d6);
await waitToast();
await shot2('3-room-full-dot.png');

// ================= 5. 第 4 页：所指的那句写在很靠右的地方（原来批注栏的位置），左边还有一行字
await T.openPage(3);
await T.pen(line(100, 300, 600));
await sleep(2000);
await T.tool('red');
await T.pen(line(1060, 300, 260, 8));
await T.tool('pen');
const s5 = await send();
const red5 = s5.meta && s5.meta.groups.find((g) => g.red), B5 = red5 && red5.bbox;
T.ok('（前提）第 4 页交上去了：所指那句在 x 1060–1320', Boolean(B5) && B5[0] > 1040, s5.meta && s5.meta.groups);
const N7 = '这一句写在最右边了';
await T.post('/bridge/reply', { sid: 'S1', submission: s5.sub.id, items: [{ type: 'note', anchor: red5.id, text: N7 }] });
T.ok('（前提）落下了', await landed(1));
const n7 = await noteOf(N7);
SB = await strokeBoxes();
P = await paper();
T.ok('所指的那句很靠右：批注不压它，也不压别的字', Boolean(n7) && !meets(n7.tb, B5) && SB.every((s) => !meets(n7.tb, s.b)), [n7 && n7.tb, B5]);
T.ok('批注展开着、挨着它（在它下面或旁边，隔不到 300）、整个在纸上', Boolean(n7) && !n7.dot && n7.tb[2] <= P.TW && n7.tb[0] >= P.X0
  && Math.max(n7.tb[0] - B5[2], B5[0] - n7.tb[2], n7.tb[1] - B5[3], B5[1] - n7.tb[3]) < 300, [n7 && n7.tb, B5, P]);
await waitToast();
await shot2('4-room-far-right.png');

// ================= 6. 书页：批注照旧在右边一栏；擦掉一条再来一条不被挤下去；字写进栏里时批注不压它
const SRC = join(T.ROOT, 'src'), PDF = join(SRC, 'list.pdf');
mkdirSync(SRC, { recursive: true });
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
doc=fitz.open()
p=doc.new_page(width=1000,height=1300)
p.insert_text((60,120),'Shopping list',fontsize=36)
p.insert_text((60,220),'apples, milk, bread',fontsize=30)
p.insert_text((60,420),'eggs and rice',fontsize=30)
doc.save(sys.argv[1])`, PDF]);
const imp = await T.post('/bridge/import', { sid: 'S1', path: PDF });
await T.openNotebook(imp.id, 0);
if (await S('S.flow')) { await js('window.__ink.toggleFlow()'); await sleep(600); }
T.ok('（前提）打开了导入的书页', (await S('S.nb.kind')) === 'book' && (await S('Boolean(S.bgImg)')), await S('S.nb.kind'));
await T.tool('red');
await T.pen(line(60, 232, 240));
await T.tool('pen');
const s6 = await send();
const NB1 = '牛奶买两盒';
await T.post('/bridge/reply', { sid: 'S1', submission: s6.sub.id, items: [{ type: 'note', anchor: 'g1', text: NB1 }] });
T.ok('（前提）落下了', await landed(1));
const b1 = await noteOf(NB1), W6 = await S('S.W');
T.ok('书页：批注照旧排在页面右边一栏（x 在正文区右边），和所指那句同一高度', Boolean(b1) && b1.lay.x > W6 && Math.abs(b1.lay.y + 20 - 232) < 12 && !b1.dot, [b1 && b1.lay, W6]);
await T.tool('eraser');
await T.pen(line(b1.lay.x + 6, b1.lay.y + 18, 40, 6));
T.ok('（前提）书页上擦掉了这条批注', (await noteOf(NB1)).erased, await noteOf(NB1));
await T.tool('pen');
const s7 = await send();
const NB2 = '面包要全麦的';
await T.post('/bridge/reply', { sid: 'S1', submission: s7.sub.id, items: [{ type: 'note', anchor: 'g1', text: NB2 }] });
T.ok('（前提）落下了', await landed(2));
const b2 = await noteOf(NB2);
T.ok('书页：擦掉一条再来一条，新的落在原来那个高度（擦掉的不占位，不被挤到下面）', Boolean(b2) && Math.abs(b2.lay.y - b1.lay.y) < 1 && Math.abs(b2.lay.x - b1.lay.x) < 1, [b2 && b2.lay, b1.lay]);
// 用户的字写进了栏里（红笔，和 eggs 那一行同一高度），批注锚在它上面
await T.tool('red');
await T.pen(line(1040, 430, 250, 8));
await T.tool('pen');
const s8 = await send();
const red8 = s8.meta && s8.meta.groups.find((g) => g.red && g.bbox[0] > 1000), B8 = red8 && red8.bbox;
T.ok('（前提）书页上写进栏里的那句交上去了', Boolean(B8), s8.meta && s8.meta.groups);
const NB3 = '鸡蛋十个就够';
await T.post('/bridge/reply', { sid: 'S1', submission: s8.sub.id, items: [{ type: 'note', anchor: red8.id, text: NB3 }] });
T.ok('（前提）落下了', await landed(3));
const b3 = await noteOf(NB3);
SB = await strokeBoxes();
T.ok('书页：字写进了栏里、批注锚在它上面：批注还在栏里，不压它、不压别的字', Boolean(b3) && b3.lay.x > W6 && !meets(b3.tb, B8) && SB.every((s) => !meets(b3.tb, s.b)), [b3 && b3.tb, B8]);
await waitToast();
await shot2('5-book-margin.png');

console.error('截图：\n' + SHOTS.join('\n'));
T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

// Claude 的短批注和批改符号：写回后画在所指的那组笔迹旁边、带的话显示出来、存到电脑上、刷新后还在；
// （2026-11-17 起空白本子里不太长、旁边有空的长回答会摊在纸上：这里的长回答都带 fold: true，查的是收着（圈号）的样子；摊开的见 open_answer.mjs）
// 擦掉所指的字，符号跟着不画；橡皮擦蓝字；平板不在那一页时先排队；「⋯」菜单里的显示开关和清除（撤销能整页找回）。
// 跑法：node tests/browser/reply_marks.mjs [临时目录]；有一项不对退出码 1。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'reply-marks', pages: 2 });

// 纸上画出来的每条蓝字：类型、线的外框 pb、字的外框 tb（都是页面坐标）、写出来的字、在不在屏幕里
const drawn = () => T.evalJS(`(() => { const U = (els) => { let b = null; for (const e of els) { const r = e.getBBox(); if (!r.width && !r.height) continue;
    const q = [r.x, r.y, r.x + r.width, r.y + r.height]; b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : q; } return b; };
  return Array.from(document.querySelectorAll('#aiRoot .ai-item')).map((g) => { const s = g.getBoundingClientRect(); return { id: g.dataset.id, type: g.getAttribute('class').split(' ')[1].slice(3),
    pb: U(g.querySelectorAll('path')), tb: U(g.querySelectorAll('text')), text: Array.from(g.querySelectorAll('text')).map((t) => t.textContent).join('|'),
    seen: s.width > 0 && s.top >= 0 && s.bottom <= innerHeight && s.left >= 0 && s.right <= innerWidth }; }); })()`);
const types = async () => (await drawn()).map((d) => d.type).sort();
// 页面数据里的蓝字
const items = () => T.evalJS(`window.__ink.S.page.ai.map((a) => ({ id: a.id, type: a.type, text: a.text || '', erasedAt: a.erasedAt || 0 }))`);
const item = async (type) => (await items()).find((a) => a.type === type);
// 等写回的批注落到这一页（一共 n 条），并且一条条写完
async function landed(n) {
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await T.evalJS(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
const toastText = () => T.evalJS(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
// 点一个会弹出系统确认框的按钮，再按「确定」（accept 为 true）或「取消」
async function tapConfirm(sel, accept) {
  const c = await T.centerOf(sel), tap = T.tapAt(c[0], c[1], 0).catch(() => {});
  let handled = false;
  for (let i = 0; i < 40 && !handled; i++) { await sleep(150); handled = await T.cdp('Page.handleJavaScriptDialog', { accept }).then(() => true, () => false); }
  await tap;
  await sleep(300);
  return handled;
}
const PENDING = join(T.DATA, 'notebooks', 'scratch', 'page-0000.pending.json'); // 服务器上第 1 页排着队的写回
// 某次交上去时发给 Claude 的那张图里，一块地方（页面坐标的框 b）有多少黄色的点、多少蓝色的点：返回 [黄, 蓝]
function tints(s, b) {
  const k = T.metaOf(s).crop, jpg = readFileSync(join(T.DATA, 'submissions', s.id, 'crop.jpg')).toString('base64'), r = [b[0] - k.x0, b[1] - k.y0, b[2] - b[0], b[3] - b[1]].map((v) => Math.round(v * k.scale));
  return T.evalJS(`new Promise((res) => { const im = new Image(); im.onload = () => { const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const x = cv.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(${r.join(', ')}).data; let y = 0, bl = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] > 225 && d[i + 1] > 205 && d[i + 2] < 215 && d[i] - d[i + 2] > 35) y++; if (d[i + 2] - d[i] > 50) bl++; } res([y, bl]); };
    im.onerror = () => res(null); im.src = 'data:image/jpeg;base64,${jpg}'; })`);
}

// 1. 黑笔写五行，第四行右边再写一小段：六组笔迹。点「AI」交上去
for (const y of [160, 280, 400, 520, 640]) await T.pen(T.line(120, y, 300));
await T.pen(T.line(640, 520, 140));
await T.tap('#check');
const sub = await T.waitSub('S1'), meta = sub && T.metaOf(sub);
T.ok('六组笔迹交上去了', Boolean(meta) && meta.groups.length === 6, meta && meta.groups.map((g) => g.id));
const G = Object.fromEntries(meta.groups.map((g) => [g.id, g.bbox])), mid = (b) => (b[1] + b[3]) / 2;

// 2. Claude 写回十三种：两种短批注、下划线、圈、箭头、八种批改符号（大括号用图里的像素框，括住第一二行）
const TEXTS = { note: '这里应为 ρ', question: '为什么取零？', arrow: '代入', number: '1', cross: '符号反了', strike: '改为 E', wavy: '这步存疑', insert: '括号', brace: '合并成一步' };
const BR = [110, 150, 430, 290], c = meta.crop, px = (x, y) => [(x - c.x0) * c.scale, (y - c.y0) * c.scale];
const rep = await T.post('/bridge/reply', { sid: 'S1', submission: sub.id, items: [
  { type: 'note', anchor: 'g1', text: TEXTS.note }, { type: 'question', anchor: 'g2', text: TEXTS.question },
  { type: 'underline', anchor: 'g3' }, { type: 'circle', anchor: 'g4' }, { type: 'arrow', from: 'g4', to: 'g6', text: TEXTS.arrow },
  { type: 'tick', anchor: 'g1' }, { type: 'number', anchor: 'g1', text: TEXTS.number }, { type: 'cross', anchor: 'g2', text: TEXTS.cross },
  { type: 'highlight', anchor: 'g2' }, { type: 'strike', anchor: 'g3', text: TEXTS.strike }, { type: 'wavy', anchor: 'g5', text: TEXTS.wavy },
  { type: 'insert', anchor: 'g5', text: TEXTS.insert }, { type: 'brace', box: [...px(BR[0], BR[1]), ...px(BR[2], BR[3])], text: TEXTS.brace }] });
T.ok('服务收下了 13 条', rep.ok === true && rep.count === 13, rep);
T.ok('13 条都落到这一页、写完了', await landed(13), await items());

// 每一种：画出来了、在屏幕里、带的话一字不差、位置和所指的那组笔迹对得上
const spans = (p, b) => p[0] <= b[0] + 2 && p[2] >= b[2] - 2, level = (p, b) => p[1] < mid(b) && p[3] > mid(b);
// 空白本子不留批注栏了（阶段 D1 第二部分；以前是「字在页边那一栏，x ≥ 1000」）：短批注先找所指那一行的右边，再找下面。
// 这一页第一、二行的右边被同一轮的勾、叉（连那句话）和括住这两行的大括号（连那句话）占着，所以两条都落在各自那一行的正下方：
// 紧挨着（隔不到 60）、从那一行的左端起、不压任何一行字，有一小段线从那一行的下沿连下来
const inks = () => Object.values(G);
const under = (d, b) => d.tb[1] > b[3] && d.tb[1] < b[3] + 60 && d.tb[0] >= b[0] - 10 && d.tb[0] < b[0] + 60 && Math.abs(d.pb[1] - b[3]) < 14
  && inks().every((k) => d.tb[2] <= k[0] || d.tb[0] >= k[2] || d.tb[3] <= k[1] || d.tb[1] >= k[3]);
const WHERE = {
  note: ['短批注：第一行右边被勾和大括号占着，写在第一行正下方的空白里，有线连过去', (d) => under(d, G.g1)],
  question: ['短的问句：第二行右边被叉和大括号占着，写在第二行正下方的空白里，有线连过去', (d) => under(d, G.g2)],
  underline: ['下划线：紧贴第三行下面、和它一样长', (d) => d.pb[1] > G.g3[3] - 1 && d.pb[3] < G.g3[3] + 22 && spans(d.pb, G.g3)],
  circle: ['圈：把第四行圈在里面，不大出太多', (d) => d.pb[0] < G.g4[0] && d.pb[1] < G.g4[1] && d.pb[2] > G.g4[2] && d.pb[3] > G.g4[3] && d.pb[2] - d.pb[0] < G.g4[2] - G.g4[0] + 80],
  arrow: ['箭头：从第四行右端指到右边那一小段，字写在旁边', (d) => d.pb[0] >= G.g4[2] && d.pb[2] <= G.g6[0] && Math.abs(mid(d.pb) - mid(G.g4)) < 40 && Math.abs(mid(d.tb) - mid(G.g4)) < 60],
  tick: ['打勾：在第一行右边、和它齐平', (d) => d.pb[0] >= G.g1[2] && d.pb[0] < G.g1[2] + 60 && level(d.pb, G.g1)],
  number: ['圈着的编号：在第一行左边、和它齐平', (d) => d.pb[2] <= G.g1[0] + 2 && d.pb[0] > G.g1[0] - 60 && level(d.pb, G.g1)],
  cross: ['打叉：在第二行右边、和它齐平，理由写在叉的右边', (d) => d.pb[0] >= G.g2[2] && d.pb[0] < G.g2[2] + 60 && level(d.pb, G.g2) && d.tb[0] >= d.pb[2] - 2],
  highlight: ['荧光笔：盖住第二行', (d) => d.pb[0] <= G.g2[0] && d.pb[1] <= G.g2[1] && d.pb[2] >= G.g2[2] && d.pb[3] >= G.g2[3] && d.pb[3] - d.pb[1] < 40],
  strike: ['删除线：划在第三行上，改成什么写在它上方', (d) => d.pb[1] > G.g3[1] - 4 && d.pb[3] < G.g3[3] + 4 && spans(d.pb, G.g3) && d.tb[3] <= G.g3[1] + 4],
  wavy: ['波浪线：在第五行下面、和它一样长，疑问写在右边', (d) => d.pb[1] >= G.g5[3] - 3 && d.pb[3] <= G.g5[3] + 16 && spans(d.pb, G.g5) && d.tb[0] >= G.g5[2]],
  insert: ['插入符：在第五行末尾下面，补的字写在它上方', (d) => d.pb[0] >= G.g5[2] - 6 && d.pb[2] <= G.g5[2] + 20 && d.pb[1] >= G.g5[3] - 2 && d.tb[3] <= G.g5[1] + 4],
  brace: ['大括号：在框住的第一二行右边，上下和框一样高，话写在括号右边', (d) => d.pb[0] >= BR[2] - 1 && Math.abs(d.pb[1] - BR[1]) < 6 && Math.abs(d.pb[3] - BR[3]) < 6 && d.tb[0] > d.pb[0]],
};
const D1 = await drawn(), by1 = Object.fromEntries(D1.map((d) => [d.type, d]));
for (const t of Object.keys(WHERE)) { const d = by1[t]; T.ok(WHERE[t][0], Boolean(d) && d.seen && d.text === (TEXTS[t] || '') && WHERE[t][1](d), d || D1.map((x) => x.type)); }
const hl = await T.evalJS(`getComputedStyle(document.querySelector('#aiRoot .ai-highlight path')).fill`);
T.ok('荧光笔是黄色半透明的底', /^rgba\(255, 229, 106, 0\.45\)$/.test(hl), hl);

// 3. 存到电脑上的页面文件里有这 13 条，带着画好的线和字；刷新后还在原处
T.ok('写回的批注自己存上了', await T.saved(), await T.evalJS(`({ dirty: window.__ink.S.dirty, saving: window.__ink.S.saving })`));
const disk = T.pageFile('scratch', 0).ai;
T.ok('页面文件里十三种各一条', JSON.stringify(disk.map((a) => a.type).sort()) === JSON.stringify(Object.keys(WHERE).sort()), disk.map((a) => a.type));
T.ok('文件里的每条有线或字，话也存着', disk.every((a) => ((a.paths || []).length > 0 || a.lay) && (a.text || '') === (TEXTS[a.type] || '')), disk.map((a) => [a.type, (a.paths || []).length, a.text]));
await T.reload();
const D2 = await drawn(), by2 = Object.fromEntries(D2.map((d) => [d.type, d]));
T.ok('刷新后 13 条都还画着，字没变', D2.length === 13 && D2.every((d) => d.text === (TEXTS[d.type] || '')), D2.map((d) => [d.type, d.text]));
T.ok('刷新后位置没动', D2.every((d) => by1[d.type] && [0, 1, 2, 3].every((k) => Math.abs((d.pb || d.tb)[k] - (by1[d.type].pb || by1[d.type].tb)[k]) < 1)), D2.map((d) => [d.type, d.pb]));

// 4. 橡皮擦掉第二行我自己的字：指着它的叉、荧光笔、问句跟着不画（只是收起，不是擦掉），别的照旧；撤销回来
await T.tap('#tools [data-tool=eraser]');
await T.pen(T.line(130, 280, 280));
T.ok('第二行擦掉了', (await T.strokes()) === 5, await T.strokes());
const t4 = await types();
T.ok('指着第二行的三条不画了，其余十条照旧', t4.length === 10 && !t4.includes('cross') && !t4.includes('highlight') && !t4.includes('question') && t4.includes('tick'), t4);
T.ok('提示说收起了 3 条、点撤销能找回', /3 条批注/.test(await toastText()) && /撤销/.test(await toastText()), await toastText());
T.ok('这三条在数据里没有记成擦掉', (await items()).every((a) => !a.erasedAt), await items());
await T.tap('#toolsUndo');
T.ok('撤销：第二行和那三条都回来了', (await T.strokes()) === 6 && (await types()).length === 13, await types());

// 5. 橡皮擦蓝字：碰到短批注，擦掉的就是这一条，我的字和别的蓝字不动；撤销找回
const n5 = by2.note.tb;
await T.pen(T.line(n5[0] + 10, mid(n5), 50, 6));
const a5 = await item('note'), t5 = await types();
T.ok('橡皮碰到短批注：这一条擦掉了、不画了', a5.erasedAt > 0 && !t5.includes('note'), [a5, t5]);
T.ok('别的十二条和我的六笔都没动', t5.length === 12 && (await T.strokes()) === 6 && (await items()).filter((a) => a.erasedAt).length === 1, [t5, await T.strokes()]);
await T.tap('#toolsUndo');
T.ok('撤销：短批注回来了', !(await item('note')).erasedAt && (await types()).includes('note'), await item('note'));
// 橡皮落在圈线上（圈的最左端）：擦掉的是圈，圈里我的字不动
await T.pen([[G.g4[0] - 14, mid(G.g4)], [G.g4[0] - 14, mid(G.g4) + 8]]);
T.ok('橡皮落在圈线上：圈擦掉了，圈里的字没擦', (await item('circle')).erasedAt > 0 && !(await types()).includes('circle') && (await T.strokes()) === 6, [await item('circle'), await T.strokes()]);
await T.tap('#toolsUndo');
T.ok('撤销：圈回来了', !(await item('circle')).erasedAt && (await types()).includes('circle'), await item('circle'));
// 橡皮落在圈里我自己的字上（顺着那一行擦一小段）：擦掉的是我的字，圈没有被擦掉（只是跟着收起），撤销后又画出来
await T.pen([[250, mid(G.g4)], [290, mid(G.g4)]]);
T.ok('擦圈里我自己的字：字擦掉了，圈没有记成擦掉，只是跟着不画', (await T.strokes()) === 5 && !(await item('circle')).erasedAt && !(await types()).includes('circle'), [await T.strokes(), await item('circle')]);
await T.tap('#toolsUndo');
T.ok('撤销：字回来，圈又画出来了', (await T.strokes()) === 6 && (await types()).includes('circle'), await types());
// 没有字的荧光笔（指着印刷文字或空白处的那种）：橡皮擦在它上面就擦掉它（荧光笔底下有我的字时先擦字，见第 4 步）；撤销找回
await T.post('/bridge/reply', { sid: 'S1', submission: sub.id, items: [{ type: 'highlight', box: [...px(600, 800), ...px(800, 830)] }] });
await landed(14);
await T.pen(T.line(620, 815, 160, 8));
const hl2 = (await items())[13];
T.ok('橡皮擦得掉画在空白处（或印刷文字上）的荧光笔：只擦掉这一条，第二行上的那条和我的字不动', Boolean(hl2 && hl2.type === 'highlight' && hl2.erasedAt)
  && (await types()).filter((t) => t === 'highlight').length === 1 && (await T.strokes()) === 6, [hl2, await types(), await T.strokes()]);
await T.tap('#toolsUndo');
T.ok('撤销：空白处的荧光笔回来了', !(await items())[13].erasedAt && (await types()).filter((t) => t === 'highlight').length === 2, [(await items())[13], await types()]);
// 擦掉短批注（这次不撤销）再点「AI」：擦掉的不再当作之前写过的批注告诉 Claude，没擦的照旧；存盘也记着它擦掉了
await T.pen(T.line(n5[0] + 10, mid(n5), 50, 6));
await T.tap('#tools [data-tool=pen]');
await T.tap('#check');
const sub5 = await T.waitSub('S1');
T.ok('擦掉的蓝字不再告诉 Claude，没擦的照旧', Boolean(sub5) && /你之前在这一页写过的批注/.test(sub5.text) && !sub5.text.includes(TEXTS.note) && sub5.text.includes(TEXTS.question) && sub5.text.includes(TEXTS.cross), sub5 && sub5.text.slice(-300));
const band = [G.g2[0], G.g2[1] - 8, G.g2[2], G.g2[3] + 8], y0 = await tints(sub, band), y5 = await tints(sub5, band), c5 = await tints(sub5, by2.circle.pb);
T.ok('发给 Claude 的图里：第二行上有黄色的荧光笔（第一次交时还没有），第四行外面画着蓝圈', y0[0] === 0 && y5[0] > 50 && c5[1] > 50, [y0, y5, c5]);
const gone5 = await tints(sub5, n5), kept5 = await tints(sub5, by2.question.tb);
T.ok('发给 Claude 的图里：擦掉的短批注不在了，没擦的那条问句还在', gone5[1] < 5 && kept5[1] > 20, [gone5, kept5]);
await T.saved();
T.ok('页面文件里记着这一条擦掉了', T.pageFile('scratch', 0).ai.find((a) => a.text === TEXTS.note).erasedAt > 0, T.pageFile('scratch', 0).ai.find((a) => a.text === TEXTS.note));

// 6. 全屏时没有「⋯」；点「退出全屏」后顶栏出来
T.ok('全屏时看不到「⋯」', !(await T.visible('#menuBtn')) && (await T.visible('#toolsBars')), await T.visible('#menuBtn'));
await T.tap('#toolsBars');
T.ok('退出全屏后「⋯」出来了', await T.visible('#menuBtn'), await T.evalJS(`document.body.className`));

// 7. 平板翻到第 2 页时 Claude 写回第 1 页：先在电脑上排队，页面文件里还没有；翻回第 1 页才落下
await T.tap('#next');
await T.waitFor(`window.__ink.S.idx === 1 && window.__ink.S.page`);
await T.saved();
const rep7 = await T.post('/bridge/reply', { sid: 'S1', submission: sub.id, items: [{ type: 'note', anchor: 'g3', text: '排队的批注' }] });
await sleep(1500);
const queued = existsSync(PENDING) ? readFileSync(PENDING, 'utf8') : '';
T.ok('不在那一页：写回的批注在电脑上排着队', rep7.ok === true && (await T.evalJS(`window.__ink.S.idx`)) === 1 && queued.includes('排队的批注'), queued.slice(0, 200));
T.ok('这时第 1 页的页面文件里还没有它，第 2 页上也没有', !JSON.stringify(T.pageFile('scratch', 0)).includes('排队的批注') && (await T.evalJS(`window.__ink.S.page.ai.length`)) === 0, await T.evalJS(`window.__ink.S.page.ai.length`));
T.ok('平板上提示 Claude 在别的页写了批注', /别的页写了批注/.test(await toastText()), await toastText());
await T.tap('#prev');
await T.waitFor(`window.__ink.S.idx === 0 && window.__ink.S.page`);
T.ok('翻回第 1 页：排队的批注落下了，画在纸上', (await landed(15)) && (await drawn()).some((d) => d.type === 'note' && d.text === '排队的批注'), await items());
await T.saved();
T.ok('落下后队列清了，页面文件里有它', !existsSync(PENDING) && JSON.stringify(T.pageFile('scratch', 0)).includes('排队的批注'), existsSync(PENDING));

// 8. 「⋯」菜单：「显示 Claude 的批注」关掉就都不画（数据还在），再点又画出来
const nAi = (await items()).length, nDrawn = (await drawn()).length;
await T.tap('#menuBtn');
T.ok('点「⋯」菜单打开，「显示 Claude 的批注」勾着', (await T.visible('#menu')) && (await T.visible('#optAi')) && (await T.evalJS(`document.querySelector('#optAi').checked`)), await T.visible('#menu'));
await T.tap('#optAi');
T.ok('关掉显示：纸上一条蓝字都不画，数据还在', (await T.count('#aiRoot .ai-item')) === 0 && (await items()).length === nAi, [await T.count('#aiRoot .ai-item'), nAi]);
await T.tap('#optAi');
T.ok('再点一次：蓝字又都画出来', nDrawn >= 14 && (await T.count('#aiRoot .ai-item')) === nDrawn, [await T.count('#aiRoot .ai-item'), nDrawn]);

// 9. 「清除本页 Claude 批注」：先问一句；按取消不清，按确定清空，我的字不动。清除能撤销（2026-11-16 用户定）：
//    撤销一次整页原样回来，连圈号看过没看过都和清除前一样；再清一次、刷新后还是清掉的；清空了再点清除不再问
// 先来两条长回答（圈号），点开其中一条（看过、空心），另一条没看过（实心）
await T.post('/bridge/reply', { sid: 'S1', submission: sub.id, items: [{ type: 'write', fold: true, anchor: 'g1', q: '问一', text: '回答一' }, { type: 'write', fold: true, anchor: 'g4', q: '问二', text: '回答二' }] });
T.ok('（前提）两条长回答落下了', await T.waitFor(`window.__ink.S.page.ai.filter((a) => a.type === 'write').length === 2`, 10000));
if (await T.visible('#menu')) await T.tap('#menuBtn'); // 上一步开着的「⋯」菜单先收起，免得挡着圈号
await sleep(1200); // 笔刚用过的一秒内手指不算
const badgeAt = (id) => T.evalJS(`(() => { const c = document.querySelector('#aiRoot .badge[data-id="${id}"] circle'); if (!c) return null; const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const ws9 = await T.evalJS(`window.__ink.S.page.ai.filter((a) => a.type === 'write').map((a) => a.id)`), b9 = await badgeAt(ws9[0]);
if (b9) await T.fingerTapAt(b9[0], b9[1]); // 点开第一个圈号的卡片：记为看过
T.ok('（前提）点开了第一个圈号的卡片', Boolean(b9) && !(await T.evalJS(`document.querySelector('#answerCard').hidden`)), b9);
await T.fingerTapAt(b9[0], b9[1]); // 再点同一个圈号：卡片收起
const badges9 = () => T.evalJS(`[...document.querySelectorAll('#aiRoot .badge')].map((g) => g.dataset.id + ':' + g.classList.contains('seen')).join()`);
const seen9 = await badges9();
T.ok('（前提）两个圈号：第一个点开看过（空心），第二个没看过（实心）', seen9 === `${ws9[0]}:true,${ws9[1]}:false`, seen9);
const nAi9 = (await items()).length, nDrawn9 = await T.count('#aiRoot .ai-item');
const before9 = await T.evalJS(`JSON.stringify(window.__ink.S.page.ai)`);
await T.tap('#menuBtn');
T.ok('菜单里有「清除本页 Claude 批注」', (await T.visible('#actClearAi')) && /清除本页/.test(await T.text('#actClearAi')), await T.text('#actClearAi'));
T.ok('点清除先弹确认框，按了取消', await tapConfirm('#actClearAi', false), null);
T.ok('按取消：批注都还在', (await items()).length === nAi9 && (await T.count('#aiRoot .ai-item')) === nDrawn9 && (await T.evalJS(`JSON.stringify(window.__ink.S.page.ai)`)) === before9, (await items()).length);
await T.tap('#menuBtn');
T.ok('再点清除，按确定', await tapConfirm('#actClearAi', true), null);
T.ok('按确定：这一页的蓝字（连圈号）一条都不画了，我的六笔还在', (await T.count('#aiRoot .ai-item')) === 0 && (await T.count('#aiRoot .badge')) === 0 && (await T.strokes()) === 6,
  [await T.count('#aiRoot .ai-item'), await T.strokes()]);
T.ok('清掉的每条都记成擦掉了（数据留着，撤销才找得回来）', (await items()).length === nAi9 && (await items()).every((a) => a.erasedAt > 0), (await items()).map((a) => [a.type, a.erasedAt]));
T.ok('屏幕上方说清除了、点撤销能找回', /已清除本页 Claude 批注/.test(await toastText()) && /点撤销能找回/.test(await toastText()), await toastText());
await T.saved();
const end9 = T.pageFile('scratch', 0);
T.ok('存盘后页面文件里每条都记着擦掉了，笔迹还在', end9.ai.length === nAi9 && end9.ai.every((a) => a.erasedAt > 0) && end9.strokes.filter((s) => !s.erasedAt).length === 6, [end9.ai.length, end9.strokes.length]);
T.ok('（前提）退出全屏后顶栏上有撤销', await T.visible('#undo'));
await T.tap('#undo');
T.ok('撤销一次：整页批注原样回来（页面数据和清除前一模一样）', (await T.evalJS(`JSON.stringify(window.__ink.S.page.ai)`)) === before9, await T.evalJS(`window.__ink.S.page.ai.filter((a) => a.erasedAt).length`));
T.ok('撤销后：画出来的蓝字和清除前一样多，圈号看过没看过也和清除前一样', (await T.count('#aiRoot .ai-item')) === nDrawn9 && (await badges9()) === seen9, [await T.count('#aiRoot .ai-item'), nDrawn9, await badges9()]);
await T.saved();
// 第 5 步擦掉、没撤销的那条短批注本来就记着擦掉，照旧；别的都不再记着擦掉
const er9 = JSON.parse(before9).map((a) => a.erasedAt || 0), disk9 = T.pageFile('scratch', 0).ai.map((a) => a.erasedAt || 0);
T.ok('撤销后存盘：页面文件里和清除前一样（清除前就擦掉的那一条照旧擦掉，别的都没记着擦掉）', er9.filter(Boolean).length === 1 && JSON.stringify(disk9) === JSON.stringify(er9), [disk9, er9]);
await T.tap('#menuBtn');
T.ok('再清一次，按确定', await tapConfirm('#actClearAi', true), null);
await T.saved();
await T.reload();
T.ok('刷新后：还是清掉的，一条蓝字都不画，笔迹还在', (await T.count('#aiRoot .ai-item')) === 0 && (await T.count('#aiRoot .badge')) === 0 && (await T.strokes()) === 6, [await T.count('#aiRoot .ai-item'), await T.strokes()]);
await T.tap('#menuBtn');
T.ok('都清掉了以后再点清除：不再弹确认框', !(await tapConfirm('#actClearAi', true)), null);
// 一页上没有我的字、只有 Claude 的一条批注：清掉以后点「AI」，和以前清空了一样，说这一页还没写字、不交
// （这条批注是直接放进页面数据的，免得为它先写字、交稿、再擦掉）
await T.tap('#next');
await T.waitFor(`window.__ink.S.idx === 1 && window.__ink.S.page`);
await T.evalJS(`(() => { const S = window.__ink.S;
  S.page.ai.push({ id: 'zx', type: 'note', t: Date.now(), text: '空页上的批注', lay: { x: 120, y: 300, w: 200, h: 30, lines: ['空页上的批注'], fs: 21, lh: 29 }, hit: [114, 296, 320, 334] });
  window.__ink.renderAI(); return 1; })()`);
T.ok('（前提）第 2 页没有我的字，只有一条蓝字', (await T.strokes()) === 0 && (await T.count('#aiRoot .ai-item')) === 1, [await T.strokes(), await T.count('#aiRoot .ai-item')]);
await T.tap('#menuBtn');
T.ok('清掉这一条', await tapConfirm('#actClearAi', true), null);
await T.saved();
await T.tap('#barCheck');
T.ok('清掉以后点「AI」：说这一页还没写字，没有交上去', /还没写字/.test(await toastText()) && !(await T.poll('S1')), await toastText());

await T.finish();

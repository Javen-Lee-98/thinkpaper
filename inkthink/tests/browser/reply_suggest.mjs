// 修改建议：文档上的虚线框带 ✓ ×；手指点、笔点、用笔在框里打勾 / 横划都能定，撤销能收回；
// 决定跟着下一次「检查」带给 Claude（没有「发送决定」按钮）；Claude 回报改成了没有，纸上标出来。
// 另外：普通蓝字旁画星号＝采纳（深蓝带 ★）；从蓝字上横划不再是手势（2026-11-12 去掉），以前划掉过的照旧是淡的；
// 空白本子里对我自己的字提的建议只是一条页边批注。
// 跑法：node tests/browser/reply_suggest.mjs [临时目录]；有一项不对退出码 1。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'reply-suggest' });
const DOC = join(T.OUT, 'outline.txt');
writeFileSync(DOC, 'I 出发前\nII 第一天行程\nIII 第二天行程\nIV 预算\nV 结论\n', 'utf8');

const seg = (pts, n = 8) => pts.slice(1).flatMap((b, k) => Array.from({ length: n }, (_, i) => [pts[k][0] + ((b[0] - pts[k][0]) * i) / n, pts[k][1] + ((b[1] - pts[k][1]) * i) / n])).concat([pts[pts.length - 1]]);
const star = (cx, cy, R = 22) => seg(Array.from({ length: 6 }, (_, k) => { const t = -Math.PI / 2 + (k * 4 * Math.PI) / 5; return [cx + R * Math.cos(t), cy + R * Math.sin(t)]; }), 10);
// 这一页上的修改建议（按 Claude 写回的先后）：数据里的决定，和纸上画出来的样子（虚线框、✓ × 钮、旁边的话和状态）
const sug = () => T.evalJS(`window.__ink.S.page.ai.filter((a) => a.type === 'suggest').map((a) => { const g = document.querySelector('#aiRoot [data-id="' + a.id + '"]'), q = (s) => g && g.querySelector(s);
  const c = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sb = q('path.sbox'), bb = sb && sb.getBBox();
  return { id: a.id, verdict: a.verdict || null, sent: Boolean(a.sent), result: a.result || null, onDoc: Boolean(a.onDoc), box: a.box, cls: g ? g.getAttribute('class') : '', opacity: g ? getComputedStyle(g).opacity : '',
    dash: sb ? getComputedStyle(sb).strokeDasharray : '', stroke: sb ? getComputedStyle(sb).stroke : '', sbox: bb && [bb.x, bb.y, bb.x + bb.width, bb.y + bb.height],
    yes: c(q('.vbtn.yes circle')), no: c(q('.vbtn.no circle')), on: [Boolean(q('.vbtn.yes.on')), Boolean(q('.vbtn.no.on'))], marks: g ? Array.from(g.querySelectorAll('.vbtn text')).map((t) => t.textContent).join('') : '',
    text: g ? Array.from(g.querySelectorAll(':scope > text:not(.vstat)')).map((t) => t.textContent).join('') : '', stat: (q('text.vstat') || {}).textContent || '' }; })`);
const verdicts = async () => (await sug()).map((s) => s.verdict);
// 普通蓝字（页边批注）：数据里的采纳 / 划掉，和纸上的样子
const note = (text) => T.evalJS(`(() => { const a = window.__ink.S.page.ai.find((o) => o.text === ${JSON.stringify(text)}), g = a && document.querySelector('#aiRoot [data-id="' + a.id + '"]'), t = g && g.querySelector('text:not(.adopt-star)');
  return a && { lay: a.lay, type: a.type, adopted: Boolean(a.adopted), dismissed: Boolean(a.dismissed), cls: g ? g.getAttribute('class') : '', star: g && g.querySelector('.adopt-star') ? g.querySelector('.adopt-star').textContent : '',
    fill: t ? getComputedStyle(t).fill : '', opacity: g ? getComputedStyle(g).opacity : '', vbtn: g ? g.querySelectorAll('.vbtn').length : 0, sbox: g ? g.querySelectorAll('path.sbox').length : 0 }; })()`);
async function landed(n) { // 等写回的批注落到这一页（一共 n 条），并且一条条写完
  const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.length >= ${n}`, 10000);
  await T.evalJS(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
  return (await T.waitFor('window.__written', 40000)) && ok;
}
const toastText = () => T.evalJS(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
const strokeCount = () => T.evalJS(`window.__ink.S.page.strokes.length`); // 连擦掉的也算：手势那一笔不该留下
// 发给 Claude 的那张图里，一块地方（页面坐标的框 b）有多少深蓝的点、多少普通蓝的点：返回 [深蓝, 蓝]
function blues(subId, crop, b) {
  const jpg = readFileSync(join(T.DATA, 'submissions', subId, 'crop.jpg')).toString('base64'), r = [b[0] - crop.x0, b[1] - crop.y0, b[2] - b[0], b[3] - b[1]].map((v) => Math.round(v * crop.scale));
  return T.evalJS(`new Promise((res) => { const im = new Image(); im.onload = () => { const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const x = cv.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(${r.join(', ')}).data; let deep = 0, blue = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 2] - d[i] > 50 && d[i + 2] > 90) { if (d[i + 2] < 150) deep++; else blue++; } res([deep, blue]); };
    im.onerror = () => res(null); im.src = 'data:image/jpeg;base64,${jpg}'; })`);
}

// 1. Claude 推送一页文档到平板；点提示上的「打开」，在文档上用红笔画一道，点「检查」
const shown = await T.post('/bridge/show', { sid: 'S1', path: DOC, title: '提纲' });
T.ok('平板上提示 Claude 推送了一页', shown.ok === true && (await T.waitFor(`/推送了一页：提纲/.test(document.querySelector('#toast').textContent) && !document.querySelector('#toast').hidden`)), [shown, await toastText()]);
await T.tap('#toast button');
T.ok('点「打开」：到了那一页文档上（有印刷的底图）', (await T.waitFor(`window.__ink.S.nb && window.__ink.S.nb.id === 'board' && window.__ink.S.page && window.__ink.S.bgImg`)), await T.evalJS(`window.__ink.S.nb && window.__ink.S.nb.id`));
await sleep(800);
await T.tap('#tools [data-tool=red]');
await T.pen(T.line(150, 620, 300));
await T.tap('#tools [data-tool=pen]');
await T.tap('#check');
const sub1 = await T.waitSub('S1'), meta1 = sub1 && T.metaOf(sub1);
T.ok('交上去了：是推送的那一页，红笔那组算写在文档上', Boolean(meta1) && meta1.nb === 'board' && meta1.groups.length === 1 && meta1.groups[0].on === 'doc' && /提纲/.test(sub1.text), meta1 && meta1.groups);

// 2. Claude 对文档里的四处各提一条修改（用图里的像素框指），另写两条普通的页边批注
const SUG = ['改为：II 第一天去海边', '改为：III 第二天爬山', '删去这句', '改为：V 小结'], BOX = [130, 200, 270, 340].map((y) => [80, y, 520, y + 35]);
const c = meta1.crop, px = (b) => [(b[0] - c.x0) * c.scale, (b[1] - c.y0) * c.scale, (b[2] - c.x0) * c.scale, (b[3] - c.y0) * c.scale];
const rep = await T.post('/bridge/reply', { sid: 'S1', submission: sub1.id, items: SUG.map((text, i) => ({ type: 'suggest', text, box: px(BOX[i]) }))
  .concat([{ type: 'note', anchor: 'g1', text: '这个记号留着' }, { type: 'note', box: px([80, 460, 520, 495]), text: '这句可以删' }]) });
T.ok('服务收下了 6 条', rep.ok === true && rep.count === 6, rep);
T.ok('6 条都落到这一页、写完了', await landed(6), await T.evalJS(`window.__ink.S.page.ai.map((a) => a.type)`));
let S4 = await sug();
T.ok('四条建议都算在文档上', S4.length === 4 && S4.every((s) => s.onDoc && !s.verdict && !s.sent), S4);
T.ok('每条：虚线框正好框住所指的那块', S4.every((s, i) => s.dash !== 'none' && s.sbox && [0, 1, 2, 3].every((k) => Math.abs(s.sbox[k] - (BOX[i][k] + (k < 2 ? -6 : 6))) < 2)), S4.map((s) => [s.dash, s.sbox]));
T.ok('每条：框旁有 ✓ × 两个钮（都还没选），改成什么写在页边', S4.every((s, i) => s.marks === '✓×' && s.yes && s.no && !s.on[0] && !s.on[1] && s.text === SUG[i] && s.stat === '' && / v-none/.test(s.cls)), S4.map((s) => [s.marks, s.text, s.cls]));
T.ok('✓ × 钮在框的右边、和框齐平', (await Promise.all(S4.map(async (s, i) => { const r = await T.screenOf(BOX[i][2], (BOX[i][1] + BOX[i][3]) / 2); return s.yes[0] > r[0] && s.no[0] > s.yes[0] && Math.abs(s.yes[1] - r[1]) < 4; }))).every(Boolean), S4.map((s) => [s.yes, s.no]));

// 3. 手指点第 1 条的 ✓＝采纳，点第 2 条的 ×＝不采纳（第 2 条的 × 正好在屏幕上方那条提示的底下）
await T.fingerTapAt(...S4[0].yes);
const toast3 = await toastText();
// 这时提示正盖在第 2 条的 × 上（屏幕上看是这样）；提示不带按钮，点按要能穿过它
const cover = await T.evalJS(`(() => { const t = document.querySelector('#toast'), r = t.getBoundingClientRect(), x = ${S4[1].no[0]}, y = ${S4[1].no[1]};
  return !t.hidden && !t.querySelector('button') && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; })()`);
await T.fingerTapAt(...S4[1].no);
T.ok('上一条的提示还显示着、正盖在下一条的 × 上：点 × 点得到（提示不挡点按）', cover && (await verdicts())[1] === 'no', [cover, await verdicts()]);
S4 = await sug();
T.ok('手指点 ✓：采纳，钮变实心，框变绿', S4[0].verdict === 'yes' && S4[0].on[0] && / v-yes/.test(S4[0].cls) && S4[0].stroke === 'rgb(47, 122, 62)', S4[0]);
T.ok('提示说决定下次点「AI」时带给 Claude、撤销可以收回', /采纳/.test(toast3) && /下次点「AI」/.test(toast3) && /撤销/.test(toast3), toast3);
T.ok('手指点 ×：不采纳，钮变实心，整条变淡', S4[1].verdict === 'no' && S4[1].on[1] && / v-no/.test(S4[1].cls) && Number(S4[1].opacity) < 0.6, S4[1]);
T.ok('交出去以前：不采纳的比采纳的淡', Number(S4[1].opacity) < Number(S4[0].opacity) - 0.1, [S4[0].opacity, S4[1].opacity]);
await T.fingerTapAt(...S4[0].yes);
const again = (await verdicts())[0];
await T.fingerTapAt(...S4[0].yes);
T.ok('同一个钮再点一次：取消，回到没定；再点又是采纳', again === null && (await verdicts())[0] === 'yes', [again, await verdicts()]);

// 4. 用笔在第 3 条的框里打勾＝采纳，在第 4 条的框里横划＝不采纳；这两笔不留作笔迹；撤销收回最后一个决定
const n0 = await strokeCount(), mid = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], [tx, ty] = mid(BOX[2]);
await T.pen(seg([[tx - 14, ty - 2], [tx - 5, ty + 9], [tx + 18, ty - 16]]));
await T.pen(seg([[BOX[3][0] + 6, mid(BOX[3])[1]], [BOX[3][0] + 166, mid(BOX[3])[1] + 2]]));
T.ok('笔在框里打勾＝采纳，横划＝不采纳', JSON.stringify(await verdicts()) === JSON.stringify(['yes', 'no', 'yes', 'no']), await verdicts());
T.ok('打勾和横划的那两笔没有留在纸上', (await strokeCount()) === n0, [n0, await strokeCount()]);
await T.tap('#toolsUndo');
T.ok('撤销：第 4 条回到没定，别的不变', JSON.stringify(await verdicts()) === JSON.stringify(['yes', 'no', 'yes', null]), await verdicts());
await T.pen([await T.evalJS(`(() => { const S = window.__ink.S, r = document.querySelector('#stage').getBoundingClientRect(); return [(${S4[3].no[0]} - r.left - S.view.tx) / S.view.s, (${S4[3].no[1]} - r.top - S.view.ty) / S.view.s]; })()`)]);
T.ok('笔尖点一下第 4 条的 ×：不采纳，这一点不留作笔迹', (await verdicts())[3] === 'no' && (await strokeCount()) === n0, [await verdicts(), await strokeCount()]);
await T.tap('#toolsUndo');
T.ok('再撤销：第 4 条又回到没定', (await verdicts())[3] === null, await verdicts());
const [kx, ky] = mid(BOX[3]);
// 打叉之前先在空白处写一笔普通的字：打叉后撤销一次回到没定，再撤销一次撤掉的就是这一笔（打叉不多留一步没有效果的撤销）
await T.pen(T.line(150, 760, 150));
const undo0 = await T.evalJS(`window.__ink.S.undo.length`);
await T.pen(seg([[kx - 14, ky - 12], [kx + 14, ky + 12]]));
await T.pen(seg([[kx + 14, ky - 12], [kx - 14, ky + 12]]));
T.ok('用笔在框里打叉（两笔交叉）：不采纳，两笔都不留', (await verdicts())[3] === 'no' && (await strokeCount()) === n0 + 1, [await verdicts(), await strokeCount()]);
await T.tap('#toolsUndo');
T.ok('打叉后撤销一次：回到没定，撤销记录回到打叉之前', (await verdicts())[3] === null && (await T.evalJS(`window.__ink.S.undo.length`)) === undo0,
  [await verdicts(), undo0, await T.evalJS(`window.__ink.S.undo.length`)]);
await T.tap('#toolsUndo');
T.ok('再撤销一次：撤掉的是打叉之前写的那一笔（没有多出一次没效果的撤销）', (await strokeCount()) === n0 && (await verdicts())[3] === null, [await strokeCount(), n0]);

// 5. 普通蓝字：旁边画个星号＝采纳（深蓝带 ★），撤销能收回；从蓝字上横划一道不再是手势，就是一笔普通的字（蓝字不变淡）；
//    以前横划过的蓝字（数据里记着 dismissed）照旧画成淡的；划在自己的字上照旧是笔迹
let A = await note('这个记号留着');
await T.pen(star(A.lay.x + 150, A.lay.y + A.lay.h + 30));
A = await note('这个记号留着');
T.ok('蓝字旁画星号：采纳，变深蓝、右上角一颗 ★', A.adopted && / adopted/.test(A.cls) && A.star === '★' && A.fill === 'rgb(31, 61, 122)', A);
T.ok('星号那一笔没有留在纸上，提示说采纳了、撤销可以收回', (await strokeCount()) === n0 && /采纳：深蓝.*撤销/.test(await toastText()), [await strokeCount(), await toastText()]);
await T.tap('#toolsUndo');
T.ok('撤销：不再是采纳的样子', !(await note('这个记号留着')).adopted && (await note('这个记号留着')).star === '', await note('这个记号留着'));
await T.pen(star(A.lay.x + 150, A.lay.y + A.lay.h + 30));
let Bn = await note('这句可以删');
const strikeB = seg([[Bn.lay.x + 10, Bn.lay.y + Bn.lay.h / 2], [Bn.lay.x + 150, Bn.lay.y + Bn.lay.h / 2 + 2]]);
await T.pen(strikeB);
Bn = await note('这句可以删');
T.ok('横划蓝字：不再是手势，蓝字没划掉、没变淡，这一笔照常留作笔迹', !Bn.dismissed && !/ dismissed/.test(Bn.cls) && Number(Bn.opacity) > 0.9 && (await strokeCount()) === n0 + 1, [Bn, await strokeCount()]);
await T.tap('#toolsUndo');
T.ok('撤销：去掉的是刚才那一笔，蓝字照旧', (await strokeCount()) === n0 && !(await note('这句可以删')).dismissed, [await strokeCount(), await note('这句可以删')]);
// 以前横划过的蓝字：直接在页面数据里记上 dismissed（现在的页面上已经没有划掉的手势），照旧画成淡的
await T.evalJS(`(() => { const S = window.__ink.S; S.page.ai.find((o) => o.text === '这句可以删').dismissed = true; window.__ink.renderAI(); })()`);
Bn = await note('这句可以删');
T.ok('以前划掉过的蓝字（dismissed）照旧画成淡的', Bn.dismissed && / dismissed/.test(Bn.cls) && Number(Bn.opacity) < 0.3, Bn);
await T.pen(seg([[160, 622], [440, 624]]));
T.ok('横划在我自己写的字上：照旧是一笔笔迹，不当手势', (await strokeCount()) === n0 + 1 && !(await note('这个记号留着')).dismissed, await strokeCount());
await T.tap('#toolsUndo');

// 6. 没有「发送决定」按钮，也不会自己发；退出全屏后顶栏上也没有，只有「检查」
await sleep(1500);
const early = await T.poll('S1');
T.ok('定了以后没有自己发出去', !early, early && early.id);
await T.tap('#toolsBars');
T.ok('退出全屏：顶栏上没有「发送决定」「批量回应」，有「AI」', (await T.visible('#bar')) && !(await T.visible('#sendDecisions')) && !(await T.visible('#batchVote')) && (await T.visible('#barCheck')), await T.evalJS(`document.body.className`));

// 7. 点顶栏的「检查」：三条决定随这一次带给 Claude（消息里有采纳 / 不采纳那一段），没定的那条不带；划掉的蓝字不再提
await T.saved();
await T.tap('#barCheck');
const sub2 = await T.waitSub('S1'), meta2 = sub2 && T.metaOf(sub2), vs = (meta2 && meta2.verdicts) || [];
T.ok('决定带上了：三条，各是采纳 / 不采纳 / 采纳，都标着在文档上', JSON.stringify(vs.map((v) => [v.id, v.kind, v.verdict, v.on, v.text])) === JSON.stringify([['s1', 'suggest', 'yes', 'doc', SUG[0]], ['s2', 'suggest', 'no', 'doc', SUG[1]], ['s3', 'suggest', 'yes', 'doc', SUG[2]]]), vs);
T.ok('消息里有「修改建议的决定」一段，逐条写着采纳 / 不采纳', Boolean(sub2) && /修改建议的决定：图里标 s1、s2、s3/.test(sub2.text) && sub2.text.includes(`- s1（在文档上）「${SUG[0]}」：采纳`)
  && sub2.text.includes(`- s2（在文档上）「${SUG[1]}」：不采纳`) && sub2.text.includes(`- s3（在文档上）「${SUG[2]}」：采纳`), sub2 && sub2.text.slice(-700));
T.ok('没定的那条不在决定里；消息里叫 Claude 改完用 result 回报', !vs.some((v) => v.text === SUG[3]) && !sub2.text.includes(`「${SUG[3]}」：`) && /result/.test(sub2.text), vs);
T.ok('采纳的蓝字照旧告诉 Claude，划掉的不再提', sub2.text.includes('这个记号留着') && !sub2.text.includes('这句可以删'), sub2.text.slice(-300));
// 图是压缩过的，细笔画的颜色会偏：拿采纳的那条和一条没采纳的蓝字（第 4 条建议页边的话）比深色的点占多少
const layBox = (l) => [l.x, l.y, l.x + l.w, l.y + l.h], share = (v) => (v && v[0] + v[1] ? v[0] / (v[0] + v[1]) : 0);
const bl = await blues(sub2.id, meta2.crop, layBox(A.lay)), bn = await blues(sub2.id, meta2.crop, layBox((await note(SUG[3])).lay));
T.ok('采纳的那条蓝字和没采纳的蓝字都画在发给 Claude 的图里', Boolean(bl) && bl[0] + bl[1] > 30 && Boolean(bn) && bn[0] + bn[1] > 30, [bl, bn]);
T.ok('采纳的蓝字在发给 Claude 的图里是深蓝的（和没采纳的分得开，和几页一起交时服务器画的一样）', share(bl) > share(bn) + 0.25, [bl, bn]);
S4 = await sug();
T.ok('带出去以后：这三条不能再点，采纳的写「改着呢」，不采纳的写「不采纳」', S4.slice(0, 3).every((s) => s.sent && s.marks === '' && / sent/.test(s.cls)) && /改着呢/.test(S4[0].stat) && S4[1].stat === '不采纳' && /改着呢/.test(S4[2].stat), S4.map((s) => [s.sent, s.marks, s.stat]));
T.ok('交出去以后：不采纳的仍比采纳的淡', Number(S4[1].opacity) < Number(S4[0].opacity) - 0.1 && Number(S4[1].opacity) < Number(S4[2].opacity) - 0.1,
  S4.slice(0, 3).map((s) => [s.verdict, s.opacity]));
T.ok('没定的第 4 条还带着 ✓ × 钮', !S4[3].sent && S4[3].marks === '✓×' && S4[3].stat === '', S4[3]);

// 8. Claude 用 result 回报：s1 改成了，s3 没改成（带原因）；纸上标出来，没改成的可以重新定
const res = await T.post('/bridge/reply', { sid: 'S1', submission: sub2.id, items: [{ type: 'result', anchor: 's1', ok: true }, { type: 'result', anchor: 's3', ok: false, text: '原文件被占用' }] });
await T.waitFor(`window.__ink.S.page.ai.filter((a) => a.result).length === 2`);
S4 = await sug();
T.ok('回报改成了：纸上那条写「已改」', res.ok === true && S4[0].stat === '已改' && S4[0].result.ok === true && S4[0].verdict === 'yes', S4[0]);
T.ok('回报没改成：纸上写「没改成」和原因，决定清掉，✓ × 钮回来可以重新定', S4[2].stat === '没改成：原文件被占用' && S4[2].verdict === null && !S4[2].sent && S4[2].marks === '✓×', S4[2]);
await T.saved();
const disk = T.pageFile('board', 0).ai;
T.ok('存到电脑上的页面文件里有这些决定和回报', disk.filter((a) => a.type === 'suggest').length === 4 && disk.find((a) => a.text === SUG[0]).result.ok === true && disk.find((a) => a.text === SUG[1]).verdict === 'no'
  && disk.find((a) => a.text === SUG[1]).sent === true && disk.find((a) => a.text === SUG[2]).result.text === '原文件被占用' && disk.find((a) => a.text === '这个记号留着').adopted === true, disk.map((a) => [a.type, a.verdict, a.sent, a.result]));

// 9. 空白本子里对我自己写的字提建议：我自己改，只画成一条页边批注，没有虚线框和 ✓ ×
await T.openNotebook('scratch', 0);
await T.pen(T.line(120, 200, 300));
await T.tap('#barCheck');
const sub3 = await T.waitSub('S1');
await T.post('/bridge/reply', { sid: 'S1', submission: sub3.id, items: [{ type: 'suggest', anchor: 'g1', text: '改为：平均速度' }] });
await landed(1);
const mine = await note('改为：平均速度');
T.ok('对我自己的字提的建议：画成页边批注，没有虚线框和 ✓ ×', Boolean(mine) && mine.type === 'note' && mine.vbtn === 0 && mine.sbox === 0 && (await T.count('#aiRoot .ai-suggest')) === 0, mine);

await T.finish();

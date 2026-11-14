// 文档原地换新版：导入一份 4 页的 PDF，在各页写字；原文件改掉（改一页、插一页、删一页）后再导入同一个文件，
// 这本原地更新、不多出一本，笔迹跟着对应的页走，改过的页标出改动处、能对比旧版；删掉的页上的笔迹另存。
// 还有：原文件在电脑上改了但没人导入 → 平板提示「原文件改过了」，点一下更新。
// 前 7 步的字都写在离改动处远的地方；第 8 步专门看压在改动处的笔迹：「请 Claude 看看」和收起 / 挪动旧笔迹都删了，
// 它留在原页、不变淡，右上角直接是「对比旧版」。
// 跑法：node tests/browser/doc_update.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'doc-update' });
const SRC = join(T.ROOT, 'src'), PDF = join(SRC, '例会.pdf');
mkdirSync(SRC, { recursive: true });
// 现场生成 PDF：每页一行大字，slides 是 [[字, x, y], …]（页面 1000 × 562.5）
const makePdf = (slides, path = PDF) => execFileSync(PY, ['-c', `import fitz,sys,json
doc=fitz.open()
for t,x,y in json.loads(sys.argv[2]):
    p=doc.new_page(width=1000,height=562.5); p.insert_text((x,y),t,fontsize=40)
doc.save(sys.argv[1])`, path, JSON.stringify(slides)]);
const P1 = ['Intro: weekend trip planner', 60, 120], P2 = ['Method: simple travel budget', 60, 120];
const P3 = ['Result: total cost 300 yuan', 60, 120], P4 = ['Summary and the next steps', 60, 120];
const NEW = ['Agenda for today and tomorrow', 60, 120], P2B = ['Method: itemized travel budget', 300, 300];
const dirOf = (name) => 'book-' + createHash('sha1').update(name).digest('hex').slice(0, 12); // 这本的笔迹存在哪个文件夹
const NB_DIR = dirOf('例会.pdf'), nbPath = join(T.DATA, 'notebooks', NB_DIR);

// ---- 小工具
const idsOnDisk = (n, dir = NB_DIR) => Array.from({ length: n }, (_, i) => { const p = T.pageFile(dir, i); return p ? p.strokes.map((s) => s.id).join('+') : ''; });
const waitDisk = async (want, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (JSON.stringify(idsOnDisk(want.length)) === JSON.stringify(want)) return true; await T.sleep(250); } return false; };
const idsOnTablet = async (n) => { const out = []; for (let i = 0; i < n; i++) { await T.openPage(i); out.push((await T.evalJS(`window.__ink.S.page.strokes.map((s) => s.id)`)).join('+')); } return out; };
const writeOn = async (i) => { await T.openPage(i); await T.pen(T.line(200, 400, 300)); return T.evalJS(`window.__ink.S.page.strokes.at(-1).id`); };
const toastText = () => T.evalJS(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
const books = async () => (await T.apiJson('/api/notebooks')).filter((n) => n.id.startsWith('book:')).map((n) => n.id);
const chip = () => T.evalJS(`(() => { const c = document.querySelector('#verchip'), a = document.querySelector('#verAct'), r = c.getBoundingClientRect();
  return { shown: !c.hidden && r.width > 0, kind: c.dataset.kind || '', text: document.querySelector('#verText').textContent, act: a.hidden ? '' : a.textContent,
    topRight: r.right > innerWidth - 30 && r.top < 160 }; })()`);
// 底图画布上这一块（纸上的坐标）有多少深色的点：分辨画的是新版还是旧版的底图
const darkIn = (x0, y0, x1, y1) => T.evalJS(`(() => { const v = window.__ink.S.view, c = document.querySelector('#bg'), k = c.width / c.clientWidth;
  const d = c.getContext('2d').getImageData(Math.round((v.tx + ${x0} * v.s) * k), Math.round((v.ty + ${y0} * v.s) * k), Math.round(${x1 - x0} * v.s * k), Math.round(${y1 - y0} * v.s * k)).data;
  let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 300) n++; return n; })()`);
const OLD_AT = [60, 85, 600, 130], NEW_AT = [300, 265, 900, 310]; // 第 2 页的标题：旧版在上面，新版挪到了中间
// 橙框（改动处）在纸上的坐标
const chgBoxes = () => T.evalJS(`Array.from(document.querySelectorAll('#aiRoot .chg-marks rect.chg')).filter((r) => r.getClientRects().length)
  .map((r) => ['x', 'y', 'width', 'height'].map((k) => Number(r.getAttribute(k))))`);
const covers = (boxes, at) => boxes.some((b) => b[0] < at[2] && b[0] + b[2] > at[0] && b[1] < at[3] && b[1] + b[3] > at[1]);

// 1. 导入：平板上弹出提示，点「打开」进到这本
makePdf([P1, P2, P3, P4]);
const imp = await T.post('/bridge/import', { sid: 'S1', path: PDF });
T.ok('导入成一本 4 页的书', imp.ok && imp.id === 'book:例会.pdf' && imp.pages === 4, imp);
await T.waitFor(`!document.querySelector('#toast').hidden && document.querySelector('#toast button')`);
T.ok('平板上提示导入了，带「打开」', /导入了《例会》/.test(await toastText()), await toastText());
await T.tap('#toast button', 1500);
T.ok('点「打开」进到这本', (await T.evalJS(`window.__ink.S.nb.id`)) === imp.id && (await T.evalJS(`window.__ink.S.nb.pages`)) === 4, await T.evalJS(`window.__ink.S.nb.id`));

// 2. 四页各写一笔（写在页面下半，离标题远）
const A = await writeOn(0), B = await writeOn(1), C = await writeOn(2), D = await writeOn(3);
T.ok('四页各写了一笔，都存到电脑上', await waitDisk([A, B, C, D]), idsOnDisk(4));

// 3. 原文件改掉：第 1 页后插一页，原第 2 页的标题改写并挪了位置；再导入同一个文件
await T.sleep(1200);
makePdf([P1, NEW, P2B, P3, P4]);
const up1 = await T.post('/bridge/import', { sid: 'S1', path: PDF });
T.ok('再导入同一个文件：原地更新（还是这本，5 页）', up1.ok && up1.id === imp.id && up1.pages === 5 && /第 3 页有改动/.test(up1.updated) && /新增第 2 页/.test(up1.updated), up1);
T.ok('没有多出一本', JSON.stringify(await books()) === JSON.stringify([imp.id]), await books());
T.ok('平板上这本自己换成了新版', await T.waitFor(`window.__ink.S.nb.pages === 5 && window.__ink.S.page`), await T.evalJS(`window.__ink.S.nb.pages`));
T.ok('平板上说了改了什么', /已更新：第 3 页有改动；新增第 2 页/.test(await toastText()), await toastText());
T.ok('电脑上的笔迹跟着页走（插页后往后挪一页）', JSON.stringify(idsOnDisk(5)) === JSON.stringify([A, '', B, C, D]), idsOnDisk(5));
const tab1 = await idsOnTablet(5);
T.ok('平板上翻到各页，笔迹也在对应的页上', JSON.stringify(tab1) === JSON.stringify([A, '', B, C, D]), tab1);
await T.tap('#nbChip');
T.ok('抽屉里也只有这一本书', (await T.count('#nbList .nb-item')) === 2 && (await T.visible('#nbList .nb-item.cur')), await T.count('#nbList .nb-item'));
await T.fingerTapAt(700, 900); // 手指点一下纸面收起抽屉（鼠标点会当成笔，留下一个点）

// 4. 改过的那一页：右上角有提示，改动处有橙框，能对比旧版再回来
await T.openPage(2);
let c = await chip();
T.ok('改过的页右上角有提示和「对比旧版」', c.shown && c.topRight && /更新时改过/.test(c.text) && c.act === '对比旧版', c);
const boxes = await chgBoxes();
T.ok('改动处用橙框标出来（旧标题和新标题的位置）', boxes.length >= 1 && covers(boxes, OLD_AT) && covers(boxes, NEW_AT), boxes);
let dk = [await darkIn(...OLD_AT), await darkIn(...NEW_AT)];
T.ok('底图是新版：标题在中间，上面是空的', dk[0] === 0 && dk[1] > 200, dk);
await T.tap('#verAct', 1500);
c = await chip();
dk = [await darkIn(...OLD_AT), await darkIn(...NEW_AT)];
T.ok('点「对比旧版」：提示变成在看旧版', (await T.evalJS(`window.__ink.S.compare`)) === true && /旧版/.test(c.text) && c.act === '回到新版', c);
T.ok('底图换成旧版：标题在上面，中间是空的', dk[0] > 200 && dk[1] === 0, dk);
T.ok('看旧版时笔迹还在', (await T.strokes()) === 1, await T.strokes());
await T.tap('#verAct', 1500);
c = await chip();
dk = [await darkIn(...OLD_AT), await darkIn(...NEW_AT)];
T.ok('再点回到新版', (await T.evalJS(`window.__ink.S.compare`)) === false && c.act === '对比旧版' && dk[0] === 0 && dk[1] > 200, [c, dk]);
await T.openPage(1);
c = await chip();
T.ok('新加的页上写着是新加的，没有「对比旧版」', c.shown && /新加的/.test(c.text) && c.act === '', c);
await T.openPage(0);
c = await chip();
T.ok('没改的页上没有提示，也没有橙框', !c.shown && (await chgBoxes()).length === 0, c);

// 5. 删页：把有笔迹的一页（现在的第 4 页）从原文件里删掉；删之前刚在新加的页上写了一笔，还没来得及存
makePdf([P1, NEW, P2B, P4]);
const E = await writeOn(1);
const up2 = await T.post('/bridge/import', { sid: 'S1', path: PDF });
T.ok('删页后再导入：还是这本，4 页，说明删了哪页', up2.ok && up2.id === imp.id && up2.pages === 4 && /删掉了旧版第 4 页（上面的手写另存了）/.test(up2.updated), up2);
T.ok('平板上换成 4 页', await T.waitFor(`window.__ink.S.nb.pages === 4 && window.__ink.S.page`), await T.evalJS(`window.__ink.S.nb.pages`));
T.ok('平板上说了删掉的页上的手写另存了', /删掉了旧版第 4 页（上面的手写另存了）/.test(await toastText()), await toastText());
T.ok('笔迹跟着页走（删页后往前挪一页），刚写没存的那笔也在', JSON.stringify(idsOnDisk(4)) === JSON.stringify([A, E, B, D]), idsOnDisk(4));
const tab2 = await idsOnTablet(4);
T.ok('平板上各页的笔迹也对', JSON.stringify(tab2) === JSON.stringify([A, E, B, D]), tab2);
const kept = readdirSync(nbPath).filter((f) => /^removed-.*-page-0003\.json$/.test(f));
const keptIds = kept.length === 1 ? JSON.parse(readFileSync(join(nbPath, kept[0]), 'utf8')).strokes.map((s) => s.id) : [];
T.ok('删掉的那页上的笔迹另存在电脑上，没丢', kept.length === 1 && keptIds.join() === C, [kept, keptIds]);
T.ok('还是只有一本', JSON.stringify(await books()) === JSON.stringify([imp.id]), await books());
const olds = existsSync(join(T.BOOKS, '_旧版')) ? readdirSync(join(T.BOOKS, '_旧版')) : [];
T.ok('两次更新前的旧版都留着', olds.length === 2, olds);

// 6. 原文件在电脑上改了、没人导入：平板重新打开时提示「原文件改过了」，点一下更新
await T.sleep(1200);
makePdf([['Intro: weekend trip planners, second draft', 60, 120], NEW, P2B, P4]);
await T.reload();
c = await chip();
T.ok('平板提示原文件改过了，带「更新到草稿纸」', c.shown && c.kind === 'source' && /原文件「例会\.pdf」改过了/.test(c.text) && c.act === '更新到草稿纸', c);
T.ok('电脑上也认出原文件改过了，这本还没换', (await T.apiJson('/api/notebook?nb=' + encodeURIComponent(imp.id))).sourceChanged === true);
await T.tap('#verAct');
T.ok('点一下就更新了', await T.waitFor(`window.__ink.S.nb.sourceChanged === false && window.__ink.S.page`, 15000), await chip());
T.ok('平板上说了改了什么', /已更新：第 1 页有改动/.test(await toastText()), await toastText());
const info = await T.apiJson('/api/notebook?nb=' + encodeURIComponent(imp.id));
T.ok('电脑上记着已经是最新，还是 4 页、一本', info.sourceChanged === false && info.pages === 4 && (await books()).length === 1, [info.sourceChanged, info.pages]);
await T.openPage(0);
c = await chip();
T.ok('改过的第 1 页有橙框和「对比旧版」，笔迹还在', c.act === '对比旧版' && (await chgBoxes()).length >= 1 && (await T.evalJS(`window.__ink.S.page.strokes.map((s) => s.id).join()`)) === A, c);
T.ok('各页笔迹没动', JSON.stringify(idsOnDisk(4)) === JSON.stringify([A, E, B, D]), idsOnDisk(4));

// 7. 另存成新文件名的新版本（例会.pdf → 例会_v2.pdf）：导入时指定替换原来那本，本子跟着改名，笔迹还在，不多出一本
const V2 = 'book:例会_v2.pdf';
makePdf([['Intro: weekend trip planners, second draft', 60, 120], NEW, P2B, ['Summary and the next steps, revised', 60, 120]], join(SRC, '例会_v2.pdf'));
const up3 = await T.post('/bridge/import', { sid: 'S1', path: join(SRC, '例会_v2.pdf'), replace: '例会' });
T.ok('换了文件名的新版本：替换原来那本，本子跟着改名，还是只有一本', up3.ok && up3.id === V2 && up3.pages === 4 && JSON.stringify(await books()) === JSON.stringify([V2]), [up3, await books()]);
T.ok('平板上跟着换到改了名的这本', await T.waitFor(`window.__ink.S.nb.id === ${JSON.stringify(V2)} && window.__ink.S.page`) && (await T.text('#chipName')) === '例会_v2', await T.text('#chipName'));
T.ok('平板上说了从哪版换到哪版、改了哪页', /已换成新版（例会 → 例会_v2）：第 4 页有改动/.test(await toastText()), await toastText());
T.ok('笔迹都跟到改了名的这本上', JSON.stringify(idsOnDisk(4, dirOf('例会_v2.pdf'))) === JSON.stringify([A, E, B, D]), idsOnDisk(4, dirOf('例会_v2.pdf')));
const tab3 = await idsOnTablet(4);
T.ok('平板上各页的笔迹也都在', JSON.stringify(tab3) === JSON.stringify([A, E, B, D]), tab3);

// 8. 笔迹压在改动处（「请 Claude 看看」和收起、挪动旧笔迹都删了以后）：更新后它留在原页、不变淡，右上角直接是「对比旧版」
//    第 4 页的标题上划一道（压着标题），再把这页的标题整个换掉
const V2DIR = dirOf('例会_v2.pdf');
const waitDisk2 = async (want, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (JSON.stringify(idsOnDisk(want.length, V2DIR)) === JSON.stringify(want)) return true; await T.sleep(250); } return false; };
await T.openPage(3);
await T.pen(T.line(70, 108, 450));
const F = await T.evalJS(`window.__ink.S.page.strokes.at(-1).id`);
T.ok('第 4 页的标题上划了一道，存到电脑上', await waitDisk2([A, E, B, D + '+' + F]), idsOnDisk(4, V2DIR));
await T.sleep(1200);
makePdf([['Intro: weekend trip planners, second draft', 60, 120], NEW, P2B, ['Closing remarks and open questions', 60, 120]], join(SRC, '例会_v2.pdf'));
const up4 = await T.post('/bridge/import', { sid: 'S1', path: join(SRC, '例会_v2.pdf') });
T.ok('标题换掉后再导入：原地更新，第 4 页有改动', up4.ok && up4.id === V2 && up4.pages === 4 && /第 4 页有改动/.test(up4.updated), up4);
T.ok('平板上这本自己换成了新版', await T.waitFor(`!document.querySelector('#toast').hidden && /《例会_v2》已更新：第 4 页有改动/.test(document.querySelector('#toast').textContent) && window.__ink.S.page`),
  await toastText());
T.ok('压在改动处的那一笔留在原页（电脑上）', JSON.stringify(idsOnDisk(4, V2DIR)) === JSON.stringify([A, E, B, D + '+' + F]), idsOnDisk(4, V2DIR));
await T.openPage(3);
const fBox = await T.evalJS(`(() => { const s = window.__ink.S.page.strokes.find((x) => x.id === ${JSON.stringify(F)}); if (!s) return null;
  const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; })()`);
const b8 = await chgBoxes();
T.ok('平板上这一笔还在第 4 页，确实压在橙框（改动处）里', Boolean(fBox) && (await T.strokes()) === 2 && covers(b8, fBox), [fBox, b8]);
// 笔迹画布上，一笔经过的地方最浓的那一点有多不透明（0–255）：变淡的笔迹这个数小
const inkAlpha = (id) => T.evalJS(`(() => { const S = window.__ink.S, s = S.page.strokes.find((x) => x.id === ${JSON.stringify(id)}), v = S.view;
  const c = document.querySelector('#ink'), k = c.width / c.clientWidth, x = c.getContext('2d'); let best = 0;
  for (const p of s.pts) { const d = x.getImageData(Math.round((v.tx + p[0] * v.s) * k) - 2, Math.round((v.ty + p[1] * v.s) * k) - 2, 5, 5).data;
    for (let i = 3; i < d.length; i += 4) best = Math.max(best, d[i]); } return best; })()`);
const alpha = [await inkAlpha(F), await inkAlpha(D)];
T.ok('压在改动处的那一笔没变淡：和同一页上别的笔迹一样浓', alpha[0] >= 200 && Math.abs(alpha[0] - alpha[1]) <= 20, alpha);
c = await chip();
const plz = await T.evalJS(`document.body.textContent.includes('请 Claude 看看')`);
T.ok('右上角的提示条直接是「对比旧版」，没有「请 Claude 看看」', c.shown && /更新时改过/.test(c.text) && c.act === '对比旧版' && !plz, [c, plz]);
await T.tap('#verAct', 1500);
T.ok('点「对比旧版」能看旧版，那一笔照旧在', (await T.evalJS(`window.__ink.S.compare`)) === true && (await T.strokes()) === 2, await T.strokes());
await T.tap('#verAct', 1500);

await T.finish();

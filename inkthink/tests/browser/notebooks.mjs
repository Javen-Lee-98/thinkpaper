// 本子管理（都在左上角 ☰ 打开的抽屉里）：新建本子（名字、竖版 / 横版纸）；给自己的本子、导入的书改名（写的字跟着走）；
// 草稿本不能改名；删除本子（列表里没了，电脑上是挪开留着，不是真删）；在别的一本那一行直接改名、删除，当前本子不变；
// 长名字写成一行、左右滑着看全，同一系列的先滑到不一样的那段。
// 跑法：node tests/browser/notebooks.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

const V47 = '示例计划 暑假去云南大理丽江玉龙雪山的行程与预算安排表_家庭会议_v47_修改6';
const V48 = '示例计划 暑假去云南大理丽江玉龙雪山的行程与预算安排表_家庭会议_v48_按草稿纸批注';
const LONG = '读书随手记：小学数学里鸡兔同笼问题的几种解法与画图方法对比';

// 准备：两份名字只差版本号的 PDF，像 Claude 那样导入成两本书，再打开页面
const T = await boot({ name: 'notebooks', open: false });
const js = T.evalJS, SRC = join(T.ROOT, 'src'), NB = join(T.DATA, 'notebooks');
mkdirSync(SRC, { recursive: true });
for (const t of [V47, V48]) {
  execFileSync(PY, ['-c', `import fitz,sys
doc=fitz.open(); p=doc.new_page(width=960,height=540); p.insert_text((60,120),"slide",fontsize=28); doc.save(sys.argv[1])`, join(SRC, t + '.pdf')]);
  await T.post('/bridge/import', { sid: 'S1', path: join(SRC, t + '.pdf') });
}
await T.go();

// ---- 小工具
// 真的点一下：先滚到看得见，确认这个位置点得到它（没藏着、没被盖住）再点
async function tap(sel, wait = 600) {
  const hit = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return '页面上没有'; e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t && (t === e || e.contains(t)) ? '' : '藏着或被盖住了'; })()`);
  if (hit) throw new Error(`点不到 ${sel}：${hit}`);
  await T.tap(sel, wait);
}
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) await tap('#nbChip', 500); };
const names = () => js(`[...document.querySelectorAll('#nbList .nb-name')].map((e) => e.title)`);
const nameOf = (title) => `#nbList .nb-name[title=${JSON.stringify(title)}]`; // 抽屉里这本的名字
const rowOf = (title) => `#nbList .nb-item:has(.nb-name[title=${JSON.stringify(title)}])`; // 抽屉里这本的那一行
const cur = () => js(`({ id: window.__ink.S.nb.id, title: window.__ink.S.nb.title, paper: window.__ink.S.nb.paper, h: window.__ink.S.nb.sizes[0].h, baseH: window.__ink.S.baseH,
  chip: document.querySelector('#chipName').textContent, strokes: window.__ink.S.page.strokes.filter((s) => !s.erasedAt).map((s) => s.id) })`);
const nbIs = (id) => T.waitFor(`window.__ink.S.nb.id === ${JSON.stringify(id)} && window.__ink.S.page`);
// 浏览器自带的输入框 / 确认框换成自己的：记下问了什么、默认填的什么，照我们给的回答
const answer = (kind, val) => js(`window.__asked = []; window.${kind} = (m, d) => { window.__asked.push([m, d === undefined ? null : d]); return ${JSON.stringify(val)}; }; 1`);
const asked = () => js(`window.__asked`);
const pads = () => JSON.parse(readFileSync(join(NB, 'pads.json'), 'utf8'));
const bookDir = (name) => 'book-' + createHash('sha1').update(name).digest('hex').slice(0, 12); // 一本书的笔迹文件夹
const inkIn = (dir) => { const f = join(NB, dir, 'page-0000.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).strokes.filter((s) => !s.erasedAt).length : null; };
// 新建本子卡片：点名字那一格、打字、选纸、点「建立」
async function newNotebook(title, paper) {
  await drawer(true);
  await tap('#actNewNb');
  const fresh = await js(`[!document.querySelector('#newNb').hidden, document.querySelector('#newNbTitle').value, document.querySelector('#newNbPaper').value]`);
  await tap('#newNbTitle', 200);
  await T.cdp('Input.insertText', { text: title });
  if (paper) await js(`(() => { const s = document.querySelector('#newNbPaper'); s.value = ${JSON.stringify(paper)}; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
  await tap('#newNbOk');
  await T.waitFor(`document.querySelector('#newNb').hidden && window.__ink.S.nb.title === ${JSON.stringify(title)} && window.__ink.S.page`);
  await T.sleep(400);
  return fresh;
}
// 一行名字的样子：几行、放不下没有、滑到了哪、两头的渐隐、开头相同的那段还露着多宽
const lineOf = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
  const rg = document.createRange(); rg.selectNodeContents(e); const r = e.getBoundingClientRect();
  return { text: e.textContent, lines: new Set([...rg.getClientRects()].map((x) => Math.round(x.top))).size, over: e.scrollWidth > e.clientWidth + 2, left: Math.round(e.scrollLeft),
    atEnd: e.scrollLeft + e.clientWidth >= e.scrollWidth - 2, fl: e.classList.contains('fade-l'), fr: e.classList.contains('fade-r'),
    preShown: Math.round(e.firstChild.getBoundingClientRect().right - r.left), x0: r.left, x1: r.right, y: r.top + r.height / 2 }; })()`);
// 手指按在屏幕上横着拖一段再抬起（真的触摸事件）
async function swipe(fromX, toX, y) {
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y, id: 1 }] });
  for (let k = 1; k <= 12; k++) { await T.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fromX + ((toX - fromX) * k) / 12, y, id: 1 }] }); await T.sleep(16); }
  await T.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await T.sleep(500);
}

// 1. 左上角 ☰ 打开抽屉：草稿本和两本书都列着
await tap('#nbChip');
T.ok('点左上角 ☰ 打开抽屉，列着草稿本和导入的两本', (await T.visible('#drawer')) && JSON.stringify(await names()) === JSON.stringify(['草稿本', V47, V48]), await names());

// 2. 新建本子：名字 + 横版纸；再建一本竖版的（名字很长）
const fresh1 = await newNotebook('横着画的图', 'landscape');
T.ok('点「＋ 新建本子…」弹出卡片：名字空着、默认竖版纸', fresh1[0] === true && fresh1[1] === '' && fresh1[2] === 'portrait', fresh1);
const land = await cur();
T.ok('建好就打开：名字对、是自己的空白本子', land.id.startsWith('pad:') && land.title === '横着画的图' && land.chip === '横着画的图' && !(await T.visible('#newNb')), land);
T.ok('横版纸：纸比宽度矮（宽 1000、高约 707）', land.paper === 'landscape' && Math.abs(land.h - 707.2) < 1 && land.baseH === land.h, land);
const fresh2 = await newNotebook(LONG);
const port = await cur();
T.ok('再点新建：卡片回到空名字、竖版纸', fresh2[1] === '' && fresh2[2] === 'portrait', fresh2);
T.ok('竖版纸的本子：和草稿本一样高（1414）', port.id.startsWith('pad:') && port.id !== land.id && port.title === LONG && port.paper === 'portrait' && port.h === 1414, port);
T.ok('电脑上记下了这两本', pads().some((p) => 'pad:' + p.id === land.id && p.title === '横着画的图') && pads().some((p) => 'pad:' + p.id === port.id && p.title === LONG), pads());

// 3. 长名字：抽屉里写成一行、放不下的右端渐隐；手指往左滑看到末尾；同一系列的两本先滑到不一样的那段
await drawer(true);
await T.sleep(300);
const l0 = await lineOf(nameOf(LONG));
T.ok('长名字在抽屉里是全名、只占一行，放不下的右端渐隐', Boolean(l0) && l0.text === LONG && l0.lines === 1 && l0.over && l0.left === 0 && l0.fr && !l0.fl, l0);
await swipe(l0.x1 - 12, l0.x0 + 12, l0.y);
const l1 = await lineOf(nameOf(LONG));
T.ok('手指按着名字往左滑一下：名字跟着走，左端也渐隐', Boolean(l1) && l1.left > 40 && l1.fl, l1);
for (let k = 0; k < 3; k++) await swipe(l0.x1 - 12, l0.x0 + 12, l0.y);
const l2 = await lineOf(nameOf(LONG));
T.ok('再滑几下到末尾：右端不再渐隐', Boolean(l2) && l2.atEnd && l2.fl && !l2.fr, l2);
const l48 = await lineOf(nameOf(V48));
T.ok('同一系列的书：一行，一打开就滑到名字不一样的那段（开头相同的滑出去了，或后半段整个露出来）', Boolean(l48) && l48.text === V48 && l48.lines === 1 && l48.over && l48.left > 100 && l48.fl
  && (l48.preShown <= 14 || l48.atEnd), l48);
await swipe(l48.x0 + 12, l48.x1 - 12, l48.y);
const l48b = await lineOf(nameOf(V48));
T.ok('往右滑回去能看到开头', Boolean(l48b) && l48b.left < l48.left - 40, [l48.left, l48b && l48b.left]);
T.ok('滑名字不会打开别的本子、不收起抽屉', (await cur()).id === port.id && (await T.visible('#drawer')), (await cur()).id);
await T.shot('3-long-names.png');
// 退出全屏后顶栏上的本子名也一样；看完回到全屏
await drawer(false);
await tap('#toolsBars');
const b0 = await lineOf('#nbTitle');
if (b0) await swipe(b0.x1 - 12, b0.x0 + 12, b0.y);
const b1 = await lineOf('#nbTitle');
T.ok('退出全屏后顶栏上的长名字也是全名一行，能往左滑着看', (await T.visible('#bar')) && Boolean(b0) && b0.text === LONG && b0.lines === 1 && b0.over && b1.left > 40 && b1.fl && !(await T.visible('#drawer')), [b0, b1]);
T.ok('刚退出全屏时，顶栏上放不下的长名字右端也有渐隐', Boolean(b0) && b0.fr, b0);
await tap('#fsBtn');
if (!(await T.visible('#nbChip')) || (await T.visible('#bar'))) throw new Error('点「全屏」没回到只有纸的样子');
// 同一系列的书：全屏时打开它，退出全屏后顶栏上的名字也先滑到不一样的那段；看完回到全屏、回到那本长名字的本子
await drawer(true);
await tap(rowOf(V48) + ' .nb-name');
await nbIs(`book:${V48}.pdf`);
await drawer(false);
await tap('#toolsBars');
const b48 = await lineOf('#nbTitle');
T.ok('同一系列的书：全屏时打开，退出全屏后顶栏上的名字滑到了不一样的那段', (await T.visible('#bar')) && Boolean(b48) && b48.text === V48 && b48.lines === 1 && b48.over
  && b48.left > 100 && b48.fl && (b48.preShown <= 14 || b48.atEnd), b48);
await tap('#fsBtn');
if (!(await T.visible('#nbChip')) || (await T.visible('#bar'))) throw new Error('点「全屏」没回到只有纸的样子');
await drawer(true);
await tap(rowOf(LONG) + ' .nb-name');
await nbIs(port.id);
await drawer(true);

// 4. 给自己的本子改名（当前这本那一行的铅笔）
await answer('prompt', '周三例会想法');
await tap('#actRename');
await T.waitFor(`document.querySelector('#chipName').textContent === '周三例会想法'`);
const a4 = await asked(), r4 = await cur();
T.ok('问「改成什么名字」，默认填着现在的名字', a4.length === 1 && /改成什么名字/.test(a4[0][0]) && a4[0][1] === LONG, a4);
T.ok('自己的本子改了名：还是这一本，左上角和列表里都是新名字', r4.id === port.id && r4.title === '周三例会想法' && r4.chip === '周三例会想法'
  && (await names()).includes('周三例会想法') && !(await names()).includes(LONG), [r4, await names()]);
T.ok('电脑上的名字也改了', pads().find((p) => 'pad:' + p.id === port.id).title === '周三例会想法', pads());

// 5. 给导入的书改名：先在上面写一笔，改名后 PDF 文件、笔迹、原文件记录都跟着走
await tap(rowOf(V47) + ' .nb-name');
await nbIs(`book:${V47}.pdf`);
await drawer(false);
await T.pen(T.line(200, 300, 250));
const ink5 = (await cur()).strokes;
await drawer(true);
await answer('prompt', '例会 v47 定稿');
await tap('#actRename');
await nbIs('book:例会 v47 定稿.pdf');
await T.sleep(500);
const r5 = await cur(), src5 = JSON.parse(readFileSync(join(T.BOOKS, '_sources.json'), 'utf8'));
T.ok('导入的书改了名：本子换成新名字，刚写的那一笔还在纸上', ink5.length === 1 && r5.id === 'book:例会 v47 定稿.pdf' && r5.chip === '例会 v47 定稿' && JSON.stringify(r5.strokes) === JSON.stringify(ink5), [ink5, r5]);
T.ok('电脑上 PDF 跟着改名，旧名字的没了', existsSync(join(T.BOOKS, '例会 v47 定稿.pdf')) && !existsSync(join(T.BOOKS, V47 + '.pdf')), readdirSync(T.BOOKS));
T.ok('电脑上的笔迹文件跟到新名字的文件夹里，旧文件夹没留下', inkIn(bookDir('例会 v47 定稿.pdf')) === 1 && !existsSync(join(NB, bookDir(V47 + '.pdf'))), [inkIn(bookDir('例会 v47 定稿.pdf')), readdirSync(NB)]);
T.ok('原文件的记录也跟着走（还指着电脑上那份原文件）', Boolean(src5['例会 v47 定稿.pdf']) && src5['例会 v47 定稿.pdf'].src.endsWith(V47 + '.pdf') && !src5[V47 + '.pdf'], Object.keys(src5));

// 6. 草稿本不能改名、不能删
await tap(rowOf('草稿本') + ' .nb-name');
await nbIs('scratch');
T.ok('草稿本那一行没有改名和删除', (await T.count('#nbList .nb-item.cur')) === 1 && !(await T.visible('#actRename')) && !(await T.visible('#actDelete')),
  await js(`[...document.querySelectorAll('#nbList .nb-item.cur .nb-acts button')].map((b) => [b.dataset.icon, b.hidden])`));
const no6 = await T.api('/api/notebook/rename', { method: 'POST', body: JSON.stringify({ nb: 'scratch', title: '改不了' }) });
T.ok('直接让服务改草稿本的名字也不行', no6.status === 400 && (await T.apiJson('/api/notebooks'))[0].title === '草稿本', no6.status);

// 7. 在别的一本那一行直接改名、删除；当前本子（草稿本）不变
await answer('prompt', '例会 v48');
await tap(rowOf(V48) + ' .nb-acts [data-icon=edit]');
await T.waitFor(`Boolean(document.querySelector(${JSON.stringify(rowOf('例会 v48'))}))`);
T.ok('在别的一本那一行改名：列表里换成新名字，当前还是草稿本', (await names()).includes('例会 v48') && !(await names()).includes(V48) && (await cur()).id === 'scratch'
  && existsSync(join(T.BOOKS, '例会 v48.pdf')) && !existsSync(join(T.BOOKS, V48 + '.pdf')), [await names(), (await cur()).id]);
const trashLabel = await js(`document.querySelector(${JSON.stringify(rowOf('例会 v48') + ' .nb-acts [data-icon=trash]')}).getAttribute('aria-label')`);
T.ok('删除按钮的说明（长按看）说的是文件留在电脑上，不说「可以找回」', trashLabel === '删除这本（文件还留在电脑上）', trashLabel);
await answer('confirm', false);
await tap(rowOf('例会 v48') + ' .nb-acts [data-icon=trash]');
const a7 = await asked();
T.ok('删除前问一句：说了是哪本、PDF 和手写都还留在电脑上、要找回让 Claude 挪回来；点取消就不删', a7.length === 1
  && a7[0][0] === '从列表里删除《例会 v48》？\nPDF 和上面的手写都还留在电脑上，要找回就让 Claude 帮你挪回来。'
  && (await names()).includes('例会 v48') && existsSync(join(T.BOOKS, '例会 v48.pdf')), a7);
await answer('confirm', true);
await tap(rowOf('例会 v48') + ' .nb-acts [data-icon=trash]');
await T.waitFor(`!document.querySelector(${JSON.stringify(rowOf('例会 v48'))})`);
const toast7 = await js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
T.ok('删完的提示也说文件还留在电脑上、要找回让 Claude 挪回来', toast7 === '已删除「例会 v48」。文件还留在电脑上，要找回就让 Claude 帮你挪回来。', toast7);
const list7 = (await T.apiJson('/api/notebooks')).map((n) => n.title);
T.ok('在别的一本那一行删除：列表里真的没了，当前还是草稿本', !(await names()).includes('例会 v48') && !list7.includes('例会 v48') && (await cur()).id === 'scratch', [await names(), list7]);
const trash7 = existsSync(join(T.BOOKS, '_已删除')) ? readdirSync(join(T.BOOKS, '_已删除')) : [];
T.ok('电脑上没真删：PDF 挪到 books/_已删除，笔迹文件夹改成 _deleted 开头', !existsSync(join(T.BOOKS, '例会 v48.pdf')) && trash7.length === 1 && /^例会 v48\.\d{8}-\d{6}\.pdf$/.test(trash7[0])
  && readdirSync(NB).some((d) => d.startsWith('_deleted-') && d.endsWith(bookDir('例会 v48.pdf'))), [trash7, readdirSync(NB)]);

// 8. 删除正开着的本子（上面写过字）：回到草稿本；电脑上挪到 _deleted 开头的文件夹，字还在
await tap(rowOf('周三例会想法') + ' .nb-name');
await nbIs(port.id);
await drawer(false);
await T.pen(T.line(150, 300, 300));
T.ok('在要删的本子上写了一笔并存上', (await T.strokes()) === 1 && (await T.saved()) && inkIn('pad-' + port.id.slice(4)) === 1, inkIn('pad-' + port.id.slice(4)));
await drawer(true);
await answer('confirm', true);
await tap('#actDelete');
await nbIs('scratch');
await T.sleep(500);
const a8 = await asked();
T.ok('删自己的本子前也问一句：手写还留在电脑上、要找回让 Claude 挪回来', a8.length === 1
  && a8[0][0] === '从列表里删除「周三例会想法」？\n上面的手写还留在电脑上，要找回就让 Claude 帮你挪回来。', a8);
T.ok('删除正开着的本子：回到草稿本，列表里没了', (await cur()).id === 'scratch' && !(await names()).includes('周三例会想法') && (await names()).includes('横着画的图')
  && !pads().some((p) => 'pad:' + p.id === port.id), [await names(), pads()]);
const gone8 = readdirSync(NB).find((d) => d.startsWith('_deleted-') && d.endsWith('pad-' + port.id.slice(4)));
T.ok('电脑上是挪到 _deleted 开头的文件夹，写的那一笔还在里面', Boolean(gone8) && !existsSync(join(NB, 'pad-' + port.id.slice(4))) && inkIn(gone8) === 1, [gone8, gone8 && inkIn(gone8)]);

await T.finish();

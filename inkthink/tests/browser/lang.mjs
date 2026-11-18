// 语言切换：选了英文，页面和电脑上的二维码页看得见的文字都是英文（你写的、本子名、Claude 的回答不算）；
// 抽屉最下面能切换；中文时一个字都不换。
// 跑法：node tests/browser/lang.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'lang', pages: 3,
  sessions: [{ sid: 'S1', label: 'idea' }, { sid: 'S2', label: 'MY_PAPER', cwd: 'E:\\x\\MY_PAPER' }] });
const js = T.evalJS;
const CJK = /[\u3400-\u9fff]/;
// 页面上还剩的中文：文字和 title / aria-label / placeholder。all 为 true 连没显示出来的也算。
// 不算：语言切换那一行、Claude 写的（#aiRoot、#tex）、脚本和样式。
const leftover = (all) => js(`(() => {
  const CJK = /[\\u3400-\\u9fff]/, out = new Set();
  const shown = (e) => { for (let n = e; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || n.hidden) return false; } return e.getClientRects().length > 0 || e === document.body; };
  const skip = (e) => Boolean(e.closest('#langRow, #aiRoot, #tex, script, style, [data-lang-keep]'));
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const el = n.nodeType === 1 ? n : n.parentElement;
    if (!el || skip(el) || (!${all ? 'true' : 'false'} && !shown(el))) continue;
    if (n.nodeType === 3) { if (CJK.test(n.nodeValue)) out.add(n.nodeValue.trim().slice(0, 60)); continue; }
    for (const a of ['title', 'aria-label', 'placeholder']) { const v = n.getAttribute(a); if (v && CJK.test(v)) out.add(a + '=' + v.slice(0, 60)); }
  }
  return [...out];
})()`);

// 0. 中文：一个字都不换，抽屉最下面有切换
T.ok('中文：按钮写「AI」', (await T.text('#check')) === 'AI' && (await js(`window.InkLang.lang`)) === 'zh', await T.text('#check'));
T.ok('中文：页面语言没改', (await js(`document.documentElement.lang`)) === 'zh-CN');
// 阶段 E：同一个工具在左侧工具栏和右下角那一条上的长按说明一字不差，对用户说「你」（界面上别处都说「你」）；全屏按钮的说明不点名哪个浏览器
const toolSaid = await js(`['pen', 'red', 'eraser', 'lasso'].map((t) => ['#rail', '#tools'].map((p) => document.querySelector(p + ' [data-tool=' + t + ']').getAttribute('aria-label')))`);
T.ok('中文：黑笔、红笔、橡皮、套索在两处的长按说明一样，不说「我」', toolSaid.every(([a, b]) => a === b && a.includes('：')) && !toolSaid.flat().some((s) => s.includes('我'))
  && toolSaid[0][0] === '黑笔：你自己的推导和草稿', toolSaid);
const fsSaid = await js(`document.querySelector('#fsBtn').title`);
T.ok('中文：全屏按钮的说明不点名哪个浏览器', fsSaid.startsWith('全屏：') && !/Safari|Chrome|Edge|Firefox/i.test(fsSaid), fsSaid);
await T.tap('#nbChip');
T.ok('抽屉最下面有语言切换，中文那个选中', (await T.visible('#langRow')) && (await js(`document.querySelector('#langRow button.on').dataset.lang`)) === 'zh'
  && (await js(`document.querySelector('#drawer').lastElementChild.id`)) === 'langRow');
await T.shot('0-zh-drawer.png');

// 1. 点 English：页面重新打开，变成英文，并记住
await T.tap('#langRow [data-lang=en]', 800);
await T.ready();
T.ok('点了 English：记住了，地址也带上', (await js(`localStorage.getItem('ink.lang') + '|' + new URLSearchParams(location.search).get('lang')`)) === 'en|en');
T.ok('英文：按钮也是 AI，页面语言是 en', (await T.text('#check')) === 'AI' && (await T.text('#barCheck')) === 'AI' && (await js(`document.documentElement.lang`)) === 'en', await T.text('#check'));
T.ok('英文：标题没有中文', !CJK.test(await js(`document.title`)), await js(`document.title`));
T.ok('英文：默认的本子名也换了', (await T.text('#chipName')) === 'Scratchpad', await T.text('#chipName'));
let left = await leftover(true);
T.ok('英文：页面里固定的文字（连没显示的）都换了', left.length === 0, left);
await T.shot('1-en-page.png');

// 1b. 左上角和顶栏上的「单页 / 连续」一对图标、加页图标：没有字，说明（长按看）是英文；点「单页」「连续」图标切换，两处跟着变；
//     长按出的说明也是英文；翻页按钮的说明也是英文
const iconLbl = (sel) => js(`(() => { const b = document.querySelector('${sel}'); return b ? (b.querySelector('svg') ? 'svg' : 'no svg') + '|' + b.textContent.trim() + '|' + b.getAttribute('aria-label') : ''; })()`);
const onOf = (sel) => js(`[...document.querySelectorAll('${sel} button.on')].map((b) => b.dataset.v).join(',')`);
const enSingle = 'svg||Single page: one page at a time', enCont = 'svg||Continuous: pages joined top to bottom', enAdd = 'svg||Add a blank page after this one';
const lbls = async (ids) => { const out = []; for (const q of ids) out.push(await iconLbl(q)); return out; };
let got = await lbls(['#chipSingle', '#chipCont', '#barSingle', '#barCont']);
T.ok('英文：左上角和顶栏上的「单页」「连续」是没有字的图标，说明是英文', JSON.stringify(got) === JSON.stringify([enSingle, enCont, enSingle, enCont]), got);
T.ok('英文：左上角翻页按钮的说明', (await js(`['#chipPrev', '#chipNext'].map((q) => document.querySelector(q).getAttribute('aria-label')).join('|')`)) === 'Previous page|Next page'
  && (await T.visible('#chipPrev')));
await T.tap('#chipSingle', 800);
T.ok('英文：点「单页」图标变成单页，左上角和顶栏上都是「单页」选中', (await js(`window.__ink.S.flow`)) === false && (await onOf('#chipPair')) === 'single' && (await onOf('#barPair')) === 'single',
  [await onOf('#chipPair'), await onOf('#barPair')]);
await T.tap('#chipCont', 800);
T.ok('英文：点「连续」图标改回连续', (await js(`window.__ink.S.flow`)) === true && (await onOf('#chipPair')) === 'flow' && (await onOf('#barPair')) === 'flow',
  [await onOf('#chipPair'), await onOf('#barPair')]);
// 长按「单页」图标：提示条上是英文的说明，松手不切换
await T.sleep(2300); // 等切换的提示过去
await js(`document.querySelector('#toast').hidden = true`);
const lp = await T.centerOf('#chipSingle');
let lpSaid = '（没有这个按钮）';
if (lp) {
  await T.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: lp[0], y: lp[1], button: 'left', buttons: 1, clickCount: 1 });
  await T.sleep(800);
  lpSaid = (await T.visible('#toast')) ? await T.text('#toast') : '';
  await T.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: lp[0], y: lp[1], button: 'left', buttons: 0, clickCount: 1 });
  await T.sleep(500);
}
T.ok('英文：长按「单页」图标出英文说明，松手不切换', lpSaid === 'Single page: one page at a time' && (await js(`window.__ink.S.flow`)) === true, [lpSaid, await js(`window.__ink.S.flow`)]);
// 左上角和顶栏上的加页图标：没有字，说明是英文
got = await lbls(['#chipAdd', '#barAdd']);
T.ok('英文：左上角和顶栏上的加页图标没有字，说明是英文', (await T.visible('#chipAdd')) && JSON.stringify(got) === JSON.stringify([enAdd, enAdd]), got);

// 2. 抽屉、选对话
await T.tap('#nbChip');
T.ok('英文：抽屉里「这本发往」', (await T.visible('#actTarget')) && (await T.text('#actTarget')).startsWith('Sends to:'), await T.text('#actTarget'));
T.ok('英文：页数', /^\(3 pages\)$/.test((await T.text('#thumbCount')).trim()), await T.text('#thumbCount'));
left = await leftover(false);
T.ok('英文：抽屉里看得见的都是英文', (await T.visible('#drawer')) && left.length === 0, left);
await T.shot('2-en-drawer.png');
await T.tap('#actTarget');
left = await leftover(false);
T.ok('英文：选对话的面板', (await T.visible('#targetPick')) && left.length === 0 && (await T.text('#targetPickList')).includes('MY_PAPER'), [left, await T.text('#targetPickList')]);
const pickEn = await js(`[...document.querySelectorAll('#targetPickList .tp-l1, #targetPickList .tp-l2')].map((e) => e.textContent)`);
T.ok('英文：每个对话下面的小字、还没打过字、只在本地那一项都是英文', pickEn.includes('Nothing typed there yet') && pickEn.includes('Do not send to Claude (local only)')
  && pickEn.some((s) => /^active (just now|\d+ min ago)$/.test(s)), pickEn);
await T.tap('#targetPickList button[data-sid="S2"]');
await T.sleep(500);
T.ok('英文：选了以后那一行跟着变', (await T.text('#actTarget')).includes('MY_PAPER') && (await T.text('#actTarget')).startsWith('Sends to:'), await T.text('#actTarget'));
// 只在本地：那一行、名字后面的小字、按钮都是英文；再选回 MY_PAPER
await T.tap('#actTarget');
await T.tap('#tpLocal', 800);
T.ok('英文：选了只在本地，那一行是 Local only (not sent to Claude)', (await T.text('#actTarget')) === 'Sends to: Local only (not sent to Claude) ▾'
  && (await T.text('#nbList .nb-local')) === 'Local only' && (await T.text('#check')) === 'Local only', [await T.text('#actTarget'), await T.text('#nbList .nb-local')]);
left = await leftover(false);
T.ok('英文：只在本地时抽屉里看得见的都是英文', left.length === 0, left);
await T.tap('#actTarget');
await T.tap('#targetPickList button[data-sid="S2"]', 800);
T.ok('英文：再选回 MY_PAPER', (await js(`window.__ink.S.nb.local`)) === false && (await T.text('#actTarget')).includes('MY_PAPER'), await T.text('#actTarget'));

// 3. 新建本子、导入的面板
await T.tap('#actNewNb');
left = await leftover(false);
T.ok('英文：新建本子的面板', (await T.visible('#newNb')) && left.length === 0, left);
await T.tap('#newNbCancel');
if (!(await T.visible('#drawer'))) await T.tap('#nbChip'); // 开过面板以后抽屉已经收起
await T.tap('#actUpload', 1100);
left = await leftover(false);
T.ok('英文：导入的面板', (await T.visible('#importSheet')) && left.length === 0, left);
await T.shot('3-en-import.png');
await T.tap('#isClose');
if (await T.visible('#drawer')) await T.tap('#nbChip');
T.ok('抽屉收起了，回到纸上', !(await T.visible('#drawer')) && !(await T.visible('#importSheet')));

// 3b. 阶段 E：缩略图上页码后面的「空白」「隐藏页」（以前写死在 style.css 的 content 里）英文界面下是英文；
//     抽屉「新文件」一组里「来自」后面的对话名，英文界面不带中文的「」
{
  const SRC = join(T.ROOT, 'src');
  mkdirSync(SRC, { recursive: true });
  execFileSync(PY, ['-c', `import pymupdf as fitz,sys,os
doc=fitz.open()
for t in ('Saturday','Sunday'):
    p=doc.new_page(width=595,height=842); p.insert_text((72,100),t,fontsize=20)
doc.save(os.path.join(sys.argv[1],'weekend.pdf'))
pix=fitz.Pixmap(fitz.csRGB, fitz.IRect(0,0,60,40), 0); pix.save(os.path.join(sys.argv[1],'shopping.png'))`, SRC]);
  const imp = await T.post('/bridge/import', { sid: 'S1', path: join(SRC, 'weekend.pdf') });
  // 第 2 页当作 PPT 的隐藏页（和导入 PPT 时记下的一样，写在这本的 doc.json 里），第 1 页后面插一张空白页
  writeFileSync(join(T.DATA, 'notebooks', 'book-' + createHash('sha1').update(imp.id.slice(5)).digest('hex').slice(0, 12), 'doc.json'), JSON.stringify({ converter: 2, hidden: [1] }));
  await T.api('/api/page/insert', { method: 'POST', body: JSON.stringify({ nb: imp.id, after: 0, orient: 'portrait' }) });
  await T.post('/bridge/offer', { sid: 'S1', files: [{ path: join(SRC, 'shopping.png') }] });
  await T.openNotebook(imp.id, 0);
  await js('window.__ink.loadOffers(false)');
  await T.sleep(400);
  await T.tap('#nbChip');
  await T.sleep(600);
  const tags = await js(`[...document.querySelectorAll('#thumbs .th > span')].map((s) => [s.textContent, getComputedStyle(s, '::after').content])`);
  T.ok('英文：缩略图上「空白」「隐藏页」是英文（写在页面里，不靠 CSS 的 content）', JSON.stringify(tags.map((x) => x[0])) === JSON.stringify(['1', '2 blank', '3 hidden slide'])
    && tags.every((x) => x[1] === 'none' || x[1] === 'normal'), tags);
  const from = await js(`[...document.querySelectorAll('#offerList .of-meta')].map((m) => m.textContent)`);
  T.ok('英文：新文件那一行写「From “idea”」，不带中文的「」', from.length === 1 && from[0].startsWith('From“idea”') && !/[「」]/.test(from[0]), from);
  left = await leftover(false);
  T.ok('英文：这时抽屉里看得见的都是英文（文件名、对话名不算）', left.length === 0, left);
  await T.api('/api/offer-dismiss', { method: 'POST', body: JSON.stringify({ all: true }) });
  await T.tap('#nbChip');
  await T.openNotebook('scratch', 0);
}

// 4. 没写字点「AI」、没东西可撤销；写一笔再点「AI」
await T.tap('#check');
T.ok('英文：空页的提示', (await T.text('#toast')) === 'Nothing written on this page yet', await T.text('#toast'));
await T.tap('#toolsUndo');
T.ok('英文：没有可撤销的', (await T.text('#toast')) === 'Nothing to undo', await T.text('#toast'));
await T.pen(T.line(120, 260, 300));
await T.sleep(1100);
await T.tap('#check');
const sub = await T.waitSub('S2');
T.ok('英文：交上去了，提示是英文', Boolean(sub) && /^Handed to “MY_PAPER”$/.test(await T.text('#toast')), await T.text('#toast'));
T.ok('英文：「AI」按钮上的进度是 Sent', (await T.text('#check')) === 'Sent', await T.text('#check'));
T.ok('交给 Claude 的消息不受页面语言影响', Boolean(sub) && sub.text.startsWith('【草稿纸】'), sub && sub.text.slice(0, 30));
T.ok('纸上不出现发出去的提示（进度只写在按钮上）', (await T.count('#aiRoot .ai-temp')) === 0 && (await js(`document.querySelector('#aiRoot').textContent`)) === '',
  await js(`document.querySelector('#aiRoot').textContent`));
await T.sleep(600);
left = await leftover(false);
T.ok('英文：交上去以后看得见的都是英文', left.length === 0, left);

// 5. Claude 回了一条批注：写的字不翻。纸上有一条修改建议，用笔点它旁边的 ✓：提示是英文
//    （建议是直接放进页面数据的：空白纸上真回一条 suggest 会被画成普通批注，不出 ✓ ×）
if (sub) await T.post('/bridge/reply', { sid: 'S2', submission: sub.id, items: [{ type: 'note', anchor: 'g1', text: '这一步符号反了' }] });
await T.waitFor(`document.querySelector('#aiRoot').textContent.includes('这一步符号反了')`);
await js(`(() => { const S = window.__ink.S;
  S.page.ai.push({ id: 'sx', type: 'suggest', t: Date.now(), text: '改为：平均速度', box: [120, 250, 420, 270], paths: [],
    lay: { x: 1044, y: 250, w: 336, h: 37, lines: ['改为：平均速度'], fs: 21, lh: 29 }, hit: [1038, 246, 1380, 291] });
  window.__ink.renderAI(); })()`);
const vb = await js(`(() => { const c = document.querySelector('#aiRoot .vbtn.yes circle'); return c ? [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))] : null; })()`);
if (vb) await T.pen([[vb[0], vb[1]], [vb[0] + 2, vb[1] + 1]]);
T.ok('英文：采纳的提示（说的是下次点 AI）', Boolean(vb) && (await T.text('#toast')) === 'Adopted (goes to Claude the next time you tap AI; Undo takes it back)', [vb, await T.text('#toast')]);
T.ok('Claude 写的字原样留着', (await js(`document.querySelector('#aiRoot').textContent`)).includes('这一步符号反了'), (await js(`document.querySelector('#aiRoot').textContent`)).slice(0, 80));
T.ok('英文：写回了，按钮上是 Reading', (await T.text('#check')) === 'Reading', await T.text('#check'));
await T.shot('5-en-reply.png');
// 这一轮结束（插件在对话这一轮做完时报）：按钮变回 AI；不然后面重新打开页面时，按钮会接着显示这一轮
if (sub) await T.post('/bridge/progress', { sid: 'S2', id: sub.id, stage: 'done' });
T.ok('英文：这一轮结束，按钮变回 AI', await T.waitFor(`document.querySelector('#check').textContent === 'AI'`), await T.text('#check'));

// 5b. 你起的本子名不换，哪怕和界面上的词一样；一段话里只认识一半的也不换
await T.tap('#nbChip');
await T.tap('#actNewNb');
await T.tap('#newNbTitle', 200);
await T.cdp('Input.insertText', { text: '连续' });
await T.tap('#newNbOk', 1500);
T.ok('自己起的本子名「连续」不被换成 Continuous', (await T.text('#chipName')) === '连续' && (await js(`window.__ink.S.nb.kind`)) !== 'scratch', await T.text('#chipName'));
const half = await js(`['买菜 · 下一步', '连续 · 番茄炒蛋', '连续 · 撤销', '检查'].map((s) => window.InkLang.t(s))`);
T.ok('只认识一半的话不换，两半都认识的才换；「检查」不再是界面上的词，不换', half[0] === '买菜 · 下一步' && half[1] === '连续 · 番茄炒蛋' && half[2] === 'Continuous · Undo'
  && half[3] === '检查', half);
const folderSaid = await js(`['删除文件夹「课题」？\\n里面的 3 本回到外面，本子本身不动。', '已放进「课题」', '已删除文件夹「课题」', '已建立文件夹「课题」', '1 本',
  '今天 09:05 开的 · 2 分钟前活跃 · 执行过 /ink', '这本发往：idea（昨天 21:30 开的） ▾'].map((s) => window.InkLang.t(s))`);
T.ok('英文：文件夹和「这本发往」列表里的几句', JSON.stringify(folderSaid) === JSON.stringify(['Delete the folder “课题”?\nIts 3 notebooks move back out; the notebooks themselves are untouched.',
  'Moved into “课题”', 'Deleted the folder “课题”', 'Created the folder “课题”', '1 notebook', 'opened today 09:05 · active 2 min ago · ran /ink',
  'Sends to: idea (opened yesterday 21:30) ▾']), folderSaid);
// 拖本子进文件夹、拖缩略图换页序之后的提示和出错（2026-11-16）
const dragSaid = await js(`['已放回「课题」', '已放回文件夹外面', '第 1 页挪到了第 3 页', '已挪回第 1 页', '有字还没存上，等存好了再挪页',
  '没挪成：页的先后在别处改过了：重新打开这本再挪', '没挪回去：已经换了本子'].map((s) => window.InkLang.t(s))`);
T.ok('英文：拖进文件夹、拖缩略图换页序的提示', JSON.stringify(dragSaid) === JSON.stringify(['Moved back into “课题”', 'Moved back out of the folder', 'Moved page 1 to page 3',
  'Moved it back to page 1', 'Some ink is not saved yet. Move the page once it is saved',
  'Could not move the page: The page order was changed elsewhere: reopen this notebook and try again', 'Could not move the page back: You have switched to another notebook']), dragSaid);
const clearSaid = await js(`window.InkLang.t('已清除本页 Claude 批注（点撤销能找回）')`); // 清除本页 Claude 批注之后的提示（2026-11-16 起能撤销）
T.ok('英文：清除本页批注之后的提示', clearSaid === "Cleared Claude's annotations on this page (Undo brings them back)", clearSaid);

// 5c. 抽屉里的文件夹：新建按钮、起名字的卡片、文件夹那一行、本子旁边的文件夹图标和点开的小列表
//     （你起的名字——本子「连续」、文件夹「课题」——不翻译，单独露出来或夹在英文提示里都不算漏翻）
const mine = (xs) => xs.filter((s) => !['连续', '课题'].includes(s) && !/“(连续|课题)”/.test(s));
if (!(await T.visible('#drawer'))) await T.tap('#nbChip');
await T.tap('#actNewFolder', 600);
left = mine(await leftover(false));
T.ok('英文：起名字的卡片', (await T.visible('#nameAsk')) && (await T.text('#nameAskTitle')) === 'New folder' && left.length === 0, left);
await T.tap('#nameAskInput', 200);
await T.cdp('Input.insertText', { text: '课题' });
await T.tap('#nameAskOk', 1000);
if (!(await T.visible('#drawer'))) await T.tap('#nbChip');
T.ok('英文：文件夹那一行写着几本，文件夹名（你起的）不翻译', (await T.text('#nbList .nf-name')) === '课题' && (await T.text('#nbList .nf-count')) === '0 notebooks',
  [await T.text('#nbList .nf-name'), await T.text('#nbList .nf-count')]);
const OWN_MORE = '#nbList .nb-item:not([data-nb="scratch"]) .nb-more'; // 草稿本（2026-11-18 起也有「⋯」，只有「复制这本…」）下面那本
const fbtn = await js(`(() => { const b = document.querySelector(${JSON.stringify(OWN_MORE)}); return b ? b.getAttribute('aria-label') : ''; })()`);
T.ok('英文：本子右边的「⋯」，说明是英文', fbtn === 'More actions', fbtn);
await T.tap(OWN_MORE, 400);
left = mine(await leftover(false));
const menuEn = await js(`[...document.querySelectorAll('#nbMenu button')].map((b) => b.textContent)`);
T.ok('英文：「⋯」点开的菜单', (await T.visible('#nbMenu')) && left.length === 0
  && JSON.stringify(menuEn) === JSON.stringify(['Move to a folder…', 'Move up', 'Move down', 'Rename…', 'Copy this notebook…', 'Delete this notebook…']), [left, menuEn]);
await T.tap('#nbMenu [data-act=folder]', 500);
left = mine(await leftover(false));
T.ok('英文：点开的小列表', (await T.visible('#folderPick')) && left.length === 0 && (await T.text('#folderPickList')).includes('课题'), [left, await T.text('#folderPickList')]);
await T.tap('#folderPickList [data-fid]', 800);
if (!(await T.visible('#drawer'))) await T.tap('#nbChip');
T.ok('英文：放进去以后写着 1 notebook', (await T.text('#nbList .nf-count')) === '1 notebook', await T.text('#nbList .nf-count'));
left = mine(await leftover(false));
T.ok('英文：有文件夹时抽屉里看得见的都是英文', left.length === 0, left);
await T.tap('#nbChip');
// 导入、删除本子的提示（2026-11-13 改过说法）都有英文
const said = await js(`['正在导入 a.pdf…', '正在导入 talk.pptx…（要先转换，稍等）', '正在打开 a.pdf…',
  '从列表里删除「ideas」？\\n上面的手写还留在电脑上，要找回就让 Claude 帮你挪回来。',
  '从列表里删除《Meeting》？\\n文件和上面的手写都还留在电脑上，要找回就让 Claude 帮你挪回来。',
  '已删除「ideas」。文件还留在电脑上，要找回就让 Claude 帮你挪回来。', '删除这本（文件还留在电脑上）'].map((s) => window.InkLang.t(s))`);
T.ok('英文：导入、删除本子的提示', JSON.stringify(said) === JSON.stringify(['Importing a.pdf…', 'Importing talk.pptx… (converting it first; this takes a moment)', 'Opening a.pdf…',
  'Remove “ideas” from the list?\nThe handwriting stays on the computer. To get it back, ask Claude to move it back.',
  'Remove “Meeting” from the list?\nThe file and the handwriting stay on the computer. To get them back, ask Claude to move them back.',
  'Deleted “ideas”. The files stay on the computer. To get them back, ask Claude to move them back.', 'Delete this notebook (the files stay on the computer)']), said);
// 阶段 E 补进对照表的：存回 PDF 那几句、文档换了新版的提示、Zotero 的出错提示和文献类型、能导入哪几种
const said2 = await js(`['正在存回 周末安排.pdf…',
  '已存回 周末安排.pdf：手写 3 组、Claude 批注 2 条（页边和加长纸上的 1 组、Claude 指着页面外的 1 条没法写进 PDF）。第 2、4 页还有 Claude 的 3 条回复没落到纸上，没写进去：翻到那几页后再存一次',
  '已存回 a.pdf：手写 1 组', '《周末安排》已更新：第 2、3 页有改动；新增第 5 页；删掉了旧版第 4 页（上面的手写另存了）', '已换成新版（v47 → v48）：内容没有变化',
  'Zotero 没开本机接口：设置 → 高级 → 勾选「允许此计算机上的其他应用程序与 Zotero 通信」', '没导入成：连不上 Zotero：先在电脑上打开 Zotero', 'Zotero 返回了错误（500）',
  'Zotero 里没有这一项', 'Zotero 条目编号不对', '没导入成：Zotero 里这篇的 PDF 文件找不到了', 'Smith · 2020 · 期刊文章 · 没有 PDF',
  '没导入成：可以导入 PDF、PPT、Word、EPUB、图片、Markdown 和纯文本', '这里没有能导入的文件（PDF、PPT、Word、EPUB、图片、Markdown 和纯文本）。'].map((s) => window.InkLang.t(s))`);
T.ok('英文：存回 PDF、文档换了新版、Zotero 出错、能导入哪几种的提示', JSON.stringify(said2) === JSON.stringify(['Saving back to 周末安排.pdf…',
  "Saved back to 周末安排.pdf: 3 groups of ink, 2 of Claude's annotations (1 group in the margin or on added paper, 1 of Claude's annotations pointing outside the page could not be written into the PDF)."
    + " Pages 2, 4 still have 3 of Claude's replies not yet on the paper, so they were not written: turn to those pages and save again",
  'Saved back to a.pdf: 1 group of ink', '“周末安排” updated: Changes on pages 2, 3; New page 5; Removed page 4 of the old version (the handwriting on them was kept separately)',
  'Switched to the new version (v47 → v48): No changes in the content',
  'Zotero’s local API is off: in Zotero, go to Settings → Advanced and tick “Allow other applications on this computer to communicate with Zotero”',
  'Could not import: Cannot reach Zotero: open Zotero on the computer first', 'Zotero returned an error (500)', 'That item is not in Zotero', 'That is not a valid Zotero item key',
  'Could not import: The PDF file of this item cannot be found in Zotero', 'Smith · 2020 · Journal article · no PDF',
  'Could not import: PDF, PowerPoint, Word, EPUB, images, Markdown and plain text can be imported',
  'Nothing to import here (PDF, PowerPoint, Word, EPUB, images, Markdown and plain text).']), said2);

// 6. 电脑上的二维码页
await T.go('?lang=en', { raw: true, path: 'qr', wait: false });
await T.sleep(1500);
left = await js(`(() => { const CJK = /[\\u3400-\\u9fff]/, out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { const p = n.parentElement;
    if (p && !p.closest('script, style') && CJK.test(n.nodeValue) && n.nodeValue.trim() !== '中文') out.push(n.nodeValue.trim().slice(0, 60)); }
  return out; })()`);
T.ok('英文：二维码页', left.length === 0 && /Scan with the tablet/.test(await js(`document.body.textContent`)) && !CJK.test(await js(`document.title`)), left);
await T.shot('6-en-qr.png');

// 7. 不带 lang 再打开还是英文；电脑上的服务停了：顶上那句是英文
await T.go(`?k=${T.code}`, { raw: true });
T.ok('不带 lang 再打开：还是英文（记住了）', (await T.text('#toolsBars')) === 'Exit full screen' && (await js(`new URLSearchParams(location.search).get('lang')`)) === null, await T.text('#toolsBars'));
const errorsOnline = T.errors.slice(); // 服务还在时页面报的错（停掉以后连不上的报错不算）
T.stopHello();
try { execFileSync('taskkill', ['/PID', String(T.srv.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* 已经没了 */ }
await T.sleep(1200);
await T.pen(T.line(120, 700, 200));
let tr = '';
for (let i = 0; i < 40 && !/not saved/.test(tr); i++) { await T.sleep(500); tr = await T.text('#trouble'); }
T.ok('英文：连不上电脑、字没存上的提示', (await T.visible('#trouble')) && /Cannot reach the computer/.test(tr) && /not saved/.test(tr) && /do not refresh/i.test(tr), tr);
await T.shot('7-en-offline.png');

T.ok('服务还在的时候页面没有报错', !errorsOnline.length, errorsOnline);
await T.finish({ errors: errorsOnline });

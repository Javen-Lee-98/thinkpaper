// 导入文档：抽屉里「导入文档…」打开面板；「电脑文件夹」一栏浏览对话所在的文件夹，点一个 PDF 导入成一本能翻页的本子；
// 图片（自己成为一本，不进「Claude 推送」）和 Markdown 也能导入；导入时纸上写「正在导入 …」（不用转换的不提转换），
// 导入过的再点写「正在打开 …」；同一个文件再点一次不会多出一本；「从平板上传…」传一个 PDF。Word / PPT 要开 Office 转换，这里不测。
// 跑法：node tests/browser/import_docs.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

// 准备：对话所在的文件夹（只放这个测试自己的文件，和别的测试分开），里面一份三页的 PDF、一张红色的图、一份 Markdown、一个不能导入的脚本
const NAME = 'import-docs', PROJ = join(process.argv[2] || join(tmpdir(), 'inkthink-browser-tests'), NAME, 'proj');
const T = await boot({ name: NAME, open: false, sessions: [{ sid: 'S1', label: 'MY_PAPER', cwd: PROJ }] });
if (PROJ !== join(T.ROOT, 'proj')) throw new Error('临时目录的位置和 browser_lib 里的对不上：' + PROJ);
const js = T.evalJS, UP = join(T.ROOT, 'ipad');
for (const d of [PROJ, join(PROJ, 'figs'), join(PROJ, 'notes'), UP]) mkdirSync(d, { recursive: true });
const makePdf = (path, texts) => execFileSync(PY, ['-c', `import pymupdf as fitz,sys,json
doc=fitz.open()
for t in json.loads(sys.argv[2]):
    p=doc.new_page(width=960,height=540); p.insert_text((60,120),t,fontsize=36)
doc.save(sys.argv[1])`, path, JSON.stringify(texts)]);
makePdf(join(PROJ, '例会汇报_v1.pdf'), ['Intro', 'Method A', 'Result']);
makePdf(join(UP, '从平板传的.pdf'), ['From iPad', 'Page two']);
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
pix=fitz.Pixmap(fitz.csRGB, fitz.IRect(0,0,300,200), 0); pix.set_rect(pix.irect,(255,0,0)); pix.save(sys.argv[1])`, join(PROJ, 'figs', 'chart.png')]);
writeFileSync(join(PROJ, 'notes', '对照.md'), '# 对照 MarkerXYZ\n\n- 第 1 页\n', 'utf8');
writeFileSync(join(PROJ, 'run.py'), 'print(1)\n', 'utf8');
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
// 面板里列着什么：小标题前面加「— 」，导入过的后面带上标记
const rows = () => js(`[...document.querySelectorAll('#isList .is-item, #isList .is-head')].map((r) => (r.classList.contains('is-head') ? '— ' + r.textContent
  : r.querySelector('.is-name').firstChild.textContent + (r.querySelector('.is-badge') ? ' [' + r.querySelector('.is-badge').textContent + ']' : '')))`);
// 面板里按名字找一行（重名取「文件夹里」的那一行），真的点一下
async function tapRow(name, wait = 300) {
  const c = await js(`(() => { const all = [...document.querySelectorAll('#isList .is-item')].filter((x) => x.querySelector('.is-name').firstChild.textContent === ${JSON.stringify(name)}), r = all[all.length - 1];
    if (!r) return null; r.scrollIntoView({ block: 'nearest' }); const b = r.querySelector('.is-name').getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, t = document.elementFromPoint(x, y);
    return t && r.contains(t) ? [x, y] : null; })()`);
  if (!c) throw new Error('导入面板里点不到这一行：' + name);
  await T.tapAt(c[0], c[1], wait);
}
// 从抽屉里点「导入文档…」，等文件夹列出来
async function openPanel() {
  await drawer(true);
  await tap('#actUpload', 300);
  await T.waitFor(`!document.querySelector('#importSheet').hidden && document.querySelector('#isList .is-item')`);
  await T.sleep(300);
}
const crumbs = () => T.text('#isCrumbs');
const nbIs = async (id) => { const ok = await T.waitFor(`window.__ink.S.nb.id === ${JSON.stringify(id)} && window.__ink.S.page && !/^正在/.test(document.querySelector('#toast').textContent)`, 20000); await T.sleep(500); return ok; };
const st = () => js(`(() => { const S = window.__ink.S; return { id: S.nb.id, kind: S.nb.kind, pages: S.nb.pages, idx: S.idx, bg: S.bgImg ? S.bgImg.naturalWidth : 0,
  chip: document.querySelector('#chipName').textContent + ' ' + document.querySelector('#chipPage').textContent, sheet: !document.querySelector('#importSheet').hidden }; })()`);
// 记下纸上出过的每一句提示，以及那时导入面板关了没有；取走后清空
await js(`(() => { window.__toasts = []; const t = document.querySelector('#toast');
  new MutationObserver(() => { if (!t.hidden && t.textContent) window.__toasts.push([t.textContent, document.querySelector('#importSheet').hidden]); }).observe(t, { childList: true, attributes: true, characterData: true, subtree: true }); return 1; })()`);
const toasts = () => js(`window.__toasts.splice(0)`);
const books = () => readdirSync(T.BOOKS).filter((f) => f.endsWith('.pdf')).sort();
const bookList = async () => (await T.apiJson('/api/notebooks')).filter((n) => n.id.startsWith('book:')).map((n) => n.title).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1. 抽屉里点「导入文档…」：面板打开在「电脑文件夹」一栏，列着对话所在的文件夹
await openPanel();
const tab = await js(`[...document.querySelectorAll('#importSheet .is-tabs button.on')].map((b) => b.dataset.tab)`);
T.ok('点「导入文档…」打开面板，抽屉收起，停在「电脑文件夹」一栏', (await T.visible('#importSheet')) && !(await T.visible('#drawer')) && same(tab, ['folder']) && (await T.visible('#isFolder')) && !(await T.visible('#isZotero')), tab);
const sess = await js(`document.querySelector('#isSession').selectedOptions[0].textContent`);
// 和「这本发往」同一套叫法：这个文件夹只有一个对话，只写文件夹名（2026-11-14 以前还带着完整路径）
T.ok('写着是哪个对话的文件夹', sess === 'MY_PAPER' && (await crumbs()) === 'proj', [sess, await crumbs()]);
const r1 = await rows(), cut = r1.indexOf('— 文件夹里');
T.ok('列出子文件夹和能导入的文件，不能导入的（run.py）不列', cut > 0 && same(r1.slice(cut + 1), ['figs', 'notes', '例会汇报_v1.pdf']) && !r1.some((x) => x.includes('run.py')), r1);
T.ok('上面有一段「最近改过的」，子文件夹里的也在', r1[0] === '— 最近改过的' && same(r1.slice(1, cut).slice().sort(), ['figs/chart.png', 'notes/对照.md', '例会汇报_v1.pdf'].sort()), r1);

// 2. 点 PDF：导入成一本书；导入时面板先关上，纸上有「正在…」的提示
await toasts();
await tapRow('例会汇报_v1.pdf');
await nbIs('book:例会汇报_v1.pdf');
const t2 = await toasts(), s2 = await st();
T.ok('点了就关面板，纸上先写「正在导入 …」（PDF 不用转换，不提转换），好了写「已导入」', t2.length >= 2 && t2[0][0] === '正在导入 例会汇报_v1.pdf…' && t2[0][1] === true && /^已导入《例会汇报_v1》/.test(t2[t2.length - 1][0]), t2);
T.ok('导入成一本三页的书并打开：有底图，左上角是书名和页码', s2.id === 'book:例会汇报_v1.pdf' && s2.kind === 'book' && s2.pages === 3 && s2.bg > 0 && s2.chip === '例会汇报_v1 1/3' && !s2.sheet, s2);
T.ok('电脑上 books 里多了这份 PDF，内容和原文件一样', same(books(), ['例会汇报_v1.pdf']) && readFileSync(join(T.BOOKS, '例会汇报_v1.pdf')).equals(readFileSync(join(PROJ, '例会汇报_v1.pdf'))), books());
const info2 = await T.apiJson('/api/notebook?nb=' + encodeURIComponent('book:例会汇报_v1.pdf'));
T.ok('记着原文件是哪份；这本以后发给这个文件夹的对话', info2.source === '例会汇报_v1.pdf' && info2.sourceChanged === false && Boolean(info2.target) && info2.target.sid === 'S1', [info2.source, info2.target]);

// 3. 能翻页：抽屉里三张缩略图，点第 3 张翻到第 3 页
await drawer(true);
await T.waitFor(`document.querySelectorAll('#thumbs img').length === 3 && [...document.querySelectorAll('#thumbs img')].every((i) => i.complete && i.naturalWidth > 0)`);
await tap('#thumbs .th:nth-child(3)', 300);
await T.waitFor(`window.__ink.S.idx === 2 && window.__ink.S.page && window.__ink.S.bgImg`);
const s3 = await st();
T.ok('能翻页：三张缩略图，点第 3 张翻到第 3 页，有底图', (await T.count('#thumbs .th')) === 3 && s3.idx === 2 && s3.bg > 0 && s3.chip === '例会汇报_v1 3/3', s3);

// 4. 同一个文件再点一次：打开原来那本，不多出一本
await tap('#nbList .nb-item:has(.nb-name[title="草稿本"]) .nb-name');
await nbIs('scratch');
await openPanel();
const r4 = await rows();
T.ok('再打开面板：这份文件标着「已导入」', r4.includes('例会汇报_v1.pdf [已导入 ›]') && !r4.includes('例会汇报_v1.pdf'), r4);
await toasts();
await tapRow('例会汇报_v1.pdf');
await nbIs('book:例会汇报_v1.pdf');
const t4 = await toasts();
T.ok('再点一次：打开原来那本，提示「正在打开 …」「已打开」', (await st()).id === 'book:例会汇报_v1.pdf' && t4[0][0] === '正在打开 例会汇报_v1.pdf…' && /^已打开《例会汇报_v1》/.test(t4[t4.length - 1][0]), t4);
T.ok('没有多出一本：列表里、电脑上都还是一份', same(await bookList(), ['例会汇报_v1']) && same(books(), ['例会汇报_v1.pdf']), [await bookList(), books()]);

// 5. 进子文件夹、点路径回到上一层；导入 Markdown
await openPanel();
await tapRow('figs');
await T.waitFor(`document.querySelector('#isCrumbs').textContent === 'proj › figs'`);
T.ok('点子文件夹进去：路径跟着变，只列这一层的文件', (await crumbs()) === 'proj › figs' && same(await rows(), ['chart.png']), [await crumbs(), await rows()]);
await tap('#isCrumbs a:first-child', 300);
await T.waitFor(`document.querySelector('#isCrumbs').textContent === 'proj'`);
T.ok('点路径最前面一段回到最外层', (await crumbs()) === 'proj' && (await rows()).includes('notes'), await rows());
await tapRow('notes');
await T.waitFor(`document.querySelector('#isCrumbs').textContent === 'proj › notes'`);
await toasts();
await tapRow('对照.md');
await nbIs('book:对照.pdf');
const t5 = await toasts(), s5 = await st();
const mdText = execFileSync(PY, ['-c', 'import pymupdf as fitz,sys; sys.stdout.buffer.write(fitz.open(sys.argv[1])[0].get_text().encode("utf-8"))', join(T.BOOKS, '对照.pdf')]).toString('utf8');
T.ok('Markdown 导入成一本书：排成了一页，有底图，提示「正在导入 …」', s5.id === 'book:对照.pdf' && s5.pages === 1 && s5.bg > 0 && !s5.sheet && t5[0][0] === '正在导入 对照.md…' && t5[0][1] === true, [s5, t5]);
T.ok('排出来的 PDF 里是文件里的字；原件另留了一份', mdText.includes('MarkerXYZ') && mdText.includes('第 1 页') && existsSync(join(T.BOOKS, '_原件', '对照.md')), mdText.slice(0, 80));

// 6. 导入图片：和从平板上传一样，自己成为一本（推送本子只放对话推过来的）
await openPanel();
await tapRow('figs');
await T.waitFor(`document.querySelector('#isCrumbs').textContent === 'proj › figs'`);
await toasts();
await tapRow('chart.png');
await nbIs('book:chart.pdf');
const t6 = await toasts(), s6 = await st();
const px6 = await js(`(() => { const v = window.__ink.S.view, d = devicePixelRatio || 1, p = document.querySelector('#bg').getContext('2d').getImageData(Math.round((v.tx + 500 * v.s) * d), Math.round((v.ty + 300 * v.s) * d), 1, 1).data; return [p[0], p[1], p[2]]; })()`);
T.ok('图片导入成自己的一本，纸上画着这张（红色的）图，提示「正在导入 …」「已导入」', s6.id === 'book:chart.pdf' && s6.kind === 'book' && s6.pages === 1 && s6.bg > 0
  && s6.chip.trim() === 'chart' && px6[0] > 200 && px6[1] < 90 && px6[2] < 90 && t6[0][0] === '正在导入 chart.png…' && /^已导入《chart》/.test(t6[t6.length - 1][0]), [s6, px6, t6]);
const nbs6 = (await T.apiJson('/api/notebooks')).map((n) => n.id);
T.ok('没有放进推送本子：哪本推送本子都没出现，书多了这一本', same(await bookList(), ['例会汇报_v1', '对照', 'chart'].sort()) && !nbs6.some((id) => id.startsWith('board'))
  && !existsSync(join(T.DATA, 'notebooks', 'board', 'bg-0000.png')), [await bookList(), nbs6]);

// 7. 「从平板上传…」：点了去选文件；选一个 PDF，传上来成一本书
await openPanel();
await T.cdp('Page.setInterceptFileChooserDialog', { enabled: true }); // 无头浏览器里不真的弹出选文件的窗口
await js(`document.querySelector('#pdfFile').addEventListener('click', () => { window.__picking = (window.__picking || 0) + 1; }); 1`);
await tap('#isUpload', 400);
T.ok('点「从平板上传…」：面板关上，去选文件', !(await T.visible('#importSheet')) && (await js(`window.__picking`)) === 1, await js(`window.__picking`));
await toasts();
const input = await T.cdp('Runtime.evaluate', { expression: `document.querySelector('#pdfFile')` });
await T.cdp('DOM.setFileInputFiles', { files: [join(UP, '从平板传的.pdf')], objectId: input.result.objectId });
await nbIs('book:从平板传的.pdf');
const t7 = await toasts(), s7 = await st();
T.ok('选了文件：纸上写「正在导入 …」（PDF 不提转换），传完打开这本两页的书', s7.id === 'book:从平板传的.pdf' && s7.pages === 2 && s7.bg > 0 && s7.chip === '从平板传的 1/2' && t7[0][0] === '正在导入 从平板传的.pdf…', [s7, t7]);
T.ok('电脑上 books 里有传上来的这份，内容和选的文件一样', same(books(), ['例会汇报_v1.pdf', '对照.pdf', 'chart.pdf', '从平板传的.pdf'].sort()) && readFileSync(join(T.BOOKS, '从平板传的.pdf')).equals(readFileSync(join(UP, '从平板传的.pdf'))), books());

await T.finish();

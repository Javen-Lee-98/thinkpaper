// 对话推送页面到平板：推一张图片、一个文本文件、一份 PDF 的某一页 → 推它的对话所在文件夹的推送本子（「推送 · 文件夹名」，2026-11-17 起各文件夹一本）里多出一页，
// 平板上有提示能点开；打开后底图是推的东西，可以在上面写字、点「AI」交回推它的那个对话。
// 跑法：node tests/browser/push_show.mjs [临时目录]；有一项不对退出码 1。
import { boot, PY } from '../browser_lib.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 两个对话：proj-b 是最近打字的，推送的是 proj-a（在推送页上写的应当回到 proj-a）
const T = await boot({ name: 'push-show', sessions: [{ sid: 'S1', label: 'proj-a' }, { sid: 'S2', label: 'proj-b' }], open: false });
await T.post('/bridge/active', { sid: 'S2' });
await T.go();

// ---- 准备要推的三样东西：左上角有红块的图、100 行的文本、3 页的 PDF（只有第 2 页上半截是绿的，另两页是蓝的）
const SRC = join(T.ROOT, 'src');
mkdirSync(SRC, { recursive: true });
const png = join(SRC, 'photo.png'), txt = join(SRC, 'notes.txt'), pdf = join(SRC, 'doc.pdf');
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
d=fitz.open(); p=d.new_page(width=800,height=600)
p.draw_rect(fitz.Rect(0,0,200,200),color=None,fill=(1,0,0)); p.insert_text((300,400),'photo',fontsize=40)
p.get_pixmap(alpha=False).save(sys.argv[1])
d=fitz.open()
for k in range(3):
    p=d.new_page(width=595,height=842)
    p.draw_rect(fitz.Rect(0,0,595,300),color=None,fill=(0,1,0) if k==1 else (0,0,1))
    p.insert_text((72,500),'PAGE %d'%(k+1),fontsize=40)
d.save(sys.argv[2])`, png, pdf]);
writeFileSync(txt, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'), 'utf8');

// ---- 这个测试自己用的小工具
const show = (body) => T.post('/bridge/show', Object.assign({ sid: 'S1' }, body));
let NB = '', boardDir = ''; // 第一次推的时候服务回这一本的 id；数据在 notebooks/board-<编号>/
const boardIndex = () => JSON.parse(readFileSync(join(boardDir, 'index.json'), 'utf8')).pages;
const toastText = () => T.evalJS(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').firstChild.textContent`);
const where = () => T.evalJS(`({ nb: window.__ink.S.nb.id, idx: window.__ink.S.idx, pages: window.__ink.S.nb.pages,
  chip: document.querySelector('#chipName').textContent + ' ' + document.querySelector('#chipPage').textContent })`); // chip：左上角写的本子名和页码
// 等提示出来，真的点提示上的「打开」，等翻到推送本子的第 i 页、底图载入
const openFromToast = async (title, i) => {
  const up = await T.waitFor(`!document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.includes(${JSON.stringify(title)})`);
  const seen = up && (await T.visible('#toast button'));
  const text = await toastText(), btn = await T.text('#toast button');
  if (seen) await T.tap('#toast button');
  const opened = await T.waitFor(`window.__ink.S.nb.id === ${JSON.stringify(NB)} && window.__ink.S.idx === ${i} && window.__ink.S.page && window.__ink.S.bgImg`);
  await T.sleep(500);
  return { seen, text, btn, opened };
};
// 屏幕上（底图那一层画布）纸上 (x, y) 这一点的颜色
const onScreen = async (wx, wy) => {
  const [sx, sy] = await T.screenOf(wx, wy);
  return T.evalJS(`(() => { const c = document.querySelector('#bg'), r = c.getBoundingClientRect(), k = c.width / r.width;
    return [...c.getContext('2d').getImageData(Math.round((${sx} - r.left) * k), Math.round((${sy} - r.top) * k), 1, 1).data].slice(0, 3); })()`);
};
// 在页面里数一张图各种颜色的点（空白图都是 0）；y0、y1：只数这一段高度（0–1）
const COUNT = `(im, y0, y1) => { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(im, 0, 0);
  const top = Math.floor(c.height * y0), d = x.getImageData(0, top, c.width, Math.max(1, Math.floor(c.height * y1) - top)).data;
  const n = { w: c.width, h: c.height, red: 0, reddish: 0, green: 0, blue: 0, dark: 0 }; // reddish：偏红就算（细红线压成 JPEG 后不是纯红）
  for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r > 170 && g < 110 && b < 110) n.red++; if (r - g > 50 && r - b > 50) n.reddish++; if (g > 170 && r < 110 && b < 110) n.green++;
    if (b > 170 && r < 110 && g < 110) n.blue++; if (r + g + b < 150) n.dark++; }
  return n; }`;
const bgCount = (y0 = 0, y1 = 1) => T.evalJS(`(${COUNT})(window.__ink.S.bgImg, ${y0}, ${y1})`); // 平板载入的这一页底图
// 电脑上的一张图：读出来交给页面去数
const fileCount = (f, y0 = 0, y1 = 1) => T.evalJS(`(async () => { const im = new Image();
  im.src = 'data:image/${f.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(f).toString('base64')}'; await im.decode(); return (${COUNT})(im, ${y0}, ${y1}); })()`);
const isRed = (p) => p[0] > 200 && p[1] < 60 && p[2] < 60, isGreen = (p) => p[1] > 200 && p[0] < 60 && p[2] < 60;
const isWhite = (p) => p[0] > 235 && p[1] > 235 && p[2] > 235;

// 1. 推一张图片（带标题）
const r1 = await show({ path: png, title: '一周气温' });
T.ok('推图片：服务说推成了，进了推它的对话所在文件夹那本「推送 · proj-a」的第 1 页，平板在线', r1.ok === true && r1.page === 0 && r1.title === '一周气温'
  && r1.tabletOnline === true && /^board:[0-9a-f]{8}$/.test(r1.nb || '') && r1.nbTitle === '推送 · proj-a', r1);
NB = r1.nb;
boardDir = join(T.DATA, 'notebooks', NB.replace(':', '-'));
const f0 = join(boardDir, 'bg-0000.png');
const idx1 = existsSync(f0) ? boardIndex() : [];
T.ok('电脑上这本推送本子里多了一页，记着标题、原文件和谁推的', existsSync(f0) && statSync(f0).size > 500 && idx1.length === 1 && idx1[0].title === '一周气温' && idx1[0].src === png
  && idx1[0].by && idx1[0].by.sid === 'S1' && idx1[0].by.label === 'proj-a' && idx1[0].by.ai === 'Claude', idx1);
const o1 = await openFromToast('一周气温', 0);
T.ok('平板上出了提示「「proj-a」里的对话推送了一页：一周气温」（不写 Claude），带「打开」', o1.seen && o1.text === '「proj-a」里的对话推送了一页：一周气温' && o1.btn === '打开', o1);
const w1 = await where();
T.ok('点「打开」到了这本推送本子的这一页', o1.opened && w1.nb === NB && w1.idx === 0 && w1.pages === 1 && w1.chip.startsWith('推送 · proj-a'), w1);
const b1 = await bgCount(), px1 = [await onScreen(100, 100), await onScreen(700, 100)];
T.ok('底图就是推的那张图：载入的是 800×600、左上角一块红', Boolean(b1) && b1.w === 800 && b1.h === 600 && b1.red > 30000 && b1.dark > 100, b1);
T.ok('屏幕上画出来了：左上角那块是红的，右边是白的', isRed(px1[0]) && isWhite(px1[1]), px1);

// 2. 推一个文本文件的第 2 段（每段 70 行；这个文件第 2 段只有 30 行，所以页面下半截是空的）
const r2 = await show({ path: txt, page: 2 });
T.ok('推文本：标题自动写成「文件名 第 2 页」，是推送本子的第 2 页', r2.ok === true && r2.page === 1 && r2.title === 'notes.txt 第 2 页', r2);
const o2 = await openFromToast('notes.txt 第 2 页', 1);
const b2top = await bgCount(0, 0.5), b2low = await bgCount(0.65, 1);
T.ok('平板上又出提示，点「打开」翻到这一页', o2.seen && o2.opened && (await where()).pages === 2, [o2, await where()]);
T.ok('底图是排好的文字：上半截有字，下半截是空的（第 2 段只有 30 行）', Boolean(b2top) && b2top.dark > 300 && b2low.dark === 0
  && b2top.red + b2top.green + b2top.blue === 0, { b2top, b2low });

// 3. 推 PDF 的第 2 页
const r3 = await show({ path: pdf, page: 2 });
T.ok('推 PDF 的某一页：标题写着第几页', r3.ok === true && r3.page === 2 && r3.title === 'doc.pdf 第 2 页', r3);
const o3 = await openFromToast('doc.pdf 第 2 页', 2);
const b3 = await bgCount(), px3 = [await onScreen(500, 200), await onScreen(500, 1100)];
T.ok('底图是 PDF 的第 2 页（上半截绿，不是另两页的蓝）', o3.opened && Boolean(b3) && b3.green > 100000 && b3.blue === 0 && b3.dark > 100, b3);
T.ok('屏幕上画出来了：上面是绿的，下面是白纸', isGreen(px3[0]) && isWhite(px3[1]), px3);
const info = await T.apiJson('/api/notebook?nb=' + encodeURIComponent(NB));
T.ok('推送本子现在共 3 页，每页记着标题', info.pages === 3 && (info.titles || []).join('｜') === '一周气温｜notes.txt 第 2 页｜doc.pdf 第 2 页', info.titles);
await T.tap('#nbChip');
const drawer = await T.evalJS(`({ open: !document.querySelector('#drawer').hidden, thumbs: document.querySelectorAll('#thumbs .th').length,
  names: [...document.querySelectorAll('#nbList .nb-item')].map((r) => r.querySelector('.nb-name').textContent + (r.classList.contains('cur') ? '（当前）' : '')),
  target: document.querySelector('#actTarget').textContent })`);
T.ok('抽屉里有「推送 · proj-a」这本（当前），3 页，这一页发往推它的对话 proj-a', drawer.open && (await T.visible('#nbList .nb-item.cur')) && drawer.names.includes('推送 · proj-a（当前）')
  && drawer.thumbs === 3 && drawer.target.includes('这一页发往：proj-a'), drawer);
await T.tap('#nbChip');

// 4. 在推送页上写字，点「AI」交回去
await T.tap('#tools [data-tool=red]');
await T.pen(T.line(120, 620, 300));
const inked = (await T.strokes()) === 1 && (await T.saved()) && T.pageFile(NB.replace(':', '-'), 2);
T.ok('能在推送页上写字，自己存到电脑上', Boolean(inked) && inked.strokes.length === 1 && inked.strokes[0].c === 'r', inked);
await T.tap('#check');
const sub = await T.waitSub('S1');
T.ok('点「AI」：交给了推它的对话 proj-a，最近打字的 proj-b 没收到', Boolean(sub) && sub.text.startsWith('【草稿纸】') && !(await T.poll('S2')), sub && sub.text.slice(0, 80));
T.ok('消息里说明这一页是推送的，写着是哪一页', Boolean(sub) && sub.text.includes('这一页是你推送到平板的东西')
  && sub.text.includes('页面：你推送到平板的「doc.pdf 第 2 页」'), sub && sub.text);
const meta = sub ? T.metaOf(sub) : {};
T.ok('投递记着是推送本子的第 3 页，红笔那一组在里面', meta.nb === NB && meta.page === 2 && (meta.role || {}).page === 'board'
  && (meta.groups || []).length === 1 && meta.groups[0].red === true, { nb: meta.nb, page: meta.page, role: meta.role });
const img = sub ? join(T.DATA, 'submissions', sub.id, 'crop.jpg') : '';
const shot = sub && existsSync(img) ? await fileCount(img) : null;
T.ok('交上去的图（消息里列着它）里既有底图（绿）也有刚写的红字', Boolean(shot) && sub.text.includes(join('submissions', sub.id, 'crop.jpg'))
  && shot.green > 10000 && shot.reddish > 100, shot);

// 5. 推一个不存在的文件：说清楚，不多出一页
const bad = await T.postRaw('/bridge/show', { sid: 'S1', path: join(SRC, '没有这个文件.png') });
const badBody = await bad.json();
T.ok('推不存在的文件：报「找不到文件」，推送本子不多出一页', bad.status === 400 && /找不到文件/.test(badBody.error || '') && boardIndex().length === 3, [bad.status, badBody]);

// 6. 同一个文本文件的第 1 段（满 70 行）：排得下，不是白页（以前放不下时一个字都不画）；最后几行也在
const r4 = await show({ path: txt });
const f3 = join(boardDir, 'bg-0003.png');
const b4 = r4.ok && existsSync(f3) ? await fileCount(f3) : null, b4low = b4 ? await fileCount(f3, 0.85, 0.97) : null;
T.ok('推长文本的第 1 段（满 70 行）：底图上有字', Boolean(b4) && b4.dark > 300, { r4, b4 });
T.ok('满 70 行的那一段一行不少：页面下部也有字（最后几行排上了）', Boolean(b4low) && b4low.dark > 30, b4low);
// 7. 有很宽的一行（两万个字符连成一个词）：照样排得上，不会整页变白
const wide = join(SRC, 'wide.txt');
writeFileSync(wide, ['first line', 'x'.repeat(20000), ...Array.from({ length: 30 }, (_, i) => `after ${i + 1}`)].join('\n'), 'utf8');
const r5 = await show({ path: wide });
const f4 = join(boardDir, 'bg-0004.png');
const b5 = r5.ok && existsSync(f4) ? await fileCount(f4) : null;
T.ok('推的文本里有很宽的一行：底图上照样有字，不是白页', Boolean(b5) && b5.dark > 300, { r5, b5 });

await T.finish();

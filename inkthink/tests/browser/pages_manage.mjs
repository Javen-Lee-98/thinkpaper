// 页面管理（抽屉里「页面」那一行右边的图标和缩略图）：在这一页后面加竖版 / 横版空白页；删除这一页、在「显示已删的页」里恢复（笔迹还在）；
// 这一页连同写的字左转 / 右转 90°（转四次回到原样）；点缩略图跳到那一页；在导入的 PDF 中间加空白页，后面的页号顺延、各页的笔迹不串。
// 跑法：node tests/browser/pages_manage.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

// 准备：四页横着的幻灯片（第一页左上角一个红块），像 Claude 那样导入成一本书，再打开页面
const T = await boot({ name: 'pages-manage', open: false });
const js = T.evalJS, SRC = join(T.ROOT, 'src'), NB = join(T.DATA, 'notebooks');
mkdirSync(SRC, { recursive: true });
execFileSync(PY, ['-c', `import fitz,sys
doc=fitz.open()
for i,t in enumerate(['Title','Method','Result','Outlook']):
    p=doc.new_page(width=960,height=540); p.insert_text((200,300),t,fontsize=40)
    if i==0: p.draw_rect(fitz.Rect(0,0,96,96),color=None,fill=(1,0,0))
doc.save(sys.argv[1])`, join(SRC, '组会.pdf')]);
const imp = await T.post('/bridge/import', { sid: 'S1', path: join(SRC, '组会.pdf') });
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
// 现在这一页和这一本的样子
const st = () => js(`(() => { const S = window.__ink.S, th = [...document.querySelectorAll('#thumbs .th')];
  return { idx: S.idx, pages: S.nb.pages, hidden: S.nb.hidden, h: S.nb.sizes.map((x) => x.h), baseH: Math.round(S.baseH * 10) / 10, rot: S.page.rot || 0,
    ink: S.page.strokes.filter((s) => !s.erasedAt).map((s) => s.id), info: S.nb.pageInfo.map((p) => (p.blank ? 'blank' : 'pdf' + p.pdf)), bg: Boolean(S.bgImg && S.bgImg.naturalWidth > 0),
    chip: document.querySelector('#chipPage').textContent, thumbs: th.length, curThumb: th.findIndex((e) => e.classList.contains('cur')), blankThumbs: th.map((e, i) => (e.classList.contains('blank') ? i : -1)).filter((i) => i >= 0) }; })()`);
// 等翻到第 i + 1 页、这本一共 n 页
const at = async (i, n) => { const ok = await T.waitFor(`window.__ink.S.page && window.__ink.S.idx === ${i} && window.__ink.S.nb.pages === ${n}`); await T.sleep(400); return ok; };
const thumb = async (i, n) => { await drawer(true); await tap(`#thumbs .th:nth-child(${i + 1})`, 300); return at(i, n); }; // 点第 i + 1 页的缩略图
const write = async (y, n = 1) => { await drawer(false); for (let k = 0; k < n; k++) await T.pen(T.line(150, y + k * 60, 300)); await T.saved(); return (await st()).ink; }; // 收起抽屉，在这一页写 n 笔，等存上
const answer = (val) => js(`window.__asked = []; window.confirm = (m) => { window.__asked.push(m); return ${JSON.stringify(val)}; }; 1`); // 确认框换成自己的：记下问了什么
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, eps = 0.2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps;
const lay = (dir) => JSON.parse(readFileSync(join(NB, dir, 'layout.json'), 'utf8')); // 电脑上记的页面顺序
const inkOf = (dir, key) => { const f = join(NB, dir, (key[0] === 'p' ? 'page-' : 'blank-') + key.slice(1) + '.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).strokes.filter((s) => !s.erasedAt).map((s) => s.id) : []; };
const ends = () => js(`(() => { const s = window.__ink.S.page.strokes[0], a = s.pts[0], b = s.pts[s.pts.length - 1]; return [a[0], a[1], b[0], b[1], s.w]; })()`); // 第一笔的起点、终点、粗细
const turn = async (sel, rot) => { await tap(sel, 300); await T.waitFor(`window.__ink.S.page && (window.__ink.S.page.rot || 0) === ${rot}`); await T.saved(); await T.sleep(300); };
// 底图画布上某个页面坐标处是不是红的
const red = (wx, wy) => js(`(() => { const v = window.__ink.S.view, d = devicePixelRatio || 1;
  const p = document.querySelector('#bg').getContext('2d').getImageData(Math.round((v.tx + ${wx} * v.s) * d), Math.round((v.ty + ${wy} * v.s) * d), 1, 1).data; return p[0] > 200 && p[1] < 90 && p[2] < 90; })()`);

// 1. 抽屉里「页面」那一行的图标；只有一页时删不了；草稿本第 1 页写一笔，在它后面加一张竖版空白页
await drawer(true);
const icons = [];
for (const id of ['#actTurnL', '#actTurnR', '#actAddPortrait', '#actAddLandscape', '#actDelPage']) icons.push(await T.visible(id));
T.ok('抽屉里「页面」那一行有五个图标：左转、右转、加竖版页、加横版页、删除', icons.every(Boolean), icons);
await tap('#actDelPage', 300);
const info1 = await T.apiJson('/api/notebook?nb=scratch');
T.ok('只有一页时点删除：提示「最后一页不能删」，页还在', (await T.text('#toast')) === '最后一页不能删' && (await T.visible('#toast')) && (await st()).pages === 1 && info1.pages === 1 && info1.hidden === 0, [await T.text('#toast'), info1.pages, info1.hidden]);
const A = await write(260);
await drawer(true);
await tap('#actAddPortrait', 200);
await at(1, 2);
let s = await st();
T.ok('加竖版空白页：加在这一页后面并翻过去，和草稿本一样高（1414）', A.length === 1 && s.idx === 1 && s.pages === 2 && s.h[1] === 1414 && s.ink.length === 0 && s.chip === '2/2' && s.thumbs === 2 && s.curThumb === 1, s);
T.ok('提示说加在了第 1 页后面', /第 1 页后加了一张空白页/.test(await T.text('#toast')), await T.text('#toast'));

// 2. 在新页上写一笔，再在它后面加一张横版空白页
const B = await write(300);
await drawer(true);
await tap('#actAddLandscape', 200);
await at(2, 3);
s = await st();
const L2 = lay('scratch'), keyB = L2.pages[1].key;
T.ok('加横版空白页：纸比宽度矮（高约 707）', B.length === 1 && s.idx === 2 && s.pages === 3 && Math.abs(s.h[2] - 707.2) < 1 && Math.abs(s.baseH - 707.2) < 1 && s.ink.length === 0 && s.chip === '3/3', s);
T.ok('电脑上记下了页的顺序和方向，两页的字各在各的文件里', L2.pages.length === 3 && L2.pages[0].key === 'p0000' && L2.pages[1].orient === 'portrait' && L2.pages[2].orient === 'landscape'
  && same(inkOf('scratch', 'p0000'), A) && same(inkOf('scratch', keyB), B) && inkOf('scratch', L2.pages[2].key).length === 0, L2);

// 3. 点缩略图跳到那一页
await T.waitFor(`[...document.querySelectorAll('#thumbs img')].every((i) => i.complete && i.naturalWidth > 0)`);
const imgs = await js(`[...document.querySelectorAll('#thumbs img')].map((i) => i.complete && i.naturalWidth > 0)`);
T.ok('三页都画出了缩略图', imgs.length === 3 && imgs.every(Boolean), imgs);
await thumb(0, 3);
s = await st();
T.ok('点第 1 页的缩略图：跳到第 1 页，上面是第一笔', s.idx === 0 && same(s.ink, A) && s.curThumb === 0 && s.chip === '1/3', s);
await thumb(1, 3);
s = await st();
T.ok('点第 2 页的缩略图：跳到第 2 页，上面是第二笔', s.idx === 1 && same(s.ink, B) && s.curThumb === 1 && s.chip === '2/3' && (await T.visible('#drawer')), s);

// 4. 删除这一页（写过字的先问一句）；后面的页顶上来
await answer(false);
await tap('#actDelPage');
T.ok('删写过字的页先问一句（说了可以恢复）；点取消就不删', same((await js(`window.__asked`)).map((m) => /写过字/.test(m) && /恢复/.test(m)), [true]) && (await st()).pages === 3, await js(`window.__asked`));
await answer(true);
await tap('#actDelPage', 200);
await at(1, 2);
s = await st();
const L4 = lay('scratch');
T.ok('删掉了：剩两页，后面那张横版页顶上来，抽屉里写着已删 1 页', s.pages === 2 && s.hidden === 1 && s.idx === 1 && Math.abs(s.h[1] - 707.2) < 1 && s.ink.length === 0 && s.thumbs === 2
  && /2 页，已删 1 页/.test(await T.text('#thumbCount')), [s, await T.text('#thumbCount')]);
T.ok('电脑上没真删：那一页记在已删的名单里，字的文件还在', L4.pages.length === 2 && L4.hidden.length === 1 && L4.hidden[0].entry.key === keyB && same(inkOf('scratch', keyB), B), L4);

// 5. 「显示已删的页」里恢复
await tap('#actHidden');
const rows = await js(`[...document.querySelectorAll('#hiddenList .hr span')].map((x) => x.textContent)`);
T.ok('点「显示已删的页」：列出那一页，标着写过字', (await T.visible('#hiddenList')) && same(rows, ['空白页（写过字）']), rows);
await tap('#hiddenList .hr button', 200);
await at(1, 3);
s = await st();
T.ok('点「恢复」：回到原来的位置（第 2 页），上面的笔迹还在', s.pages === 3 && s.hidden === 0 && s.idx === 1 && same(s.ink, B) && s.h[1] === 1414 && Math.abs(s.h[2] - 707.2) < 1
  && !(await T.visible('#hiddenList')) && lay('scratch').hidden.length === 0 && same(lay('scratch').pages.map((p) => p.key), L2.pages.map((p) => p.key)), s);

// 没写过字的页（第 3 页）：不问就删；名单里不标「写过字」；恢复回来还在最后
await thumb(2, 3);
await answer(true);
await tap('#actDelPage', 200);
await at(1, 2);
await tap('#actHidden');
const rows5 = await js(`[...document.querySelectorAll('#hiddenList .hr span')].map((x) => x.textContent)`);
T.ok('没写过字的页不问就删；已删的名单里不标「写过字」', (await js(`window.__asked.length`)) === 0 && (await st()).pages === 2 && same(rows5, ['空白页']), [await js(`window.__asked`), rows5]);
await tap('#hiddenList .hr button', 200);
await at(2, 3);
s = await st();
T.ok('恢复回来还在最后（第 3 页，横版）', s.idx === 2 && s.pages === 3 && s.hidden === 0 && Math.abs(s.h[2] - 707.2) < 1 && s.ink.length === 0, s);

// 6. 右转 90°：纸变成横的，笔迹的坐标跟着转；一共转四次回到原样；左转再右转也回到原处
await thumb(0, 3);
const p0 = await ends(), k = 1000 / 1414;
await turn('#actTurnR', 90);
let p = await ends();
s = await st();
T.ok('右转 90°：纸变成横的（高约 707），原来朝上的一边到了右边，笔迹跟着转', s.rot === 90 && Math.abs(s.baseH - 707.2) < 1 && same(s.ink, A)
  && near(p, [k * (1414 - p0[1]), k * p0[0]]) && near(p.slice(2), [k * (1414 - p0[3]), k * p0[2]]), [p0, p, s.baseH]);
const f6 = T.pageFile('scratch', 0);
T.ok('转角和转过的笔迹存到了电脑上', Boolean(f6) && f6.rot === 90 && near(f6.strokes[0].pts[0], p, 0.01), f6 && [f6.rot, f6.strokes[0].pts[0]]);
for (const r of [180, 270, 0]) await turn('#actTurnR', r);
p = await ends();
s = await st();
T.ok('再右转三次（一共四次）：纸、笔迹、粗细都回到原样', s.rot === 0 && s.baseH === 1414 && same(s.ink, A) && near(p, p0, 0.5) && near(p.slice(2), p0.slice(2), 0.5) && Math.abs(p[4] - p0[4]) < 0.03, [p0, p]);
await turn('#actTurnL', 270);
p = await ends();
T.ok('左转 90°：原来朝上的一边到了左边', near(p, [k * p0[1], k * (1000 - p0[0])], 0.5) && near(p.slice(2), [k * p0[3], k * (1000 - p0[2])], 0.5), [p0, p]);
await turn('#actTurnR', 0);
p = await ends();
T.ok('左转再右转：笔迹回到原处，电脑上存的转角也回到 0', near(p, p0, 0.5) && near(p.slice(2), p0.slice(2), 0.5) && (T.pageFile('scratch', 0).rot || 0) === 0, [p0, p]);

// 7. 导入的 PDF：在第 2、3 页上写字，再在第 2 页后面加一张空白页
const BOOK = 'book-' + createHash('sha1').update('组会.pdf').digest('hex').slice(0, 12); // 这本书的笔迹文件夹
await drawer(true);
await tap(`#nbList .nb-item:has(.nb-name[title="组会"]) .nb-name`);
await T.waitFor(`window.__ink.S.nb.id === ${JSON.stringify(imp.id)} && window.__ink.S.page`);
await thumb(1, 4);
const C = await write(300);
await thumb(2, 4);
const D = await write(250, 2);
await thumb(1, 4);
await tap('#actAddPortrait', 200);
await at(2, 5);
s = await st();
T.ok('在 PDF 中间加空白页：加在第 2 页后面，是一张没有底图的白纸', C.length === 1 && D.length === 2 && s.idx === 2 && s.pages === 5 && same(s.info, ['pdf0', 'pdf1', 'blank', 'pdf2', 'pdf3'])
  && !s.bg && s.ink.length === 0 && s.h[2] === 1414 && s.chip === '3/5', s);
T.ok('缩略图多了一张，第 3 张标着空白', s.thumbs === 5 && same(s.blankThumbs, [2]) && s.curThumb === 2, s);
await thumb(3, 5);
s = await st();
T.ok('后面的页号顺延：原来的第 3 页现在是第 4 页，底图和那两笔都跟着它', s.idx === 3 && s.bg && same(s.ink, D) && s.chip === '4/5', s);
await thumb(1, 5);
s = await st();
T.ok('前面的第 2 页没变：有底图，还是那一笔', s.idx === 1 && s.bg && same(s.ink, C), s);
const L7 = lay(BOOK), keyE = L7.pages[2].key;
T.ok('电脑上各页的字没串：还按原文件的页号存着，顺序里多了一张空白纸', same(L7.pages.map((e) => (e.pdf === undefined ? 'blank' : 'pdf' + e.pdf)), ['pdf0', 'pdf1', 'blank', 'pdf2', 'pdf3'])
  && same(inkOf(BOOK, 'p0001'), C) && same(inkOf(BOOK, 'p0002'), D) && inkOf(BOOK, keyE).length === 0 && inkOf(BOOK, 'p0000').length === 0 && inkOf(BOOK, 'p0003').length === 0, L7);

// 8. 空白页上写的字存在它自己的文件里；在横着的书页后面加横版空白页：和前一页一样大
await thumb(2, 5);
const E = await write(300);
T.ok('在插进去的空白页上写字：存在它自己的文件里，前后两页的字不变', E.length === 1 && same(inkOf(BOOK, keyE), E) && same(inkOf(BOOK, 'p0001'), C) && same(inkOf(BOOK, 'p0002'), D), [E, inkOf(BOOK, keyE)]);
await thumb(3, 5);
await tap('#actAddLandscape', 200);
await at(4, 6);
s = await st();
T.ok('在横着的书页后面加横版空白页：和前一页一样大', s.idx === 4 && s.info[4] === 'blank' && s.h[3] === 562.5 && s.h[4] === 562.5 && !s.bg, s);

// 9. 书页右转：底图跟着转；左转回来
await thumb(0, 6);
const before = [await red(50, 50), await red(950, 80)];
await turn('#actTurnR', 90);
s = await st();
T.ok('书页右转：纸竖起来，底图跟着转，左上角的红块到了右上角', before[0] && !before[1] && s.rot === 90 && Math.abs(s.baseH - 1777.8) < 1 && (await red(950, 80)) && !(await red(50, 50)), [before, s.baseH, await red(950, 80), await red(50, 50)]);
await turn('#actTurnL', 0);
s = await st();
T.ok('左转回来：红块回到左上角', s.rot === 0 && s.baseH === 562.5 && (await red(50, 50)) && !(await red(950, 80)), [s.baseH, await red(50, 50), await red(950, 80)]);

await T.finish();

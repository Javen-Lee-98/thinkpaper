// 挪过页序的书，原文件更新后保留用户排的先后（2026-11-17 用户定，《产品定义》第 2 节「做了但还留着毛病的」）：
// 导入一份 4 页的 PDF（A B C D），各页写一笔，B 后面插一张空白页，把 D 挪到最前（D A B _ C）。
// 原文件改了（B 后面加了一页 X，C 改了）：平板上点「更新这本」以后，抽屉里的缩略图按 D A B _ X C 排（看缩略图的图，不只看数据），
// 笔迹跟着各自的页；改过的 C、新加的 X 上，右上角的提示条各说各的，「对比旧版」看到的是 C 的旧版；没改的页、空白页上没有提示。
// 更新后那句话里的页码是平板上现在的页码（第 6 页有改动；新增第 5 页）。再让 Claude 导入一次改了 D 的新版：
// 给 Claude 的结果照旧写原文件的页号（第 5 页），平板上那句话写平板上的页码（第 1 页），先后还是用户排的。
// 只在无头 Edge 上用合成的笔和点击验过，没在 iPad 上试过。
// 跑法：node tests/browser/doc_order.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'doc-order' });
const SRC = join(T.ROOT, 'src'), PDF = join(SRC, '例会.pdf');
mkdirSync(SRC, { recursive: true });
// 每页上面一行标题（对齐新旧两版用），中间一条粗黑条：黑条的高低认得出是哪一页（缩略图上也看得出来）。页面 1000 × 562.5
const BAR = { A: 70, B: 150, C: 230, C2: 310, D: 390, X: 470 };
const TITLE = { A: 'Intro: weekend trip planner', B: 'Method: simple travel budget', C: 'Result: total cost 300 yuan', C2: 'Result: total cost 350 yuan',
  D: 'Summary and the next steps', D2: 'Summary and the open questions', X: 'Agenda for today and tomorrow' };
const makePdf = (pages) => execFileSync(PY, ['-c', `import pymupdf as fitz,sys,json
doc=fitz.open()
for t,y in json.loads(sys.argv[2]):
    p=doc.new_page(width=1000,height=562.5); p.insert_text((60,45),t,fontsize=30); p.draw_rect(fitz.Rect(100,y,900,y+40),color=(0,0,0),fill=(0,0,0))
doc.save(sys.argv[1])`, PDF, JSON.stringify(pages.map((k) => [TITLE[k], BAR[k] ?? BAR[k[0]]]))]);
const NB = 'book:例会.pdf';

// ---- 小工具
const js = T.evalJS, same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const toastText = () => js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
const chip = () => js(`(() => { const c = document.querySelector('#verchip'), a = document.querySelector('#verAct'), r = c.getBoundingClientRect();
  return { shown: !c.hidden && r.width > 0, kind: c.dataset.kind || '', text: document.querySelector('#verText').textContent, act: a.hidden ? '' : a.textContent }; })()`);
const chgBoxes = () => js(`document.querySelectorAll('#aiRoot .chg-marks rect.chg').length`);
const inkOnTablet = async (n) => { const out = []; for (let i = 0; i < n; i++) { await T.openPage(i); out.push((await js(`window.__ink.S.page.strokes.filter((s) => !s.erasedAt).map((s) => s.id)`)).join('+')); } return out; };
const writeOn = async (i) => { await T.openPage(i); await T.pen(T.line(150, 540, 120)); await T.saved(); return js(`window.__ink.S.page.strokes.at(-1).id`); };
// 底图画布上纸面这一块里深色的点有多少：分辨眼前是新版还是旧版的底图
const darkIn = (x0, y0, x1, y1) => js(`(() => { const v = window.__ink.S.view, c = document.querySelector('#bg'), k = c.width / c.clientWidth;
  const d = c.getContext('2d').getImageData(Math.round((v.tx + ${x0} * v.s) * k), Math.round((v.ty + ${y0} * v.s) * k), Math.round(${x1 - x0} * v.s * k), Math.round(${y1 - y0} * v.s * k)).data;
  let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 300) n++; return n; })()`);
// 抽屉里每张缩略图画的是哪一页：看图上黑条在哪个高度（缩略图宽对应纸宽 1000）；没有黑条的是空白页「_」
const thumbPages = () => js(`(async () => {
  const BAR = ${JSON.stringify(BAR)}, out = [];
  for (const img of document.querySelectorAll('#thumbs .th img')) {
    img.loading = 'eager';
    try { await img.decode(); } catch (e) { out.push('?'); continue; }
    const c = document.createElement('canvas'), w = img.naturalWidth, h = img.naturalHeight, s = w / 1000;
    c.width = w; c.height = h;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, w, h).data;
    let best = '_', most = 0.5;
    for (const [k, y] of Object.entries(BAR)) {
      const y0 = Math.round((y + 8) * s), y1 = Math.min(h, Math.round((y + 32) * s)), x0 = Math.round(w * 0.2), x1 = Math.round(w * 0.8);
      let n = 0, all = 0;
      for (let r = y0; r < y1; r++) for (let q = x0; q < x1; q++) { const i = (r * w + q) * 4; all++; if (d[i] + d[i + 1] + d[i + 2] < 200) n++; }
      if (all && n / all > most) { most = n / all; best = k; }
    }
    out.push(best);
  }
  return out; })()`);
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) { if (open) await T.tap('#nbChip', 800); else await T.fingerTapAt(700, 900, 600); } };
const labels = () => js(`[...document.querySelectorAll('#thumbs .th span')].map((e) => e.textContent).join(',')`);

// 1. 导入 A B C D，各页写一笔；B 后面插一张空白页（也写一笔）；把 D 挪到最前面
makePdf(['A', 'B', 'C', 'D']);
const imp = await T.post('/bridge/import', { sid: 'S1', path: PDF });
T.ok('导入成一本 4 页的书', imp.ok && imp.id === NB && imp.pages === 4, imp);
await T.openNotebook(NB, 0);
const ink = {};
for (const [i, k] of [[0, 'A'], [1, 'B'], [2, 'C'], [3, 'D']]) ink[k] = await writeOn(i);
const ins = await T.apiJson('/api/page/insert', { method: 'POST', body: JSON.stringify({ nb: NB, after: 1 }) });
T.ok('B 后面插了一张空白页', ins.page === 2, ins);
await T.openNotebook(NB, 2);
ink._ = await writeOn(2);
const mv = await T.apiJson('/api/page/move', { method: 'POST', body: JSON.stringify({ nb: NB, from: 4, to: 0, key: 'p0003' }) });
T.ok('D 挪到了最前面', mv.page === 0, mv);
await T.openNotebook(NB, 0);
await drawer(true);
T.ok('挪完：缩略图是 D A B _ C（看缩略图上的黑条）', same(await thumbPages(), ['D', 'A', 'B', '_', 'C']), await thumbPages());
await drawer(false);

// 2. 原文件改了：B 后面加一页 X，C 改了（标题和黑条都挪了）。平板重新打开时提示原文件改过了，点「更新这本」
await T.sleep(1200);
makePdf(['A', 'B', 'X', 'C2', 'D']);
await T.reload();
let c = await chip();
T.ok('平板提示原文件改过了，带「更新这本」', c.shown && c.kind === 'source' && c.act === '更新这本', c);
await T.tap('#verAct');
T.ok('点一下就更新了', await T.waitFor(`window.__ink.S.nb.sourceChanged === false && window.__ink.S.nb.pages === 6 && window.__ink.S.page`, 15000), await chip());
T.ok('平板上那句话写的是平板上现在的页码：第 6 页有改动；新增第 5 页', /《例会》已更新：第 6 页有改动；新增第 5 页/.test(await toastText()), await toastText());
const info = await T.apiJson('/api/notebook?nb=' + encodeURIComponent(NB));
T.ok('电脑上记的页序：D A B _ X C（原文件页号 4 0 1 空白 2 3）', same(info.pageInfo.map((p) => p.pdf), [4, 0, 1, null, 2, 3]), info.pageInfo.map((p) => p.pdf));

// 3. 抽屉里的缩略图按用户排的先后，新加的 X 跟在 B 和它后面的空白页后面
await drawer(true);
T.ok('更新后缩略图是 D A B _ X C2（看缩略图上的黑条：C 是新版的）', same(await thumbPages(), ['D', 'A', 'B', '_', 'X', 'C2']), await thumbPages());
T.ok('缩略图的页码是 1 到 6，第 4 张标着空白', (await labels()) === '1,2,3,4 空白,5,6', await labels());
await drawer(false);
const tab = await inkOnTablet(6);
T.ok('平板上翻到各页，笔迹跟着各自的页：D A B _ (X 上没有) C', same(tab, [ink.D, ink.A, ink.B, ink._, '', ink.C]), tab);

// 4. 提示条跟着页走：改过的 C（第 6 页）有「这一页更新时改过（见橙框）」和橙框，「对比旧版」看到 C 的旧版；
//    新加的 X（第 5 页）写「这一页是更新后新加的」；没改的 D（第 1 页）、A、空白页上没有提示
await T.openPage(5);
c = await chip();
T.ok('第 6 页（改过的 C）：右上角「这一页更新时改过（见橙框）」带「对比旧版」，有橙框', c.shown && c.kind === 'page' && c.text === '这一页更新时改过（见橙框）' && c.act === '对比旧版' && (await chgBoxes()) >= 1, [c, await chgBoxes()]);
const OLD_BAR = [300, BAR.C + 8, 700, BAR.C + 32], NEW_BAR = [300, BAR.C2 + 8, 700, BAR.C2 + 32];
let dk = [await darkIn(...OLD_BAR), await darkIn(...NEW_BAR)];
T.ok('底图是新版的 C（黑条在下面）', dk[0] === 0 && dk[1] > 1000, dk);
await T.tap('#verAct', 1500);
c = await chip();
dk = [await darkIn(...OLD_BAR), await darkIn(...NEW_BAR)];
T.ok('点「对比旧版」：看到的是 C 的旧版（黑条在上面），不是别的页', (await js(`window.__ink.S.compare`)) === true && /旧版/.test(c.text) && dk[0] > 1000 && dk[1] === 0, [c, dk]);
await T.tap('#verAct', 1500);
T.ok('「回到新版」', (await js(`window.__ink.S.compare`)) === false, await chip());
await T.openPage(4);
c = await chip();
T.ok('第 5 页（新加的 X）：「这一页是更新后新加的」，没有「对比旧版」', c.shown && c.text === '这一页是更新后新加的' && c.act === '', c);
for (const [i, what] of [[0, '挪到最前的 D'], [1, 'A'], [3, '空白页']]) {
  await T.openPage(i);
  c = await chip();
  T.ok(`第 ${i + 1} 页（${what}）：没有提示，没有橙框`, !c.shown && (await chgBoxes()) === 0, c);
}

// 5. Claude 再导入一次（D 改了）：给 Claude 的结果写原文件页号（第 5 页），平板上那句话写平板上的页码（第 1 页）；先后不变
await T.sleep(1200);
makePdf(['A', 'B', 'X', 'C2', 'D2']);
const up = await T.post('/bridge/import', { sid: 'S1', path: PDF });
T.ok('给 Claude 的结果：原地更新，写原文件的页号「第 5 页有改动」', up.ok && up.id === NB && up.pages === 6 && up.updated === '第 5 页有改动', up);
T.ok('平板上那句话写平板上的页码「第 1 页有改动」', await T.waitFor(`!document.querySelector('#toast').hidden && /《例会》已更新：第 1 页有改动/.test(document.querySelector('#toast').textContent)`), await toastText());
await drawer(true);
T.ok('缩略图还是 D A B _ X C2', same(await thumbPages(), ['D', 'A', 'B', '_', 'X', 'C2']), await thumbPages());
await drawer(false);
await T.openPage(0);
c = await chip();
T.ok('第 1 页（改过的 D）：「这一页更新时改过（见橙框）」，笔迹还在', c.shown && c.text === '这一页更新时改过（见橙框）' && c.act === '对比旧版'
  && (await js(`window.__ink.S.page.strokes.map((s) => s.id).join('+')`)) === ink.D, c);
await T.openPage(5);
c = await chip();
T.ok('第 6 页（这次没改的 C）：没有提示了', !c.shown, c);

T.ok('页面没有报错', !T.errors.length, T.errors);
await T.finish();

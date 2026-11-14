// 存回 PDF：把这本上的手写和 Claude 的批注写进电脑上那份 PDF 原文件。
// 入口在抽屉里当前这本那一行的「存回 PDF」图标。查：先问一句、存之前留底（2026-11-14 起和改文件同一个留底文件夹 data/keep，
// 不再往 data/backups 里放）、PDF 里真的多了批注（用 PyMuPDF 打开看）、再存是替换不是叠加、存完提示上有「撤回」（先在顶上问一句，
// 撤回后 PDF 逐字节回到存之前）、原文件在导入后改过就不存并说明、不是从 PDF 导入的本子没有这个入口。
// 跑法：node tests/browser/save_pdf.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY, APP } from '../browser_lib.mjs';

const T = await boot({ name: 'save-pdf' });
const SRC = join(T.ROOT, 'src'), PDF = join(SRC, 'paper.pdf'), PNG = join(SRC, 'photo.png'), BACKUPS = join(T.DATA, 'backups');
mkdirSync(SRC, { recursive: true });
const py = (code, ...args) => execFileSync(PY, ['-c', code, ...args], { encoding: 'utf8' });
// 两页的 PDF（1000 宽，纸上的坐标和 PDF 的坐标一样），第 1 页上有一条别人（张三）加的高亮；再做一张图片
py(`import fitz,sys
doc=fitz.open()
for t in ['Newton second law: F = m a','Energy is conserved here']:
    p=doc.new_page(width=1000,height=562.5); p.insert_text((60,120),t,fontsize=40)
pg=doc[0]; hl=pg.add_highlight_annot(fitz.Rect(60,85,400,130)); hl.set_info(title='张三'); hl.update()
doc.save(sys.argv[1])
fitz.Pixmap(fitz.csRGB, fitz.IRect(0,0,400,300), 0).save(sys.argv[2])`, PDF, PNG);
// 用 PyMuPDF 读出 PDF 里所有批注：[页, 类型, 作者, 主题, 内容, 外框]
const annots = () => JSON.parse(py(`import fitz,sys,json
doc=fitz.open(sys.argv[1])
print(json.dumps([[i,a.type[1],a.info.get('title',''),a.info.get('subject',''),a.info.get('content',''),[round(v) for v in a.rect]] for i,pg in enumerate(doc) for a in pg.annots()]))`, PDF));
const own = (list) => list.filter((a) => a[2].startsWith('InkThink')); // 草稿纸写进去的
const toastText = () => T.evalJS(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
const waitToast = async (re, ms = 15000) => { const t0 = Date.now(); for (;;) { const t = await toastText(); if (re.test(t)) return t; if (Date.now() - t0 > ms) return t; await T.sleep(200); } };
const openDrawer = async () => { if (!(await T.visible('#drawer'))) await T.tap('#nbChip'); };
const closeDrawer = async () => { if (await T.visible('#drawer')) await T.fingerTapAt(700, 900); }; // 手指点纸面收起抽屉
// 系统的确认框用一个替身接住：记下问了什么，按 answer 回答
const onConfirm = (answer) => T.evalJS(`(() => { window.__asked = window.__asked || []; window.confirm = (m) => { window.__asked.push(m); return ${answer}; }; return 1; })()`);
const asked = () => T.evalJS(`window.__asked || []`);
const pageOnDisk = async (nb, i) => (await T.apiJson(`/api/page?nb=${encodeURIComponent(nb)}&i=${i}`));
// 以前的备份文件夹里这份 PDF 的备份（2026-11-14 起不再往里放）
const backups = () => (existsSync(BACKUPS) ? readdirSync(BACKUPS).filter((f) => f.startsWith('paper.')).sort() : []);
// 留底文件夹里这份 PDF 的撤回队列（新的在前）和原件
const kept = () => JSON.parse(py(`import sys,json; sys.path.insert(0, sys.argv[1]); from keep import Keeper
k=Keeper(sys.argv[2]); o=k.original(sys.argv[3]); print(json.dumps({'h': k.history(sys.argv[3]), 'o': o}))`, APP, join(T.DATA, 'keep'), PDF));

// 1. 导入 PDF，第 1 页写两笔黑的、一笔红的，第 2 页写一笔；Claude 在第 1 页加一条短批注
const imp = await T.post('/bridge/import', { sid: 'S1', path: PDF });
await T.openNotebook(imp.id, 1);
await T.pen(T.line(200, 400, 300));
await T.openPage(0);
await T.pen(T.line(200, 400, 300));
await T.pen(T.line(200, 430, 300));
await T.tap('#tools [data-tool=red]');
await T.pen(T.line(600, 250, 200));
await T.tap('#tools [data-tool=pen]');
const rep = await T.post('/bridge/reply', { sid: 'S1', items: [{ type: 'note', text: '标题太泛', box: [60, 85, 600, 130] }] });
T.ok('Claude 的短批注写到了这一页', rep.ok && await T.waitFor(`window.__ink.S.page.ai.some((a) => a.type === 'note' && a.text === '标题太泛')`), rep);
await T.saved();
await T.sleep(1500);
const d0 = await pageOnDisk(imp.id, 0), d1 = await pageOnDisk(imp.id, 1);
T.ok('写的字和批注都存到电脑上了', d0.strokes.length === 3 && d0.ai.length === 1 && d1.strokes.length === 1, [d0.strokes.length, d0.ai.length, d1.strokes.length]);

// 2. 入口：抽屉里这本那一行有「存回 PDF」
await openDrawer();
const label = await T.evalJS(`(document.querySelector('#actSavePdf') || { getAttribute: () => '' }).getAttribute('aria-label')`);
T.ok('抽屉里这本那一行有「存回 PDF」，看得见', (await T.visible('#actSavePdf')) && /^存回 PDF/.test(label), label);
T.ok('它在当前这本那一行里', await T.evalJS(`Boolean(document.querySelector('#nbList .nb-item.cur #actSavePdf'))`));

// 3. 第一次存先问一句；答「取消」就什么都不写
const before = readFileSync(PDF);
await onConfirm(false);
await T.tap('#actSavePdf', 1500);
const q1 = await asked();
T.ok('第一次存回先问一句，说了写进哪个文件、会先留底、存完能撤回', q1.length === 1 && /paper\.pdf/.test(q1[0]) && /留一份底/.test(q1[0]) && /能撤回/.test(q1[0]), q1);
T.ok('答取消：原文件一个字节没动，也没留底', readFileSync(PDF).equals(before) && kept().h.length === 0 && backups().length === 0, kept());

// 4. 答「确定」：写进原文件，存之前留了底
await onConfirm(true);
await T.tap('#actSavePdf');
const t1 = await waitToast(/已存回|没存成/);
T.ok('平板上说存回了：手写几组、Claude 批注 1 条', /已存回 paper\.pdf：手写 \d+ 组、Claude 批注 1 条/.test(t1), t1);
const a1 = annots(), mine1 = own(a1);
const ink0 = mine1.filter((a) => a[0] === 0 && a[1] === 'Ink' && a[2] === 'InkThink'), red0 = ink0.filter((a) => a[3] === '红笔');
T.ok('PDF 第 1 页多了手写的墨迹批注（黑的和红的）', ink0.some((a) => a[3] === '手写') && red0.length === 1, mine1);
T.ok('平板上说的组数和 PDF 里的墨迹条数一样', Number((/手写 (\d+) 组/.exec(t1) || [])[1]) === mine1.filter((a) => a[1] === 'Ink' && a[2] === 'InkThink').length, t1);
const r = red0.length ? red0[0][5] : [0, 0, 0, 0];
T.ok('红笔那一笔写在 PDF 上原来的位置', Math.abs(r[0] - 600) < 12 && Math.abs(r[2] - 800) < 12 && Math.abs((r[1] + r[3]) / 2 - 250) < 8, r);
const notes = mine1.filter((a) => a[1] === 'Text');
T.ok('Claude 的批注成了 PDF 里的便签，内容和作者都对', notes.length === 1 && notes[0][0] === 0 && notes[0][2] === 'InkThink · Claude' && notes[0][4] === '标题太泛', notes);
T.ok('PDF 第 2 页也有那一笔', mine1.filter((a) => a[0] === 1 && a[1] === 'Ink').length === 1, mine1);
T.ok('别人（张三）加的批注还在', a1.filter((a) => a[2] === '张三').length === 1, a1);
const k1 = kept();
T.ok('存之前留了底（留底文件夹里），和存之前的原文件一模一样；不再往旧的备份文件夹里放', k1.h.length === 1 && k1.h[0].note === '存回 PDF 前'
  && readFileSync(k1.h[0].copy).equals(before) && backups().length === 0, [k1, backups()]);
T.ok('存完的提示上有「撤回」', (await T.text('#toast button')) === '撤回', await T.text('#toast'));
const afterFirst = readFileSync(PDF);
const info1 = await T.apiJson('/api/notebook?nb=' + encodeURIComponent(imp.id));
T.ok('自己存回的不算「原文件改过了」', Boolean(info1.saved) && info1.sourceChanged === false, [info1.saved, info1.sourceChanged]);

// 5. 再写一笔、再存一次：不再问；是替换上次写的，不是叠加；又留一份底
await closeDrawer();
await T.pen(T.line(200, 500, 150));
await openDrawer();
await T.tap('#actSavePdf');
const t2 = await waitToast(/已存回|没存成/);
const a2 = annots(), mine2 = own(a2);
T.ok('再存一次不再问，直接存', /已存回 paper\.pdf/.test(t2) && (await asked()).length === 2, [t2, await asked()]);
T.ok('再存是替换上次写的：只多了新写的那一笔，没有叠成两份', mine2.length === mine1.length + 1 && mine2.filter((a) => a[1] === 'Text').length === 1, [mine1.length, mine2.length]);
T.ok('张三的批注还是只有一条', a2.filter((a) => a[2] === '张三').length === 1, a2);
const k2 = kept();
T.ok('第二次存之前又留了一份底（最早那份是原件，原样留着）', k2.h.length === 2 && readFileSync(k2.o.copy).equals(before) && readFileSync(k2.h[0].copy).equals(afterFirst), k2);

// 5b. 点存完提示上的「撤回」：先在顶上问一句，确认后 PDF 逐字节回到这次存之前
T.ok('第二次存完的提示上也有「撤回」', (await T.text('#toast button')) === '撤回', await T.text('#toast'));
await T.tap('#toast button', 800);
const ask5 = await T.evalJS(`({ up: !document.querySelector('#qcard').hidden, head: document.querySelector('#qcHead').textContent, text: document.querySelector('#qcBody').innerText,
  btns: [...document.querySelectorAll('#qcFoot button')].filter((b) => !b.hidden && b.offsetWidth).map((b) => b.textContent) })`);
T.ok('撤回前在顶上问一句：撤回对 paper.pdf 的上一次存回，「取消」「撤回」', ask5.up && ask5.head === '撤回修改' && ask5.text.includes('撤回对《paper.pdf》的上一次存回？电脑上的文件会回到存回之前。')
  && JSON.stringify(ask5.btns) === '["取消","撤回"]', ask5);
await T.shot('save-pdf-undo-confirm.png');
await T.tap('#qcYes');
const t5 = await waitToast(/已撤回|没撤回/);
T.ok('撤回了：PDF 逐字节回到第二次存之前', /已撤回：《paper\.pdf》回到了存回之前/.test(t5) && readFileSync(PDF).equals(afterFirst), t5);
T.ok('撤回队列少了一份', kept().h.length === 1, kept());
const info5 = await T.apiJson('/api/notebook?nb=' + encodeURIComponent(imp.id));
T.ok('撤回后不算「原文件改过了」', info5.sourceChanged === false, info5.sourceChanged);

// 6. 原文件在导入后被别的程序改过：不存，并说明
await T.sleep(1200);
py(`import fitz,sys
doc=fitz.open(sys.argv[1]); doc.new_page(); doc.saveIncr()`, PDF);
const changed = readFileSync(PDF);
await openDrawer(); // 撤回时抽屉收起了
await T.tap('#actSavePdf');
const t3 = await waitToast(/已存回|没存成/);
T.ok('原文件改过后不存，说明要先更新这本', /没存成：原文件在导入后改过：先更新这本，再存回/.test(t3), t3);
T.ok('原文件没被这次存回动过，也没多留底', readFileSync(PDF).equals(changed) && kept().h.length === 1 && backups().length === 0, kept());

// 7. 不是从电脑上的 PDF 导入的本子：没有这个入口；直接请求也会被拒并说明
await closeDrawer();
await T.openNotebook('scratch', 0);
await openDrawer();
T.ok('草稿本那一行没有「存回 PDF」', (await T.count('#nbList .nb-item.cur')) === 1 && !(await T.visible('#actSavePdf')), await T.count('#actSavePdf'));
await closeDrawer();
const img = await T.post('/bridge/import', { sid: 'S1', path: PNG });
await T.openNotebook(img.id, 0);
await openDrawer();
T.ok('从图片导入的本子那一行也没有「存回 PDF」', img.ok && (await T.evalJS(`window.__ink.S.nb.id`)) === img.id && (await T.count('#nbList .nb-item.cur')) === 1 && !(await T.visible('#actSavePdf')), img);
const refuse = await T.api('/api/book/save-pdf', { method: 'POST', body: JSON.stringify({ nb: img.id }) });
const why = (await refuse.json()).error || '';
T.ok('直接请求存回会被拒，说明没有可以存回的原文件', refuse.status === 400 && /不是从电脑上的 PDF 导入的/.test(why), [refuse.status, why]);

await T.finish();

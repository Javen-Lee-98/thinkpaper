// 改电脑上的文件 · 其余几样（2026-11-14，阶段 C；《产品定义》第 4 节），用一份 Markdown（周三例会纪要）：
// A. 「覆盖还是另存」卡片等不到：工具先得到「还没选、停手等着」；之后选了，对话收到一条新消息，写明哪个文件、选了什么、带 mode 再调；
//    带 mode 调的不弹卡片。
// B. 右上角提示条关掉以后：抽屉里这本那一行有「撤回上次修改」（名字下面另起一行），从这里也能撤回。
// C. 连改 7 次：留 5 版；从提示条上撤回 5 次（「撤回这次修改」→「再往回撤一次」），一版版回去；第 6 次没有按钮了。
// D. 回到前台时查原文件改过没有（以前要重新打开这本）；那次修改之后文件又改过：确认那一句写明会连后来的改动一起回退、
//    现在这份另留一份；撤回后另留的那份在留底文件夹里。
// E. 推送页上指着我手写的字的修改建议不算「在文档上」（画成页边批注、没有 ✓ ×），指着印刷内容的照旧在文档上。
// F. 英文界面：卡片、提示条、抽屉、确认、撤回后的提示都是英文；卡片上点「Overwrite」交上去的照样是「覆盖」。
// G. 平板不在线：ink_edit 不带 mode 时马上得到「在对话里问」，不排卡片。
// 跑法：node tests/browser/edit_more.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { boot, PY, APP } from '../browser_lib.mjs';

const T = await boot({ name: 'edit-more' });
const js = T.evalJS, sid = 'S1';
const SRC = join(T.ROOT, 'docs'), MD = join(SRC, '会议纪要.md');
mkdirSync(SRC, { recursive: true });
const minutes = (k) => `# 周三例会纪要\n\n- 下周换会议室\n- 茶歇改到 ${k} 点\n- 周五前交报销单\n`;
writeFileSync(MD, minutes(0), 'utf8');
const py = (code, ...args) => execFileSync(PY, ['-c', code, ...args], { encoding: 'utf8' });
const kept = (p) => JSON.parse(py(`import sys,json; sys.path.insert(0, sys.argv[1]); from keep import Keeper
k=Keeper(sys.argv[2]); print(json.dumps({'h': k.history(sys.argv[3]), 'a': k.asides(sys.argv[3])}))`, APP, join(T.DATA, 'keep'), p));
const rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.hidden || !e.getClientRects().length) return null;
  const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
const toastText = () => js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
const waitToast = async (re, ms = 30000) => { const t0 = Date.now(); for (;;) { const t = await toastText(); if (re.test(t)) return t; if (Date.now() - t0 > ms) return t; await T.sleep(200); } };
const shot = async (f) => { await js(`document.querySelector('#toast').hidden = true`); return T.shot(f); };
const drain = async () => { while (await T.poll(sid)) { /* 之前的消息不管 */ } };
const cardUp = async (id) => { const ok = await T.waitFor(`window.__ink.S.qShown === ${JSON.stringify(id)} && !document.querySelector('#qcard').hidden`); await T.sleep(400); return ok; };
const tapOption = async (text) => { const c = await js(`(() => { const b = [...document.querySelectorAll('#qcBody .qc-opts button')].find((x) => x.textContent === ${JSON.stringify(text)});
  if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`); if (c) await T.tapAt(c[0], c[1]); return Boolean(c); };
const confirmCard = () => js(`({ up: !document.querySelector('#qcard').hidden && document.querySelector('#qcard').dataset.kind === 'local', head: document.querySelector('#qcHead').textContent,
  lines: [...document.querySelectorAll('#qcBody .qc-local div')].map((d) => d.textContent),
  btns: [...document.querySelectorAll('#qcFoot button')].filter((b) => !b.hidden && b.offsetWidth).map((b) => b.textContent) })`);
const undoBtn = () => js(`document.querySelector('#verchip').hidden || document.querySelector('#verUndo').hidden ? '' : document.querySelector('#verUndo').textContent`);
const openDrawer = async () => { if (!(await T.visible('#drawer'))) await T.tap('#nbChip', 700); };
const edit = async (k) => { // Claude 带 mode 覆盖一次：留底、改、导入
  const r = await T.post('/bridge/edit', { sid, path: MD, mode: 'overwrite' });
  writeFileSync(MD, minutes(k), 'utf8');
  const up = await T.post('/bridge/import', { sid, path: MD });
  return { r, up };
};
const bytes = () => readFileSync(MD, 'utf8');

const imp = await T.post('/bridge/import', { sid, path: MD });
const NB = imp.id;
await T.openNotebook(NB, 0);
T.ok('导入并打开了「会议纪要」', NB === 'book:会议纪要.pdf' && (await T.waitFor(`window.__ink.S.bgImg && window.__ink.S.nb.id === ${JSON.stringify(NB)}`)), imp);

// A. 卡片等不到：先「还没选」；之后选了「另存」，对话收到一条新消息；服务不替 Claude 先另存
const files0 = readdirSync(SRC).sort();
const ask = await T.post('/bridge/edit', { sid, path: MD });
T.ok('卡片落下', await cardUp(ask.ask));
const p1 = await T.post('/bridge/edit-wait', { id: ask.ask, wait: 0.3 }), p2 = await T.post('/bridge/edit-wait', { id: ask.ask, wait: 0.3, last: true });
T.ok('等不到：工具那边得到「还没选，停手等着，不要替用户选，也不要先动这个文件」', p1.pending && p2.pending && p2.text.includes('不要替用户选') && p2.text.includes('也不要先动这个文件'), p2);
T.ok('卡片还在平板上', await T.visible('#qcard'));
await drain();
await tapOption('另存');
const late = await T.waitSub(sid);
T.ok('之后选了「另存」：对话收到【草稿纸·回答】，写明哪个文件、选了什么、带 mode=saveas 再调一次 ink_edit', Boolean(late) && late.text.startsWith('【草稿纸·回答】你之前要改 ')
  && late.text.includes('会议纪要.md') && late.text.includes('我现在选了「另存」') && late.text.includes('mode=saveas'), late && late.text);
T.ok('晚到的选择只是一条消息：没有新文件，也没有留底', JSON.stringify(readdirSync(SRC).sort()) === JSON.stringify(files0) && kept(MD).h.length === 0, readdirSync(SRC));
const direct = await T.post('/bridge/edit', { sid, path: MD, mode: 'overwrite' });
await T.sleep(1500);
T.ok('带 mode 调：不弹卡片，直接留底', direct.done === true && direct.mode === 'overwrite' && (await js(`window.__ink.S.cards.length === 0 && document.querySelector('#qcard').hidden`)) && kept(MD).h.length === 1, direct);
writeFileSync(MD, minutes(1), 'utf8');
await T.post('/bridge/import', { sid, path: MD });
T.ok('改完导入：提示条上有「撤回这次修改」', await T.waitFor(`!document.querySelector('#verUndo').hidden && document.querySelector('#verUndo').textContent === '撤回这次修改'`, 20000), await undoBtn());

// B. 关掉提示条：抽屉里这本那一行「撤回上次修改」（名字下面另起一行，整行宽），点它也能撤回
await T.tap('#verClose');
T.ok('提示条关掉了', await T.waitFor(`document.querySelector('#verchip').hidden`));
await openDrawer();
const dr = await js(`(() => { const b = document.querySelector('#actUndoEdit'), row = b && b.closest('.nb-item'), name = row && row.querySelector('.nb-name'), d = document.querySelector('#drawer');
  if (!b) return null; const r = b.getBoundingClientRect(), n = name.getBoundingClientRect(), dd = d.getBoundingClientRect();
  return { text: b.textContent, cur: row.classList.contains('cur'), below: r.top >= n.bottom - 1, inside: r.left >= dd.left && r.right <= dd.right, w: r.width }; })()`);
T.ok('抽屉里当前这本那一行：名字下面一行「撤回上次修改」，在抽屉里看得全', Boolean(dr) && dr.text === '撤回上次修改' && dr.cur && dr.below && dr.inside, dr);
await shot('edit-drawer-undo.png');
await T.tap('#actUndoEdit', 800);
const cB = await confirmCard();
T.ok('点了：抽屉收起，顶上问一句', cB.up && !(await T.visible('#drawer')) && cB.lines[0] === '撤回对《会议纪要.md》的上一次修改？电脑上的文件会回到修改之前。', cB);
await T.tap('#qcYes');
await waitToast(/已撤回|没撤回/);
T.ok('从抽屉撤回了：文件回到改之前', bytes() === minutes(0), bytes());

// C. 连改 7 次：留 5 版；提示条上撤回 5 次，一版版回去；第 6 次没有按钮
for (let k = 1; k <= 7; k++) await edit(10 + k);
T.ok('改了 7 次：撤回队列留 5 版', kept(MD).h.length === 5, kept(MD).h.length);
T.ok('平板上换到第 7 次的版本，提示条上有「撤回这次修改」', await T.waitFor(`!document.querySelector('#verUndo').hidden && document.querySelector('#verUndo').textContent === '撤回这次修改'
  && window.__ink.S.nb.undo && window.__ink.S.nb.undo.left === 5`, 20000), [await undoBtn(), await js(`window.__ink.S.nb.undo`)]);
const seen = [];
for (let n = 0; n < 5; n++) {
  await T.waitFor(`!document.querySelector('#verchip').hidden && !document.querySelector('#verUndo').hidden`, 20000);
  seen.push(await undoBtn());
  await T.tap('#verUndo', 700);
  await T.tap('#qcYes');
  await waitToast(/已撤回|没撤回/);
  T.ok(`第 ${n + 1} 次撤回：文件回到第 ${6 - n} 次改完的样子`, bytes() === minutes(10 + 6 - n), bytes());
}
T.ok('按钮先是「撤回这次修改」，之后是「再往回撤一次」', JSON.stringify(seen) === JSON.stringify(['撤回这次修改', '再往回撤一次', '再往回撤一次', '再往回撤一次', '再往回撤一次']), seen);
await T.sleep(1500);
T.ok('撤了 5 次：提示条上没有撤回按钮了', (await undoBtn()) === '' && !(await js(`window.__ink.S.nb.undo`)), await undoBtn());
await openDrawer();
T.ok('抽屉里也没有「撤回上次修改」', (await T.count('#actUndoEdit')) === 0);
await T.fingerTapAt(700, 900);

// D. 改完以后用户自己在电脑上又改了：回到前台就查出来；撤回时确认那一句写明会连后来的改动一起回退、现在这份另留一份
await edit(30);
await T.waitFor(`!document.querySelector('#verUndo').hidden`, 20000);
const mine = '# 周三例会纪要\n\n- 下周换会议室\n- 茶歇改到 30 点\n- 周五前交报销单\n- 我自己加的：带伞\n';
writeFileSync(MD, mine, 'utf8');
await T.sleep(2500);
T.ok('（对照）还在前台、没有别的动静时，平板不知道原文件改了', (await js(`document.querySelector('#verchip').dataset.kind`)) !== 'source', await T.text('#verchip'));
await js(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); return 1; })()`);
T.ok('回到前台：提示条写「原文件改过了」，带「更新这本」', await T.waitFor(`!document.querySelector('#verchip').hidden && document.querySelector('#verchip').dataset.kind === 'source'
  && document.querySelector('#verText').textContent === '原文件「会议纪要.md」改过了'`, 8000), await T.text('#verchip'));
await openDrawer();
await T.tap('#actUndoEdit', 800);
const cD = await confirmCard();
T.ok('确认那一句：写明那之后又改过、会连后来的改动一起回退、现在这份另留一份', cD.up && cD.lines.length === 2 && cD.lines[0] === '撤回对《会议纪要.md》的上一次修改？电脑上的文件会回到修改之前。'
  && cD.lines[1] === '这个文件在那次修改之后又改过，撤回会连后来的改动一起回退；现在这份会另留一份，要用可以让 Claude 找回。', cD);
await shot('edit-undo-confirm-changed.png');
await drain();
await T.tap('#qcYes');
const tD = await waitToast(/已撤回|没撤回/);
T.ok('撤回了，提示里说后来改的那份另留了', /已撤回：《会议纪要\.md》回到了修改之前；后来又改过的那份另留了一份/.test(tD), tD);
const kD = kept(MD);
T.ok('文件回到那次修改之前；后来改的那份另留在留底文件夹里', bytes() === minutes(12) && kD.a.length === 1 && readFileSync(kD.a[0].copy, 'utf8') === mine && kD.a[0].note === '撤回前', [bytes(), kD.a]);
const toldD = await T.waitSub(sid);
T.ok('对话收到【草稿纸·撤回】，写着另留在哪', Boolean(toldD) && toldD.text.includes('另留在 ') && toldD.text.includes(basename(kD.a[0].copy)), toldD && toldD.text);

// E. 推送页：指着我手写的字的建议画成页边批注（没有 ✓ ×），指着印刷内容的照旧在文档上
const TXT = join(SRC, '采购单.txt');
writeFileSync(TXT, '办公室采购单\n一、打印纸 三箱\n二、白板笔 两盒\n三、纸杯 一袋\n', 'utf8');
const shownE = await T.post('/bridge/show', { sid, path: TXT, title: '采购单' }); // 进这个对话所在文件夹的推送本子（2026-11-17）
await T.openNotebook(shownE.nb, 0);
await T.waitFor(`window.__ink.S.nb.id === ${JSON.stringify(shownE.nb)} && window.__ink.S.bgImg`);
await T.pen(T.line(150, 700, 260));
await T.saved();
await drain();
await T.tap('#check');
const subE = await T.waitSub(sid), metaE = subE && T.metaOf(subE), c = metaE.crop;
const px = (b) => [(b[0] - c.x0) * c.scale, (b[1] - c.y0) * c.scale, (b[2] - c.x0) * c.scale, (b[3] - c.y0) * c.scale];
await T.post('/bridge/reply', { sid, submission: subE.id, items: [{ type: 'suggest', anchor: 'g1', text: '改为：便签 两本' }, { type: 'suggest', box: px([40, 90, 520, 140]), text: '改为：打印纸 两箱' }] });
await T.waitFor(`window.__ink.S.page.ai.length >= 2`, 10000);
await T.sleep(1500);
const E = await js(`window.__ink.S.page.ai.map((a) => ({ type: a.type, text: a.text, onDoc: Boolean(a.onDoc), vbtn: document.querySelectorAll('#aiRoot [data-id="' + a.id + '"] .vbtn').length }))`);
const onInk = E.find((a) => a.text === '改为：便签 两本'), onPrint = E.find((a) => a.text === '改为：打印纸 两箱');
T.ok('指着我手写的字的建议：不算在文档上，画成页边批注，没有 ✓ ×', Boolean(onInk) && onInk.type === 'note' && !onInk.onDoc && onInk.vbtn === 0, E);
T.ok('指着印刷内容的建议：照旧在文档上，有 ✓ ×', Boolean(onPrint) && onPrint.type === 'suggest' && onPrint.onDoc && onPrint.vbtn === 2, E);
await T.openNotebook(NB, 0);

// F. 英文界面：卡片、提示条、抽屉、确认、撤回后的提示；卡片上点「Overwrite」交上去的是「覆盖」
await T.go('&lang=en');
await T.openNotebook(NB, 0);
const askF = await T.post('/bridge/edit', { sid, path: MD });
await cardUp(askF.ask);
const cardF = await js(`({ head: document.querySelector('#qcHead').textContent, q: document.querySelector('#qcBody .qc-q').textContent,
  opts: [...document.querySelectorAll('#qcBody .qc-opts button')].map((b) => b.textContent),
  left: [...document.querySelectorAll('#qcFoot .qc-left button')].filter((b) => !b.hidden).map((b) => b.textContent), later: document.querySelector('#qcLater').textContent })`);
T.ok('英文：服务问的那句和两个选项跟着翻译，「忽略」「稍后」是英文', cardF.head === 'idea asks you' && cardF.q === 'Edit “会议纪要.md”: overwrite the original file, or save a copy?'
  && JSON.stringify(cardF.opts) === '["Overwrite","Save as a copy"]' && JSON.stringify(cardF.left) === '["Ignore"]' && cardF.later === 'Later', cardF);
await shot('edit-ask-card-en.png');
const waitF = T.post('/bridge/edit-wait', { id: askF.ask, wait: 20 });
await tapOption('Overwrite');
const goF = await waitF;
T.ok('英文界面点「Overwrite」：交上去的是「覆盖」', goF.mode === 'overwrite' && goF.chose === '覆盖', goF);
writeFileSync(MD, minutes(40), 'utf8');
await T.post('/bridge/import', { sid, path: MD });
T.ok('英文：提示条上是「Revert this edit」', await T.waitFor(`!document.querySelector('#verUndo').hidden && document.querySelector('#verUndo').textContent === 'Revert this edit'`, 20000), await undoBtn());
T.ok('英文：提示条那一句和「对比旧版」也是英文', (await T.text('#verText')) === 'This page changed in the update: see the orange boxes' && (await T.text('#verAct')) === 'Compare with the old version',
  [await T.text('#verText'), await T.text('#verAct')]);
await T.sleep(400);
const enChip = await rect('#verchip'), enRow = await rect('#chipRow'), enBtns = await js(`[...document.querySelectorAll('#verchip button')].filter((b) => !b.hidden).map((b) => b.getBoundingClientRect().height)`);
const meets = (a, b) => Boolean(a && b) && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
T.ok('英文：提示条换成英文变宽以后重新摆过，不压左上角那一排；按钮不折行', !meets(enChip, enRow) && enBtns.every((h) => h <= 30), [enChip, enRow, enBtns]);
await openDrawer();
T.ok('英文：抽屉里是「Revert the last edit」', (await T.text('#actUndoEdit')) === 'Revert the last edit', await T.text('#actUndoEdit'));
await T.fingerTapAt(700, 900);
await T.tap('#verUndo', 800);
const cF = await confirmCard();
T.ok('英文：确认的头一行、那一句、两个按钮', cF.up && cF.head === 'Revert an edit' && cF.lines[0] === 'Revert the last edit to “会议纪要.md”? The file on the computer goes back to how it was before the edit.'
  && JSON.stringify(cF.btns) === '["Cancel","Revert"]', cF);
await shot('edit-undo-confirm-en.png');
await T.tap('#qcYes');
const tF = await waitToast(/Reverted|Not reverted|Could not/);
T.ok('英文：撤回后的提示', /^Reverted: “会议纪要\.md” is back to how it was before the edit/.test(tF), tF);
T.ok('英文：纸上「已撤回」那几个字也有对照', await js(`window.InkLang.t('已撤回') === 'Reverted' && window.InkLang.t('已改') === 'Done'`));
await T.go('');

// G. 平板不在线：ink_edit 不带 mode 马上得到「在对话里问」，不排卡片
await T.cdp('Page.navigate', { url: 'about:blank' });
let online = true;
for (let i = 0; i < 60 && online; i++) { await T.sleep(1000); online = (await T.get(`/bridge/status?sid=${sid}`)).tabletOnline; }
const off = await T.post('/bridge/edit', { sid, path: MD });
T.ok('平板关了：马上得到「在对话里问用户覆盖还是另存」，没有排卡片', !online && off.offline === true && off.text.includes('在对话里问用户') && (await T.apiJson('/api/asks')).length === 0, off);

await T.finish();

// 字迹确认卡片：Claude 拿不准的字，在平板上弹卡片问。点候选、自己写、跳过、稍后再答、翻到那页、
// 等太久之后才答（作为新消息送进对话）、更正过的读法记下来下次带上。
// 2026-11-14（阶段 C）起它和问话卡片是同一种卡片：从屏幕顶上落下、居中，「稍后」缩成顶上一小条，点小条再展开。
// 跑法：node tests/browser/confirm_card.mjs [临时目录]；有一项不对退出码 1。
import { boot } from '../browser_lib.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const T = await boot({ name: 'confirm-card', pages: 2 });
const sid = 'S1';

// ---- 这个测试自己用的小工具
// 插件那一侧：问字迹、等回答（先停一下，等平板把上一张卡片收拾完）
const ask = async (body) => { await T.sleep(400); return T.post('/bridge/confirm', Object.assign({ sid }, body)); };
const wait = (id, o) => T.post('/bridge/confirm-wait', Object.assign({ id, wait: 20 }, o));
// 等这张卡片落下来，并且里面的截图都载入了
const cardUp = async (id) => {
  const up = await T.waitFor(`window.__ink.S.qShown === ${JSON.stringify(id)} && !document.querySelector('#qcard').hidden`);
  const loaded = await T.waitFor(`[...document.querySelectorAll('#qcBody img')].every((i) => i.complete && i.naturalWidth > 0)`);
  await T.sleep(400); // 落下的动画停稳
  return up && loaded;
};
const cardGone = () => T.waitFor(`document.querySelector('#qcard').hidden && document.querySelector('#qbar').hidden`);
const rect = (sel) => T.evalJS(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null;
  const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
const meets = (a, b) => Boolean(a && b) && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const okText = () => T.text('#confirmOk');
// 纸上框出来的那几处：位置、大小，在屏幕上看不看得见
const marks = () => T.evalJS(`[...document.querySelectorAll('#aiRoot .confirm-mark')].map((r) => { const b = r.getBoundingClientRect();
  return { x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height'),
    seen: b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= innerHeight && getComputedStyle(r).display !== 'none' }; })`);
const around = (m, b) => Boolean(m) && Math.abs(m.x - (b[0] - 8)) < 1.5 && Math.abs(m.y - (b[1] - 8)) < 1.5
  && Math.abs(m.w - (b[2] - b[0] + 16)) < 1.5 && Math.abs(m.h - (b[3] - b[1] + 16)) < 1.5;
// 卡片里第 k 处的截图：等它载入，读像素数一数红色的点和深色的点（空白图两样都是 0）
const snippet = async (k) => {
  const row = `document.querySelectorAll('#qcBody .cq')[${k}]`;
  await T.waitFor(`(() => { const i = ${row} && ${row}.querySelector('img'); return i && i.complete && i.naturalWidth > 0; })()`);
  return T.evalJS(`(() => { const im = ${row} && ${row}.querySelector('img'); if (!im || !im.naturalWidth) return null;
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data; let red = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i] > 170 && d[i + 1] < 110 && d[i + 2] < 110) red++; if (d[i] + d[i + 1] + d[i + 2] < 150) dark++; }
    const r = im.getBoundingClientRect(); return { w: c.width, h: c.height, red, dark, shown: r.width > 0 && r.height > 0 }; })()`);
};
// 真的点一下第 k 处的某个候选按钮
const tapOption = async (k, text) => {
  const c = await T.evalJS(`(() => { const row = document.querySelectorAll('#qcBody .cq')[${k}];
    const e = row && [...row.querySelectorAll('.opts button')].find((b) => b.textContent === ${JSON.stringify(text)});
    if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (c) await T.tapAt(c[0], c[1]);
  return Boolean(c);
};
const firstRow = () => T.evalJS(`(() => { const row = document.querySelector('#qcBody .cq'); if (!row) return null;
  return { on: [...row.querySelectorAll('.opts button.on')].map((b) => b.textContent), input: row.querySelector('input').value }; })()`);

// 0. 准备：第 1 页黑笔一组（g1）、红笔一组（g2），第 2 页红笔一组；Claude 用整本检测取到这两页，平板停在第 1 页
await T.pen(T.line(120, 260, 300));
await T.tap('#tools [data-tool=red]');
await T.pen(T.line(120, 520, 200));
await T.openPage(1);
await T.pen(T.line(150, 300, 220));
await T.saved();
await T.openPage(0);
const scan = await T.post('/bridge/scan', { sid, nb: 'scratch' });
const pg = scan.id ? T.metaOf(scan).pages : {};
const g = (pg['1'] || {}).groups || {}, g2nd = (pg['2'] || {}).groups || {};
T.ok('准备好了：整本检测取到两页，第 1 页两组笔迹、第 2 页一组', scan.pages === 2 && Boolean(g.g1 && g.g2 && g2nd.g1), scan.error || Object.keys(pg));

// 1. 一张卡片问两处（平板正开着那一页）
const c1 = await ask({ submission: scan.id, page: 1, questions: [
  { anchor: 'g2', guess: 'ρ', options: ['p', 'P'], question: '这里是 ρ 还是 p？' },
  { anchor: 'g1', question: '这一行写的是什么？' }] });
T.ok('插件问得出去：拿到卡片编号，说了问的是哪一页', Boolean(c1.id) && c1.tabletOnline === true && /草稿本第 1 页/.test(c1.where || ''), c1);
T.ok('平板上弹出卡片，写着是哪个对话在问', (await cardUp(c1.id)) && (await T.visible('#qcard')) && (await T.text('#qcHead')) === 'idea 想确认字迹',
  await T.text('#qcHead'));
// 挪到了顶上（2026-11-14）：在左上角那一排下面、居中；不再盖住右下角那一条（以前在底部、压在它上面）
const card1 = await rect('#qcard'), chips1 = await rect('#chipRow'), tools1 = await rect('#tools'), vw = await T.evalJS(`document.documentElement.clientWidth`);
T.ok('卡片在屏幕顶上居中，在左上角那一排下面', Boolean(card1 && chips1) && card1.t >= chips1.b && card1.t < 140 && Math.abs((card1.l + card1.r) / 2 - vw / 2) < 2
  && !meets(card1, chips1), { card1, chips1 });
T.ok('卡片不盖右下角那一条，那一条照样点得到', Boolean(tools1) && !meets(card1, tools1) && await T.evalJS(`(() => { const r = document.querySelector('#tools').getBoundingClientRect();
  return document.querySelector('#tools').contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })()`), { card1, tools1 });
await T.shot('1-confirm-top.png');
const asked =await T.evalJS(`[...document.querySelectorAll('#qcBody .cq > .q')].map((e) => e.textContent)`);
T.ok('两处问的话都写在卡片上', asked.length === 2 && asked[0].includes('这里是 ρ 还是 p？') && asked[1].includes('这一行写的是什么？'), asked);
const btns = await T.evalJS(`[...document.querySelectorAll('#qcBody .cq')].map((r) => [...r.querySelectorAll('.opts button')].map((b) => b.textContent))`);
T.ok('候选按钮：Claude 的读法排第一，后面是别的候选；没给候选的那处没有按钮', JSON.stringify(btns) === JSON.stringify([['ρ', 'p', 'P'], []]), btns);
const inputs = await T.evalJS(`[...document.querySelectorAll('#qcBody .cq input')].map((i) => { const r = i.getBoundingClientRect();
  return { hint: i.placeholder, seen: r.width > 100 && r.height > 20 && r.top >= 0 && r.bottom <= innerHeight }; })`);
T.ok('每处都有一个可以自己写的输入框，在屏幕上看得见', inputs.length === 2 && inputs.every((i) => i.seen && i.hint.includes('在这里写')), inputs);
const s0 = await snippet(0), s1 = await snippet(1);
T.ok('第一处的截图里是那一笔红字', Boolean(s0) && s0.shown && s0.red > 50 && s0.dark === 0, s0);
T.ok('第二处的截图里是那一笔黑字', Boolean(s1) && s1.shown && s1.dark > 50 && s1.red === 0, s1);
const m1 = await marks();
T.ok('纸上这两处笔迹被框出来，框在屏幕上看得见', m1.length === 2 && around(m1[0], g.g2) && around(m1[1], g.g1) && m1.every((m) => m.seen), m1);
T.ok('什么都没填时按钮写着「看不清，跳过」', (await okText()) === '看不清，跳过', await okText());
const w1 = wait(c1.id);
await tapOption(0, 'p');
const picked = await firstRow();
T.ok('点一个候选：那个按钮亮起来，下面的按钮变成「回答」', Boolean(picked) && picked.on.join() === 'p' && picked.input === 'p' && (await okText()) === '回答', picked);
await T.tap('#confirmOk');
const a1 = await w1;
T.ok('点「回答」后 Claude 拿到读法：第一处是 p，没填的第二处算跳过', Boolean(a1.answers) && a1.answers[0].text === 'p' && a1.answers[1].skip === true
  && a1.text.includes('g2：这里是 ρ 还是 p？（你读成「ρ」） → 是「p」') && /g1：这一行写的是什么？ → 我没有回答（跳过了）/.test(a1.text), a1);
const left1 = [await cardGone(), (await marks()).length, (await T.apiJson('/api/confirms')).length];
T.ok('答完卡片收起，纸上的框去掉，服务器上不再有待答的卡片', left1[0] && left1[1] === 0 && left1[2] === 0, left1);

// 2. 候选都不对：在输入框里自己写一个不在候选里的字
const c2 = await ask({ submission: scan.id, page: 1, questions: [{ anchor: 'g2', guess: 'x', options: ['y'], question: '是 x 还是 y？' }] });
await cardUp(c2.id);
const w2 = wait(c2.id);
await T.tap('#qcBody .cq input');
await T.cdp('Input.insertText', { text: '∂' });
await T.sleep(300);
const typed = await firstRow();
T.ok('在输入框里写了字：候选都不亮，按钮变成「回答」', Boolean(typed) && typed.input === '∂' && typed.on.length === 0 && (await okText()) === '回答', typed);
await T.tap('#confirmOk');
const a2 = await w2;
T.ok('自己写的读法 Claude 也拿到了', Boolean(a2.answers) && a2.answers[0].text === '∂' && a2.text.includes('（你读成「x」） → 是「∂」'), a2);
await cardGone();

// 3. 没有笔迹编号、按纸上一块位置问（不带投递编号：问的是平板当前这一页）；什么都不填就是跳过
const box = [100, 240, 440, 280];
const c3 = await ask({ questions: [{ box, question: '这一块写的是什么？' }] });
await cardUp(c3.id);
const m3 = await marks(), s3 = await snippet(0);
T.ok('按位置问的：纸上框出那一块，卡片里有那一块的截图', m3.length === 1 && around(m3[0], box) && m3[0].seen && Boolean(s3) && s3.dark > 50, { m3, s3 });
const w3 = wait(c3.id);
await T.tap('#confirmOk');
const a3 = await w3;
T.ok('什么都不填直接点「看不清，跳过」：Claude 拿到的是跳过', Boolean(a3.answers) && a3.answers[0].skip === true && !a3.answers[0].text
  && a3.text.includes('我没有回答（跳过了）'), a3);
await cardGone();

// 4. 问的不是平板当前这一页：卡片上有「翻到那页」
const c4 = await ask({ submission: scan.id, page: 2, questions: [{ anchor: 'g1', guess: 'k', options: ['h'], question: '是 k 吗？' }] });
await cardUp(c4.id);
const go = await T.evalJS(`[...document.querySelectorAll('#qcBody > .q button')].map((b) => b.textContent)`);
T.ok('卡片写着是第 2 页，带「翻到那页」；这时纸上没有框', (await T.text('#qcBody > .q')).includes('草稿本第 2 页') && go.join() === '翻到那页'
  && (await T.visible('#qcBody > .q button')) && (await marks()).length === 0, go);
await T.tap('#qcBody > .q button');
const flipped = await T.waitFor(`window.__ink.S.idx === 1 && document.querySelectorAll('#aiRoot .confirm-mark').length === 1`);
const m4 = await marks();
T.ok('点「翻到那页」翻到了第 2 页，那一处被框出来', flipped && around(m4[0], g2nd.g1) && m4[0].seen, { idx: await T.evalJS(`window.__ink.S.idx`), m4 });

// 5. Claude 等太久不等了；之后用户才答：作为一条新消息送进对话
const p4 = await wait(c4.id, { wait: 0.3, last: true });
T.ok('还没答时 Claude 那边先得到「还没答」，卡片留在平板上', p4.pending === true && (await T.visible('#qcard')), p4);
await tapOption(0, 'k');
await T.tap('#confirmOk');
const late = await T.waitSub(sid);
T.ok('之后答了：对话收到一条【草稿纸·确认】消息，写着哪一页、读法是什么', Boolean(late) && late.text.startsWith('【草稿纸·确认】') && late.text.includes('草稿本第 2 页')
  && late.text.includes('g1：是 k 吗？（你读成「k」） → 对，是「k」'), late && late.text);

// 6. 更正过的读法记在电脑上，下次投递带上「你以前读错过的」
const file = join(T.DATA, 'corrections.json');
const pairs = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []).map((r) => `${r.guess}→${r.text}`);
T.ok('更正表里记了改过的两条（ρ→p、x→∂），答「对」的和跳过的不记', pairs.length === 2 && pairs.includes('ρ→p') && pairs.includes('x→∂'), pairs);
await cardGone();
await T.pen(T.line(150, 460, 220));
await T.tap('#check');
const sub = await T.waitSub(sid);
T.ok('下次点「AI」交上去的消息里带着「你以前读错过的」', Boolean(sub) && sub.text.startsWith('【草稿纸】') && sub.text.includes('你以前读错过的（我在确认卡片上更正的）：')
  && sub.text.includes('「ρ」→「p」') && sub.text.includes('「x」→「∂」'), sub && sub.text);

// 7. 「稍后」：卡片缩成顶上一小条，纸上的框去掉；全屏时也点得到小条，点它卡片再展开（以前全屏时收起就没处再打开）
const c7 = await ask({ submission: scan.id, page: 2, questions: [{ anchor: 'g1', guess: 'm', question: '是 m 吗？' }] });
await cardUp(c7.id);
await T.tap('#qcLater');
const bar7 = await rect('#qbar'), chips7 = await rect('#chipRow');
T.ok('全屏时点「稍后」：卡片收起成顶上一小条，纸上的框去掉', (await T.evalJS(`document.body.classList.contains('collapsed')`)) && !(await T.visible('#qcard'))
  && (await T.visible('#qbar')) && (await marks()).length === 0, { bar7 });
T.ok('小条上写着谁想确认字迹，在左上角那一排下面', (await T.text('#qbar')).includes('idea 想确认字迹') && Boolean(bar7 && chips7) && bar7.t >= chips7.b && !meets(bar7, chips7),
  { text: await T.text('#qbar'), bar7, chips7 });
await T.tap('#qbar');
const again = { card: await T.visible('#qcard'), bar: await T.visible('#qbar'), q: await T.text('#qcBody .cq > .q'), marks: (await marks()).length };
T.ok('全屏时点小条：卡片又出来（还是那一问），纸上的框回来，不用退出全屏', again.card && !again.bar && again.q.includes('是 m 吗？') && again.marks === 1
  && (await T.evalJS(`document.body.classList.contains('collapsed')`)), again);
const w7 = wait(c7.id);
await tapOption(0, 'm');
await T.tap('#confirmOk');
const a7 = await w7;
T.ok('再打开后照常能答', Boolean(a7.answers) && a7.answers[0].text === 'm' && a7.text.includes('对，是「m」'), a7);
T.ok('都答完后卡片和小条都没了', await cardGone());

// 8. 截图后到：卡片先按截图的大小留好位置，图到了卡片不跳高、按钮不挪（拦下截图的请求，过一会儿再放行）
const heldImgs = [];
T.onCdp('Fetch.requestPaused', (p) => heldImgs.push(p.requestId));
await T.cdp('Fetch.enable', { patterns: [{ urlPattern: '*confirm-img*', requestStage: 'Request' }] });
const c8 = await ask({ submission: scan.id, page: 1, questions: [{ anchor: 'g1', guess: 'v', question: '是 v 吗？' }] });
await T.waitFor(`window.__ink.S.qShown === ${JSON.stringify(c8.id)} && !document.querySelector('#qcard').hidden`);
await T.sleep(800);
const before8 = { held: heldImgs.length, card: await rect('#qcard'), img: await rect('#qcBody img'), ok: await rect('#confirmOk'),
  loaded: await T.evalJS(`[...document.querySelectorAll('#qcBody img')].map((i) => i.complete && i.naturalWidth > 0)`) };
for (const id of heldImgs.splice(0)) await T.cdp('Fetch.continueRequest', { requestId: id });
await T.waitFor(`[...document.querySelectorAll('#qcBody img')].every((i) => i.complete && i.naturalWidth > 0)`);
await T.sleep(300);
const after8 = { card: await rect('#qcard'), img: await rect('#qcBody img'), ok: await rect('#confirmOk') };
await T.cdp('Fetch.disable');
T.ok('截图还没到时已经留好了位置', before8.held === 1 && JSON.stringify(before8.loaded) === '[false]' && Boolean(before8.img) && before8.img.h > 40, before8);
T.ok('截图到了：卡片不跳高，「回答」按钮不挪', Boolean(after8.card && before8.card) && Math.abs(after8.card.h - before8.card.h) < 1.5
  && Math.abs(after8.img.h - before8.img.h) < 1.5 && Math.abs(after8.ok.t - before8.ok.t) < 1.5, { before8, after8 });
const w8 = wait(c8.id);
await T.tap('#confirmOk');
await w8;
await cardGone();

// 9. 字迹确认卡片和问话卡片排同一个队：先来的先显示，小条上写还有几张；答了这张，下一张落下
const c9 = await ask({ submission: scan.id, page: 1, questions: [{ anchor: 'g1', guess: 'w', question: '是 w 吗？' }] });
await cardUp(c9.id);
await T.sleep(300);
const q9 = await T.post('/bridge/ask', { sid, question: '接着改哪一处？', options: ['第一处'] });
await T.waitFor(`window.__ink.S.cards.length === 2`);
await T.pen(T.line(150, 1150, 200)); // 在纸上（卡片下面）落笔：缩成小条
T.ok('两种卡片一个队：确认卡片在前，小条上写还有 1 张', (await T.evalJS(`window.__ink.S.cards.map((c) => c.kind).join()`)) === 'confirm,question'
  && (await T.visible('#qbar')) && (await T.text('#qbar')).includes('还有 1 张'), await T.text('#qbar'));
await T.tap('#qbar');
const w9 = wait(c9.id);
await T.tap('#confirmOk');
await w9;
const next9 = await T.waitFor(`window.__ink.S.qShown === ${JSON.stringify(q9.id)} && !document.querySelector('#qcard').hidden`);
T.ok('答了确认卡片，问话卡片落下来', next9 && (await T.text('#qcHead')) === 'idea 问你' && (await T.text('#qcBody .qc-q')) === '接着改哪一处？');
const a9 = T.post('/bridge/ask-wait', { id: q9.id, wait: 20 });
await T.tap('#qcBody .qc-opts button');
T.ok('问话卡片照常能答', ((await a9).answer || {}).choice === '第一处');
T.ok('都答完了', await cardGone());

// 10. 电脑上的服务还是没有问话卡片的旧版本（/api/asks 回 404）、页面已经是新的：字迹确认卡片照样出来
T.onCdp('Fetch.requestPaused', (p) => {
  if (p.request.url.includes('/api/asks')) {
    T.cdp('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 404, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify({ error: 'not found' })).toString('base64') }).catch(() => {});
  }
});
await T.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/asks*', requestStage: 'Request' }] });
await T.reload();
const c10 = await ask({ submission: scan.id, page: 1, questions: [{ anchor: 'g1', guess: 'z', question: '是 z 吗？' }] });
T.ok('取不到问话卡片的列表时，字迹确认卡片照样出来', (await cardUp(c10.id)) && (await T.text('#qcHead')) === 'idea 想确认字迹', await T.text('#qcHead'));
const w10 = wait(c10.id);
await T.tap('#confirmOk');
T.ok('照样能答', Boolean((await w10).answers) && (await cardGone()));
await T.cdp('Fetch.disable');

await T.finish();

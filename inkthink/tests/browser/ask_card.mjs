// 问话卡片（2026-11-14，阶段 C）：Claude 用 ink_ask 发到平板顶上的卡片。从屏幕顶上落下、居中，不挡左上角那一排和右下角那一条；
// 点一个选项就是回答；用笔写在卡片里那一小块纸上，交的是笔迹的图；在纸上落笔，卡片缩成顶上一小条（那一笔照常写上），点小条再展开；
// 一次一张、其余排队，小条上写还有几张；没答时工具先得到「还没答」，之后答了作为一条新消息送进对话；结果卡片点「知道了」消失、工具不等；
// 平板不在线时马上告诉工具；刷新后没答的还在；全屏、退出全屏都摆得对；英文界面的按钮字。
// 这里站在插件的位置上直接调服务的 /bridge/ask、/bridge/ask-wait（插件那一侧连着等几次、共约一分半，由插件测试管）。
// 跑法：node tests/browser/ask_card.mjs [临时目录]；有一项不对退出码 1。
import { boot } from '../browser_lib.mjs';
import { existsSync, readFileSync } from 'node:fs';

const T = await boot({ name: 'ask-card' });
const sid = 'S1';
const js = T.evalJS;

// ---- 这个测试自己用的小工具
const ask = async (body) => { await T.sleep(300); return T.post('/bridge/ask', Object.assign({ sid }, body)); };
const wait = (id, o) => T.post('/bridge/ask-wait', Object.assign({ id, wait: 20 }, o));
// 等这张卡片落下来（落下的动画 0.24 秒，等它停稳再量）
const cardUp = async (id) => {
  const up = await T.waitFor(`window.__ink.S.qShown === ${JSON.stringify(id)} && !document.querySelector('#qcard').hidden`);
  await T.sleep(400);
  return up;
};
const allGone = () => T.waitFor(`document.querySelector('#qcard').hidden && document.querySelector('#qbar').hidden && !window.__ink.S.cards.length`);
const rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null;
  const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
const meets = (a, b) => Boolean(a && b) && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const vw = await js(`document.documentElement.clientWidth`);
const centered = (r) => Boolean(r) && Math.abs((r.l + r.r) / 2 - vw / 2) < 2;
// 卡片（或小条）摆得对：顶上、居中，不挡左上角那一排、顶栏、右下角那一条
const placed = async (sel) => {
  const me = await rect(sel), chips = await rect('#chipRow'), bar = await rect('#bar'), tools = await rect('#tools');
  return { ok: Boolean(me) && centered(me) && me.t < 140 && !meets(me, chips) && !meets(me, bar) && !meets(me, tools)
    && (!chips || me.t >= chips.b) && (!bar || me.t >= bar.b), me, chips, bar, tools };
};
// 真的点一下卡片里写着某些字的按钮
const tapButton = async (scope, text, wait = 400) => {
  const c = await js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find((x) => x.textContent === ${JSON.stringify(text)});
    if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (c) await T.tapAt(c[0], c[1], wait);
  return Boolean(c);
};
// 用笔在屏幕上画一笔（屏幕坐标）
const penScreen = async (pts, wait = 250) => {
  const base = { pointerType: 'pen', button: 'left' };
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: pts[0][0], y: pts[0][1], buttons: 1, clickCount: 1 }, base));
  for (const p of pts.slice(1)) await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: p[0], y: p[1], buttons: 1 }, base));
  const l = pts[pts.length - 1];
  await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: l[0], y: l[1], buttons: 0, clickCount: 1 }, base));
  await T.sleep(wait);
};
// 一张 PNG 里深色的点和白色的点各多少（在页面里解码）
const pngInk = (file) => js(`(async () => { const im = new Image(); im.src = 'data:image/png;base64,${readFileSync(file).toString('base64')}';
  await im.decode(); const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let dark = 0, white = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i] + d[i + 1] + d[i + 2] < 200) dark++; else if (d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245) white++; }
  return { w: c.width, h: c.height, dark, white }; })()`);
const headText = () => T.text('#qcHead');

// 0. 纸上先写一笔
await T.pen(T.line(120, 900, 300));
await T.saved();
const n0 = await T.strokes();
T.ok('准备好了：全屏，纸上一笔', n0 === 1 && (await js(`document.body.classList.contains('collapsed')`)), n0);

// 1. 问题卡片：问的话、两个选项、手写那一小块纸。从顶上落下、居中，不挡左上角那一排和右下角那一条
const q1 = await ask({ question: '改动覆盖原文件，还是另存一份？', options: ['覆盖', '另存'] });
T.ok('插件发得出去：拿到卡片编号', Boolean(q1.id) && q1.tabletOnline === true, q1);
T.ok('平板上落下一张卡片，写着是哪个对话在问', (await cardUp(q1.id)) && (await headText()) === 'idea 问你', await headText());
const look = await js(`(() => { const q = document.querySelector('#qcBody .qc-q'), cs = getComputedStyle(q), card = getComputedStyle(document.querySelector('#qcard'));
  return { q: q.textContent, font: cs.fontFamily, color: cs.color, bg: card.backgroundColor, border: card.borderTopWidth,
    opts: [...document.querySelectorAll('#qcBody .qc-opts button')].map((b) => b.textContent),
    pad: Boolean(document.querySelector('#qcBody canvas.qc-pad')), hint: (document.querySelector('#qcBody .qc-padhint') || {}).textContent,
    foot: [...document.querySelectorAll('#qcFoot > button')].map((b) => b.textContent + (b.disabled ? '（灰）' : '')),
    left: [...document.querySelectorAll('#qcFoot .qc-left button')].filter((b) => !b.hidden).map((b) => b.textContent) }; })()`);
T.ok('卡片上：问的话是蓝色手写体，白底细框', look.q === '改动覆盖原文件，还是另存一份？' && /Xiaolai/.test(look.font) && look.color === 'rgb(47, 95, 174)'
  && look.bg === 'rgb(255, 255, 255)' && look.border === '1px', look);
T.ok('两个选项是文字按钮；下面一小块纸可以手写，「重写」「交回答」在写之前是灰的；左下角是「忽略」（只有一张，没有「全部忽略」）',
  JSON.stringify(look.opts) === '["覆盖","另存"]' && look.pad && look.hint === '或者用笔写在下面' && JSON.stringify(look.foot) === '["重写（灰）","交回答（灰）"]'
  && JSON.stringify(look.left) === '["忽略"]', look);
let at = await placed('#qcard');
T.ok('卡片在顶上居中，在左上角那一排下面，不挡它、也不挡右下角那一条', at.ok, at);
T.ok('右下角那一条照样点得到（卡片没盖住它）', await js(`(() => { const r = document.querySelector('#tools').getBoundingClientRect();
  return document.querySelector('#tools').contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })()`));
await T.shot('1-ask-card.png');

// 点一个选项：那个按钮白底加粗边框，工具那边收到这个选项，卡片消失
const w1 = wait(q1.id);
await tapButton('#qcBody .qc-opts', '另存', 60);
const lit = await js(`(() => { const b = document.querySelector('#qcBody .qc-opts button.on'); if (!b) return null; const cs = getComputedStyle(b);
  return { t: b.textContent, bg: cs.backgroundColor, border: cs.borderTopColor }; })()`);
T.ok('点了的选项白底加粗边框', Boolean(lit) && lit.t === '另存' && lit.bg === 'rgb(255, 255, 255)' && lit.border === 'rgb(34, 34, 34)', lit);
const a1 = await w1;
T.ok('工具那边收到点的选项', Boolean(a1.answer) && a1.answer.choice === '另存' && a1.text === '我点了「另存」。', a1);
T.ok('答完卡片消失，服务器上不再有这张', (await allGone()) && (await T.apiJson('/api/asks')).length === 0);

// 2. 手写回答：用笔写在卡片里那一小块纸上，交的是笔迹的图；纸上不多一笔，卡片也不缩
const q2 = await ask({ question: '这一步的 x 等于几？写一下' });
await cardUp(q2.id);
T.ok('只能手写的问题：没有选项，提示写在下面', (await T.count('#qcBody .qc-opts button')) === 0 && (await T.text('#qcBody .qc-padhint')) === '用笔写在下面');
const pad = await rect('#qcBody .qc-pad');
const inPad = (fx, fy) => [pad.l + pad.w * fx, pad.t + pad.h * fy];
await T.tool('red'); // 红笔也行，写出来是黑字
await penScreen(Array.from({ length: 12 }, (_, i) => inPad(0.1 + i * 0.03, 0.3 + (i % 3) * 0.12)));
await T.tool('pen');
await penScreen(Array.from({ length: 10 }, (_, i) => inPad(0.55 + i * 0.03, 0.7 - i * 0.03)));
const padState = await js(`({ n: window.__ink.S.qPad.length, send: !document.querySelector('#qcSend').disabled, min: window.__ink.S.qMin })`);
T.ok('写在那一小块纸上：两笔记下了，「交回答」能点了，卡片没缩', padState.n === 2 && padState.send && !padState.min, padState);
T.ok('写在卡片里的不算纸上的笔迹', (await T.strokes()) === n0, await T.strokes());
await T.shot('2-handwriting.png');
const w2 = wait(q2.id);
await T.tap('#qcSend');
const a2 = await w2;
const img = a2.answer && a2.answer.image;
T.ok('工具那边收到一张图的路径，让 Claude 用 Read 看图', Boolean(img) && existsSync(img) && a2.text.includes(img) && a2.text.includes('用 Read 看这张图'), a2);
const ink2 = img ? await pngInk(img) : null;
T.ok('图里有笔迹：白底上有深色的线', Boolean(ink2) && ink2.dark > 80 && ink2.white > ink2.w * ink2.h * 0.8, ink2);
T.ok('交了之后卡片消失', await allGone());

// 3. 在纸上落笔：卡片缩成顶上一小条，那一笔照常写上；点小条再展开。两张排队：小条上写还有几张，答完一张下一张落下
const q3 = await ask({ question: '先做哪一个？', options: ['甲', '乙'] });
await cardUp(q3.id);
const q4 = await ask({ question: '第二个问题：要不要接着改？', options: ['好'] });
await T.sleep(800);
T.ok('第二张排在后面：显示的还是第一张', (await js(`window.__ink.S.cards.map((c) => c.id).join()`)) === `${q3.id},${q4.id}` && (await js(`window.__ink.S.qShown`)) === q3.id);
await T.pen(T.line(150, 1000, 260));
const mini = { card: await T.visible('#qcard'), bar: await T.visible('#qbar'), strokes: await T.strokes() };
T.ok('在纸上落笔：卡片缩成小条，那一笔照常写在纸上', !mini.card && mini.bar && mini.strokes === n0 + 1, mini);
const barText = await T.text('#qbar');
T.ok('小条上写着谁在问、问的开头，还有 1 张', barText.includes('idea 问：') && barText.includes('先做哪一个？') && barText.includes('还有 1 张'), barText);
at = await placed('#qbar');
T.ok('小条在顶上居中，不挡左上角那一排和右下角那一条', at.ok, at);
await T.shot('3-bar-two.png');
await T.fingerTapAt(400, 700);
T.ok('手指点纸面不展开也不出别的', !(await T.visible('#qcard')) && (await T.visible('#qbar')));
await T.tap('#qbar');
T.ok('点小条：卡片展开（还是那一张），小条收起', (await T.visible('#qcard')) && !(await T.visible('#qbar')) && (await T.text('#qcBody .qc-q')) === '先做哪一个？');
await T.fingerTapAt(400, 1100);
T.ok('手指（挪纸、搭着的手掌）落在纸上不收卡片', await T.visible('#qcard'));
const w3 = wait(q3.id);
await tapButton('#qcBody .qc-opts', '甲');
const a3 = await w3;
T.ok('答了第一张：工具收到「甲」', Boolean(a3.answer) && a3.answer.choice === '甲', a3);
T.ok('第一张消失，下一张落下来（展开着）', (await cardUp(q4.id)) && (await T.text('#qcBody .qc-q')) === '第二个问题：要不要接着改？' && !(await T.visible('#qbar')));

// 4. 等太久：工具先得到「还没答」，卡片留着；之后答了，对话收到一条新消息
const p4 = await wait(q4.id, { wait: 0.3 });
const p4b = await wait(q4.id, { wait: 0.3, last: true });
T.ok('没答时工具那边先得到「还没答」，卡片还在平板上', p4.pending === true && p4b.pending === true && (await T.visible('#qcard')), [p4, p4b]);
await tapButton('#qcBody .qc-opts', '好');
const late = await T.waitSub(sid);
T.ok('之后答了：对话收到一条【草稿纸·回答】消息，写着问的是什么、点了什么', Boolean(late) && late.text.startsWith('【草稿纸·回答】')
  && late.text.includes('「第二个问题：要不要接着改？」') && late.text.includes('我点了「好」'), late && late.text);
await allGone();

// 5. 结果卡片：发出去工具马上返回；点「知道了」消失，不告诉对话
await T.sleep(1600); // 等上一张答完的「已告诉 Claude」提示过去，截图看得清
const t5 = Date.now();
const r5 = await ask({ result: '三条路线的对比：\n第一条路最短\n\n第二条最便宜' });
T.ok('结果卡片发出去马上返回', Boolean(r5.id) && Date.now() - t5 < 2000, r5);
await cardUp(r5.id);
const res = await js(`({ head: document.querySelector('#qcHead').textContent, text: document.querySelector('#qcBody .qc-text').innerText,
  foot: [...document.querySelectorAll('#qcFoot button')].filter((b) => !b.hidden).map((b) => b.textContent), pad: Boolean(document.querySelector('#qcBody .qc-pad')) })`);
T.ok('结果卡片：写着谁的结果、整段文字，只有「知道了」（没有「忽略」）', res.head === 'idea 的结果' && res.text.includes('第一条路最短') && res.text.includes('第二条最便宜')
  && JSON.stringify(res.foot) === '["知道了"]' && !res.pad, res);
await T.shot('4-result.png');
await T.tap('#qcSeen');
T.ok('点「知道了」：卡片消失，服务器上也没有了', (await allGone()) && (await T.apiJson('/api/asks')).length === 0);
await T.sleep(500);
T.ok('看过结果不告诉对话', !(await T.poll(sid)));

// 6. 刷新以后，没答的卡片还在
const q6 = await ask({ question: '刷新以后还在吗？', options: ['选项甲', '选项乙'] });
await cardUp(q6.id);
await T.reload();
T.ok('刷新后没答的卡片还在（还是那一张）', await cardUp(q6.id), await js(`window.__ink.S.qShown`));

// 7. 全屏、退出全屏：卡片都在顶上居中，不挡上面的东西
at = await placed('#qcard');
T.ok('全屏时：卡片在左上角那一排下面', at.ok && Boolean(at.chips), at);
await T.shot('5-fullscreen.png');
await T.tap('#toolsBars', 800);
const rail = await rect('#rail');
at = await placed('#qcard');
T.ok('退出全屏：卡片在顶栏下面、居中，不挡顶栏和左侧工具栏', at.ok && Boolean(at.bar) && !meets(at.me, rail), { at, rail });
await T.shot('6-bars.png');
await T.tap('#qcLater');
at = await placed('#qbar');
T.ok('退出全屏时点「稍后」：缩成顶栏下面的小条', !(await T.visible('#qcard')) && at.ok, at);
await T.tap('#qbar');
await T.tap('#fsBtn', 800);
at = await placed('#qcard');
T.ok('回到全屏：卡片又在左上角那一排下面', (await js(`document.body.classList.contains('collapsed')`)) && at.ok && Boolean(at.chips), at);

// 8. 英文界面：按钮和头一行是英文，Claude 写的问题和选项不翻译
await T.go('&lang=en');
await cardUp(q6.id);
const q7 = await ask({ question: 'Second one', options: ['A'] });
await T.sleep(800);
const en = await js(`({ head: document.querySelector('#qcHead').textContent, later: document.querySelector('#qcLater').textContent,
  foot: [...document.querySelectorAll('#qcFoot > button')].map((b) => b.textContent), hint: document.querySelector('#qcBody .qc-padhint').textContent,
  left: [...document.querySelectorAll('#qcFoot .qc-left button')].filter((b) => !b.hidden).map((b) => b.textContent),
  q: document.querySelector('#qcBody .qc-q').textContent, opts: [...document.querySelectorAll('#qcBody .qc-opts button')].map((b) => b.textContent) })`);
T.ok('英文：头一行、「稍后」「重写」「交回答」「忽略」「全部忽略（2 张）」和提示是英文', en.head === 'idea asks you' && en.later === 'Later' && JSON.stringify(en.foot) === '["Clear","Send answer"]'
  && en.hint === 'Or write your answer below with the pen' && JSON.stringify(en.left) === '["Ignore","Ignore all (2)"]', en);
T.ok('英文：Claude 写的问题和选项不翻译', en.q === '刷新以后还在吗？' && JSON.stringify(en.opts) === '["选项甲","选项乙"]', en);
await T.tap('#qcLater');
const enBar = await T.text('#qbar');
T.ok('英文：小条上写「idea asks:」和「1 more」', enBar.includes('idea asks:') && enBar.includes('刷新以后还在吗？') && enBar.includes('1 more'), enBar);
await T.tap('#qbar');
await tapButton('#qcBody .qc-opts', '选项甲');
await cardUp(q7.id);
await tapButton('#qcBody .qc-opts', 'A');
T.ok('英文：两张都答完', await allGone());
await T.go('');

// 9. 平板不在线：工具马上得到「不在线」，卡片不排队到以后
await T.cdp('Page.navigate', { url: 'about:blank' });
let online = true;
for (let i = 0; i < 60 && online; i++) { await T.sleep(1000); online = (await T.get(`/bridge/status?sid=${sid}`)).tabletOnline; }
const t9 = Date.now();
const off = await T.post('/bridge/ask', { sid, question: '在吗？', options: ['在'] });
T.ok('平板关了：工具马上得到「平板不在线」，没有排队的卡片', !online && off.offline === true && !off.id && Date.now() - t9 < 2000
  && (await T.apiJson('/api/asks')).length === 0, { online, off });

await T.finish();

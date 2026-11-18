// 新文件提示（阶段 D2，《产品定义》第 7 节第 5 条）：Claude 在对话里生成了新文件（插件报给电脑：/bridge/offer），
// 平板屏幕上方出一条「Claude 生成了某某 [加入] [忽略]」，约 8 秒后自己收起；一次来了几个合成一条（[在抽屉里看] [忽略这 N 个]）；
// 没处理的列在抽屉最上面的「新文件」一组，☰ 上带一个小圆点；条数多时这一组限高、在里面滑，不把下面那两组开关挤下去；
// 按钮写清做什么、去哪（更新《某本》、替换《某本》、另加一本）；加入后打开那一本、提示消失（单张图、单页 PDF 也自己成一本，
// 不进「Claude 推送」）；文件已经不在了如实说；这一条不压顶上的问话卡片，出现、收起都不打断正在写的一笔。
// 截图存在 <临时目录>/offers/out/ 下。
// 跑法：node tests/browser/offers.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { boot, PY } from '../browser_lib.mjs';

const T = await boot({ name: 'offers', open: false });
const js = T.evalJS, sleep = T.sleep, SRC = join(T.ROOT, 'src');
mkdirSync(SRC, { recursive: true });
// 准备文件：几张图、一页的 PDF、两页的 PDF、导入过的两本（一本的原文件之后改了，一本之后来了新版本）
// 同一个文件同一版本只提示一次（忽略过的也不再提示）：每一步用自己的几个文件
const MANY = ['苹果', '香蕉', '西瓜', '葡萄', '橙子', '草莓', '桃子', '梨'];
const OTHER = ['早餐', '午饭', '晚饭', '水果', '零食', '饮料', '牛奶', '面包', '调料', '日用品'];
execFileSync(PY, ['-c', `import pymupdf as fitz,sys,os
src=sys.argv[1]
def pdf(name, texts, w=595, h=842):
    doc=fitz.open()
    for t in texts:
        p=doc.new_page(width=w,height=h); p.insert_text((72,100),t,fontsize=20)
    doc.save(os.path.join(src,name))
def png(name, rgb):
    pix=fitz.Pixmap(fitz.csRGB, fitz.IRect(0,0,300,200), 0); pix.set_rect(pix.irect,rgb); pix.save(os.path.join(src,name))
png('周末安排.png',(200,220,255)); png('临时.png',(255,230,200))
for i,n in enumerate(sys.argv[2:]): png(n+'.png',(100+i*8,200,180))
pdf('一页说明.pdf',['one page']); pdf('买菜清单.pdf',['eggs','greens'])
pdf('旅行计划_v1.pdf',['Day 1: park','Day 2: museum'],960,540); pdf('旅行计划_v2.pdf',['Day 1: park','Day 2: museum and lake'],960,540)
pdf('例会纪要.pdf',['Monday meeting'])`, SRC, ...MANY, ...OTHER]);
await T.post('/bridge/import', { sid: 'S1', path: join(SRC, '旅行计划_v1.pdf') });
await T.post('/bridge/import', { sid: 'S1', path: join(SRC, '例会纪要.pdf') });
await T.go();
await T.openNotebook('scratch', 0);

// ---- 小工具
const offer = async (...names) => { const r = await T.post('/bridge/offer', { sid: 'S1', files: names.map((n) => ({ path: join(SRC, n) })) }); await sleep(300); return r; };
const pending = async () => (await T.apiJson('/api/offers')).map((o) => o.name).sort();
const barUp = () => T.waitFor(`!document.querySelector('#offerBar').hidden`, 5000);
const barText = () => js(`document.querySelector('#obText').textContent`);
const barBtns = () => js(`[...document.querySelectorAll('#obBtns button')].map((b) => b.textContent)`);
const rows = () => js(`[...document.querySelectorAll('#offerList .of-item')].map((r) => ({ name: r.querySelector('.of-name').textContent, meta: r.querySelector('.of-meta').textContent,
  btns: [...r.querySelectorAll('.of-acts button')].map((b) => b.textContent) }))`);
const dots = () => js(`[...document.querySelectorAll('.new-dot')].map((d) => !d.hidden)`);
const rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.hidden || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })()`);
const meet = (a, b) => Boolean(a && b) && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const toastText = () => js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
const installLog = () => js(`(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (!t.hidden) window.__toasts.push(t.textContent); })
  .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true, attributes: true }); return 1; })()`);
const toasts = () => js(`window.__toasts.slice()`);
// 真的点一下某处里写着某些字的按钮
const tapButton = async (scope, text, wait = 600) => {
  const c = await js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find((x) => x.textContent === ${JSON.stringify(text)} && x.getClientRects().length);
    if (!b) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (c) await T.tapAt(c[0], c[1], wait);
  return Boolean(c);
};
const openDrawer = async () => { if (!(await T.visible('#drawer'))) await T.tap((await T.visible('#nbChip')) ? '#nbChip' : '#drawerBtn', 600); };
const closeDrawer = async () => { if (await T.visible('#drawer')) await T.tap((await T.visible('#nbChip')) ? '#nbChip' : '#drawerBtn', 500); };
const dismissAll = async () => { await T.api('/api/offer-dismiss', { method: 'POST', body: JSON.stringify({ all: true }) }); await sleep(600); };
const vw = await js(`document.documentElement.clientWidth`);
await installLog();

// 1. 没有新文件：上方那一条、抽屉那一组、小圆点都没有；自己收起的时间是 8 秒
T.ok('没有新文件时：上方那一条、抽屉那一组、☰ 上的小圆点都没有', (await js(`document.querySelector('#offerBar').hidden && document.querySelector('#offerBox').hidden`)) && (await dots()).every((d) => !d), await dots());
T.ok('上方那一条约 8 秒后自己收起（S.offerMs）', (await js('window.__ink.S.offerMs')) === 8000, await js('window.__ink.S.offerMs'));
await js('window.__ink.S.offerMs = 3000'); // 测试里等 3 秒

// 2. 一张图：上方出一条，写着文件名，[加入] [忽略]；在左上角那一排下面、居中，不挡那一排和右下角那一条
await offer('周末安排.png');
T.ok('Claude 生成了一张图：上方出一条', await barUp(), null);
await sleep(400);
T.ok('写着「Claude 生成了 周末安排.png」，按钮是「加入」「忽略」', (await barText()) === 'Claude 生成了周末安排.png' && JSON.stringify(await barBtns()) === '["加入","忽略"]', [await barText(), await barBtns()]);
const b1 = await rect('#offerBar'), chips = await rect('#chipRow'), tools = await rect('#tools');
T.ok('在左上角那一排下面、左右居中，不挡那一排和右下角那一条', Boolean(b1) && b1[1] >= chips[3] && Math.abs((b1[0] + b1[2]) / 2 - vw / 2) < 2 && !meet(b1, chips) && !meet(b1, tools) && b1[1] < 140, { b1, chips, tools });
T.ok('左上角本子名上的 ☰ 带一个小圆点', await js(`!document.querySelector('#nbChip .new-dot').hidden`), await dots());
await T.shot('offer-bar.png');
await sleep(1500);
const still = !(await js(`document.querySelector('#offerBar').hidden`));
T.ok('过一会儿自己收起（没处理的进抽屉）', still && (await T.waitFor(`document.querySelector('#offerBar').hidden`, 4000)), still);

// 3. 抽屉最上面「新文件」一组：一行，文件名、哪个对话生成的、「加入」「忽略」；只有一个时没有「全部忽略」；下面那两组开关还在原处
await openDrawer();
const r1 = await rows();
T.ok('抽屉最上面「新文件（1）」：一行，写着文件名、来自哪个对话、「加入」「忽略」', (await T.visible('#offerBox')) && (await T.text('#offerHead')) === '新文件（1）' && r1.length === 1
  && r1[0].name === '周末安排.png' && /来自「idea」/.test(r1[0].meta) && JSON.stringify(r1[0].btns) === '["加入","忽略"]', r1);
T.ok('只有一个时没有「全部忽略」', !(await T.visible('#offerAll')), null);
const top1 = await rect('#offerBox'), view1 = await rect('#viewRow');
T.ok('「新文件」在最上面，连续 / 单页、适配宽度 / 整页那一行在它下面、整个看得见', Boolean(top1 && view1) && top1[3] <= view1[1] + 1 && view1[3] <= (await js('innerHeight')), { top1, view1 });
await T.shot('offer-drawer-1.png');
// 点「加入」：成了自己的一本（不放进「Claude 推送」），打开它；提示没了
await tapButton('#offerList', '加入', 400);
T.ok('点「加入」：这张图自己成了一本，打开了它的第 1 页', await T.waitFor(`window.__ink.S.nb && window.__ink.S.nb.id === 'book:周末安排.pdf' && window.__ink.S.idx === 0 && window.__ink.S.bgImg`, 15000),
  await js('window.__ink.S.nb && window.__ink.S.nb.id'));
await sleep(500);
T.ok('没有放进「Claude 推送」', !(await js(`window.__ink.S.nbList.some((n) => n.id.startsWith('board'))`)), await js(`window.__ink.S.nbList.map((n) => n.id)`));
T.ok('提示没了：抽屉那一组、小圆点都不出', (await pending()).length === 0 && (await js(`document.querySelector('#offerBox').hidden`)) && (await dots()).every((d) => !d), [await pending(), await dots()]);
T.ok('说了一句「已加入《周末安排》」', (await toasts()).includes('已加入《周末安排》'), await toasts());

// 4. 一页的 PDF：在上方那一条上点「加入」，也自己成一本
await offer('一页说明.pdf');
await barUp();
await tapButton('#obBtns', '加入', 400);
T.ok('一页的 PDF：在上方那一条上点「加入」，自己成了一本（一页），打开了它', await T.waitFor(`window.__ink.S.nb && window.__ink.S.nb.id === 'book:一页说明.pdf' && window.__ink.S.nb.pages === 1`, 15000),
  await js('window.__ink.S.nb && [window.__ink.S.nb.id, window.__ink.S.nb.pages]'));
T.ok('上方那一条收起了，也没进「Claude 推送」', (await js(`document.querySelector('#offerBar').hidden`)) && !(await js(`window.__ink.S.nbList.some((n) => n.id.startsWith('board'))`)), null);

// 5. 在上方那一条上点「忽略」：收起，不再提示
await offer('买菜清单.pdf');
await barUp();
await tapButton('#obBtns', '忽略');
T.ok('点「忽略」：那一条收起，这个文件不再提示', (await js(`document.querySelector('#offerBar').hidden`)) && (await pending()).length === 0, await pending());

// 6. 顶上有问话卡片时：这一条排在卡片上面，卡片挪到它下面，不叠；这一条收起后卡片挪回去
await T.post('/bridge/ask', { sid: 'S1', result: '周六的买菜清单整理好了：鸡蛋、青菜、牛奶。' });
await T.waitFor(`!document.querySelector('#qcard').hidden`, 8000);
await sleep(500);
const q0 = await rect('#qcard');
await offer('早餐.png');
await barUp();
await sleep(500);
const bq = await rect('#offerBar'), q1 = await rect('#qcard');
T.ok('有问话卡片时：这一条在上面，卡片挪到它下面，不叠', Boolean(bq && q1) && !meet(bq, q1) && q1[1] >= bq[3], { bq, q1 });
await js(`document.querySelector('#toast').hidden = true`); // 截图里不要上一步「已加入」那一句
await T.shot('offer-bar-with-card.png');
await T.waitFor(`document.querySelector('#offerBar').hidden`, 5000);
await sleep(300);
const q2 = await rect('#qcard');
T.ok('这一条收起后：卡片挪回原来的地方', Boolean(q2 && q0) && Math.abs(q2[1] - q0[1]) < 2, { q0, q2 });
await tapButton('#qcFoot', '知道了');
await dismissAll();

// 7. 正在写字的时候这一条出来、又收起：那一笔不断，照常写完
const n0 = await T.strokes();
const pts = Array.from({ length: 30 }, (_, i) => [150 + i * 15, 700 + (i % 2 ? -8 : 8)]), sp = [];
for (const p of pts) sp.push(await T.screenOf(p[0], p[1]));
const pen = { pointerType: 'pen', button: 'left' };
await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: sp[0][0], y: sp[0][1], buttons: 1, clickCount: 1 }, pen));
for (const p of sp.slice(1, 10)) await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: p[0], y: p[1], buttons: 1 }, pen));
await T.post('/bridge/offer', { sid: 'S1', files: [{ path: join(SRC, '午饭.png') }] });
const upMid = await barUp();
for (const p of sp.slice(10, 20)) await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: p[0], y: p[1], buttons: 1 }, pen));
const downMid = await T.waitFor(`document.querySelector('#offerBar').hidden`, 5000);
for (const p of sp.slice(20)) await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: p[0], y: p[1], buttons: 1 }, pen));
const l = sp[sp.length - 1];
await T.cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: l[0], y: l[1], buttons: 0, clickCount: 1 }, pen));
await sleep(400);
const last = await js(`(() => { const s = window.__ink.S.page.strokes[window.__ink.S.page.strokes.length - 1]; return { n: s.pts.length, x0: s.pts[0][0], x1: s.pts[s.pts.length - 1][0] }; })()`);
T.ok('写字的时候这一条出来又收起：那一笔是完整的一笔（从头到尾）', upMid && downMid && (await T.strokes()) === n0 + 1 && Math.abs(last.x0 - 150) < 3 && Math.abs(last.x1 - 585) < 3 && last.n >= 10,
  { upMid, downMid, n0, n: await T.strokes(), last });
await dismissAll();

// 8. 一次来了三个：合成一条；还开着时又来一个，并进同一条；「在抽屉里看」打开抽屉
await offer('晚饭.png', '水果.png', '零食.png');
await barUp();
await sleep(300);
const t3 = await barText();
T.ok('一次来了三个：一条，「Claude 生成了 某个 等 3 个文件」，按钮「在抽屉里看」「忽略这 3 个」', /^Claude 生成了.+等 3 个文件$/.test(t3) && JSON.stringify(await barBtns()) === '["在抽屉里看","忽略这 3 个"]', [t3, await barBtns()]);
T.ok('只有一条（不叠好几条）', (await T.count('#offerBar')) === 1, null);
await offer('饮料.png');
await sleep(300);
T.ok('还开着时又来一个：并进这一条，写「等 4 个文件」，文件名换成最新的那个', (await barText()) === 'Claude 生成了饮料.png等 4 个文件' && JSON.stringify(await barBtns()) === '["在抽屉里看","忽略这 4 个"]', [await barText(), await barBtns()]);
await tapButton('#obBtns', '在抽屉里看');
T.ok('点「在抽屉里看」：这一条收起，抽屉打开，「新文件」一组四行，有「全部忽略」', (await js(`document.querySelector('#offerBar').hidden`)) && (await T.visible('#drawer')) && (await rows()).length === 4 && (await T.visible('#offerAll')),
  [await rows(), await T.visible('#offerAll')]);
// 抽屉开着时又来了：不另出一条，抽屉里多一行
await offer('调料.png');
await sleep(500);
T.ok('抽屉开着时又来一个：上方不出那一条，抽屉里多一行', (await js(`document.querySelector('#offerBar').hidden`)) && (await rows()).length === 5, await rows());
await tapButton('#offerBox', '全部忽略');
await sleep(400);
T.ok('「全部忽略」：都不提示了，那一组和小圆点都没了', (await pending()).length === 0 && (await js(`document.querySelector('#offerBox').hidden`)) && (await dots()).every((d) => !d), [await pending(), await dots()]);
await closeDrawer();

// 9. 「忽略这 N 个」
await offer('牛奶.png', '面包.png');
await barUp();
await tapButton('#obBtns', '忽略这 2 个');
T.ok('点「忽略这 2 个」：这一条收起，两个都不提示了', (await js(`document.querySelector('#offerBar').hidden`)) && (await pending()).length === 0, await pending());

// 10. 某本的新版本、某本的原文件改过了：按钮写清做什么、去哪
await offer('旅行计划_v2.pdf');
await barUp();
T.ok('像某本的新版本：上方那一条的按钮是「替换《旅行计划_v1》」「忽略」', JSON.stringify(await barBtns()) === '["替换《旅行计划_v1》","忽略"]', await barBtns());
execFileSync(PY, ['-c', `import pymupdf as fitz,sys
doc=fitz.open(); p=doc.new_page(width=595,height=842); p.insert_text((72,100),"Monday meeting, changed",fontsize=20); doc.save(sys.argv[1])`, join(SRC, '例会纪要.pdf')]);
await offer('例会纪要.pdf');
await openDrawer();
const r10 = await rows(), rv = r10.find((r) => r.name === '旅行计划_v2.pdf'), ru = r10.find((r) => r.name === '例会纪要.pdf');
T.ok('抽屉里：新版本那行「替换《旅行计划_v1》」「另加一本」「忽略」', Boolean(rv) && JSON.stringify(rv.btns) === '["替换《旅行计划_v1》","另加一本","忽略"]', r10);
T.ok('抽屉里：原文件改过了那行「更新《例会纪要》」「忽略」', Boolean(ru) && JSON.stringify(ru.btns) === '["更新《例会纪要》","忽略"]', r10);
await tapButton('#offerList', '更新《例会纪要》', 400);
T.ok('点「更新《例会纪要》」：那本原地更新，打开它', await T.waitFor(`window.__ink.S.nb && window.__ink.S.nb.id === 'book:例会纪要.pdf'`, 15000), await js('window.__ink.S.nb && window.__ink.S.nb.id'));
await sleep(800);
T.ok('没说没加成', !(await toasts()).some((t) => t.startsWith('没加成')), await toasts());
await openDrawer();
await tapButton('#offerList', '替换《旅行计划_v1》', 400);
T.ok('点「替换《旅行计划_v1》」：换成了新版本，打开它', await T.waitFor(`window.__ink.S.nb && /旅行计划/.test(window.__ink.S.nb.id) && window.__ink.S.bgImg`, 15000), await js('window.__ink.S.nb && window.__ink.S.nb.id'));
await sleep(800);
T.ok('两个都处理掉了', (await pending()).length === 0, await pending());

// 11. 一下来了八个：抽屉里这一组限高、在里面滑，下面那两组开关不被挤下去
await T.openNotebook('scratch', 0);
await js(`document.querySelector('#toast').hidden = true`);
await offer(...MANY.map((n) => n + '.png'));
await barUp();
T.ok('八个：上方一条写「等 8 个文件」', /等 8 个文件$/.test(await barText()), await barText());
await openDrawer();
const many = await js(`(() => { const l = document.querySelector('#offerList'), d = document.querySelector('#drawer'), v = document.querySelector('#viewRow').getBoundingClientRect();
  return { rows: l.querySelectorAll('.of-item').length, sh: l.scrollHeight, ch: l.clientHeight, view: [v.top, v.bottom], ih: innerHeight, dTop: d.scrollTop }; })()`);
T.ok('抽屉里八行，这一组限高、在里面滑；连续 / 单页那一行整个看得见', many.rows === 8 && many.sh > many.ch + 20 && many.view[1] <= many.ih && many.dTop === 0 && many.view[0] < many.ih * 0.6, many);
await T.shot('offer-drawer-8.png');
await tapButton('#offerBox', '全部忽略');
await closeDrawer();

// 12. 文件提示出来以后文件被删了：点「加入」如实说，提示收掉
await offer('临时.png');
await barUp();
unlinkSync(join(SRC, '临时.png'));
await tapButton('#obBtns', '加入', 1500);
const tg = (await toasts()).find((t) => t.startsWith('没加成'));
T.ok('文件已经不在了：说「没加成：「临时.png」已经不在电脑上了…」，提示收掉了', Boolean(tg) && tg.includes('「临时.png」已经不在电脑上了') && (await pending()).length === 0, [tg, await pending()]);

// 13. 退出全屏后：这一条在顶栏下面，☰ 上带小圆点
await T.tap('#toolsBars', 800);
await offer('日用品.png');
await barUp();
await sleep(300);
const b13 = await rect('#offerBar'), bar = await rect('#bar');
T.ok('退出全屏：这一条在顶栏下面、不挡顶栏，顶栏的 ☰ 带小圆点', Boolean(b13 && bar) && b13[1] >= bar[3] && (await js(`!document.querySelector('#drawerBtn .new-dot').hidden`)), { b13, bar });

await T.finish();

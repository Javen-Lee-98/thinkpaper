// 整本检测和当前页快照（Claude 那一侧来取）：整本检测把一本里写过字的每一页画成图、附书写过程，
// 可以只要新写的页、指定页、放大一段，平板关着也能取；快照取平板当前这一页，要平板开着。
// 跑法：node tests/browser/scan_snapshot.mjs [临时目录]；有一项不对退出码 1。（要等平板「离线」，全程一分钟左右）
import { boot } from '../browser_lib.mjs';
import { existsSync, readFileSync, statSync } from 'node:fs';

const T = await boot({ name: 'scan-snapshot', pages: 3 });
const sid = 'S1';

// ---- 这个测试自己用的小工具
const scanRaw = async (body) => { const r = await T.postRaw('/bridge/scan', Object.assign({ sid }, body)); return Object.assign(await r.json(), { status: r.status }); };
// 消息里列的图（每页一行「图：路径（说明）」）；快照消息里图的路径写在「- 说明：路径」里
const scanImgs = (text) => text.split('\n').filter((l) => l.startsWith('图：')).map((l) => l.slice(2).split('（')[0]);
const anyImgs = (text) => text.match(/[A-Za-z]:\\[^\n（]*?\.(?:jpg|png)/g) || [];
const onDisk = (f) => existsSync(f) && statSync(f).size;
// 第 no 页那一段文字
const part = (text, no) => { const p = text.split('── 第 ').find((x) => x.startsWith(`${no} 页`)); return p ? p.split('\n\n')[0] : ''; };
// 把电脑上的一张图交给浏览器读像素：数深色（黑字）和偏红（红字）的点。空白页两样都是 0
const count = (f) => T.evalJS(`(async () => { const im = new Image();
  im.src = 'data:image/${f.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(f).toString('base64')}';
  await im.decode(); const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; const n = { w: c.width, h: c.height, dark: 0, reddish: 0 };
  for (let i = 0; i < d.length; i += 4) { if (d[i] + d[i + 1] + d[i + 2] < 150) n.dark++; if (d[i] - d[i + 1] > 50 && d[i] - d[i + 2] > 50) n.reddish++; }
  return n; })()`);

// 0. 准备：第 1 页黑笔一组、红笔一组；第 2 页不写；第 3 页黑笔一组。平板停在第 3 页
await T.pen(T.line(120, 200, 300));
await T.tap('#tools [data-tool=red]');
await T.pen(T.line(120, 520, 200));
await T.tap('#tools [data-tool=pen]');
await T.openPage(2);
await T.pen(T.line(150, 300, 220));
await T.saved();

// 1. 整本检测（按本子的名字找）：写过字的页各一张图加书写过程
const s1 = await scanRaw({ nb: '草稿本' });
const t1 = s1.text || '';
T.ok('整本检测：是一条【草稿纸·整本】消息，只有写过字的第 1、3 页', s1.status === 200 && s1.pages === 2 && s1.nb === 'scratch' && t1.startsWith('【草稿纸·整本】')
  && t1.includes('── 第 1 页') && t1.includes('── 第 3 页') && !t1.includes('── 第 2 页'), s1.error || t1.slice(0, 200));
const im1 = scanImgs(t1);
T.ok('每页一张图，文件真的生成了', im1.length === 2 && im1.every((f) => onDisk(f) > 2000), im1.map(onDisk));
const c1 = im1[0] && onDisk(im1[0]) ? await count(im1[0]) : null, c3 = im1[1] && onDisk(im1[1]) ? await count(im1[1]) : null;
T.ok('第 1 页的图里有黑字也有红字', Boolean(c1) && c1.dark > 50 && c1.reddish > 50, c1);
T.ok('第 3 页的图里有黑字、没有红字', Boolean(c3) && c3.dark > 50 && c3.reddish === 0, c3);
const p1 = part(t1, 1), p3 = part(t1, 3);
T.ok('每页附着书写过程：第 1 页两组（第二组标着红笔），第 3 页一组；第一次看的都标 ★', /★ g1｜.*｜1 笔/.test(p1) && /★ g2｜.*｜1 笔｜红笔（问题）/.test(p1)
  && p1.includes('这一页共 2 组笔迹') && p1.includes('这一页你第一次看') && /★ g1｜.*｜1 笔/.test(p3) && p3.includes('这一页共 1 组笔迹'), [p1, p3]);
const m1 = s1.id ? T.metaOf(s1) : {};
T.ok('这次检测记了下来（写回某一页时按它找笔迹的位置）', m1.kind === 'scan' && m1.target === sid && Object.keys(m1.pages || {}).join() === '1,3'
  && Object.keys(m1.pages['1'].groups).join() === 'g1,g2' && m1.pages['3'].page === 2, m1.pages && Object.keys(m1.pages));
T.ok('整本检测是 Claude 自己取的，不另外往对话里投一条', !(await T.poll(sid)), null);

// 2. only_new：只要上次看过之后有新笔迹的页
const s2 = await scanRaw({ only_new: true });
T.ok('刚看过、没新写：一页都不取，说明两页之前都看过了', s2.status === 200 && s2.pages === 0 && (s2.text || '').includes('没有符合条件的页') && s2.text.includes('2 页的笔迹你之前都看过了'), s2.error || s2.text);
await T.pen(T.line(150, 700, 220)); // 第 3 页再写一组，刚写完就来检测（服务会先让平板存一下、等一等）
const s3 = await scanRaw({ only_new: true });
const t3 = s3.text || '', q3 = part(t3, 3);
T.ok('第 3 页新写了一组：只取第 3 页，新的那组标 ★、旧的不标，另一页说明没附', s3.pages === 1 && t3.includes('有新笔迹的页') && /★ g2｜/.test(q3) && /\n {2,}g1｜/.test(q3)
  && !/★ g1｜/.test(q3) && !t3.includes('── 第 1 页') && t3.includes('另有 1 页没有新笔迹，没附上'), s3.error || t3);

// 3. pages：指定页（没写过字的页也照取）
const s4 = await scanRaw({ pages: [2] });
const t4 = s4.text || '', im4 = scanImgs(t4);
const c4 = im4[0] && onDisk(im4[0]) ? await count(im4[0]) : null;
T.ok('指定第 2 页：只取这一页，书写过程写着还没有笔迹，图是一张空白页', s4.pages === 1 && t4.includes('── 第 2 页') && !t4.includes('── 第 1 页') && t4.includes('这一页还没有手写笔迹')
  && Boolean(c4) && c4.w > 500 && c4.dark === 0 && c4.reddish === 0, s4.error || [t4.slice(0, 200), c4]);

// 4. region：单独一页放大一段（y 450–650 只有那一笔红字，黑字在 y 200，不在里面）
const s5 = await scanRaw({ pages: [1], region: [450, 650] });
const t5 = s5.text || '', im5 = scanImgs(t5);
const c5 = im5[0] && onDisk(im5[0]) ? await count(im5[0]) : null;
const k1 = ((m1.pages || {})['1'] || {}).crop || {}, k5 = s5.id ? T.metaOf(s5).pages['1'].crop : {};
T.ok('放大一段：消息写着只截了 y 450–650，比整页那张放得大', s5.pages === 1 && t5.includes('只截了 y 450–650 这一段') && k5.y0 === 450 && k5.scale > k1.scale,
  s5.error || [t5.slice(0, 300), k1, k5]);
T.ok('放大的图是扁的一条，里面只有那一笔红字', Boolean(c5) && c5.w > 3 * c5.h && Math.abs(c5.h - 200 * k5.scale) < 4 && c5.reddish > 50 && c5.dark === 0, c5);
const e1 = await scanRaw({ pages: [1, 3], region: [0, 100] });
T.ok('放大一段只能配合单独一页：两页一起要时说清楚', e1.status === 400 && /region 只能配合单独一页/.test(e1.error || ''), e1);
const e2 = await scanRaw({ nb: '没有这本' });
T.ok('本子名字不对：报没有这本，并列出现有的本子', e2.status === 404 && /没有叫「没有这本」的本子/.test(e2.error || '') && e2.error.includes('草稿本'), e2);

// 5. 当前页快照：平板开着第 3 页，页面应答后返回图和文字
const r6 = await T.postRaw('/bridge/snapshot', { sid, wait: 10 });
const tip6 = await T.waitFor(`!document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.includes('Claude 看了一眼这一页')`, 3000);
const s6 = await r6.json(), t6 = s6.text || '';
T.ok('快照：是一条【草稿纸·快照】消息，写着平板当前是第 3 页', r6.status === 200 && Boolean(s6.id) && t6.startsWith('【草稿纸·快照】') && t6.includes('页面：草稿本第 3 页'), s6.error || t6.slice(0, 300));
const im6 = anyImgs(t6), cr6 = im6.find((f) => f.endsWith('crop.jpg'));
const c6 = cr6 && onDisk(cr6) ? await count(cr6) : null;
T.ok('快照的图真的生成了，里面有这一页的两组黑字', im6.length >= 1 && im6.every((f) => onDisk(f) > 1000) && Boolean(c6) && c6.dark > 50 && c6.reddish === 0, [im6.map(onDisk), c6]);
const m6 = s6.id ? T.metaOf(s6) : {};
T.ok('快照附着书写过程（两组），记着是快照、是第 3 页', /g1｜/.test(t6) && /g2｜/.test(t6) && t6.includes('这一页共 2 组笔迹') && m6.snapshot === true
  && m6.nb === 'scratch' && m6.page === 2 && (m6.groups || []).length === 2, { snapshot: m6.snapshot, page: m6.page, groups: (m6.groups || []).length });
T.ok('平板上闪一句「Claude 看了一眼这一页」；快照不往对话里另投一条', tip6 && !(await T.poll(sid)), await T.text('#toast'));

// 6. 平板关着：整本检测照样取得到（取到关之前存下的字），快照取不了
await T.openPage(1);
await T.pen(T.line(150, 400, 220));
const saved = (await T.saved()) && (await T.apiJson('/api/page?nb=scratch&i=1'));
T.ok('关平板之前，第 2 页新写的一笔存到了电脑上', Boolean(saved) && (saved.strokes || []).length === 1, saved);
await T.cdp('Page.navigate', { url: 'about:blank' });
let offline = false; // 服务要 30 秒没见到平板才算它关了
for (let i = 0; i < 40 && !offline; i++) { await T.sleep(1500); offline = (await T.get(`/bridge/status?sid=${sid}`)).tabletOnline === false; }
T.ok('平板页面关掉一会儿后，服务认得出平板不在了', offline, offline);
const r7 = await T.postRaw('/bridge/snapshot', { sid, wait: 3 });
const s7 = await r7.json();
T.ok('平板关着时快照取不了，说明要打开草稿纸页面', r7.status === 400 && /平板上没有打开草稿纸页面/.test(s7.error || ''), [r7.status, s7]);
const s8 = await scanRaw({ nb: 'scratch', only_new: true });
const t8 = s8.text || '', im8 = scanImgs(t8);
const c8 = im8[0] && onDisk(im8[0]) ? await count(im8[0]) : null;
T.ok('平板关着时整本检测照样能取：取到第 2 页新写的那一笔，图里有字', s8.status === 200 && s8.pages === 1 && t8.includes('── 第 2 页') && /★ g1｜/.test(part(t8, 2))
  && Boolean(c8) && c8.dark > 50, s8.error || [t8.slice(0, 300), c8]);

await T.finish();

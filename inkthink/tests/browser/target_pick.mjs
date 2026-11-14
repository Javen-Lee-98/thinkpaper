// 「这本发往」的列表认得出是哪个对话（《产品定义》第 2 节，2026-11-14 用户定）：按项目文件夹分组，文件夹名做小标题；
// 每个对话一行两行字——最近在那个对话里打的一句话（还没打过字的写「还没打过字」），下面小字写什么时候开的 · 多久前活跃 ·
// 执行过 /ink；现在发往的打 ✓、白底加粗边框；不同地方的同名文件夹，小标题带上上一级文件夹名；选了以后真的发到选的那个；
// 抽屉里那一行、「已交给……」的提示、导入面板的对话下拉框用同一套叫法（文件夹名，同一个文件夹几个对话时加那句话的开头）。
// 列表的截图存在 <临时目录>/target-pick/out/ 下。
// 跑法：node tests/browser/target_pick.mjs [临时目录]；有一项不对退出码 1。
import { join } from 'node:path';
import { boot } from '../browser_lib.mjs';

const NAME = 'target-pick', SP = process.argv[2] || join((await import('node:os')).tmpdir(), 'inkthink-browser-tests');
const WORK = join(SP, NAME, 'work'), OTHER = join(SP, NAME, 'other');
// 四个对话：work\idea 里开着两个（A1 打过字、执行过 /ink；A2 还没打过字），work\paper 一个，other\idea 一个（同名、不同地方）
const SESS = [
  { sid: 'A1', label: 'idea', cwd: join(WORK, 'idea') },
  { sid: 'A2', label: 'idea', cwd: join(WORK, 'idea') },
  { sid: 'B', label: 'paper', cwd: join(WORK, 'paper') },
  { sid: 'C', label: 'idea', cwd: join(OTHER, 'idea') },
];
const T = await boot({ name: NAME, sessions: SESS, open: false });
const js = T.evalJS;
const NOW = Date.now(), START_A1 = NOW - 5 * 60 * 1000, START_A2 = NOW - 26 * 3600 * 1000;
// 插件登记时报的：A1 什么时候开的、执行过 /ink；A2 什么时候开的；B、C 什么都没报（比如插件还没重载）
await T.post('/bridge/hello', { sid: 'A1', label: 'idea', cwd: SESS[0].cwd, started: START_A1, ink: true });
await T.post('/bridge/hello', { sid: 'A2', label: 'idea', cwd: SESS[1].cwd, started: START_A2 });
// 打字的先后：C（斜杠命令，不报那句话）、B、A1 最近
await T.post('/bridge/active', { sid: 'C' });
await T.sleep(30);
await T.post('/bridge/active', { sid: 'B', hint: '论文第二节的图' });
await T.sleep(30);
await T.post('/bridge/active', { sid: 'A1', hint: '先看周末的第二条路线安排怎么样' });
await T.go();

// 和页面同一个算法写出「什么时候开的」（今天 14:05 / 昨天 21:30 / 11月12日 09:10）
const startText = (ms) => {
  const d = new Date(ms), now = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000), hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return diff === 0 ? `今天 ${hm}` : diff === 1 ? `昨天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
};
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) await T.tap('#nbChip'); await T.sleep(300); };
const items = () => js(`[...document.querySelectorAll('#targetPickList > *')].map((e) => ({ cls: e.className, sid: e.dataset.sid || '', id: e.id,
  l1: (e.querySelector('.tp-l1') || {}).textContent || '', l2: (e.querySelector('.tp-l2') || {}).textContent || '', none: Boolean(e.querySelector('.tp-l1.none')),
  check: Boolean(e.querySelector('.tp-check')), on: e.classList.contains('on'), text: e.textContent }))`);
const sentToNow = async () => { const got = []; for (const s of SESS) if (await T.poll(s.sid)) got.push(s.sid); return got.join('+'); };
const sentTo = async () => { for (let i = 0; i < 40; i++) { const got = await sentToNow(); if (got) return got; await T.sleep(250); } return ''; };
let y = 150;
const write = async () => { await T.pen(T.line(120, y, 220)); y += 80; await T.sleep(400); };

// 1. 抽屉里那一行：草稿本没绑过，写默认会发往的那个（最近打字的 A1）；同一个文件夹开着两个，名字后面带它最近打的那句话的开头
await drawer(true);
const row1 = await T.text('#actTarget');
T.ok('新本子没绑过对话：那一行照旧写默认会发往的（最近打字的 A1），带那句话的开头、带上一级文件夹名', row1 === '这本发往：idea（work）『先看周末的第二条路线…』 ▾', row1);

// 2. 点开：按文件夹分组
await T.tap('#actTarget');
const L = await items();
const heads = L.filter((r) => r.cls === 'tp-folder').map((r) => r.text);
T.ok('按文件夹分组：最近有人打字的文件夹在前；两个叫 idea 的文件夹在不同地方，小标题带上一级文件夹名', JSON.stringify(heads) === JSON.stringify(['idea（work）', 'paper', 'idea（other）']), heads);
T.ok('每个对话排在自己的文件夹下面，组里最近打字的在前', L.slice(0, 7).map((r) => r.sid || r.text).join() === 'idea（work）,A1,A2,paper,B,idea（other）,C', L.map((r) => r.sid || r.text));
const by = Object.fromEntries(L.filter((r) => r.sid).map((r) => [r.sid, r]));
T.ok('A1：第一行是最近在那个对话里打的那句话；下面小字写什么时候开的 · 多久前活跃 · 执行过 /ink', by.A1.l1 === '先看周末的第二条路线安排怎么样' && !by.A1.none
  && by.A1.l2 === `${startText(START_A1)} 开的 · 刚刚活跃 · 执行过 /ink`, by.A1);
T.ok('A2：还没打过字的照写「还没打过字」（淡一点）；下面写什么时候开的（26 小时前开的）、没执行过 /ink 就不写', by.A2.l1 === '还没打过字' && by.A2.none
  && /^(昨天|\d+月\d+日) \d\d:\d\d 开的 · (刚刚|\d+ 分钟前)活跃$/.test(by.A2.l2) && by.A2.l2.startsWith(startText(START_A2)), by.A2);
T.ok('插件没报什么时候开的（B、C）：不写这一段，不编', /^(刚刚|\d+ 分钟前)活跃$/.test(by.B.l2) && /^(刚刚|\d+ 分钟前)活跃$/.test(by.C.l2) && by.B.l1 === '论文第二节的图' && by.C.l1 === '还没打过字', [by.B, by.C]);
T.ok('现在会发往的 A1 打 ✓、是选中的样子，别的没有', by.A1.check && by.A1.on && !['A2', 'B', 'C'].some((s) => by[s].check || by[s].on), L);
const look = await js(`(() => { const on = getComputedStyle(document.querySelector('#targetPickList button.on')), off = getComputedStyle(document.querySelector('#targetPickList button[data-sid=A2]'));
  return { onBg: on.backgroundColor, onShadow: on.boxShadow, offBg: off.backgroundColor, onW: on.fontWeight }; })()`);
T.ok('选中的那一行是白底加粗边框（不整块涂色）', look.onBg === 'rgb(255, 255, 255)' && /1\.5px/.test(look.onShadow) && look.onBg !== look.offBg, look);
const tail = L.slice(-2);
T.ok('最下面隔开一项「不发给 Claude（只在本地）」', tail[0].cls === 'tp-sep' && tail[1].id === 'tpLocal' && tail[1].l1 === '不发给 Claude（只在本地）', tail);
const fit = await js(`(() => { const p = document.querySelector('#targetPick').getBoundingClientRect(); return p.left >= 0 && p.right <= innerWidth && p.top >= 0 && p.bottom <= innerHeight; })()`);
T.ok('列表整个在屏幕里', fit);
await T.shot('2-target-pick.png');

// 3. 选同一个文件夹里还没打过字的 A2：那一行、写一笔点「AI」真的发到 A2，「已交给……」用同一套叫法
await T.tap('#targetPickList button[data-sid=A2]', 800);
const row3 = await T.text('#actTarget');
const nameA2 = `idea（work）（${startText(START_A2)} 开的）`;
T.ok('选 A2：那一行写 A2 的叫法（同一个文件夹几个对话，A2 还没打过字：写什么时候开的）', row3 === `这本发往：${nameA2} ▾` && (await js(`(window.__ink.S.nb.target || {}).sid`)) === 'A2', row3);
await drawer(false);
await write();
await js(`window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (!t.hidden) window.__toasts.push(t.textContent); })
  .observe(document.querySelector('#toast'), { childList: true, subtree: true, characterData: true, attributes: true }); 1`);
await T.tap('#check');
const got3 = await sentTo();
T.ok('点「AI」：交给了选的 A2，别的对话都没收到', got3 === 'A2', got3);
const said3 = await js(`window.__toasts`);
T.ok('屏幕上方那句「已交给……」用同一套叫法', said3.includes(`已交给「${nameA2}」`), said3);

// 4. 再选另一个文件夹里唯一的那个对话（B）：只写文件夹名；真的发到 B
await drawer(true);
await T.tap('#actTarget');
const L4 = await items();
T.ok('再点开：✓ 跟着换到 A2', L4.find((r) => r.sid === 'A2').check && !L4.find((r) => r.sid === 'A1').check, L4.filter((r) => r.check));
await T.tap('#targetPickList button[data-sid=B]', 800);
T.ok('选 B（work\\paper 里只有它）：那一行只写文件夹名', (await T.text('#actTarget')) === '这本发往：paper ▾', await T.text('#actTarget'));
await drawer(false);
await write();
await T.tap('#check');
T.ok('点「AI」：交给了 B', (await sentTo()) === 'B');

// 5. 导入面板的对话下拉框：同一套叫法，选中的是这本发往的那个
await drawer(true);
await T.tap('#actUpload', 1200);
const opts = await js(`[...document.querySelectorAll('#isSession option')].map((o) => [o.value, o.textContent, o.selected])`);
T.ok('导入面板的下拉框：每个对话的叫法和「这本发往」一样，默认选着这本发往的 B', JSON.stringify(opts.map((o) => o[1])) === JSON.stringify(
  ['idea（work）『先看周末的第二条路线…』', 'paper', 'idea（other）', nameA2]) && opts.find((o) => o[2])[0] === 'B', opts);
await T.tap('#isClose');

// 6. 「对话上下文太长，回得会慢」删了：页面上、页面脚本里、对话列表的接口里都没有；还没重载的旧插件照样报上下文大小也不记
await T.post('/bridge/progress', { sid: 'A1', ctx: 260000 });
const ss = await T.apiJson('/api/sessions');
const src = await js(`Promise.all(['/static/app.js', '/static/i18n.js', '/'].map((u) => fetch(u).then((r) => r.text()))).then((a) => a.join('\\n'))`);
T.ok('对话列表的接口里没有上下文大小', ss.sessions.length === 4 && ss.sessions.every((s) => !('ctx' in s)), ss.sessions.map((s) => Object.keys(s)));
T.ok('页面和页面脚本里没有「上下文太长」「回得会慢」', !/上下文太长|回得会慢|\.ctx\b/.test(src) && !/上下文太长|回得会慢/.test(await js(`document.body.textContent`)));

await T.finish();

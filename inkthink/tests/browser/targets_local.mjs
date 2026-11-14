// 每本发往哪个对话：每本记住自己的对话，不跟着「最近打字的」跑；抽屉里「这本发往」能换；对话不在了先问；
// /ink here 把平板开着的那本改发到那个对话。只在本地（2026-11-14 并进「这本发往」）：列表最下面一项「不发给 Claude（只在本地）」，
// 选了不发、Claude 也取不到；那一行写「这本发往：只在本地（不发给 Claude）」，抽屉里这本名字后面写「只在本地」（原来的小锁图标去掉了）；
// 再选一个对话就取消只在本地、发往那个对话。
// 跑法：node tests/browser/targets_local.mjs [临时目录]；有一项不对退出码 1。
import { boot } from '../browser_lib.mjs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SIDS = ['S1', 'S2', 'S3'], NAME = { S1: 'proj-a', S2: 'proj-b', S3: 'proj-c' };
const T = await boot({ name: 'targets-local', sessions: SIDS.map((sid) => ({ sid, label: NAME[sid] })), open: false });
const pad = await T.apiJson('/api/notebook/new', { method: 'POST', body: JSON.stringify({ title: '读书笔记' }) }); // 准备第二个本子
await T.sleep(60);
await T.post('/bridge/active', { sid: 'S2' }); // proj-b 是最近打字的
await T.go();

// ---- 这个测试自己用的小工具
const setting = (dir) => { const f = join(T.DATA, 'notebooks', dir, 'settings.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; };
const savedTarget = (dir) => (setting(dir).target || {}).sid || null; // 电脑上记的：这本发往哪个对话
const padDir = 'pad-' + String(pad.id || '').slice(4);
const bound = () => T.evalJS(`(window.__ink.S.nb.target || {}).sid || null`); // 平板上记的
const toastText = () => T.evalJS(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`);
const subs = () => { const d = join(T.DATA, 'submissions'); return existsSync(d) ? readdirSync(d).length : 0; }; // 一共投递过几次
const recent = (s) => T.waitFor(`window.__ink.S.sessions[0] && window.__ink.S.sessions[0].sid === '${s}'`); // 平板知道谁是最近打字的了
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) await T.tap('#nbChip'); await T.sleep(300); };
// 打开抽屉看「这本发往」那一行写着什么（看得见才算），看完收起
const targetRow = async () => { await drawer(true); const t = (await T.visible('#actTarget')) ? await T.text('#actTarget') : ''; await drawer(false); return t; };
let y = 120;
const write = async () => { await T.pen(T.line(100, y, 200)); y += 90; };
// 这一刻哪个对话收到了投递：返回收到的对话（比如 'S2'；谁都没收到是 ''，不止一个收到会连着写）
const sentToNow = async () => { const got = []; for (const sid of SIDS) if (await T.poll(sid)) got.push(sid); return got.join('+'); };
// 等投递出现（最多 10 秒），看是哪个对话收到的
const sentTo = async () => { for (let i = 0; i < 40; i++) { const got = await sentToNow(); if (got) return got; await T.sleep(250); } return ''; };
const checkTo = async () => { await write(); await T.tap('#check'); return sentTo(); }; // 写一笔，点「AI」，看发给了谁
// 在抽屉里真的点一下某个本子，换到那一本
const openNb = async (title) => {
  await drawer(true);
  const c = await T.evalJS(`(() => { const r = [...document.querySelectorAll('#nbList .nb-item')].find((x) => x.querySelector('.nb-name').textContent.includes(${JSON.stringify(title)}));
    if (!r) return null; const b = r.querySelector('.nb-name').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
  if (c) await T.tapAt(c[0], c[1], 1500);
  await drawer(false);
  return T.evalJS(`window.__ink.S.nb.id`);
};
// 「这本发往」点开的列表：每一项（小标题、对话、分隔线、只在本地）依次是什么
const pickItems = () => T.evalJS(`[...document.querySelectorAll('#targetPickList > *')].map((e) => ({ cls: e.className, sid: e.dataset.sid || '', id: e.id,
  text: e.textContent, on: e.classList.contains('on') }))`);
// 抽屉里本子列表的样子：每一行的名字、名字后面的小字、有没有锁的图标
const nbRows = () => T.evalJS(`[...document.querySelectorAll('#nbList .nb-item')].map((r) => ({ name: r.querySelector('.nb-name').textContent,
  tag: (r.querySelector('.nb-local') || {}).textContent || '', lock: Boolean(r.querySelector('[data-icon=lock]')) }))`);

// 1. 没绑过的本子：发往最近打字的对话；发一次就记下
const start = await T.evalJS(`({ n: window.__ink.S.sessions.length, first: window.__ink.S.sessions[0].sid, bound: (window.__ink.S.nb.target || {}).sid || null })`);
T.ok('三个对话都连着，最近打字的是 proj-b；草稿本还没绑过对话', start.n === 3 && start.first === 'S2' && start.bound === null && savedTarget('scratch') === null, start);
T.ok('抽屉里「这本发往」写着 proj-b（还没绑过：默认会发往的那个）', (await targetRow()).includes('这本发往：proj-b'), await T.text('#actTarget'));
const r1 = await checkTo();
T.ok('第一次点「AI」发给 proj-b，这本从此记成发往 proj-b（电脑上也记了）', r1 === 'S2' && (await bound()) === 'S2' && savedTarget('scratch') === 'S2', [r1, savedTarget('scratch')]);

// 2. 别的对话变成最近打字的：这本不跟着跑
await T.post('/bridge/active', { sid: 'S1' });
const now1 = await recent('S1');
const r2 = await checkTo();
T.ok('proj-a 变成最近打字的：草稿本照旧发给 proj-b', now1 && r2 === 'S2' && (await bound()) === 'S2', r2);

// 3. 抽屉里「这本发往」换对话：按文件夹分组（三个对话在三个文件夹），最近打字的在前，现在发往的打 ✓；最下面隔开一项只在本地
await drawer(true);
await T.tap('#actTarget');
const items = await pickItems();
const sess = items.filter((r) => r.sid);
T.ok('点「这本发往」：三个文件夹各一个小标题，最近打字的 proj-a 在最前，各自下面是它的对话', (await T.visible('#targetPick'))
  && items.filter((r) => r.cls === 'tp-folder').map((r) => r.text).join() === 'proj-a,proj-b,proj-c'
  && items.slice(0, 6).map((r) => r.sid || r.text).join() === 'proj-a,S1,proj-b,S2,proj-c,S3', items);
T.ok('现在发往的 proj-b 那一行打 ✓、是选中的样子；别的没有', sess.filter((r) => r.on).map((r) => r.sid).join() === 'S2'
  && sess.find((r) => r.sid === 'S2').text.endsWith('✓') && !sess.find((r) => r.sid === 'S1').text.includes('✓'), sess);
const last = items.slice(-2);
T.ok('列表最下面隔开一项「不发给 Claude（只在本地）」，现在没选它', last[0].cls === 'tp-sep' && last[1].id === 'tpLocal' && last[1].text === '不发给 Claude（只在本地）' && !last[1].on, last);
await T.tap('#targetPickList button[data-sid=S1]');
const row3 = (await T.visible('#actTarget')) ? await T.text('#actTarget') : '';
T.ok('选 proj-a：面板收起，那一行改成 proj-a，电脑上也改了', !(await T.visible('#targetPick')) && row3.includes('这本发往：proj-a') && (await bound()) === 'S1'
  && savedTarget('scratch') === 'S1', [row3, savedTarget('scratch')]);
await drawer(false);
const r3 = await checkTo();
T.ok('换了之后点「AI」发给 proj-a', r3 === 'S1', r3);

// 4. 每本记自己的：另一本第一次发给当时最近打字的 proj-b，草稿本还是 proj-a
await T.post('/bridge/active', { sid: 'S2' });
const now2 = await recent('S2');
const at = await openNb('读书笔记');
T.ok('在抽屉里点「读书笔记」换到那一本；它没绑过，「这本发往」写着最近打字的 proj-b', now2 && at === pad.id && (await bound()) === null
  && (await targetRow()).includes('这本发往：proj-b'), [at, await T.text('#actTarget')]);
y = 120;
const r4 = await checkTo();
T.ok('读书笔记第一次点「AI」发给 proj-b，记在它自己名下；草稿本记的还是 proj-a', r4 === 'S2' && savedTarget(padDir) === 'S2' && savedTarget('scratch') === 'S1',
  [r4, savedTarget(padDir), savedTarget('scratch')]);
const back = await openNb('草稿本');
T.ok('回到草稿本：「这本发往」还是 proj-a', back === 'scratch' && (await bound()) === 'S1' && (await targetRow()).includes('这本发往：proj-a'), [back, await T.text('#actTarget')]);
y = 420;
const r5 = await checkTo();
T.ok('两本各发各的：草稿本的发给 proj-a', r5 === 'S1', r5);

// 5. /ink here：proj-c 那边认领，平板开着的这本（草稿本）改发到 proj-c，没开着的那本不动
const cl = await T.post('/bridge/claim', { sid: 'S3' });
const moved = await T.waitFor(`(window.__ink.S.nb.target || {}).sid === 'S3'`);
const st = await T.get('/bridge/status?sid=S3'); // 这里面有访问码：只取要看的两项，不整个打印
T.ok('/ink here：平板不用刷新，草稿本就改发 proj-c（电脑上也改了，插件那边也看得到）', cl.ok === true && moved && savedTarget('scratch') === 'S3'
  && st.isTarget === true && st.targetNb === '草稿本' && (await targetRow()).includes('这本发往：proj-c'),
  { moved, saved: savedTarget('scratch'), isTarget: st.isTarget, targetNb: st.targetNb });
T.ok('没开着的读书笔记不受影响，还是发往 proj-b', savedTarget(padDir) === 'S2', savedTarget(padDir));
const r6 = await checkTo();
T.ok('认领之后点「AI」发给 proj-c', r6 === 'S3', r6);
await drawer(true);
await T.tap('#actTarget');
const inked = await T.evalJS(`(() => { const b = document.querySelector('#targetPickList button[data-sid=S3]'); return b ? b.querySelector('.tp-l2').textContent : ''; })()`);
T.ok('执行过 /ink here 的 proj-c：列表里那一行的小字写着「执行过 /ink」', inked.endsWith('执行过 /ink'), inked);
await T.tap('#targetPickCancel');
await drawer(false);

// 6. 绑定的对话不在了：点「AI」先问发往哪个对话（列表最下面照样有只在本地）
T.stopHello(); // 不再替 proj-c 报到；另两个接着报
await T.sleep(300);
setInterval(() => ['S1', 'S2'].forEach((sid) => T.post('/bridge/hello', { sid, label: NAME[sid], cwd: T.SP }).catch(() => {})), 5000);
await T.post('/bridge/bye', { sid: 'S3' });
const left = await T.waitFor(`window.__ink.S.sessions.length === 2 && !window.__ink.S.sessions.some((s) => s.sid === 'S3')`);
T.ok('proj-c 关了：抽屉里写着「proj-c」（不在了）', left && (await targetRow()).includes('这本发往：「proj-c」（不在了）'), await T.text('#actTarget'));
const n6 = subs();
await write();
await T.tap('#check');
const askedUp = await T.waitFor(`!document.querySelector('#targetPick').hidden`);
const asked = { head: await T.text('#targetPickHead'), list: await T.evalJS(`[...document.querySelectorAll('#targetPickList button[data-sid]')].map((b) => b.dataset.sid)`),
  local: await T.visible('#tpLocal') };
T.ok('点「AI」先不发，弹出来问：原来的对话不在了，发往哪个（列的是还连着的两个，最下面有只在本地）', askedUp && (await T.visible('#targetPick'))
  && asked.head.includes('这本原来发往「proj-c」，那个对话现在不在了') && asked.list.slice().sort().join() === 'S1,S2' && asked.local
  && subs() === n6 && (await sentToNow()) === '', asked);
await T.tap('#targetPickList button[data-sid=S1]');
const r7 = await sentTo();
T.ok('选了 proj-a：接着把这一页发给它，这本以后发往 proj-a', r7 === 'S1' && subs() === n6 + 1 && (await bound()) === 'S1' && savedTarget('scratch') === 'S1', [r7, savedTarget('scratch')]);

// 7. 只在本地：在「这本发往」的列表里选最下面那一项
await drawer(true);
T.ok('抽屉里的本子列表没有锁的图标（只在本地并进了「这本发往」）', (await T.count('#nbList [data-icon=lock]')) === 0 && !(await T.evalJS(`Boolean(document.querySelector('#actLocal'))`)),
  await nbRows());
await T.tap('#actTarget');
await T.tap('#tpLocal');
const locked = await T.waitFor(`window.__ink.S.nb.local === true`), tip7 = await toastText();
const row7 = (await T.visible('#actTarget')) ? await T.text('#actTarget') : '';
T.ok('选「不发给 Claude（只在本地）」：这本设成只在本地，提示不会发给 Claude，电脑上记了', locked && tip7.includes('《草稿本》只在本地：不会发给 Claude')
  && setting('scratch').local === true && !(await T.visible('#targetPick')), [tip7, setting('scratch').local]);
T.ok('那一行写「这本发往：只在本地（不发给 Claude）」', row7 === '这本发往：只在本地（不发给 Claude） ▾', row7);
const rows7 = await nbRows();
T.ok('本子列表里草稿本的名字后面用小字写着「只在本地」（不是图标），别的本子没有', rows7.find((r) => r.name === '草稿本').tag === '只在本地'
  && rows7.filter((r) => r.tag).length === 1 && !rows7.some((r) => r.lock), rows7);
await T.shot('7-local-row.png');
await T.tap('#actTarget');
const items7 = await pickItems();
T.ok('再点开：只在本地那一项打 ✓、是选中的样子，哪个对话都没有 ✓', items7.find((r) => r.id === 'tpLocal').on && items7.find((r) => r.id === 'tpLocal').text.endsWith('✓')
  && !items7.some((r) => r.sid && (r.on || r.text.includes('✓'))), items7);
await T.tap('#targetPickCancel');
await drawer(false);
const n7 = subs();
await write();
await T.saved();
await T.tap('#check');
await T.sleep(800);
const tip7b = await toastText();
const btn7 = await T.evalJS(`(() => { const b = document.querySelector('#check'); return { text: b.textContent, locked: b.classList.contains('locked'), lock: Boolean(b.querySelector('.ck-lock svg')) }; })()`);
T.ok('只在本地时右下角按钮灰着带锁、写「只在本地」', btn7.text === '只在本地' && btn7.locked && btn7.lock, btn7);
await T.shot('7-local-button.png');
T.ok('只在本地时点按钮：只提示（说去「这本发往」里选一个对话），不发', tip7b === '《草稿本》设为「只在本地」，不发给 Claude。要发的话，在抽屉里点「这本发往」选一个对话。'
  && subs() === n7 && (await sentToNow()) === '', [tip7b, subs() - n7]);
const deny = async (path, body) => {
  const r = await T.postRaw(path, Object.assign({ sid: 'S1' }, body)), j = await r.json();
  return { status: r.status, error: j.error || '', refused: r.status === 400 && /只在本地/.test(j.error || '') };
};
const d1 = await deny('/bridge/scan', { nb: 'scratch' }), d2 = await deny('/bridge/snapshot', { wait: 3 });
const d3 = await deny('/bridge/confirm', { questions: [{ box: [100, 100, 300, 140] }] });
T.ok('只在本地时 Claude 来取也被拒：整本检测、快照、问字迹都回「只在本地」，什么都没交出去', d1.refused && d2.refused && d3.refused && subs() === n7
  && (await T.apiJson('/api/confirms')).length === 0, [d1, d2, d3]);
const ai0 = await T.evalJS(`window.__ink.S.page.ai.length`);
const d4 = await deny('/bridge/reply', { items: [{ type: 'note', text: '试写一条', box: [100, 100, 300, 140] }] });
await T.sleep(1500);
const more4 = (await T.evalJS(`window.__ink.S.page.ai.length`)) - ai0;
T.ok('只在本地时 Claude 往这本上写回也被拒（回「只在本地」，说去「这本发往」里改），纸上没多出蓝字', d4.refused && more4 === 0 && d4.error.includes('「这本发往」')
  && !d4.error.includes('锁'), Object.assign(d4, { 纸上多了几条蓝字: more4 }));

// 8. 记在电脑上：刷新后还在；在列表里再选一个对话就取消只在本地，并真的发到那个对话
await T.reload();
await drawer(true);
const after = { local: await T.evalJS(`window.__ink.S.nb.local`), row: await T.text('#actTarget'), rows: await nbRows() };
T.ok('刷新后还是只在本地：那一行和名字后面的小字都在', after.local === true && after.row === '这本发往：只在本地（不发给 Claude） ▾'
  && after.rows.find((r) => r.name === '草稿本').tag === '只在本地', after);
await T.tap('#actTarget');
await T.tap('#targetPickList button[data-sid=S2]');
const unlocked = await T.waitFor(`window.__ink.S.nb.local === false`), tip8 = await toastText();
const after8 = { row: await T.text('#actTarget'), rows: await nbRows(), bound: await bound() };
T.ok('只在本地时在列表里选 proj-b：取消只在本地、改发 proj-b，电脑上也改了', unlocked && tip8.includes('《草稿本》可以发给 Claude 了') && setting('scratch').local === false
  && savedTarget('scratch') === 'S2' && after8.bound === 'S2' && after8.row.includes('这本发往：proj-b') && !after8.rows.some((r) => r.tag), [tip8, after8]);
await drawer(false);
const btn8 = await T.evalJS(`(() => { const b = document.querySelector('#check'); return { text: b.textContent, locked: b.classList.contains('locked') }; })()`);
// 第 6 步交给 proj-a 的那一轮还没走完（测试里没人报下一步）：不再灰着带锁，接着显示那一轮的「已交」
T.ok('右下角按钮不再灰着带锁，接着显示这本那一轮的进度', btn8.text === '已交' && !btn8.locked, btn8);
await write();
await T.tap('#check');
const r8 = await sentTo();
T.ok('取消后点「AI」真的发给了选的 proj-b', r8 === 'S2', r8);

await T.finish();

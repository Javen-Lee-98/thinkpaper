// 接别的 AI 的第一步（2026-11-17，《产品定义》第 2 节「本子、对话、AI 的关系」最后一条）：经 inkthink\mcp_server.py 接进来的对话。查：
// 1. 把 mcp_server.py 起成子进程（--url 指向测试服务、--ai Codex，文件夹 paper），按 MCP 协议握手；另有一个普通的 Claude 对话（idea）；
// 2. 草稿本没选过对话、连着两个：写一笔点「AI」弹出选对话的单子——Codex 那一行小字最前面标着「Codex」、上面那行写「看不到在那里打的话」；
//    Claude 那一行和以前一样（没有标记，小字里没有 Claude，上面那行「还没打过字」）；
// 3. 选 Codex：这一页经 MCP 的 ink_wait 交到了它手里（文字、这一页的图，第一次带固定规则），Claude 对话没收到；抽屉里那一行写「这本发往：Codex · paper」；
// 4. 经 MCP 的 ink_reply 写回：蓝字落到纸上，作者的 AI 是 Codex；存回电脑的页面文件里也是；
// 5. 把这本改发给 Claude 对话再交：消息里说这几条不是它写的，是「paper」的 Codex 对话写的；
// 6. 英文界面：单子里那一行的标记是原名 Codex、后面那几段照旧是英文，上面那行是英文；选了以后抽屉那一行是 Sends to: Codex · paper；
// 7. 关掉小程序（stdin 关上）：它从单子里消失。
// 只在无头 Edge 里、用这里写的 MCP 客户端试过，没有用真的 Codex、Gemini 试过。
// 跑法：node tests/run_browser.mjs <临时目录> --only other_ai；有一项不对退出码 1。
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot, sleep, PY, APP } from '../browser_lib.mjs';

const NAME = 'other-ai', SP = process.argv[2] || join((await import('node:os')).tmpdir(), 'inkthink-browser-tests');
const PAPER = join(SP, NAME, 'proj', 'paper'), IDEA = join(SP, NAME, 'proj', 'idea');
const T = await boot({ name: NAME, sessions: [{ sid: 'C1', label: 'idea', cwd: IDEA }], open: false });
mkdirSync(PAPER, { recursive: true }); // boot 会清空这个测试的临时目录：文件夹在它之后建
mkdirSync(IDEA, { recursive: true });
const js = T.evalJS;
const S = (expr) => js(`(() => { const S = window.__ink.S; return ${expr}; })()`);

// ---- 一个按 MCP 协议说话的小客户端：stdio 上一行一条 JSON-RPC（按字节切行，UTF-8 不会被切坏）
function startMcp(args, cwd) {
  const p = spawn(PY, [join(APP, 'mcp_server.py'), ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = new Map(), out = { log: [], err: '' };
  let buf = Buffer.alloc(0), next = 0;
  p.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (let i; (i = buf.indexOf(10)) >= 0;) {
      const line = buf.subarray(0, i).toString('utf8');
      buf = buf.subarray(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      out.log.push(m);
      if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    }
  });
  p.stderr.on('data', (d) => { out.err += d.toString('utf8'); });
  const send = (o) => p.stdin.write(Buffer.from(JSON.stringify(o) + '\n', 'utf8'));
  out.request = (method, params, ms = 60000) => new Promise((res, rej) => {
    const id = ++next, t = setTimeout(() => { waiters.delete(id); rej(new Error(`MCP ${method} ${ms / 1000} 秒没回`)); }, ms);
    waiters.set(id, (m) => { clearTimeout(t); res(m); });
    send(Object.assign({ jsonrpc: '2.0', id, method }, params ? { params } : {}));
  });
  out.notify = (method, params) => send(Object.assign({ jsonrpc: '2.0', method }, params ? { params } : {}));
  out.tool = (name, args, ms) => out.request('tools/call', { name, arguments: args || {} }, ms);
  out.close = async () => { // stdin 关上：它向服务说 bye、退出；venv 的 python.exe 会再起一个解释器，停不下来时连子进程一起停
    try { p.stdin.end(); } catch (e) { /* */ }
    for (let i = 0; i < 50 && p.exitCode === null; i++) await sleep(100);
    if (p.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* */ } }
  };
  process.on('exit', () => { try { p.kill(); } catch (e) { /* */ } });
  return out;
}
const textOf = (r) => ((r && r.result && r.result.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
const imagesOf = (r) => ((r && r.result && r.result.content) || []).filter((c) => c.type === 'image');

// ================= 1. 起小程序、握手；它出现在服务的对话列表里，ai 是 Codex
const M = startMcp(['--url', T.B, '--ai', 'Codex'], PAPER);
const init = await M.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1' } });
M.notify('notifications/initialized');
T.ok('（前提）握手成功，instructions 里有固定规则', init.result && init.result.protocolVersion === '2025-06-18' && init.result.instructions.includes('## 手写草稿纸（inkpad）'), init);
let MX = '';
for (let i = 0; i < 50 && !MX; i++) {
  const ss = (await T.apiJson('/api/sessions')).sessions;
  MX = (ss.find((s) => s.label === 'paper') || {}).sid || '';
  if (!MX) await sleep(200);
}
const ss1 = (await T.apiJson('/api/sessions')).sessions;
T.ok('（前提）它登记成了一个对话：文件夹 paper，ai 是 Codex；Claude 那个的 ai 是 Claude', Boolean(MX) && ss1.find((s) => s.sid === MX).ai === 'Codex' && ss1.find((s) => s.sid === 'C1').ai === 'Claude', ss1);

await T.go();
if (await S('S.flow')) { await js(`window.__ink.toggleFlow()`); await sleep(800); }
await T.waitFor(`(window.__ink.S.sessions || []).length === 2`, 8000);

// ================= 2. 写一笔点「AI」：先弹单子；Codex 那一行标出来，Claude 那一行和以前一样
const rowOf = (sid) => js(`(() => { const b = document.querySelector('#targetPickList button[data-sid="${sid}"]'); if (!b) return null;
  const l2 = b.querySelector('.tp-l2'), tag = l2.querySelector('.tp-ai');
  return { l1: b.querySelector('.tp-l1').textContent, l2: l2.textContent, tag: tag ? tag.textContent : null, kids: l2.childElementCount }; })()`);
await T.pen(T.line(120, 200, 260));
await sleep(400);
await T.tap('#check');
T.ok('（前提）点「AI」先弹出选对话的单子', await T.waitFor(`!document.querySelector('#targetPick').hidden`, 5000));
const rx = await rowOf(MX), rc = await rowOf('C1');
T.ok('Codex 那一行：小字最前面标着「Codex」，后面照旧是什么时候开的、多久前活跃', Boolean(rx) && rx.tag === 'Codex' && /^Codex · 今天 \d\d:\d\d 开的 · (刚刚|\d+ 分钟前)活跃$/.test(rx.l2), rx);
T.ok('Codex 那一行上面那行：看不到在那里打的话（不说「还没打过字」）', Boolean(rx) && rx.l1 === '看不到在那里打的话', rx);
T.ok('Claude 那一行和以前一样：没有标记，小字里没有 Claude，上面那行「还没打过字」', Boolean(rc) && rc.tag === null && rc.kids === 0 && !rc.l2.includes('Claude') && /^(刚刚|\d+ 分钟前)活跃$/.test(rc.l2) && rc.l1 === '还没打过字', rc);
await T.shot('2-pick.png');

// ================= 3. 选 Codex：经 MCP 的 ink_wait 收到这一页
await T.tap(`#targetPickList button[data-sid="${MX}"]`, 800);
const w = await M.tool('ink_wait', { timeout: 20 }, 40000);
const wt = textOf(w), sub = (/submission="([^"]+)"/.exec(wt) || [])[1];
T.ok('经 ink_wait 收到了这一页：消息文字、写回用的投递编号，第一次带着固定规则', wt.includes('【草稿纸】我在平板上写了一些东西发给你。') && Boolean(sub) && wt.includes('## 手写草稿纸（inkpad）') && !wt.includes('mcp__inkpad__'), wt.slice(0, 300));
const imgs = imagesOf(w);
T.ok('这一页的图作为 image 附在结果里（JPEG）', imgs.length >= 1 && imgs[0].mimeType === 'image/jpeg' && Buffer.from(imgs[0].data, 'base64').subarray(0, 2).toString('hex') === 'ffd8', imgs.map((i) => i.mimeType));
T.ok('Claude 对话没收到', !(await T.poll('C1')));
await T.waitFor(`(window.__ink.S.nb.target || {}).sid === ${JSON.stringify(MX)}`, 5000);
const drawer = async (open) => { if ((await T.visible('#drawer')) !== open) await T.tap('#nbChip'); await sleep(300); };
await drawer(true);
const row3 = await T.text('#actTarget');
T.ok('抽屉里那一行：这本发往：Codex · paper', row3 === '这本发往：Codex · paper ▾', row3);
await drawer(false);

// ================= 4. 经 MCP 的 ink_reply 写回：落到纸上，作者是 Codex
const NOTE = '这一笔画平了';
const rep = await M.tool('ink_reply', { submission: sub, items: [{ type: 'note', anchor: 'g1', text: NOTE }, { type: 'read', anchor: 'g1', text: '一横' }] });
T.ok('（前提）ink_reply 写成了', textOf(rep).startsWith('已写到草稿纸：') && !rep.result.isError, textOf(rep));
const landed = await T.waitFor(`window.__ink.S.page && window.__ink.S.page.ai.some((a) => a.text === ${JSON.stringify(NOTE)})`, 10000);
await js(`(() => { window.__written = false; window.__ink.S.aiQueue.then(() => { window.__written = true; }); })()`);
const written = await T.waitFor('window.__written', 40000); // 一笔一笔写完（等不到也算不对）
const note = await S(`JSON.parse(JSON.stringify(S.page.ai.find((a) => a.text === ${JSON.stringify(NOTE)}) || null))`);
T.ok('蓝字落到纸上（写完了），作者是这个对话、AI 是 Codex', landed && written && Boolean(note) && note.author && note.author.sid === MX && note.author.ai === 'Codex' && note.author.label === 'paper', note && note.author);
await T.saved();
const disk = T.pageFile('scratch', 0);
const onDisk = disk && disk.ai.find((a) => a.text === NOTE);
T.ok('存回电脑的页面文件里，那一条的作者也是 Codex', Boolean(onDisk) && onDisk.author.ai === 'Codex' && onDisk.author.sid === MX, onDisk && onDisk.author);
await T.shot('4-reply.png');

// ================= 5. 改发给 Claude 对话再交：消息里说这几条不是它写的、是 Codex 写的
await drawer(true);
await T.tap('#actTarget');
await T.tap('#targetPickList button[data-sid="C1"]', 800);
await drawer(false);
await T.tap('#check');
const s5 = await T.waitSub('C1', 60);
const t5 = s5 ? s5.text : '';
T.ok('交给了 Claude 对话：消息里说有 1 条蓝字是「paper」的 Codex 对话写的', t5.includes('这一页上有 1 条蓝色批注不是这个对话写的（是「paper」的 Codex 对话写的）'), t5.slice(-700));
T.ok('那一条在列表里标〔不是你写的〕', t5.includes(`- 〔不是你写的〕${NOTE}`), t5.slice(-500));
const w5 = await M.tool('ink_wait', { timeout: 2 }, 20000);
T.ok('这次 Codex 那边没收到（ink_wait 等了 2 秒回「还没有新的投递」）', textOf(w5).startsWith('还没有新的投递'), textOf(w5));

// ================= 6. 英文界面
await T.go('&lang=en');
await drawer(true);
await T.tap('#actTarget');
T.ok('（前提）英文界面：单子出来了', await T.waitFor(`!document.querySelector('#targetPick').hidden`, 5000));
const ex = await rowOf(MX), ec = await rowOf('C1');
T.ok('英文界面：Codex 那一行标着原名 Codex，后面那几段是英文', Boolean(ex) && ex.tag === 'Codex' && /^Codex · opened today \d\d:\d\d · active (just now|\d+ min ago)$/.test(ex.l2), ex);
T.ok('英文界面：Codex 那一行上面那行是英文', Boolean(ex) && ex.l1 === 'What was typed there is not shown', ex);
T.ok('英文界面：Claude 那一行没有标记', Boolean(ec) && ec.tag === null && /^active (just now|\d+ min ago)$/.test(ec.l2) && ec.l1 === 'Nothing typed there yet', ec);
await T.shot('6-pick-en.png');
await T.tap(`#targetPickList button[data-sid="${MX}"]`, 800);
const row6 = await T.text('#actTarget');
T.ok('英文界面：选了 Codex，抽屉那一行写 Sends to: Codex · paper', row6 === 'Sends to: Codex · paper ▾', row6);
await drawer(false);

// ================= 7. 关掉小程序：从单子里消失
await M.close();
const gone = (await T.apiJson('/api/sessions')).sessions.every((s) => s.sid !== MX);
T.ok('关掉小程序（stdin 关上）：它马上从对话列表里消失', gone, (await T.apiJson('/api/sessions')).sessions.map((s) => s.sid));
T.ok('小程序往外说的话里没有访问码', !JSON.stringify(M.log).includes(T.code) && !M.err.includes(T.code));

await T.finish();

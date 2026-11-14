// 浏览器测试共用的一套：在临时目录里起一个测试服务、开一个无头浏览器，打开现在的页面，
// 提供点按、用笔写、读页面状态的小工具，以及「不对就报错」的 ok / finish。
//
// 用法（每个测试文件）：
//   import { boot } from '../browser_lib.mjs';
//   const T = await boot({ name: 'ink-basic' });
//   T.ok('写上了', (await T.strokes()) === 1, await T.strokes());
//   await T.finish();           // 有一项不对、或页面抛了没接住的错：退出码 1
//
// 临时目录取命令行第一个参数（node tests/browser/xxx.mjs <临时目录>），没给就用系统临时目录。
// 端口自己找空的，几个测试可以同时跑。真实数据（inkthink/data、inkthink/books）不会被碰到。
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const venv = [join(APP, '.venv', 'Scripts', 'python.exe'), join(APP, '.venv', 'bin', 'python')].find((p) => existsSync(p));
export const PY = process.env.INK_PYTHON || venv || 'python';
const BROWSERS = [process.env.INK_BROWSER, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function waitHttp(u, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(u); if (r.status < 500) return; } catch (e) { /* 还没起来 */ }
    if (Date.now() - t0 > ms) throw new Error('等不到 ' + u);
    await sleep(200);
  }
}

/**
 * 起服务和浏览器，打开现在的页面。opts：
 *   name      这个测试的名字（临时目录里用它分开）
 *   pages     草稿本一共几页（默认 1）
 *   sessions  连着的对话，默认 [{ sid: 'S1', label: 'idea' }]；cwd 不写就是临时目录
 *   query     打开页面时地址后面再带的参数，比如 '&lang=en'；默认带 lang=zh 和 notour=1
 *   width / height  屏幕大小，默认 834 × 1194（竖着的 iPad）
 *   open      false 时不打开页面（只要服务），之后自己调 T.go()
 *   config    测试服务的配置（会写成一个 config.json），比如 { zotero: 'http://127.0.0.1:端口' }
 */
export async function boot(opts = {}) {
  const name = opts.name || 'test';
  const SP = process.argv[2] || join(tmpdir(), 'inkthink-browser-tests');
  const ROOT = join(SP, name), DATA = join(ROOT, 'data'), BOOKS = join(ROOT, 'books'), PROFILE = join(ROOT, 'browser'), OUT = join(ROOT, 'out');
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  for (const d of [DATA, BOOKS, PROFILE, OUT]) mkdirSync(d, { recursive: true });
  const PORT = await freePort(), DBG = await freePort(), B = `http://127.0.0.1:${PORT}`;
  const procs = [];
  const run = (c, a, o) => { const p = spawn(c, a, Object.assign({ stdio: 'ignore' }, o)); procs.push(p); return p; };
  // venv 的 python.exe 会再起一个真正的解释器：停的时候连子进程一起停
  const killTree = (p) => { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* 已经没了 */ } };
  const killAll = () => procs.forEach((p) => { killTree(p); try { p.kill(); } catch (e) { /* */ } });
  // 浏览器的一次性配置目录跑完就删：留着不管的话每次几十 MB（浏览器自己往里下载组件），2026-11-13 查出两天攒了 801 个、约 30 GB。
  // 浏览器刚被停掉时文件可能还占着，所以重试几次；数据、截图（data、out）留着给人看
  const dropProfile = () => { try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch (e) { /* 删不掉：run_browser.mjs 末尾还会再扫一遍 */ } };
  process.on('exit', () => { killAll(); dropProfile(); });

  // 测试服务自己的配置：Zotero 默认指到一个不通的地址，免得哪个测试点了「Zotero」页签就去连电脑上真的 Zotero；
  // 要别的配置（比如假的 Zotero 接口、往来稿导出到哪）用 opts.config 给
  const CONFIG = join(ROOT, 'config.json');
  writeFileSync(CONFIG, JSON.stringify(Object.assign({ zotero: 'http://127.0.0.1:9' }, opts.config || {})), 'utf8');
  const srv = run(PY, ['server.py', '--host', '127.0.0.1', '--port', String(PORT), '--data', DATA, '--books', BOOKS, '--config', CONFIG], { cwd: APP });
  await waitHttp(`${B}/bridge/ping`, 20000);
  const code = readFileSync(join(DATA, 'access_code.txt'), 'utf8').trim();
  const T = { SP, ROOT, DATA, BOOKS, OUT, B, PORT, code, sleep, srv };

  // ---- 和服务说话
  // 插件那一侧的接口（/bridge/...）：本机来的不用访问码
  T.post = async (path, body) => { const r = await fetch(B + path, { method: 'POST', body: JSON.stringify(body || {}), headers: { 'Content-Type': 'application/json' } }); return r.json(); };
  T.postRaw = (path, body) => fetch(B + path, { method: 'POST', body: JSON.stringify(body || {}), headers: { 'Content-Type': 'application/json' } });
  T.get = async (path) => (await fetch(B + path)).json();
  // 平板那一侧的接口（/api/...）：带访问码
  T.api = (path, o = {}) => fetch(B + path, Object.assign({}, o, { headers: Object.assign({ 'X-Access': code, 'Content-Type': 'application/json' }, o.headers || {}) }));
  T.apiJson = async (path, o) => (await T.api(path, o)).json();
  T.poll = async (sid) => (await T.get(`/bridge/poll?sid=${sid}`)).submission;
  T.waitSub = async (sid, tries = 40) => { for (let i = 0; i < tries; i++) { const s = await T.poll(sid); if (s) return s; await sleep(250); } return null; };
  T.metaOf = (sub) => JSON.parse(readFileSync(join(DATA, 'submissions', sub.id, 'meta.json'), 'utf8'));
  T.pageFile = (nbDir, i) => { const f = join(DATA, 'notebooks', nbDir, `page-${String(i).padStart(4, '0')}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };

  for (let k = 1; k < (opts.pages || 1); k++) await T.api('/api/notebook/addpage?nb=scratch', { method: 'POST', body: '' });
  const sessions = opts.sessions || [{ sid: 'S1', label: 'idea' }];
  T.hello = () => Promise.all(sessions.map((s) => T.post('/bridge/hello', { sid: s.sid, label: s.label, cwd: s.cwd || SP })));
  await T.hello();
  const keepAlive = setInterval(() => T.hello().catch(() => {}), 5000);
  T.stopHello = () => clearInterval(keepAlive);

  // ---- 浏览器
  const exe = BROWSERS.find((p) => p && existsSync(p));
  if (!exe) throw new Error('找不到 Edge 或 Chrome；可以用环境变量 INK_BROWSER 指定');
  // 后三个开关：不让浏览器在后台联网、下载组件和自带的应用（配置目录就是被这些撑大的）；测试只连本机
  run(exe, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--disable-sync', '--disable-extensions',
    '--disable-component-update', '--disable-background-networking', '--disable-default-apps', 'about:blank']);
  await waitHttp(`http://127.0.0.1:${DBG}/json/version`, 30000);
  const tab = (await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let mid = 0;
  const pending = new Map(), errors = [], listeners = [];
  T.errors = errors; // 页面里没接住的错
  // 听浏览器发来的事件（比如 Fetch.requestPaused：拦下某个请求、过一会儿再放行）：T.onCdp('Fetch.requestPaused', (params) => …)
  T.onCdp = (method, fn) => listeners.push([method, fn]);
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method) for (const [k, fn] of listeners) if (k === msg.method) fn(msg.params);
  });
  const cdp = (method, params) => new Promise((res, rej) => {
    const id = ++mid, t = setTimeout(() => { pending.delete(id); rej(new Error(`CDP ${method} 15 秒没回`)); }, 15000);
    pending.set(id, (msg) => { clearTimeout(t); if (msg.error) rej(new Error(`CDP ${method}: ${msg.error.message}`)); else res(msg.result); });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  T.cdp = cdp;
  // 在页面里算一个表达式（可以是 async 的立即执行函数），返回它的值；表达式自己抛错时这里也抛错
  T.evalJS = async (e) => {
    const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面里出错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  T.shot = async (file) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, file), Buffer.from(r.data, 'base64')); return join(OUT, file); };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: opts.width || 834, height: opts.height || 1194, deviceScaleFactor: 1, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  // 等页面开好：本子和这一页都载入了、连上了服务
  T.ready = async (ms = 30000) => {
    const t0 = Date.now();
    while (!(await T.evalJS(`Boolean(window.__ink && window.__ink.S.page && window.__ink.S.online)`).catch(() => false))) {
      if (Date.now() - t0 > ms) throw new Error(`页面 ${Math.round(ms / 1000)} 秒没打开`);
      await sleep(300);
    }
    await sleep(600);
  };
  // 打开（或重新打开）页面。query 是地址后面再带的参数；带 raw: true 时 query 就是整个查询串（不自动加访问码等）
  T.go = async (query = '', o = {}) => {
    // 页面取地址里第一个 lang：query 里自己带了 lang 就不再加 lang=zh
    const q = o.raw ? query : `?k=${code}${/(^|[?&])lang=/.test(query) ? '' : '&lang=zh'}&notour=1${query}`;
    const url = `${B}/${o.path || ''}${q}`;
    await cdp('Page.navigate', { url });
    // 不等页面开好的（比如故意用旧访问码打开、等着出「需要访问码」）：纸那一页至少等它的脚本跑起来（window.__ink 有了）。
    // 2026-11-14 整套跑时 devices 几次卡在这一步，单独跑都好；卡住那次查到：页面和各个文件都取到了，app.js 却没跑完
    // （没有 window.__ink、没发任何 /api 请求、也没报错）。原因没查清，先照下面开纸的办法：15 秒还没跑起来就重新打开一次。
    // 别的页（path 不空，比如 brush.html、qr）没有 window.__ink，不等。
    if (o.wait === false) {
      await cdp('Page.bringToFront').catch(() => {});
      if (o.path) return;
      const ran = async (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await T.evalJS('Boolean(window.__ink)').catch(() => false)) return true; await sleep(50); } return false; };
      if (!(await ran(15000))) {
        process.stderr.write('  （页面的脚本 15 秒没跑起来，重新打开一次）\n');
        await cdp('Page.navigate', { url });
        await cdp('Page.bringToFront').catch(() => {});
        await ran(30000);
      }
      return;
    }
    // 几个测试同时起浏览器时，偶尔这一页被挤到后台、迟迟开不好（2026-11-12 整套跑第 3 遍时碰到一次）：
    // 先把它拿到前台；15 秒还没好就重新打开一次再等
    await cdp('Page.bringToFront').catch(() => {});
    try { await T.ready(15000); } catch (e) {
      process.stderr.write('  （页面 15 秒没开好，重新打开一次）\n');
      await cdp('Page.navigate', { url });
      await cdp('Page.bringToFront').catch(() => {});
      await T.ready(30000);
    }
    await cdp('Page.bringToFront');
  };
  // 刷新也会碰到上面那种「被挤到后台、迟迟开不好」（2026-11-14 整套跑时 answer_card 碰到一次，单独跑三遍都好）：同样拿到前台、重试一次
  T.reload = async () => {
    await cdp('Page.reload');
    await cdp('Page.bringToFront').catch(() => {});
    try { await T.ready(15000); } catch (e) {
      process.stderr.write('  （刷新后 15 秒没开好，再刷新一次）\n');
      await cdp('Page.reload');
      await cdp('Page.bringToFront').catch(() => {});
      await T.ready(30000);
    }
  };

  // ---- 看页面
  T.visible = (sel) => T.evalJS(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const cs = getComputedStyle(e);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && e.getClientRects().length > 0; })()`);
  T.text = (sel) => T.evalJS(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
  T.count = (sel) => T.evalJS(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  // 一直等到表达式为真（返回 true），等不到返回 false
  T.waitFor = async (expr, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      if (await T.evalJS(`Boolean(${expr})`).catch(() => false)) return true;
      if (Date.now() - t0 > ms) return false;
      await sleep(200);
    }
  };
  // 页面坐标（纸上的 x、y）→ 屏幕坐标
  T.screenOf = (wx, wy) => T.evalJS(`(() => { const S = window.__ink.S, r = document.querySelector('#stage').getBoundingClientRect(), v = S.view;
    return [r.left + v.tx + ${wx} * v.s, r.top + v.ty + ${wy} * v.s]; })()`);
  T.centerOf = (sel) => T.evalJS(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);

  // ---- 动手
  // 真的点一下屏幕上的一点（有 pointerdown / pointerup），算鼠标
  T.tapAt = async (x, y, wait = 400) => {
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(wait);
  };
  T.tap = async (sel, wait = 500) => { const c = await T.centerOf(sel); if (!c) return false; await T.tapAt(c[0], c[1], wait); return true; };
  // 手指点一下屏幕上的一点（触摸事件）
  T.fingerTapAt = async (x, y, wait = 400) => {
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(wait);
  };
  // 用笔画一笔：points 是页面坐标 [[x, y], …]
  T.pen = async (points, wait = 300) => {
    const base = { pointerType: 'pen', button: 'left' }, sp = [];
    for (const p of points) sp.push(await T.screenOf(p[0], p[1]));
    await cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: sp[0][0], y: sp[0][1], buttons: 1, clickCount: 1 }, base));
    for (const p of sp.slice(1)) await cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x: p[0], y: p[1], buttons: 1 }, base));
    const l = sp[sp.length - 1];
    await cdp('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: l[0], y: l[1], buttons: 0, clickCount: 1 }, base));
    await sleep(wait);
  };
  T.line = (x0, y, len, n = 10) => Array.from({ length: n }, (_, i) => [x0 + (i * len) / (n - 1), y]);
  T.tool = async (name) => { await T.evalJS(`(() => { const b = document.querySelector('#tools [data-tool=${name}]') || document.querySelector('#rail [data-tool=${name}]'); b.click(); })()`); await sleep(150); };
  T.strokes = () => T.evalJS(`window.__ink.S.page.strokes.filter((s) => !s.erasedAt).length`);
  T.openPage = async (i) => { await T.evalJS(`window.__ink.openPage(${i})`); await sleep(1200); };
  T.openNotebook = async (id, i = 0) => { await T.evalJS(`window.__ink.openNotebook(${JSON.stringify(id)}, ${i})`); await sleep(1200); };
  // 等这一页存到服务器上（写完字后要等一下才存）：没有待存的改动，也没有还在路上的存盘请求
  // （页面里 dirty 在排进队列时就清了，请求没回来之前 saveTryAt 一直不是 0）
  T.saved = (ms = 8000) => T.waitFor(`!window.__ink.S.dirty && !window.__ink.S.saveTryAt`, ms);

  // ---- 记结果
  const R = { name, fail: [], known: [], passed: 0 };
  T.R = R;
  T.ok = (label, cond, got) => {
    process.stderr.write((cond ? '  ok ' : 'FAIL ') + label + (cond ? '' : ' → ' + JSON.stringify(got)) + '\n');
    if (cond) R.passed++; else R.fail.push({ name: label, got });
    return Boolean(cond);
  };
  // 已知不过的一项（现在的页面上这个功能是坏的，等用户定怎么办）：不算失败，单独列出来；哪天它过了也会提醒
  T.known = (label, cond, why, got) => {
    process.stderr.write((cond ? ' !ok ' : 'KNOWN ') + label + (cond ? '（原来标着已知不过，现在过了：把 known 改回 ok）' : ' → ' + why) + '\n');
    R.known.push({ name: label, why, passedNow: Boolean(cond), got });
    return Boolean(cond);
  };
  // 收尾：打印结果，关掉服务和浏览器。有一项不对、或页面里有没接住的错（ignoreErrors 为 true 时不算），退出码 1
  T.finish = async (o = {}) => {
    clearInterval(keepAlive);
    const errs = o.ignoreErrors ? [] : (o.errors || errors);
    R.errors = errs;
    console.log(JSON.stringify(R, null, 1));
    try { ws.close(); } catch (e) { /* */ }
    killAll();
    process.exit(R.fail.length || errs.length ? 1 : 0);
  };
  process.on('uncaughtException', (e) => { console.error('测试脚本出错：', e); R.fail.push({ name: '脚本没跑完', got: String(e && e.stack || e) }); console.log(JSON.stringify(R, null, 1)); killAll(); process.exit(1); });
  process.on('unhandledRejection', (e) => { console.error('测试脚本出错：', e); R.fail.push({ name: '脚本没跑完', got: String(e && e.stack || e) }); console.log(JSON.stringify(R, null, 1)); killAll(); process.exit(1); });

  if (opts.open !== false) await T.go(opts.query || '');
  return T;
}

// 把一页的书写过程重放成动画，不用在平板上录屏。
// 存盘的每一笔都带着每个点的时间；这里在电脑上起一份临时的草稿纸（临时数据目录，只读那一页的存盘文件，不碰真实数据），
// 用页面自带的「回放本页书写过程」按原来的笔顺和节奏重画，再让蓝色批注按写回的先后一条条出现，
// 逐帧截图，交给 ffmpeg 合成 GIF 和 MP4。画面是同一套页面代码画出来的，不是屏幕录像，等回答的时间不在里面。
//
// 用法：node tools/demo_replay.mjs <某一页的存盘 .json> <输出文件夹> [选项]
//   --seconds 14   书写那一段压成多少秒（停顿按页面回放的规则压缩）
//   --fps 15       书写那一段每秒多少帧
//   --width 834 --height 1194   页面大小（竖着的 11 寸平板）；横着就对调
//   --scale 2      截图的清晰度倍数
//   --lang zh      界面语言（zh / en）
//   --gif 640      GIF 的宽度；--mp4 1080 是 MP4 的宽度
//   --intro        片头加上页面打开的过程：一张白页，页面载入，纸铺满屏幕，然后才开始写
//   --keep         留着临时文件夹（帧、临时数据）
// 需要：本机的 Edge 或 Chrome（环境变量 INK_BROWSER 可指定）、ffmpeg（环境变量 FFMPEG 可指定，没有就只留下帧）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP, PY } from '../tests/browser_lib.mjs';

const args = process.argv.slice(2), pos = [], opt = {};
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) { pos.push(args[i]); continue; }
  const k = args[i].slice(2);
  if (k === 'keep' || k === 'intro') opt[k] = true; else opt[k] = args[++i];
}
if (pos.length < 2) { console.error('用法：node tools/demo_replay.mjs <某一页的存盘 .json> <输出文件夹> [--seconds 14] [--fps 15] [--width 834] [--height 1194] [--scale 2] [--lang zh]'); process.exit(2); }
const SRC = resolve(pos[0]), OUT = resolve(pos[1]);
const num = (k, d) => (opt[k] === undefined ? d : Number(opt[k]));
const SECONDS = num('seconds', 14), FPS = num('fps', 15), W = num('width', 834), H = num('height', 1194), SCALE = num('scale', 2);
const GIF_W = num('gif', 640), MP4_W = num('mp4', 1080), LANG = opt.lang === 'en' ? 'en' : 'zh';
const PORT = num('port', 8871), DBG = num('debug-port', 9411), B = `http://127.0.0.1:${PORT}`;
const LEAD = 0.5, AFTER_WRITE = 0.9, PER_NOTE = 0.7, HOLD = 3; // 开头的空白、写完到蓝字出现、每条蓝字之间、最后停留（秒）
const INTRO_BLANK = 0.5; // 片头那张白页停多久（秒）

const BROWSER = [process.env.INK_BROWSER, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p) => p && existsSync(p));
if (!BROWSER) { console.error('没找到 Edge 或 Chrome；用环境变量 INK_BROWSER 指定浏览器的路径'); process.exit(2); }
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const TMP = join(tmpdir(), `thinkpaper-demo-${process.pid}`);
const DATA = join(TMP, 'data'), BOOKS = join(TMP, 'books'), PROFILE = join(TMP, 'browser'), FRAMES = join(TMP, 'frames');
for (const d of [DATA, BOOKS, PROFILE, FRAMES, join(DATA, 'notebooks', 'scratch'), OUT]) mkdirSync(d, { recursive: true });
const page = JSON.parse(readFileSync(SRC, 'utf8'));
if (!Array.isArray(page.strokes) || !page.strokes.length) { console.error('这个文件里没有笔迹：' + SRC); process.exit(2); }
writeFileSync(join(DATA, 'notebooks', 'scratch', 'index.json'), JSON.stringify({ pages: 1 }));
writeFileSync(join(DATA, 'notebooks', 'scratch', 'page-0000.json'), JSON.stringify(page));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const run = (c, a, o) => { const p = spawn(c, a, Object.assign({ stdio: 'ignore' }, o)); procs.push(p); return p; };
process.on('exit', () => {
  procs.forEach((p) => { try { p.kill(); } catch (e) { /* 已经退了 */ } });
  if (!opt.keep) try { rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 浏览器还占着文件：留给系统清 */ }
});
async function waitHttp(u, ms) { const t0 = Date.now(); for (;;) { try { const r = await fetch(u); if (r.status < 500) return; } catch (e) { /* 还没起来 */ } if (Date.now() - t0 > ms) throw new Error('等不到 ' + u); await sleep(200); } }

run(PY, ['server.py', '--host', '127.0.0.1', '--port', String(PORT), '--data', DATA, '--books', BOOKS, '--config', join(TMP, 'none.json')], { cwd: APP });
await waitHttp(`${B}/bridge/ping`, 15000);
const code = readFileSync(join(DATA, 'access_code.txt'), 'utf8').trim();
const hello = () => fetch(`${B}/bridge/hello`, { method: 'POST', body: JSON.stringify({ sid: 'DEMO', label: 'demo', cwd: TMP }), headers: { 'Content-Type': 'application/json' } }).catch(() => {});
await hello(); // 有一个连着的对话，页面才是平时的样子
const keepAlive = setInterval(hello, 5000);

run(BROWSER, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--hide-scrollbars', 'about:blank']);
await waitHttp(`http://127.0.0.1:${DBG}/json/version`, 20000);
const tab = (await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let mid = 0; const pending = new Map(), errors = [];
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
});
const cdp = (method, params) => new Promise((res) => { const id = ++mid; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
const evalJS = async (e) => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;

await cdp('Runtime.enable');
await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: true });
// 这一页存着的字和批注，页面一打开就会画出来；片子要从空纸开始，所以先藏着，等回放把纸清空了再放开
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const add = () => { const s = document.createElement('style'); s.id = 'demoIntro'; s.textContent = '#ink,#live,#ai,#tex{visibility:hidden!important}'; document.documentElement.appendChild(s); };
  if (document.documentElement) add(); else new MutationObserver((m, o) => { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true });
  try { localStorage.setItem('inkthink.guideSeen', 'true'); } catch (e) {} // 片子里不要新手引导
})()` });

// 帧：每张图配一个时长，最后交给 ffmpeg 的 concat
const frames = [];
function put(data, seconds) {
  const name = `f-${String(frames.length + 1).padStart(5, '0')}.png`;
  writeFileSync(join(FRAMES, name), Buffer.from(data, 'base64'));
  frames.push({ name, seconds });
}
async function shot(seconds) { put((await cdp('Page.captureScreenshot', { format: 'png' })).data, seconds); }

const URL0 = `${B}/?k=${code}&lang=${LANG}`;
if (opt.intro) { // 片头：还没打开时的一张白页，然后按真实的快慢拍下页面载入（画面没变就不重复存）
  await shot(INTRO_BLANK);
  const seen = [];
  await cdp('Page.navigate', { url: URL0 });
  for (const t0 = Date.now(); Date.now() - t0 < 2500;) {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    if (r && r.data && (!seen.length || seen[seen.length - 1].data !== r.data)) seen.push({ data: r.data, t: Date.now() });
    await sleep(30);
  }
  seen.forEach((f, i) => put(f.data, i + 1 < seen.length ? (seen[i + 1].t - f.t) / 1000 : 0.1));
} else await cdp('Page.navigate', { url: URL0 });
for (let i = 0; ; i++) {
  if (await evalJS(`Boolean(window.__ink && window.__ink.S.page && window.__ink.S.page.strokes.length)`)) break;
  if (i > 75) { console.error('页面没有打开那一页', errors); process.exit(1); }
  await sleep(200);
}
await evalJS(`document.fonts.ready.then(() => 1)`);
await sleep(1200);
const introFrames = frames.length;

// 页面里装三样东西：藏住提示条和还没轮到的蓝字；一个自己走的钟（回放按它走，一帧走一格，所以每一帧都截得到、快慢可调）
await evalJS(`(() => {
  const st = document.createElement('style');
  document.head.appendChild(st);
  const base = '#toast{display:none!important}';
  // 页面的回放会把批注层整层藏起来；这里要让蓝字在它该出现的那一刻出现，所以把这层留着，一条条放出来（排好的公式那层等到最后）
  window.__demoShow = (ids) => { st.textContent = ids === null ? base : base + ' #aiRoot{display:inline!important} #tex{visibility:hidden} #aiRoot > .ai-item{visibility:hidden}'
    + ids.map((id) => ' #aiRoot > .ai-item[data-id="' + id + '"]{visibility:visible}').join(''); };
  window.__demoShow([]);
  const realRAF = window.requestAnimationFrame.bind(window), realNow = performance.now.bind(performance);
  let vt = 0, queue = [];
  window.__demoClock = {
    on() { vt = 0; queue = []; window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; }; performance.now = () => vt; },
    step(dt) { vt += dt; const q = queue; queue = []; for (const cb of q) cb(vt); },
    off() { window.requestAnimationFrame = realRAF; delete performance.now; const q = queue; queue = []; for (const cb of q) realRAF(cb); },
  };
  return 1;
})()`);

const info = await evalJS(`(() => {
  const I = window.__ink, S = I.S;
  const when = new Map(S.page.ai.map((a, i) => [a.id, [a.t || 0, i]]));
  const blue = Array.from(document.querySelectorAll('#aiRoot > .ai-item')).map((g) => g.dataset.id).filter((id, i, all) => id && when.has(id) && all.indexOf(id) === i)
    .sort((a, b) => when.get(a)[0] - when.get(b)[0] || when.get(a)[1] - when.get(b)[1]);
  window.__demoClock.on();
  I.replay();
  const hid = document.getElementById('demoIntro'); // 回放已经把纸清空：放开一开始藏着的那几层
  if (hid) hid.remove();
  const R = S.replay;
  // 每条蓝字排在它之后写的第一笔之前：用户在蓝字旁边回的字，要在蓝字出现之后才写
  const draws = R.ev.filter((e) => e.kind === 'draw');
  window.__demoBlue = blue.map((id) => { const d = draws.find((e) => e.t > when.get(id)[0]); return { id, at: d ? d.v : null }; });
  const end = Math.max(...R.ev.map((e) => e.v + (e.kind === 'draw' && e.s.pts.length ? e.s.pts[e.s.pts.length - 1][3] / R.SPEED : 0)));
  const live = S.page.strokes.filter((s) => s.pts.length), t0 = Math.min(...live.map((s) => s.t0)), t1 = Math.max(...live.map((s) => s.t0 + s.pts[s.pts.length - 1][3]));
  return { strokes: live.length, red: live.filter((s) => s.c === 'r').length, erased: live.filter((s) => s.erasedAt).length,
    realSeconds: Math.round((t1 - t0) / 1000), penSeconds: Math.round(live.reduce((n, s) => n + s.pts[s.pts.length - 1][3], 0) / 1000), replayMs: Math.round(end), replaySpeed: R.SPEED };
})()`);

const blue = await evalJS(`window.__demoBlue`), ids = blue.map((b) => b.id);
let shown = 0, vt = 0, rounds = 0;
const stepTo = async (target) => {
  const done = await evalJS(`(() => { window.__demoClock.step(${target - vt}); const R = window.__ink.S.replay; return !R || (R.next >= R.ev.length && !R.active.length); })()`);
  vt = target;
  return done;
};
// 一批蓝字：先在交上去的那一刻停一下（等回答的时间不在片子里），再一条条出现
async function showBlue(batch) {
  frames[frames.length - 1].seconds = AFTER_WRITE;
  rounds++;
  for (let i = 0; i < batch; i++) {
    shown++;
    await evalJS(`(() => { window.__demoShow(${JSON.stringify(ids.slice(0, shown))}); return 1; })()`);
    await sleep(120);
    await shot(PER_NOTE);
  }
}

await shot(LEAD);
const n = Math.max(1, Math.round(SECONDS * FPS)), dt = info.replayMs / n;
for (let i = 0; i < 4 * n; i++) {
  const due = shown < blue.length && blue[shown].at !== null && blue[shown].at <= vt + dt ? blue[shown].at : null;
  if (due !== null) {
    if (due - 1 > vt) { await stepTo(due - 1); await shot(1 / FPS); } // 画到那一笔落下之前
    await showBlue(blue.filter((b) => b.at === due).length);
    continue;
  }
  const done = await stepTo(vt + dt);
  await shot(1 / FPS);
  if (done && vt >= info.replayMs) break;
}
await evalJS(`(() => { window.__demoClock.off(); return 1; })()`);
for (let i = 0; i < 30 && await evalJS(`Boolean(window.__ink.S.replay)`); i++) await sleep(100); // 回放自己收尾（约 0.7 秒）
await sleep(300);
if (shown < blue.length) await showBlue(blue.length - shown); // 最后一批：之后没有再写字
await evalJS(`(() => { window.__demoShow(null); return 1; })()`);
await sleep(300);
await shot(HOLD);
clearInterval(keepAlive);

copyFileSync(join(FRAMES, frames[frames.length - 1].name), join(OUT, 'last.png'));
const total = frames.reduce((s, f) => s + f.seconds, 0);
// penSpeed：落笔的那些笔画是原速的几倍（笔与笔之间的停顿另外压缩过）
Object.assign(info, { blue: ids.length, rounds, introFrames, introSeconds: Math.round(frames.slice(0, introFrames).reduce((s, f) => s + f.seconds, 0) * 100) / 100, frames: frames.length, seconds: Math.round(total * 10) / 10, writingSeconds: SECONDS,
  penSpeed: Math.round(((info.replaySpeed * info.replayMs) / (SECONDS * 1000)) * 10) / 10, size: [W * SCALE, H * SCALE], lang: LANG, errors });
writeFileSync(join(OUT, 'info.json'), JSON.stringify(info, null, 1));

// 合成：concat 列表里每张图一个时长；最后一张要再写一遍，时长才算数
const list = frames.map((f) => `file '${f.name}'\nduration ${f.seconds.toFixed(4)}`).join('\n') + `\nfile '${frames[frames.length - 1].name}'\n`;
writeFileSync(join(FRAMES, 'frames.txt'), list);
const ff = (a) => spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'frames.txt'].concat(a), { cwd: FRAMES, encoding: 'utf8' });
const made = [];
const gif = ff(['-vf', `fps=${FPS},scale=${GIF_W}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`, '-loop', '0', join(OUT, 'replay.gif')]);
if (gif.error) console.error('没找到 ffmpeg（环境变量 FFMPEG 可指定）；帧留在 ' + FRAMES), opt.keep = true;
else {
  if (gif.status === 0) made.push('replay.gif'); else console.error(gif.stderr);
  const mp4 = ff(['-vf', `fps=30,scale=${MP4_W}:-2:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', join(OUT, 'replay.mp4')]);
  if (mp4.status === 0) made.push('replay.mp4'); else console.error(mp4.stderr);
}
console.log(JSON.stringify(Object.assign({ out: OUT, made }, info), null, 1));
// 临时文件夹里有那一页的副本：先让浏览器和服务退出、松开文件，再删
cdp('Browser.close').catch(() => {});
await sleep(800);
procs.forEach((p) => { try { p.kill(); } catch (e) { /* 已经退了 */ } });
await sleep(400);
if (!opt.keep) try { rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.error('临时文件夹没删掉，请手动删：' + TMP); }
process.exit(errors.length ? 1 : 0);

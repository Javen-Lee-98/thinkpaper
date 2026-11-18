// 页面的脚本没载全时自己重新加载一次（2026-11-17 用户定，《产品定义》第 2 节）。查：
// 某个脚本（这里用 turn.js）头一次没取到：页面自己重新加载一次，第二次取到了，页面是好的（能写字），屏幕上没有那句话；
// 一直取不到：只自己试一次（不会没完没了地重新加载），屏幕上方说「页面没载全（缺 turn.js）」，给一个「重新加载」（44 高）；
// 取得到了以后点「重新加载」：页面好了，那句话没了；英文界面那句话和按钮是英文。
// 脚本取不到是用浏览器的拦截（CDP Fetch.failRequest）造出来的；真的 Wi-Fi 抖动、iPad 上的 Safari 没试过。
// 跑法：node tests/run_browser.mjs <临时目录> --only load_retry；有一项不对退出码 1。
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'load-retry', pages: 2 });
const js = T.evalJS;

let mode = 'ok', seen = 0; // ok：放行；once：头一次不给；always：一直不给
T.onCdp('Fetch.requestPaused', (p) => {
  seen++;
  const fail = mode === 'always' || (mode === 'once' && seen === 1);
  T.cdp(fail ? 'Fetch.failRequest' : 'Fetch.continueRequest', fail ? { requestId: p.requestId, errorReason: 'Failed' } : { requestId: p.requestId }).catch(() => {});
});
await T.cdp('Network.enable');
await T.cdp('Network.setCacheDisabled', { cacheDisabled: true }); // 每次打开都真的去取脚本，不用缓存里的
await T.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/static/turn.js*', requestStage: 'Request' }] });

const look = () => js(`(() => { const b = document.querySelector('#loadTrouble'), k = document.querySelector('#loadTroubleBtn');
  let key = null; try { key = sessionStorage.getItem('ink.reloadTry'); } catch (e) { /* */ }
  const r = b ? b.getBoundingClientRect() : null, q = k ? k.getBoundingClientRect() : null;
  return { bar: b ? b.querySelector('span').textContent : null, btn: k ? k.textContent : null, btnH: q ? q.height : 0, key: Boolean(key),
    inScreen: r ? r.left >= 0 && r.right <= document.documentElement.clientWidth && r.top >= 0 : null, top: r ? r.top : null, vh: innerHeight,
    turn: typeof window.Turn !== 'undefined', ink: Boolean(window.__ink), page: Boolean(window.__ink && window.__ink.S.page) }; })()`);
const settle = async (ms) => { // 等页面不再自己重新加载：取 turn.js 的次数有一会儿没变
  let last = -1, t0 = Date.now();
  while (Date.now() - t0 < ms) { if (seen === last) return; last = seen; await sleep(1500); }
};

// ================= 1. 头一次没取到：自己重新加载一次，第二次好了
mode = 'once'; seen = 0;
await T.go('');
let L = await look();
T.ok('turn.js 头一次没取到：页面自己重新加载了一次（一共取了两次），第二次取到了', seen === 2 && L.turn, [seen, L]);
T.ok('页面是好的：本子和这一页都载入了，屏幕上没有「页面没载全」那句话，记着「试过一次」的标记清掉了', L.page && L.bar === null && !L.key, L);
const n0 = await T.strokes();
await T.pen(T.line(120, 240, 90));
T.ok('能写字', (await T.strokes()) === n0 + 1, [n0, await T.strokes()]);
await T.saved();

// ================= 2. 一直取不到：只自己试一次，然后说一句、给「重新加载」
mode = 'always'; seen = 0;
await T.go('', { wait: false });
await settle(12000);
const tries = seen;
L = await look();
T.ok('一直取不到：只自己重新加载了一次（一共取了两次）', tries === 2, tries);
T.ok('屏幕上方出了那句话：写明缺 turn.js；带「重新加载」按钮（44 高）；整条在屏幕里、在上半边',
  L.bar === '页面没载全（缺 turn.js），可能写不了字。' && L.btn === '重新加载' && L.btnH >= 44 && L.inScreen === true && L.top < L.vh / 2, L);
await sleep(3500);
T.ok('之后不再自己重新加载（不会没完没了）', seen === tries, [tries, seen]);
await T.shot('load-retry-bar.png');

// ================= 3. 取得到了以后点「重新加载」：好了
mode = 'ok';
await T.tap('#loadTroubleBtn', 300);
await T.ready(30000);
L = await look();
T.ok('点「重新加载」：页面好了，那句话没了，标记清掉了', L.page && L.turn && L.bar === null && !L.key, L);
T.ok('刚才写的那一笔还在', (await T.strokes()) === n0 + 1, await T.strokes());

// ================= 4. 英文界面：那句话和按钮是英文
mode = 'always'; seen = 0;
await T.go('&lang=en', { wait: false });
await settle(12000);
L = await look();
T.ok('英文界面：那句话和按钮是英文', L.bar === 'The page did not load completely (missing turn.js). Writing may not work.' && L.btn === 'Reload', L);
mode = 'ok';
await T.tap('#loadTroubleBtn', 300);
await T.ready(30000);
L = await look();
T.ok('英文界面点 Reload：页面好了', L.page && L.turn && L.bar === null, L);

await T.cdp('Fetch.disable').catch(() => {});
// 这个测试里页面故意坏过几次：缺 turn.js 时主脚本会报「Turn is not defined」，这一种不算；别的报错照样算不对
const other = T.errors.filter((e) => !/Turn is not defined/.test(String(e)));
T.ok('故意弄坏的那几次，主脚本确实报了缺 Turn（说明不查的话页面就是坏着的）', T.errors.length > other.length, T.errors.length);
await T.finish({ errors: other });

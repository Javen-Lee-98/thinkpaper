// 公式落下前等 KaTeX 的字体（阶段 D1 修「第一个公式的宽度量错」时加的）：字体一直载不进来（请求卡住不回）时，
// 最多等 3 秒照旧落下、不卡住；页面打开不等这些字体。字体正常时量得对，由 reply_draw.mjs 查。
// 跑法：node tests/run_browser.mjs <临时目录> --only formula_font；有一项不对退出码 1。只在无头 Edge 里跑过。
import { boot, sleep } from '../browser_lib.mjs';

const T = await boot({ name: 'formula-font', open: false });
// KaTeX 的字体请求全都拦下、一直不放行（相当于电脑那头卡住了）
const held = [];
T.onCdp('Fetch.requestPaused', (p) => held.push(p.requestId));
await T.cdp('Network.enable');
await T.cdp('Network.setCacheDisabled', { cacheDisabled: true });
await T.cdp('Fetch.enable', { patterns: [{ urlPattern: '*KaTeX_*', requestStage: 'Request' }] });
const t0 = Date.now();
await T.go();
const opened = Date.now() - t0;
T.ok('字体卡住时页面照常打开（不等公式的字体）', opened < 15000 && (await T.evalJS(`Boolean(window.__ink.S.page)`)), opened);

await T.tap('#tools [data-tool=red]');
await T.pen(T.line(120, 200, 300));
await T.tap('#tools [data-tool=pen]');
await T.tap('#check');
const sub = await T.waitSub('S1');
T.ok('（前提）交上去了', Boolean(sub), sub);
const t1 = Date.now();
await T.post('/bridge/reply', { sid: 'S1', submission: sub.id, items: [{ type: 'formula', tex: 'a^2 + b^2 = c^2' }, { type: 'note', anchor: 'g1', text: '买三斤苹果' }] });
const landed = await T.waitFor(`window.__ink.S.page.ai.some((a) => a.type === 'formula')`, 15000), dt = Date.now() - t1;
T.ok('公式的字体一直载不进来：等到 3 秒左右照旧落下，没有卡住', landed && dt >= 2500 && dt < 9000, { landed, ms: dt, heldRequests: held.length });
T.ok('（前提）这段时间里 KaTeX 的字体请求真的被拦着', held.length > 0, held.length);
T.ok('同一条回复里的短批注也落下了，公式画在纸上', await T.waitFor(`window.__ink.S.page.ai.some((a) => a.type === 'note') && document.querySelector('#tex .tx .katex')`, 5000),
  await T.evalJS(`window.__ink.S.page.ai.map((a) => a.type)`));
const f = await T.evalJS(`(() => { const a = window.__ink.S.page.ai.find((o) => o.type === 'formula'); return a && a.lay; })()`);
T.ok('公式有占位（宽、高都是正的）', Boolean(f) && f.w > 40 && f.h >= 40, f);
// 放行之后照常能写
for (const id of held.splice(0)) await T.cdp('Fetch.continueRequest', { requestId: id }).catch(() => {});
await T.cdp('Fetch.disable');
await sleep(300);
await T.pen(T.line(120, 600, 200));
T.ok('之后照常能写字', (await T.strokes()) === 2, await T.strokes());

await T.finish();

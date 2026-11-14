// 设备配对和访问码：地址里带访问码打开就自动配对，平板上只留设备令牌、不留访问码；访问码不对出「需要访问码」；
// 电脑上断开这台设备后访问码一起换，平板下一次请求回到输入访问码，记着旧地址也进不来；输入新访问码重新配对后照常能写、能存。
// 访问码不打印：检查项的「得到的值」里只放真假和个数。
// 跑法：node tests/browser/devices.mjs [临时目录]；有一项不对退出码 1。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from '../browser_lib.mjs';

const T = await boot({ name: 'devices' });
const codeNow = () => readFileSync(join(T.DATA, 'access_code.txt'), 'utf8').trim(); // 电脑上现在的访问码（只用，不打印）
const devices = async () => (await T.get('/bridge/devices')).devices;
// 平板上记着什么：有没有设备令牌、记没记访问码、所有记下的东西里有没有出现访问码
const kept = (code) => T.evalJS(`(() => { const get = (k) => { try { return JSON.parse(localStorage.getItem('inkthink.' + k) || '""'); } catch (e) { return '?'; } };
  const all = Object.keys(localStorage).map((k) => localStorage.getItem(k)).join('\\n');
  return { token: String(get('device')).length > 20, codeKept: get('k') !== '', codeAnywhere: all.includes(${JSON.stringify(code)}) }; })()`);
const lockedShown = () => T.visible('#locked');
const entered = () => T.evalJS(`Boolean(window.__ink && window.__ink.S.page && window.__ink.S.online)`); // 进到纸了没有
// 在「需要访问码」里把框里的字换成 text（点一下框、全选、打字），再点「进入」
const enterCode = async (text) => {
  await T.tap('#codeInput');
  await T.evalJS(`document.querySelector('#codeInput').select()`);
  await T.cdp('Input.insertText', { text });
  await T.tap('#codeOk', 300);
};
const diskStrokes = () => { const p = T.pageFile('scratch', 0); return p ? p.strokes.filter((s) => !s.erasedAt).length : 0; };
const waitDisk = async (n, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (diskStrokes() === n) return true; await T.sleep(250); } return false; };

// 1. 地址里带访问码打开：自动配对，平板上只留设备令牌，不留访问码
const code0 = codeNow();
let k = await kept(code0), devs = await devices();
T.ok('带访问码打开：直接进到纸，没有要访问码', (await entered()) && !(await lockedShown()));
T.ok('自动配对了：电脑上列着这一台', devs.length === 1 && Boolean(devs[0].id) && Boolean(devs[0].name), devs.map((d) => d.name));
T.ok('平板上留了设备令牌', k.token, k);
T.ok('平板上没留访问码（记下的东西里哪儿都没有）', !k.codeKept && !k.codeAnywhere, k);
await T.pen(T.line(120, 260, 300));
T.ok('只凭设备令牌就能写、能存', (await T.strokes()) === 1 && (await waitDisk(1)), diskStrokes());

// 2. 一台新平板（什么都没记）拿着不对的访问码打开：出「需要访问码」，进不来；输入对的才进
await T.evalJS(`(localStorage.clear(), 1)`);
await T.go('?k=not-the-code&lang=zh&notour=1', { raw: true, wait: false });
T.ok('访问码不对：出现「需要访问码」的输入页', await T.waitFor(`!document.querySelector('#locked').hidden`) && /需要访问码/.test(await T.text('#locked h3'))
  && (await T.visible('#codeInput')) && (await T.visible('#codeOk')), await T.text('#locked h3'));
T.ok('没进到纸，电脑上也没多配一台', !(await entered()) && (await devices()).length === 1, (await devices()).length);
await enterCode('still-wrong');
await T.sleep(2500);
T.ok('再输一个不对的：还是停在输入页', (await lockedShown()) && !(await entered()) && (await devices()).length === 1, (await devices()).length);
await enterCode(code0);
await T.ready();
k = await kept(code0);
devs = await devices();
T.ok('输入对的访问码：进到纸了，输入页收起', (await entered()) && !(await lockedShown()));
T.ok('这台新配上了，平板上只留令牌、不留访问码', devs.length === 2 && k.token && !k.codeKept && !k.codeAnywhere, [devs.length, k]);
T.ok('之前写的那一笔还在', (await T.strokes()) === 1, await T.strokes());

// 3. 电脑上断开这台设备：访问码一起换；平板下一次请求（写一笔、自己存）就回到输入访问码
const mine = devs[devs.length - 1].id;
const rv = await T.post('/bridge/devices/revoke', { id: mine });
const code1 = codeNow();
devs = await devices();
T.ok('断开了：电脑上不再列这一台', rv.ok === true && devs.length === 1 && devs.every((d) => d.id !== mine), devs.length);
T.ok('访问码一起换了', code1.length >= 8 && code1 !== code0);
await T.pen(T.line(120, 330, 300));
T.ok('平板下一次请求回到「需要访问码」', await T.waitFor(`!document.querySelector('#locked').hidden`, 10000));
k = await kept(code1);
T.ok('平板上的令牌作废后清掉了，新访问码它也不知道', !k.token && !k.codeAnywhere, k);
T.ok('断开后那一笔没存到电脑上', diskStrokes() === 1, diskStrokes());

// 4. 记着旧地址（带旧访问码）重新打开：进不来
await T.go('', { wait: false }); // 测试工具记着的还是旧访问码
T.ok('旧地址打开：还是「需要访问码」，进不到纸', await T.waitFor(`!document.querySelector('#locked').hidden`) && !(await entered()));
await T.sleep(1500);
T.ok('电脑上没有因此多配一台', (await devices()).length === 1, (await devices()).length);
const old = await T.api('/api/notebooks');
T.ok('拿旧访问码直接请求也被拒', old.status === 401, old.status);

// 5. 输入新访问码：重新配对，照常能写、能存
await enterCode(code1);
await T.ready();
k = await kept(code1);
devs = await devices();
T.ok('输入新访问码：进到纸了', (await entered()) && !(await lockedShown()));
T.ok('重新配对了：电脑上又列着这一台，平板上只留令牌', devs.length === 2 && devs[devs.length - 1].id !== mine && k.token && !k.codeKept && !k.codeAnywhere, [devs.length, k]);
T.ok('地址里的旧访问码换成了新的（刷新不会又被拦）', (await T.evalJS(`new URLSearchParams(location.search).get('k') === ${JSON.stringify(code1)}`)) === true);
await T.pen(T.line(120, 400, 300));
T.ok('照常能写、能存', (await T.strokes()) === 2 && (await waitDisk(2)), [await T.strokes(), diskStrokes()]);
await T.reload();
T.ok('刷新后还在纸上，两笔都在', (await entered()) && !(await lockedShown()) && (await T.strokes()) === 2, await T.strokes());

await T.finish();

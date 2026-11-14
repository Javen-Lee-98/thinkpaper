// 跑 tests/browser 下所有浏览器测试，最多 3 个同时跑；每个的输出存到 <临时目录>/logs/<名字>.log。
// 用法：node tests/run_browser.mjs <临时目录> [--only 名字里的词]
// 每个测试有一项不对就以 1 退出；这里有任何一个没过，退出码也是 1。标着「已知不过」的项单独列出来，不算失败。
import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..'), DIR = join(APP, 'tests', 'browser');
const args = process.argv.slice(2), oi = args.indexOf('--only'), only = oi >= 0 ? args.splice(oi, 2)[1] : '';
const SP = args[0];
if (!SP) { console.error('用法：node tests/run_browser.mjs <临时目录> [--only 名字里的词]'); process.exit(2); }
const OUT = join(SP, 'logs');
mkdirSync(OUT, { recursive: true });
const files = readdirSync(DIR).filter((f) => f.endsWith('.mjs') && (!only || f.includes(only))).sort();

const runOne = (f) => new Promise((res) => {
  const t0 = Date.now(), p = spawn(process.execPath, [join(DIR, f), SP], { cwd: APP });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => p.kill(), 300000);
  p.on('close', (code) => {
    clearTimeout(timer);
    writeFileSync(join(OUT, f.replace('.mjs', '.log')), err + '\n' + out);
    let r = null;
    try { r = JSON.parse(out.slice(out.indexOf('{'))); } catch (e) { /* 没打出结果：脚本中途死了 */ }
    res({ f, code, s: Math.round((Date.now() - t0) / 1000), r });
  });
});

const queue = files.slice(), results = [];
async function worker() { for (let f; (f = queue.shift());) results.push(await runOne(f)); }
await Promise.all([worker(), worker(), worker()]);
results.sort((a, b) => a.f.localeCompare(b.f));
let checks = 0;
for (const x of results) {
  const n = x.r ? x.r.passed : 0, bad = x.r ? x.r.fail.length : '?', known = x.r ? x.r.known.filter((k) => !k.passedNow).length : 0;
  checks += n;
  console.log(`${x.code === 0 ? 'ok  ' : 'FAIL'} ${x.f}（${x.s} 秒；对 ${n} 项，不对 ${bad} 项${known ? `，已知不过 ${known} 项` : ''}）`);
  if (x.r) for (const f of x.r.fail) console.log(`       不对：${f.name}`);
  if (x.r) for (const e of x.r.errors || []) console.log(`       页面报错：${String(e).split('\n')[0]}`);
  if (x.r) for (const k of x.r.known) console.log(`       ${k.passedNow ? '原标已知不过，现在过了' : '已知不过'}：${k.name}${k.passedNow ? '' : ' —— ' + k.why}`);
  if (!x.r) console.log('       没有打出结果，看日志');
}
const bad = results.filter((x) => x.code !== 0).length;
// 浏览器的一次性配置目录：每个测试退出时自己删（见 browser_lib.mjs）；超时被停掉的来不及删，这里再扫一遍，还剩的说出来
const left = [];
for (const d of readdirSync(SP, { withFileTypes: true })) {
  const prof = join(SP, d.name, 'browser');
  if (!d.isDirectory() || !existsSync(join(prof, 'Local State'))) continue;
  try { rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch (e) { /* 还被占着 */ }
  if (existsSync(prof)) left.push(prof);
}
for (const p of left) console.log(`       浏览器配置目录没删掉（浏览器可能还开着），请手动删：${p}`);
console.log(`${results.length - bad}/${results.length} 个测试通过，共检查 ${checks} 项；日志在 ${OUT}`);
process.exit(bad ? 1 : 0);

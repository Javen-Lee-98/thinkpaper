// 现在的页面（只有这一套）：只有纸、左上角的本子名和页码（点开抽屉）、右下角一条（退出全屏、黑笔、红笔、橡皮、撤销、检查）；
// 上下页接在一起；抽屉里「这本发往」换对话；「检查」只有这一页新写就整页交、别的页也有新写的就一起交，
// 不带档位、不带补一句；空页不交；旧的试用页地址跳到这里；电脑上的服务停了，顶上写出来。
// 跑法：node tests/browser/page_simple.mjs [临时目录]；有一项不对退出码 1。
import { execFileSync } from 'node:child_process';
import { boot } from '../browser_lib.mjs';

const T = await boot({ name: 'page-simple', pages: 3,
  sessions: [{ sid: 'S1', label: 'idea' }, { sid: 'S2', label: 'MY_PAPER', cwd: 'E:\\x\\MY_PAPER' }] });
const js = T.evalJS;
// 当前页的纸在屏幕上到哪儿为止、屏幕多高
const paper = () => js(`(() => { const S = window.__ink.S, v = S.view; return { bottom: Math.round(v.ty + S.pageH * v.s), screen: innerHeight, pages: S.nb.pages, idx: S.idx }; })()`);
// 翻到第 i + 1 页：打开抽屉，点那一页的缩略图，再把抽屉收起
async function gotoPage(i) {
  if (!(await T.visible('#drawer'))) await T.tap('#nbChip');
  await T.tap(`#thumbs .th:nth-child(${i + 1})`, 1200);
  if (await T.visible('#drawer')) await T.tap('#nbChip');
}

// 1. 屏幕上只有纸、左上角的本子名、右下角一条；上下页接在一起
T.ok('只有这一套页面：没有区分新旧界面的标记', await js(`!document.body.classList.contains('simple') && !('SIMPLE' in window.__ink) && document.querySelectorAll('.full-only, .simple-only').length === 0`));
T.ok('没有顶栏、左侧工具栏、全屏浮动条', !(await T.visible('#bar')) && !(await T.visible('#rail')) && !(await T.visible('#floatbar')));
const btns = await js(`[...document.querySelectorAll('#tools button')].map((b) => b.dataset.tool || b.id).join(',')`);
T.ok('右下角一条：退出全屏、黑笔、红笔、橡皮、撤销、AI', (await T.visible('#tools')) && btns === 'toolsBars,pen,red,eraser,toolsUndo,check', btns);
const nb0 = await js(`({ title: window.__ink.S.nb.title, pages: window.__ink.S.nb.pages, idx: window.__ink.S.idx })`);
T.ok('左上角是本子名和页码', (await T.visible('#nbChip')) && (await T.text('#chipName')) === nb0.title && nb0.pages === 3
  && (await T.text('#chipPage')) === `${nb0.idx + 1}/${nb0.pages}`, [nb0, await T.text('#chipName'), await T.text('#chipPage')]);
T.ok('上下页接在一起（连续阅读）', await js(`window.__ink.S.flow === true`));
await T.shot('1-page.png');

// 2. 点本子名打开抽屉；「这本发往」换成 MY_PAPER；再点本子名收起
await T.tap('#nbChip');
T.ok('点本子名打开抽屉', await T.visible('#drawer'));
T.ok('抽屉里有「这本发往」', (await T.visible('#actTarget')) && (await T.text('#actTarget')).startsWith('这本发往：'), await T.text('#actTarget'));
await T.tap('#actTarget');
T.ok('点开选对话', (await T.visible('#targetPick')) && (await T.text('#targetPickList')).includes('MY_PAPER'), await T.text('#targetPickList'));
await T.tap('#targetPickList button[data-sid="S2"]');
await T.sleep(500);
T.ok('选了 MY_PAPER：这本绑到它', (await js(`(window.__ink.S.nb.target || {}).sid`)) === 'S2' && !(await T.visible('#targetPick')));
T.ok('抽屉还开着，那一行跟着变', (await T.visible('#drawer')) && (await T.text('#actTarget')).includes('MY_PAPER'), await T.text('#actTarget'));
await T.tap('#nbChip');
T.ok('再点本子名收起抽屉', !(await T.visible('#drawer')));

// 3. 写一笔，点「检查」：整页交给 MY_PAPER，不带档位、不带补一句
await T.tap('#tools [data-tool=red]');
T.ok('红笔选中', (await js(`window.__ink.S.tool`)) === 'red' && (await js(`document.querySelector('#tools [data-tool=red]').classList.contains('on')`)));
await T.tap('#tools [data-tool=pen]');
await T.pen(T.line(120, 260, 300));
T.ok('写上了', (await T.strokes()) === 1, await T.strokes());
await T.sleep(1100);
await T.tap('#check');
const sub1 = await T.waitSub('S2');
const m1 = sub1 && T.metaOf(sub1);
T.ok('交给了 MY_PAPER', Boolean(sub1) && sub1.text.startsWith('【草稿纸】'), sub1 && sub1.text.slice(0, 40));
T.ok('整页（图从纸的左上角起、宽到整个正文区）、不带档位、不带补一句', Boolean(m1) && Boolean(m1.crop) && m1.crop.x0 <= 0 && m1.crop.y0 <= 0 && m1.crop.x1 >= 1000
  && !m1.depth && !m1.note, m1 && { crop: m1.crop, depth: m1.depth, note: m1.note });
T.ok('平板不再发用不上的 whole_page、overview_window', Boolean(m1) && !('whole_page' in m1) && !('overview_window' in m1), m1 && Object.keys(m1));
T.ok('消息里没有档位和「我另外写的一句」', Boolean(sub1) && !/档位/.test(sub1.text) && !/我另外写的一句/.test(sub1.text), sub1 && sub1.text.slice(0, 200));
T.ok('原来的对话没收到', !(await T.poll('S1')));

// 4. 撤销
await T.pen(T.line(120, 330, 200));
const before = await T.strokes();
await T.tap('#toolsUndo');
T.ok('撤销去掉最后一笔', before === 2 && (await T.strokes()) === 1, [before, await T.strokes()]);

// 4b. 紧挨着、连着写的几笔算一组（出过每一笔都自成一组的事故：同名函数盖掉了分组用的距离函数）
await T.pen(T.line(600, 600, 60));
await T.pen(T.line(600, 625, 60));
await T.pen(T.line(600, 650, 60));
const gn = await js(`window.__ink.computeGroups(window.__ink.inkStrokes()).map((g) => g.n)`);
T.ok('连着写的三笔是一组', gn[gn.length - 1] === 3, gn);
await T.sleep(1100);
await T.tap('#check'); // 这三笔先交掉，下面第 5 步只看第 2、3 页
const sub4 = await T.waitSub('S2');
T.ok('交上去的也是一组三笔', Boolean(sub4) && (T.metaOf(sub4).groups || []).some((g) => g.n === 3), sub4 && (T.metaOf(sub4).groups || []).map((g) => g.n));

// 5. 第 2、3 页各写一笔，停在第 3 页点「检查」：两页一起交（只交新写的），不问
await gotoPage(1);
await T.pen(T.line(120, 300, 300));
await gotoPage(2);
let pp = await paper();
T.ok('最后一页的纸铺到屏幕底', pp.idx === 2 && pp.idx === pp.pages - 1 && pp.bottom >= pp.screen - 1, pp);
await T.pen(T.line(120, 400, 300));
T.ok('左上角的页码跟着变', (await T.text('#chipPage')) === `3/${nb0.pages}`, await T.text('#chipPage'));
await T.sleep(1100);
await T.tap('#check');
T.ok('不弹「只发这一页还是都发」', !(await T.visible('#sendPick')));
let sub = await T.waitSub('S2');
T.ok('两页一起交', Boolean(sub) && sub.text.startsWith('【草稿纸·整本】') && /── 第 2 页/.test(sub.text) && /── 第 3 页/.test(sub.text) && !/── 第 1 页/.test(sub.text),
  sub && sub.text.slice(0, 200));
T.ok('整本消息也不带档位', Boolean(sub) && !/档位/.test(sub.text));

// 5b. 第 1 页上有一条修改建议，用笔点它旁边的 ✓（那一页没写新字）：提示说下次「检查」带上，不提已经没有的「发送决定」；
//     换到第 2 页写一笔再检查：第 1 页连同这条决定一起交上去。
//     这条建议是直接放进页面数据的（准备工作）：空白纸上真回一条 suggest，页面会把它画成普通批注，不出 ✓ ×
await gotoPage(0);
await js(`(() => { const S = window.__ink.S;
  S.page.ai.push({ id: 'sx', type: 'suggest', t: Date.now(), text: '改为：平均速度', box: [120, 250, 420, 270], paths: [],
    lay: { x: 1044, y: 250, w: 336, h: 37, lines: ['改为：平均速度'], fs: 21, lh: 29 }, hit: [1038, 246, 1380, 291] });
  window.__ink.renderAI(); })()`);
const vb = await js(`(() => { const c = document.querySelector('#aiRoot .vbtn.yes circle'); return c ? [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))] : null; })()`);
const n0 = await T.strokes();
if (vb) await T.pen([[vb[0], vb[1]], [vb[0] + 2, vb[1] + 1]]);
const verdicts = await js(`window.__ink.S.page.ai.filter((a) => a.type === 'suggest').map((a) => a.verdict || '')`);
T.ok('建议旁边有 ✓；用笔点它就是采纳，这一点不留作笔迹', Boolean(vb) && verdicts.length === 1 && verdicts[0] === 'yes' && (await T.strokes()) === n0, { vb, verdicts });
T.ok('采纳后的提示说下次点「AI」带上', (await T.text('#toast')).includes('下次点「AI」') && !(await T.text('#toast')).includes('发送决定'), await T.text('#toast'));
await gotoPage(1);
await T.pen(T.line(120, 520, 200));
await T.sleep(1100);
await T.tap('#check');
sub = await T.waitSub('S2');
T.ok('没写新字的那一页连同决定一起交', Boolean(sub) && sub.text.startsWith('【草稿纸·整本】') && /── 第 1 页/.test(sub.text) && /── 第 2 页/.test(sub.text)
  && /「改为：平均速度」：采纳/.test(sub.text) && !/── 第 3 页/.test(sub.text), sub && sub.text.slice(0, 300));

// 6. 在抽屉里新建一本空白的：左上角换成它的名字；空页点「检查」不交
await T.tap('#nbChip');
await T.tap('#actNewNb');
await T.tap('#newNbTitle', 200);
await T.cdp('Input.insertText', { text: '暑假旅行笔记' });
await T.tap('#newNbOk', 1500);
T.ok('左上角换成新本子的名字', (await T.text('#chipName')) === '暑假旅行笔记' && !(await T.visible('#newNb')), await T.text('#chipName'));
pp = await paper();
T.ok('只有一页的空白本子：纸铺到屏幕底', pp.pages === 1 && pp.bottom >= pp.screen - 1, pp);
await T.sleep(2200); // 等「已建立」的提示过去
await T.tap('#check');
T.ok('空页不交', !(await T.poll('S2')) && !(await T.poll('S1')));
T.ok('提示还没写字', (await T.visible('#toast')) && (await T.text('#toast')).includes('还没写字'), await T.text('#toast'));

// 7. 旧的试用页地址跳到这里，访问码等参数照带
await T.go('', { path: 'static/plain.html' });
T.ok('试用页地址跳到现在的页面', (await js(`location.pathname + '|' + new URLSearchParams(location.search).get('notour')`)) === '/|1'
  && (await js(`Boolean(window.__ink && document.querySelector('#check') && document.querySelector('#nbChip'))`)), await js(`location.pathname`));

// 8. 电脑上的服务停了：顶上写出来，新写的字没存上也说明白（没有状态栏，不写就什么都看不到）
await T.go();
await T.pen(T.line(120, 620, 200));
await T.sleep(2500);
T.ok('平时没有提示', !(await T.visible('#trouble')), await T.text('#trouble'));
const errorsOnline = T.errors.slice(); // 服务还在时页面报的错（停掉以后连不上的报错不算）
T.stopHello();
try { execFileSync('taskkill', ['/PID', String(T.srv.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* 已经没了 */ }
await T.sleep(1200);
await T.pen(T.line(120, 700, 200));
let tr = '';
for (let i = 0; i < 40 && !tr.includes('还没存上'); i++) { await T.sleep(500); tr = await T.text('#trouble'); }
T.ok('服务停了又写了字：顶上提示字还没存上、先别刷新', (await T.visible('#trouble')) && tr.includes('还没存上') && tr.includes('先别刷新'), tr);
await T.shot('8-offline.png');

T.ok('服务还在的时候页面没有报错', !errorsOnline.length, errorsOnline);
await T.finish({ errors: errorsOnline });

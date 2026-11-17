// 最基本的一条线：用笔写、橡皮擦、撤销、自己存到电脑上、刷新后还在、点「AI」交上去。
// 跑法：node tests/browser/ink_basic.mjs [临时目录]；有一项不对退出码 1。
import { boot } from '../browser_lib.mjs';

const T = await boot({ name: 'ink-basic' });

// 1. 黑笔写两笔、红笔写一笔
await T.pen(T.line(120, 260, 300));
await T.pen(T.line(120, 330, 300));
T.ok('黑笔写了两笔', (await T.strokes()) === 2, await T.strokes());
await T.tap('#tools [data-tool=red]');
await T.pen(T.line(120, 420, 260));
const cols = await T.evalJS(`window.__ink.S.page.strokes.map((s) => s.c || '')`);
T.ok('第三笔是红笔', cols.length === 3 && cols[2] === 'r' && cols[0] === '' && cols[1] === '', cols);
const pts = await T.evalJS(`window.__ink.S.page.strokes[0].pts.length`);
T.ok('一笔里记了多个点（位置、轻重、时刻）', pts >= 5 && (await T.evalJS(`window.__ink.S.page.strokes[0].pts[0].length`)) === 4, pts);

// 2. 橡皮擦掉第二笔，撤销找回
await T.tap('#tools [data-tool=eraser]');
await T.pen([[200, 322], [210, 338]]);
T.ok('橡皮擦掉一笔', (await T.strokes()) === 2, await T.strokes());
await T.tap('#toolsUndo');
T.ok('撤销把擦掉的找回来', (await T.strokes()) === 3, await T.strokes());
await T.tap('#tools [data-tool=pen]');
await T.pen(T.line(120, 500, 200));
await T.tap('#toolsUndo');
T.ok('撤销去掉刚写的一笔', (await T.strokes()) === 3, await T.strokes());

// 3. 自己存到电脑上；刷新后还在
T.ok('写完自己存上了', await T.saved(), await T.evalJS(`({ dirty: window.__ink.S.dirty, saving: window.__ink.S.saving })`));
const onDisk = T.pageFile('scratch', 0);
T.ok('电脑上的页面文件里有这三笔', Boolean(onDisk) && onDisk.strokes.filter((s) => !s.erasedAt).length === 3, onDisk && onDisk.strokes.length);
await T.reload();
T.ok('刷新后三笔还在', (await T.strokes()) === 3, await T.strokes());

// 4. 点「AI」：这一页交给连着的对话
await T.tap('#check');
const sub = await T.waitSub('S1');
T.ok('交上去了，是一条【草稿纸】消息', Boolean(sub) && sub.text.startsWith('【草稿纸】'), sub && sub.text.slice(0, 60));
const meta = sub && T.metaOf(sub);
T.ok('带着笔迹分组，红笔那组标着红', Boolean(meta) && (meta.groups || []).length >= 2 && meta.groups.some((g) => g.red), meta && meta.groups);
T.ok('消息里列了图的路径和写回用的编号', Boolean(sub) && /先用 Read 看/.test(sub.text) && sub.text.includes(sub.id), sub && sub.text.slice(-120));

await T.finish();

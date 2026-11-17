import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Call = { path: string; body?: Record<string, unknown> }
type Entry = { name: string; kind: 'file' | 'dir'; mtimeMs: number }
type World = {
  calls: Call[]
  queue: { id: string; text: string }[]
  prompts: string[]
  tools: string[]
  schemas: Record<string, any>
  descs: Record<string, string>
  up: boolean
  runs: string[][]
  files: Record<string, Entry[]>
  answered: number
  cwd: string
  asked: number // 问话卡片：还要等几次（ask-wait 回 pending）才答；Infinity 是一直不答
  askReply: Record<string, unknown> // ask-wait 答了时回什么
  tabletUp: boolean // 平板开着草稿纸（/bridge/ask 不在线时回 offline）
  local?: boolean // 平板上开着的是「只在本地」的本子：状态里不带名字，带 targetLocal
  edited: number // 「覆盖还是另存」卡片：还要等几次（edit-wait 回 pending）才选；Infinity 是一直不选
  editReply: Record<string, unknown> // edit-wait 选了时回什么
  editFail: string // /bridge/edit 出错时的话（比如留底没做成）；空的不出错
  remind: string // /bridge/import 带的提醒
  replyNotes: unknown // /bridge/reply 带的 notes（服务把关时查出来的话）
}

const HELLO = {
  url: 'http://192.0.2.5:8765/?k=abc', // 192.0.2.x 是专门给文档和示例用的地址段（RFC 5737）
  qr: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  isTarget: true,
  tabletOnline: true,
  targetLabel: 'idea',
  sessions: 1,
  submissionsDir: 'E:\\ink\\data\\submissions',
  skipDirs: ['E:\\proj\\idea\\inkthink\\data'],
}

// 站在引擎和中转服务的位置上：这些钩子在插件之下回答它的调用
function world(on: On): World {
  const w: World = {
    calls: [], queue: [], prompts: [], tools: [], schemas: {}, descs: {}, up: true, runs: [], files: {}, answered: 2, cwd: 'E:\\proj\\idea',
    asked: 2, askReply: { answer: { choice: '另存' }, text: '我点了「另存」。' }, tabletUp: true,
    edited: 2, editReply: { done: true, mode: 'saveas', target: 'E:\\proj\\idea\\清单 v2.md', text: '已经另存了一份：E:\\proj\\idea\\清单 v2.md', chose: '另存' },
    editFail: '', remind: '', replyNotes: undefined,
  }
  on('process.run', (_, e) => {
    w.runs.push([...e.argv])
    w.up = true
    return { value: { exitCode: 0, stdout: 'started', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', (_, e) => {
    if (!w.up) throw new Error('connection refused')
    const url = new URL(e.url)
    const body = e.init?.body ? (JSON.parse(String(e.init.body)) as Record<string, unknown>) : undefined
    w.calls.push({ path: url.pathname, body })
    const json = (obj: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(obj) } })
    if (url.pathname === '/bridge/ping') return json({ ok: true, app: 'inkthink' })
    if (url.pathname === '/bridge/hello' || url.pathname === '/bridge/status')
      return json(w.local ? { ...HELLO, isTarget: false, targetLabel: '', targetNb: '', targetLocal: true } : HELLO)
    if (url.pathname === '/bridge/poll') return json(w.queue.length ? { submission: w.queue.shift() } : {})
    if (url.pathname === '/bridge/reply') {
      const items = (body?.items as unknown[]) ?? []
      return json({ ok: true, count: items.length, page: '草稿本第 1 页（空白草稿纸）', tabletOnline: true, ...(w.replyNotes === undefined ? {} : { notes: w.replyNotes }) })
    }
    if (url.pathname === '/bridge/scan') return json({ id: 'scan1', pages: 2, text: '【草稿纸·整本】……' })
    if (url.pathname === '/bridge/import') {
      return json({ ok: true, id: 'book:汇报.pdf', title: '汇报', pages: 2, updated: '第 2 页有改动', tabletOnline: true, remind: w.remind || null })
    }
    if (url.pathname === '/bridge/edit') {
      if (w.editFail) return { value: { status: 400, ok: false, headers: {}, text: JSON.stringify({ error: w.editFail }) } }
      if (body?.mode) return json({ done: true, mode: body.mode, target: body.path, text: `可以改了：改 ${String(body.path)} 本身（${String(body.mode)}）` })
      return json(w.tabletUp ? { ask: 'e1', name: '清单.md' } : { offline: true, text: '平板现在没打开草稿纸，没法弹卡片：在对话里问用户，改《清单.md》是覆盖原文件还是另存一份，再带上 mode 调一次 ink_edit。' })
    }
    if (url.pathname === '/bridge/edit-wait') {
      const pending = { pending: true, tabletOnline: true, text: '用户还没选（卡片留在平板顶上）。这一轮就停在这里等着：不要替用户选，也不要先动这个文件。' }
      if (body?.wait === 0) return json(pending)
      w.edited--
      return json(w.edited > 0 ? pending : w.editReply)
    }
    if (url.pathname === '/bridge/confirm') return json({ id: 'c1', tabletOnline: true })
    if (url.pathname === '/bridge/confirm-wait') {
      w.answered--
      return json(w.answered > 0 ? { pending: true } : { answers: [{ text: 'ρ' }], text: '1. g3：这是？ → 是「ρ」。' })
    }
    if (url.pathname === '/bridge/ask') return json(w.tabletUp ? { id: 'q1', tabletOnline: true } : { offline: true })
    if (url.pathname === '/bridge/ask-wait') {
      if (body?.wait === 0) return json({ pending: true }) // 只来记一下「不等了」
      w.asked--
      return json(w.asked > 0 ? { pending: true } : w.askReply)
    }
    return json({ ok: true })
  })
  on('fs.list', (_, e) => ({ value: (w.files[e.path ?? ''] ?? []).map(f => ({ ...f, size: 1, isLink: false })) }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  for (const tool of ['Read', 'Edit']) on('tool.call', { tool }, () => ({ result: 'ok' }))
  on('tool.register', (_, e) => {
    w.tools.push(e.name)
    w.schemas[e.name] = e.inputSchema
    w.descs[e.name] = String((e as { description?: unknown }).description ?? '')
    return { value: { tool: `mcp__inkpad__${e.name}` } }
  })
  on('command.register', () => ({ value: { command: 'ink' } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return w
}

test('平板发来的内容进入这个对话，批注能写回去（VS Code 宿主：会话开始时无界面、非交互）', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)

  await $.session.start({ cwd: 'E:\\proj\\idea', surface: null, isInteractive: false })
  await clock.settle()
  expect(w.tools).toEqual(['ink_reply', 'ink_show', 'ink_snapshot', 'ink_import', 'ink_scan', 'ink_confirm', 'ink_ask', 'ink_edit'])
  const hello = w.calls.find(c => c.path === '/bridge/hello')
  expect(hello?.body).toEqual({ sid: 'sess-1', label: 'idea', cwd: 'E:\\proj\\idea' })

  w.queue.push({ id: 's1', text: '【草稿纸】我在平板上写了一些东西发给你。' })
  await clock.advance(1600)
  expect(w.prompts).toEqual(['【草稿纸】我在平板上写了一些东西发给你。'])

  const ran = await $.tool.call({
    tool: 'mcp__inkpad__ink_reply',
    submission: 's1',
    items: [{ type: 'question', anchor: 'g2', text: '单位对吗？' }],
  })
  expect(ran.result).toBe('已写到草稿纸：草稿本第 1 页（空白草稿纸），共 1 条')
  const reply = w.calls.find(c => c.path === '/bridge/reply')
  expect(reply?.body).toEqual({ sid: 'sess-1', submission: 's1', items: [{ type: 'question', anchor: 'g2', text: '单位对吗？' }] })
  const item = w.schemas.ink_reply.properties.items.items.properties
  expect(Object.keys(item)).toContain('q')
  // 长回答（2026-11-13）：平板标圈号、点开看全文；不再改写（没有 revises），write 的 anchor 不写 end
  expect(Object.keys(item).includes('revises')).toBe(false)
  const say = w.descs.ink_reply
  expect(say.includes('平板在那里标一个圈号，用户点圈号才看到全文，不占纸面')).toBe(true)
  // 阶段 E：长回答从不写在页末，那句说法改成「圈号是平板自己标的」
  expect(say.includes('圈号是平板自己标的，不用另画 number 去配，write 的 anchor 也不要写 end')).toBe(true)
  expect(say.includes('页末')).toBe(false)
  expect(say.includes('回一条新的 write（anchor 填那条红笔），旧的那条用户自己擦')).toBe(true)
  expect(say.includes('解释按圈号写在页末')).toBe(false)
  expect(item.anchor.description.includes('write 填所答的那条红笔')).toBe(true)
  expect(item.type.description.startsWith('write 长的回答（平板在 anchor 那处标一个圈号')).toBe(true)
  // 卡片上的红字（2026-11-14）：回应用 write 带 card（那张卡片的圈号），接在那张卡片下面；插件原样转给服务
  expect(item.card.type).toBe('number')
  expect(item.card.description.includes('那张卡片的圈号 n')).toBe(true)
  expect(say.includes('回应用 write，card 填 n，q 填你读到的那句红字，这段接在那张卡片最下面，不出新的圈号')).toBe(true)
  // 纸上的短批注上写了红字（2026-11-14）：交上来时它已收成圈号、变成卡片，回应办法一样（同一个 card）
  expect(say.includes('用户在纸上的短批注上直接写了红字时，那条短批注交上来时已收成圈号、变成这样一张卡片，回应的办法一样')).toBe(true)
  expect(item.card.description.includes('长回答卡片（或短批注收成的卡片）')).toBe(true)
  await $.tool.call({ tool: 'mcp__inkpad__ink_reply', submission: 's1', items: [{ type: 'write', card: 2, q: '这句不对', text: '改成：和店家无关' }] })
  const replies = w.calls.filter(c => c.path === '/bridge/reply')
  expect(replies.length).toBe(2)
  expect(replies[1].body).toEqual({ sid: 'sess-1', submission: 's1', items: [{ type: 'write', card: 2, q: '这句不对', text: '改成：和店家无关' }] })
  expect(item.type.enum).toContain('suggest')
  for (const t of ['tick', 'cross', 'strike', 'insert', 'wavy', 'highlight', 'brace', 'number']) expect(item.type.enum).toContain(t)
  for (const t of ['label', 'node', 'link', 'group']) expect(item.type.enum).toContain(t)
  expect(item.anchors.type).toBe('array')
  expect(item.links.type).toBe('array')
  expect(item.type.enum).toContain('sketch')
  expect(item.type.enum).toContain('formula')
  expect(item.tex.type).toBe('string')
  expect(item.shapes.items.properties.type.enum).toEqual(['line', 'curve', 'rect', 'ellipse', 'text', 'axes'])
  expect(w.calls.some(c => c.path === '/bridge/route')).toBe(false) // 投递直接交进对话，不再先问服务走哪条
})

test('读草稿纸投递的图片不用问，别处的照旧', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  on('fs.stat', (_, e) => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('tool.check', () => ({ decision: 'ask' as const }))
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()

  const inside = await $.tool.check({ tool: 'Read', input: { file_path: 'e:/ink/data/submissions/2026/crop.jpg' } })
  expect(inside.decision).toBe('allow')
  const outside = await $.tool.check({ tool: 'Read', input: { file_path: 'E:\\secret\\notes.txt' } })
  expect(outside.decision).toBe('ask')
})

test('面板在每个界面都画得出来，VS Code 里有二维码', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()

  const PANE = {
    plugin: 'inkpad',
    component: 'Pane',
    requestId: 'inkpad',
    props: { title: '手写草稿纸', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as const
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /平板发送的内容会进入这个对话/ }))?.text).toBe('平板发送的内容会进入这个对话')
    if (surface !== 'terminal') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    await ui.unmount()
  }
})

test('平板上开着的是只在本地的本子：/ink 和面板说它只在本地，不说发往谁，也没有「改发到这个对话」', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.local = true
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  const out = JSON.stringify(await $.command.run({ command: 'ink', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }))
  expect(out).toContain('平板上开着的这一本设成了「只在本地」，不发给 Claude')
  expect(out).not.toContain('发往「')
  expect(out).not.toContain('/ink here')
  const ui = await $.ui.mount({
    plugin: 'inkpad', component: 'Pane', requestId: 'inkpad', surface: 'vscode',
    props: { title: '手写草稿纸', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect((await ui.find({ type: 'Text', text: /只在本地/ }))?.text).toBe('平板上开着的这一本只在本地，不发给 Claude')
  expect(await ui.find({ type: 'Text', text: /发往：/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', label: '这本改发到这个对话' })).toBeUndefined()
  await ui.unmount()
})

test('服务没开时：开对话不自动启动，/ink 才启动', { options: { server_command: 'E:\\proj\\idea\\inkthink\\.venv\\Scripts\\python.exe E:\\proj\\idea\\inkthink\\launch.py' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.up = false
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.advance(5000)
  expect(w.runs).toEqual([])
  expect(w.calls.length).toBe(0)

  const out = await $.command.run({ command: 'ink', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(w.runs.length).toBe(1)
  expect(w.runs[0]?.[1]).toBe('E:\\proj\\idea\\inkthink\\launch.py')
  expect(JSON.stringify(out)).toContain('平板浏览器打开')
  await clock.advance(1600)
  expect(w.calls.some(c => c.path === '/bridge/poll')).toBe(true)
})

test('对话的名字取项目根目录（cd 到别处不变）；打字时报那句话的开头，斜杠命令不报', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  on('session.root', () => ({ value: 'E:\\proj\\inkthink' }))
  w.cwd = 'C:\\Users\\me\\.claude' // 在对话里 cd 到了别处
  await $.tool.call({ tool: 'mcp__inkpad__ink_reply', submission: 's9', items: [{ type: 'write', text: '好' }] }) // 中途重新加载：没有 session.start
  await clock.settle()
  expect(w.calls.find(c => c.path === '/bridge/hello')?.body?.label).toBe('inkthink')
  await $.prompt.submit({ text: '那么现在我已经有问题了\n第二行不要', origin: { kind: 'composer' } } as any)
  await $.prompt.submit({ text: '/ink here', origin: { kind: 'composer' } } as any)
  const active = w.calls.filter(c => c.path === '/bridge/active').map(c => c.body?.hint)
  expect(active).toEqual(['那么现在我已经有问题了', undefined])
})

test('系统提示里放服务给的固定说明；服务没给时什么也不加', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  on('prompt.compose', () => ({ sections: [] }))
  const compose = () => $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: null, isInteractive: false })
  await clock.settle()
  expect((await compose()).sections.find(s => s.id === 'inkpad:protocol')).toBeUndefined()
  ;(HELLO as Record<string, unknown>).protocol = '## 手写草稿纸（inkpad）\n- 固定说明全文'
  try {
    await clock.advance(1600 * 4) // 每 4 次轮询刷新一次状态
    const now = (await compose()).sections.find(s => s.id === 'inkpad:protocol')
    expect(now?.text).toBe('## 手写草稿纸（inkpad）\n- 固定说明全文')
    expect(now?.scope).toBe('session')
  } finally {
    delete (HELLO as Record<string, unknown>).protocol
  }
  expect(w.calls.some(c => c.path === '/bridge/status')).toBe(true)
})

test('会话中途重新加载（没有 session.start）：第一次调用工具时补上启动，开始轮询', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.tool.call({ tool: 'mcp__inkpad__ink_reply', submission: 's9', items: [{ type: 'write', text: '好' }] })
  await clock.settle()
  expect(w.tools).toEqual(['ink_reply', 'ink_show', 'ink_snapshot', 'ink_import', 'ink_scan', 'ink_confirm', 'ink_ask', 'ink_edit'])
  expect(w.calls.find(c => c.path === '/bridge/hello')?.body).toEqual({ sid: 'sess-1', label: 'idea', cwd: 'E:\\proj\\idea' })
  await clock.advance(1600)
  expect(w.calls.some(c => c.path === '/bridge/poll')).toBe(true)
})

test('投递交进对话后才确认收到；服务再给一次同一条时不重复交', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  w.queue.push({ id: 's1', text: '【草稿纸】一' }, { id: 's1', text: '【草稿纸】一' }, { id: 's2', text: '【草稿纸】二' })
  await clock.advance(6000)
  await clock.settle()
  expect(w.prompts.filter(p => p.startsWith('【草稿纸】'))).toEqual(['【草稿纸】一', '【草稿纸】二'])
  expect(w.calls.filter(c => c.path === '/bridge/ack').map(c => c.body)).toEqual([{ sid: 'sess-1', id: 's1' }, { sid: 'sess-1', id: 's2' }])
})

test('/ink stop 停止服务；之后发现服务不在也不自动重启', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  await $.command.run({ command: 'ink', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const out = await $.command.run({ command: 'ink', args: 'stop', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(JSON.stringify(out)).toContain('已停止')
  expect(w.calls.some(c => c.path === '/bridge/stop')).toBe(true)
  w.up = false
  const runs = w.runs.length
  await clock.advance(40000)
  expect(w.runs.length).toBe(runs)
})

test('/ink 打开面板并给出平板地址', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  const out = await $.command.run({ command: 'ink', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(JSON.stringify(out)).toContain('http://192.0.2.5:8765/?k=abc')
})

test('改过的文档再导入：原地更新，结果里说明改了什么', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  const imp = await $.tool.call({ tool: 'mcp__inkpad__ink_import', path: '汇报.pdf' })
  expect(imp.result).toBe('已原地更新《汇报》（共 2 页，用户的手写保留）：第 2 页有改动。平板上改过的页会标出改动处，可对比旧版。')
  expect(w.calls.find(c => c.path === '/bridge/import')?.body).toEqual({ sid: 'sess-1', path: 'E:\\proj\\idea\\汇报.pdf', as_new: false })
  // 原文件改过、留底里却没有记录（没先调 ink_edit）：服务给的提醒接在结果后面，照样导入（不拦）
  w.remind = '提醒：这个文件在上次导入之后改过，留底里却没有那之后的记录。'
  const again = await $.tool.call({ tool: 'mcp__inkpad__ink_import', path: '汇报.pdf' })
  expect(again.result).toBe('已原地更新《汇报》（共 2 页，用户的手写保留）：第 2 页有改动。平板上改过的页会标出改动处，可对比旧版。\n提醒：这个文件在上次导入之后改过，留底里却没有那之后的记录。')
})

test('改文件（ink_edit）：没带 mode 在平板上问、等到用户选；带 mode 不弹卡片；三个工具的说明讲的是同一套', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  const ran = await $.tool.call({ tool: 'mcp__inkpad__ink_edit', path: '清单.md' })
  expect(ran.result).toBe('已经另存了一份：E:\\proj\\idea\\清单 v2.md')
  expect(w.calls.find(c => c.path === '/bridge/edit')?.body).toEqual({ sid: 'sess-1', path: 'E:\\proj\\idea\\清单.md' }) // 不带 mode
  expect(w.calls.filter(c => c.path === '/bridge/edit-wait').map(c => c.body)).toEqual([
    { id: 'e1', wait: 25, last: false },
    { id: 'e1', wait: 25, last: false },
  ])
  // 用户在对话里说了覆盖：带 mode，不弹卡片、不等
  const before = w.calls.filter(c => c.path === '/bridge/edit-wait').length
  const direct = await $.tool.call({ tool: 'mcp__inkpad__ink_edit', path: 'E:\\proj\\idea\\清单.md', mode: 'overwrite' })
  expect(direct.result).toBe('可以改了：改 E:\\proj\\idea\\清单.md 本身（overwrite）')
  expect(w.calls.filter(c => c.path === '/bridge/edit').at(-1)?.body).toEqual({ sid: 'sess-1', path: 'E:\\proj\\idea\\清单.md', mode: 'overwrite' })
  expect(w.calls.filter(c => c.path === '/bridge/edit-wait').length).toBe(before)
  // mode 写错了：不发
  const n = w.calls.filter(c => c.path === '/bridge/edit').length
  expect(typeof (await $.tool.call({ tool: 'mcp__inkpad__ink_edit', path: '清单.md', mode: 'replace' })).deny).toBe('string')
  expect(typeof (await $.tool.call({ tool: 'mcp__inkpad__ink_edit' })).deny).toBe('string')
  expect(w.calls.filter(c => c.path === '/bridge/edit').length).toBe(n)

  const props = w.schemas.ink_edit.properties
  expect(Object.keys(props).sort()).toEqual(['mode', 'path'])
  expect(props.mode.enum).toEqual(['overwrite', 'saveas'])
  expect(w.schemas.ink_edit.required).toEqual(['path'])
  // 说明：ink_edit → 按返回的路径改 → ink_import → result，三个工具讲的是同一套；打字让改的也先调 ink_edit；一次一个文件；忽略了就不改
  const edit = w.descs.ink_edit ?? '', imp = w.descs.ink_import ?? '', reply = w.descs.ink_reply ?? ''
  for (const must of ['每一轮动手改之前调一次', '一次只办一个文件', '同一个文件的几处合起来只调一次', '覆盖原文件，还是另存一份', '不要替用户选', '作为一条新消息', '「忽略」',
    '在对话里问用户', '留了底', '原文件不要动', '用 ink_import 导入改好的那个文件', 'ink_reply 的 result', '用户在对话里打字让你改已导入的文档也一样先调它',
    '用户已经说了覆盖还是另存，就带上 mode']) expect(edit.includes(must)).toBe(true)
  for (const must of ['动手前先调 ink_edit', '导入改好的那个文件', '另存的导入 ink_edit 新建的那个文件', 'ink_reply 的 result', '用户在对话里打字让你改已导入的文档也一样'])
    expect(imp.includes(must)).toBe(true)
  expect(reply.includes('先调 ink_edit（在平板上问用户覆盖还是另存，并先留底），按它返回的路径改，用 ink_import 导入改好的那个文件，最后用 result 逐条回报')).toBe(true)
  expect(w.schemas.ink_reply.properties.items.items.properties.type.description.includes('在 ink_edit → 改文件 → ink_import 之后')).toBe(true)
  // 以前互相矛盾的两种说法不再出现
  for (const d of [edit, imp, reply]) {
    for (const bad of ['不覆盖原文件', '新文件放进项目', '改过后再导入']) expect(d.includes(bad)).toBe(false)
  }
  // 改文件算重活：这一轮的进展报「在改文件」
  const id = '20261114-101010-abcd'
  await $.turn.start({ text: `【草稿纸】……submission="${id}"`, turnId: 't9' })
  await $.tool.call({ tool: 'mcp__inkpad__ink_edit', path: '清单.md', mode: 'saveas' })
  expect(w.calls.some(c => c.path === '/bridge/progress' && c.body?.id === id && c.body?.stage === 'working')).toBe(true)
})

test('改文件（ink_edit）约一分半没选：停手等着；平板不在线改在对话里问；忽略了、留底没做成照服务说的', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  w.edited = Infinity
  const ran = await $.tool.call({ tool: 'mcp__inkpad__ink_edit', path: '清单.md' })
  expect(String(ran.result)).toContain('用户还没选')
  expect(String(ran.result)).toContain('不要替用户选')
  const waits = w.calls.filter(c => c.path === '/bridge/edit-wait').map(c => c.body)
  expect(waits.map(b => b?.wait)).toEqual([25, 25, 25, 15])
  expect(waits.map(b => b?.last)).toEqual([false, false, false, true])
  // 用户点了「忽略」：服务说这次不改，原样交给 Claude
  w.edited = 1
  w.editReply = { ignored: true, text: '用户忽略了，这次不要改这个文件（没有留底，也没有建新文件，原文件没动）。' }
  const ign = await $.tool.call({ tool: 'mcp__inkpad__ink_edit', path: '清单.md' })
  expect(ign.result).toBe('用户忽略了，这次不要改这个文件（没有留底，也没有建新文件，原文件没动）。')
  // 平板没开：马上告诉 Claude 改在对话里问，不等
  w.tabletUp = false
  const n = w.calls.filter(c => c.path === '/bridge/edit-wait').length
  const off = await $.tool.call({ tool: 'mcp__inkpad__ink_edit', path: '清单.md' })
  expect(String(off.result)).toContain('在对话里问用户')
  expect(w.calls.filter(c => c.path === '/bridge/edit-wait').length).toBe(n)
  // 覆盖前留底没做成：deny，Claude 不动文件
  w.editFail = '覆盖前没能把原文件留底（磁盘满了）：原文件不要动，先告诉用户。'
  const bad = await $.tool.call({ tool: 'mcp__inkpad__ink_edit', path: '清单.md', mode: 'overwrite' })
  expect(bad.deny).toBe('没办成：覆盖前没能把原文件留底（磁盘满了）：原文件不要动，先告诉用户。')
})

test('问话卡片的说明：用户可能点「忽略」，忽略了的不要再问；服务说忽略了就原样交给 Claude', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  expect((w.descs.ink_ask ?? '').includes('用户也可能点「忽略」不答：返回会告诉你，忽略了的问题不要再问')).toBe(true)
  w.asked = 1
  w.askReply = { answer: { ignored: true }, text: '用户忽略了这个问题，没有回答。不要再问同一个问题。' }
  const ran = await $.tool.call({ tool: 'mcp__inkpad__ink_ask', question: '周六去哪家超市？', options: ['东门', '西门'] })
  expect(ran.result).toBe('用户忽略了这个问题，没有回答。不要再问同一个问题。')
})

test('整本检测：参数原样交给服务，结果给 Claude；写回时带页码', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  const ran = await $.tool.call({ tool: 'mcp__inkpad__ink_scan', nb: '课题汇报', only_new: true })
  expect(ran.result).toBe('【草稿纸·整本】……')
  expect(w.calls.find(c => c.path === '/bridge/scan')?.body).toEqual({ sid: 'sess-1', nb: '课题汇报', only_new: true })
  await $.tool.call({ tool: 'mcp__inkpad__ink_reply', submission: 'scan1', page: 3, items: [{ type: 'note', anchor: 'g1', text: '好' }] })
  expect(w.calls.find(c => c.path === '/bridge/reply')?.body?.page).toBe(3)
})

test('确认字迹：等到用户在平板上回答，把读法交给 Claude', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  const ran = await $.tool.call({
    tool: 'mcp__inkpad__ink_confirm',
    submission: 's1',
    questions: [{ anchor: 'g3', guess: 'p', options: ['ρ'] }],
  })
  expect(ran.result).toBe('1. g3：这是？ → 是「ρ」。')
  const waits = w.calls.filter(c => c.path === '/bridge/confirm-wait')
  expect(waits.length).toBe(2)
  expect(waits[0]?.body).toEqual({ id: 'c1', wait: 25, last: false })
  expect(waits[1]?.body).toEqual({ id: 'c1', wait: 20, last: true })
})

test('确认字迹最多等约 45 秒：没答就先按自己的理解继续', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.answered = 99
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  const ran = await $.tool.call({ tool: 'mcp__inkpad__ink_confirm', submission: 's1', questions: [{ anchor: 'g3', guess: 'p' }] })
  expect(String(ran.result)).toContain('用户暂时没有回答')
  // 规则瘦身（2026-11-16）：等多久、等不到怎么办从固定说明挪到这句返回里，只在等不到时出现
  expect(String(ran.result).startsWith('等了约 45 秒，')).toBe(true)
  expect(String(ran.result)).toContain('先按你的理解继续，并在回复里标明哪处是推测的')
  expect(String(ran.result)).toContain('【草稿纸·确认】')
  expect(w.calls.filter(c => c.path === '/bridge/confirm-wait').map(c => c.body?.wait)).toEqual([25, 20])
  // 说明里写的是实际等多久（以前写「最多约 100 秒」，实际 25 + 20 秒）
  const confirmSay = w.descs.ink_confirm ?? ''
  expect(confirmSay.includes('最多约 45 秒')).toBe(true)
  expect(confirmSay.includes('100 秒')).toBe(false)
})

test('写回时服务查出来的话（短批注收成圈号、退回的批改符号、缺的读法）一条一行接在工具结果后面', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  w.replyNotes = ['第 1 条 cross 没写上：缺一句 text（为什么错）。', 7, '', '还缺 g2 的读法（红笔那几组和这次回应到的组都要交）：各补一条 read（anchor 填组号，text 照写的原样转写，不翻译、不解释）。']
  const ran = await $.tool.call({ tool: 'mcp__inkpad__ink_reply', submission: 's1', items: [{ type: 'cross', anchor: 'g1' }, { type: 'tick', anchor: 'g1' }] })
  expect(ran.result).toBe('已写到草稿纸：草稿本第 1 页（空白草稿纸），共 2 条\n第 1 条 cross 没写上：缺一句 text（为什么错）。\n还缺 g2 的读法（红笔那几组和这次回应到的组都要交）：各补一条 read（anchor 填组号，text 照写的原样转写，不翻译、不解释）。')
  w.replyNotes = 'not a list' // 服务给的不对：不接
  expect((await $.tool.call({ tool: 'mcp__inkpad__ink_reply', submission: 's1', items: [{ type: 'tick', anchor: 'g1' }] })).result).toBe('已写到草稿纸：草稿本第 1 页（空白草稿纸），共 1 条')
  const say = w.descs.ink_reply ?? ''
  expect(say.includes('写长了草稿纸会把它收成圈号卡片，工具结果里会说')).toBe(true)
  expect(say.includes('漏了的组，工具结果里会点名')).toBe(true)
  const type = w.schemas.ink_reply.properties.items.items.properties.type.description as string
  expect(type.includes('cross、strike、wavy 不带 text 的那一条会被退回、不画')).toBe(true)
  expect(type.includes('不带 text 的不画')).toBe(false)
  expect((w.descs.ink_edit ?? '').includes('拿回来要盖掉现在这份时，也算改文件，照样先调它')).toBe(true)
})

test('问话卡片：发问题、等到用户点的选项；说明写清什么时候用、没答就停手等着', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  const ran = await $.tool.call({ tool: 'mcp__inkpad__ink_ask', question: '覆盖原文件，还是另存一份？', options: ['覆盖', '另存'] })
  expect(ran.result).toBe('我点了「另存」。')
  expect(w.calls.find(c => c.path === '/bridge/ask')?.body).toEqual({ sid: 'sess-1', question: '覆盖原文件，还是另存一份？', options: ['覆盖', '另存'], handwrite: true })
  expect(w.calls.filter(c => c.path === '/bridge/ask-wait').map(c => c.body)).toEqual([
    { id: 'q1', wait: 25, last: false },
    { id: 'q1', wait: 25, last: false },
  ])
  const say = w.descs.ink_ask ?? ''
  for (const must of ['能写在纸上的都写在纸上', '只有两种情况才用它', '要用户回答才能继续的问题', '纸上放不下的结果', '别的对话内容不发到平板',
    '约一分半', '用 Read 看图', '不要替用户选', '作为一条新消息', '「知道了」', '改在对话里问']) expect(say.includes(must)).toBe(true)
  const props = w.schemas.ink_ask.properties
  expect(Object.keys(props).sort()).toEqual(['handwrite', 'options', 'question', 'result'])
  expect(props.options.maxItems).toBe(4)
  expect(props.handwrite.type).toBe('boolean')
  // 手写的回答：服务给的是图的路径，原样交给 Claude
  w.asked = 1
  w.askReply = { answer: { image: 'E:\\ink\\data\\submissions\\x\\answer.png' }, text: '我在卡片上用笔手写了回答，图在 E:\\ink\\data\\submissions\\x\\answer.png：用 Read 看这张图，读出我写的。' }
  const hand = await $.tool.call({ tool: 'mcp__inkpad__ink_ask', question: '第二步写一下', handwrite: true })
  expect(String(hand.result)).toContain('answer.png：用 Read 看这张图')
  expect(w.calls.filter(c => c.path === '/bridge/ask').at(-1)?.body).toEqual({ sid: 'sess-1', question: '第二步写一下', options: [], handwrite: true })
})

test('问话卡片约一分半没答：停手等着、不替用户选；最后一次告诉服务不等了', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.asked = Infinity
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  const ran = await $.tool.call({ tool: 'mcp__inkpad__ink_ask', question: '选哪个？', options: ['甲', '乙'], handwrite: false })
  expect(String(ran.result)).toContain('用户还没答（卡片留在平板上）')
  expect(String(ran.result)).toContain('不要替用户选')
  expect(String(ran.result)).toContain('作为一条新消息')
  const waits = w.calls.filter(c => c.path === '/bridge/ask-wait').map(c => c.body)
  expect(waits.map(b => b?.wait)).toEqual([25, 25, 25, 15]) // 共 90 秒
  expect(waits.map(b => b?.last)).toEqual([false, false, false, true])
  expect(w.calls.find(c => c.path === '/bridge/ask')?.body?.handwrite).toBe(false)
})

test('问话卡片：结果卡片不等；平板不在线马上改在对话里；参数不对不发', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  const res = await $.tool.call({ tool: 'mcp__inkpad__ink_ask', result: '第一段\n第二段' })
  expect(String(res.result)).toContain('不用等')
  expect(w.calls.find(c => c.path === '/bridge/ask')?.body).toEqual({ sid: 'sess-1', result: '第一段\n第二段' })
  expect(w.calls.some(c => c.path === '/bridge/ask-wait')).toBe(false)
  w.tabletUp = false
  const off = await $.tool.call({ tool: 'mcp__inkpad__ink_ask', question: '选哪个？', options: ['甲', '乙'] })
  expect(off.result).toBe('平板现在没打开草稿纸，卡片没发出去：改在对话里问用户。')
  const offRes = await $.tool.call({ tool: 'mcp__inkpad__ink_ask', result: '结果' })
  expect(offRes.result).toBe('平板现在没打开草稿纸，卡片没发出去：把结果直接写在对话里。')
  expect(w.calls.some(c => c.path === '/bridge/ask-wait')).toBe(false)
  const before = w.calls.filter(c => c.path === '/bridge/ask').length
  for (const bad of [{}, { question: '问？', result: '结果' }, { question: '选？', options: ['1', '2', '3', '4', '5'] }]) {
    const r = await $.tool.call({ tool: 'mcp__inkpad__ink_ask', ...bad })
    expect(typeof r.deny).toBe('string')
  }
  expect(w.calls.filter(c => c.path === '/bridge/ask').length).toBe(before)
})

test('这一轮的进展报给服务：排队、在看、改文件、结束；不再报上下文大小', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 260000, window: 1000000, percent: 26 }, rateLimits: [] } }))
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: null, isInteractive: false })
  await clock.settle()
  await $.turn.start({ text: '我在打字', turnId: 't0' }) // 对话正忙
  const id = '20261102-010101-abcd'
  w.queue.push({ id, text: `【草稿纸】我在平板上写了一些东西发给你。\n\n写回用 mcp__inkpad__ink_reply（submission="${id}"）。` })
  await clock.advance(1600)
  await $.turn.complete({ answer: '好', durationMs: 1, isAborted: false, turnId: 't0', reason: 'answer' })
  await $.turn.start({ text: w.prompts[0] ?? '', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: `E:\\ink\\data\\submissions\\${id}\\crop.jpg` }).catch(() => undefined)
  await $.tool.call({ tool: 'Read', file_path: `E:\\ink\\data\\submissions\\${id}\\overview.jpg` }).catch(() => undefined)
  await $.tool.call({ tool: 'Edit', file_path: 'E:\\proj\\idea\\a.md', old_string: 'a', new_string: 'b' }).catch(() => undefined)
  await $.turn.complete({ answer: '写好了', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const stages = w.calls.filter(c => c.path === '/bridge/progress' && c.body?.stage).map(c => [c.body?.id, c.body?.stage])
  expect(stages).toEqual([[id, 'queued'], [id, 'reading'], [id, 'working'], [id, 'done']])
  expect(w.calls.some(c => c.path === '/bridge/answer')).toBe(false) // 每轮的最终回复不再转给平板
  await clock.advance(1600 * 8) // 每 4 次轮询刷新一次状态：以前顺便报上下文大小（2026-11-14 删了）
  expect(w.calls.some(c => c.path === '/bridge/status')).toBe(true)
  expect(w.calls.some(c => c.body !== undefined && 'ctx' in c.body)).toBe(false)
  expect(w.calls.filter(c => c.path === '/bridge/progress').every(c => typeof c.body?.stage === 'string')).toBe(true)
  expect(w.calls.find(c => c.path === '/bridge/hello')?.body?.started).toBeUndefined() // startedAt 是 0：当作拿不到，不报
})

test('登记时报对话什么时候开的、对话记录里最后一句打的话；执行过 /ink 的报出来', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  on('session.usage', () => ({ value: { startedAt: 1794700000000, context: { tokens: 1000, window: 1000000, percent: 0 }, rateLimits: [] } }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '先看看周末的第二条路线\n第二行不要', toolUses: [] },
      { role: 'assistant', text: '好', toolUses: [] },
      { role: 'user', text: '<ide_selection>选中的几行</ide_selection>\n把这一段改短一点', toolUses: [] },
      { role: 'assistant', text: '改好了', toolUses: [] },
      { role: 'user', text: '', toolUses: [], toolResults: [] },
      { role: 'user', text: '【草稿纸】我在平板上写了一些东西发给你。', toolUses: [] },
      { role: 'user', text: '<command-name>/ink</command-name>', toolUses: [] },
      { role: 'user', text: '/ink here', toolUses: [] },
    ],
  }))
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  const first = w.calls.find(c => c.path === '/bridge/hello')?.body
  expect(first).toEqual({ sid: 'sess-1', label: 'idea', cwd: 'E:\\proj\\idea', started: 1794700000000, hint: '把这一段改短一点' })
  await $.command.run({ command: 'ink', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const after = w.calls.filter(c => c.path === '/bridge/hello').at(-1)?.body
  expect(after?.ink).toBe(true)
  expect(after?.hint).toBe('把这一段改短一点')
})

test('这一轮新生成的图片和文档报给平板；之前就有的、草稿纸自己的数据不报', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.files = {
    'E:\\proj\\idea': [
      { name: 'old.png', kind: 'file', mtimeMs: 1 },
      { name: 'notes.md', kind: 'file', mtimeMs: 1 },
      { name: 'figs', kind: 'dir', mtimeMs: 0 },
      { name: 'node_modules', kind: 'dir', mtimeMs: 0 },
      { name: 'inkthink', kind: 'dir', mtimeMs: 0 },
    ],
    'E:\\proj\\idea\\figs': [],
    'E:\\proj\\idea\\inkthink': [{ name: 'data', kind: 'dir', mtimeMs: 0 }],
    'E:\\proj\\idea\\inkthink\\data': [],
  }
  on('tool.call', { tool: 'Write' }, () => ({ result: '已写入' }))
  await $.session.start({ cwd: 'E:\\proj\\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  // 这一轮：figs 里画了新图，old.png 重新生成，notes.md 改了（Markdown 改动不报），草稿纸数据里多了截图（不报）
  w.files['E:\\proj\\idea\\figs'] = [{ name: 'chart.png', kind: 'file', mtimeMs: 5 }, { name: 'run.py', kind: 'file', mtimeMs: 5 }]
  w.files['E:\\proj\\idea']![0] = { name: 'old.png', kind: 'file', mtimeMs: 6 }
  w.files['E:\\proj\\idea']![1] = { name: 'notes.md', kind: 'file', mtimeMs: 6 }
  w.files['E:\\proj\\idea\\inkthink\\data'] = [{ name: 'crop.png', kind: 'file', mtimeMs: 6 }]
  w.files['E:\\proj\\idea\\node_modules'] = [{ name: 'logo.png', kind: 'file', mtimeMs: 6 }]
  await $.tool.call({ tool: 'Write', file_path: 'C:\\tmp\\plan.md', content: '# 计划' })
  await $.turn.complete({ answer: '画好了', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  const offer = w.calls.find(c => c.path === '/bridge/offer')
  const paths = ((offer?.body?.files as { path: string }[]) ?? []).map(f => f.path).sort()
  expect(paths).toEqual(['C:\\tmp\\plan.md', 'E:\\proj\\idea\\figs\\chart.png', 'E:\\proj\\idea\\old.png'])

  // 下一轮生成了 PPT 和几张图：图多半是 PPT 的素材，只报 PPT
  w.calls = []
  w.files['E:\\proj\\idea\\figs'] = [
    { name: 'chart.png', kind: 'file', mtimeMs: 5 },
    { name: 'photo.png', kind: 'file', mtimeMs: 9 },
    { name: '汇报_v48.pptx', kind: 'file', mtimeMs: 9 },
    { name: '~$汇报_v48.pptx', kind: 'file', mtimeMs: 9 }, // PowerPoint 开着它时的锁文件
  ]
  await $.turn.complete({ answer: '做好了', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()
  const second = w.calls.find(c => c.path === '/bridge/offer')
  expect(((second?.body?.files as { path: string }[]) ?? []).map(f => f.path)).toEqual(['E:\\proj\\idea\\figs\\汇报_v48.pptx'])
})

test('/ink 启动过的服务意外停了：插件在半分钟内把它重新拉起；没执行过 /ink 的对话不去拉', { options: { server_command: 'E:\\proj\\idea\\inkthink\\.venv\\Scripts\\python.exe E:\\proj\\idea\\inkthink\\launch.py' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: 'E:\proj\idea', surface: 'vscode', isInteractive: false })
  await clock.settle()
  await $.command.run({ command: 'ink', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(w.runs.length).toBe(0) // 服务本来就在
  w.up = false // 服务停了
  await clock.advance(1500 * 21)
  expect(w.runs.length).toBe(1)
  expect(w.calls.filter(c => c.path === '/bridge/hello').length).toBeGreaterThan(1)
})

/**
 * inkpad：把平板上的「草稿纸」接进 Claude Code 对话。
 *
 * 平板浏览器里写写画画、点「AI」→ 本机的 InkThink 中转服务收下 → 本插件每 1.5 秒
 * 去取，取到就作为一条消息送进这个对话（$.prompt.submit）。Claude 用这里注册的工具
 * 把批注写回草稿纸、往平板推页面、整本检测、确认拿不准的字迹、在平板顶上发问话卡片、
 * 改已导入的文档之前问覆盖还是另存并先留底（ink_edit）；
 * 这一轮里新生成的图片/文档报给服务，由用户在平板上决定要不要加进草稿纸。
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { InkpadStatus } from '../types'

const PANE = 'inkpad'
const status = atom({ plugin: 'inkpad', key: 'status' } as const, { online: false } as InkpadStatus)

const TOOL_REPLY = 'mcp__inkpad__ink_reply'
const TOOL_SHOW = 'mcp__inkpad__ink_show'
const TOOL_SNAPSHOT = 'mcp__inkpad__ink_snapshot'
const TOOL_IMPORT = 'mcp__inkpad__ink_import'
const TOOL_SCAN = 'mcp__inkpad__ink_scan'
const TOOL_CONFIRM = 'mcp__inkpad__ink_confirm'
const TOOL_ASK = 'mcp__inkpad__ink_ask'
const TOOL_EDIT = 'mcp__inkpad__ink_edit'

// 报给平板的新文件：图片、PDF、Office 文档（改过也报），Markdown（只报新建的）
const OFFER_EXT = /\.(png|jpe?g|svg|gif|webp|bmp|tiff?|pdf|pptx?|docx?|odp|odt|rtf|epub|md)$/i
const PAGE_EXT = /\.(png|jpe?g|svg|gif|webp|bmp|tiff?|pdf|pptx?|docx?|odp|odt|rtf|epub)$/i
const DOC_EXT = /\.(pdf|pptx?|docx?|odp|odt|rtf|epub)$/i
// Office 打开文档时的锁文件（~$开头）和临时文件
const TEMP_NAME = /^(~\$|\.~|~WRL)|\.(tmp|crdownload|part)$/i
const IMAGE_EXT = /\.(png|jpe?g|svg|gif|webp|bmp|tiff?)$/i
const SKIP_DIR = /^(\..*|node_modules|__pycache__|venv|env|site-packages|\$RECYCLE\.BIN|System Volume Information)$/i
const SCAN_DEPTH = 4
const SCAN_MAX_DIRS = 400

type Engine = EngineInterface
type Reply = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }

// 本会话的连接状态（模块重载时清空，session.start 会重新填）
const ctx = {
  base: 'http://127.0.0.1:8765',
  serverCommand: '',
  // 草稿纸的固定说明：服务给的（InkThink 的 prompt.py 里的 protocol()，hello 和状态里带着），放进系统提示，
  // 每个对话一次；投递里只放这一页的内容
  protocol: '',
  sid: '',
  label: '',
  cwd: '',
  submissionsDir: '',
  busy: false,
  busySince: 0,
  ticks: 0,
  failures: 0,
  spawning: false,
  started: false,
  serverWanted: false, // 这个对话里执行过 /ink：服务意外停了就自动重新拉起
  offerFiles: true,
  skipDirs: [] as string[],
  known: null as Map<string, number> | null, // 项目里图片/文档的修改时间，用来找出这一轮新生成的
  scanning: false,
  written: new Set<string>(), // 这一轮 Write 写过的文件（可能在项目文件夹之外）
  delivered: new Set<string>(), // 已经交进对话（或正在交）的投递编号：服务没收到确认、再给一次时不重复交
  turnActive: false, // 主对话这一轮还没结束（投递要排队）
  current: '', // 这一轮是在回哪次投递（turn.start 的文字里带着 submission 编号）
  reported: new Set<string>(), // 这一轮已经报过的进展
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function splitArgv(cmd: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? '')
  return out
}

function isUnder(path: string, dir: string): boolean {
  const norm = (s: string) => s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const p = norm(path)
  const d = norm(dir)
  return p === d || p.startsWith(d + '\\')
}

async function call($: Engine, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> {
  try {
    const r = await $.http.fetch(ctx.base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let data: Record<string, unknown> = {}
    try {
      data = r.text ? (JSON.parse(r.text) as Record<string, unknown>) : {}
    } catch {
      data = {}
    }
    if (r.ok) return { ok: true, data }
    return { ok: false, error: String(data.error ?? `HTTP ${r.status}`) }
  } catch (err) {
    return { ok: false, error: `连不上草稿纸服务（${ctx.base}）：${String(err)}` }
  }
}

async function setStatus($: Engine, patch: Partial<InkpadStatus>) {
  const now = await read($, status)
  const next = { ...now, ...patch }
  const changed = (Object.keys(patch) as (keyof InkpadStatus)[]).some(k => now[k] !== next[k])
  if (changed) await update($, status, () => next)
}

async function applyStatus($: Engine, d: Record<string, unknown>) {
  if (typeof d.submissionsDir === 'string') ctx.submissionsDir = d.submissionsDir
  if (typeof d.protocol === 'string') ctx.protocol = d.protocol
  if (Array.isArray(d.skipDirs)) ctx.skipDirs = d.skipDirs.filter((x): x is string => typeof x === 'string')
  await setStatus($, {
    online: true,
    url: typeof d.url === 'string' ? d.url : undefined,
    qr: typeof d.qr === 'string' ? d.qr : undefined,
    tabletOnline: Boolean(d.tabletOnline),
    isTarget: Boolean(d.isTarget),
    targetLabel: typeof d.targetLabel === 'string' ? d.targetLabel : '',
    targetNb: typeof d.targetNb === 'string' ? d.targetNb : '',
    stableUrl: typeof d.stableUrl === 'string' ? d.stableUrl : undefined,
    sessions: typeof d.sessions === 'number' ? d.sessions : 0,
  })
}

async function ping($: Engine): Promise<boolean> {
  const r = await call($, 'GET', '/bridge/ping')
  return r.ok && r.data.app === 'inkthink'
}

// 服务没在运行就用 server_command 在后台启动它（launch.py 让它脱离本会话、一直运行到关机）。
// 只在用户执行 /ink 时调用：开新对话不会自动把服务开到局域网上。
// auto：服务意外停了、插件自动重启时为 true，带上 --auto：用户自己停的（/ink stop 或二维码页上的「停止服务」）就不重启
async function ensureServer($: Engine, auto = false): Promise<boolean> {
  if (await ping($)) return true
  if (!ctx.serverCommand || ctx.spawning) return false
  ctx.spawning = true
  try {
    const run = await $.process.run(splitArgv(ctx.serverCommand).concat(auto ? ['--auto'] : []), { timeoutMs: 20000 })
    if (run.exitCode !== 0) $.ui.log(`inkpad：启动草稿纸服务失败：${run.stderr.trim()}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`inkpad：启动草稿纸服务失败：${String(err)}`, { to: 'debug' })
  } finally {
    ctx.spawning = false
  }
  return ping($)
}

// 登记（或重新登记）这个对话。顺带报平板「这本发往」的列表上认对话用的几样（拿不到的不报，服务也不另编）：
// 对话什么时候开的（$.session.usage() 的 startedAt）、对话记录里最后一句用户打的话、这个对话里执行过 /ink 没有
async function hello($: Engine) {
  const r = await call($, 'POST', '/bridge/hello', { sid: ctx.sid, label: ctx.label, cwd: ctx.cwd, ...(await sessionFacts($)) })
  if (r.ok) await applyStatus($, r.data)
}

async function sessionFacts($: Engine): Promise<{ started?: number; hint?: string; ink?: true }> {
  const out: { started?: number; hint?: string; ink?: true } = {}
  const u = await $.session.usage().catch(() => null)
  if (u && typeof u.startedAt === 'number' && u.startedAt > 0) out.started = Math.round(u.startedAt)
  const msgs = await $.session.messages().catch(() => null)
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      const h = m && m.role === 'user' ? hintOf(m.text ?? '') : undefined
      if (h) {
        out.hint = h
        break
      }
    }
  }
  if (ctx.serverWanted) out.ink = true
  return out
}

// 一句用户打的话的开头（第一行，最多 40 个字）：引擎附在消息里的标签块（<…>…</…>）先去掉；
// 斜杠命令、草稿纸的投递（【草稿纸…】开头）不算
function hintOf(text: string): string | undefined {
  const plain = text.replace(/<([A-Za-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/g, '').trim()
  const line = (plain.split('\n')[0] ?? '').trim()
  if (!line || line.startsWith('/') || line.startsWith('<') || line.startsWith('【草稿纸')) return undefined
  return line.slice(0, 40)
}

async function refresh($: Engine) {
  const r = await call($, 'GET', `/bridge/status?sid=${encodeURIComponent(ctx.sid)}`)
  if (r.ok) await applyStatus($, r.data)
}

// 这一轮到哪一步了（排队、Claude 在看、在改文件、结束）：服务转给平板显示，并记下时刻
async function progress($: Engine, id: string, stage: string) {
  if (!id || ctx.reported.has(`${id}:${stage}`)) return
  ctx.reported.add(`${id}:${stage}`)
  await call($, 'POST', '/bridge/progress', { sid: ctx.sid, id, stage })
}

const SUB_IN_TEXT = /submission="(\d{8}-\d{6}-[0-9a-f]{4})"/
// 改文件、跑命令的工具：这一轮在做重活
const WORK_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', TOOL_IMPORT, TOOL_EDIT])

// 开新对话时：服务在运行就登记上，不在就安静地等（轮询会每半分钟再试一次）
async function connect($: Engine) {
  if (await ping($)) await hello($)
  else await setStatus($, { online: false })
}

async function claim($: Engine) {
  await call($, 'POST', '/bridge/claim', { sid: ctx.sid })
  await refresh($)
}

async function tick($: Engine) {
  // 一次轮询超过 15 秒还没回来（服务在请求中途被重启时，请求可能一直挂着）：当作卡住，放行下一次
  if (ctx.busy && Date.now() - ctx.busySince < 15000) return
  if (!ctx.sid) return
  ctx.busy = true
  ctx.busySince = Date.now()
  try {
    const r = await call($, 'GET', `/bridge/poll?sid=${encodeURIComponent(ctx.sid)}&ack=1`)
    if (!r.ok) {
      ctx.failures++
      if (ctx.failures === 1) await setStatus($, { online: false, tabletOnline: false })
      if (ctx.failures % 20 === 0) {
        // 每 30 秒试一次：服务还在就重新登记；不在了、而这个对话执行过 /ink，就把它重新拉起来
        if (await ping($)) await hello($)
        else if (ctx.serverWanted && (await ensureServer($, true))) await hello($)
      }
      return
    }
    ctx.failures = 0
    if (r.data.unknown) {
      await hello($) // 服务重启过，重新登记
      return
    }
    const sub = r.data.submission as { id: string; text: string } | undefined
    if (sub && !ctx.delivered.has(sub.id)) {
      ctx.delivered.add(sub.id)
      await setStatus($, { lastSubmission: Date.now() })
      $.ui.toast('收到草稿纸上的输入')
      // 不等它：对话正忙时要排到这一轮结束，期间轮询照常进行
      void deliver($, sub)
    }
    ctx.ticks++
    if (ctx.ticks % 4 === 0) await refresh($)
  } finally {
    ctx.busy = false
  }
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') || /^[a-zA-Z]:/.test(dir) ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name
}

function absPath(p: string): string {
  return /^([a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(p) ? p : joinPath(ctx.cwd, p)
}

// 列出项目文件夹里的图片和文档（深度和目录数有上限，跳过隐藏目录、依赖目录和草稿纸自己的数据）
async function listOfferable($: Engine, dir: string, depth: number, out: Map<string, number>, budget: { dirs: number }) {
  if (budget.dirs <= 0 || ctx.skipDirs.some(d => isUnder(dir, d))) return
  budget.dirs--
  const entries = await $.fs.list(dir).catch(() => [])
  for (const e of entries) {
    const full = joinPath(dir, e.name)
    if (e.kind === 'file' && OFFER_EXT.test(e.name) && !TEMP_NAME.test(e.name)) out.set(full, e.mtimeMs)
    else if (e.kind === 'dir' && depth < SCAN_DEPTH && !SKIP_DIR.test(e.name)) await listOfferable($, full, depth + 1, out, budget)
  }
}

async function snapshotFiles($: Engine): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (ctx.cwd) await listOfferable($, ctx.cwd, 0, out, { dirs: SCAN_MAX_DIRS })
  return out
}

// 一轮结束：和上一轮末的清单比，新出现的（图片/文档改过的也算）报给服务，平板上弹出「加到草稿纸 / 忽略」
async function offerNewFiles($: Engine) {
  if (!ctx.offerFiles || ctx.scanning || !ctx.cwd) return
  ctx.scanning = true
  try {
    const now = await snapshotFiles($)
    const before = ctx.known
    ctx.known = now
    const files: { path: string; mtimeMs: number }[] = []
    if (before) {
      for (const [path, mtime] of now) {
        const old = before.get(path)
        if (old === undefined || (old !== mtime && PAGE_EXT.test(path))) files.push({ path, mtimeMs: mtime })
      }
    }
    for (const path of ctx.written) {
      if (!now.has(path)) files.push({ path, mtimeMs: 0 })
    }
    ctx.written.clear()
    let fresh = files.filter(f => !(ctx.submissionsDir && isUnder(f.path, ctx.submissionsDir)) && !ctx.skipDirs.some(d => isUnder(f.path, d)))
    // 这一轮生成了 PPT/Word/PDF 时，同一轮的图片多半是文档里用的素材：只报文档
    if (fresh.some(f => DOC_EXT.test(f.path))) fresh = fresh.filter(f => !IMAGE_EXT.test(f.path))
    if (fresh.length) await call($, 'POST', '/bridge/offer', { sid: ctx.sid, files: fresh.slice(0, 20) })
  } finally {
    ctx.scanning = false
  }
}

// 连上服务时先记下现有文件（只做一次），之前就有的不会被当成新的
async function baselineFiles($: Engine) {
  if (!ctx.offerFiles || ctx.known || ctx.scanning) return
  ctx.scanning = true
  try {
    ctx.known = await snapshotFiles($)
  } finally {
    ctx.scanning = false
  }
}

// 一条投递交进对话。交进去后告诉服务收到了，服务才删；交不进去就放掉这个编号，服务过一会儿再给
async function deliver($: Engine, sub: { id: string; text: string }) {
  if (ctx.turnActive) void progress($, sub.id, 'queued') // 对话正忙：排到这一轮结束
  await $.prompt
    .submit({ text: sub.text, asUser: true })
    .then(() => call($, 'POST', '/bridge/ack', { sid: ctx.sid, id: sub.id }))
    .catch(() => ctx.delivered.delete(sub.id))
}

async function waitConfirm($: Engine, id: string): Promise<string> {
  // 共等约 45 秒（25 + 20）：这一轮不久卡着；最后一次还没答，之后的回答作为新消息送进对话
  for (let k = 0; k < 2; k++) {
    const r = await call($, 'POST', '/bridge/confirm-wait', { id, wait: k ? 20 : 25, last: k === 1 })
    if (!r.ok) return `没等到回答：${r.error}。先按你的理解继续，并在回复里标明哪处是推测的。`
    if (typeof r.data.text === 'string') return r.data.text
  }
  return '用户暂时没有回答（确认卡片还留在平板上，回答后会作为新消息发来）。先按你的理解继续，并在回复里标明哪处是推测的。'
}

// 问话卡片（ink_ask）：一次最多挂 25 秒，连着等几次，共约一分半；最后一次还没答，之后的回答作为新消息送进对话
const ASK_WAITS = [25, 25, 25, 15]
const ASK_PENDING =
  '用户还没答（卡片留在平板上）。这一轮就停在这里等着：不要替用户选，也不要按哪个选项先做下去；用户答了，答案会作为一条新消息（【草稿纸·回答】）送来。'

async function waitAsk($: Engine, id: string): Promise<string> {
  for (let k = 0; k < ASK_WAITS.length; k++) {
    const last = k === ASK_WAITS.length - 1
    const r = await call($, 'POST', '/bridge/ask-wait', { id, wait: ASK_WAITS[k], last })
    if (!r.ok) {
      // 中途出错：记一下「不等了」，用户之后的回答照样作为新消息送来（服务也连不上时，卡片记在服务的文件里，重启后同样送来）
      const again = last ? null : await call($, 'POST', '/bridge/ask-wait', { id, wait: 0, last: true })
      if (again?.ok && typeof again.data.text === 'string') return again.data.text
      return `没等到回答（${r.error}）。${ASK_PENDING}`
    }
    if (typeof r.data.text === 'string') return r.data.text
  }
  return ASK_PENDING
}

// 改文件前问「覆盖还是另存」（ink_edit 没带 mode）：和问话卡片一样连着等约一分半；用户选了，服务当场留底或另存，返回该改哪个文件。
// 最后一次还没选：服务记下「不等了」，之后的选择作为一条新消息送来（让 Claude 带上 mode 再调一次）
const EDIT_PENDING =
  '用户还没选（卡片留在平板顶上）。这一轮就停在这里等着：不要替用户选，也不要先动这个文件；用户选了，会作为一条新消息（【草稿纸·回答】）送来，到时按消息里说的带上 mode 再调一次 ink_edit。'

async function waitEdit($: Engine, id: string): Promise<string> {
  let pending = ''
  for (let k = 0; k < ASK_WAITS.length; k++) {
    const last = k === ASK_WAITS.length - 1
    const r = await call($, 'POST', '/bridge/edit-wait', { id, wait: ASK_WAITS[k], last })
    if (!r.ok) {
      const again = last ? null : await call($, 'POST', '/bridge/edit-wait', { id, wait: 0, last: true })
      if (again?.ok && typeof again.data.text === 'string') return again.data.text
      return `没等到用户选（${r.error}）。${EDIT_PENDING}`
    }
    if (typeof r.data.text !== 'string') continue
    if (!r.data.pending) return r.data.text // 选了（已留底或另存好）、忽略了、或卡片撤下了
    pending = r.data.text
  }
  return pending || EDIT_PENDING
}

async function registerTools($: Engine) {
  await $.tool.register({
    name: 'ink_reply',
    isDeferred: false,
    description:
      '把回答写回用户平板上的草稿纸，以蓝色手写体出现。write：长的回答（可多段，用 \\n 换行），用来代替在对话里回答：anchor 填所答的那条红笔（或它讲的那处笔迹），q 填问题原文；平板在那里标一个圈号，用户点圈号才看到全文，不占纸面；note/question：页边的短批注（每条不超过 40 字）；underline/circle/arrow：画在笔迹上的标记；read：对手写内容的转写。anchor/from/to 用消息图片里的笔迹编号（g1、g2……）；指向印刷文字或无编号处时用 box（消息里那一页的图里的像素坐标 [x0,y0,x1,y1]；不给 submission 时为页面坐标）。不给 submission 就写到平板当前打开的那一页。回答红笔问题：短的（约 40 字以内）用 note，anchor 填那个红笔问题的编号；长的用 write，anchor 也填那个红笔问题的编号。不要自己用 number 标圈号去配页末的 write，write 的 anchor 也不要写 end（number 仍可用来给步骤排顺序）。用户用红笔要你改写某条回答时，回一条新的 write（anchor 填那条红笔），旧的那条用户自己擦。用户在长回答的卡片上用红笔写了批注（消息里附那张卡片的图，写着「圈号 n 的卡片」）：回应用 write，card 填 n，q 填你读到的那句红字，这段接在那张卡片最下面，不出新的圈号；要改写整段，也把改好的写在下面。用户采纳了文档上的修改建议（消息里「修改建议的决定」）：先调 ink_edit（在平板上问用户覆盖还是另存，并先留底），按它返回的路径改，用 ink_import 导入改好的那个文件，最后用 result 逐条回报改成了没有。',
    inputSchema: {
      type: 'object',
      properties: {
        submission: { type: 'string', description: '【草稿纸】消息里给的 submission 编号；省略则写到这个对话最近一次投递的那一页' },
        page: { type: 'number', description: '【草稿纸·整本】消息里的页码（第几页，从 1 起）；单页投递不用填' },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['write', 'note', 'question', 'underline', 'circle', 'arrow', 'read', 'suggest', 'tick', 'cross', 'strike', 'insert', 'wavy', 'highlight', 'brace', 'number', 'label', 'node', 'link', 'group', 'sketch', 'figure', 'formula', 'result'],
                description: 'write 长的回答（平板在 anchor 那处标一个圈号，用户点开看全文）；note 页边批注；question 以问题写的批注；underline 下划线；circle 圈出；arrow 箭头；read 对手写内容的转写（显示在顶部）；suggest 要用户同意才动的一处修改（框住 anchor/box 那块，text 写改成什么，用户点 ✓/×）。批改符号（都画在 anchor/box 那块上）：tick 对 ✓；cross 错 ✗（text 写一句为什么）；strike 删除线（text 可写改成什么）；insert 插入符 ^（text 写补的字）；wavy 波浪线表示存疑（text 可写一句疑问）；highlight 荧光笔；brace 大括号把那块括起来（text 写一句）；number 圈着的编号（text 写 1、2、3）。概念图上：label 给用户画的箭头补关系词（anchor 填那条箭头，text 两三个字）；以下三种是建议，画成虚线，用户点 ✓/×，同意的变实线：node 建议加一个概念（text 是概念，anchor 填放在哪个旁边，links 列出要连的组），link 建议加一条线（from、to 填组号，text 是关系词），group 建议把几个归成一类（anchors 列出那几组，text 是类名）。sketch 一张手绘风格的示意图或方框图：只给结构（nodes 节点、edges 连线、groups 分组），不写坐标，草稿纸排版；text 可写一句图注；放在 anchor/box 那块下面，anchor 写 end 或不写就接在页面最后。figure 一张你在电脑上生成的图（数据图、函数曲线，matplotlib 等画成 PNG 或 SVG）：path 填文件路径，text 写一句图注，放法和 sketch 一样。formula 一个排版好的公式（tex 写 LaTeX，不带 $），放法和 sketch 一样。result 回报一条采纳的修改改完了没有（在 ink_edit → 改文件 → ink_import 之后）：anchor 填 s 编号，ok 填 true / false，没改成时 text 写一句原因',
              },
              text: { type: 'string', description: 'write/note/question/read 的文字；suggest 写改成什么（如「改为：……」「删去这句」，最多 120 字）；批改符号旁边的一句话（不超过 40 字），insert 是补的字、number 是编号；arrow 可带不超过 8 字的标签' },
              q: { type: 'string', description: 'write 回答红笔问题时：那个问题的原文（照用户写的转写），显示在点开的卡片顶上，用户擦掉红字后也看得到；带 card 时填你读到的卡片上的那句红字，显示在接上的那一段前面' },
              card: { type: 'number', description: 'write 回应用户在长回答卡片上写的红字时：那张卡片的圈号 n（消息里写着「圈号 n 的卡片」）。带了它，这段 text 接在那张卡片最下面，不出新的圈号' },
              anchor: { type: 'string', description: '笔迹编号如 g3；一组分了几行（消息里写着「分 N 行」）时 g3:1 指它的第 1 行。write 填所答的那条红笔（或它讲的那处笔迹）：圈号标在它右边，不要写 end；sketch、figure、formula 可写 end 表示接在页面所有内容之后' },
              from: { type: 'string', description: 'arrow/link 的起点编号' },
              to: { type: 'string', description: 'arrow/link 的终点编号' },
              anchors: { type: 'array', items: { type: 'string' }, description: 'group：归成一类的那几组的编号' },
              links: { type: 'array', items: { type: 'string' }, description: 'node：新概念要连过去的组的编号' },
              ok: { type: 'boolean', description: 'result：改成了 true，没改成 false' },
              tex: { type: 'string', description: 'formula 的 LaTeX（不带 $），如 \\frac{a+b}{2}' },
              nodes: {
                type: 'array',
                description: 'sketch 的节点：每个是一个字符串（就是节点的字），或 {id, text, shape}；字要短（不超过 12 个字），shape 填 round 画成椭圆，默认方框。最多 24 个',
                items: {
                  anyOf: [
                    { type: 'string' },
                    { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, shape: { type: 'string', enum: ['box', 'round'] } }, required: ['text'] },
                  ],
                },
              },
              edges: {
                type: 'array',
                description: 'sketch 的连线（带箭头）：from、to 填节点的 id 或字，text 写两三个字的关系词，dash 为 true 画虚线。最多 40 条',
                items: {
                  type: 'object',
                  properties: { from: { type: 'string' }, to: { type: 'string' }, text: { type: 'string' }, dash: { type: 'boolean' } },
                  required: ['from', 'to'],
                },
              },
              groups: {
                type: 'array',
                description: 'sketch 的分组：nodes 列出组里的节点，text 是组名，画成虚线框',
                items: {
                  type: 'object',
                  properties: { nodes: { type: 'array', items: { type: 'string' } }, text: { type: 'string' } },
                  required: ['nodes'],
                },
              },
              dir: { type: 'string', enum: ['LR', 'TB'], description: 'sketch：从左往右（LR）还是从上往下（TB）排；不写时四层以内从左往右' },
              path: { type: 'string', description: 'figure：图的文件路径（PNG、JPG、SVG；相对路径按当前项目目录）' },
              w: { type: 'number', description: 'sketch 旧写法：坐标范围的宽，默认 600' },
              h: { type: 'number', description: 'sketch 旧写法：坐标范围的高，默认 300' },
              shapes: {
                type: 'array',
                description: 'sketch 旧写法（尽量用 nodes/edges/groups）：形状，坐标都在 w × h 里：line（pts 折线，arrow 画箭头，dash 虚线，text 写在中段旁）、curve（pts，过这些点的平滑曲线）、rect（x、y、w、h，text 写在框中间）、ellipse（cx、cy、rx、ry，text）、text（x、y 是这行字的左端、竖直居中，size 字号默认 20）、axes（x、y、w、h 坐标轴，左下角为原点，xlabel、ylabel）',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['line', 'curve', 'rect', 'ellipse', 'text', 'axes'] },
                    pts: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
                    x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
                    cx: { type: 'number' }, cy: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' },
                    text: { type: 'string' }, size: { type: 'number' }, xlabel: { type: 'string' }, ylabel: { type: 'string' },
                    arrow: { type: 'string', enum: ['end', 'start', 'both'] },
                    dash: { type: 'boolean' },
                  },
                  required: ['type'],
                },
              },
              box: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '消息里那一页的图里的像素框 [x0,y0,x1,y1]' },
            },
            required: ['type'],
          },
        },
      },
      required: ['items'],
    },
  })
  await $.tool.register({
    name: 'ink_show',
    isDeferred: false,
    description:
      '把一个文件推到用户平板的草稿纸上，成为「Claude 推送」本子里新的一页，让用户在上面手写、圈画后发回来。支持图片（png/jpg）、PDF（用 page 选页）、SVG，以及文本/代码文件（排成一页，page 表示第几个 70 行）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对路径按当前项目目录解析）' },
        page: { type: 'number', description: 'PDF 的页码（从 1 起），或文本文件的第几段 70 行' },
        title: { type: 'string', description: '在平板上显示的标题' },
      },
      required: ['path'],
    },
  })
  await $.tool.register({
    name: 'ink_snapshot',
    isDeferred: false,
    description:
      '取用户平板草稿纸当前这一页的快照（这一页的图、字帖、书写过程），用于用户在对话里提到「看我草稿纸上写的」之类的时候。返回图片路径，之后用 Read 查看。需要平板上开着草稿纸页面。',
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'ink_import',
    isDeferred: false,
    description:
      '把一整份文档导入用户平板的草稿纸，成为一个可以翻页、手写的本子：PDF、PPT/PPTX、Word（DOC/DOCX，用本机 Office 转换）、EPUB、图片、Markdown。同一个文件再导入，会原地更新原来那本：页按内容对齐，用户的手写跟着对应的页走，平板上能对比新旧版、看到改动处。' +
      '改已导入的文档：动手前先调 ink_edit（它问用户覆盖还是另存，并先留底），按它返回的路径改完，再用这个工具导入改好的那个文件：覆盖的导入原文件；另存的导入 ink_edit 新建的那个文件，平板上那本自动换成它（不用 replace）。然后用 ink_reply 的 result 回报采纳的修改建议改成了没有。用户在对话里打字让你改已导入的文档也一样。' +
      '不经 ink_edit 另存成新文件名的新版本（如 v47 → v48）用 replace 指定替换哪本。只想推某一页让用户圈画时用 ink_show。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对路径按当前项目目录解析）' },
        title: { type: 'string', description: '在平板上显示的名字，默认用文件名' },
        replace: { type: 'string', description: '用这个文件替换草稿纸里已有的哪本（本子名字），笔迹保留、可对比新旧版' },
        as_new: { type: 'boolean', description: '即使导入过，也另建一本' },
      },
      required: ['path'],
    },
  })
  await $.tool.register({
    name: 'ink_scan',
    isDeferred: false,
    description:
      '检测用户草稿纸上一整本的内容：把一本里写过字的每一页（书页/推送页连同用户的手写、你之前的批注）在电脑上画成图，返回各页图片路径和书写过程，之后用 Read 逐页看。用户说「我在好几页上写了」「看看整本」或想知道用户在哪些页留了意见时用。不需要平板开着。',
    inputSchema: {
      type: 'object',
      properties: {
        nb: { type: 'string', description: '本子：名字（如 PPT 文件名）或 id（scratch=草稿本，board=Claude 推送，book:文件名.pdf）；省略则为平板当前打开的本子' },
        pages: { type: 'array', items: { type: 'number' }, description: '只看这些页（从 1 起）；省略则为所有写过字的页' },
        only_new: { type: 'boolean', description: '只要上次看过之后有新笔迹的页' },
        region: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '配合单独一页：只截页面坐标 y0–y1 这一段并放大' },
      },
    },
  })
  await $.tool.register({
    name: 'ink_confirm',
    isDeferred: false,
    description:
      '读不准用户的手写（字、符号、下标、数字）时，在平板上弹一张确认卡片问用户：附那一块的截图、你的读法和候选，用户点选或手写更正。会等用户回答（最多约 45 秒），返回用户的读法；没等到就先按你的理解继续，用户之后的回答作为新消息送来。一次可问几处。',
    inputSchema: {
      type: 'object',
      properties: {
        submission: { type: 'string', description: '【草稿纸】消息里的 submission 编号；省略则为平板当前那一页' },
        page: { type: 'number', description: '整本检测消息里的页码（从 1 起）' },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              anchor: { type: 'string', description: '笔迹编号，如 g3' },
              box: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '没有编号时：图里的像素框 [x0,y0,x1,y1]' },
              guess: { type: 'string', description: '你的读法' },
              options: { type: 'array', items: { type: 'string' }, description: '其他候选读法' },
              question: { type: 'string', description: '想问的话，如「这里是 ρ 还是 p？」' },
            },
          },
        },
      },
      required: ['questions'],
    },
  })
  await $.tool.register({
    name: 'ink_ask',
    isDeferred: false,
    description:
      '在用户平板的草稿纸顶上发一张问话卡片。能写在纸上的都写在纸上（用 ink_reply），只有两种情况才用它：要用户回答才能继续的问题（question，可带 0–4 个短选项；用户点一个，或用笔在卡片上手写），和纸上放不下的结果（result）。别的对话内容不发到平板。' +
      '问题卡片会等用户回答约一分半：点了选项，返回那个选项的原文；手写的，返回一张图的路径，用 Read 看图读出用户写的。一分半还没答，就停在这里等着，不要替用户选；卡片留在平板上，用户答了，答案会作为一条新消息（【草稿纸·回答】）送来。' +
      '用户也可能点「忽略」不答：返回会告诉你，忽略了的问题不要再问。' +
      '结果卡片发出去就返回，用户看完点「知道了」它就消失，不用等。平板没打开草稿纸时卡片不发，马上告诉你：改在对话里问、在对话里说。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要用户回答的一句话（问题卡片）；和 result 只给一个' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 4, description: '0–4 个短选项（几个字），用户点一个；不给就只能手写回答' },
        handwrite: { type: 'boolean', description: '能不能用笔在卡片上手写回答，默认能；只许点选项时填 false（这时要给 options）' },
        result: { type: 'string', description: '纸上放不下的结果（结果卡片，可多段，用 \\n 换行）；和 question 只给一个' },
      },
    },
  })
  await $.tool.register({
    name: 'ink_edit',
    isDeferred: false,
    description:
      '改用户电脑上一份已导入草稿纸的文档之前先调它（用户交上来的书页对应的原文件，或用户在对话里点名的）：每一轮动手改之前调一次；一次只办一个文件，这一轮要改同一个文件的几处合起来只调一次，要改两个文件就调两次，下一轮再改再调。' +
      '不带 mode：在用户平板顶上问「覆盖原文件，还是另存一份？」，等用户点选约一分半。用户还没选，就停在这里等着，不要替用户选，也不要先动这个文件；用户选了，会作为一条新消息送来，到时带上 mode 再调一次。用户点了「忽略」，这次就不改这个文件。平板没打开草稿纸时马上告诉你：在对话里问用户，再带上 mode 调。' +
      '带 mode 就不弹卡片，直接办：overwrite 先把原文件留底，然后你改原文件本身；saveas 在原文件旁边另存一份（如 v47 → v48），返回新文件的路径，你改这个新文件，原文件不要动。留了底，用户在平板上能撤回。' +
      '按返回的路径改完：用 ink_import 导入改好的那个文件（平板上那本原地换成新版；另存的，那本换成新文件），采纳的修改建议再用 ink_reply 的 result 逐条回报改成了没有。' +
      '用户在对话里打字让你改已导入的文档也一样先调它：用户已经说了覆盖还是另存，就带上 mode；没说的，在对话里问用户。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要改的那个原文件的路径（相对路径按当前项目目录解析）' },
        mode: {
          type: 'string',
          enum: ['overwrite', 'saveas'],
          description: '用户已经说了时填：overwrite 覆盖原文件（先留底），saveas 另存一份（改新文件）。不填就在平板上问用户',
        },
      },
      required: ['path'],
    },
  })
  await $.command.register({
    name: 'ink',
    description: '手写草稿纸：显示平板二维码和连接状态；/ink here 让平板发到这个对话',
    argumentHint: '[here]',
  })
}

// 启动：取会话 ID、注册工具、连服务、开始轮询。会话开始时调用；插件在会话中途被重新加载时
// 不会再有「会话开始」，所以用户输入、一轮开始/结束、调用工具或 /ink 时也都补一次。
async function ensureStarted($: Engine, cwd?: string) {
  if (ctx.started) return
  ctx.started = true
  try {
    ctx.sid = await $.session.id()
    // 项目根目录：在对话里 cd 到别处不会变（session.cwd 会跟着变，平板上的名字就成了别的文件夹）
    ctx.cwd = cwd ?? ((await $.session.root().catch(() => '')) || (await $.session.cwd()))
    ctx.label = basename(ctx.cwd)
    await registerTools($)
    void connect($)
      .then(() => baselineFiles($))
      .catch(() => undefined)
    $.clock.every(1500, () => {
      void tick($)
    })
  } catch (err) {
    ctx.started = false
    throw err
  }
}

export const register: Register = (on, options) => {
  ctx.base = String(options.server_url || 'http://127.0.0.1:8765').replace(/\/+$/, '')
  ctx.serverCommand = String(options.server_command || '').trim()
  ctx.offerFiles = String(options.offer_new_files ?? 'true') !== 'false'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 不按 surface/isInteractive 过滤：VS Code 扩展是程序宿主，会话开始时报的是「无界面、非交互」，和 claude -p 一样
    await ensureStarted($, e.cwd)
    return started
  })

  on('turn.start', async ($, e, next) => {
    await ensureStarted($).catch(() => undefined)
    if (!e.agentId) {
      ctx.turnActive = true
      ctx.current = SUB_IN_TEXT.exec(e.text ?? '')?.[1] ?? '' // 这一轮是在回哪次投递
    }
    return next(e)
  })

  // 这一轮在回投递时：读了投递的图＝Claude 在看；改文件、跑命令＝在做重活
  on('tool.call', async ($, e, next) => {
    if (ctx.current) {
      const input = e as unknown as { tool?: string; file_path?: unknown }
      if (input.tool === 'Read' && typeof input.file_path === 'string' && ctx.submissionsDir && isUnder(input.file_path, ctx.submissionsDir)) {
        void progress($, ctx.current, 'reading')
      } else if (input.tool && WORK_TOOLS.has(input.tool)) {
        void progress($, ctx.current, 'working')
      }
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (ctx.sid) await call($, 'POST', '/bridge/bye', { sid: ctx.sid })
    return next(e)
  })

  // 用户在这个对话里打字（终端是 composer，VS Code 等宿主是 sdk）：平板默认就发到这里
  on('prompt.submit', async ($, e, next) => {
    await ensureStarted($).catch(() => undefined)
    const typed = e.origin.kind === 'composer' || e.origin.kind === 'sdk' || e.origin.kind === 'bridge'
    // 顺带报这句话的开头：平板上同一个文件夹开着几个对话时靠它认（斜杠命令不算）
    const hint = hintOf(e.text ?? '')
    if (ctx.sid && typed && (await read($, status)).online) await call($, 'POST', '/bridge/active', { sid: ctx.sid, hint })
    return next(e)
  })

  // 每轮结束：报这一轮结束了，并把这一轮新生成的图片/文档报给平板（子代理的一轮不算）
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await ensureStarted($).catch(() => undefined)
    if (e.agentId) return done
    ctx.turnActive = false
    if (ctx.current) void progress($, ctx.current, 'done')
    ctx.current = ''
    if (ctx.sid && (await read($, status)).online) void offerNewFiles($).catch(() => undefined) // 不让找文件拖住这一轮的结束
    return done
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const done = await next(e)
    const path = (e as unknown as { file_path?: unknown }).file_path
    if (ctx.offerFiles && typeof path === 'string' && OFFER_EXT.test(path)) ctx.written.add(absPath(path))
    return done
  })

  // 服务连得上时，在系统提示词末尾加上草稿纸的固定说明（服务给的；没给就什么也不加）
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const st = await read($, status)
    if (!st.online || !ctx.protocol) return composed
    return { sections: [...composed.sections, { id: 'inkpad:protocol', text: ctx.protocol, scope: 'session' as const }] }
  })

  // 读取草稿纸投递的图片不必每次问
  on('tool.check', { tool: 'Read' }, async ($, e, next) => {
    const input = e.input as { file_path?: unknown } | null
    if (ctx.submissionsDir && input && typeof input.file_path === 'string') {
      const st = await $.fs.stat(input.file_path, { resolve: true }).catch(() => null)
      if (st?.realPath && isUnder(st.realPath, ctx.submissionsDir)) {
        return { decision: 'allow' as const, reason: 'inkpad：读取草稿纸投递的图片' }
      }
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL_REPLY }, async ($, e) => {
    await ensureStarted($).catch(() => undefined)
    const args = e as unknown as { submission?: unknown; page?: unknown; items?: unknown }
    const r = await call($, 'POST', '/bridge/reply', {
      sid: ctx.sid,
      submission: typeof args.submission === 'string' && args.submission ? args.submission : undefined,
      page: typeof args.page === 'number' ? args.page : undefined,
      items: Array.isArray(args.items)
        ? args.items.map((it: any) => (it && it.type === 'figure' && typeof it.path === 'string' ? { ...it, path: absPath(it.path) } : it))
        : [],
    })
    if (!r.ok) return { deny: `没写成：${r.error}` }
    const later = r.data.tabletOnline ? '' : '（平板现在没打开草稿纸，下次打开那一页时会出现）'
    return { result: `已写到草稿纸：${String(r.data.page ?? '')}，共 ${String(r.data.count)} 条${later}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'inkpad 插件出错，没有完成这次操作' }))

  on('tool.call', { tool: TOOL_SHOW }, async ($, e) => {
    await ensureStarted($).catch(() => undefined)
    const args = e as unknown as { path?: unknown; page?: unknown; title?: unknown }
    if (typeof args.path !== 'string' || !args.path) return { deny: '缺少 path' }
    const r = await call($, 'POST', '/bridge/show', {
      sid: ctx.sid,
      path: absPath(args.path),
      page: typeof args.page === 'number' ? args.page : undefined,
      title: typeof args.title === 'string' ? args.title : undefined,
    })
    if (!r.ok) return { deny: `没推送成：${r.error}` }
    const later = r.data.tabletOnline ? '平板上会弹出提示' : '平板现在没打开草稿纸，打开后在「Claude 推送」本子里'
    return {
      result: `已推到平板：「${String(r.data.title)}」（Claude 推送 第 ${Number(r.data.page) + 1} 页），${later}。用户圈画后会以【草稿纸】消息发回。`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'inkpad 插件出错，没有完成这次操作' }))

  on('tool.call', { tool: TOOL_IMPORT }, async ($, e) => {
    await ensureStarted($).catch(() => undefined)
    const args = e as unknown as { path?: unknown; title?: unknown; replace?: unknown; as_new?: unknown }
    if (typeof args.path !== 'string' || !args.path) return { deny: '缺少 path' }
    const r = await call($, 'POST', '/bridge/import', {
      sid: ctx.sid,
      path: absPath(args.path),
      title: typeof args.title === 'string' ? args.title : undefined,
      replace: typeof args.replace === 'string' && args.replace ? args.replace : undefined,
      as_new: args.as_new === true,
    })
    if (!r.ok) return { deny: `没导入成：${r.error}` }
    const later = r.data.tabletOnline ? '平板上会弹出提示' : '平板现在没打开草稿纸，打开后在左上角的本子列表里'
    if (typeof r.data.updated === 'string') {
      // 原文件在上次导入之后改过、留底里却没有记录（多半是没先调 ink_edit）：服务给一句提醒，接在后面（不拦）
      const remind = typeof r.data.remind === 'string' && r.data.remind ? `\n${r.data.remind}` : ''
      return { result: `已原地更新《${String(r.data.title)}》（共 ${String(r.data.pages)} 页，用户的手写保留）：${r.data.updated}。平板上改过的页会标出改动处，可对比旧版。${remind}` }
    }
    return { result: `已导入：《${String(r.data.title)}》，共 ${String(r.data.pages)} 页，${later}。` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'inkpad 插件出错，没有完成这次操作' }))

  on('tool.call', { tool: TOOL_SNAPSHOT }, async $ => {
    await ensureStarted($).catch(() => undefined)
    const r = await call($, 'POST', '/bridge/snapshot', { sid: ctx.sid, wait: 15 })
    if (!r.ok) return { deny: `没取到：${r.error}` }
    return { result: String(r.data.text) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'inkpad 插件出错，没有完成这次操作' }))

  on('tool.call', { tool: TOOL_SCAN }, async ($, e) => {
    await ensureStarted($).catch(() => undefined)
    const args = e as unknown as { nb?: unknown; pages?: unknown; only_new?: unknown; region?: unknown }
    const r = await call($, 'POST', '/bridge/scan', {
      sid: ctx.sid,
      nb: typeof args.nb === 'string' && args.nb ? args.nb : undefined,
      pages: Array.isArray(args.pages) ? args.pages.filter(p => typeof p === 'number') : undefined,
      only_new: args.only_new === true,
      region: Array.isArray(args.region) && args.region.length === 2 ? args.region : undefined,
    })
    if (!r.ok) return { deny: `没取到：${r.error}` }
    return { result: String(r.data.text) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'inkpad 插件出错，没有完成这次操作' }))

  on('tool.call', { tool: TOOL_CONFIRM }, async ($, e) => {
    await ensureStarted($).catch(() => undefined)
    const args = e as unknown as { submission?: unknown; page?: unknown; questions?: unknown }
    if (!Array.isArray(args.questions) || !args.questions.length) return { deny: '缺少 questions' }
    const r = await call($, 'POST', '/bridge/confirm', {
      sid: ctx.sid,
      submission: typeof args.submission === 'string' && args.submission ? args.submission : undefined,
      page: typeof args.page === 'number' ? args.page : undefined,
      questions: args.questions,
    })
    if (!r.ok) return { deny: `没问成：${r.error}` }
    const id = String(r.data.id)
    if (!r.data.tabletOnline) {
      await call($, 'POST', '/bridge/confirm-wait', { id, wait: 0, last: true })
      return { result: '平板现在没打开草稿纸：确认卡片已经留在那一页，用户打开后回答会作为新消息发来。先按你的理解继续，并在回复里标明哪处是推测的。' }
    }
    $.ui.toast('在平板上确认字迹')
    return { result: await waitConfirm($, id) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'inkpad 插件出错，没有完成这次操作' }))

  // 问话卡片：问题等约一分半（没答就停手等着，之后的回答作为新消息送来）；结果发出去就返回；平板不在线马上改在对话里
  on('tool.call', { tool: TOOL_ASK }, async ($, e) => {
    await ensureStarted($).catch(() => undefined)
    const args = e as unknown as { question?: unknown; options?: unknown; handwrite?: unknown; result?: unknown }
    const question = typeof args.question === 'string' ? args.question.trim() : ''
    const result = typeof args.result === 'string' ? args.result.trim() : ''
    if (!question && !result) return { deny: '要给 question（要用户回答的一句话）或 result（纸上放不下的结果）' }
    if (question && result) return { deny: 'question 和 result 只给一个：问问题和给结果分两张卡片' }
    const options = Array.isArray(args.options) ? args.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '') : []
    if (options.length > 4) return { deny: 'options 最多 4 个' }
    const r = await call($, 'POST', '/bridge/ask', {
      sid: ctx.sid,
      ...(question ? { question, options, handwrite: args.handwrite !== false } : { result }),
    })
    if (!r.ok) return { deny: `没发成：${r.error}` }
    if (r.data.offline) {
      return { result: question ? '平板现在没打开草稿纸，卡片没发出去：改在对话里问用户。' : '平板现在没打开草稿纸，卡片没发出去：把结果直接写在对话里。' }
    }
    if (result) return { result: '结果卡片已经显示在平板顶上，用户看完点「知道了」它就消失；不用等。' }
    $.ui.toast('在平板上回答 Claude 的问题')
    return { result: await waitAsk($, String(r.data.id)) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'inkpad 插件出错，没有完成这次操作' }))

  // 改文件之前（ink_edit）：带 mode 直接办（覆盖前留底 / 另存一份）；没带就在平板顶上问覆盖还是另存，等约一分半；
  // 平板不在线马上告诉 Claude 改在对话里问。留底没做成等出错：deny，Claude 不要动文件
  on('tool.call', { tool: TOOL_EDIT }, async ($, e) => {
    await ensureStarted($).catch(() => undefined)
    const args = e as unknown as { path?: unknown; mode?: unknown }
    if (typeof args.path !== 'string' || !args.path) return { deny: '缺少 path（要改的那个原文件）' }
    const mode = args.mode === 'overwrite' || args.mode === 'saveas' ? args.mode : undefined
    if (args.mode !== undefined && args.mode !== null && args.mode !== '' && !mode) {
      return { deny: 'mode 只能是 overwrite（覆盖原文件）或 saveas（另存一份）；不知道用户要哪种就不填，在平板上问' }
    }
    const r = await call($, 'POST', '/bridge/edit', { sid: ctx.sid, path: absPath(args.path), ...(mode ? { mode } : {}) })
    if (!r.ok) return { deny: `没办成：${r.error}` }
    if (typeof r.data.ask === 'string' && r.data.ask) {
      $.ui.toast('在平板上选覆盖还是另存')
      return { result: await waitEdit($, r.data.ask) }
    }
    return { result: String(r.data.text ?? '') }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'inkpad 插件出错，没有完成这次操作' }))

  on('command.run', { command: 'ink' }, async ($, e) => {
    if (e.args.trim() === 'stop') { // 停止服务：平板连不上，插件也不自动重启，直到下次 /ink
      ctx.serverWanted = false
      const r = await call($, 'POST', '/bridge/stop', {})
      await setStatus($, { online: false, tabletOnline: false })
      return { text: r.ok ? '草稿纸服务已停止。要再用，输入 /ink。' : '草稿纸服务本来就没在运行。' }
    }
    await ensureStarted($).catch(() => undefined)
    if (e.args.trim() === 'here' && ctx.sid) await call($, 'POST', '/bridge/claim', { sid: ctx.sid })
    if (!(await ensureServer($))) {
      await setStatus($, { online: false })
      return { text: '草稿纸服务没有运行，也没能自动启动。检查 inkpad 插件的 server_command 设置，或手动运行 inkthink 文件夹里的 start.bat。' }
    }
    ctx.serverWanted = true
    await hello($)
    await $.ui.open({ id: PANE, title: '手写草稿纸' })
    const st = await read($, status)
    const nb = st.targetNb ? `《${st.targetNb}》` : ''
    const where = st.isTarget
      ? `平板上${nb}发送的内容会进入这个对话。`
      : `平板上${nb || '这本'}发往「${st.targetLabel || '（无）'}」，用 /ink here 改到这个对话（每本记住自己的对话）。`
    const stable = st.stableUrl ? `；换了网络 IP 会变，也可以用固定地址 ${st.stableUrl}（有的网络不支持）` : ''
    return { text: `草稿纸：平板浏览器打开 ${st.url ?? ''}（和电脑连同一个 Wi-Fi${stable}）。${where}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const st = await read($, status)
    const lines = [
      st.online ? '服务已连接' : '服务未连接',
      st.tabletOnline ? '平板在线' : '平板未打开',
      st.isTarget
        ? `平板${st.targetNb ? `上《${st.targetNb}》` : ''}发送的内容会进入这个对话`
        : `平板上${st.targetNb ? `《${st.targetNb}》` : '这本'}发往：${st.targetLabel || '（无）'}`,
    ]
    if (e.surface === 'terminal') {
      const { Box, Text, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text bold>手写草稿纸</Text>
          {lines.map(t => (
            <Text>{t}</Text>
          ))}
          {st.url ? <Text>平板打开：{st.url}</Text> : null}
          {st.stableUrl ? <Text>固定地址（IP 变了也能用）：{st.stableUrl}</Text> : null}
          {st.online && !st.isTarget ? <Button key="claim" label="这本改发到这个对话" onPress={() => claim($)} /> : null}
        </Box>
      )
    }
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text bold>手写草稿纸</Text>
        {lines.map(t => (
          <Text dimColor>{t}</Text>
        ))}
        {st.qr ? <Svg source={st.qr} alt={`扫码打开草稿纸：${st.url ?? ''}`} width={180} height={180} /> : null}
        {st.url ? <Text>{st.url}</Text> : null}
        {st.stableUrl ? <Text dimColor>固定地址（IP 变了也能用）：{st.stableUrl}</Text> : null}
        {st.online && !st.isTarget ? <Button key="claim" label="这本改发到这个对话" onPress={() => claim($)} /> : null}
      </Box>
    )
  })
}

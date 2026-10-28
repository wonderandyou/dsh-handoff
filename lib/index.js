/**
 * dsh-handoff —— 宿主半边
 * ============================================================================
 * 一句话：**每个工作区一份交接文档，会话结束往里写一条，新会话开起来自动读回来。**
 *
 * 三块拼起来：
 *   store.js      按工作区路径存文档（json 是真相源，md 是给人看的版本）
 *   summarize.js  把一段会话压成一条「做了什么 / 结果 / 下次接手」
 *   index.js      事件订阅 + 自动注入 + 工具 + 面板接口
 *
 * 几条硬立场：
 *   · **只读会话事件，绝不 append** —— 往会话日志里加东西会让会话打不开；
 *   · 总结走宿主自己的 ctx.llm，不需要 key、不碰外部服务；
 *   · 总结异步、失败静默 —— 交接写不出来也绝不许拖垮聊天；
 *   · 同一个会话只占一条记录（越聊越长是「更新」不是「追加」）；
 *   · 注入失败就返回空字符串 —— 组装阶段抛错会毁掉整个请求。
 * ============================================================================
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDocStore, ensureDir, formatTime, normalizePath, resultLabel, slugOf } from './store.js'
import { buildTranscript, fallbackEntry, resolveCallConfig, summarize } from './summarize.js'

const name = 'dsh-handoff'

/** 只要有提示词注册表就能工作；其余服务（workspaceRegistry / tools / webServer / llm）都按可选处理。 */
const inject = ['systemPrompt']

const DEFAULTS = Object.freeze({
  enabled: true,
  /** 数据目录；留空 = ~/.dsh/handoff。 */
  dir: '',
  /** 工作区账本路径；留空 = ~/.dsh/storages/workspace.json（一般不用改，测试才用）。 */
  workspaceFile: '',
  /** 运行时上下文排序：比 grow 的状态段（310）稍后一点，紧贴消息尾部。 */
  injectOrder: 320,
  /** 新会话自动读回最近几条。 */
  injectEntries: 3,
  /** 自动读回文本的字符预算（约 3.2 字符 ≈ 1 token）。 */
  injectChars: 1200,
  /** 每个工作区最多保留多少条。 */
  maxEntries: 40,
  /** 会话结束时是否自动总结写入。 */
  autoWrite: true,
  /** 两次总结之间的最小间隔 —— 防「一直聊一直花钱」。 */
  minGapMs: 90000,
  /** 一轮结束后等多久再总结（这段时间内又来了新消息就不重复总结）。 */
  debounceMs: 20000,
  /** 每天最多总结几次；0 = 不限。 */
  maxPerDay: 120,
  /** 指定总结模型 / provider；留空 = 自动挑便宜的。 */
  summarizeModel: '',
  summarizeProvider: '',
  /** 单次总结最长等待。 */
  summarizeTimeoutMs: 60000,
})

function resolveConfig(raw) {
  const cfg = { ...DEFAULTS }
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  for (const key of Object.keys(DEFAULTS)) {
    if (source[key] !== undefined) cfg[key] = source[key]
  }
  cfg.enabled = cfg.enabled !== false
  cfg.autoWrite = cfg.autoWrite !== false
  const num = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, n))
  }
  cfg.injectOrder = num(cfg.injectOrder, DEFAULTS.injectOrder, -10000, 10000)
  cfg.injectEntries = num(cfg.injectEntries, DEFAULTS.injectEntries, 0, 12)
  cfg.injectChars = num(cfg.injectChars, DEFAULTS.injectChars, 200, 8000)
  cfg.maxEntries = num(cfg.maxEntries, DEFAULTS.maxEntries, 1, 500)
  cfg.minGapMs = num(cfg.minGapMs, DEFAULTS.minGapMs, 0, 24 * 3600 * 1000)
  cfg.debounceMs = num(cfg.debounceMs, DEFAULTS.debounceMs, 1000, 10 * 60 * 1000)
  cfg.maxPerDay = num(cfg.maxPerDay, DEFAULTS.maxPerDay, 0, 5000)
  cfg.summarizeTimeoutMs = num(cfg.summarizeTimeoutMs, DEFAULTS.summarizeTimeoutMs, 5000, 180000)
  cfg.summarizeModel = String(cfg.summarizeModel ?? '')
  cfg.summarizeProvider = String(cfg.summarizeProvider ?? '')
  cfg.dir = String(cfg.dir ?? '')
  cfg.workspaceFile = String(cfg.workspaceFile ?? '')
  return Object.freeze(cfg)
}

function makeLog(ctx) {
  return (level, message) => {
    try {
      const logger = ctx?.logger
      if (logger !== null && logger !== undefined && typeof logger[level] === 'function') {
        logger[level](`[handoff] ${message}`)
      } else if (level === 'warn' || level === 'error') {
        console.error(`[handoff] ${message}`)
      }
    } catch {
      // 日志失败绝不向上冒泡
    }
  }
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

export function apply(ctx, rawConfig = {}) {
  const cfg = resolveConfig(rawConfig)
  if (cfg.enabled !== true) return
  const log = makeLog(ctx)

  const baseDir = cfg.dir !== '' ? path.resolve(cfg.dir) : path.join(os.homedir(), '.dsh', 'handoff')
  const dir = ensureDir(baseDir)
  const store = createDocStore({ dir, log, maxEntries: cfg.maxEntries })

  /** 会话 → cwd 缓存（事件里能拿到 header，注入时就不用再猜）。 */
  const cwdCache = new Map()
  /** 会话缓冲区：本会话收到的消息、轮数、定时器。 */
  const buffers = new Map()
  /** 注入文本缓存：写盘后清掉，避免新会话读到旧内容。 */
  const injectCache = new Map()
  /** agent 对象引用：agent 上往往直接挂着 session / cwd，比反查服务更靠谱。 */
  const agentRefs = new Map()
  /** 服务引用：**必须靠 ctx.inject 等就绪**，ctx.get() 在激活那一刻拿不到（grow 踩过）。 */
  let sessionsRef = undefined
  let registryRef = undefined
  let llmRef = undefined

  for (const dep of ['sessions', 'workspaceRegistry', 'llm']) {
    try {
      if (typeof ctx.inject !== 'function') continue
      ctx.inject([dep], (depCtx) => {
        const service = depCtx?.[dep]
        if (dep === 'sessions') {
          sessionsRef = service
          log('info', `sessions 服务就绪：${typeof service?.get === 'function' ? '有 get()' : '没有 get()'}`)
        } else if (dep === 'workspaceRegistry') {
          registryRef = service
          const count = safeRead(() => service?.list?.()?.length)
          log('info', `工作区注册表就绪：${typeof service?.list === 'function' ? `${count ?? '?'} 个工作区` : '没有 list()'}`)
        } else if (dep === 'llm') {
          llmRef = service
          log('info', `llm 服务就绪：${typeof service?.stream === 'function' ? '有 stream()' : '没有 stream()'}`)
        }
      })
    } catch (error) {
      log('warn', `等 ${dep} 依赖失败：${String(error?.message ?? error)}`)
    }
  }

  // ------------------------------------------------------------ 工作区解析 --

  const workspaceFile =
    cfg.workspaceFile !== '' ? path.resolve(cfg.workspaceFile) : path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')
  let workspaceFileCache = { at: 0, rows: [] }

  /**
   * 直接读 DSH 自己的工作区账本（`~/.dsh/storages/workspace.json`）。
   * ★ 这是**最可靠**的一条路：不依赖 workspaceRegistry 服务能不能拿到
   *   （ctx.get() 在插件激活那一刻是 undefined，踩过一次）。只读，绝不写它。
   *   结构：{ global: { workspaceIds }, tables: { workspaces: { <id>: {path,title,sessionIds} } } }
   */
  function readWorkspaceFile() {
    const now = Date.now()
    if (now - workspaceFileCache.at < 5000) return workspaceFileCache.rows
    let rows = []
    try {
      const data = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'))
      const table = data?.tables?.workspaces
      if (table !== null && typeof table === 'object') {
        const order = Array.isArray(data?.global?.workspaceIds) ? data.global.workspaceIds : Object.keys(table)
        for (const id of order) {
          const rec = table[id]
          if (rec === null || typeof rec !== 'object') continue
          const wsPath = typeof rec.path === 'string' ? rec.path : ''
          if (wsPath === '') continue
          rows.push({
            id: String(id),
            path: wsPath,
            title: String(rec.title ?? ''),
            sessionIds: Array.isArray(rec.sessionIds) ? rec.sessionIds : [],
          })
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') log('debug', `读工作区账本失败：${String(error?.message ?? error)}`)
    }
    workspaceFileCache = { at: now, rows }
    return rows
  }

  function registryList() {
    const fromFile = readWorkspaceFile()
    if (fromFile.length > 0) return fromFile
    try {
      const reg = registryRef ?? ctx?.workspaceRegistry ?? safeRead(() => ctx?.get?.('workspaceRegistry'))
      if (reg === null || reg === undefined || typeof reg.list !== 'function') return []
      const list = reg.list()
      return Array.isArray(list) ? list : []
    } catch (error) {
      log('debug', `读工作区列表失败：${String(error?.message ?? error)}`)
      return []
    }
  }

  function sessionOf(sessionId) {
    try {
      const sessions = sessionsRef ?? ctx?.sessions ?? safeRead(() => ctx?.get?.('sessions'))
      if (sessions === null || sessions === undefined || typeof sessions.get !== 'function') return undefined
      return sessions.get(sessionId)
    } catch {
      return undefined
    }
  }

  /** 读一个可能是 getter 的字段：抛错就当没有（Session.header 是 getter，没准备好会抛）。 */
  function safeRead(fn) {
    try {
      return fn()
    } catch {
      return undefined
    }
  }

  function cwdOfSession(sessionId, session) {
    const key = String(sessionId ?? '')
    if (key !== '') {
      const cached = cwdCache.get(key)
      if (typeof cached === 'string' && cached !== '') return cached
    }
    const agentRef = key === '' ? undefined : agentRefs.get(key)
    const live = key === '' ? undefined : sessionOf(key)
    // ★ 每一项都单独 try —— session.header 是 getter，抛一次就会把整个 turn/end 处理掉，
    //   表现是「事件收得到、就是不写文档」，日志里只有一条 debug，非常难查（踩过）
    const candidates = [
      safeRead(() => session?.header?.cwd),
      safeRead(() => session?.meta?.cwd),
      safeRead(() => session?.cwd),
      safeRead(() => agentRef?.session?.header?.cwd),
      safeRead(() => agentRef?.session?.meta?.cwd),
      safeRead(() => agentRef?.header?.cwd),
      safeRead(() => agentRef?.meta?.cwd),
      safeRead(() => agentRef?.cwd),
      safeRead(() => live?.header?.cwd),
      safeRead(() => live?.meta?.cwd),
      safeRead(() => live?.cwd),
      safeRead(() => live?.agent?.session?.header?.cwd),
    ]
    for (const value of candidates) {
      if (typeof value === 'string' && value !== '') {
        if (key !== '') cwdCache.set(key, value)
        return value
      }
    }
    return ''
  }

  /**
   * 会话属于哪个工作区。
   * 三条路按顺序：① 注册表里 sessionIds 命中；② cwd 与工作区路径相等；③ 拿 cwd 自己当工作区。
   */
  function resolveWorkspace(sessionId, session) {
    const id = String(sessionId ?? '')
    const cwd = cwdOfSession(id, session)
    const list = registryList()

    for (const item of list) {
      try {
        const ids = safeRead(() => item?.sessionIds)
        // ★ 账本里的 id 有两种写法：带 `session-` 前缀的和不带的（补名册时混过）→ 统一去掉前缀再比
        if (Array.isArray(ids) && ids.some((other) => normSessionId(other) === normSessionId(id))) {
          const wsPath = typeof item?.path === 'string' ? item.path : ''
          if (wsPath !== '') return { id: String(item?.id ?? wsPath), path: wsPath, title: String(item?.title ?? slugOf(wsPath)) }
        }
      } catch {
        // 单个工作区坏了不影响别的
      }
    }

    if (cwd !== '') {
      const norm = normalizePath(cwd)
      for (const item of list) {
        try {
          if (normalizePath(item?.path) === norm) {
            return { id: String(item?.id ?? item.path), path: String(item.path), title: String(item?.title ?? slugOf(item.path)) }
          }
        } catch {
          // 同上
        }
      }
      return { id: `cwd:${norm}`, path: cwd, title: slugOf(cwd) }
    }
    return undefined
  }

  /** 取第一个非空字符串（空串、undefined、null 都跳过）。 */
  function pickText(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    return ''
  }

  /** 会话 id 归一：去掉 `session-` 前缀（账本里两种写法都出现过）。 */
  function normSessionId(value) {
    return String(value ?? '').replace(/^session-/, '')
  }

  /**
   * 面板 / 工具用的工作区清单。
   * ★ **登记过的工作区全都列出来**（哪怕还没有交接文档）—— 主人要的是「按工作区分开」，
   *   只列有文档的会看起来像「没有分工作区」（踩过）。再补上「注册表里没有、但磁盘上有文档」的。
   */
  function allWorkspaces() {
    const docs = new Map()
    for (const row of store.list()) docs.set(normalizePath(row.path), row)
    const rows = []
    const seen = new Set()
    for (const item of registryList()) {
      const wsPath = safeRead(() => item?.path)
      if (typeof wsPath !== 'string' || wsPath === '') continue
      const norm = normalizePath(wsPath)
      if (seen.has(norm)) continue
      seen.add(norm)
      const doc = docs.get(norm)
      const files = store.fileOf(wsPath)
      const sessions = safeRead(() => item?.sessionIds)
      rows.push({
        key: doc?.key ?? files.key,
        hash: files.hash,
        slug: files.slug,
        path: wsPath,
        title: pickText(doc?.title, safeRead(() => item?.title), slugOf(wsPath)),
        doc: doc?.doc ?? files.rel,
        count: doc?.count ?? 0,
        updatedAt: doc?.updatedAt ?? 0,
        registered: true,
        sessions: Array.isArray(sessions) ? sessions.length : 0,
      })
      docs.delete(norm)
    }
    for (const row of docs.values()) rows.push({ ...row, title: pickText(row.title, row.slug), registered: false, sessions: 0 })
    return rows
  }

  // ---------------------------------------------------------------- 缓冲 --
  function bufferOf(sessionId) {
    const key = String(sessionId ?? '')
    if (key === '') return undefined
    let item = buffers.get(key)
    if (item !== undefined) return item
    item = {
      sessionId: key,
      entries: [],
      turns: 0,
      lastReason: undefined,
      ws: undefined,
      timer: undefined,
      timerAt: 0,
      lastSummaryAt: 0,
      inFlight: false,
      wrote: 0,
      failed: 0,
      lastError: '',
      lastSkip: '',
    }
    buffers.set(key, item)
    if (buffers.size > 64) {
      const oldest = buffers.keys().next()
      if (!oldest.done) buffers.delete(oldest.value)
    }
    return item
  }

  function eventText(message) {
    if (message === undefined || message === null) return ''
    const content = message?.content
    if (typeof content === 'string') return content.slice(0, 4000)
    if (!Array.isArray(content)) return typeof message?.text === 'string' ? message.text.slice(0, 4000) : ''
    const parts = []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      else if (block?.type === 'image') parts.push('[图片]')
      else if (block?.type === 'tool-call') parts.push(`[调用 ${String(block?.name ?? '工具')}]`)
    }
    return parts.join('\n').slice(0, 4000)
  }

  // -------------------------------------------------------------- 每日预算 --

  const statsFile = path.join(dir, 'stats.json')

  function readStats() {
    const today = new Date().toISOString().slice(0, 10)
    try {
      const raw = JSON.parse(fs.readFileSync(statsFile, 'utf8'))
      return raw?.day === today ? Math.max(0, Number(raw?.count ?? 0) || 0) : 0
    } catch {
      return 0
    }
  }

  function budgetLeft() {
    if (cfg.maxPerDay <= 0) return Infinity
    return Math.max(0, cfg.maxPerDay - readStats())
  }

  function noteSummary() {
    try {
      const today = new Date().toISOString().slice(0, 10)
      writeAtomic(statsFile, JSON.stringify({ day: today, count: readStats() + 1 }, null, 2))
    } catch {
      // 记不上就算了
    }
  }

  // -------------------------------------------------------------- 总结落盘 --

  function resultFromReason(reason) {
    const kind = typeof reason === 'string' ? reason : String(reason?.kind ?? reason?.type ?? '')
    if (/error|fail|abort|cancel|interrupt/i.test(kind)) return 'partial'
    return 'ok'
  }

  async function summarizeSession(buf, ws) {
    // ★ ctx.get('llm') 也可能抛（服务没注册时 cordis 会抛，不是返回 undefined）→ 全部包住
    const fallback = () => {
      try {
        return fallbackEntry(buf.entries, { result: resultFromReason(buf.lastReason) })
      } catch {
        return undefined
      }
    }
    try {
      const llm = llmRef ?? safeRead(() => ctx?.llm) ?? safeRead(() => ctx?.get?.('llm'))
      const call = await resolveCallConfig(llm, { provider: cfg.summarizeProvider, model: cfg.summarizeModel })
      if (call.ok !== true) {
        log('debug', `没法调模型（${call.reason}），这一条用规则摘要顶上`)
        return fallback()
      }
      const transcript = buildTranscript(buf.entries, { headChars: 1200, tailChars: 2800 })
      if (transcript === '') return undefined
      const result = await summarize({
        llm,
        provider: call.provider,
        model: call.model,
        transcript,
        timeoutMs: cfg.summarizeTimeoutMs,
      })
      if (result.ok !== true) {
        log('debug', `总结没成功（${result.reason}），这一条用规则摘要顶上`)
        return fallback()
      }
      return result.entry
    } catch (error) {
      log('warn', `总结环节抛错，改用规则摘要：${String(error?.message ?? error)}`)
      return fallback()
    }
  }

  async function flush(sessionId, why) {
    const buf = buffers.get(String(sessionId))
    if (buf === undefined) return
    if (buf.inFlight === true) return
    if (buf.entries.length === 0) return

    const ws = safeRead(() => buf.ws ?? resolveWorkspace(sessionId))
    if (ws === undefined) {
      buf.lastSkip = '认不出工作区（cwd 和账本都没命中）'
      log('warn', `会话 ${String(sessionId).slice(0, 8)} 找不到工作区，这次先不写`)
      return
    }

    if (budgetLeft() <= 0) {
      buf.lastSkip = '今日总结预算用完'
      log('debug', `今天的总结预算用完了（${cfg.maxPerDay} 次），这条跳过`)
      return
    }

    buf.inFlight = true
    try {
      const piece = await summarizeSession(buf, ws)
      if (piece === undefined) {
        buf.lastSkip = '总结没产出内容'
        return
      }
      const entry = {
        ...piece,
        sessionId: String(sessionId),
        at: Date.now(),
        turns: buf.turns,
        workspace: ws.path,
        source: piece.source ?? 'model',
      }
      const written = store.upsert(ws.path, entry, { title: pickText(ws.title, slugOf(ws.path)) })
      if (written === undefined) {
        buf.lastSkip = '写文件失败（看 warn 日志）'
        return
      }
      buf.ws = ws
      buf.lastSkip = ''
      buf.lastError = ''
      buf.lastSummaryAt = Date.now()
      buf.wrote += 1
      injectCache.delete(normalizePath(ws.path))
      noteSummary()
      log(
        'info',
        `交接已${written.action === 'insert' ? '写入' : '更新'}（${why}）：${ws.title} · ${String(entry.title ?? '').slice(0, 30)} · 共 ${written.doc.entries.length} 条`,
      )
    } catch (error) {
      buf.failed += 1
      buf.lastError = String(error?.message ?? error)
      log('warn', `交接写入失败：${buf.lastError}`)
    } finally {
      buf.inFlight = false
    }
  }

  function schedule(sessionId) {
    if (cfg.autoWrite !== true) return
    const buf = buffers.get(String(sessionId))
    if (buf === undefined) return
    const now = Date.now()
    const gapLeft = Math.max(0, buf.lastSummaryAt + cfg.minGapMs - now)
    const wait = Math.max(cfg.debounceMs, gapLeft)
    // 已经有更早的定时器就让它跑，不重置（否则一直聊就一直不落盘）
    if (buf.timer !== undefined && buf.timerAt <= now + wait) return
    if (buf.timer !== undefined) clearTimeout(buf.timer)
    buf.timerAt = now + wait
    buf.timer = setTimeout(() => {
      buf.timer = undefined
      buf.timerAt = 0
      void flush(sessionId, 'auto')
    }, wait)
    if (typeof buf.timer?.unref === 'function') buf.timer.unref()
  }

  // ------------------------------------------------------------ 事件订阅 --

  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = String(session?.id ?? '')
      if (sessionId === '') return
      const type = event?.type

      // ★ 这里**不要**先读 cwd：读 cwd 要碰 Session.header（getter，会抛），
      //   一旦抛错整条事件处理就断了 —— 后面 user/assistant 都进不了缓冲，
      //   表现出来就是「每轮都在跑、交接文档永远空的」。cwd 放到 turn/end 里再读（那里有 try）。
      if (type === 'user/message') {
        const text = eventText(event.data?.message ?? event.data)
        if (text !== '') bufferOf(sessionId)?.entries.push({ role: 'user', text })
        return
      }
      if (type === 'assistant/message') {
        const text = eventText(event.data?.message ?? event.data)
        if (text !== '') bufferOf(sessionId)?.entries.push({ role: 'assistant', text })
        return
      }
      if (type === 'turn/end') {
        const buf = bufferOf(sessionId)
        if (buf === undefined) return
        buf.turns += 1
        buf.lastReason = event.data?.reason
        if (buf.ws === undefined) buf.ws = safeRead(() => resolveWorkspace(sessionId, session))
        if (buf.ws === undefined) log('warn', `会话 ${sessionId.slice(0, 8)} 这一轮结束但没认出工作区（cwd 缓存 ${cwdCache.size} 条），先不排写入`)
        schedule(sessionId)
      }
    } catch (error) {
      log('warn', `事件处理失败：${String(error?.message ?? error)}`)
    }
  })

  // ------------------------------------------------- 新会话自动读回交接 --

  function renderInject(ws, sessionId) {
    const key = normalizePath(ws.path)
    const cached = injectCache.get(key)
    const now = Date.now()
    if (cached !== undefined && now - cached.at < 15000 && cached.sessionId === sessionId) return cached.text

    const text = buildInjectText(ws, sessionId)
    injectCache.set(key, { at: now, text, sessionId })
    if (injectCache.size > 128) {
      const oldest = injectCache.keys().next()
      if (!oldest.done) injectCache.delete(oldest.value)
    }
    return text
  }

  function buildInjectText(ws, sessionId) {
    const loaded = store.load(ws.path)
    const entries = loaded.doc.entries.filter((item) => String(item?.sessionId ?? '') !== String(sessionId ?? ''))
    if (entries.length === 0) return ''
    const limit = Math.max(1, cfg.injectEntries)
    const picked = entries.slice(0, limit)
    const lines = []
    lines.push('## 本工作区交接（自动，来自 dsh-handoff）')
    lines.push('')
    lines.push(`工作区：${String(loaded.doc.title || ws.title || slugOf(ws.path))}（\`${ws.path}\`）· 已有 ${loaded.doc.entries.length} 条记录。`)
    lines.push('下面几条是同工作区里更早会话留下的交接。**先看一眼再开工**；如果和主人这次说的事无关，忽略即可，不要主动复述。')
    lines.push('')
    let used = lines.join('\n').length
    let shown = 0
    for (const entry of picked) {
      const title = String(entry?.title ?? '').trim() || '（没有标题）'
      const did = String(entry?.did ?? '').trim()
      const block = [
        `${shown + 1}. ${formatTime(entry?.at)} · ${title}`,
        did === '' ? '' : `   - 做了什么：${did}`,
        `   - 结果：${resultLabel(entry?.result)}`,
        String(entry?.next ?? '').trim() === '' ? '' : `   - 下次接手：${String(entry.next).trim()}`,
      ]
        .filter((line) => line !== '')
        .join('\n')
      if (used + block.length > cfg.injectChars) break
      lines.push(block)
      lines.push('')
      used += block.length + 1
      shown += 1
    }
    if (shown === 0) return ''
    lines.push(`完整文档：\`${loaded.md}\`（要看全部就打开它，或用 handoff 工具读）`)
    return lines.join('\n')
  }

  const installedAgents = new Map()

  function installForAgent(agent) {
    const sessionId = String(agent?.id ?? '')
    if (sessionId === '') return undefined
    const disposers = []

    try {
      const agentCtx = agent?.ctx
      if (agentCtx === undefined || agentCtx === null || typeof agentCtx.effect !== 'function') return undefined
      disposers.push(
        agentCtx.effect(
          () =>
            agentCtx.systemPrompt.context({
              name: 'handoff:workspace',
              order: cfg.injectOrder,
              interpolate: false,
              text: () => {
                try {
                  const ws = resolveWorkspace(sessionId)
                  if (ws === undefined) return ''
                  return renderInject(ws, sessionId)
                } catch (error) {
                  // 组装阶段抛错会毁掉整个请求 —— 必须吞掉
                  log('warn', `渲染交接失败：${String(error?.message ?? error)}`)
                  return ''
                }
              },
            }),
          'handoff.inject',
        ),
      )
    } catch (error) {
      log('warn', `交接注入注册失败：${String(error?.message ?? error)}`)
    }

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 已经清掉了
        }
      }
    }
  }

  function ensureAgent(agent) {
    const sessionId = String(agent?.id ?? '')
    if (sessionId === '') return
    // 留着 agent 对象：它上面往往直接挂着 session / cwd，比反查服务更靠得住
    if (!agentRefs.has(sessionId)) agentRefs.set(sessionId, agent)
    if (installedAgents.has(sessionId)) return
    let cleanup = null
    try {
      ctx.effect(() => {
        cleanup = installForAgent(agent) ?? null
        return () => {
          if (typeof cleanup === 'function') cleanup()
          cleanup = null
        }
      }, `handoff.agent.${sessionId}`)
    } catch (error) {
      log('warn', `给会话 ${sessionId} 挂交接注入失败：${String(error?.message ?? error)}`)
      return
    }
    installedAgents.set(sessionId, () => {
      if (typeof cleanup === 'function') cleanup()
    })
  }

  ctx.on('agent/created', (payload) => {
    try {
      ensureAgent(payload?.agent)
    } catch (error) {
      log('warn', `新会话挂交接失败：${String(error?.message ?? error)}`)
    }
  })

  ctx.on('agent/disposed', (payload) => {
    const sessionId = String(payload?.agent?.id ?? '')
    if (sessionId === '') return
    agentRefs.delete(sessionId)
    const dispose = installedAgents.get(sessionId)
    installedAgents.delete(sessionId)
    if (typeof dispose === 'function') {
      try {
        dispose()
      } catch {
        // 已经清掉了
      }
    }
    // 会话真的要走了：把还没落盘的内容立刻写掉
    const buf = buffers.get(sessionId)
    if (buf !== undefined) {
      if (buf.timer !== undefined) {
        clearTimeout(buf.timer)
        buf.timer = undefined
        buf.timerAt = 0
      }
      if (cfg.autoWrite === true && buf.entries.length > 0) void flush(sessionId, 'dispose')
      buffers.delete(sessionId)
    }
    cwdCache.delete(sessionId)
  })

  // 热加载 / 重启后：把已经在跑的会话补挂一遍
  // ★ 必须用 ctx.inject 等 agents 就绪 —— ctx.get('agents') 在激活那一刻是 undefined，
  //   那样「恢复出来的旧会话」永远补挂不上（注入不出现、cwd 也拿不到）。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['agents'], (agentCtx) => {
        try {
          const agents = agentCtx?.agents
          if (agents === undefined || agents === null || typeof agents.list !== 'function') {
            log('warn', 'agents 服务没有 list()，补挂已有会话跳过')
            return
          }
          const list = agents.list() ?? []
          for (const agent of list) {
            try {
              ensureAgent(agent)
            } catch (error) {
              log('debug', `补挂已有会话失败：${String(error?.message ?? error)}`)
            }
          }
          log('info', `补挂已有会话：${list.length} 个`)
        } catch (error) {
          log('warn', `枚举已有会话失败：${String(error?.message ?? error)}`)
        }
      })
    }
  } catch (error) {
    log('warn', `请求 agents 依赖失败：${String(error?.message ?? error)}`)
  }

  // ---------------------------------------------------------------- 工具 --

  const okSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      text: { type: 'string' },
      count: { type: 'integer' },
    },
    required: ['ok', 'text'],
  }
  const textRender = (args, value) => [{ type: 'text', text: String(value?.text ?? '') }]

  /** 从路径 / 标题 / key 里认出是哪个工作区；不填就用调用方会话所在的工作区。 */
  function findWorkspace(query, agentId) {
    const want = String(query ?? '').trim()
    const list = allWorkspaces()
    if (want === '') {
      const here = agentId === undefined || agentId === '' ? undefined : resolveWorkspace(agentId)
      if (here === undefined) return undefined
      const hit = list.find((row) => normalizePath(row.path) === normalizePath(here.path))
      if (hit !== undefined) return hit
      const files = store.fileOf(here.path)
      return { key: files.key, hash: files.hash, slug: files.slug, path: here.path, title: here.title, doc: files.rel, count: 0, updatedAt: 0 }
    }
    const norm = normalizePath(want)
    return (
      list.find((row) => row.key === want) ??
      list.find((row) => normalizePath(row.path) === norm) ??
      list.find((row) => String(row.title ?? '') === want) ??
      list.find((row) => String(row.path ?? '').toLowerCase().includes(want.toLowerCase()))
    )
  }

  function registerTools(tools) {
    const register = (definition) => {
      try {
        ctx.effect(() => tools.register(definition), `handoff.tool.${definition.name}`)
      } catch (error) {
        log('warn', `工具 ${definition.name} 注册失败：${String(error?.message ?? error)}`)
      }
    }

    register({
      name: 'handoff',
      description:
        '读写本机的工作区交接文档（每个工作区一份，会话结束时自动写）。action=list 列出所有工作区；action=read 读某工作区的交接原文；action=append 手动补一条；action=clear 清空某工作区（要 confirm）。不填 workspace 就是当前工作区。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'read', 'append', 'clear', 'status', 'flush'], description: '要做什么（flush = 立刻把当前会话缓冲写一次，调试用）' },
          workspace: { type: 'string', description: '工作区路径 / 标题 / key；不填就是当前工作区' },
          title: { type: 'string', description: 'append 用：一句话标题' },
          did: { type: 'string', description: 'append 用：这次做了什么' },
          result: { type: 'string', enum: ['ok', 'partial', 'fail'], description: 'append 用：结果' },
          next: { type: 'string', description: 'append 用：下次接手要先做什么' },
          confirm: { type: 'boolean', description: 'clear 用：必须为 true 才真的清空' },
          limit: { type: 'integer', description: 'read 用：最多显示几条，默认 10' },
        },
        required: ['action'],
      },
      output: { schema: okSchema, render: textRender },
      execute: async (args, exec) => {
        try {
          const agentId = String(exec?.agent?.id ?? exec?.agentId ?? '')
          const action = String(args?.action ?? '')
          if (action === 'list') {
            const rows = allWorkspaces()
            if (rows.length === 0) return { ok: true, text: '还没认出任何工作区（工作区注册表还是空的）。在 DSH 里建一个工作区再来。', count: 0 }
            const text = rows
              .map((row, i) => {
                const state = row.count > 0 ? `${row.count} 条 · 最后 ${formatTime(row.updatedAt)}` : '还没有交接记录'
                const extra = row.registered === true ? ` · ${row.sessions} 个会话` : ' · 未登记在工作区列表'
                return `${i + 1}. ${row.title} · ${state}${extra}\n   ${row.path}\n   ${row.doc}`
              })
              .join('\n')
            return { ok: true, text: `共 ${rows.length} 个工作区：\n${text}`, count: rows.length }
          }

          if (action === 'status') {
            const rows = allWorkspaces()
            const withDoc = rows.filter((row) => row.count > 0).length
            const written = [...buffers.values()].reduce((sum, buf) => sum + buf.wrote, 0)
            // 缓冲区快照：排查「事件收到了但没写文档」就靠这一段
            const bufLines = [...buffers.values()].slice(0, 6).map((buf) => {
              const ws = buf.ws === undefined ? '(未定)' : buf.ws.path
              const cwd = cwdOfSession(buf.sessionId) || '(没读到)'
              const hasAgent = agentRefs.has(buf.sessionId) ? '有' : '无'
              const timer = buf.timer === undefined ? '无' : `等 ${Math.max(0, Math.round((buf.timerAt - Date.now()) / 1000))}s`
              const last = buf.lastSummaryAt > 0 ? formatTime(buf.lastSummaryAt) : '还没写过'
              const why = buf.lastError !== '' ? `错误「${buf.lastError}」` : buf.lastSkip !== '' ? `跳过「${buf.lastSkip}」` : ''
              return `· ${buf.sessionId.slice(0, 8)}：收 ${buf.entries.length} 条 / ${buf.turns} 轮 / 工作区 ${ws} / cwd ${cwd} / agent ${hasAgent} / 定时器 ${timer} / 上次 ${last} / 写 ${buf.wrote} 失败 ${buf.failed}${why === '' ? '' : ` / ${why}`}`
            })
            return {
              ok: true,
              text: [
                `数据目录：${dir}`,
                `工作区：${rows.length} 个（其中 ${withDoc} 个有交接记录）`,
                `本次运行已写：${written} 条`,
                `自动写入：${cfg.autoWrite ? '开' : '关'}　最小间隔：${Math.round(cfg.minGapMs / 1000)}s　防抖：${Math.round(cfg.debounceMs / 1000)}s`,
                `今日剩余预算：${budgetLeft() === Infinity ? '不限' : `${budgetLeft()} 次`}`,
                `服务：sessions ${typeof sessionsRef?.get === 'function' ? '就绪' : '没拿到'} / 注册表 ${typeof registryRef?.list === 'function' ? '就绪' : '没拿到'} / llm ${typeof llmRef?.stream === 'function' ? '就绪' : '没拿到'} / 账本 ${readWorkspaceFile().length} 个工作区`,
                buffers.size === 0 ? '本会话缓冲：空（还没收到消息事件）' : `缓冲中的会话（${buffers.size} 个）：`,
                ...bufLines,
              ].join('\n'),
              count: rows.length,
            }
          }

          if (action === 'flush') {
            const id = agentId !== '' ? agentId : [...buffers.keys()][0]
            if (id === undefined || id === '') return { ok: false, text: '拿不到当前会话，没法 flush。' }
            const buf = buffers.get(id)
            const before = buf === undefined ? 0 : buf.wrote
            await flush(id, 'tool')
            const after = buf === undefined ? 0 : buf.wrote
            const loaded = buf?.ws === undefined ? undefined : store.load(buf.ws.path)
            return {
              ok: after > before,
              text: [
                `会话 ${id.slice(0, 8)}：缓冲 ${buf?.entries.length ?? 0} 条 / ${buf?.turns ?? 0} 轮 / 工作区 ${buf?.ws?.path ?? '(未定)'}`,
                after > before
                  ? `写入成功，文档现在 ${loaded?.doc.entries.length ?? '?'} 条`
                  : `这次没写入${buf?.lastError !== undefined && buf?.lastError !== '' ? `：${buf.lastError}` : buf?.lastSkip !== undefined && buf?.lastSkip !== '' ? `（${buf.lastSkip}）` : '（原因不明）'}`,
              ].join('\n'),
            }
          }

          const row = findWorkspace(args?.workspace, agentId)
          if (row === undefined) {
            return { ok: false, text: '没找到这个工作区的交接文档。先用 action=list 看看有哪些，或者显式给 workspace（工作区路径 / 标题 / key）。' }
          }

          if (action === 'read') {
            const loaded = store.load(row.path)
            if (loaded.doc.entries.length === 0) return { ok: true, text: `${row.path} 还没有交接记录。`, count: 0 }
            const limit = Math.max(1, Math.min(50, Number(args?.limit ?? 10)))
            const text = loaded.doc.entries
              .slice(0, limit)
              .map((entry, i) => {
                const lines = [`${i + 1}. ${formatTime(entry?.at)} · ${String(entry?.title ?? '')}`, `   做了什么：${String(entry?.did ?? '')}`, `   结果：${resultLabel(entry?.result)}`]
                if (String(entry?.next ?? '').trim() !== '') lines.push(`   下次接手：${String(entry.next).trim()}`)
                return lines.join('\n')
              })
              .join('\n\n')
            return { ok: true, text: `工作区：${loaded.doc.title}（${row.path}）· 共 ${loaded.doc.entries.length} 条，显示 ${Math.min(limit, loaded.doc.entries.length)} 条\n文件：${loaded.md}\n\n${text}`, count: loaded.doc.entries.length }
          }

          if (action === 'append') {
            const did = String(args?.did ?? '').trim()
            const title = String(args?.title ?? '').trim()
            if (did === '' && title === '') return { ok: false, text: 'append 至少要给 title 或 did。' }
            const result = ['ok', 'partial', 'fail'].includes(String(args?.result ?? '')) ? String(args.result) : 'unknown'
            const written = store.append(row.path, {
              title: title === '' ? did.slice(0, 20) : title,
              did,
              result,
              detail: '',
              next: String(args?.next ?? '').trim(),
              at: Date.now(),
              turns: 0,
              workspace: row.path,
              source: 'tool',
            })
            injectCache.delete(normalizePath(row.path))
            return { ok: written !== undefined, text: written === undefined ? '写失败了，看日志。' : `已补一条到「${row.title}」，现在共 ${written.doc.entries.length} 条。` }
          }

          if (action === 'clear') {
            if (args?.confirm !== true) return { ok: false, text: '清空要带 confirm=true。文档里的记录会全部没掉（md/json 两个文件都会重写）。' }
            const ok = store.clear(row.path)
            injectCache.delete(normalizePath(row.path))
            return { ok, text: ok ? `已清空「${row.title}」的交接记录。` : '清空失败，看日志。' }
          }

          return { ok: false, text: `不认识的 action：${action}` }
        } catch (error) {
          return { ok: false, text: `交接操作失败：${String(error?.message ?? error)}` }
        }
      },
    })
  }

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (toolCtx) => {
        try {
          const tools = toolCtx?.tools
          if (tools === undefined || tools === null || typeof tools.register !== 'function') return
          registerTools(tools)
          log('info', '交接工具已注册：handoff')
        } catch (error) {
          log('warn', `工具注册失败：${String(error?.message ?? error)}`)
        }
      })
    }
  } catch (error) {
    log('warn', `请求 tools 依赖失败：${String(error?.message ?? error)}`)
  }

  // ------------------------------------------------------------ 面板接口 --

  function isLocal(req) {
    try {
      const remote = req?.socket?.remoteAddress ?? ''
      return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === ''
    } catch {
      return false
    }
  }

  function sendJson(res, value, status = 200) {
    try {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(value))
    } catch {
      // 连接已经断了
    }
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = []
      req.on('data', (chunk) => {
        chunks.push(chunk)
        if (chunks.length > 64) {
          resolve('')
          try {
            req.destroy()
          } catch {
            // 已经关了
          }
        }
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })
  }

  function registerPanelRoutes(webServer) {
    const route = (routePath, handler, label) => {
      try {
        ctx.effect(() => webServer.register({ kind: 'exact', path: routePath, handler }), `handoff.route.${label}`)
      } catch (error) {
        log('warn', `面板路由 ${routePath} 注册失败：${String(error?.message ?? error)}`)
      }
    }

    route(
      '/handoff/list.json',
      (req, res) => {
        if (!isLocal(req)) return sendJson(res, { ok: false, reason: 'local only' }, 403)
        try {
          sendJson(res, {
            ok: true,
            dir,
            workspaces: allWorkspaces(),
            stats: {
              written: [...buffers.values()].reduce((sum, buf) => sum + buf.wrote, 0),
              budgetLeft: budgetLeft() === Infinity ? -1 : budgetLeft(),
              sessionsBuffered: buffers.size,
            },
          })
        } catch (error) {
          sendJson(res, { ok: false, reason: String(error?.message ?? error) })
        }
      },
      'list',
    )

    route(
      '/handoff/doc.json',
      (req, res) => {
        if (!isLocal(req)) return sendJson(res, { ok: false, reason: 'local only' }, 403)
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const key = url.searchParams.get('key') ?? ''
          const list = allWorkspaces()
          const row = list.find((item) => item.key === key) ?? list[0]
          if (row === undefined) return sendJson(res, { ok: true, workspace: undefined, doc: { entries: [] } })
          // 没记录的工作区也要能打开：store.load 只读，不会顺手建文件
          const loaded = store.load(row.path)
          sendJson(res, { ok: true, workspace: row, doc: loaded.doc, md: loaded.md, entries: loaded.doc.entries })
        } catch (error) {
          sendJson(res, { ok: false, reason: String(error?.message ?? error) })
        }
      },
      'doc',
    )

    route(
      '/handoff/act',
      async (req, res) => {
        if (!isLocal(req)) return sendJson(res, { ok: false, reason: 'local only' }, 403)
        try {
          if (req.method !== 'POST') return sendJson(res, { ok: false, reason: 'POST only' }, 405)
          const raw = await readBody(req)
          let body
          try {
            body = JSON.parse(raw)
          } catch {
            return sendJson(res, { ok: false, reason: '请求体不是 JSON' }, 400)
          }
          const action = String(body?.action ?? '')
          const row = allWorkspaces().find((item) => item.key === String(body?.key ?? ''))
          if (row === undefined) return sendJson(res, { ok: false, reason: '没有这个工作区' })
          if (action === 'clear') {
            const ok = store.clear(row.path)
            injectCache.delete(normalizePath(row.path))
            return sendJson(res, { ok, text: ok ? `已清空「${row.title}」` : '清空失败' })
          }
          if (action === 'append') {
            const written = store.append(row.path, {
              title: String(body?.title ?? '').slice(0, 60),
              did: String(body?.did ?? '').slice(0, 400),
              result: ['ok', 'partial', 'fail'].includes(String(body?.result ?? '')) ? String(body.result) : 'unknown',
              detail: '',
              next: String(body?.next ?? '').slice(0, 200),
              at: Date.now(),
              turns: 0,
              workspace: row.path,
              source: 'panel',
            })
            injectCache.delete(normalizePath(row.path))
            return sendJson(res, { ok: written !== undefined })
          }
          return sendJson(res, { ok: false, reason: '未知动作' }, 400)
        } catch (error) {
          sendJson(res, { ok: false, reason: String(error?.message ?? error) })
        }
      },
      'act',
    )
  }

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => {
        try {
          const server = webCtx?.webServer
          if (server === undefined || server === null || typeof server.register !== 'function') return
          registerPanelRoutes(server)
          log('info', '面板接口就绪：/handoff/{list,doc,act}')
        } catch (error) {
          log('warn', `面板接口挂载失败：${String(error?.message ?? error)}`)
        }
      })
    }
  } catch (error) {
    log('warn', `请求 webServer 依赖失败：${String(error?.message ?? error)}`)
  }

  // ---------------------------------------------------------------- 收尾 --

  ctx.effect(() => () => {
    for (const buf of buffers.values()) {
      if (buf.timer !== undefined) {
        try {
          clearTimeout(buf.timer)
        } catch {
          // 已经清掉了
        }
        buf.timer = undefined
      }
      // 插件卸载前把没写的写掉（尽力而为，不等待）
      if (cfg.autoWrite === true && buf.entries.length > 0 && buf.inFlight !== true) void flush(buf.sessionId, 'unload')
    }
  }, 'handoff.dispose')

  const known = safeRead(() => allWorkspaces()) ?? []
  const knownDocs = known.filter((row) => row.count > 0).length
  log(
    'info',
    `已启用：数据目录 ${dir} · 工作区 ${known.length} 个（${knownDocs} 个有交接）· 自动写入${cfg.autoWrite ? '开' : '关'} · 新会话读回最近 ${cfg.injectEntries} 条`,
  )
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function writeAtomic(file, text) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

export { name, inject, DEFAULTS, resolveConfig }
export default { name, inject, apply, DEFAULTS }

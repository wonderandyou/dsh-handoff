/**
 * _selftest.mjs —— 不启动 DSH 也能验的整条链路
 * ============================================================================
 * 用假 ctx 把真实插件跑一遍：事件进来 → 总结 → 写文档 → 新会话注入 → 工具/面板读回。
 * 全程不联网、不调真模型（llm 用假 stream），失败以非零退出码收场。
 *
 * 跑法：node _selftest.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, resolveConfig } from './lib/index.js'
import { buildTranscript, fallbackEntry, parseEntry } from './lib/summarize.js'
import { createDocStore, normalizePath, pathHash } from './lib/store.js'

let failed = 0
let passed = 0
function ok(condition, label, extra = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${extra === '' ? '' : ` — ${extra}`}`)
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`)
}

const tmpRoot = path.join(os.tmpdir(), `dsh-handoff-selftest-${Date.now()}`)
fs.mkdirSync(tmpRoot, { recursive: true })
process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // 临时目录删不掉无所谓
  }
})

// ---------------------------------------------------------------------------
// 假 ctx
// ---------------------------------------------------------------------------

function makeFakeCtx({ workspaces = [], modelReply } = {}) {
  const listeners = new Map()
  const cleanups = []
  const reg = { contexts: [], tools: [], routes: [], sections: [] }
  const sessions = new Map()

  const ctx = {
    logger: {
      info: (m) => console.log(`    [info] ${m}`),
      warn: (m) => console.log(`    [warn] ${m}`),
      error: (m) => console.log(`    [error] ${m}`),
      debug: () => {},
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
      return () => listeners.set(type, listeners.get(type).filter((item) => item !== fn))
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {}
    },
    inject(deps, cb) {
      cb(ctx)
      return () => {}
    },
    get(name) {
      if (name === 'agents') return { list: () => [] }
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      if (name === 'tools') return ctx.tools
      if (name === 'webServer') return ctx.webServer
      if (name === 'workspaceRegistry') return ctx.workspaceRegistry
      if (name === 'llm') return ctx.llm
      return undefined
    },
    systemPrompt: {
      context(def) {
        reg.contexts.push(def)
        return () => {}
      },
      section(def) {
        reg.sections.push(def)
        return () => {}
      },
      getContextOrder: () => 300,
    },
    tools: {
      register(def) {
        reg.tools.push(def)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        reg.routes.push(route)
        return () => {}
      },
    },
    workspaceRegistry: {
      list: () => workspaces,
    },
    sessions: { get: (id) => sessions.get(id) },
    llm: {
      listProviders: () => [{ id: 'deepseek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      stream: () => fakeStream(modelReply),
    },
  }

  return {
    ctx,
    reg,
    sessions,
    emit(type, a, b) {
      const list = listeners.get(type) ?? []
      for (const fn of list) fn(a, b)
    },
  }
}

async function* fakeStream(reply) {
  const text = typeof reply === 'function' ? reply() : reply
  yield { type: 'text-delta', text }
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 30 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function fakeSession(id, cwd) {
  return { id, header: { cwd } }
}

function fakeWorkspace(id, wsPath, title, sessionIds) {
  return { id, path: wsPath, title, sessionIds }
}

// ---------------------------------------------------------------------------
section('store：同一会话只占一条 + 渲染')
// ---------------------------------------------------------------------------

const storeDir = path.join(tmpRoot, 'store')
const logs = []
const store = createDocStore({ dir: storeDir, log: (level, message) => logs.push(`${level}:${message}`), maxEntries: 5 })
const wsA = path.join(tmpRoot, 'workspace-a')
fs.mkdirSync(wsA, { recursive: true })

ok(normalizePath('D:\\插件\\') === 'd:/插件', '路径归一：斜杠统一 + 盘符小写', normalizePath('D:\\插件\\'))
ok(pathHash('D:\\插件') === pathHash('d:/插件/'), '同一个目录不同写法 → 同一个哈希')

store.upsert(wsA, { sessionId: 's1', at: Date.now(), title: '第一版', did: '建了骨架', result: 'ok', next: '' }, { title: '工作区A' })
store.upsert(wsA, { sessionId: 's2', at: Date.now(), title: '第二版', did: '加了个工具', result: 'partial', next: '补测试' }, { title: '工作区A' })
let loaded = store.load(wsA)
ok(loaded.doc.entries.length === 2, '两条不同会话 → 两条记录', String(loaded.doc.entries.length))

store.upsert(wsA, { sessionId: 's1', at: Date.now(), title: '第一版（更新）', did: '建了骨架并跑通', result: 'ok', next: '' }, { title: '工作区A' })
loaded = store.load(wsA)
ok(loaded.doc.entries.length === 2, '同一个会话再写 → 更新不是追加', String(loaded.doc.entries.length))
ok(loaded.doc.entries[0].title === '第一版（更新）', '更新后移到最前面（最新在上）', loaded.doc.entries[0].title)
ok(fs.existsSync(loaded.md), 'md 文件已生成', loaded.md)
const md = fs.readFileSync(loaded.md, 'utf8')
ok(md.includes('# 工作区交接 · 工作区A'), 'md 标题带工作区名')
ok(!md.includes('undefined'), 'md 里不许出现 undefined（路径/标题踩过这个坑）')
ok(loaded.doc.path === wsA, '文档里存的路径是对的（不是 undefined）', loaded.doc.path)
ok(md.includes('做了什么：建了骨架并跑通'), 'md 里有「做了什么」')
ok(md.includes('结果：部分完成'), '结果被翻成中文')
ok(md.includes('下次接手：补测试'), 'md 里有「下次接手」')

for (let i = 0; i < 8; i += 1) {
  store.upsert(wsA, { sessionId: `bulk-${i}`, at: Date.now(), title: `批量 ${i}`, did: 'x', result: 'ok' }, { title: '工作区A' })
}
ok(store.load(wsA).doc.entries.length === 5, '超过上限自动截断（maxEntries=5）', String(store.load(wsA).doc.entries.length))

ok(store.list().length === 1, 'list() 能列出这一个工作区', String(store.list().length))
ok(store.clear(wsA) === true, 'clear() 返回成功')
ok(store.load(wsA).doc.entries.length === 0, 'clear() 后确实没有了')

// ---------------------------------------------------------------------------
section('summarize：草稿拼接 / 解析 / 兜底')
// ---------------------------------------------------------------------------

const longEntries = []
for (let i = 0; i < 30; i += 1) {
  longEntries.push({ role: i % 2 === 0 ? 'user' : 'assistant', text: `第 ${i} 条消息 ${'啊'.repeat(20)}` })
}
const transcript = buildTranscript(longEntries, { headChars: 300, tailChars: 300 })
ok(transcript.includes('第 0 条消息'), '长会话草稿保留了开头意图')
ok(transcript.includes('第 29 条消息'), '长会话草稿保留了结尾进展')
ok(transcript.includes('中间省略'), '中间过程被省略（省 token）')

ok(parseEntry('```json\n{"title":"做插件","did":"写了 store.js","result":"ok","next":""}\n```')?.title === '做插件', '能解析被 markdown 包住的 JSON')
ok(parseEntry('废话 {"title":"x","did":"y","result":"ok"} 废话')?.did === 'y', '能从前后的废话里抠出 JSON')
ok(parseEntry('完全不是 JSON') === null, '解析不了就返回 null（不写脏数据）')
const fb = fallbackEntry(
  [
    { role: 'user', text: '帮我做个交接插件' },
    { role: 'assistant', text: '写完了，测试也过了' },
  ],
  { result: 'ok' },
)
ok(fb !== undefined && fb.did.includes('交接插件'), '规则兜底会带上最初的需求', fb?.did)
ok(fb?.source === 'fallback', '兜底条目标了 source=fallback')

// ---------------------------------------------------------------------------
section('apply：整条链路（事件 → 总结 → 落盘 → 新会话注入）')
// ---------------------------------------------------------------------------

const homeDir = path.join(tmpRoot, 'home')
const wsB = path.join(tmpRoot, 'workspace-b')
fs.mkdirSync(wsB, { recursive: true })
const wsEntityB = fakeWorkspace('ws-b', wsB, '插件', [])

// 假的工作区账本（照真实结构写：global.workspaceIds + tables.workspaces）
const wsLedger = path.join(tmpRoot, 'workspace.json')
const wsC = path.join(tmpRoot, 'workspace-c')
fs.mkdirSync(wsC, { recursive: true })
fs.writeFileSync(
  wsLedger,
  JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['w1', 'w2'] },
    tables: { workspaces: { w1: { path: wsB, title: '插件', sessionIds: ['session-sess-1'] }, w2: { path: wsC, title: '软件', sessionIds: [] } } },
  }),
  'utf8',
)

const modelText = '{"title":"给 DSH 做交接插件","did":"写了 store/summarize/index 三个模块并跑通自测","result":"ok","detail":"自测全绿","next":"重启 DSH 验证真实注入"}'
let modelCalls = 0
const harness = makeFakeCtx({
  workspaces: [wsEntityB],
  modelReply: () => {
    modelCalls += 1
    return modelText
  },
})
apply(harness.ctx, {
  dir: homeDir,
  workspaceFile: wsLedger,
  debounceMs: 1000,
  minGapMs: 0,
  injectEntries: 3,
  injectChars: 1200,
})

ok(harness.reg.contexts.length === 0, '还没有会话 → 一个注入都没挂')
ok(harness.reg.tools.length === 1 && harness.reg.tools[0].name === 'handoff', 'handoff 工具已注册', String(harness.reg.tools.length))
ok(harness.reg.routes.length === 3, '面板 3 个路由已注册', String(harness.reg.routes.length))

// 1) 新会话开起来
const agentA = { id: 'sess-1', ctx: harness.ctx }
harness.sessions.set('sess-1', fakeSession('sess-1', wsB))
harness.emit('agent/created', { agent: agentA })
ok(harness.reg.contexts.length === 1, 'agent/created → 挂了一个交接注入', String(harness.reg.contexts.length))
ok(harness.reg.contexts[0].name === 'handoff:workspace', '注入段名为 handoff:workspace')
ok(harness.reg.contexts[0].interpolate === false, '注入段关掉了变量插值（路径里带 {{}} 也不会炸）')

// 2) 聊了两轮
const sessionA = fakeSession('sess-1', wsB)
harness.emit('session/event', sessionA, { type: 'user/message', data: { content: [{ type: 'text', text: '帮我做个工作区交接插件' }] } })
harness.emit('session/event', sessionA, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好，先摸清 DSH 的 hook。' }] } } })
harness.emit('session/event', sessionA, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
harness.emit('session/event', sessionA, { type: 'user/message', data: { content: [{ type: 'text', text: '继续' }] } })
harness.emit('session/event', sessionA, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '三个模块写完了，自测全绿。' }] } } })
harness.emit('session/event', sessionA, { type: 'turn/end', data: { reason: { kind: 'stop' } } })

// 3) 等防抖 → 落盘
await new Promise((resolve) => setTimeout(resolve, 1600))
const storeC = createDocStore({ dir: homeDir, log: () => {}, maxEntries: 40 })
const docB = storeC.load(wsB).doc
ok(modelCalls >= 1, '总结真的调了一次模型', String(modelCalls))
ok(docB.entries.length === 1, '一个会话 → 交接文档里一条记录', String(docB.entries.length))
ok(docB.entries[0]?.title === '给 DSH 做交接插件', '写进去的是模型给的标题', docB.entries[0]?.title)
ok(docB.entries[0]?.sessionId === 'sess-1', '记录带着会话 id')
ok(docB.entries[0]?.turns === 2, '记录带着轮数', String(docB.entries[0]?.turns))
ok(docB.title === '插件', '文档标题用了工作区名字', docB.title)

// 4) 新会话打开 → 自动读回
const agentB = { id: 'sess-2', ctx: harness.ctx }
harness.sessions.set('sess-2', fakeSession('sess-2', wsB))
harness.emit('agent/created', { agent: agentB })
const injectDef = harness.reg.contexts[harness.reg.contexts.length - 1]
let injected = ''
try {
  injected = injectDef.text()
} catch (error) {
  injected = `抛错：${error.message}`
}
ok(injected.includes('本工作区交接'), '新会话的注入文本里有交接段落')
ok(injected.includes('给 DSH 做交接插件'), '新会话读到了上一个会话的标题')
ok(injected.includes('下一次') || injected.includes('下次接手'), '新会话能看见「下次接手」')
ok(injected.includes('工作区：插件'), '注入文本标明是哪个工作区', injected.split('\n')[2])

// 5) 同一个会话续聊：不该看到自己那条（否则会把自己上一轮写的东西又当交接读回来）
const selfSessionInject = harness.reg.contexts[0]
ok(docB.entries[0]?.sessionId === 'sess-1', '当前会话是 sess-1（自检前提）')
ok(selfSessionInject.text() === '', '同一个会话续聊时不会把自己那条注入回去', selfSessionInject.text().slice(0, 60))

// 6) 另一个工作区互不串（wsC 已在上面建好并登记进账本）
harness.sessions.set('sess-3', fakeSession('sess-3', wsC))
const agentC = { id: 'sess-3', ctx: harness.ctx }
harness.emit('agent/created', { agent: agentC })
const defC = harness.reg.contexts[harness.reg.contexts.length - 1]
ok(defC.text() === '', '别的工作区没记录 → 注入空字符串（不硬塞内容）')

// 7) agent/disposed → 立刻落盘
harness.emit('session/event', harness.sessions.get('sess-3'), { type: 'user/message', data: { content: [{ type: 'text', text: '这个工作区聊一句' }] } })
harness.emit('session/event', harness.sessions.get('sess-3'), { type: 'turn/end', data: { reason: { kind: 'stop' } } })
harness.emit('agent/disposed', { agent: agentC })
await new Promise((resolve) => setTimeout(resolve, 300))
const docC = storeC.load(wsC).doc
ok(docC.entries.length === 1, '会话销毁时立刻写了一条（不用等防抖）', String(docC.entries.length))

// ---------------------------------------------------------------------------
section('工具 handoff')
// ---------------------------------------------------------------------------

const tool = harness.reg.tools[0]
const execFor = (id) => ({ agent: { id } })

let out = await tool.execute({ action: 'list' }, execFor('sess-1'))
ok(out.ok === true && out.count === 2, 'list 列出 2 个工作区', JSON.stringify(out.count))
ok(out.text.includes('插件'), 'list 结果里有工作区名')

out = await tool.execute({ action: 'read' }, execFor('sess-1'))
ok(out.ok === true && out.text.includes('写了 store/summarize/index'), 'read 不填 workspace 时读的是当前会话的工作区')
ok(out.text.includes(wsB), 'read 结果带工作区路径')

out = await tool.execute({ action: 'append', title: '手动补一条', did: '手动写的', result: 'partial' }, execFor('sess-1'))
ok(out.ok === true, 'append 成功')
out = await tool.execute({ action: 'read', limit: 5 }, execFor('sess-1'))
ok(out.text.includes('手动补一条'), 'append 的那条读得回来')

out = await tool.execute({ action: 'clear' }, execFor('sess-1'))
ok(out.ok === false, 'clear 不带 confirm 会拒绝')
out = await tool.execute({ action: 'clear', confirm: true }, execFor('sess-1'))
ok(out.ok === true, 'clear 带 confirm 才真的清')
out = await tool.execute({ action: 'read' }, execFor('sess-1'))
ok(out.text.includes('还没有交接记录'), 'clear 之后读不到了')

out = await tool.execute({ action: 'status' }, execFor('sess-1'))
ok(out.text.includes('数据目录'), 'status 能报数据目录')
out = await tool.execute({ action: 'nope' }, execFor('sess-1'))
ok(out.ok === false, '未知 action 会被拒')

// ---------------------------------------------------------------------------
section('面板接口')
// ---------------------------------------------------------------------------

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      res.headers[k] = v
    },
    end(body) {
      res.body = String(body ?? '')
    },
  }
  return res
}
const localReq = (url = '/', method = 'GET') => ({ url, method, socket: { remoteAddress: '127.0.0.1' }, on() {}, destroy() {} })
const remoteReq = (url = '/') => ({ url, method: 'GET', socket: { remoteAddress: '8.8.8.8' }, on() {}, destroy() {} })

const routeList = harness.reg.routes.find((item) => item.path === '/handoff/list.json')
const routeDoc = harness.reg.routes.find((item) => item.path === '/handoff/doc.json')
ok(routeList !== undefined && routeDoc !== undefined, 'list/doc 路由都在')

let res = fakeRes()
routeList.handler(localReq('/handoff/list.json'), res)
let payload = JSON.parse(res.body)
ok(payload.ok === true, 'list.json 返回 ok')
ok(Array.isArray(payload.workspaces), 'list.json 带 workspaces 数组')
ok(
  payload.workspaces.some((row) => String(row.path) === wsB),
  '登记过但还没有记录的工作区也会列出来（主人要的「按工作区分开」）',
  JSON.stringify(payload.workspaces.map((row) => row.path)),
)

res = fakeRes()
routeList.handler(remoteReq('/handoff/list.json'), res)
ok(res.statusCode === 403, '非本机请求被拒（403）', String(res.statusCode))

res = fakeRes()
routeDoc.handler(localReq('/handoff/doc.json'), res)
payload = JSON.parse(res.body)
ok(payload.ok === true && payload.doc !== undefined, 'doc.json 能返回文档')

// ---------------------------------------------------------------------------
section('边界情况')
// ---------------------------------------------------------------------------

// 1) 没有 cwd 的会话 → 不该崩
const agentD = { id: 'sess-4', ctx: harness.ctx }
harness.emit('agent/created', { agent: agentD })
const defD = harness.reg.contexts[harness.reg.contexts.length - 1]
ok(defD.text() === '', '没 cwd / 没登记工作区时注入空字符串，不抛错')

// 2) 模型返回垃圾 → 回退规则摘要，不写脏数据
const badHarness = makeFakeCtx({ workspaces: [wsEntityB], modelReply: () => '我不是 JSON' })
const wsE = path.join(tmpRoot, 'workspace-e')
fs.mkdirSync(wsE, { recursive: true })
apply(badHarness.ctx, {
  dir: path.join(tmpRoot, 'home2'),
  workspaceFile: path.join(tmpRoot, 'no-such-ledger.json'),
  debounceMs: 1000,
  minGapMs: 0,
  maxPerDay: 0,
})
const sessionE = fakeSession('sess-e', wsE)
badHarness.sessions.set('sess-e', sessionE)
badHarness.emit('session/event', sessionE, { type: 'user/message', data: { content: [{ type: 'text', text: '跑个长任务' }] } })
badHarness.emit('session/event', sessionE, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '做完了' }] } } })
badHarness.emit('session/event', sessionE, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
await new Promise((resolve) => setTimeout(resolve, 1600))
const storeE = createDocStore({ dir: path.join(tmpRoot, 'home2'), log: () => {}, maxEntries: 40 })
const docE = storeE.load(wsE).doc
ok(docE.entries.length === 1, '模型返回垃圾也会用规则摘要写一条', String(docE.entries.length))
ok(docE.entries[0]?.source === 'fallback', '这条标了 fallback 来源', String(docE.entries[0]?.source))

// 3) 开关关掉 → 什么都不挂
const offHarness = makeFakeCtx({ workspaces: [wsEntityB] })
apply(offHarness.ctx, { enabled: false, dir: path.join(tmpRoot, 'home3') })
ok(offHarness.reg.contexts.length === 0 && offHarness.reg.tools.length === 0, 'enabled=false 时完全不挂东西')
ok(!fs.existsSync(path.join(tmpRoot, 'home3')), 'enabled=false 时连目录都不建')

// 4) 配置钳制
const cfg = resolveConfig({ injectEntries: 999, debounceMs: 1, minGapMs: -5, maxEntries: 0 })
ok(cfg.injectEntries === 12, 'injectEntries 被钳到 12', String(cfg.injectEntries))
ok(cfg.debounceMs === 1000, 'debounceMs 最少 1 秒', String(cfg.debounceMs))
ok(cfg.minGapMs === 0, 'minGapMs 不会变负数', String(cfg.minGapMs))
ok(cfg.maxEntries === 1, 'maxEntries 最少 1', String(cfg.maxEntries))

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '全部通过' : '有失败'}：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)

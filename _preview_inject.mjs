/**
 * _preview_inject.mjs —— 用**真实**的交接数据预演「新会话开头会看到什么」
 * ============================================================================
 * 不启动 DSH、不联网、不改任何文档：挂一个假 ctx，把 apply() 跑起来，
 * 触发一次 agent/created，然后把注入文本打出来（长度 / 条目数 / 前几十行）。
 *
 * 跑法：
 *   node _preview_inject.mjs                # 预览当前目录
 *   node _preview_inject.mjs D:\软件        # 预览指定工作区
 */

import os from 'node:os'
import path from 'node:path'
import { apply } from './lib/index.js'

const targetPath = process.argv[2] ?? process.cwd()
const HANDOFF_DIR = path.join(os.homedir(), '.dsh', 'handoff')
const WS_FILE = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')

const contexts = []
const listeners = new Map()

const fakeCtx = {
  logger: { info: () => {}, warn: (m) => console.log(`  [warn] ${m}`), error: () => {}, debug: () => {} },
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, [])
    listeners.get(type).push(fn)
    return () => {}
  },
  effect(fn) {
    const cleanup = fn()
    return () => {
      if (typeof cleanup === 'function') cleanup()
    }
  },
  inject(_deps, cb) {
    cb(fakeCtx)
    return () => {}
  },
  get: (name) => fakeCtx[name === 'agents' ? 'agents' : name],
  systemPrompt: {
    context(def) {
      contexts.push(def)
      return () => {}
    },
  },
  tools: { register: () => () => {} },
  webServer: { register: () => () => {} },
  // 关键：给一个「这个会话跑在 targetPath」的 sessions 服务，好让插件认出工作区
  sessions: { get: () => ({ header: { cwd: targetPath } }) },
  workspaceRegistry: undefined,
  llm: undefined,
  agents: { list: () => [] },
}

apply(fakeCtx, { dir: HANDOFF_DIR, workspaceFile: WS_FILE })

const sessionId = `session-preview-${Date.now()}`
const agent = { id: sessionId, ctx: fakeCtx }
for (const fn of listeners.get('agent/created') ?? []) fn({ agent })

if (contexts.length === 0) {
  console.log('[FAIL] 没有注册到注入段')
  process.exit(1)
}

const def = contexts[contexts.length - 1]
const text = def.text()
const second = def.text()

console.log(`\n目标工作区：${targetPath}`)
console.log(`注入段名称：${def.name}　排序：${def.order}　插值：${String(def.interpolate)}`)
console.log(`第一次取文本：${text.length} 字符 ≈ ${Math.round(text.length / 3.2)} token，列出 ${(text.match(/^### /gm) ?? []).length} 条`)
console.log(`第二次取文本：${second.length} 字符（injectOnce = 只给一次，所以应为 0）`)

if (text === '') {
  console.log('\n[注] 这个工作区还没有交接记录，或没认出来 → 真实运行时也是空注入。')
  process.exit(0)
}

console.log('\n================ 注入文本全文 ================')
console.log(text)

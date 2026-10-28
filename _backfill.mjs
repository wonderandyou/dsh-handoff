/**
 * _backfill.mjs —— 把各工作区**已有的历史会话**整理成交接条目写进去
 * ============================================================================
 * 为什么单独写一个脚本：插件里加工具要重启 DSH 才生效，而 store.js 是纯 fs 模块，
 * 可以脱离 DSH 运行时直接调用 —— 这样「先让各工作区有内容」不用再打扰主人重启。
 *
 * 数据来源（都只读）：
 *   ~/.dsh/storages/session_projcache/sessions/<id>.json   会话的标题 / 首条需求 / cwd
 *   ~/.dsh/storages/workspace.json                          工作区 id → 标题（可选）
 *
 * 写出去：~/.dsh/handoff/workspaces/<工作区>-<hash>.{json,md}
 *
 * 跑法：
 *   node _backfill.mjs --dry              先看会写什么，不落盘
 *   node _backfill.mjs                    真的写（每个工作区最近 4 个会话）
 *   node _backfill.mjs --per=8            每个工作区多回填几个
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDocStore, formatTime, normalizePath, slugOf } from './lib/store.js'

const HOME = os.homedir()
const CACHE_DIR = path.join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions')
const WORKSPACE_FILE = path.join(HOME, '.dsh', 'storages', 'workspace.json')
const DOC_DIR = path.join(HOME, '.dsh', 'handoff')

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
/** 默认只回填 DSH 工作区列表里登记过的目录，免得 Downloads / 桌面某个子文件夹也冒出来。 */
const includeUnregistered = argv.includes('--all')
const perArg = argv.find((item) => item.startsWith('--per='))
const perWs = Math.max(1, Math.min(20, Number(perArg?.split('=')[1] ?? 4) || 4))
/** 最近多少分钟内还在动的会话视为「正在进行」，不回填（让插件自己去写）。 */
const SKIP_FRESH_MS = 10 * 60 * 1000

const store = createDocStore({ dir: DOC_DIR, log: (level, msg) => console.log(`[${level}] ${msg}`), maxEntries: 40 })

// ---------------------------------------------------------------------------
// 工作区账本（拿中文标题）
// ---------------------------------------------------------------------------

function readLedger() {
  const map = new Map()
  try {
    const data = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8'))
    const table = data?.tables?.workspaces ?? {}
    for (const [id, rec] of Object.entries(table)) {
      const wsPath = typeof rec?.path === 'string' ? rec.path : ''
      if (wsPath === '') continue
      map.set(normalizePath(wsPath), { id, title: String(rec?.title ?? ''), path: wsPath })
    }
  } catch (error) {
    console.log(`[warn] 读工作区账本失败：${error?.message ?? error}`)
  }
  return map
}

// ---------------------------------------------------------------------------
// 会话投影：标题 / 首条需求
// ---------------------------------------------------------------------------

/** 投影里的字符串字段有两种形态：直接字符串，或 { ver, seq, val }。 */
function textOf(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.val === 'string') return value.val
  return ''
}

function firstPromptOf(record) {
  const raw = record?.rows?.titleInput
  const text = textOf(raw?.val?.first) || (typeof raw?.val?.first?.text === 'string' ? raw.val.first.text : '')
  return text.replace(/\s+/g, ' ').trim()
}

function scanSessions() {
  let names = []
  try {
    names = fs.readdirSync(CACHE_DIR).filter((name) => name.endsWith('.json'))
  } catch (error) {
    console.log(`[warn] 读会话缓存目录失败：${error?.message ?? error}`)
    return []
  }
  const rows = []
  for (const name of names) {
    const file = path.join(CACHE_DIR, name)
    try {
      const stat = fs.statSync(file)
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const record = raw?.record
      const cwd = record?.identity?.cwd
      if (typeof cwd !== 'string' || cwd === '') continue
      rows.push({
        sessionId: name.replace(/\.json$/, ''),
        cwd,
        title: textOf(record?.rows?.title).trim(),
        prompt: firstPromptOf(record).slice(0, 160),
        at: stat.mtimeMs,
      })
    } catch {
      // 单个会话坏了跳过
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const ledger = readLedger()
const sessions = scanSessions()
const now = Date.now()

const groups = new Map()
for (const row of sessions) {
  const key = normalizePath(row.cwd)
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(row)
}

const plan = []
for (const [key, list] of groups) {
  const registered = ledger.get(key)
  if (registered === undefined && includeUnregistered !== true) continue
  const ws = registered ?? { id: `cwd:${key}`, title: slugOf(list[0].cwd), path: list[0].cwd }
  const recent = [...list].sort((a, b) => b.at - a.at)
  const picked = []
  for (const row of recent) {
    if (picked.length >= perWs) break
    // 正在进行的会话留给插件自己写，别抢
    if (now - row.at < SKIP_FRESH_MS) continue
    // 没标题也没首条需求的空会话跳过
    if (row.title === '' && row.prompt === '') continue
    picked.push(row)
  }
  if (picked.length === 0) continue
  plan.push({ ws, picked })
}

plan.sort((a, b) => b.picked[0].at - a.picked[0].at)

console.log(`\n扫描到 ${sessions.length} 个会话，分布在 ${groups.size} 个工作区；计划回填 ${plan.length} 个工作区、每区最多 ${perWs} 条\n`)

let written = 0
for (const { ws, picked } of plan) {
  console.log(`■ ${ws.title}（${ws.path}）`)
  for (const row of picked) {
    const entry = {
      sessionId: row.sessionId,
      at: row.at,
      title: (row.title || row.prompt || '未命名会话').slice(0, 60),
      did: row.prompt === '' ? '（历史会话补录：只知道标题）' : `（历史会话补录）开场需求：${row.prompt}`,
      result: 'unknown',
      detail: '历史会话，结果未记录',
      next: '',
      turns: 0,
      workspace: ws.path,
      source: 'backfill',
    }
    console.log(`   ${formatTime(entry.at)}  ${entry.title}`)
    if (!dry) {
      const result = store.upsert(ws.path, entry, { title: ws.title || slugOf(ws.path) })
      if (result !== undefined) written += 1
    }
  }
}

if (dry) {
  console.log('\n（--dry：什么都没写）')
} else {
  console.log(`\n完成：写入/更新 ${written} 条。文档在 ${path.join(DOC_DIR, 'workspaces')}`)
  console.log(`现在有交接记录的工作区：${store.list().filter((row) => row.count > 0).length} / ${store.list().length}`)
}

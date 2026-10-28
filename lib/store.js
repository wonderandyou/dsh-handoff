/**
 * store.js —— 每个工作区一份交接文档
 * ============================================================================
 * 一个工作区 = 一个目录。文档按「规范路径」认，不按工作区 id 认 ——
 * 工作区被删了再加回来、或者干脆没登记过（--profile 直接开一个目录），
 * 路径还是那个路径，交接文档就该还在。
 *
 * 落盘结构（~/.dsh/handoff/）：
 *   workspaces/<slug>-<hash8>.json   真相源（条目数组）
 *   workspaces/<slug>-<hash8>.md     渲染给人看的版本
 *   index.json                       一份索引，方便面板列出来
 *
 * 约定：
 *   · 写之前先写 .tmp 再 rename —— 进程被 kill 不会留半截文件；
 *   · 读坏了不抛，回落空文档并记一条日志，绝不让插件因为数据文件挂掉；
 *   · json 是真相源，md 永远是它的渲染结果（不许手改 md 后指望 json 跟着变）。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 确保目录存在。失败直接抛（调用方兜）。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 路径归一：斜杠统一、盘符小写、去尾部斜杠。用来比较「是不是同一个目录」。 */
export function normalizePath(input) {
  if (typeof input !== 'string') return ''
  let p = input.trim()
  if (p === '') return ''
  p = p.replace(/[\\/]+/g, '/')
  if (/^[a-zA-Z]:\//.test(p)) p = p[0].toLowerCase() + p.slice(1)
  if (p.length > 3 && p.endsWith('/')) p = p.replace(/\/+$/, '')
  return p
}

/** 稳定短哈希（同一路径永远同一个值）。 */
export function pathHash(input) {
  const norm = normalizePath(input)
  return crypto.createHash('sha1').update(norm, 'utf8').digest('hex').slice(0, 8)
}

/** 目录名 → 可用作文件名的短标题。根盘符（D:\）会给 D-。 */
export function slugOf(input) {
  const norm = normalizePath(input)
  if (norm === '') return 'workspace'
  let base = norm
  const parts = norm.split('/').filter((item) => item !== '')
  base = parts.length === 0 ? norm : parts[parts.length - 1]
  if (/^[a-z]:$/i.test(base)) base = `${base[0]}-`
  base = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  if (base === '' || base === '.' || base === '..') base = 'workspace'
  return base.slice(0, 30)
}

/** 原子写文本。 */
export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/** 读 JSON，坏了一律回落。 */
export function readJsonSafe(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    if (raw.trim() === '') return { ok: true, value: fallback }
    return { ok: true, value: JSON.parse(raw) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, value: fallback }
    return { ok: false, value: fallback, reason: String(error?.message ?? error) }
  }
}

const EMPTY_DOC = Object.freeze({ version: 1, path: '', title: '', entries: [] })

/**
 * 交接文档仓库。所有方法都同步、不抛错（失败返回 undefined / 空数组）。
 */
export function createDocStore({ dir, log, maxEntries = 40 }) {
  const docsDir = path.join(dir, 'workspaces')
  const indexFile = path.join(dir, 'index.json')
  try {
    ensureDir(docsDir)
  } catch (error) {
    log('warn', `交接目录建不出来：${String(error?.message ?? error)}`)
  }

  function fileOf(wsPath) {
    const hash = pathHash(wsPath)
    const slug = slugOf(wsPath)
    return {
      hash,
      slug,
      key: `${slug}-${hash}`,
      json: path.join(docsDir, `${slug}-${hash}.json`),
      md: path.join(docsDir, `${slug}-${hash}.md`),
      rel: path.join('workspaces', `${slug}-${hash}.md`),
    }
  }

  /** 读一份文档（不存在就是空文档）。 */
  function load(wsPath) {
    const files = fileOf(wsPath)
    const got = readJsonSafe(files.json, null)
    if (got.ok === false) log('warn', `交接文档读不出来（${files.key}）：${got.reason}`)
    const raw = got.value
    const doc = {
      version: 1,
      path: String(raw?.path ?? wsPath),
      title: String(raw?.title ?? ''),
      updatedAt: Number(raw?.updatedAt ?? 0) || 0,
      entries: Array.isArray(raw?.entries) ? raw.entries.filter((item) => item !== null && typeof item === 'object') : [],
    }
    return { ...files, path: wsPath, doc }
  }

  function save(loaded) {
    const doc = { ...loaded.doc }
    // ★ 路径优先取调用方给的 wsPath（loaded.path），别指望文档里自带的那个字段
    doc.path = String(loaded.path ?? loaded.doc.path ?? '')
    doc.title = String(loaded.doc.title ?? '')
    if (doc.entries.length > maxEntries) doc.entries = doc.entries.slice(0, maxEntries)
    writeTextAtomic(loaded.json, `${JSON.stringify(doc, null, 2)}\n`)
    writeTextAtomic(loaded.md, renderMarkdown(doc))
    return doc
  }

  /**
   * 写一条交接记录。同一个 sessionId 只保留一条 —— 会话越聊越长时是「更新」不是「追加」，
   * 否则一个长会话会把交接文档刷满。
   * @returns {{ doc: object, files: object, action: 'insert'|'update' }|undefined}
   */
  function upsert(wsPath, entry, meta = {}) {
    try {
      const loaded = load(wsPath)
      // ★ 空串也是「有值」，?? 链会把 '' 当有效值留下来 —— 这里必须用 || 挑第一个非空
      const title = String(meta.title || loaded.doc.title || slugOf(wsPath))
      const others = loaded.doc.entries.filter((item) => String(item.sessionId ?? '') !== String(entry.sessionId ?? ''))
      const existed = others.length !== loaded.doc.entries.length
      const next = { ...entry }
      loaded.doc.title = title
      loaded.doc.updatedAt = Number(next.at ?? Date.now())
      loaded.doc.entries = [next, ...others]
      save(loaded)
      touchIndex(loaded.doc, loaded)
      return { doc: loaded.doc, files: loaded, action: existed ? 'update' : 'insert' }
    } catch (error) {
      log('warn', `交接文档写入失败（${wsPath}）：${String(error?.message ?? error)}`)
      return undefined
    }
  }

  /** 手动追加一条（没有 sessionId，永远新增）。 */
  function append(wsPath, entry) {
    return upsert(wsPath, { ...entry, sessionId: String(entry?.sessionId ?? `manual-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`) })
  }

  function touchIndex(doc, files) {
    const got = readJsonSafe(indexFile, { version: 1, workspaces: [] })
    const index = got.ok === true && got.value !== null && typeof got.value === 'object' ? got.value : { version: 1, workspaces: [] }
    const list = Array.isArray(index.workspaces) ? index.workspaces.filter((item) => item !== null && typeof item === 'object') : []
    const row = {
      key: files.key,
      hash: files.hash,
      slug: files.slug,
      path: String(doc.path ?? ''),
      title: String(doc.title ?? ''),
      doc: files.rel,
      count: doc.entries.length,
      updatedAt: Number(doc.updatedAt ?? 0),
    }
    const rest = list.filter((item) => item.key !== row.key)
    writeTextAtomic(indexFile, `${JSON.stringify({ version: 1, workspaces: [row, ...rest].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)) }, null, 2)}\n`)
  }

  /** 列全部工作区文档（索引 + 现场目录扫描兜底）。 */
  function list() {
    const rows = []
    const seen = new Set()
    const got = readJsonSafe(indexFile, { version: 1, workspaces: [] })
    const fromIndex = got.ok === true && Array.isArray(got.value?.workspaces) ? got.value.workspaces : []
    for (const row of fromIndex) {
      if (row === null || typeof row !== 'object') continue
      const key = String(row.key ?? '')
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      rows.push(row)
    }
    // 索引丢了也能列出来：直接扫目录
    try {
      for (const name of fs.readdirSync(docsDir)) {
        if (!name.endsWith('.json')) continue
        const key = name.slice(0, -5)
        if (seen.has(key)) continue
        const loaded = load(path.join(docsDir, `${key}.md`))
        seen.add(key)
        rows.push({
          key,
          hash: loaded.hash,
          slug: loaded.slug,
          path: loaded.doc.path,
          title: loaded.doc.title,
          doc: loaded.rel,
          count: loaded.doc.entries.length,
          updatedAt: loaded.doc.updatedAt,
        })
      }
    } catch {
      // 目录读不了就算了，索引里有的照样能列
    }
    return rows.sort((a, b) => (Number(b.updatedAt ?? 0) || 0) - (Number(a.updatedAt ?? 0) || 0))
  }

  /** 读渲染好的 md 原文。 */
  function text(wsPath) {
    const loaded = load(wsPath)
    return renderMarkdown(loaded.doc)
  }

  /** 按 key 找路径（面板用）。 */
  function pathOfKey(key) {
    const row = list().find((item) => item.key === String(key))
    return row?.path ?? ''
  }

  function clear(wsPath) {
    try {
      const loaded = load(wsPath)
      loaded.doc.entries = []
      loaded.doc.updatedAt = Date.now()
      save(loaded)
      touchIndex(loaded.doc, loaded)
      return true
    } catch (error) {
      log('warn', `交接文档清空失败：${String(error?.message ?? error)}`)
      return false
    }
  }

  return { dir, docsDir, indexFile, maxEntries, fileOf, load, save, upsert, append, list, text, pathOfKey, clear, render: renderMarkdown }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const RESULT_LABEL = { ok: '成功', partial: '部分完成', fail: '失败', unknown: '未判断' }

export function resultLabel(value) {
  const key = String(value ?? '').trim()
  if (key === '' || key === 'unknown') return RESULT_LABEL.unknown
  if (['ok', '成功', 'success', 'done'].includes(key)) return RESULT_LABEL.ok
  if (['partial', '部分完成', '部分'].includes(key)) return RESULT_LABEL.partial
  if (['fail', '失败', 'failed', 'error'].includes(key)) return RESULT_LABEL.fail
  return key.slice(0, 12)
}

export function formatTime(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '未知时间'
  const d = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 一条记录 → markdown 段落。 */
export function renderEntry(entry, index) {
  const lines = []
  const title = String(entry?.title ?? '').trim() || '（没有标题）'
  lines.push(`## ${index}. ${formatTime(entry?.at)} · ${title}`)
  const did = String(entry?.did ?? '').trim()
  if (did !== '') lines.push(`- 做了什么：${did}`)
  const result = resultLabel(entry?.result)
  const detail = String(entry?.detail ?? '').trim()
  lines.push(`- 结果：${result}${detail === '' ? '' : `（${detail}）`}`)
  const next = String(entry?.next ?? '').trim()
  if (next !== '') lines.push(`- 下次接手：${next}`)
  const turns = Number(entry?.turns ?? 0)
  const bits = []
  if (turns > 0) bits.push(`${turns} 轮`)
  if (typeof entry?.sessionId === 'string' && entry.sessionId !== '') bits.push(`会话 \`${entry.sessionId.slice(0, 8)}\``)
  if (bits.length > 0) lines.push(`- ${bits.join(' · ')}`)
  return lines.join('\n')
}

/** 整份文档 → markdown（给人看的版本）。 */
export function renderMarkdown(doc) {
  const title = String(doc?.title ?? '').trim() || slugOf(String(doc?.path ?? ''))
  const entries = Array.isArray(doc?.entries) ? doc.entries : []
  const head = [
    `# 工作区交接 · ${title}`,
    '',
    `> 目录：\`${String(doc?.path ?? '')}\``,
    '> 这份文档由 DSH 插件「交接」自动维护：每次会话结束写一条，同一工作区开新会话时自动读回最近几条。',
    `> 最后更新：${formatTime(doc?.updatedAt)}　记录数：${entries.length}`,
    '',
  ]
  if (entries.length === 0) {
    head.push('_还没有记录。在这个工作区里聊一次，会话结束后就会自动写进来。_', '')
    return head.join('\n')
  }
  const body = entries.map((entry, i) => renderEntry(entry, i + 1)).join('\n\n')
  return `${head.join('\n')}${body}\n`
}

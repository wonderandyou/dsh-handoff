/**
 * summarize.js —— 把一段会话压成一条交接记录
 * ============================================================================
 * 只做三件事：拼增量草稿、挑一个便宜模型、把模型输出抠成结构化条目。
 *
 * 三条纪律（和 dsh-grow 一致）：
 *   1. 走宿主自己的通道（ctx.llm），不需要任何 API key，不碰外部服务；
 *   2. 只发「这一段」的会话，不重发全史 —— 头一段弄清意图，尾一段看结果；
 *   3. 解析失败就返回失败，由调用方回退到「规则摘要」，绝不写脏数据。
 */

const SYSTEM_PROMPT = [
  '你在维护一份「工作区交接文档」。用户在同一工作区里连续换会话干活，下一个接手的人（可能是未来的你）',
  '要能只看这一条就知道：上一手到底做了什么、东西放在哪、结果如何、下一步从哪接。',
  '',
  '把给你的这段会话压成**一条**交接记录，只输出 JSON，不要解释，不要 markdown 代码块：',
  '{"title":"一句话标题，不超过 20 字","did":"这个会话做了什么，150~300 字","result":"ok|partial|fail","detail":"结果的一句话补充，可为空","next":"下次接手要先做什么，可为空"}',
  '',
  '规则：',
  '1. title 是这次会话的主题，不是第一句话的复述。',
  '2. **did 要写实、要给细节**（这是重点）：',
  '   - 改了/新建了哪些文件（写文件名或相对路径）',
  '   - 跑了什么命令 / 做了什么操作',
  '   - 得到了什么结论、什么数字（端口、计数、哈希片段、报错原文里的关键词）',
  '   - 有哪些限制、哪些没做',
  '   ✗ 不要写「讨论了问题」「进行了开发」「优化了一下」这种空话。',
  '3. did 用「；」分句，2~5 句即可，不要写成一大段散文。',
  '4. result：全部做完且验证通过 = ok；做了一部分 / 还没验证 = partial；失败或被卡住 = fail。',
  '5. next 只写在**下次真正需要接着做**时；已经收尾就留空。',
  '6. 不写感谢、不写情绪、不写「用户要求」这类废话。',
  '7. 不泄露任何密钥、token、密码 —— 遇到一律写成「（凭据已略）」。',
].join('\n')

/**
 * 把消息列表拼成草稿：头部一小段（意图）+ 尾部一大段（结果）。
 * 长会话只看全史会把 token 烧在中间过程上，而交接要的恰恰是两头。
 */
export function buildTranscript(entries, options = {}) {
  const headChars = Math.max(0, Number(options.headChars ?? 1200))
  const tailChars = Math.max(300, Number(options.tailChars ?? 2800))
  const lines = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    const who = entry.role === 'assistant' ? '助手' : '主人'
    const text = String(entry.text ?? '').replace(/\s+/g, ' ').trim()
    if (text === '') continue
    lines.push(`${who}：${text.length > 600 ? `${text.slice(0, 599)}…` : text}`)
  }
  if (lines.length === 0) return ''
  const head = []
  let used = 0
  for (const line of lines) {
    if (used + line.length > headChars) break
    head.push(line)
    used += line.length + 1
  }
  const tail = []
  used = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (used + line.length > tailChars) break
    tail.unshift(line)
    used += line.length + 1
  }
  // 头尾已经连上了：直接用尾巴（别重复发一遍）
  if (tail.length >= lines.length || head.length >= lines.length) return lines.join('\n')
  const omitted = lines.length - head.length - tail.length
  return `${head.join('\n')}\n…（中间省略 ${omitted} 条）…\n${tail.join('\n')}`
}

/** 选 provider + model：优先便宜模型，其次官方通道。 */
export async function resolveCallConfig(llm, options = {}) {
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    return { ok: false, reason: 'ctx.llm 不可用' }
  }
  let providers = []
  try {
    providers = llm.listProviders() ?? []
  } catch (error) {
    return { ok: false, reason: `listProviders 失败：${String(error?.message ?? error)}` }
  }
  if (!Array.isArray(providers) || providers.length === 0) return { ok: false, reason: '没有可用的模型 provider' }

  const wantedProvider = String(options.provider ?? '').trim()
  let provider = wantedProvider !== '' ? providers.find((item) => item?.id === wantedProvider) : undefined
  if (provider === undefined) {
    provider = providers.find((item) => String(item?.id ?? '').startsWith('deepseek')) ?? providers[0]
  }
  if (provider === undefined) return { ok: false, reason: '拿不到 provider' }

  let models = []
  try {
    models = (await llm.listModels(provider.id)) ?? []
  } catch (error) {
    return { ok: false, reason: `listModels 失败：${String(error?.message ?? error)}` }
  }
  if (!Array.isArray(models) || models.length === 0) return { ok: false, reason: `provider ${provider.id} 没有模型` }

  const wantedModel = String(options.model ?? '').trim()
  let model = wantedModel !== '' ? models.find((item) => item?.id === wantedModel) : undefined
  if (model === undefined) {
    model =
      models.find((item) => /flash|mini|lite/i.test(String(item?.id ?? ''))) ??
      models.find((item) => /chat|v3|4/i.test(String(item?.id ?? ''))) ??
      models[0]
  }
  return { ok: true, provider: provider.id, model: model.id }
}

/**
 * 调一次总结。
 * @returns {Promise<{ ok:boolean, entry?:object, usage?:object, reason?:string }>}
 */
export async function summarize({ llm, provider, model, transcript, maxTokens = 1400, temperature = 0.2, timeoutMs = 60000 }) {
  if (typeof transcript !== 'string' || transcript.trim() === '') return { ok: false, reason: '没有可总结的内容' }

  let text = ''
  let usage = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(5000, timeoutMs))
  if (typeof timer?.unref === 'function') timer.unref()

  try {
    const stream = llm.stream({
      provider,
      model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
      temperature,
      maxTokens,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk === null || chunk === undefined) continue
      if (chunk.type === 'text-delta') text += String(chunk.text ?? '')
      else if (chunk.type === 'usage') usage = chunk.usage ?? null
      else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        return { ok: false, reason: `模型返回错误：${chunk.reason.failure?.message ?? 'unknown'}` }
      }
    }
  } catch (error) {
    return { ok: false, reason: `请求失败：${String(error?.message ?? error)}` }
  } finally {
    clearTimeout(timer)
  }

  const entry = parseEntry(text)
  if (entry === null) return { ok: false, reason: `返回无法解析（${text.slice(0, 80)}）`, usage }
  return { ok: true, entry, usage, model }
}

/** 从模型输出里抠结构化条目。 */
export function parseEntry(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  const candidates = [text]
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced !== null) candidates.push(fenced[1])
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      const entry = normalizeEntry(value)
      if (entry !== null) return entry
    } catch {
      // 试下一个
    }
  }
  return null
}

function normalizeEntry(value) {
  if (value === null || typeof value !== 'object') return null
  const did = String(value.did ?? value.done ?? value.summary ?? '').trim()
  const title = String(value.title ?? '').trim()
  if (did === '' && title === '') return null
  const result = String(value.result ?? 'unknown').trim().toLowerCase()
  return {
    title: (title === '' ? did.slice(0, 20) : title).slice(0, 60),
    did: did.slice(0, 900),
    result: result === 'ok' || result === 'partial' || result === 'fail' ? result : 'unknown',
    detail: String(value.detail ?? '').trim().slice(0, 200),
    next: String(value.next ?? '').trim().slice(0, 400),
  }
}

/**
 * 规则摘要兜底：模型不可用 / 解析失败时，也不让交接文档空着。
 * 只取「主人最初要什么」+「最后一句回复的开头」，够用且零成本。
 */
export function fallbackEntry(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) return undefined
  const firstUser = list.find((item) => item?.role === 'user' && String(item?.text ?? '').trim() !== '')
  const lastAssistant = [...list].reverse().find((item) => item?.role === 'assistant' && String(item?.text ?? '').trim() !== '')
  const ask = clean(firstUser?.text, 220)
  const said = clean(lastAssistant?.text, 420)
  const title = ask !== '' ? ask : '一次会话'
  return {
    title: title.slice(0, 60),
    did: [ask === '' ? '' : `需求：${ask}`, said === '' ? '' : `最后进展：${said}`].filter((x) => x !== '').join('；').slice(0, 800),
    result: options.result ?? 'unknown',
    detail: options.detail ?? '',
    next: '',
    source: 'fallback',
  }
}

function clean(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

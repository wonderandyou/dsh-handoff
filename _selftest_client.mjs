/**
 * _selftest_client.mjs —— 客户端半边的冒烟测试
 * ============================================================================
 * 不启动浏览器，只验：模块能被 __ModuleLoader__ 收下、factory 能跑完、
 * slots 注册挂上、组件在「有数据 / 没数据」两种状态下都能渲染成元素树（不白屏）。
 *
 * 跑法：node _selftest_client.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const here = path.dirname(fileURLToPath(import.meta.url))
const code = fs.readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')

// ---------------------------------------------------------------------------
// 最小 React 替身：只要 createElement / useState / useEffect / useCallback
// ---------------------------------------------------------------------------

function makeFakeReact() {
  const element = (type, props, ...children) => ({ $$el: true, type, props: props ?? {}, children: children.flat() })
  const stateCells = []
  let cursor = 0
  const React = {
    createElement: element,
    useState(initial) {
      const index = cursor
      cursor += 1
      if (stateCells[index] === undefined) stateCells[index] = { value: typeof initial === 'function' ? initial() : initial }
      const set = (next) => {
        stateCells[index] = { value: typeof next === 'function' ? next(stateCells[index].value) : next }
      }
      return [stateCells[index].value, set]
    },
    useEffect(effect) {
      // 只在首次挂载跑一次（照 React 的 [] 依赖习惯），重渲染时不再跑
      if (React.__mounted === true) return
      React.__mounted = true
      try {
        effect()
      } catch (error) {
        console.log(`    [effect 抛错] ${error.message}`)
      }
    },
    useCallback(fn) {
      return fn
    },
  }
  React.__mounted = false
  React.__reset = () => {
    stateCells.length = 0
    cursor = 0
    React.__mounted = false
  }
  // 模拟一次重渲染：不清状态值，只把 hook 游标归零
  React.__beginRender = () => {
    cursor = 0
  }
  return React
}

function countElements(node) {
  if (node === null || node === undefined || typeof node !== 'object') return 0
  if (node.$$el !== true) return 0
  let total = 1
  for (const child of node.children ?? []) total += countElements(child)
  return total
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  const own = Array.isArray(node.children) ? node.children.map(textOf).join(' ') : ''
  return own
}

// ---------------------------------------------------------------------------
console.log('=== client.js 结构 ===')
// ---------------------------------------------------------------------------

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
}

// ★ client.js 里 fetch 是自由变量 —— 用 new Function 注入时必须传一个「转发器」，
//   不能传死桩，否则后面换 mock 它看不到（踩过：一直显示加载中）
let fetchImpl = async () => ({ ok: false, status: 500 })
const fetchForward = (...args) => fetchImpl(...args)

// eslint-disable-next-line no-new-func
new Function('window', 'fetch', code)(globalThis.window, fetchForward)

ok(loaded !== null, '__ModuleLoader__.load 被调用了')
ok(loaded?.id === 'dsh-handoff', '模块 id 是 dsh-handoff', String(loaded?.id))

const fakeReact = makeFakeReact()
const module = loaded.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`不该 require(${name})`)
})

ok(typeof module?.apply === 'function', 'factory 返回了 apply')
ok(Array.isArray(module?.inject) && module.inject.includes('slots'), 'inject 里声明了 slots')

// ---------------------------------------------------------------------------
console.log('\n=== slots 注册 ===')
// ---------------------------------------------------------------------------

const registered = []
const fakeCtx = {
  slots: {
    inject(name, cb) {
      ok(name === 'settings.section', 'slots.inject 等的是 settings.section', name)
      cb()
    },
    register(meta, component) {
      registered.push({ meta, component })
    },
  },
}
module.apply(fakeCtx)

ok(registered.length === 1, '注册了 1 个设置页区块', String(registered.length))
ok(registered[0]?.meta?.id === 'handoff', '区块 id 是 handoff', String(registered[0]?.meta?.id))
ok(registered[0]?.meta?.label === '交接', '区块显示名是「交接」', String(registered[0]?.meta?.label))
ok(registered[0]?.meta?.name === 'settings.section', '挂的是 settings.section', String(registered[0]?.meta?.name))
ok(typeof registered[0]?.component === 'function', '区块是个组件函数')

// ---------------------------------------------------------------------------
console.log('\n=== 组件渲染（拿不到接口数据时）===')
// ---------------------------------------------------------------------------

fetchImpl = async () => ({ ok: false, status: 500 })

fakeReact.__reset()
const loadingTree = registered[0].component({})
let tree = loadingTree
ok(tree !== null && tree !== undefined, '没数据时也返回一个元素（不是空白）')
ok(textOf(tree).includes('加载中'), '接口失败时显示加载中/提示，而不是空白', textOf(tree).slice(0, 40))

// ---------------------------------------------------------------------------
console.log('\n=== 组件渲染（有数据时）===')
// ---------------------------------------------------------------------------

fetchImpl = async (url) => {
  if (String(url).includes('/handoff/list.json')) {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        dir: 'C:\\Users\\x\\.dsh\\handoff',
        workspaces: [
          { key: 'k1', path: 'D:\\插件', title: '插件', count: 2, updatedAt: Date.now(), doc: 'workspaces\\插件-k1.md' },
          { key: 'k2', path: 'D:\\软件', title: '软件', count: 0, updatedAt: Date.now(), doc: 'workspaces\\软件-k2.md' },
        ],
        stats: { written: 3, budgetLeft: 117 },
      }),
    }
  }
  if (String(url).includes('/handoff/doc.json')) {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        workspace: { key: 'k1', path: 'D:\\插件', title: '插件', count: 2 },
        entries: [
          { sessionId: 's1', at: Date.now(), title: '做交接插件', did: '写了三个模块', result: 'ok', next: '重启验证', turns: 3 },
          { sessionId: 's2', at: Date.now(), title: '修 bug', did: '路径写成 undefined', result: 'fail', next: '', turns: 1 },
        ],
      }),
    }
  }
  throw new Error(`selftest 收到了意外的请求：${url}`)
}

// 第一次渲染：触发 useEffect 里的异步 reload；之后反复「等一下 → 重渲染」，
// 让所有异步 setState 都落进最终画面（真实 React 会自己重渲染，这里手动驱动）
fakeReact.__reset()
tree = registered[0].component({})
for (let i = 0; i < 6; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 20))
  fakeReact.__beginRender()
  tree = registered[0].component({})
}
const count = countElements(tree)
const text = textOf(tree)
const cardTitles = []
const walk = (node) => {
  if (node === null || typeof node !== 'object' || node.$$el !== true) return
  if (typeof node.props?.title === 'string') cardTitles.push(node.props.title)
  for (const child of node.children ?? []) walk(child)
}
walk(tree)

ok(count > 20, '有数据时渲染出的元素数量像个正常页面', String(count))
ok(text.includes('工作区交接'), '有页面标题「工作区交接」')
ok(cardTitles.includes('插件'), '工作区卡片标题是当前工作区名', cardTitles.join('|').slice(0, 60))
ok(text.includes('插件'), '列出工作区「插件」')
ok(text.includes('做交接插件'), '列出条目「做交接插件」')
ok(text.includes('成功'), '显示结果文案')
ok(text.includes('失败'), '失败那条也在（结果是 fail 时显示「失败」）')
ok(text.includes('重启验证'), '显示「下次接手」')
ok(text.includes('数据目录'), '顶部显示数据目录')

// ---------------------------------------------------------------------------
console.log('\n=== 危险操作要两次确认 ===')
// ---------------------------------------------------------------------------
ok(text.includes('清空这份文档'), '有个「清空这份文档」按钮')
ok(!text.includes('确认清空（不可恢复）'), '一开始不是确认态（要先点一次）')

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)

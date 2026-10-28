/**
 * client.js —— 设置页「交接」
 *
 * 只做三件事：看每个工作区的交接文档、切着看条目、清掉不想要的。
 * 数据全部来自宿主自己的 /handoff/* 端点（本机 only），不读别的插件的 DOM。
 *
 * 颜色统一走主题变量并带兜底值 —— 变量被改名最多难看一点，不会崩。
 */

window.__ModuleLoader__.load({
  id: 'dsh-handoff',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const LINE = 'var(--dsw-alias-border-subtle, rgba(128,128,128,0.28))'
    const TEXT = 'var(--dsw-alias-text-primary, currentColor)'
    const MUTED = 'var(--dsw-alias-text-secondary, rgba(128,128,128,0.9))'
    const CARD = 'var(--dsw-alias-surface-subtle, rgba(128,128,128,0.06))'
    const ACCENT = 'var(--dsw-alias-accent-primary, #4b8bf5)'

    async function getJson(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return response.json()
    }

    // ------------------------------------------------------------------ 小组件 --

    function Card({ title, hint, children }) {
      return h(
        'div',
        {
          style: {
            border: '1px solid ' + LINE,
            borderRadius: 12,
            background: CARD,
            padding: '12px 14px',
            marginBottom: 10,
          },
        },
        title !== undefined
          ? h(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 } },
              h('strong', { style: { fontSize: 14, color: TEXT } }, title),
              hint === undefined ? null : h('span', { style: { fontSize: 12, color: MUTED } }, hint),
            )
          : null,
        children,
      )
    }

    function Button({ children, onClick, disabled, danger }) {
      return h(
        'button',
        {
          type: 'button',
          disabled: disabled === true,
          onClick,
          style: {
            border: '1px solid ' + (danger === true ? 'rgba(220,80,80,0.5)' : LINE),
            color: danger === true ? 'rgba(220,80,80,0.95)' : TEXT,
            background: 'transparent',
            borderRadius: 8,
            padding: '5px 12px',
            fontSize: 13,
            cursor: disabled === true ? 'default' : 'pointer',
            opacity: disabled === true ? 0.5 : 1,
          },
        },
        children,
      )
    }

    function fmt(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value <= 0) return '—'
      const date = new Date(value)
      const pad = (n) => String(n).padStart(2, '0')
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    const RESULT = { ok: '成功', partial: '部分完成', fail: '失败', unknown: '未判断' }
    const RESULT_COLOR = { ok: 'rgba(70,170,110,0.95)', partial: 'rgba(220,160,60,0.95)', fail: 'rgba(220,80,80,0.95)', unknown: MUTED }

    // -------------------------------------------------------------------- 页面 --

    function HandoffSection() {
      const [list, setList] = useState(null)
      const [key, setKey] = useState('')
      const [doc, setDoc] = useState(null)
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)
      const [confirmClear, setConfirmClear] = useState(false)

      const loadDoc = useCallback(async (wantKey) => {
        try {
          const next = await getJson('/handoff/doc.json?key=' + encodeURIComponent(wantKey ?? ''))
          if (next.ok === true) {
            setDoc(next)
            if (typeof next.workspace?.key === 'string' && next.workspace.key !== '') setKey(next.workspace.key)
          } else {
            setNote(next.reason ?? '读不到文档')
          }
        } catch (error) {
          setNote('连不上插件接口：' + String(error?.message ?? error))
        }
      }, [])

      const reload = useCallback(async () => {
        try {
          const next = await getJson('/handoff/list.json')
          if (next.ok !== true) {
            setNote(next.reason ?? '拿不到列表')
            return
          }
          setList(next)
          const wantKey = key !== '' && (next.workspaces ?? []).some((row) => row.key === key) ? key : (next.workspaces?.[0]?.key ?? '')
          // ★ 首次进来 key 还是空的：选中的那个要写回状态，否则下面 current 永远找不到 → 一直显示「还没有记录」
          setKey(wantKey)
          await loadDoc(wantKey)
        } catch (error) {
          setNote('连不上插件接口：' + String(error?.message ?? error))
        }
      }, [key, loadDoc])

      useEffect(() => {
        void reload()
        // 只在首次挂载时拉一次；之后靠手点刷新
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const pick = useCallback(
        async (nextKey) => {
          setKey(nextKey)
          setConfirmClear(false)
          await loadDoc(nextKey)
        },
        [loadDoc],
      )

      const clearDoc = useCallback(async () => {
        if (doc === null) return
        setBusy(true)
        try {
          const result = await postJson('/handoff/act', { action: 'clear', key: doc.workspace?.key ?? '' })
          setNote(result.ok === true ? '已清空这一份交接文档' : '清空失败：' + (result.reason ?? '未知'))
          setConfirmClear(false)
          await reload()
        } catch (error) {
          setNote('操作失败：' + String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }, [doc, reload])

      if (list === null) {
        return h(
          'div',
          { style: { padding: 18, color: TEXT, fontSize: 14 } },
          h(Card, { title: '交接' }, note !== '' ? note : '加载中…'),
        )
      }

      const workspaces = list.workspaces ?? []
      const entries = doc?.entries ?? []
      const stats = list.stats ?? {}
      const withDoc = workspaces.filter((row) => Number(row.count ?? 0) > 0).length

      const header = h(
        'div',
        { style: { marginBottom: 14 } },
        h('div', { style: { fontSize: 16, fontWeight: 600, color: TEXT, marginBottom: 4 } }, '工作区交接'),
        h(
          'div',
          { style: { fontSize: 12, color: MUTED, lineHeight: 1.6 } },
          '每个工作区一份交接文档。会话结束时自动写一条「做了什么 / 结果 / 下次接手」，同一工作区开新会话时自动读回最近几条。',
        ),
        h(
          'div',
          { style: { fontSize: 12, color: MUTED, marginTop: 6 } },
          '工作区：' +
            String(workspaces.length) +
            ' 个（' +
            String(withDoc) +
            ' 个已有交接）　本次已写：' +
            String(stats.written ?? 0) +
            ' 条　今日预算剩：' +
            (Number(stats.budgetLeft) < 0 ? '不限' : String(stats.budgetLeft)),
        ),
        h('div', { style: { fontSize: 12, color: MUTED, marginTop: 2, wordBreak: 'break-all' } }, '数据目录：' + String(list.dir ?? '')),
      )

      const tabs = h(
        'div',
        { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 } },
        workspaces.length === 0
          ? h('span', { style: { fontSize: 12, color: MUTED } }, '还没认出任何工作区（工作区列表是空的）。')
          : workspaces.map((row) => {
              const selected = row.key === key
              const count = Number(row.count ?? 0)
              return h(
                'button',
                {
                  key: row.key,
                  type: 'button',
                  onClick: () => void pick(row.key),
                  title: String(row.path ?? ''),
                  style: {
                    border: '1px solid ' + (selected ? ACCENT : LINE),
                    borderStyle: count > 0 ? 'solid' : 'dashed',
                    background: selected ? ACCENT : 'transparent',
                    color: selected ? '#fff' : TEXT,
                    borderRadius: 8,
                    padding: '6px 11px',
                    fontSize: 13,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 6,
                  },
                },
                h('span', null, String(row.title || row.slug || '工作区')),
                h(
                  'span',
                  { style: { fontSize: 11, opacity: selected ? 0.85 : 0.6 } },
                  count > 0 ? String(count) + ' 条' : row.registered === false ? '未登记' : '暂无记录',
                ),
              )
            }),
      )

      const current = workspaces.find((row) => row.key === key)

      const docCard =
        current === undefined
          ? h(Card, { title: '还没有工作区' }, h('div', { style: { fontSize: 13, color: MUTED } }, '在 DSH 里建一个工作区、在里面聊一次，这里就会出现它。'))
          : h(
              Card,
              {
                title: String(current.title || current.slug || '工作区'),
                hint:
                  Number(current.count ?? 0) > 0
                    ? String(current.count) + ' 条 · 最后更新 ' + fmt(current.updatedAt)
                    : '还没有交接记录',
              },
              h(
                'div',
                { style: { fontSize: 12, color: MUTED, marginBottom: 8, wordBreak: 'break-all' } },
                String(current.path ?? '') +
                  '　' +
                  (current.registered === false ? '未登记在工作区列表' : String(current.sessions ?? 0) + ' 个会话'),
              ),
              entries.length === 0
                ? h(
                    'div',
                    { style: { fontSize: 13, color: MUTED, lineHeight: 1.7 } },
                    '这个工作区还没有交接记录。在这里聊完一轮，20 秒后会自动写进来（标题 / 做了什么 / 结果 / 下次接手）。',
                  )
                : entries.map((entry, i) =>
                    h(
                      'div',
                      {
                        key: String(entry.sessionId ?? '') + '-' + String(i),
                        style: {
                          borderTop: i === 0 ? 'none' : '1px solid ' + LINE,
                          paddingTop: i === 0 ? 0 : 10,
                          marginTop: i === 0 ? 0 : 10,
                        },
                      },
                      h(
                        'div',
                        { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
                        h('strong', { style: { fontSize: 13, color: TEXT } }, String(entry.title ?? '（没有标题）')),
                        h('span', { style: { fontSize: 12, color: RESULT_COLOR[entry.result] ?? MUTED } }, RESULT[entry.result] ?? String(entry.result ?? '')),
                        h('span', { style: { fontSize: 12, color: MUTED } }, fmt(entry.at) + ' · ' + String(entry.turns ?? 0) + ' 轮'),
                      ),
                      String(entry.did ?? '') === ''
                        ? null
                        : h('div', { style: { fontSize: 13, color: TEXT, marginTop: 4, lineHeight: 1.6 } }, String(entry.did)),
                      String(entry.next ?? '') === ''
                        ? null
                        : h('div', { style: { fontSize: 12, color: MUTED, marginTop: 4 } }, '下次接手：' + String(entry.next)),
                    ),
                  ),
              entries.length === 0
                ? null
                : h(
                    'div',
                    { style: { display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' } },
                    confirmClear
                      ? Button({ children: '确认清空（不可恢复）', onClick: () => void clearDoc(), disabled: busy, danger: true })
                      : Button({ children: '清空这份文档', onClick: () => setConfirmClear(true), disabled: busy, danger: true }),
                    confirmClear ? Button({ children: '取消', onClick: () => setConfirmClear(false), disabled: busy }) : null,
                  ),
            )

      const actions = h(
        'div',
        { style: { display: 'flex', gap: 8, marginBottom: 10 } },
        Button({ children: '重新读取', onClick: () => void reload(), disabled: busy }),
        h(
          'span',
          { style: { fontSize: 12, color: MUTED, alignSelf: 'center' } },
          '文档在磁盘上也能直接看：workspaces/<工作区名>-<哈希>.md',
        ),
      )

      return h(
        'div',
        { style: { padding: '18px 20px 28px', maxWidth: 820, color: TEXT } },
        header,
        actions,
        tabs,
        note !== '' ? h('div', { style: { fontSize: 12, color: MUTED, marginBottom: 8 } }, note) : null,
        docCard,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'handoff', order: 45, label: '交接' }, HandoffSection),
        )
      },
    }
  },
})

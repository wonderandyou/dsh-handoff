# dsh-handoff（交接）

**每个工作区一份交接文档：会话结束自动写一条简短摘要，同一工作区开新会话时自动读回来。**

> DSH（DeepSeek Harness）插件。纯插件实现，零第三方依赖、零外部程序。

## 它解决什么

在同一个工作区里换会话干活，上下文是断的 —— 新会话不知道上一手做完了什么、卡在哪、下一步该接哪。
这个插件按**工作区目录**把交接记录下来，新会话一开就自动读最近几条。

## 行为

| 时机 | 做什么 |
|---|---|
| 一轮结束（`turn/end`） | 等一个防抖窗口（默认 15 秒），把这一段会话压成一条 `标题 / 做了什么 / 结果 / 下次接手` 写进该工作区的文档 |
| 会话销毁（`agent/disposed`） | 不等防抖，立刻把没落盘的内容写掉 |
| 新会话创建（`agent/created`） | 挂一个注入段：读该工作区最近 N 条交接，塞进运行时上下文 |
| 工具 `handoff` | `list` / `read` / `append` / `clear` / `status` / `flush` |
| 设置页「交接」 | 列出所有工作区（没记录的也列，标「暂无记录」）、切着看条目、清空 |

**同一个会话只占一条记录** —— 越聊越长是「更新」，不是「追加」，否则长会话会把文档刷满。

## 工作区怎么认

三条路按顺序，前一条不行才走下一条：

1. **DSH 自己的工作区账本** `~/.dsh/storages/workspace.json` —— 里面的 `sessionIds` 命中就是它（只读，绝不改写）
2. 会话的 `cwd` 与工作区 `path` 相同
3. 拿 `cwd` 自己当工作区（没登记过的目录也能用）

> 为什么优先读账本文件而不是 `workspaceRegistry` 服务：插件激活那一刻 `ctx.get('workspaceRegistry')` 拿不到，
> 而那些服务要用 `ctx.inject([...])` 等就绪。账本文件是最稳的一条路。

## 数据在哪

```
~/.dsh/handoff/
├── index.json                      工作区索引（面板用，丢了会按目录重建）
├── stats.json                      今天的总结次数（预算用）
└── workspaces/
    ├── 插件-3f2a91cd.json          真相源（条目数组）
    └── 插件-3f2a91cd.md            渲染版，给人看的
```

文件名 = `<目录名>-<路径哈希 8 位>`。按**规范路径**认，所以工作区删了再加回来、或者根本没登记过，交接文档都还在。

## 配置

全部走 `cordis.patch.yml`，省略即默认：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dir` | `""` | 数据目录；空 = `~/.dsh/handoff` |
| `workspaceFile` | `""` | 工作区账本路径；空 = `~/.dsh/storages/workspace.json`（一般不用改） |
| `injectOrder` | `320` | 交接段在运行时上下文里的排序 |
| `injectEntries` | `3` | 新会话读回最近几条 |
| `injectChars` | `1200` | 读回文本的字符预算（≈375 token） |
| `maxEntries` | `40` | 每个工作区最多保留几条 |
| `autoWrite` | `true` | 会话结束是否自动写 |
| `minGapMs` | `90000` | 两次总结最小间隔（防一路聊一路烧钱） |
| `debounceMs` | `15000` | 一轮结束后等多久再总结 |
| `maxPerDay` | `120` | 每天最多总结几次，`0` = 不限 |
| `summarizeModel` | `""` | 指定模型；空 = 自动挑便宜的 flash / mini / lite |
| `summarizeProvider` | `""` | 指定 provider；空 = 优先官方通道 |

## 四条纪律

1. **只读会话事件，绝不 append** —— 往会话日志里加事件会让会话文件打不开。
2. **总结失败不空着** —— 模型挂了 / 返回不是 JSON / 拿不到 `llm` 服务，都回退成「最初需求 + 最后进展」的规则摘要。
3. **注入失败就返回空** —— 组装阶段抛错会毁掉整个模型请求，宁可没交接也不能让聊天挂掉。
4. **同一会话不读回自己那条** —— 否则每轮都会把上一轮写的东西又当交接读一遍。

## 把已有的历史会话补进来

插件从装上那刻起才记录。想让它一开始就有内容，跑回填脚本（只读本机会话缓存，不联网）：

```powershell
node _backfill.mjs --dry     # 先看会写什么
node _backfill.mjs           # 每个工作区补最近 4 个会话
node _backfill.mjs --per=8   # 多补几个
node _backfill.mjs --all     # 连没登记在工作区列表里的目录也补
```

历史会话只能拿到标题和开场需求，所以这些条目标「未判断」—— 结果无从得知，不编造。

## 自测

```powershell
node _selftest.mjs          # host 半边，70 项断言
node _selftest_client.mjs   # 设置页半边，23 项断言
```

不启动 DSH 也能跑完整链路（假 ctx + 假 llm + 假账本）：存储、渲染、草稿拼接、JSON 解析、事件 → 总结 → 落盘、新会话注入、工具、面板接口、边界情况。

## 安装

装进 profile 的三处（和别的插件一样）：

1. `~/.dsh/profiles/desktop/package.json` → `dependencies` 加 `"dsh-handoff": "link:<你的路径>/dsh-handoff"`
2. 同文件 `dsh.profile.bundles` 加 `"dsh-handoff"`
3. `node_modules/dsh-handoff` 建 junction 指过去（Windows：`New-Item -ItemType Junction`）

改完**重启 DSH** 生效。

## 目录结构

```
dsh-handoff/
├── package.json
├── cordis.patch.yml        bundle 自己的补丁层（把 host 行插进来）
├── icon.svg
├── lib/
│   ├── index.js            host 半边：事件订阅 / 自动注入 / 工具 / 面板接口
│   ├── store.js            每个工作区一份文档（json 真相源 + md 渲染）
│   ├── summarize.js        把一段会话压成一条交接记录
│   └── client.js           设置页「交接」
├── locale/{zh,en}.json
├── _selftest.mjs
├── _selftest_client.mjs
└── _backfill.mjs
```

## License

MIT

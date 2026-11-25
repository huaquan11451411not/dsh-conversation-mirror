# 会话镜像（dsh-conversation-mirror）

每轮对话结束时，把该会话的完整日志重写成一份中文 Markdown，落到你指定的目录。替代早期那套
`mirror.ps1` + 启动文件夹快捷方式 + 20 秒轮询 + 按 zstd 帧魔数切帧解压的做法。

## 安装

```sh
# 从 npm（推荐，需要 npm 11 以上）
dsh plugin --profile <你的 profile> add dsh-conversation-mirror

# 直接从 GitHub 源码
dsh plugin --profile <你的 profile> add github:huaquan11451411not/dsh-conversation-mirror
```

装完在 DSH 的插件页能看到「会话镜像 / Conversation mirror」；默认产物落在
`<用户目录>/dsh-conversations/`。

## 它做什么

- 监听 Host 的 `session/event`，只在 `turn/end` 时触发（不轮询、不扫盘）。
- 用 `ctx.sessionQuery.readSession(sessionId)` 拿到完整逻辑事件流（含 fork 继承前缀）。
- 整篇重写 `sessions\<session-id>.md`，同时刷新 `latest.md`。
- 子代理会话（`delegationDepth > 0`）照常归档到 `sessions\`，但不更新 `latest.md`——一次性的子任务不该顶掉你正在看的那场对话。
- 同一会话的连续 `turn/end` 会在 `debounceMs` 窗口内合并，并按会话串行落盘。

产物结构：

```
<dir>\
  sessions\<session-id>.md     # 每个会话一份，整篇重写
  latest.md                    # 最近一次导出的那份（内容即 sessions 里的同一份）
  raw\<session-id>.jsonl       # 仅当 formats 含 'jsonl' 时生成
```

## 配置

写在 bundle 的 `cordis.patch.yml` 行配置里（本仓库已填好一套）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dir` | `<用户主目录>/dsh-conversations` | 镜像根目录。留空用默认值；若自定义，必须是绝对路径且不能是盘符根目录。 |
| `formats` | `['md']` | 可选 `'md'`、`'jsonl'`；为空数组按 `['md']` 处理。 |
| `maxToolResult` | `2000` | 单个工具结果保留的字符数，超出截断并标注剩余长度。 |
| `debounceMs` | `1500` | 同一会话连续 `turn/end` 的合并等待。 |
| `latest` | `true` | 是否同步刷新 `latest.md`。 |

改完配置需要重新安装/重载该 bundle 才生效。

## 安全边界（写盘相关）

插件接受的输入是运行时数据，不是可信代码，所以每次落盘都重新证明目标合法：

- **根目录校验**：相对路径、盘符根目录（如 `D:\`）一律拒绝并停用插件。
- **路径收敛**：所有目标经 `path.resolve` 后必须仍在 `dir` 之内，`..` 逃逸与绝对路径目标都会被拒。
- **文件名净化**：会话 id 只接受 `[A-Za-z0-9._-]`（正常 id 原样保留以覆盖旧文件）；含分隔符、空白或超长的
  异常 id 会被净化并追加内容哈希，避免 `..\` 或同名碰撞。
- **软链拒绝**：目录建好后用 `lstat` 确认不是软链；写文件走"同目录临时文件 + rename"，替换的是目标条目本身，
  即使目标被预先替换成软链也只会替换该链接，不会跟写到链接指向的真实文件。
- **资源上限**：单篇文档 8 MiB、单条工具结果按 `maxToolResult` 截断，避免异常会话撑爆磁盘。
- **无外联**：不联网、不启子进程、不 `eval`、不动态加载代码。

## 已知限制

- 工具结果里的密钥/隐私**不会**自动打码；需要脱敏请在 `maxToolResult` 之外另想办法（本插件不做）。
- DSH 自己的原始会话日志仍写在 DSH 的数据目录（`<用户目录>/.dsh/sessions`），插件只读取并生成整理版，不改也不删原始日志。
- 只有 `turn/end` 之后才会落盘，所以进行中的那一轮不会出现在文件里。
- 同一会话若同时被别的东西写同一路径（例如旧的 `mirror.ps1` 还在跑），会互相覆盖；装本插件前请先停掉旧链路。
- 子代理会话也会在 `sessions\` 里留下文件（文件名是其 session id，通常没有 `session-` 前缀）。

## 卸载

在插件页移除该 bundle 即可，定时器与写入链随 fiber 一并释放；已产出的 md 文件保留。
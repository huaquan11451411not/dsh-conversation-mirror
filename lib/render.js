/**
 * 纯函数渲染层：把一份 SessionEvent[] 变成人读的中文 Markdown。
 *
 * 不读存储、不碰 ctx、不写盘，便于单测。格式与 D:\dsh-conversations 里
 * 已有的 export-session.mjs 产物保持同一套标题/图标习惯，方便新旧文件混放。
 */

import { redactText } from './redact.js'

/** 标题缺失时的兜底标题。 */
const UNTITLED = '未命名会话'
/** 整篇 Markdown 的字节上限，防止异常长会话拖死写盘。 */
const DEFAULT_MAX_DOC_BYTES = 8 * 1024 * 1024
/** 单个工具结果默认保留的字符数。 */
const DEFAULT_MAX_TOOL_RESULT = 2000
/** harness 自动注入的上下文前缀：不是用户说的话，导出时跳过。 */
const INJECTED_PREFIXES = [
  '<system-reminder>',
  'Time sampled while preparing',
  'Browser time zone for this request',
]

/**
 * 判断一段用户消息是否只是 harness 自动注入的上下文。
 * @param {string} text 消息正文。
 * @returns {boolean} 是注入内容则为 true。
 */
function isInjected(text) {
  const body = text.trimStart()
  return INJECTED_PREFIXES.some((prefix) => body.startsWith(prefix))
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * 把毫秒时间戳格式化成本地时区的 `YYYY-MM-DD HH:mm:ss`。
 * @param {unknown} ms 毫秒时间戳。
 * @returns {string} 无法解析时返回空串。
 */
export function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** 按码点截断，避免切坏代理对；返回 [文本, 是否截断, 剩余字符数]。 */
function clipText(text, limit) {
  if (limit <= 0 || text.length <= limit) return [text, false, 0]
  const chars = Array.from(text)
  if (chars.length <= limit) return [text, false, 0]
  return [chars.slice(0, limit).join(''), true, chars.length - limit]
}

/** 用比内容更长的围栏包住文本，避免正文里的 ``` 提前闭合代码块。 */
function fenced(text, language = '') {
  const body = String(text).replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')
  let longest = 0
  for (const match of body.matchAll(/`{3,}/gu)) longest = Math.max(longest, match[0].length)
  const marker = '`'.repeat(Math.max(3, longest + 1))
  return `${marker}${language}\n${body}\n${marker}`
}

/** 取一个内容块数组里的纯文本，忽略图片/文件/未知类型。 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/** 取一个内容块数组里的推理文本（思考过程）。 */
function reasoningOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text)
    }
  }
  return parts.join('\n\n')
}

/**
 * 按 turn/start…turn/end 归集段落，保证助手回复和工具调用保持原始先后顺序。
 * @param {readonly object[]} events 完整事件流。
 * @returns {Array<{ index: number, time: number, segments: object[] }>} 各轮段落。
 */
function collectTurns(events) {
  const turns = []
  /** callId → 段落，用于把工具结果贴回调用处（跨轮兜底）。 */
  const toolCalls = new Map()
  let current

  const begin = (turn, time) => {
    current = { index: typeof turn === 'number' ? turn : turns.length + 1, time: 0, segments: [] }
    if (typeof time === 'number') current.time = time
    turns.push(current)
    return current
  }
  const active = (time) => {
    const turn = current ?? begin(undefined, time)
    if (turn.time === 0 && typeof time === 'number') turn.time = time
    return turn
  }

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    switch (event.type) {
      case 'turn/start':
        begin(data?.turn, event.time)
        break
      case 'turn/end':
        current = undefined
        break
      case 'user/message': {
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') break
        if (data?.source?.kind !== 'user') break
        const text = textOf(data.content)
        if (text === '' || isInjected(text)) break
        const bucket = current === undefined && typeof data?.turn === 'number' ? begin(data.turn, event.time) : active(event.time)
        bucket.segments.push({ kind: 'user', text })
        break
      }
      case 'assistant/message': {
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') break
        const message = data?.message
        if (message === undefined) break
        const text = textOf(message.content)
        const reasoning = reasoningOf(message.content)
        if (text === '' && reasoning === '') break
        active(event.time).segments.push({
          kind: 'assistant',
          step: typeof data.step === 'number' ? data.step : undefined,
          text,
          reasoning,
        })
        break
      }
      case 'tool/call': {
        const name = typeof data?.name === 'string' ? data.name : 'unknown'
        const entry = {
          kind: 'tool',
          name,
          arguments: typeof data?.arguments === 'string' ? data.arguments : '',
          result: undefined,
        }
        active(event.time).segments.push(entry)
        if (data?.callId !== undefined) toolCalls.set(String(data.callId), entry)
        break
      }
      case 'tool/result': {
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') break
        const message = data?.message
        const callId = message?.toolCallId ?? message?.source?.callId
        const entry = callId === undefined ? undefined : toolCalls.get(String(callId))
        if (entry === undefined) break
        entry.result = {
          text: textOf(message?.content),
          isError: message?.isError === true,
          reason: typeof data?.error?.reason === 'string' ? data.error.reason : undefined,
        }
        break
      }
      default:
        break
    }
  }
  return turns.filter((turn) => turn.segments.length > 0)
}

/** 渲染单个工具调用段落。 */
function renderTool(segment, maxToolResult) {
  const lines = [`**Tool: \`${segment.name}\`**`]
  const args = segment.arguments === '' ? '(无参数)' : fenced(segment.arguments, 'json')
  lines.push('', args)
  const result = segment.result
  lines.push('')
  if (result === undefined) {
    lines.push('**结果**', '', '(未记录结果)')
    return lines.join('\n')
  }
  lines.push(result.isError ? '**结果（错误）**' : '**结果**', '')
  if (result.reason !== undefined && result.reason !== '') {
    lines.push(`错误：${result.reason}`)
    if (result.text !== '') {
      const [text, truncated, remaining] = clipText(result.text, maxToolResult)
      lines.push('', fenced(text, 'text'))
      if (truncated) lines.push('', `…（已截断，剩余 ${String(remaining)} 字符）`)
    }
    return lines.join('\n')
  }
  if (result.text === '') {
    lines.push('(无输出)')
    return lines.join('\n')
  }
  const [text, truncated, remaining] = clipText(result.text, maxToolResult)
  lines.push(fenced(text, 'text'))
  if (truncated) lines.push('', `…（已截断，剩余 ${String(remaining)} 字符）`)
  return lines.join('\n')
}

/** 渲染一个助手片段：思考过程折叠，正文直出。 */
function renderAssistant(segment) {
  const blocks = []
  if (segment.reasoning !== '') {
    blocks.push(`<details><summary>🧠 思考过程</summary>\n\n${segment.reasoning}\n\n</details>`)
  }
  if (segment.text !== '') blocks.push(segment.text)
  return blocks.join('\n\n')
}

/**
 * 渲染一份完整会话。
 * @param {readonly object[]} events 完整逻辑事件流（seq 升序，含 fork 继承前缀）。
 * @param {object} options 渲染选项。
 * @param {string} options.sessionId 会话 id。
 * @param {string} [options.cwd] 会话工作目录。
 * @param {number} [options.createdAt] 会话创建时间（毫秒）。
 * @param {number} [options.maxToolResult] 单个工具结果保留字符数。
 * @param {number} [options.maxBytes] 整篇字节上限。
 * @param {number} [options.now] 导出时间（毫秒），便于测试注入。
 * @param {readonly { label: string, re: RegExp }[]} [options.redactRules] 脱敏规则，缺省不抹。
 * @returns {string} 以单个换行结尾的 Markdown。
 */
export function renderSessionMarkdown(events, options = {}) {
  const {
    sessionId = '',
    cwd = '',
    createdAt,
    maxToolResult = DEFAULT_MAX_TOOL_RESULT,
    maxBytes = DEFAULT_MAX_DOC_BYTES,
    now = Date.now(),
    redactRules = [],
  } = options

  const list = Array.isArray(events) ? events : []
  const titleEvent = [...list].reverse().find((event) => event?.type === 'session/title')
  const rawTitle = typeof titleEvent?.data?.title === 'string' ? titleEvent.data.title : ''
  const title = rawTitle.replace(/\r\n?|\n/gu, ' ').trim() === '' ? UNTITLED : rawTitle.replace(/\r\n?|\n/gu, ' ').trim()
  const firstTime = list.find((event) => typeof event?.time === 'number')?.time
  const startTime = typeof createdAt === 'number' ? createdAt : firstTime

  const sections = [`# ${title}`]
  const meta = [
    `- 会话 ID: \`${sessionId}\``,
    cwd === '' ? undefined : `- 工作目录: \`${cwd}\``,
    startTime === undefined ? undefined : `- 开始时间: ${formatTime(startTime)}`,
    `- 导出时间: ${formatTime(now)}`,
    `- 事件数: ${String(list.length)}`,
    '- 说明: 本文件由 DSH 插件 `dsh-conversation-mirror` 在每轮结束时自动重写，手工编辑会被覆盖。',
  ].filter((line) => line !== undefined)
  sections.push(meta.join('\n'))
  sections.push('---')

  for (const turn of collectTurns(list)) {
    const heading = turn.time === 0
      ? `## 第 ${String(turn.index)} 轮`
      : `## 第 ${String(turn.index)} 轮 · ${formatTime(turn.time)}`
    sections.push(heading)
    for (const segment of turn.segments) {
      if (segment.kind === 'user') {
        sections.push(`### 👤 用户\n\n${segment.text}`)
      } else if (segment.kind === 'assistant') {
        const label = segment.step === undefined ? '### 🤖 助手' : `### 🤖 助手 · 步骤 ${String(segment.step)}`
        sections.push(`${label}\n\n${renderAssistant(segment)}`)
      } else {
        sections.push(renderTool(segment, maxToolResult))
      }
    }
  }

  let markdown = `${sections.join('\n\n').trimEnd()}\n`
  // 脱敏放在拼完之后：标题、元数据、正文、工具参数与结果都在同一处过滤，
  // 不必在每个字段各写一遍，也就不会漏掉新加的字段。
  markdown = redactText(markdown, redactRules)
  const bytes = Buffer.byteLength(markdown, 'utf8')
  if (bytes > maxBytes) {
    const keep = Math.max(0, Math.floor(markdown.length * (maxBytes / bytes)))
    markdown = `${markdown.slice(0, keep)}\n\n…（文档超过 ${String(maxBytes)} 字节上限，已截断）\n`
  }
  return markdown
}
/**
 * dsh-conversation-mirror —— Host 插件。
 *
 * 只做一件事：每当某个会话的一轮结束（`session/event` 的 `turn/end`），
 * 就把该会话的完整日志读出来、渲染成中文 Markdown、原子写进 config.dir。
 *
 * 设计取舍：
 * - 事件驱动而不是轮询：不需要 20 秒定时器、不需要自己切 zstd 帧解压。
 * - 整篇重写而不是增量追加：与旧 export-session.mjs 的产物语义一致，
 *   任何时候手工删掉文件，下一轮就会重新长出来。
 * - 不导出 `Config` schema：避免把 `@deepseek-ai/schemastery` 变成插件依赖，
 *   配置在 apply 里手工校验，非法就在日志里说清原因并停用。
 */

import os from 'node:os'
import path from 'node:path'

import { renderSessionMarkdown } from './render.js'
import {
  ensureDirInside,
  MirrorPathError,
  resolveRoot,
  safeSessionFileName,
  writeContained,
} from './store.js'

const DEFAULT_MAX_TOOL_RESULT = 2000
const DEFAULT_DEBOUNCE_MS = 1500
const DEFAULT_DIR_NAME = 'dsh-conversations'
const FORMATS = new Set(['md', 'jsonl'])

/**
 * 取一个正整数配置，非法回落到默认值。
 * @param {unknown} value 配置值。
 * @param {number} fallback 默认值。
 * @returns {number} 正整数。
 */
function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * 解析镜像根目录：显式配置优先，缺省落在「用户主目录/dsh-conversations」。
 * 这样公开分发的默认配置里不必写任何人的真实路径。
 * @param {unknown} dir 配置里的 dir。
 * @returns {string} 规范化后的绝对根目录。
 */
function resolveDir(dir) {
  if (dir === undefined || dir === null || dir === '') return path.join(os.homedir(), DEFAULT_DIR_NAME)
  return resolveRoot(dir)
}

/**
 * 挂载插件。
 * @param {object} ctx Cordis 上下文（Host 侧）。
 * @param {object} [config] 行配置，来自 cordis.patch.yml。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  let root
  try {
    root = resolveDir(config.dir)
  } catch (error) {
    ctx.logger.warn(`conversation-mirror: 未启用（${error instanceof Error ? error.message : String(error)}）`)
    return
  }

  const formats = Array.isArray(config.formats)
    ? config.formats.filter((format) => FORMATS.has(format))
    : ['md']
  const writeMarkdown = formats.length === 0 || formats.includes('md')
  const writeJsonl = formats.includes('jsonl')
  const maxToolResult = positiveInt(config.maxToolResult, DEFAULT_MAX_TOOL_RESULT)
  const debounceMs = positiveInt(config.debounceMs, DEFAULT_DEBOUNCE_MS)
  const writeLatest = config.latest !== false

  /** sessionId → 合并窗口定时器。 */
  const timers = new Map()
  /** sessionId → 该会话的写入链，保证同一会话串行落盘。 */
  const chains = new Map()
  let warnedMissingService = false

  /**
   * 导出一次该会话的完整日志。
   * @param {string} sessionId 会话 id。
   * @returns {Promise<void>} 写完或抛出。
   */
  const exportOnce = async (sessionId) => {
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery === undefined) {
      if (!warnedMissingService) {
        warnedMissingService = true
        ctx.logger.warn('conversation-mirror: 缺少 sessionQuery 服务，本次不镜像')
      }
      return
    }
    const snapshot = await sessionQuery.readSession(sessionId)
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    if (events.length === 0) return

    const header = snapshot.session ?? {}
    const fileName = safeSessionFileName(sessionId)
    const markdown = renderSessionMarkdown(events, {
      sessionId,
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : undefined,
      maxToolResult,
    })

    if (writeMarkdown) {
      ensureDirInside(root, 'sessions')
      // 加 BOM，老版本记事本/编辑器也能正确识别 UTF-8（与历史上的导出文件保持一致）
      const payload = `\uFEFF${markdown}`
      writeContained(root, path.join('sessions', `${fileName}.md`), payload)
      // 子代理会话（delegationDepth > 0）照常归档，但不抢 latest.md——
      // 否则 latest.md 会指向某个一次性的子任务，而不是你正在看的对话。
      const isSubagentSession = typeof header.delegationDepth === 'number' && header.delegationDepth > 0
      if (writeLatest && !isSubagentSession) writeContained(root, 'latest.md', payload)
    }
    if (writeJsonl) {
      ensureDirInside(root, 'raw')
      const jsonl = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
      writeContained(root, path.join('raw', `${fileName}.jsonl`), jsonl)
    }
  }

  /**
   * 把一次导出排进该会话的写入链。
   * @param {string} sessionId 会话 id。
   * @returns {Promise<void>} 完成后结算。
   */
  const run = (sessionId) => {
    const previous = chains.get(sessionId) ?? Promise.resolve()
    const next = previous
      .then(() => exportOnce(sessionId))
      .catch((error) => {
        const reason = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`conversation-mirror: 导出 ${sessionId} 失败：${reason}`)
      })
    chains.set(sessionId, next)
    void next.then(() => {
      if (chains.get(sessionId) === next) chains.delete(sessionId)
    })
    return next
  }

  /**
   * 合并同一会话的连续 turn/end，避免一次回复里多次触发重复写盘。
   * @param {unknown} sessionId 会话 id。
   * @returns {void}
   */
  const schedule = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const existing = timers.get(sessionId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      timers.delete(sessionId)
      void run(sessionId)
    }, debounceMs)
    timer.unref?.()
    timers.set(sessionId, timer)
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    schedule(session?.id)
  })

  ctx.effect(() => () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    chains.clear()
  }, 'conversation-mirror: timers')
}

export { MirrorPathError }
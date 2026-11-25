/**
 * 安全写盘层：路径收敛、文件名净化、软链拒绝、原子替换。
 *
 * 威胁模型（security-audit guidance）：会话 id 与配置目录来自低信任的运行时输入；
 * 若直接拼路径，`..\..\` 或盘符、以及被预先放置的软链，都能把"写镜像"变成
 * "覆盖任意文件"。因此每次落盘都必须重新证明目标仍在 root 之内，且用
 * 临时文件 + rename 替换目标本身（而不是跟写软链指向的真实文件）。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 路径校验失败：不合法或越界，调用方只应记日志并跳过本次写入。 */
export class MirrorPathError extends Error {
  /** @param {string} message 面向日志的中文说明。 */
  constructor(message) {
    super(message)
    this.name = 'MirrorPathError'
  }
}

const SESSION_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u

/**
 * 校验并规范化配置里的镜像根目录。
 * @param {unknown} dir 配置值。
 * @returns {string} 规范化后的绝对路径。
 * @throws {MirrorPathError} 空值、相对路径、或盘符根目录。
 */
export function resolveRoot(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new MirrorPathError('config.dir 未配置')
  if (!path.isAbsolute(dir)) throw new MirrorPathError(`config.dir 必须是绝对路径：${dir}`)
  const root = path.resolve(dir)
  if (root === path.parse(root).root) throw new MirrorPathError(`config.dir 不能是盘符根目录：${root}`)
  return root
}

/**
 * 把会话 id 变成安全的单层文件名。
 * 正常 id（如 `session-1a2b3c4d-...`）原样保留，以便与已有产物同名覆盖；
 * 含分隔符、`..`、空白或超长的异常 id 会被净化并追加内容哈希，避免碰撞。
 * @param {unknown} sessionId 会话 id。
 * @returns {string} 不含路径分隔符的文件名（无扩展名）。
 */
export function safeSessionFileName(sessionId) {
  const raw = String(sessionId ?? '')
  if (SESSION_FILE_PATTERN.test(raw) && raw !== '.' && raw !== '..') return raw
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^[.-]+/u, '').slice(0, 64)
  return cleaned === '' ? `session-${digest}` : `${cleaned}-${digest}`
}

/**
 * 判断 target 是否严格位于 root 之内（不含 root 自身）。
 * @param {string} root 已规范化的根目录。
 * @param {string} target 已规范化的目标路径。
 * @returns {boolean} 是否在内。
 */
export function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * 把 root 内的相对路径解析成绝对路径，越界即拒绝。
 * @param {string} root 已规范化的根目录。
 * @param {string} relativePath root 内的相对路径。
 * @returns {string} 绝对路径。
 * @throws {MirrorPathError} 绝对路径、空路径、或解析后越界（含 `..` 逃逸）。
 */
export function resolveInside(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '') {
    throw new MirrorPathError('目标相对路径为空')
  }
  if (path.isAbsolute(relativePath)) throw new MirrorPathError(`拒绝绝对路径目标：${relativePath}`)
  const target = path.resolve(root, relativePath)
  if (!isInside(root, target)) throw new MirrorPathError(`目标越出镜像目录：${relativePath}`)
  return target
}

/**
 * 创建 root 内的目录，并确认最终路径是真实目录而非软链。
 * @param {string} root 已规范化的根目录。
 * @param {string} relativeDir root 内的相对目录。
 * @returns {string} 该目录的绝对路径。
 * @throws {MirrorPathError} 越界、或最终路径是软链/非目录。
 */
export function ensureDirInside(root, relativeDir) {
  const target = resolveInside(root, relativeDir)
  fs.mkdirSync(target, { recursive: true })
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new MirrorPathError(`拒绝写入软链或非目录路径：${target}`)
  }
  return target
}

/**
 * 同目录临时文件 + rename 原子替换。
 * rename 替换的是目标条目本身，因此目标若是软链只会被替换，不会被跟写。
 * @param {string} filePath 绝对目标路径。
 * @param {string | Uint8Array} content 内容。
 * @returns {void}
 */
export function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const suffix = `${process.pid.toString(36)}-${crypto.randomBytes(4).toString('hex')}`
  const tempPath = path.join(dir, `.${base}.${suffix}.tmp`)
  const handle = fs.openSync(tempPath, 'wx', 0o600)
  try {
    if (typeof content === 'string') fs.writeFileSync(handle, content, 'utf8')
    else fs.writeFileSync(handle, content)
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  try {
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch { /* 临时文件清理失败不掩盖原始错误 */ }
    throw error
  }
}

/**
 * 在 root 内按相对路径原子写入。
 * @param {string} root 已规范化的根目录。
 * @param {string} relativePath root 内的相对路径。
 * @param {string | Uint8Array} content 内容。
 * @returns {void}
 */
export function writeContained(root, relativePath, content) {
  writeAtomic(resolveInside(root, relativePath), content)
}
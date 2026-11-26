/**
 * 文本脱敏：把可能被粘进对话里的凭证抹掉。
 *
 * 为什么默认开：镜像的产物是「整段对话原文」，而人一着急就会把 token、
 * API key、恢复码直接贴进聊天框。文件一旦落盘、又被同步/备份/分享出去，
 * 泄露就已经发生，事后删文件也收不回来。所以在写盘前抹掉最省事。
 *
 * 取舍：
 * - 只认「有固定形状」的凭证（前缀正则），不做泛化的高熵扫描——
 *   后者会把正常的长哈希、base64 图片、代码片段误伤成 [redacted]。
 * - 规则是纯函数、可单测；正则编译失败只报错不抛，避免一条写错的配置
 *   让整个插件停摆。
 */

/** 内置规则：都是业界有固定前缀或固定结构的凭证。 */
const BUILTIN_RULES = [
  { label: 'npm-token', source: 'npm_[A-Za-z0-9]{36}' },
  { label: 'github-token', source: '(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})' },
  { label: 'openai-key', source: 'sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}' },
  { label: 'slack-token', source: 'xox[baprs]-[A-Za-z0-9-]{10,}' },
  { label: 'aws-access-key', source: '(?:AKIA|ASIA)[0-9A-Z]{16}' },
  { label: 'google-api-key', source: 'AIza[0-9A-Za-z_-]{35}' },
]

/**
 * 生成替换标记。
 * @param {string} label 规则名。
 * @returns {string} 形如 `[redacted:npm-token]`。
 */
export function redactedMarker(label) {
  return `[redacted:${label}]`
}

/**
 * 编译脱敏规则：内置规则始终生效，`extra` 里的正则追加在后面。
 * @param {unknown} extra 用户配置的额外正则（字符串数组）。
 * @returns {{ rules: Array<{ label: string, re: RegExp }>, errors: string[] }}
 *   编译后的规则；非法项只在 errors 里留一条说明，不影响其余规则。
 */
export function compileRedactRules(extra) {
  const rules = []
  const errors = []
  for (const rule of BUILTIN_RULES) {
    rules.push({ label: rule.label, re: new RegExp(rule.source, 'gu') })
  }
  const list = Array.isArray(extra) ? extra : []
  let index = 0
  for (const item of list) {
    if (typeof item !== 'string' || item === '') {
      errors.push('脱敏规则必须是正则字符串，已忽略一个非字符串项')
      continue
    }
    index += 1
    try {
      rules.push({ label: `custom-${String(index)}`, re: new RegExp(item, 'gu') })
    } catch (error) {
      errors.push(`脱敏规则 /${item}/ 不是合法正则：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { rules, errors }
}

/**
 * 按规则抹掉文本里的凭证。
 * @param {string} text 原始文本。
 * @param {readonly { label: string, re: RegExp }[]} rules 编译后的规则。
 * @returns {string} 抹掉凭证后的文本。
 */
export function redactText(text, rules) {
  if (typeof text !== 'string' || text === '' || !Array.isArray(rules) || rules.length === 0) return text
  let output = text
  for (const rule of rules) {
    output = output.replace(rule.re, redactedMarker(rule.label))
  }
  return output
}
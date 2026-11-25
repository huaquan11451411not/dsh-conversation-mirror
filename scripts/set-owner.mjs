/**
 * 把仓库里的 OWNER 占位符替换成真实的 GitHub 用户名。
 *
 * 用法（在仓库根目录）：
 *   node scripts/set-owner.mjs <github-username>
 *
 * 只改这几处：package.json 的 repository/homepage/bugs、market/*.yml、
 * README 与 PUBLISH.md 里的示例链接。改完请 review 后提交。
 */
import fs from 'node:fs'
import path from 'node:path'

const owner = (process.argv[2] ?? '').trim()
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(owner)) {
  console.error('用法: node scripts/set-owner.mjs <github-username>')
  console.error('用户名规则：字母或数字开头，只含字母/数字/连字符，最长 39 字符。')
  process.exit(1)
}

const root = path.resolve(import.meta.dirname, '..')
const targets = [
  'package.json',
  'README.md',
  'PUBLISH.md',
  'market/awesome-dsh-plugin-entry.yml',
]

let touched = 0
for (const rel of targets) {
  const file = path.join(root, rel)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const next = text.replaceAll('OWNER', owner)
  if (next !== text) {
    fs.writeFileSync(file, next)
    touched++
    console.log(`已更新 ${rel}`)
  }
}

console.log(touched === 0 ? '没有需要替换的占位符。' : `完成，共更新 ${touched} 个文件。`)
console.log(`下一步：git add -A && git commit -m "chore: set repository owner"`)
console.log(`然后是 git config user.email "${owner}@users.noreply.github.com"`)
console.log(`以及 git commit --amend --reset-author --no-edit（把首个提交的作者也换成 noreply 身份）`)
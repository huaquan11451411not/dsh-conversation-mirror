import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { compileRedactRules, redactText } from '../lib/redact.js'
import { renderSessionMarkdown } from '../lib/render.js'
import {
  ensureDirInside,
  MirrorPathError,
  resolveInside,
  resolveRoot,
  safeSessionFileName,
  writeContained,
} from '../lib/store.js'

const SESSION_ID = 'session-test-0001-aaaa-bbbb'

/** 造一份最小的 V4 事件流：一轮用户提问 + 思考 + 一次工具调用 + 最终回复。 */
function sampleEvents() {
  return [
    { type: 'session', version: 4, id: SESSION_ID, createdAt: 1795603913187, cwd: 'C:\\work' },
    { type: 'session/title', seq: 2, time: 1795603913200, data: { title: '测试会话标题' } },
    { type: 'turn/start', seq: 3, time: 1795603914000, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 4,
      time: 1795603915000,
      data: { content: [{ type: 'text', text: '帮我看一下磁盘' }], source: { kind: 'user' } },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message',
      seq: 5,
      time: 1795603916000,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先查一下再回答。' },
            { type: 'text', text: '我去看看。' },
            { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"cmd":"df -h"}' },
          ],
        },
      },
      surfaceOp: 'append',
    },
    { type: 'tool/call', seq: 6, time: 1795603916100, data: { turn: 1, callId: 'call_1', name: 'bash', arguments: '{"cmd":"df -h"}' } },
    {
      type: 'tool/result',
      seq: 7,
      time: 1795603917000,
      data: {
        turn: 1,
        message: { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'C: free 61.7 GB' }], isError: false },
      },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message',
      seq: 8,
      time: 1795603918000,
      data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'C 盘还剩 61.7 GB。' }] } },
      surfaceOp: 'append',
    },
    { type: 'turn/end', seq: 9, time: 1795603919000, data: { turn: 1 } },
  ]
}

/** 假 Cordis 上下文：只实现插件用到的 on/get/effect/logger。 */
function fakeContext(snapshot) {
  const listeners = new Map()
  const cleanups = []
  const warnings = []
  const context = {
    warnings,
    logger: { warn: (message) => warnings.push(message), info: () => {} },
    get: (name) => (name === 'sessionQuery' ? { readSession: async () => snapshot } : undefined),
    on: (type, handler) => {
      listeners.set(type, handler)
    },
    effect: (factory) => {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    emit: (type, ...args) => listeners.get(type)?.(...args),
    dispose: () => {
      for (const cleanup of cleanups) cleanup()
    },
  }
  return context
}

/** 造一个临时镜像根目录。 */
function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-test-'))
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

test('渲染：标题、用户原文、思考折叠、工具调用与结果、助手回复', () => {
  const markdown = renderSessionMarkdown(sampleEvents(), {
    sessionId: SESSION_ID,
    cwd: 'C:\\work',
    createdAt: 1795603913187,
    now: 1795603920000,
  })
  assert.match(markdown, /^# 测试会话标题\n/u)
  assert.match(markdown, /- 会话 ID: `session-test-0001-aaaa-bbbb`/u)
  assert.match(markdown, /- 工作目录: `C:\\work`/u)
  assert.match(markdown, /## 第 1 轮 · /u)
  assert.match(markdown, /### 👤 用户\n\n帮我看一下磁盘/u)
  assert.match(markdown, /<details><summary>🧠 思考过程<\/summary>\n\n先查一下再回答。/u)
  assert.match(markdown, /### 🤖 助手 · 步骤 1\n\n<details>/u)
  assert.match(markdown, /<\/details>\n\n我去看看。/u)
  assert.match(markdown, /\*\*Tool: `bash`\*\*/u)
  assert.match(markdown, /```json\n\{"cmd":"df -h"\}\n```/u)
  assert.match(markdown, /C: free 61\.7 GB/u)
  assert.match(markdown, /### 🤖 助手 · 步骤 2\n\nC 盘还剩 61\.7 GB。/u)
  assert.ok(markdown.endsWith('\n') && !markdown.endsWith('\n\n'), '应以单个换行结尾')
})

test('渲染：超长工具结果被截断并标注剩余字符', () => {
  const long = 'x'.repeat(50)
  const events = sampleEvents().map((event) => event.type === 'tool/result'
    ? {
        ...event,
        data: { ...event.data, message: { ...event.data.message, content: [{ type: 'text', text: long }] } },
      }
    : event)
  const markdown = renderSessionMarkdown(events, { sessionId: SESSION_ID, maxToolResult: 10 })
  assert.ok(!markdown.includes(long), '不应包含原始超长结果')
  assert.match(markdown, /x{10}/u)
  assert.match(markdown, /…（已截断，剩余 40 字符）/u)
})

test('渲染：跳过 harness 注入的上下文，并按 data.turn 归轮', () => {
  const events = [
    { type: 'session', version: 4, id: SESSION_ID, createdAt: 1795603913187, cwd: 'C:\\work' },
    {
      type: 'user/message',
      seq: 2,
      time: 1795603915000,
      data: {
        turn: 7,
        content: [{ type: 'text', text: '<system-reminder>\n这些只是注入内容\n</system-reminder>' }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    },
    {
      type: 'user/message',
      seq: 3,
      time: 1795603916000,
      data: { turn: 7, content: [{ type: 'text', text: '真正的问题' }], source: { kind: 'user' } },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message',
      seq: 4,
      time: 1795603917000,
      data: { turn: 7, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '答案' }] } },
      surfaceOp: 'append',
    },
    { type: 'turn/end', seq: 5, time: 1795603918000, data: { turn: 7 } },
  ]
  const markdown = renderSessionMarkdown(events, { sessionId: SESSION_ID })
  assert.ok(!markdown.includes('这些只是注入内容'), '注入内容不应出现在导出里')
  assert.match(markdown, /## 第 7 轮 · /u, '轮次编号应取自 data.turn')
  assert.match(markdown, /### 👤 用户\n\n真正的问题/u)
})

test('写盘：落盘文件带 UTF-8 BOM', async () => {
  const root = resolveRoot(tempRoot())
  const snapshot = { session: { id: SESSION_ID, cwd: 'C:\\work', createdAt: 1795603913187 }, events: sampleEvents() }
  const context = fakeContext(snapshot)
  apply(context, { dir: root, debounceMs: 1 })
  context.emit('session/event', { id: SESSION_ID }, { type: 'turn/end' })
  await sleep(120)
  const written = fs.readFileSync(path.join(root, 'sessions', `${SESSION_ID}.md`))
  assert.deepEqual([...written.subarray(0, 3)], [0xef, 0xbb, 0xbf], '应以 UTF-8 BOM 开头')
  context.dispose()
})

test('配置：不给 dir 时落到「用户主目录/dsh-conversations」', async () => {
  const home = tempRoot()
  const previous = process.env.USERPROFILE
  process.env.USERPROFILE = home
  try {
    const snapshot = { session: { id: SESSION_ID, cwd: 'C:\\work', createdAt: 1795603913187 }, events: sampleEvents() }
    const context = fakeContext(snapshot)
    apply(context, { debounceMs: 10 })
    context.emit('session/event', { id: SESSION_ID }, { type: 'turn/end' })
    await sleep(120)
    const expected = path.join(home, 'dsh-conversations', 'sessions', `${SESSION_ID}.md`)
    assert.ok(fs.existsSync(expected), `应写到默认目录: ${expected}`)
    assert.equal(context.warnings.length, 0, '默认目录不应产生警告')
    context.dispose()
  } finally {
    if (previous === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previous
  }
})

test('端到端：子代理会话归档但不抢 latest.md', async () => {
  const root = resolveRoot(tempRoot())
  const subId = '11111111-2222-3333-4444-555555555555'
  const snapshot = {
    session: { id: subId, cwd: 'C:\\work', createdAt: 1795603913187, delegationDepth: 1 },
    events: sampleEvents(),
  }
  const context = fakeContext(snapshot)
  apply(context, { dir: root, debounceMs: 10 })
  context.emit('session/event', { id: subId }, { type: 'turn/end' })
  await sleep(120)
  assert.ok(fs.existsSync(path.join(root, 'sessions', `${subId}.md`)), '子会话仍应归档')
  assert.equal(fs.existsSync(path.join(root, 'latest.md')), false, 'latest.md 不应被一次性子任务覆盖')
  context.dispose()
})

test('文件名净化：正常 id 原样保留，异常 id 不含路径分隔符', () => {
  assert.equal(safeSessionFileName(SESSION_ID), SESSION_ID)
  assert.equal(safeSessionFileName('..'), safeSessionFileName('..'))
  for (const hostile of ['../../evil', 'C:\\Windows\\System32\\x', 'a/b', '..\\..\\evil', '   ', 'x'.repeat(200)]) {
    const name = safeSessionFileName(hostile)
    assert.ok(name.length > 0)
    assert.ok(!name.includes('/') && !name.includes('\\'), `不应含分隔符: ${name}`)
    assert.ok(!name.startsWith('.'), `不应以点开头: ${name}`)
    assert.ok(name.length <= 100, `不应超长: ${name.length}`)
  }
  assert.notEqual(safeSessionFileName('../a'), safeSessionFileName('../b'), '净化后仍需区分')
})

test('路径收敛：拒绝越界与绝对路径目标', () => {
  const root = resolveRoot(tempRoot())
  assert.throws(() => resolveInside(root, '../escape.md'), MirrorPathError)
  assert.throws(() => resolveInside(root, path.join(root, 'abs.md')), MirrorPathError)
  assert.throws(() => resolveRoot('relative\\dir'), MirrorPathError)
  assert.throws(() => resolveRoot('D:\\'), MirrorPathError)
  assert.ok(resolveInside(root, path.join('sessions', 'a.md')).startsWith(root))
})

test('写盘：软链目录被拒绝', () => {
  const root = resolveRoot(tempRoot())
  const realDir = path.join(root, 'real')
  fs.mkdirSync(realDir)
  fs.symlinkSync(realDir, path.join(root, 'linkdir'), 'junction')
  assert.throws(() => ensureDirInside(root, 'linkdir'), MirrorPathError)
})

test('写盘：rename 替换软链本身而不跟随改写（需软链权限，无权限则跳过）', (t) => {
  const root = resolveRoot(tempRoot())
  const sessions = ensureDirInside(root, 'sessions')
  const outside = path.join(root, 'victim.md')
  fs.writeFileSync(outside, 'original')
  const target = path.join(sessions, 'x.md')
  try {
    fs.symlinkSync(outside, target, 'file')
  } catch (error) {
    t.skip(`当前账户无法创建文件软链（${error.code}），跳过该项`)
    return
  }
  writeContained(root, path.join('sessions', 'x.md'), 'mirrored')
  assert.equal(fs.readFileSync(outside, 'utf8'), 'original', '软链指向的文件不应被改写')
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false, '目标条目应被替换成普通文件')
  assert.equal(fs.readFileSync(target, 'utf8'), 'mirrored')
})

test('端到端：turn/end 后写出 sessions/<id>.md 与 latest.md', async () => {
  const root = tempRoot()
  const snapshot = { session: { id: SESSION_ID, cwd: 'C:\\work', createdAt: 1795603913187 }, events: sampleEvents() }
  const ctx = fakeContext(snapshot)
  apply(ctx, { dir: root, debounceMs: 10 })

  ctx.emit('session/event', { id: SESSION_ID }, { type: 'step/end' })
  await sleep(60)
  assert.equal(fs.existsSync(path.join(root, 'sessions', `${SESSION_ID}.md`)), false, '非 turn/end 不应触发')

  ctx.emit('session/event', { id: SESSION_ID }, { type: 'turn/end' })
  await sleep(120)

  const file = path.join(root, 'sessions', `${SESSION_ID}.md`)
  const latest = path.join(root, 'latest.md')
  assert.ok(fs.existsSync(file), '应写出会话文件')
  assert.ok(fs.existsSync(latest), '应写出 latest.md')
  const markdown = fs.readFileSync(file, 'utf8')
  assert.match(markdown, /## 第 1 轮 · /u)
  assert.equal(fs.readFileSync(latest, 'utf8'), markdown)
  ctx.dispose()
})

test('端到端：恶意会话 id 不会写出根目录之外', async () => {
  const parent = tempRoot()
  const root = path.join(parent, 'mirror')
  fs.mkdirSync(root)
  const hostileId = '../../escape'
  const snapshot = { session: { id: hostileId, cwd: 'C:\\work' }, events: sampleEvents() }
  const ctx = fakeContext(snapshot)
  apply(ctx, { dir: root, debounceMs: 10 })
  ctx.emit('session/event', { id: hostileId }, { type: 'turn/end' })
  await sleep(120)

  const written = fs.readdirSync(path.join(root, 'sessions'))
  assert.equal(written.length, 1)
  assert.ok(!written[0].includes('..') && !written[0].includes('/') && !written[0].includes('\\'))
  assert.deepEqual(fs.readdirSync(parent).sort(), ['mirror'], '父目录不应多出任何东西')
  ctx.dispose()
})

test('配置非法时停用并只记一条 warning', () => {
  const ctx = fakeContext({ session: {}, events: sampleEvents() })
  apply(ctx, { dir: 'relative\\dir', debounceMs: 10 })
  ctx.emit('session/event', { id: SESSION_ID }, { type: 'turn/end' })
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /未启用/u)
})

const NPM_TOKEN = `npm_${'A'.repeat(36)}`
const GH_TOKEN = `ghp_${'B'.repeat(36)}`

/** 把用户消息换成一段含凭证的文本。 */
function eventsWithSecret(secret) {
  return sampleEvents().map((event) => event.type === 'user/message'
    ? { ...event, data: { ...event.data, content: [{ type: 'text', text: `这是我的令牌 ${secret} 别外传` }] } }
    : event)
}

test('脱敏：默认抹掉常见凭证，保留周围文案', () => {
  const markdown = renderSessionMarkdown(eventsWithSecret(NPM_TOKEN), {
    sessionId: SESSION_ID,
    redactRules: compileRedactRules().rules,
  })
  assert.ok(!markdown.includes(NPM_TOKEN), 'NPM token 不应出现在导出里')
  assert.match(markdown, /\[redacted:npm-token\]/u)
  assert.match(markdown, /这是我的令牌 .* 别外传/u, '周围文案应保留')
  const gh = renderSessionMarkdown(eventsWithSecret(GH_TOKEN), {
    sessionId: SESSION_ID,
    redactRules: compileRedactRules().rules,
  })
  assert.ok(!gh.includes(GH_TOKEN))
  assert.match(gh, /\[redacted:github-token\]/u)
})

test('脱敏：redactText 不改动普通文本，也不漏抹多处凭证', () => {
  const rules = compileRedactRules().rules
  assert.equal(redactText('磁盘还剩 61.7 GB，没有 token。', rules), '磁盘还剩 61.7 GB，没有 token。')
  const two = `a ${NPM_TOKEN} b ${GH_TOKEN} c`
  const out = redactText(two, rules)
  assert.ok(!out.includes(NPM_TOKEN) && !out.includes(GH_TOKEN))
  assert.equal(out.match(/\[redacted:/gu)?.length, 2)
})

test('端到端：自定义 redactPatterns 生效', async () => {
  const root = resolveRoot(tempRoot())
  const snapshot = { session: { id: SESSION_ID, cwd: 'C:\\work' }, events: eventsWithSecret('SECRET-1234') }
  const ctx = fakeContext(snapshot)
  apply(ctx, { dir: root, redactPatterns: ['SECRET-[0-9]{4}'], debounceMs: 10 })
  ctx.emit('session/event', { id: SESSION_ID }, { type: 'turn/end' })
  await sleep(120)
  const markdown = fs.readFileSync(path.join(root, 'sessions', `${SESSION_ID}.md`), 'utf8')
  assert.ok(!markdown.includes('SECRET-1234'), '自定义规则应生效')
  assert.match(markdown, /\[redacted:custom-1\]/u)
  assert.equal(ctx.warnings.length, 0)
  ctx.dispose()
})

test('端到端：redact: false 时保留原文（自己承担风险）', async () => {
  const root = resolveRoot(tempRoot())
  const snapshot = { session: { id: SESSION_ID, cwd: 'C:\\work' }, events: eventsWithSecret(NPM_TOKEN) }
  const ctx = fakeContext(snapshot)
  apply(ctx, { dir: root, redact: false, debounceMs: 10 })
  ctx.emit('session/event', { id: SESSION_ID }, { type: 'turn/end' })
  await sleep(120)
  const markdown = fs.readFileSync(path.join(root, 'sessions', `${SESSION_ID}.md`), 'utf8')
  assert.ok(markdown.includes(NPM_TOKEN), '关掉脱敏后应保留原文')
  ctx.dispose()
})

test('脱敏：非法正则只记 warning，不影响其余规则与写盘', async () => {
  const root = resolveRoot(tempRoot())
  const snapshot = { session: { id: SESSION_ID, cwd: 'C:\\work' }, events: eventsWithSecret(NPM_TOKEN) }
  const ctx = fakeContext(snapshot)
  apply(ctx, { dir: root, redactPatterns: ['('], debounceMs: 10 })
  ctx.emit('session/event', { id: SESSION_ID }, { type: 'turn/end' })
  await sleep(120)
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /不是合法正则/u)
  const markdown = fs.readFileSync(path.join(root, 'sessions', `${SESSION_ID}.md`), 'utf8')
  assert.ok(!markdown.includes(NPM_TOKEN), '内置规则仍应生效')
  ctx.dispose()
})
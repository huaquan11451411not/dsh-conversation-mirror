# 发布到 GitHub 与 DSH 插件市场

本文件是一份**可自己照做的操作清单**。仓库里不含任何账号、邮箱、机器路径或其它个人信息，
`package.json` / `market/*.yml` 里的 `huaquan11451411not` 是占位符，发布前替换成你的 GitHub 用户名。

## 0. 隐私边界（发布前必读）

已经做过的处理：

- 代码与文档里**没有**真实机器路径、Windows 用户名、会话 ID、邮箱、令牌。`grep` 自查命令见最后一节。
- 默认配置不留任何人的真实目录：`dir` 留空时落到「用户主目录/dsh-conversations」。
- `.gitignore` 挡住 `dsh-conversations/`、`dsh-transcripts/`、`.dsh/`、`*.log` 等本机运行产物
  （插件会把真实对话内容写进这些目录，**绝不能提交**）。
- `LICENSE` 的版权方写的是 "dsh-conversation-mirror contributors"，不是个人姓名。

提交时还要注意两件事：

1. **git 提交者身份会被永久写进历史**。不要用真实邮箱。用 GitHub 的 noreply 地址：

   ```bash
   git config user.name "huaquan11451411not"
   git config user.email "huaquan11451411not@users.noreply.github.com"
   ```

   （在 GitHub → Settings → Emails 勾选 "Keep my email addresses private" 后，页面会给出带数字 ID 的
   `12345678+huaquan11451411not@users.noreply.github.com`，用那个更好。）
2. **提交前确认工作区里没混进本机文件**：`git status --short` 里不应出现 `dsh-conversations/`
   或任何 `.md` 对话导出。

## 1. 建仓库并推送

```bash
cd dsh-conversation-mirror
# 把 huaquan11451411not 换成你的 GitHub 用户名（package.json、market/*.yml、README 里的链接）
git init -b main
git config user.name "huaquan11451411not"
git config user.email "huaquan11451411not@users.noreply.github.com"
git add -A
git status --short          # 自查：不应出现对话导出、日志、node_modules
git commit -m "feat: dsh-conversation-mirror 0.1.0"
git remote add origin https://github.com/huaquan11451411not/dsh-conversation-mirror.git
git push -u origin main
```

没有 `gh` CLI 时用网页建空仓库（不要勾选自动生成 README，否则要 rebase）。

## 2. GitHub 仓库设置

- **About → Topics** 加上 `dsh-plugin`（另有市场会按这个 topic 自动抓取），建议再补
  `deepseek-harness`、`dsh`、`cordis`、`transcript`。
- About 描述填一句人话，例如「每轮结束把会话导出成可读 Markdown」。
- 打一个 Release `v0.1.0`（可选，但 `tarball` 安装方式需要它）。

**注意：awesome-dsh-plugin 的 CI 要求仓库创建满 1 天**才能受理目录 PR，当天建的仓库会被挡。

## 3. 发布 npm 包（解锁一键安装）

本机 `~/.npmrc` 的 registry 是 npmmirror 镜像，**不能用来发布**，必须显式指定官方源：

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami  --registry=https://registry.npmjs.org/
npm publish --dry-run   # 先看打进去的文件清单，确认没有多余文件
npm publish
npm view dsh-conversation-mirror version
```

`publishConfig.registry` 已写死官方源，`publishConfig.access` 为 `public`。
包名 `dsh-conversation-mirror` 在官方 registry 上尚未被占用（2026-11-25 查证）。

**npm 现在强制发布走 2FA**，账号没开 2FA 时会直接 403：

```
403 Forbidden - PUT https://registry.npmjs.org/<pkg>
Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

注意这个 403 **不是验证码提示**——registry 不发 `www-authenticate` 挑战头，所以
`npm publish --otp=<code>` 在「账号还没开 2FA」时也不会生效，重试只会得到同样的错误。
两条出路：

1. **开 2FA**（推荐长期用）：npmjs.com → Account → Two-Factor Authentication，选包含
   "writes" 的模式；之后 `npm publish` 会弹 6 位码，或用 `npm publish --otp=<code>`。
2. **Granular Access Token + Bypass 2FA**（CI 或不装验证器 App 时）：npmjs.com → Access Tokens
   → Generate New Token → **Granular**，权限选 Read and write，勾上
   **"Bypass two-factor authentication for this token"**，然后：

   ```bash
   npm publish --//registry.npmjs.org/:_authToken=npm_xxxxxxxx
   ```

   注意 npm 已公告收紧 bypass 2FA token：账号类操作自 2026-08 起、直接发布自 2027-01 起
   不再支持，长期仍建议改用 2FA 或 Trusted Publishing（OIDC）。
   token 只显示一次，用完立刻在网页上 revoke，别写进仓库或全局 `.npmrc`。

## 4. 上架插件市场（awesome-dsh-plugin）

市场（dsh-market / Discover）每次打开时读取 `https://awesome-dsh-plugin.com/plugins.json`，
该文件由 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
的 `data/plugins/*.yml` 生成。**没有「上传安装包」的入口，唯一投稿渠道是给这个仓库提 PR。**

1. Fork 该仓库，新建 `data/plugins/huaquan11451411not__dsh-conversation-mirror.yml`
   （模板见本仓库 `market/awesome-dsh-plugin-entry.yml`，把 `huaquan11451411not` 换掉即可）；
2. 一个 PR 只加这一条（单 PR 上限 3 条，且不能改动别人的条目）；
3. 提 PR 时按仓库的 `contributing.md` / PR 模板填写；
4. 合并后通常一天内出现在市场里，安装命令为：

   ```bash
   dsh plugin --profile web add dsh-conversation-mirror -w
   ```

   （`web` 是常见 profile 名；按你自己的 profile 替换，例如 `desktop`。)

## 5. 发布后自查

```bash
npm view dsh-conversation-mirror readme | head -40   # README 是否跟随发布
dsh plugin --profile web add dsh-conversation-mirror -w
dsh web --dump-config | grep -A2 conversation-mirror
```

装完**必须重启 dsh web**——运行中的实例不会热载 bundle 层。

## 6. 隐私自查命令

```bash
grep -rIn -E '(Users[\\/][A-Za-z0-9]|/home/[A-Za-z0-9]|[A-Za-z]:\\\\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,})' \
  --exclude-dir=.git .
```

预期只命中 `LICENSE` 里的 `dsh-conversation-mirror contributors` 这类非个人信息，
以及测试里刻意用的假 UUID（`11111111-2222-3333-4444-555555555555`）。
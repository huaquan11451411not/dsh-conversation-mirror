# 0.1.1

- 新增脱敏：写盘前抹掉常见凭证（`npm_`、`ghp_`/`github_pat_`、`sk-`、`xoxb-`、`AKIA`/`ASIA`、`AIza`），统一替换成 `[redacted:<规则名>]`。
- 新增配置 `redact`（默认 `true`）与 `redactPatterns`（追加自定义正则，非法正则只记 warning 不抛错）。
- `md` 与 `jsonl` 两种产物都会脱敏。

# 0.1.0

首个发布版本。

- 监听 DSH 的 `session/event`，每轮结束（`turn/end`）把该会话渲染成中文 Markdown 并原子写入 `dir`。
- 产出 `sessions/<session-id>.md` 与 `latest.md`（子代理会话归档但不更新 `latest.md`）。
- 支持 `md` / `jsonl` 两种格式，工具结果、思考过程、注入上下文分别处理。
- 写盘安全：根目录校验、路径收敛、文件名净化、软链拒绝、8 MiB 上限、同目录临时文件 + rename。
- 无轮询、无网络、无子进程、无动态代码加载。
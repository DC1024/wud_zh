# wud-success-update.js — WUD 容器更新成功邮件脚本

配合 [wud_zh](https://github.com/DC1024/wud_zh)（What's up Docker 中文 fork）的
`command.update` 触发器使用：驱动 `docker.local` 触发器完成更新（拉取 → 重建），
然后在轮询确认收敛后发送**成功/失败邮件**。

## 功能要点（四修版，2026-10-14）

1. **按容器名轮询**而非容器 id —— WUD 更新会重建容器，id 必变，按 id 轮询必然 404 超时误报。
2. **三条成功判据**（满足其一即可）：
   - `updateAvailable` 变为 `false`（本机与 registry 收敛）；
   - 本机镜像 digest 相比更新前发生变化（镜像被替换）；
   - 容器 id 已变（被重建过）且本机 digest 已等于目标 digest。
   多判据是为了容忍「WUD 的 hub 源」与「dockerd 的 registry-mirrors」缓存不同步导致的收敛滞后。
3. **API 调用 3 次容错重试** —— WUD 重启/抖动时一次 `fetch failed` 不再误报失败。
4. **三修：轮询中主动让 WUD 重查** —— 重建后 WUD 不会自动重新评估容器，
   每 30s 对该容器 `POST /api/containers/:id/watch`，否则成功判据永远等不到。
5. **四修：行缺失时主动全量重扫** —— 重建后的新容器行**不会自动回到 store**，
   按 id 查不到时（第一次 miss 立即 + 每 30s）触发 `POST /api/containers/watch` 让新行落库。
6. **幂等冷却护栏**：按容器名记录 `last-update` 标记，30 分钟冷却期内重复触发直接跳过，
   防止「更新 → 重建 → 又触发更新」自激循环。
7. 结局写入 marker 文件（`ok=true/false/null`），便于外部审计与排查。

## 背景知识（踩坑实录）

- wud_zh fork 在容器重建后**不会自动重查**：API 里的 `updateAvailable` 保持旧值，
  只有每日 cron（默认 04:00）或手动 watch 会重新评估。自动化流程必须主动触发重查。
- **新容器行不自动落库**：docker 重建后，store 里是旧行（旧 id），新行要等下一次重扫才出现。
- WUD 版本检查（hub 源）与实际拉镜像（dockerd `registry-mirrors`）是两条独立通路，
  报「更新失败」时先分清是哪条断了。
- digest 有两层语义：WUD 取的是平台 manifest 层 digest，docker `RepoDigest` 是 index 层 digest，
  同一镜像两种表示，不要当成两个版本。

## 部署

脚本由 WUD 容器执行（以 `command.update` 触发器 spawn，子进程随 WUD 容器停止而终止），
需要能访问 WUD API 并发出 SMTP 邮件。

1. 把脚本放到 WUD 容器挂载的可访问路径（示例：宿主机 `/data_n002/wud-store/` → 容器内 `/store/`）。
2. 在 WUD 中为容器添加 `command.update` 触发器（auto=true），命令类似：

   ```
   node /store/wud-success-update.js
   ```

   WUD 会通过环境变量 `container_json` 传入完整容器对象。
3. 凭据通过环境变量注入（WUD 触发器配置或容器 env），不要写死在脚本里：

   | 变量 | 含义 |
   |---|---|
   | `WUD_AUTH` | WUD API basic auth，格式 `user:password` |
   | `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | SMTP 服务器与凭据（465 端口 secure） |
   | `MAIL_TO` / `MAIL_FROM` | 收件 / 发件地址 |

4. 测试模式：设 `WUD_SKIP_UPDATE=1` 跳过实际触发更新，仅走轮询+邮件逻辑。

## Marker 文件

`/store/.wud-last-update-<容器名>.json`：

```json
{"ts": 1791952593762, "time": "2026/10/14 12:36:33", "ok": true,
 "reason": "updateAvailable 已变为 false（本机与 registry 收敛）"}
```

- `ok: null` = 进行中；`true/false` = 结局。
- 30 分钟冷却期以 marker 的 `ts` 为准。

## 已验证

2026-10-14 在生产环境用临时容器（跑旧 digest 镜像 + 设为被监控 + 全量重扫）做了
无风险全链路演练：发现新版 → 拉取重建（16s）→ 脚本确认收敛 → 成功邮件落地，全程约 1 分钟。

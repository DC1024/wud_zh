#!/usr/bin/env bash
set -e

# ── ops 资产同步 ───────────────────────────────────────────────────────
# 镜像内的 ops/（更新成功脚本 + 版本戳）在启动时同步到 /store（bind mount），
# 这样一次 `docker pull` 就能同时交付应用与脚本修复，无需再手工传文件。
# 硬约束：幂等、失败只告警、绝不 exit 1 —— 否则下面的 set -e 会让容器起不来。
# 日志一律写 stderr，避免污染 `exec "$@" | pino-pretty` 的 stdout 管道。
sync_ops_assets() {
  set +e
  local src=/opt/wud-ops
  local dst=/store

  [ -d "$src" ] || return 0
  [ -f "$src/wud-success-update.js" ] || return 0
  mkdir -p "$dst" 2>/dev/null || return 0

  # 用户手工热修优先：存在该标记时完全跳过覆盖
  if [ -f "$dst/.ops-local-override" ]; then
    echo "[ops-sync] skip: $dst/.ops-local-override present" >&2
    return 0
  fi

  local want=unknown
  [ -f "$src/VERSION" ] && want="$(tr -d '[:space:]' < "$src/VERSION")"
  local have=
  [ -f "$dst/.ops-version" ] && have="$(tr -d '[:space:]' < "$dst/.ops-version")"

  if [ "$want" = "$have" ] && [ -f "$dst/wud-success-update.js" ]; then
    echo "[ops-sync] up to date ($want)" >&2
    return 0
  fi

  # 覆盖前把现网脚本按版本 + 时间戳备份，保留手工回退能力
  if [ -f "$dst/wud-success-update.js" ]; then
    local backup="$dst/backups/pre-ops-${want}-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$backup" 2>/dev/null &&
      cp -a "$dst/wud-success-update.js" "$backup/" 2>/dev/null &&
      echo "[ops-sync] backup -> $backup" >&2
  fi

  if ! cp -f "$src/wud-success-update.js" "$dst/wud-success-update.js" 2>/dev/null; then
    echo "[ops-sync] copy failed, keeping existing script" >&2
    return 0
  fi

  printf '%s\n' "$want" > "$dst/.ops-version" 2>/dev/null
  echo "[ops-sync] synced ops $want -> $dst/wud-success-update.js" >&2
  return 0
}

# 子 shell 隔离：函数内的 set +e 不会影响后续 exec 分支
( sync_ops_assets ) || true

# Node 24 runtime proxy support: enable --use-env-proxy when proxy env vars are set
if [ -n "${HTTP_PROXY:-}" ] || [ -n "${HTTPS_PROXY:-}" ] || \
   [ -n "${http_proxy:-}" ] || [ -n "${https_proxy:-}" ] || \
   [ -n "${ALL_PROXY:-}" ] || [ -n "${all_proxy:-}" ]; then
  if [[ "${NODE_OPTIONS:-}" != *"--use-env-proxy"* ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--use-env-proxy"
  fi
fi

# One-shot headless mode: run `node dist/index <command>` directly so the
# JSON output on stdout is never piped through pino-pretty.
# Usage: docker run -e WUD_RUN_MODE=oneshot getwud/wud watch
if [ "${WUD_RUN_MODE}" == "oneshot" ]; then
  if [ "$1" == "node" ] && [ "$2" == "dist/index" ]; then
    shift 2
  fi
  exec node dist/index "$@"
fi

if [ "$1" == "node" ] && [ "$2" == "dist/index" ] && [ "${WUD_LOG_FORMAT}" != "json" ]; then
  "$@" | ./node_modules/.bin/pino-pretty \
    --translateTime "SYS:yyyy-mm-dd HH:MM:ss.l" \
    --ignore pid,hostname,name,component \
    --messageFormat '{if component}[{component}] {end}{msg}' &
  PIPE_PID=$!
  NODE_PID=$(jobs -p)

  forward_signal() {
    local sig="$1"
    kill -s "$sig" $NODE_PID 2>/dev/null || true
  }

  trap 'forward_signal TERM' SIGTERM
  trap 'forward_signal INT' SIGINT

  wait "$PIPE_PID" 2>/dev/null || true
  wait "$PIPE_PID" 2>/dev/null
  STATUS=$?
  exit $STATUS
else
  exec "$@"
fi

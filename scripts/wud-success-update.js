"use strict";
// WUD command trigger 脚本：驱动 docker.local 完成更新，更新完成后发成功/失败邮件。
// 由 WUD command 触发器以环境变量 container_json 传入完整容器对象。
//
// ── 成功判据（满足其一即视为已更新）──────────────────────────────
//   a) updateAvailable 变为 false  —— 本机镜像与 registry 已收敛（常规情况）；
//   b) 本机镜像 digest（value 或 repo）相比更新前发生变化 —— 镜像确实被替换了；
//   c) 容器 id 已变（说明被重建过）且本机 digest 已等于目标 digest。
//   为什么需要 b/c)：拉取走的是 docker daemon 的 registry-mirrors，
//   而 WUD 的远端 digest 查的是 WUD_REGISTRY_HUB_URL，两者是不同缓存，
//   镜像站落后时 updateAvailable 会一直为 true，只用 (a) 会误报「更新失败」。
//
// ── 2026-10-14 重要修复：按「容器名」轮询，不再按「容器 id」──────────
//   旧实现是 `GET /api/containers/<id>`，而 WUD 的 docker 更新会**重建容器**，
//   id 必然变化 → 旧 id 立刻 404 → 脚本永远观察不到 updateAvailable=false
//   或 digest 变化 → 35 分钟后一律判「更新超时/失败」。
//   结果：更新成功说失败、更新失败也说失败，从没发过「成功」邮件。
//   现改为 `GET /api/containers?name=<容器名>`（WUD 该参数是精确匹配）
//   重新定位重建后的新行，再按上面三条判据判断。
//
// ── 幂等/冷却护栏（防自激循环）────────────────────────────────
//   WUD 的容器 id 是 docker 容器 hash，更新会重建容器 → id 变化 →
//   旧行被 prune、新行按「首次见到」插入 → containerReport.changed = true →
//   触发器再次触发。若此时 updateAvailable 仍为 true（上面的镜像站滞后场景），
//   就会「更新 → 重建 → 又更新」无限循环（2026-09-24 实测过：容器内出现 3 个
//   并发本脚本，并发出误报的「更新失败」邮件）。
//   因此这里按容器名记一个 last-update 标记：冷却期内直接跳过。
//   冷却期只需大于「一轮更新耗时」（拉取 + 重建 + 轮询，约 5~10 分钟）即可打断循环，
//   因为一旦跳过就不会再有重建，也就不会再有下一次触发。
const fs = require('fs');
const nodemailer = require('/home/node/app/node_modules/nodemailer');

const AUTH = process.env.WUD_AUTH || 'admin:<YOUR_WUD_PASSWORD>';
const BASE = 'http://127.0.0.1:3000';
const MAIL = {
  host: process.env.SMTP_HOST || 'smtp.example.com',
  port: 465,
  secure: true,
  auth: { user: process.env.SMTP_USER || '<YOUR_SMTP_USER>', pass: process.env.SMTP_PASS || '<YOUR_SMTP_PASS>' },
};
const TO = process.env.MAIL_TO || '<YOUR_EMAIL>';
const FROM = process.env.MAIL_FROM || 'WUD <YOUR_EMAIL>';
// 大镜像（如 ollama 5.46GB）拉取慢，窗口放宽到 35min
const DEADLINE_MS = 35 * 60 * 1000;
// 冷却期：同一容器的重复触发在这个窗口内一律忽略
const COOLDOWN_MS = 30 * 60 * 1000;
const POLL_MS = 10000;
// 超过这个时长一直查不到同名容器（重建未完成 / 容器没起来）就记一条日志
const MISS_LOG_EVERY = 6; // 每 6 轮（60s）打一次
const MARKER_DIR = '/store';

// ── 2026-10-14 三次修复：轮询中主动请求 WUD 重查该容器 ─────────────
//   此 fork 重建容器后**不会自动重查**（只有每天 04:00 cron / 手动 watch
//   会重新评估），API 轮询读到的 updateAvailable 一直是重建前的旧值，
//   成功判据 (a) 永远等不到。
//   当天 magpie 案例：10:56:39 重建成功，轮询等到 11:05 仍拿不到
//   「已收敛」证据（脚本随后被容器重启一同杀掉，成功邮件未能发出）。
//   现在每 REFRESH_EVERY 轮（30s）对该容器 POST /api/containers/:id/watch，
//   让 WUD 把新状态写回 store，下一轮轮询即可确认。
const REFRESH_EVERY = 3; // 每 3 轮（30s）触发一次重查

// ── 2026-10-14 二次修复：API 调用加容错重试 ──────────────────────
//   现场故障：脚本调 WUD API 时正好撞上 WUD 容器重启（23:55→00:31 重启 6 次，
//   期间 /store/wud.sqlite 还报过 database disk image is malformed），
//   fetch 抛一次 'fetch failed' 就被 catch 成「更新调用失败」→ 立刻发失败邮件；
//   而 WUD 两分钟后就恢复并成功完成了更新。
//   所以：网络层异常 / 5xx 一律重试，不要一次失败就判死。
//   POST 只在「网络层异常」时重试（请求没送达才会抛），5xx 不重试，
//   避免 WUD 已经收到指令、重试又触发一次重建。
const API_RETRIES = 3; // 总尝试次数
const API_RETRY_MS = 10000; // 每次重试间隔

async function once(path, opts) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + Buffer.from(AUTH).toString('base64'),
  };
  return fetch(BASE + path, { ...opts, headers });
}

async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  let lastErr = null;
  for (let i = 1; i <= API_RETRIES; i += 1) {
    try {
      const r = await once(path, opts);
      // 5xx = WUD 侧临时故障（重启中 / sqlite 损坏），GET 可安全重试；
      // POST 不重试（可能已生效），4xx 一律不重试（是请求本身的问题）。
      if (r.ok || (r.status < 500 && r.status !== 429) || method === 'POST') {
        return r;
      }
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) {
      lastErr = e;
    }
    if (i < API_RETRIES) {
      console.log(
        '[api] ' +
          method +
          ' ' +
          path +
          ' 第 ' +
          i +
          ' 次失败（' +
          lastErr.message +
          '），' +
          API_RETRY_MS / 1000 +
          's 后重试',
      );
      await sleep(API_RETRY_MS);
    }
  }
  throw new Error(
    method + ' ' + path + ' 连续 ' + API_RETRIES + ' 次失败: ' + lastErr.message,
  );
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function fmtTime() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function short(d) {
  return d ? String(d).replace('sha256:', '').slice(0, 12) : '-';
}

function markerPath(name) {
  return (
    MARKER_DIR + '/.wud-last-update-' + name.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json'
  );
}

function readMarker(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeMarker(p, obj) {
  try {
    fs.writeFileSync(p, JSON.stringify(obj));
  } catch (e) {
    console.error('[marker] FAILED: ' + e.message);
  }
}

/**
 * 按容器名重新定位容器。
 * 更新会重建容器 → id 变 → 必须用 name 查，不能用触发时拿到的旧 id。
 * WUD 的 ?name= 是精确匹配（实测 ?name=mag / ?name=magpi. 均返回 0 条）。
 * 重建过程中该行会短暂消失，此时返回 null，调用方继续等即可。
 */
async function findByName(name) {
  const r = await api('/api/containers?name=' + encodeURIComponent(name));
  if (!r.ok) return null;
  const list = await r.json();
  if (!Array.isArray(list)) return null;
  return (
    list.find((x) => x && (x.name === name || x.displayName === name)) || null
  );
}

async function main() {
  const c = JSON.parse(process.env.container_json || '{}');
  const id = c.id;
  const name = c.name || c.displayName || id || '(unknown)';
  const uk = c.updateKind || {};
  const img = c.image || {};
  const tag = (img.tag && img.tag.value) || 'latest';
  const repo = img.name || '';
  const reg = (img.registry && img.registry.name) || '';
  const imageLabel = [reg, repo].filter(Boolean).join('/') + ':' + tag;

  // 更新前的本机镜像标识（用于判断镜像是否真被替换）
  const beforeValue = (img.digest && img.digest.value) || null;
  const beforeRepo = (img.digest && img.digest.repo) || null;
  const targetV = uk.remoteValue || (c.result && c.result.digest) || '-';

  console.log(
    '[start] ' +
      name +
      ' id=' +
      short(id) +
      ' 本机=' +
      short(beforeValue) +
      ' 目标=' +
      short(targetV) +
      ' 镜像=' +
      imageLabel,
  );

  // ── 冷却/并发护栏（按容器名，id 会随重建变化所以不能用 id）──
  const mp = markerPath(name);
  const prev = readMarker(mp);
  if (prev && prev.ts && Date.now() - prev.ts < COOLDOWN_MS) {
    console.log(
      '[skip] ' +
        name +
        ' 处于冷却期（上次动作 ' +
        (prev.time || '?') +
        '，结果 ' +
        (prev.ok === null ? '进行中' : prev.ok ? '成功' : '失败') +
        '，剩余 ' +
        Math.ceil((COOLDOWN_MS - (Date.now() - prev.ts)) / 60000) +
        ' 分钟）=> 跳过本次触发，避免重复重建',
    );
    return;
  }
  writeMarker(mp, { ts: Date.now(), time: fmtTime(), ok: null });

  const skip = process.env.WUD_SKIP_UPDATE === '1';
  let updated = false;
  let reason = null;
  let errMsg = null;
  let afterValue = beforeValue;
  let afterRepo = beforeRepo;
  let afterId = id;

  if (!skip) {
    try {
      // 触发时拿到的 id 也可能已经过期（WUD 重启 / 库重建后 id 会变）。
      // 先按容器名解析出当前 id 再 POST，避免 POST 直接 404 秒判「更新调用失败」。
      let pre = null;
      try {
        pre = await findByName(name);
      } catch (e) {
        pre = null;
      }
      if (pre && !beforeValue) {
        afterValue = beforeValue =
          (pre.image && pre.image.digest && pre.image.digest.value) || null;
      }
      if (pre && !beforeRepo) {
        afterRepo = beforeRepo =
          (pre.image && pre.image.digest && pre.image.digest.repo) || null;
      }
      const postId = (pre && pre.id) || id;

      let r = await api(
        '/api/containers/' + postId + '/triggers/docker/local',
        { method: 'POST' },
      );
      if (!r.ok && id && id !== postId) {
        console.log(
          '[post] 用解析到的 id 触发失败（HTTP ' +
            r.status +
            '），回退用触发时的 id 再试',
        );
        r = await api('/api/containers/' + id + '/triggers/docker/local', {
          method: 'POST',
        });
      }
      if (!r.ok) throw new Error('HTTP ' + r.status + ' (id=' + postId + ')');

      const deadline = Date.now() + DEADLINE_MS;
      let miss = 0;
      let rounds = 0; // 已看到容器行（非 miss）的轮询轮数
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        let cc = null;
        try {
          cc = await findByName(name);
        } catch (e) {
          continue; // 重建中可能瞬时不可达，跳过本轮
        }
        if (!cc) {
          miss += 1;
          if (miss % MISS_LOG_EVERY === 0) {
            console.log(
              '[poll] ' +
                name +
                ' 暂未查到（重建中？）已等待 ' +
                Math.round((miss * POLL_MS) / 1000) +
                's',
            );
          }
          // 四修（2026-10-14）：重建后的新容器行**不会自动回到 store**，
          // 只有重扫（全量 watch 或单容器 :id/watch）才会把它落库。
          // 干等永远查不到（12:27 演练实测 miss 到 35min 超时），
          // 所以查不到行时也要主动触发：第 1 次 miss 立刻全量重扫，
          // 之后每 3 轮（30s）再扫一次，直到行出现。
          if (miss === 1 || miss % REFRESH_EVERY === 0) {
            try {
              const rw = await api('/api/containers/watch', { method: 'POST' });
              console.log(
                '[refresh] 行缺失，已请求全量重扫（miss=' +
                  miss +
                  '，HTTP ' +
                  rw.status +
                  '）',
              );
            } catch (e) {
              console.log('[refresh] 重扫请求失败（下轮重试）: ' + e.message);
            }
          }
          continue; // 容器行短暂消失属正常，继续等
        }

        const ci = cc.image || {};
        const dv = (ci.digest && ci.digest.value) || null;
        const dr = (ci.digest && ci.digest.repo) || null;
        if (dv) afterValue = dv;
        if (dr) afterRepo = dr;
        if (cc.id) afterId = cc.id;

        const rebuilt = Boolean(cc.id && id && cc.id !== id);
        if (cc.updateAvailable === false) {
          updated = true;
          reason = 'updateAvailable 已变为 false（本机与 registry 收敛）';
          break;
        }
        if (beforeValue && dv && dv !== beforeValue) {
          updated = true;
          reason = '本机镜像 digest 已变化（镜像被替换）';
          break;
        }
        if (beforeRepo && dr && dr !== beforeRepo) {
          updated = true;
          reason = '本机镜像 repo digest 已变化';
          break;
        }
        if (rebuilt && targetV && dv && dv === targetV) {
          updated = true;
          reason = '容器已重建且本机 digest 已等于目标 digest';
          break;
        }

        rounds += 1;
        // 重建已可见，或等待已久（2/6/20 分钟兜底）时，主动让 WUD 重查该容器，
        // 否则它不会自己刷新 state，成功判据 (a) 永远读不到 false。
        if (
          rounds % REFRESH_EVERY === 0 &&
          (rebuilt || rounds === 12 || rounds === 36 || rounds === 120)
        ) {
          try {
            const rr = await api(
              '/api/containers/' + encodeURIComponent(cc.id) + '/watch',
              { method: 'POST' },
            );
            console.log(
              '[refresh] 已请求 WUD 重查 ' +
                name +
                '（id=' +
                short(cc.id) +
                '，HTTP ' +
                rr.status +
                '）',
            );
          } catch (e) {
            console.log('[refresh] 重查请求失败（下轮重试）: ' + e.message);
          }
        }
        if (miss % MISS_LOG_EVERY === 0 || miss === 0) {
          console.log(
            '[poll] ' +
              name +
              ' id=' +
              short(cc.id) +
              (rebuilt ? '(已重建)' : '(未变)') +
              ' updateAvailable=' +
              cc.updateAvailable +
              ' 本机=' +
              short(dv),
          );
        }
      }
      if (!updated) {
        errMsg =
          '更新超时（' +
          DEADLINE_MS / 60000 +
          ' 分钟内未观察到镜像被替换；更新前本机 ' +
          short(beforeValue) +
          '，最后一次观测 ' +
          short(afterValue) +
          (afterId !== id ? '，容器已重建' : '，容器未重建') +
          '）';
      }
    } catch (e) {
      errMsg = '更新调用失败: ' + e.message;
    }
  } else {
    updated = true;
    reason = '测试模式（WUD_SKIP_UPDATE=1，未实际更新）';
  }

  const ok = !errMsg;
  writeMarker(mp, {
    ts: Date.now(),
    time: fmtTime(),
    ok,
    reason: reason || errMsg,
  });

  const subject = ok ? '容器更新成功: ' + name : '容器更新失败: ' + name;
  const body = ok
    ? [
        '容器 ' + name + ' 已成功更新。',
        '镜像: ' + imageLabel,
        '旧镜像: ' + short(beforeValue),
        '新镜像: ' + short(afterValue),
        '目标(registry): ' + short(targetV),
        '判据: ' + (reason || '-'),
        '容器 id: ' + short(id) + ' -> ' + short(afterId),
        '时间: ' + fmtTime(),
      ].join('\n')
    : [
        '容器 ' + name + ' 更新未成功。',
        '镜像: ' + imageLabel,
        '本机: ' + short(beforeValue) + ' -> ' + short(afterValue),
        '目标: ' + short(targetV),
        '容器 id: ' + short(id) + ' -> ' + short(afterId),
        '原因: ' + errMsg,
        '时间: ' + fmtTime(),
      ].join('\n');

  try {
    const transport = nodemailer.createTransport(MAIL);
    await transport.sendMail({ from: FROM, to: TO, subject, text: body });
    console.log('[mail] sent: ' + subject);
  } catch (e) {
    console.error('[mail] FAILED: ' + e.message);
    process.exitCode = 2;
  }
  console.log(subject);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

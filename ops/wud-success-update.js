"use strict";
// WUD command trigger 脚本：驱动 docker.local 完成更新，更新完成后发成功/失败邮件。
// 由 WUD command 触发器以环境变量 container_json 传入完整容器对象。
//
// ── 成功判据（分级判定，高可信优先，且必须校验方向）──────────────
//   旧实现是四条并列 if，谁先命中谁生效；其中「本机 digest 变了」这一条
//   不区分升级还是降级，导致 2026-11-12 ttrss 被换成 6 月的旧镜像后
//   仍被判为「更新成功」。现改为按可信度排序的判定链：
//
//   rank 3  updateAvailable=false 且 created 未倒退 —— 本机与 registry 收敛
//   rank 3  本机 digest == 目标 digest 且容器已重建 —— 拿到目标镜像
//   rank 2  镜像 created 前进（升级）—— 时间戳方向正确
//   rank 0  镜像 created 倒退 —— **降级**，立即判失败并告警，不再继续等
//   rank 1  digest 变了但 created 无法比较 —— 「待确认」，继续轮询；
//           到截止时间仍停在 rank 1 则发「待确认」通知，不谎报成功
//
//   为什么保留「digest 变化」这条宽松线索：拉取走的是 docker daemon 的
//   registry-mirrors，而 WUD 的远端 digest 查的是 WUD_REGISTRY_HUB_URL，
//   两者是不同缓存，镜像站落后时 updateAvailable 会一直为 true，
//   只用收敛判据会误报「更新失败」。但它现在只作为「待确认」，不再直接判成功。
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
// nodemailer 延迟到真正发信时再 require：
// ① 镜像内路径固定为 /home/node/app/node_modules，单测环境没有这个路径；
// ② 只在发信分支加载，脚本被 require 做纯函数测试时不会因缺依赖直接崩。
function loadNodemailer() {
  return require('/home/node/app/node_modules/nodemailer');
}

// API 鉴权：优先用显式 WUD_AUTH；否则由 WUD 容器自带的
// WUD_AUTH_ADMIN_USER / WUD_AUTH_ADMIN_PASSWORD 拼出（线上即此路径）。
// 早期版本只认 WUD_AUTH 占位符，导致 401 而更新从未真正触发。
const AUTH =
  process.env.WUD_AUTH ||
  (process.env.WUD_AUTH_ADMIN_USER && process.env.WUD_AUTH_ADMIN_PASSWORD
    ? process.env.WUD_AUTH_ADMIN_USER + ':' + process.env.WUD_AUTH_ADMIN_PASSWORD
    : 'admin:<YOUR_WUD_PASSWORD>');
const BASE = 'http://127.0.0.1:3000';
// 邮件配置：WUD 容器内实际用的是 WUD_TRIGGER_SMTP_MAIL_* 系列变量，
// 旧的 SMTP_*/MAIL_* 占位符在线上取不到值，邮件会发不出去。这里两个来源都认。
const MAIL = {
  host:
    process.env.WUD_TRIGGER_SMTP_MAIL_HOST ||
    process.env.SMTP_HOST ||
    'smtp.example.com',
  port: Number(
    process.env.WUD_TRIGGER_SMTP_MAIL_PORT || process.env.SMTP_PORT || 465,
  ),
  secure: (process.env.WUD_TRIGGER_SMTP_MAIL_TLS_ENABLED || 'true') !== 'false',
  auth: {
    user:
      process.env.WUD_TRIGGER_SMTP_MAIL_USER ||
      process.env.SMTP_USER ||
      '<YOUR_SMTP_USER>',
    pass:
      process.env.WUD_TRIGGER_SMTP_MAIL_PASS ||
      process.env.SMTP_PASS ||
      '<YOUR_SMTP_PASS>',
  },
};
const TO =
  process.env.WUD_TRIGGER_SMTP_MAIL_TO ||
  process.env.MAIL_TO ||
  '<YOUR_EMAIL>';
// 发件人：WUD 原生 SMTP trigger 用 FROM_NAME + FROM_ADDRESS 拼成
// `"WUD" <ops@example.com>`，所以收件端显示 WUD。这里必须同样拼上显示名，
// 否则只传裸地址，邮件客户端会按地址本地部分显示成 `ops`，
// 导致同一套通知出现两种署名。
const RAW_FROM =
  process.env.WUD_TRIGGER_SMTP_MAIL_FROM_ADDRESS ||
  process.env.MAIL_FROM ||
  '';
const FROM_NAME = process.env.WUD_TRIGGER_SMTP_MAIL_FROM_NAME || 'WUD';
const FROM = RAW_FROM
  ? RAW_FROM.includes('<')
    ? RAW_FROM // 已是 "Name <addr>" 形式，原样使用
    : `"${FROM_NAME}" <${RAW_FROM}>`
  : `"${FROM_NAME}" <YOUR_EMAIL>`;
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
const UPDATE_RETRIES = 3; // 五修：整轮更新（触发+轮询）失败后的最大重试次数
const UPDATE_RETRY_MS = 60000; // 每轮更新重试间隔（60s，给 WUD 从竞态/unknown 态恢复）

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

// ── 全局串行锁（跨容器，B4）──────────────────────────────────────
// 04:00 一轮里多个容器会同时触发更新，全都去打同一个 registry，
// 容易撞上 toomanyrequests。这里用 /store 下的锁文件把更新动作串起来：
//   · 用 O_EXCL 原子创建，抢不到就带 jitter 轮询等待；
//   · 持锁者超过 LOCK_STALE_MS 未释放（脚本被容器重启杀掉）视为陈旧，允许接管；
//   · 等待超时则放行并打日志 —— 宁可并发也不要卡死更新。
// 注意：锁只保护「拉取 + 重建 + 轮询」这段，冷却标记仍按容器名各自独立。
const LOCK_PATH = MARKER_DIR + '/.wud-update.lock';
const LOCK_STALE_MS = 40 * 60 * 1000; // > DEADLINE_MS，避免误接管仍在跑的更新
const LOCK_WAIT_MS = 25 * 60 * 1000;
const LOCK_POLL_MS = 5000;

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

function lockIsStale(info) {
  if (!info || !info.ts) return true;
  return Date.now() - info.ts > LOCK_STALE_MS;
}

async function acquireLock(name) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let announced = false;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, name, ts: Date.now(), time: fmtTime() }),
      );
      fs.closeSync(fd);
      console.log('[lock] 已获取全局更新锁');
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        console.log('[lock] 创建失败（' + e.code + '），跳过加锁继续执行');
        return false;
      }
      const info = readLock();
      if (lockIsStale(info)) {
        console.log(
          '[lock] 发现陈旧锁（持有者 ' +
            ((info && info.name) || '?') +
            '，' +
            ((info && info.time) || '?') +
            '），接管',
        );
        try {
          fs.unlinkSync(LOCK_PATH);
        } catch (e2) {
          /* 别人已删，下一轮重试 */
        }
        continue;
      }
      if (Date.now() >= deadline) {
        console.log(
          '[lock] 等待超时，放弃加锁继续执行（避免卡死更新）',
        );
        return false;
      }
      if (!announced) {
        console.log(
          '[lock] 等待中：' +
            ((info && info.name) || '?') +
            ' 正在更新（' +
            ((info && info.time) || '?') +
            '）',
        );
        announced = true;
      }
      // jitter：避免多个等待者同一时刻醒来再一起抢
      await sleep(LOCK_POLL_MS + Math.floor(Math.random() * 5000));
    }
  }
}

function releaseLock() {
  try {
    const info = readLock();
    if (info && info.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch (e) {
    /* 释放失败不影响结果，陈旧锁会被下一个进程接管 */
  }
}

// 错峰抖动：同一轮触发的多个容器在真正动手前随机等待一小段，
// 把并发峰值摊平（配合全局锁，先到的先做）。
async function jitter() {
  const max = Number(process.env.WUD_UPDATE_JITTER_MS || 8000);
  if (!Number.isFinite(max) || max <= 0) return;
  const ms = Math.floor(Math.random() * max);
  console.log('[jitter] 错峰等待 ' + ms + 'ms');
  await sleep(ms);
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

// 比较两个 ISO 构建时间的方向。返回 'newer'（升级）/ 'older'（降级）/
// 'same'（持平）/ 'unknown'（任一侧缺失或无法解析）。
// 注意：这里刻意用 created 而不是 digest —— mirror 会重写 manifest，
// ttrss 实测同一镜像有 3cca2ee5 / 46abe3e6 / 5eb139c5 三个互异的 digest。
function compareCreated(before, after) {
  if (!before || !after) return 'unknown';
  const a = new Date(before).getTime();
  const b = new Date(after).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 'unknown';
  if (b > a) return 'newer';
  if (b < a) return 'older';
  return 'same';
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
  // 注意：这两个变量在下面「按名重定位后回填」分支里会被重新赋值，
  // 因此必须是 let，绝不能是 const（否则严格模式下抛 Assignment to constant variable）。
  let beforeValue = (img.digest && img.digest.value) || null;
  let beforeRepo = (img.digest && img.digest.repo) || null;
  // 镜像构建时间：判定「升级 / 持平 / 降级」的方向基准。
  // digest 会被 mirror 重写（ttrss 实测三个 digest 互不相同），created 不会。
  let beforeCreated = img.created || null;
  const targetV = uk.remoteValue || (c.result && c.result.digest) || '-';
  const targetCreated = (c.result && c.result.created) || null;

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
  let afterCreated = beforeCreated;
  // 判定结果分级：null=未定，'confirmed'=高可信成功，'downgrade'=降级，
  // 'pending'=只看到 digest 变化但方向不明（不谎报成功）
  let verdict = null;

  // 冷却期已放行，正式动手前先错峰再抢全局锁：
  // 同一轮 04:00 触发多个容器时，避免同时向同一个 registry 打拉取请求。
  if (!skip) {
    await jitter();
    await acquireLock(name);
  }

  // 五修（2026-10-16）→ 2026-10-19 修正根因：整轮更新（触发 + 轮询确认）失败后
  // 自动重试，最多 UPDATE_RETRIES 次。首失败即发「将自动重试」通知，重试成功则发
  // 正常成功邮件，全部失败才发最终失败邮件。
  // 真正的根因（2026-10-19 定位）：本脚本自身在严格模式（"use strict"）下把 const
  // 声明的 beforeValue / beforeRepo 在 262/266 行重新赋值，抛
  // 「Assignment to constant variable」，且发生在 POST 更新触发之前，所以容器从未被
  // 真正触发、3 次重试全部确定性失败（与竞态/unknown 无关）。已把这两个变量改为 let。
  // 原注释把原因归到 WUD 后端「竞态」是错误的，特此更正。
  async function notify(subject, body) {
    try {
      const transport = loadNodemailer().createTransport(MAIL);
      await transport.sendMail({ from: FROM, to: TO, subject, text: body });
      console.log('[mail] sent: ' + subject);
    } catch (e) {
      console.error('[mail] FAILED: ' + e.message);
      process.exitCode = 2;
    }
    console.log(subject);
  }

  if (!skip) {
    for (let attempt = 1; attempt <= UPDATE_RETRIES && !updated; attempt++) {
      errMsg = null;
      verdict = null; // 每轮重试重新判定，避免上一轮的 pending 残留
      if (attempt > 1) {
        console.log(
          '[retry] 第 ' + attempt + '/' + UPDATE_RETRIES + ' 次尝试更新 ' + name,
        );
        await sleep(UPDATE_RETRY_MS);
      }
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
        const dc = ci.created || null;
        if (dv) afterValue = dv;
        if (dr) afterRepo = dr;
        if (dc) afterCreated = dc;
        if (cc.id) afterId = cc.id;

        const rebuilt = Boolean(cc.id && id && cc.id !== id);
        const direction = compareCreated(beforeCreated, dc);

        // ── rank 0：镜像变旧 = 降级，立刻失败，不再等待 ──
        if (direction === 'older') {
          verdict = 'downgrade';
          errMsg =
            '检测到降级：镜像构建时间由 ' +
            beforeCreated +
            ' 倒退到 ' +
            dc +
            '（镜像站缓存不一致或 tag 被指回旧版本）。已中止判定，未计为成功。';
          break;
        }

        // ── rank 3a：与 registry 收敛 ──
        if (cc.updateAvailable === false) {
          verdict = 'confirmed';
          reason = 'updateAvailable 已变为 false（本机与 registry 收敛）';
          break;
        }

        // ── rank 3b：拿到目标 digest 且已重建 ──
        if (rebuilt && targetV && dv && dv === targetV) {
          verdict = 'confirmed';
          reason = '容器已重建且本机 digest 已等于目标 digest';
          break;
        }

        // ── rank 2：created 前进 = 升级 ──
        if (direction === 'newer') {
          verdict = 'confirmed';
          reason =
            '镜像构建时间前进（' + beforeCreated + ' -> ' + dc + '），判定为升级';
          break;
        }

        // ── rank 1：digest 变了但方向无法确认 → 记为待确认，继续轮询 ──
        if (
          (beforeValue && dv && dv !== beforeValue) ||
          (beforeRepo && dr && dr !== beforeRepo)
        ) {
          verdict = 'pending';
          reason =
            '本机镜像 digest 已变化，但构建时间无法确认方向（' +
            (beforeCreated || '未知') +
            ' -> ' +
            (dc || '未知') +
            '），继续观察';
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
      if (verdict === 'confirmed') {
        updated = true;
      }
      if (!updated) {
        errMsg =
          verdict === 'pending'
            ? '待确认：' +
              DEADLINE_MS / 60000 +
              ' 分钟内只观察到镜像 digest 变化，无法确认是升级；更新前 ' +
              beforeCreated +
              '，最后观测 ' +
              afterCreated +
              '。未计为成功，请人工核对。'
            : '更新超时（' +
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

      if (updated) {
        reason =
          (reason ? reason + '；' : '') +
          '第 ' +
          attempt +
          '/' +
          UPDATE_RETRIES +
          ' 次尝试成功';
        break;
      }
      // 降级是确定性结论，重试只会再拉回同一个旧镜像，直接终止
      if (verdict === 'downgrade') {
        console.log('[abort] 判定降级，跳过剩余重试');
        break;
      }
      if (attempt < UPDATE_RETRIES) {
        console.log(
          '[retry] 第 ' +
            attempt +
            ' 次失败: ' +
            errMsg +
            '，' +
            UPDATE_RETRY_MS / 1000 +
            's 后重试',
        );
        await notify(
          '容器更新将自动重试: ' + name,
          [
            '容器 ' + name + ' 第 ' + attempt + ' 次更新尝试未成功，将自动重试。',
            '已尝试: ' + attempt + '/' + UPDATE_RETRIES,
            '失败原因: ' + errMsg,
            '约 ' + UPDATE_RETRY_MS / 1000 + ' 秒后进行第 ' + (attempt + 1) + ' 次尝试。',
            '若最终成功会另行发送成功通知；若 ' + UPDATE_RETRIES + ' 次全部失败会发送失败通知。',
            '时间: ' + fmtTime(),
          ].join('\n'),
        );
      }
    }
    if (!updated && errMsg) {
      errMsg = errMsg + '（已自动重试 ' + UPDATE_RETRIES + ' 次，均失败）';
    }
  } else {
    updated = true;
    reason = '测试模式（WUD_SKIP_UPDATE=1，未实际更新）';
  }

  // 更新动作已结束（无论成败），立刻释放全局锁，让下一个等待者继续。
  if (!skip) releaseLock();

  const ok = !errMsg;
  writeMarker(mp, {
    ts: Date.now(),
    time: fmtTime(),
    ok,
    verdict: verdict || (ok ? 'confirmed' : 'failed'),
    reason: reason || errMsg,
  });

  const subject = ok
    ? '容器更新成功: ' + name
    : verdict === 'downgrade'
      ? '容器更新被判定为降级: ' + name
      : verdict === 'pending'
        ? '容器更新待确认: ' + name
        : '容器更新失败: ' + name;
  const body = ok
    ? [
        '容器 ' + name + ' 已成功更新。',
        '镜像: ' + imageLabel,
        '旧镜像: ' + short(beforeValue),
        '新镜像: ' + short(afterValue),
        '目标(registry): ' + short(targetV),
        '构建时间: ' + (beforeCreated || '?') + ' -> ' + (afterCreated || '?'),
        '判据: ' + (reason || '-'),
        '容器 id: ' + short(id) + ' -> ' + short(afterId),
        '时间: ' + fmtTime(),
      ].join('\n')
    : [
        '容器 ' + name + ' 更新未成功。',
        '镜像: ' + imageLabel,
        '本机: ' + short(beforeValue) + ' -> ' + short(afterValue),
        '构建时间: ' + (beforeCreated || '?') + ' -> ' + (afterCreated || '?'),
        '目标: ' + short(targetV) + '（构建于 ' + (targetCreated || '?') + '）',
        '容器 id: ' + short(id) + ' -> ' + short(afterId),
        '原因: ' + errMsg,
        '时间: ' + fmtTime(),
      ].join('\n');

  await notify(subject, body);
}

// 作为脚本直接执行时（node /store/wud-success-update.js）才跑 main；
// 被单测 require 时只导出纯函数，避免触发真实更新与发信。
if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });
}

module.exports = { compareCreated };

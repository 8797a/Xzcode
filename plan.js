'use strict';

/**
 * ZCode 侧套餐额度读取。
 *
 * 数据源：客户端自己的日志 ~/.zcode/v2/logs/YYYY-MM-DD.log
 * 客户端会周期性请求 billing/balance，并把完整响应写进日志，
 * 里面含 plans（套餐定义）和 balances（额度桶）。
 * 走日志而不是自己请求：那条路要 X-Device-Mid 等一串客户端头，
 * 缺一个就 400；日志里是客户端拿到手的第一手响应，最省事也最准。
 *
 * 对外的形状（flattenPlanItems 消费的就是这个）：
 *   {
 *     ok: true,
 *     logTs,            // 日志里那条记录的时间戳（本地时间字符串）
 *     providerId,       // 如 builtin:zai-start-plan / remote:<账号目录名>
 *     userPlanId,       // 逗号拼接的 user_plan_id 列表
 *     source,           // 'client' | 'server'
 *     logFile,
 *     plans: [{
 *       name,
 *       entitlements: [{ showName, grantUnits, period, pending }],
 *       buckets:      [{ showName, period, totalUnits, usedUnits, availableUnits }],
 *     }],
 *   }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 老架构的全局日志目录。新架构下每个账号的日志在它自己的数据根里
// （<账号>/data/.zcode/v2/logs），调用方会把 logDir 显式传进来。
// 这里留一个默认值，只为兼容不带参数的旧调用。
const LEGACY_LOG_DIR = path.join(os.homedir(), '.zcode', 'v2', 'logs');
const MARKER = 'billing/balance 请求完成 ';
const TAIL_BYTES = 4 * 1024 * 1024;

/** 最近三天里存在的日志文件，新的在前 */
function recentLogFiles(logDir) {
  const dir = logDir || LEGACY_LOG_DIR;
  const out = [];
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    const d = new Date(now - i * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    const f = path.join(dir, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

/** 只读文件尾部若干字节。日志动辄近 10MB，全读没必要 */
function readTail(file, bytes) {
  const st = fs.statSync(file);
  const size = Math.min(bytes, st.size);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 从 start 处的 `{` 开始，按括号配对取出一个完整 JSON 对象。
 * 必须处理字符串与转义，否则 payload 里带引号的文案会把配对判错。
 */
function extractJson(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 一条 billing 记录里的 user_plan_id 列表（它是账号级的唯一标识） */
function userPlanIdsOf(obj) {
  const d = (obj && obj.payload && obj.payload.data) || null;
  if (!d) return [];
  return (d.plans || []).map((p) => p.user_plan_id).filter(Boolean);
}

/**
 * 找一条 billing 记录。
 *
 * 日志是全局的——同一台机器上跑过的每个账号，它的 billing 响应都写进同一个
 * 文件。所以「最后一条」不等于「当前账号的那一条」：实测这台机器一天之内混了
 * 9 个账号的记录，其中好几个 provider 完全相同（都是 builtin:zai-start-plan），
 * 光靠 provider 校核根本分不出来，面板会把别人的额度当成当前账号的显示。
 *
 * 因此这里支持按 expectUserPlanId 精确匹配；指定了却一条都没匹配上时返回 null，
 * 让调用方去用该账号自己的旧快照，而不是把别人的数据顶上来。
 */
function latestRecord(expectUserPlanId, logDir) {
  let text = null;
  for (const f of recentLogFiles(logDir)) {
    try {
      const candidate = readTail(f, TAIL_BYTES);
      if (candidate.includes(MARKER)) { text = candidate; break; }
    } catch {
      /* 读不了就试下一个 */
    }
  }
  if (!text) return null;

  let at = text.lastIndexOf(MARKER);
  let guard = 0;
  // 最多回看 80 条：既给新账号留出"它自己的记录还没写进来"的余地，
  // 也不至于为了找它把整个文件扫一遍。
  while (at >= 0 && guard < 80) {
    const brace = text.indexOf('{', at + MARKER.length - 1);
    if (brace > 0) {
      const json = extractJson(text, brace);
      if (json) {
        let obj = null;
        try { obj = JSON.parse(json); } catch { obj = null; }
        if (obj && obj.payload) {
          if (!expectUserPlanId) {
            const lineStart = text.lastIndexOf('\n', at) + 1;
            const m = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(text.slice(lineStart, at));
            return { obj, ts: m ? m[1] : null, at, matchMode: 'latest' };
          }
          if (userPlanIdsOf(obj).includes(expectUserPlanId)) {
            const lineStart = text.lastIndexOf('\n', at) + 1;
            const m = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(text.slice(lineStart, at));
            return { obj, ts: m ? m[1] : null, at, matchMode: 'exact' };
          }
        }
      }
    }
    at = text.lastIndexOf(MARKER, at - 1);
    guard += 1;
  }
  return null;
}

// 日志按 mtime 缓存，未更新时不重复解析。
// key 同时带上归属和日志目录：新架构下每个账号各有自己的日志，
// 只按归属做 key 会让两个账号的解析结果互相顶掉。
let cache = { mtimeMs: -1, key: '', rec: null };

function loadRecord(force, expectUserPlanId, logDir) {
  let files = [];
  try { files = recentLogFiles(logDir); } catch { return null; }
  if (!files.length) return null;

  let mtimeMs = 0;
  for (const f of files) {
    try { mtimeMs = Math.max(mtimeMs, fs.statSync(f).mtimeMs); } catch { /* 忽略 */ }
  }
  const key = (expectUserPlanId || '') + '|' + (logDir || '');
  if (!force && cache.mtimeMs === mtimeMs && cache.key === key) return cache.rec;

  const rec = latestRecord(expectUserPlanId, logDir);
  cache = { mtimeMs, key, rec };
  return rec;
}

/** 秒 → 'YYYY-MM-DDTHH:mm:ss'（本地时间，不带 Z） */
function toIso(sec) {
  if (!sec) return null;
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 把服务端的一个 balance 桶归一化。
 * available_units 才是「还剩多少」；缺它时退回 total - used，绝不拿总量当可用。
 */
function normalizeBucket(b, entitlements) {
  const ent = entitlements.find((e) => e.entitlementId && e.entitlementId === b.entitlement_id);
  const total = Number(b.total_units) || 0;
  const used = Number(b.used_units) || 0;
  const hasAvail = b.available_units !== undefined && b.available_units !== null;
  return {
    showName: (ent && ent.showName) || b.show_name || '额度',
    period: (ent && ent.period) || null,
    totalUnits: total,
    usedUnits: used,
    availableUnits: hasAvail ? Number(b.available_units) : Math.max(0, total - used),
  };
}

/**
 * 归一化一条 billing 记录。
 *
 * pending 的判据是 entitlement 的 effective_at 落在未来 —— 活动券会提前发放，
 * 但生效点（本地 23:00）之前它不可用，必须让渲染层知道「还没生效」，
 * 否则用户会以为现在就能用。
 */
function normalize(rec, activeProvider) {
  if (!rec || !rec.obj) return { ok: false, msg: '没有读到额度记录' };
  const now = Date.now();
  const d = (rec.obj.payload && rec.obj.payload.data) || null;
  if (!d) return { ok: false, msg: '额度记录里没有 data' };

  const providerId = rec.obj.providerId || null;
  // 日志是全局的，可能混着别的账号的记录。带上 activeProvider 时校核一下，
  // 不一致就让调用方知道这份数据不属于当前账号。
  const providerMismatch = !!(activeProvider && providerId && !providerId.includes(activeProvider));

  const plans = (d.plans || []).map((p) => {
    const entitlements = (p.entitlements || []).map((e) => {
      const effMs = e.effective_at ? e.effective_at * 1000 : null;
      return {
        entitlementId: e.entitlement_id || null,
        showName: e.show_name || '额度',
        meter: e.meter || null,
        grantUnits: Number(e.grant_units) || 0,
        period: e.period || null,
        effectiveAt: effMs,
        pending: !!(effMs && effMs > now),
      };
    });
    return {
      planId: p.plan_id || null,
      userPlanId: p.user_plan_id || null,
      name: p.name || p.plan_id || '套餐',
      description: p.description || null,
      status: p.status || null,
      // 必须是 ISO 字符串。接口给的是秒，直接透传的话渲染层会当毫秒，
      // 结果 1970 年附近（曾显示成「有效期至 01-22」）。
      startsAt: toIso(p.starts_at),
      endsAt: toIso(p.ends_at),
      entitlements,
      buckets: [],
    };
  });

  // 把 balances 挂到各自的计划上；找不到归属的就不硬塞
  const byUserPlan = new Map();
  for (const pl of plans) {
    if (pl.userPlanId) byUserPlan.set(pl.userPlanId, pl);
  }
  for (const b of (d.balances || [])) {
    const owner = byUserPlan.get(b.user_plan_id);
    if (!owner) continue;
    owner.buckets.push(normalizeBucket(b, owner.entitlements));
  }

  // 两个派生字段，渲染层靠它们决定徽章文字（「生效中 / 待生效 / 已结束」）。
  // 漏掉它们的表现是徽章恒为「生效中」——同一张卡片里描述文案却写着「尚未生效」。
  for (const pl of plans) {
    // 计划里所有权益都还没到生效点，才算整张计划待生效。
    // 部分生效时显示「生效中」更贴近实际（有一部分现在就能用）。
    pl.pending = pl.entitlements.length > 0 && pl.entitlements.every((e) => e.pending);
    const endsMs = pl.endsAt ? Date.parse(pl.endsAt.replace(' ', 'T')) : NaN;
    pl.expired = Number.isFinite(endsMs) ? endsMs < now : false;
  }

  // 展示顺序：常规套餐在前、一次性赠送在后
  const rank = (pl) => (pl.entitlements.some((e) => e.period === 'one_time') ? 1 : 0);
  plans.sort((a, b) => (rank(a) - rank(b)) || (String(a.name) < String(b.name) ? -1 : 1));

  const userPlanId = plans.map((p) => p.userPlanId).filter(Boolean).join(',') || null;

  return {
    ok: true,
    logTs: rec.ts,
    serverTime: d.server_time || null,
    providerId,
    providerMismatch,
    userPlanId,
    source: 'client',
    logFile: null,
    plans,
  };
}

/**
 * 读当前账号的额度。
 *
 * logDir 传当前账号自己的日志目录（<账号>/data/.zcode/v2/logs）。
 * 新架构下每个账号各写各的日志，本来就只含它自己的记录；不传则退回老架构的
 * 全局目录，那样多账号机器上会串号。
 */
function fetchPlans(activeProvider, force = false, expectUserPlanId = null, logDir = null) {
  const rec = loadRecord(force, expectUserPlanId, logDir);
  if (!rec) {
    return {
      ok: false,
      reason: expectUserPlanId ? 'no-record-for-account' : 'no-record',
      msg: expectUserPlanId
        ? '这个账号自己的日志里还没有额度记录——客户端启动后才会写。'
        : '还没读到额度记录（客户端启动后才会写日志）',
    };
  }
  const out = normalize(rec, activeProvider);
  out.matchMode = rec.matchMode;
  return out;
}

// 让联网查询复用同一套归一化：把服务端响应包成日志记录的形状
function normalizeRemote(data, providerId) {
  if (!data) return { ok: false, msg: '服务端没有返回数据' };
  const rec = {
    ts: new Date().toISOString(),
    obj: { providerId: providerId || null, code: 0, payload: { code: 0, msg: '', data } },
  };
  const out = normalize(rec, null);
  out.source = 'server';
  out.logFile = null;
  return out;
}

module.exports = { fetchPlans, normalizeRemote, normalize, LEGACY_LOG_DIR };

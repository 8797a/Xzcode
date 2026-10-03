'use strict';
// 联网查询套餐：只依赖账号自己的凭据，不要求本机登录过客户端。
//
// 端点（实测确认，2026-09-19 重新验证）：
//   GET {zcode}/api/v1/zcode-plan/billing/balance?app_version=3.11.2
//       Authorization: Bearer <zcodejwttoken>
//       X-Device-Mid: <该账号的 device_mid>
//   → 200 {code:0,data:{plans:[...],balances:[...]}}
//
// 两个坑，都是实测出来的：
//   1) 不带 X-Device-Mid 会返回 400 code=3001 "parameter error"。
//      缺的不是 URL 参数而是这个头 —— 之前误判成「缺一个看不出来的参数」，
//      于是退而用 billing/current，代价是 balances 永远为空。
//   2) billing/current 已经被服务端风控，无论怎么请求都是
//      405 code=3012 "blocked due to unusual activity"，别再用了。
//
// 服务端对密集请求敏感，所以这里做全局节流，并且只应由用户主动触发。

const fs = require('fs');
const path = require('path');
const settings = require('./settings');

const BIGMODEL_ORIGIN = 'https://bigmodel.cn';
const ZCODE_ORIGIN = 'https://zcode.z.ai';
const KEY_NAME = 'zcode-api-key';

const BILLING_PATH = '/api/v1/zcode-plan/billing/balance';
const APP_VERSION = '3.11.2';
// 客户端自报的这几个头，缺了会被判异常。值照客户端日志里的来。
const CLIENT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIN_GAP_MS = 10000;
const REQUEST_TIMEOUT_MS = 12000;

// 一旦服务端判定异常活动（code 3012），立即熔断：期间不再发任何请求。
// 触发后整个账号/出口都可能被限，继续试探只会加重。
const COOLDOWN_MS = 30 * 60 * 1000;

// 状态文件必须落在**可写**位置。
// 打包后 __dirname 在 resources\app.asar 里 —— 那是只读的虚拟归档，writeFileSync 会抛错，
// 而 writeState 把错误吞了，表现是「熔断状态永远存不下来」：撞到服务端风控（code 3012）
// 之后重启面板，30 分钟冷却直接丢失，又会继续打同一个接口。
// 开发态仍写在源码目录，方便直接看。
const STATE_FILE = path.join(
  __dirname.includes('app.asar') ? settings.APP_DIR : __dirname,
  '.remote-plan-state.json'
);

let lastCallAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readState() {
  try {
    // 去掉 BOM：外部工具写入的状态文件可能带 BOM，否则 JSON.parse 会失败
    const raw = fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeState(s) {
  try {
    // 目录可能是刚装的机器上第一次写，先确保它在
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
  } catch {
    /* 写不进去也不影响主流程 */
  }
}

function cooldownLeftMs() {
  const until = Number(readState().cooldownUntil) || 0;
  const left = until - Date.now();
  return left > 0 ? left : 0;
}

function enterCooldown(msg) {
  writeState({ cooldownUntil: Date.now() + COOLDOWN_MS, reason: msg || 'rate-limited', at: new Date().toISOString() });
}

function clearCooldown() {
  const s = readState();
  if (s.cooldownUntil) writeState({});
}

async function throttle() {
  const gap = Date.now() - lastCallAt;
  if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
  lastCallAt = Date.now();
}

async function call(url, options = {}) {
  await throttle();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ac.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON 时 body 保持 null */ }
    if (body && body.code === 3012) enterCooldown(body.msg);
    return { status: res.status, body, text };
  } catch (e) {
    return { status: 0, body: null, text: '', error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 套餐 ----------

/**
 * 查套餐。
 *
 * 必须带两样东西，缺一不可：
 *   - Authorization: Bearer <zcodejwttoken>   换错 token 会 401
 *   - X-Device-Mid: <账号的 device_mid>       缺了会 400 code=3001 parameter error
 *
 * 有了它们 balances 就是真的，不需要再拿 entitlement 的 grant_units 凑数。
 * 但仍要防一手：万一服务端某天又只回 plans 不回 balances，
 * 调用方（flattenPlanItems）的 unknown 标记会兜住，不会把赠送额度当已用量。
 */
async function fetchPlanByJwt(jwt, deviceMid) {
  const left = cooldownLeftMs();
  if (left > 0) {
    return {
      ok: false,
      reason: 'cooldown',
      msg: `服务端此前判定异常活动，已冷却 ${Math.ceil(left / 60000)} 分钟，期间不再发起请求`,
    };
  }

  const token = (jwt || '').trim();
  if (!token) return { ok: false, reason: 'no-jwt', msg: '该账号还没有 JWT，需要先在网页登录一次' };
  const mid = (deviceMid || '').trim();
  if (!mid) {
    return { ok: false, reason: 'no-device-mid', msg: '该账号没有设备标识（device_mid），联网查询会被判参数错误' };
  }

  const url = `${ZCODE_ORIGIN}${BILLING_PATH}?app_version=${APP_VERSION}`;
  const r = await call(url, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      'X-Device-Mid': mid,
      'X-ZCode-App-Version': APP_VERSION,
      'X-Platform': 'desktop',
      'X-Client-Language': 'zh-CN',
      'X-Client-Timezone': 'Asia/Shanghai',
      'X-Os-Category': 'windows',
      Accept: 'application/json',
      'User-Agent': CLIENT_UA,
      Origin: ZCODE_ORIGIN,
      Referer: ZCODE_ORIGIN + '/',
    },
  });

  if (r.status === 401) return { ok: false, reason: 'unauthorized', msg: 'JWT 已失效，需要重新登录' };
  if (r.status === 0) return { ok: false, reason: 'network', msg: '网络请求失败：' + (r.error || '未知') };
  if (!r.body) return { ok: false, reason: 'http', msg: 'HTTP ' + r.status };
  if (r.body.code === 3012) {
    return { ok: false, reason: 'rate-limited', msg: '服务端判定异常活动，已熔断 30 分钟，期间请勿重复尝试' };
  }
  if (r.status !== 200) return { ok: false, reason: 'http', msg: 'HTTP ' + r.status };
  if (r.body.code !== 0) return { ok: false, reason: 'biz', msg: `code=${r.body.code} ${r.body.msg || ''}`.trim() };

  clearCooldown();
  return { ok: true, data: r.body.data || {}, source: 'server' };
}

// ---------- 签名凭据（派生，用于模型请求，不是查套餐所必需） ----------

function pickOrgAndProject(info) {
  const orgs = (info && info.organizations) || [];
  const cands = orgs
    .map((o) => ({
      organization: o,
      projects: (o.projects || []).filter((p) => String(p.projectType ?? '').trim() !== '2'),
    }))
    .filter((x) => x.organization.organizationId && x.projects.length);
  if (!cands.length) return null;
  const org = cands.find((x) => (x.organization.organizationName || '').includes('默认机构')) || cands[0];
  const proj = org.projects.find((p) => (p.projectName || '').includes('默认项目')) || org.projects[0];
  if (!proj || !proj.projectId) return null;
  return { organizationId: org.organization.organizationId, projectId: proj.projectId };
}

// 用 OAuth access_token 派生出 `apiKeyId.secretKey`（与客户端本地保存的完全一致）。
// 全程只读：只在 zcode-api-key 不存在时才会创建。
async function deriveSigningKey(accessToken, options = {}) {
  const token = (accessToken || '').trim();
  if (!token) return { ok: false, reason: 'no-token', msg: '缺少 access_token' };
  const auth = { Authorization: token, 'Content-Type': 'application/json' };

  const info = await call(`${BIGMODEL_ORIGIN}/api/biz/customer/getCustomerInfo`, { headers: auth });
  if (info.status !== 200 || !info.body) return { ok: false, reason: 'http', msg: 'getCustomerInfo HTTP ' + info.status };
  const scope = pickOrgAndProject(info.body.data);
  if (!scope) return { ok: false, reason: 'no-org', msg: '账号下没有可用的机构/项目' };

  const base = `${BIGMODEL_ORIGIN}/api/biz/v1/organization/${scope.organizationId}/projects/${scope.projectId}/api_keys`;
  const listed = await call(base, { headers: auth });
  if (listed.status !== 200) return { ok: false, reason: 'http', msg: 'api_keys HTTP ' + listed.status };
  const arr = Array.isArray(listed.body) ? listed.body : (listed.body && listed.body.data) || [];
  let hit = arr.find((k) => k && k.name === KEY_NAME && k.apiKey);

  if (!hit) {
    if (!options.createIfMissing) {
      return { ok: false, reason: 'no-key', msg: `账号下还没有 ${KEY_NAME}，需要先在本机登录一次客户端` };
    }
    const created = await call(base, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: KEY_NAME }),
    });
    hit = created.body && (Array.isArray(created.body) ? created.body[0] : created.body.data);
    if (!hit || !hit.apiKey) return { ok: false, reason: 'create-failed', msg: '创建 api key 失败' };
  }

  const copied = await call(`${base}/copy/${encodeURIComponent(hit.apiKey)}`, { headers: auth });
  if (copied.status !== 200) return { ok: false, reason: 'http', msg: 'copy HTTP ' + copied.status };
  const secret = ((copied.body && (copied.body.data ? copied.body.data.secretKey : copied.body.secretKey)) || '').trim();
  if (!secret) return { ok: false, reason: 'no-secret', msg: '没有取到 secretKey' };

  return { ok: true, apiKeyId: hit.apiKey, secretKey: secret, full: `${hit.apiKey}.${secret}`, scope };
}

module.exports = {
  fetchPlanByJwt,
  deriveSigningKey,
  pickOrgAndProject,
  cooldownLeftMs,
  enterCooldown,
  clearCooldown,
  BIGMODEL_ORIGIN,
  ZCODE_ORIGIN,
};

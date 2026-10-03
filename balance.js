'use strict';

/**
 * 余额 / 额度查询。
 *
 * 数据源说明（实测确认）：
 *   - zcode 侧 billing API（zcode.z.ai/api/v1/zcode-plan/billing/*）对非客户端进程
 *     返回 3012 "unusual activity"：客户端请求带 X-Client-Sig / X-Client-Nonce /
 *     X-Client-Pow 签名（私钥握手 + PoW），脚本无法复刻，因此不作为数据源。
 *   - BigModel 侧 open.bigmodel.cn 的 biz 网关可用，凭据来自 credentials.json 里
 *     解密的 oauth:bigmodel:access_token：
 *       GET /api/biz/account/query-customer-account-report   账户余额
 *       GET /api/biz/tokenAccounts/list/my                   资源包明细
 *       GET /api/biz/subscription/list                       Coding Plan 订阅
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const oauth = require('./oauth');

const V2 = path.join(os.homedir(), '.zcode', 'v2');
const CREDENTIALS = path.join(V2, 'credentials.json');

const BIGMODEL_HOST = 'https://open.bigmodel.cn';
const ZAI_HOST = 'https://api.z.ai';
const TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 60 * 1000;

let cache = { at: 0, data: null };

function readCredentials(file = CREDENTIALS) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function decryptField(value) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('enc:v1:')) return value;
  try {
    return oauth.decrypt(value);
  } catch {
    return null;
  }
}

// 从任意一份 credentials.json 解析可用的 provider token（快照校准用）
function resolveTokenFrom(file = CREDENTIALS) {
  const cred = readCredentials(file);
  if (!cred) return null;
  const provider = decryptField(cred['oauth:active_provider']) || '';
  const bigmodelToken = decryptField(cred['oauth:bigmodel:access_token']);
  const zaiToken = decryptField(cred['oauth:zai:access_token']);
  if (provider === 'zai' && zaiToken) return { provider: 'zai', token: zaiToken, host: ZAI_HOST };
  if (provider === 'bigmodel' && bigmodelToken) return { provider: 'bigmodel', token: bigmodelToken, host: BIGMODEL_HOST };
  if (bigmodelToken) return { provider: 'bigmodel', token: bigmodelToken, host: BIGMODEL_HOST };
  if (zaiToken) return { provider: 'zai', token: zaiToken, host: ZAI_HOST };
  return null;
}

function resolveToken() {
  return resolveTokenFrom(CREDENTIALS);
}

const USERINFO_PATHS = {
  bigmodel: '/api/biz/customer/getCustomerInfo',
  zai: '/api/oauth/userinfo',
};

/**
 * 平台返回的时间是北京时间（已用 zcodejwt 的 iat 交叉验证：03:33 vs 03:36）。
 * 形如 "2026-09-15 03:33:03" 按 UTC+8 解析，其它格式走 Date.parse。
 */
function parsePlatformTime(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (m && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    const [, y, mo, d, h, mi, se] = m;
    const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${se}+08:00`);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * 取账号在平台上的真实注册时间。
 * 账号"年龄"必须以此为准：否则新导入的老号会被误判成新号，节奏提醒直接失真。
 */
async function fetchRegisteredAt(file = CREDENTIALS) {
  const resolved = resolveTokenFrom(file);
  if (!resolved) return null;
  const url = resolved.host + USERINFO_PATHS[resolved.provider];
  let body;
  try {
    const r = await getJson(url, resolved.token);
    body = r && r.body;
  } catch {
    return null;
  }
  const d = (body && (body.data || body)) || {};
  const raw = d.createTime || d.create_time || d.createdAt || d.registeredAt || null;
  if (!raw) return null;
  const iso = parsePlatformTime(raw);
  if (!iso) return null;
  return {
    provider: resolved.provider,
    raw: String(raw),
    iso,
    name: d.customerName || d.username || d.displayName || null,
  };
}

async function getJson(url, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        accept: 'application/json, text/plain, */*',
        authorization: 'Bearer ' + token,
        'user-agent': 'ZCode/3.0.1',
        'X-Client-Version': '3.11.2',
        'X-App-Id': 'zcode',
      },
    });
    const text = await res.text();
    try {
      return { status: res.status, body: text ? JSON.parse(text) : null };
    } catch {
      return { status: res.status, body: null };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBalance(force = false) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ok: true, cached: true, ...cache.data };
  }

  const resolved = resolveToken();
  if (!resolved) {
    return { ok: false, msg: '未找到可用的账号凭据（请先登录 zcode 或导入账号）' };
  }

  const { provider, token, host } = resolved;
  const result = { ok: true, provider, fetchedAt: new Date().toISOString() };

  const [account, packages, subscription] = await Promise.all([
    getJson(`${host}/api/biz/account/query-customer-account-report`, token).catch(() => null),
    getJson(`${host}/api/biz/tokenAccounts/list/my?pageNum=1&pageSize=100`, token).catch(() => null),
    getJson(`${host}/api/biz/subscription/list`, token).catch(() => null),
  ]);

  if (account && account.body && account.body.code === 200 && account.body.data) {
    const d = account.body.data;
    result.account = {
      balance: d.balance,
      availableBalance: d.availableBalance,
      rechargeAmount: d.rechargeAmount,
      giveAmount: d.giveAmount,
      totalSpendAmount: d.totalSpendAmount,
      frozenBalance: d.frozenBalance,
    };
  }

  if (packages && packages.body && Array.isArray(packages.body.rows)) {
    result.packages = packages.body.rows.map((r) => ({
      name: r.resourcePackageName,
      type: r.type,
      balance: r.tokenBalance,
      status: r.status,
      expireAt: r.expirationTime,
      model: r.suitableModel || null,
    }));
  }

  if (subscription && subscription.body && Array.isArray(subscription.body.data)) {
    result.subscriptions = subscription.body.data.map((s) => ({
      productName: s.productName,
      nextRenewTime: s.nextRenewTime,
    }));
  }

  // zcode 侧套餐状态来自客户端本地缓存（无需签名）。
  try {
    const planCache = JSON.parse(fs.readFileSync(path.join(V2, 'coding-plan-cache.json'), 'utf8'));
    const items = planCache.entryStatus && planCache.entryStatus.items ? planCache.entryStatus.items : {};
    result.plans = Object.entries(items).map(([name, v]) => ({
      name,
      status: v.status,
      reason: v.reason || null,
    }));
    result.plansUpdatedAt = planCache.entryStatus ? planCache.entryStatus.updatedAt : null;
  } catch {
    result.plans = [];
  }

  cache = { at: Date.now(), data: { provider, account: result.account, packages: result.packages, subscriptions: result.subscriptions, plans: result.plans, plansUpdatedAt: result.plansUpdatedAt } };
  return result;
}

module.exports = { fetchBalance, fetchRegisteredAt, parsePlatformTime, resolveTokenFrom };

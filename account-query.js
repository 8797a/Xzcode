'use strict';
/**
 * 联网查询 —— 只要两件事：**这个账号有没有券** + **日额度还剩多少**
 * =====================================================================
 * 端点（实测确认）：
 *   GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.11.2
 *       Authorization: Bearer <zcodejwttoken>
 *       X-Device-Mid:  <该账号的 device_mid>
 *
 * ⚠ 两处必踩的坑（都实测复现过）：
 *   ① **缺 X-Device-Mid → HTTP 400 code=3001 "parameter error"**，
 *      而 400 的 body 里**没有 data.plans / data.balances** ——
 *      只读字段的代码会把"请求失败"误读成"没有券"。所以本模块**先校验
 *      status 与 code**，不合法就明确返回 error，绝不返回空结果装作查到了。
 *   ② 服务端对密集请求敏感，`billing/*` 连查会回 **code 3012 unusual activity**，
 *      触发后要冷却（调用方自行退避），别继续打。
 *
 * 返回结构（只这两样，够用就好）：
 *   {
 *     ok: true,
 *     coupon: { exists, count, items:[{name, planId, units, startsAt, endsAt, effectiveAt, pending}] },
 *     daily:  { 'GLM-5.3': {total, used, left}, 'GLM-5.3-Flash': {...} },
 *     plans:  ['ZCode Global Build', 'ZCode Start Plan']      // 便于人眼扫
 *   }
 *
 * 用法（CLI，用来看真实账号）：
 *   node account-query.js <账号目录名...>
 *   node account-query.js --dir D:\PYxiangmu\Zcode-users\zcode-switch\accounts pcixx678 twplfn35
 */

const fs = require('fs');
const path = require('path');

const ZCODE_ORIGIN = 'https://zcode.z.ai';
const BALANCE_PATH = '/api/v1/zcode-plan/billing/balance';
const APP_VERSION = '3.11.2';
const TIMEOUT_MS = 12000;
const CLIENT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 默认账号库：环境变量 > 本项目的 accounts/ > 同级 zcode-switch/accounts */
function defaultAccountsDir() {
  if (process.env.XZCODE_ACCOUNTS_DIR) return process.env.XZCODE_ACCOUNTS_DIR;
  if (process.env.ZDASHBOARD_ACCOUNTS_DIR) return process.env.ZDASHBOARD_ACCOUNTS_DIR;
  if (process.env.ZPANEL_ACCOUNTS_DIR) return process.env.ZPANEL_ACCOUNTS_DIR;
  const a = path.join(__dirname, 'accounts');
  if (fs.existsSync(a)) return a;
  const b = path.join(__dirname, '..', 'zcode-switch', 'accounts');
  if (fs.existsSync(b)) return b;
  return a;
}

const iso = (s) => (s ? new Date(s * 1000).toLocaleString('zh-CN', { hour12: false }) : null);

/**
 * 查一个账号：有没有券 + 日额度。
 * @param {string} jwt        zcodejwttoken
 * @param {string} deviceMid  该账号的 device_mid（**必需**）
 */
async function queryAccount(jwt, deviceMid) {
  const token = String(jwt || '').trim();
  const mid = String(deviceMid || '').trim();
  if (!token) return { ok: false, error: 'no-jwt', msg: '该账号还没有 JWT' };
  if (!mid) return { ok: false, error: 'no-device-mid', msg: '该账号没有 device_mid（服务端会判参数错误 3001）' };

  const url = `${ZCODE_ORIGIN}${BALANCE_PATH}?app_version=${APP_VERSION}`;
  let res, body, text;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      res = await fetch(url, {
        headers: {
          Authorization: 'Bearer ' + token,
          'X-Device-Mid': mid,
          'X-ZCode-App-Version': APP_VERSION,
          'X-Platform': 'desktop',
          'X-Client-Language': 'zh-CN',
          'X-Client-Timezone': 'Asia/Shanghai',
          Accept: 'application/json',
          'User-Agent': CLIENT_UA,
          Origin: ZCODE_ORIGIN,
          Referer: ZCODE_ORIGIN + '/',
        },
        signal: ac.signal,
      });
      text = await res.text();
    } finally { clearTimeout(timer); }
  } catch (e) {
    return { ok: false, error: 'network', msg: '网络请求失败：' + (e.message || e) };
  }

  try { body = JSON.parse(text); } catch { body = null; }

  // ① 先校验，再取字段 —— 绝不把 400 读成"没有券"
  if (res.status === 401) return { ok: false, error: 'unauthorized', msg: 'JWT 已失效，需要重新登录', http: 401 };
  if (res.status === 0) return { ok: false, error: 'network', msg: '网络不可达' };
  if (!body) return { ok: false, error: 'http', msg: 'HTTP ' + res.status + '：响应不是 JSON', http: res.status, raw: String(text).slice(0, 200) };
  if (body.code === 3001) return { ok: false, error: 'parameter', msg: '参数错误 3001（多半是 device_mid 不对/缺失）', http: res.status, code: 3001 };
  if (body.code === 3012) return { ok: false, error: 'risk', msg: '服务端判定异常活动 3012，需要冷却', http: res.status, code: 3012 };
  if (body.code !== 0 || !body.data) return { ok: false, error: 'business', msg: 'HTTP ' + res.status + ' code=' + body.code + ' ' + (body.msg || ''), http: res.status, code: body.code };

  const plans = body.data.plans || [];
  const balances = body.data.balances || [];

  // ② 券 = 非基础 Start Plan 的那些（活动券/礼包，通常是 one_time）
  const couponItems = [];
  for (const p of plans) {
    if (/ZCode Start Plan/i.test(p.name || '')) continue;
    const e = (p.entitlements || [])[0] || {};
    couponItems.push({
      name: p.name || p.plan_id,
      planId: p.plan_id,
      units: e.grant_units != null ? e.grant_units : null,
      showName: e.show_name || '',
      period: e.period || '',
      startsAt: iso(p.starts_at),
      endsAt: iso(p.ends_at),
      effectiveAt: e.effective_at ? iso(e.effective_at) : null,
      // 发放了但还没生效（跨过 23:00 才生效）—— 用来提醒"别当成没用"
      pending: !!(e.effective_at && e.effective_at * 1000 > Date.now()),
    });
  }

  // ③ 日额度 = period 为 daily 的那些桶，按模型名归并
  const daily = {};
  for (const b of balances) {
    const period = String(b.period || '').toLowerCase();
    if (period && period !== 'daily') continue;
    const name = b.show_name || b.entitlement_id || '未知';
    const total = b.total_units != null ? b.total_units : b.quota;
    const used = b.used_units != null ? b.used_units : b.used;
    const left = b.remaining_units != null ? b.remaining_units
      : (b.available_units != null ? b.available_units
        : (total != null && used != null ? total - used : null));
    if (!daily[name]) daily[name] = { total: 0, used: 0, left: 0 };
    if (typeof total === 'number') daily[name].total += total;
    if (typeof used === 'number') daily[name].used += used;
    if (typeof left === 'number') daily[name].left += left;
  }

  return {
    ok: true,
    coupon: { exists: couponItems.length > 0, count: couponItems.length, items: couponItems },
    daily,
    plans: plans.map((p) => p.name),
    planCount: plans.length,
    serverTime: body.data.server_time ? new Date(body.data.server_time * 1000).toISOString() : null,
  };
}

/** 从本地账号目录读 jwt + device_mid */
function readLocalAccount(dir, id) {
  const d = path.join(dir, id);
  const out = { id, jwt: null, mid: null };
  for (const f of ['data/.zcode/v2/config.json', 'config.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8').replace(/^\uFEFF/, ''));
      const found = [];
      (function w(o) {
        if (typeof o === 'string') { if (o.startsWith('eyJ') && o.split('.').length === 3) found.push(o); }
        else if (o && typeof o === 'object') for (const v of Object.values(o)) w(v);
      })(j);
      if (found.length) { out.jwt = found[0]; break; }
    } catch { /* 继续找下一个 */ }
  }
  try { out.mid = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8').replace(/^\uFEFF/, '')).device_mid || null; } catch { }
  return out;
}

module.exports = { queryAccount, readLocalAccount, defaultAccountsDir };

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const di = argv.indexOf('--dir');
    const dir = di >= 0 ? argv[di + 1] : defaultAccountsDir();
    const ids = argv.filter((x, i) => !x.startsWith('--') && i !== di + 1);
    if (!ids.length) { console.log('用法：node account-query.js [--dir <账号库>] <账号...>'); process.exit(1); }
    console.log('账号库：' + dir + '\n');
    for (const id of ids) {
      const a = readLocalAccount(dir, id);
      if (!a.jwt || !a.mid) { console.log('## ' + id + '  跳过（' + (!a.jwt ? '无 JWT' : '无 device_mid') + '）'); continue; }
      const r = await queryAccount(a.jwt, a.mid);
      if (!r.ok) { console.log('## ' + id + '  ✗ ' + r.error + '：' + r.msg); await new Promise((x) => setTimeout(x, 2600)); continue; }
      console.log('## ' + id);
      console.log('   券：' + (r.coupon.exists
        ? r.coupon.items.map((c) => c.name + (c.units != null ? ' ' + c.units.toLocaleString('en-US') + ' ' + c.showName : '')
          + '　' + c.startsAt + ' → ' + c.endsAt + (c.effectiveAt ? '　生效 ' + c.effectiveAt : '') + (c.pending ? '（待生效）' : '')).join(' / ')
        : '无'));
      const dn = Object.keys(r.daily);
      console.log('   日额度：' + (dn.length
        ? dn.map((k) => k + ' 剩 ' + r.daily[k].left.toLocaleString('en-US') + '/' + r.daily[k].total.toLocaleString('en-US')).join('　')
        : '无'));
      console.log('   套餐：' + r.plans.join(' + '));
      await new Promise((x) => setTimeout(x, 2600));
    }
  })().catch((e) => console.log('ERR ' + e.message));
}

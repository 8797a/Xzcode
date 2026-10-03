'use strict';

/**
 * ZCode 额外额度领取（billing/preview + billing/claim）。
 *
 * 协议从 ZCode 客户端 3.14.3 的 app.asar 里实测提取（claimManualPlan /
 * getManualClaimPlanPreviews 两个函数原样照搬）：
 *   GET  https://zcode.z.ai/api/v1/zcode-plan/billing/preview?app_version=&platform=
 *        裸 JWT 即可查「可领列表」；实测必须带 X-Device-Mid，否则返回 code 3001 空列表
 *   POST https://zcode.z.ai/api/v1/zcode-plan/billing/claim   body { plan_id }
 *        需要 X-Aliyun-Captcha-Verify-Param（无痕验证）+ X-Aliyun-Captcha-Verify-Region
 *   成功：code 0 + data.plan.status='active'；失败看 data.message / code
 *
 * 实测（2026-09-28）：trust 计划一次发 1 亿 GLM-5.3-Flash tokens（one_time）。
 * 这个通道不走 anthropic messages 那套签名（X-Client-Sig 不存在于客户端的
 * claim 调用里），所以面板可以直连，不需要伪装成客户端进程。
 */

const HOST = 'https://zcode.z.ai';
const PREVIEW_PATH = '/api/v1/zcode-plan/billing/preview';
const CLAIM_PATH = '/api/v1/zcode-plan/billing/claim';
const APP_VERSION = '3.14.3';
const PLATFORM = 'win32-x64';
const TIMEOUT_MS = 15000;

function identityHeaders(jwt, mid, extra = {}) {
  const h = {
    accept: 'application/json',
    'user-agent': `ZCode/${APP_VERSION}`,
    'X-ZCode-App-Version': APP_VERSION,
    'X-Platform': PLATFORM,
    'X-Os-Category': 'windows',
    'X-Client-Language': 'zh-CN',
    'X-Client-Timezone': 'Asia/Shanghai',
    'HTTP-Referer': `${HOST}/`,
    'X-Title': 'Z Code@electron',
    ...extra,
  };
  if (jwt) h.authorization = `Bearer ${jwt}`;
  if (mid) h['X-Device-Mid'] = mid;
  return h;
}

async function requestJson(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) {}
    return { status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 可领列表。返回 { ok, plans:[{planId,name,description,grantUnits,showName}], code, msg }。
 */
async function listClaimable(jwt, mid) {
  try {
    const url = `${HOST}${PREVIEW_PATH}?app_version=${APP_VERSION}&platform=${PLATFORM}`;
    const r = await requestJson(url, { headers: identityHeaders(jwt, mid) });
    const body = r.body;
    if (!body || typeof body.code !== 'number') {
      return { ok: false, code: -1, msg: `HTTP ${r.status}（响应不是 JSON）` };
    }
    if (body.code !== 0) {
      return { ok: false, code: body.code, msg: body.msg || `code ${body.code}` };
    }
    const plans = ((body.data && body.data.plans) || []).flatMap((p) => {
      const planId = p && p.plan_id && String(p.plan_id).trim();
      if (!planId) return [];
      const ents = (p.entitlements || []).map((e) => ({
        showName: (e && e.show_name) || '',
        grantUnits: Number.isFinite(e && e.grant_units) ? e.grant_units : 0,
      }));
      return [{
        planId,
        name: (p.name && p.name.trim()) || planId,
        description: (p.description && p.description.trim()) || '',
        grantUnits: ents.reduce((s, e) => s + (e.grantUnits || 0), 0),
        showName: ents.map((e) => e.showName).filter(Boolean).join('/'),
      }];
    });
    return { ok: true, code: 0, plans, msg: '' };
  } catch (e) {
    return { ok: false, code: -1, msg: (e && e.message) || String(e) };
  }
}

/**
 * 领一个计划。返回 { ok, code, msg, plan, failureEndsAt, captchaRejected }。
 * captchaRejected=true 表示验证码参数被上游打回（换新参数重试有意义）。
 */
async function claimPlan(jwt, mid, planId, captchaParam, captchaRegion) {
  try {
    const headers = identityHeaders(jwt, mid, {
      'content-type': 'application/json',
      'X-Aliyun-Captcha-Verify-Param': captchaParam,
    });
    if (captchaRegion) headers['X-Aliyun-Captcha-Verify-Region'] = captchaRegion;
    const r = await requestJson(`${HOST}${CLAIM_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ plan_id: planId }),
    });
    const body = r.body;
    if (!body || typeof body.code !== 'number') {
      return { ok: false, code: r.status, msg: `HTTP ${r.status}（响应不是 JSON）`, captchaRejected: r.status === 403 };
    }
    const code = body.code;
    const msg = (body.msg && body.msg.trim()) || (body.data && body.data.message) || '';
    if (code !== 0 || !(body.data && body.data.plan)) {
      const endsAt = body.data && body.data.plan && body.data.plan.ends_at;
      return {
        ok: false,
        code,
        msg: msg || `code ${code}`,
        failureEndsAt: Number.isFinite(endsAt) ? endsAt : null,
        // 3007 = 验证码校验不过；403 也多半是验证码/风控层
        captchaRejected: code === 3007 || r.status === 403,
      };
    }
    const p = body.data.plan;
    return {
      ok: true,
      code: 0,
      msg: msg || '',
      plan: {
        userPlanId: (p.user_plan_id || '').trim(),
        planId: (p.plan_id || planId).trim(),
        name: (p.name || '').trim() || planId,
        status: (p.status || '').trim(),
        startsAt: Number.isFinite(p.starts_at) ? p.starts_at : null,
        endsAt: Number.isFinite(p.ends_at) ? p.ends_at : null,
      },
    };
  } catch (e) {
    return { ok: false, code: -1, msg: (e && e.message) || String(e), captchaRejected: false };
  }
}

module.exports = { listClaimable, claimPlan, APP_VERSION, PLATFORM, HOST };

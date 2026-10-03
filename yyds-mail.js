'use strict';
/**
 * YYDS Mail（vip.215.im）收信客户端 —— Z.ai 邮箱注册的「自动收激活邮件」通道。
 *
 * API 要点（官方文档 https://vip.215.im/docs，BaseURL maliapi.215.im/v1）：
 *   - 鉴权：请求头 X-API-Key: AC-…（面板设置里存）
 *   - POST /v1/accounts { platformCode?, localPart?, excludeDomains? }
 *       → data.address / data.token（临时收信 token，24h 过期）
 *       platformCode 传目标平台代码后，服务端只分未被该平台拉黑的域名
 *   - GET  /v1/platforms（免鉴权）→ 平台代码表，按 name/code 匹配 z.ai
 *   - GET  /v1/messages/next?address=…&wait=30  长轮询下一封未读信，
 *       data.message 里有 subject / text / html[]，服务端还会尽力给 verificationCode。
 *       Z.ai 注册邮件里的激活链接在正文里，用正则提取。
 *   - POST /v1/messages/actions { messageId, action:'mark_read'|'delete' }（备用）
 *
 * 本模块不依赖 electron，可单测。所有方法在网络错误时抛错，由调用方决定降级。
 */

const API_BASE = 'https://maliapi.215.im/v1';
const DEFAULT_TIMEOUT_MS = 15000;

function assertKey(apiKey) {
  const k = String(apiKey || '').trim();
  if (!k) throw new Error('缺少 YYDS Mail API Key（设置里填入，vip.215.im 获取）');
  return k;
}

async function call(apiKey, method, path, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      'X-API-Key': assertKey(apiKey),
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || text.slice(0, 160) || ('HTTP ' + res.status);
    throw new Error('YYDS Mail ' + path + ' HTTP ' + res.status + '：' + msg);
  }
  return json || {};
}

/** 平台代码表里找 Z.ai 相关的 code；找不到返回 null（调用方就不带 platformCode） */
async function findPlatformCode(apiKey, hint = /z[\s.-]?ai|zcode|chat\.z/i) {
  const json = await call(apiKey, 'GET', '/platforms', null, 12000);
  const list = (json && (json.data || json)) || [];
  const arr = Array.isArray(list) ? list : [];
  const hit = arr.find((p) => {
    const s = [p.code, p.name, p.slug, p.platform].filter(Boolean).join(' ').toLowerCase();
    return hint.test(s);
  });
  return hit ? String(hit.code || hit.slug || hit.name) : null;
}

/**
 * 创建一个临时邮箱。
 * @returns {Promise<{address: string, id?: string, token?: string, expiresAt?: string, platformCode: string|null}>}
 */
async function createInbox({ apiKey, platformCode = null, localPart = null, excludeDomains = null } = {}) {
  const body = {};
  if (platformCode) body.platformCode = platformCode;
  if (localPart) body.localPart = localPart;
  if (Array.isArray(excludeDomains) && excludeDomains.length) body.excludeDomains = excludeDomains;
  const json = await call(apiKey, 'POST', '/accounts', body);
  const data = (json && json.data) || {};
  const address = String(data.address || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new Error('YYDS Mail 返回的邮箱地址无效：' + JSON.stringify(data).slice(0, 200));
  }
  return { address, id: data.id, token: data.token, expiresAt: data.expiresAt, platformCode: platformCode || null };
}

/** 从邮件正文里提取 chat.z.ai 的激活链接（取最像的那条，去掉尾部标点） */
function extractVerifyLink(text, htmlList) {
  const sources = [String(text || '')].concat((Array.isArray(htmlList) ? htmlList : []).map((h) => String(h || '')));
  for (const s of sources) {
    // html 里的 href 可能带 &amp; 转义
    const norm = s.replace(/&amp;/g, '&');
    const found = norm.match(/https?:\/\/(?:chat\.z\.ai|z\.ai)\/[^\s"'<>）)\]]+/gi) || [];
    if (found.length) return found.map((u) => u.replace(/[.,;:!？?]+$/, ''))[0];
  }
  return null;
}

/**
 * 轮询收信，直到收到 Z.ai 的验证邮件或超时。
 *
 * 实测（2026-09-24）：文档里的 /messages/next 对纯 address 查询返回 204 空响应，
 * 不能用；可靠的是「列表 /v1/messages?address= 找到邮件 id → 详情 /v1/messages/{id}
 * 拿正文」。收信箱是一次性的，通常第一封就是 Z.ai 的验证邮件，仍按发件人优先过滤。
 *
 * @param {object} o {apiKey, address, timeoutMs=180000, pollMs=5000}
 * @returns {Promise<{link: string|null, subject: string, verificationCode: string|null, raw: object}>}
 *          超时抛错（err.timeout = true），调用方降级为手动粘贴链接。
 */
async function waitForVerifyMail({ apiKey, address, timeoutMs = 180000, pollMs = 4000, onTick = null } = {}) {
  assertKey(apiKey);
  const addr = String(address || '').trim();
  if (!addr) throw new Error('缺少邮箱地址');
  const deadline = Date.now() + Number(timeoutMs || 180000);
  const started = Date.now();
  let lastErr = null;
  let round = 0;

  while (Date.now() < deadline) {
    round += 1;
    try {
      const list = await call(apiKey, 'GET', '/messages?address=' + encodeURIComponent(addr));
      const msgs = (list && list.data && list.data.messages) || [];
      // 重发会让旧链接失效 —— 必须优先最新一封（按 createdAt 倒序）
      const sorted = msgs.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      const hit = sorted.find((m) => /z\.ai/i.test((m.from && m.from.address) || '')) || sorted[0];
      if (hit && hit.id) {
        const detail = await call(apiKey, 'GET', '/messages/' + encodeURIComponent(hit.id));
        const m = (detail && detail.data) || hit;
        const htmlList = Array.isArray(m.html) ? m.html : (m.html ? [m.html] : []);
        const link = extractVerifyLink(m.text, htmlList);
        if (link || m.verificationCode) {
          return {
            link,
            subject: String(m.subject || ''),
            verificationCode: m.verificationCode ? String(m.verificationCode) : null,
            raw: m,
          };
        }
        // 有信但没提取到链接（可能是不相干的信），继续轮等真正那封
      }
    } catch (e) {
      lastErr = e; // 单次网络抖动不放弃
    }
    if (typeof onTick === 'function') {
      try { onTick({ round, elapsedMs: Date.now() - started, lastError: lastErr ? lastErr.message : null }); } catch (_) {}
    }
    await new Promise((r) => setTimeout(r, Math.max(2000, Number(pollMs || 4000))));
  }
  const err = new Error('等待验证邮件超时' + (lastErr ? ('（最后一次错误：' + lastErr.message + '）') : ''));
  err.timeout = true;
  throw err;
}

module.exports = { API_BASE, createInbox, waitForVerifyMail, extractVerifyLink, findPlatformCode };

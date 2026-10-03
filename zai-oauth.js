'use strict';
/**
 * Z.AI OAuth 免密登录 —— 与 zcode2api 项目（app/oauth.py ZaiAuthFlow）同形。
 * 流程（全程不需要手机号，用邮箱注册的 Z.ai 账号在浏览器里授权即可）：
 *   1. startFlow(): POST /api/v1/oauth/cli/init（Bearer 随机 poll_token）
 *      → { flow_id, authorize_url }
 *   2. 用户在浏览器里打开 authorize_url，登录并点「授权」
 *   3. pollFlow(): GET /api/v1/oauth/cli/poll/{flow_id}
 *      → data.status = pending | ready | failed（ready 时 data.token = Coding Plan JWT）
 *
 * 上游 cli/init 发起的流程约 5 分钟过期；过期/未知 flow_id 的 poll 不报错，
 * 调用方据此提示重新发起。本模块不依赖 electron，可单测。
 *
 * 为什么不用 electron net / 面板内置代理窗口：授权页交给系统默认浏览器最省事
 * —— 代理、证书、登录态都归浏览器管，面板只负责生成链接和轮询结果。
 */

const crypto = require('crypto');

const OAUTH_API_BASE = 'https://zcode.z.ai/api/v1';
// 与 zcode2api 对齐：授权链接 5 分钟过期，略留余量
const FLOW_TTL_MS = 5 * 60 * 1000;

/** 生成一次流程所需的随机 poll_token（对齐 zcode2api：secrets.token_hex(32)） */
function newPollToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 发起一次 OAuth 流程。
 * @returns {Promise<{flowId: string, authorizeUrl: string, pollToken: string, expiresAt: number}>}
 */
async function startFlow() {
  const pollToken = newPollToken();
  const res = await fetch(OAUTH_API_BASE + '/oauth/cli/init', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + pollToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ provider: 'zai' }),
  });
  if (!res.ok) {
    throw new Error('cli/init HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  }
  const body = await res.json().catch(() => ({}));
  const data = body && body.data ? body.data : {};
  const flowId = String(data.flow_id || '');
  const authorizeUrl = String(data.authorize_url || '');
  if (!flowId || !authorizeUrl) {
    throw new Error('cli/init 返回数据不完整（缺 flow_id 或 authorize_url）');
  }
  return { flowId, authorizeUrl, pollToken, expiresAt: Date.now() + FLOW_TTL_MS };
}

/**
 * 轮询一次授权状态。
 * @returns {Promise<{status: 'pending'|'ready'|'failed'|'expired', token?: string, message?: string}>}
 */
async function pollFlow(flow) {
  if (!flow || !flow.flowId || !flow.pollToken) {
    return { status: 'expired', message: '没有进行中的授权流程' };
  }
  if (Date.now() > flow.expiresAt) {
    return { status: 'expired', message: '授权链接已过期（约 5 分钟有效），请重新发起' };
  }
  let res;
  try {
    res = await fetch(OAUTH_API_BASE + '/oauth/cli/poll/' + encodeURIComponent(flow.flowId), {
      headers: { 'Authorization': 'Bearer ' + flow.pollToken },
    });
  } catch (e) {
    // 单次网络抖动按 pending 处理（与 zcode2api 同口径），不中断轮询
    return { status: 'pending' };
  }
  if (!res.ok) {
    return { status: 'pending' };
  }
  const body = await res.json().catch(() => ({}));
  const data = body && body.data ? body.data : {};
  const state = String(data.status || 'pending');
  if (state === 'ready') {
    const token = String(data.token || '');
    if (!token) return { status: 'failed', message: '授权成功但未返回凭证' };
    // zai.access_token 是 chat.z.ai 的 OAuth 令牌 —— ZCode 桌面端的登录态靠它
    //（credentials.json 的 oauth:zai:access_token），只有 zcodejwttoken 会显示未登录。
    const zai = (data.zai && typeof data.zai === 'object') ? data.zai : {};
    return { status: 'ready', token, zaiAccessToken: String(zai.access_token || '') };
  }
  if (state === 'failed') {
    const reason = data.message || data.reason || '授权失败或被拒绝';
    return { status: 'failed', message: String(reason) };
  }
  return { status: 'pending' };
}

module.exports = { startFlow, pollFlow, newPollToken, OAUTH_API_BASE, FLOW_TTL_MS };

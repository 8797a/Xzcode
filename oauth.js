'use strict';

/**
 * ZCode OAuth（Authorization Code）实现 —— BigModel / Z.ai 双线路。
 *
 * 逆向自官方客户端 app.asar 的 OAuth adapter：
 *
 *   BigModel（id = "bigmodel"）
 *     authorizeUrl : https://bigmodel.cn/login
 *     appId        : zcode
 *     redirectUri  : zcode://oauth/callback
 *     tokenUrl     : https://zcode.z.ai/api/v1/oauth/token
 *     userinfoUrl  : https://bigmodel.cn/api/biz/customer/getCustomerInfo
 *     授权参数      : redirect=<uri> & appId=<appId> & state=<state>
 *
 *   Z.ai（id = "zai"）
 *     authorizeUrl : https://chat.z.ai/api/oauth/authorize
 *     appId        : client_P8X5CMWmlaRO9gyO-KSqtg
 *     redirectUri  : zcode://oauth/callback
 *     tokenUrl     : https://zcode.z.ai/api/v1/oauth/token
 *     userinfoUrl  : https://chat.z.ai/api/oauth/userinfo
 *     授权参数      : redirect_uri & response_type=code & client_id & state
 *
 * 桌面端生产环境 redirectUri 为 https 桥接页：
 *   https://zcode.z.ai/app/oauth/login?redirect=zcode://oauth/callback&app_version=<ver>
 * 授权完成后桥接页把 code 转交 zcode:// 自定义协议。两种形态本模块都支持。
 *
 * 凭据落盘键名（与官方一致）：
 *   oauth:active_provider / oauth:<provider>:access_token
 *   oauth:<provider>:refresh_token / oauth:<provider>:user_info / zcodejwttoken
 */

const crypto = require('crypto');
const os = require('os');

const APP_VERSION = '3.11.2';
const ZCODE_ORIGIN = 'https://zcode.z.ai';
const DESKTOP_REDIRECT = 'zcode://oauth/callback';

const PROVIDERS = {
  bigmodel: {
    id: 'bigmodel',
    displayName: 'BigModel',
    authorizeUrl: 'https://bigmodel.cn/login',
    appId: 'zcode',
    redirectUri: DESKTOP_REDIRECT,
    tokenUrl: ZCODE_ORIGIN + '/api/v1/oauth/token',
    userinfoUrl: 'https://bigmodel.cn/api/biz/customer/getCustomerInfo',
    paramStyle: 'redirect-appId',
  },
  zai: {
    id: 'zai',
    displayName: 'Z.ai',
    authorizeUrl: 'https://chat.z.ai/api/oauth/authorize',
    appId: 'client_P8X5CMWmlaRO9gyO-KSqtg',
    redirectUri: DESKTOP_REDIRECT,
    tokenUrl: ZCODE_ORIGIN + '/api/v1/oauth/token',
    userinfoUrl: 'https://chat.z.ai/api/oauth/userinfo',
    businessLoginUrl: 'https://api.z.ai/api/auth/z/login',
    paramStyle: 'oauth2',
  },
};

// ---------------------------------------------------------------- redirect

function desktopRedirectUri(appVersion = APP_VERSION) {
  const u = new URL('/app/oauth/login', ZCODE_ORIGIN);
  u.searchParams.set('redirect', DESKTOP_REDIRECT);
  u.searchParams.set('app_version', appVersion);
  return u.toString();
}

function resolveRedirectUri(providerId, mode, appVersion) {
  if (mode === 'direct') return DESKTOP_REDIRECT;
  return desktopRedirectUri(appVersion);
}

function buildAuthorizeUrl(providerId, state, mode = 'bridge', appVersion = APP_VERSION) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error('未知 OAuth provider: ' + providerId);
  const redirectUri = resolveRedirectUri(providerId, mode, appVersion);
  const q = p.paramStyle === 'oauth2'
    ? new URLSearchParams({
        redirect_uri: redirectUri,
        response_type: 'code',
        client_id: p.appId,
        state,
      })
    : new URLSearchParams({
        redirect: redirectUri,
        appId: p.appId,
        state,
      });
  return { url: p.authorizeUrl + '?' + q.toString(), redirectUri, provider: providerId };
}

// ---------------------------------------------------------------- callback

// 官方 parseCallbackParams：authCode ?? code，配合 state
function parseCallbackUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const code = url.searchParams.get('authCode') || url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return null;
  return { code: code.trim(), state: state.trim(), href: raw };
}

function parseManualInput(input, state) {
  const raw = (input || '').trim();
  if (!raw) return null;
  const asUrl = parseCallbackUrl(raw);
  if (asUrl) return asUrl;
  if (state && raw === state) return null;
  return { code: raw, state: state || '', href: null };
}

// ---------------------------------------------------------------- token

function trimOrNull(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// 官方 resolveBigModelBusinessAccessToken 的回退链
function resolveAccessToken(providerId, data) {
  if (!data) return null;
  const bag = data[providerId] || {};
  for (const c of [bag.access_token, bag.accessToken, data.access_token, data.accessToken]) {
    const v = trimOrNull(c);
    if (v) return v;
  }
  return null;
}

function resolveRefreshToken(providerId, data) {
  if (!data) return null;
  const bag = data[providerId] || {};
  return trimOrNull(bag.refresh_token) || trimOrNull(bag.refreshToken) || null;
}

async function exchangeCode(providerId, code, state, redirectUri) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error('未知 OAuth provider: ' + providerId);

  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: providerId,
      code,
      redirect_uri: redirectUri || p.redirectUri,
      state: state || '',
    }),
  });

  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error('token 响应不是 JSON（HTTP ' + res.status + '）：' + text.slice(0, 200));
  }
  if (!json) throw new Error('token 响应为空（HTTP ' + res.status + '）');
  if (json.code !== undefined && json.code !== 0) {
    throw new Error((json.msg && String(json.msg).trim()) || ('token 交换被拒绝（code: ' + json.code + '）'));
  }

  const data = json.data || {};
  const accessToken = resolveAccessToken(providerId, data);
  if (!accessToken) throw new Error('token 响应缺少 data.' + providerId + '.access_token');

  return {
    provider: providerId,
    accessToken,
    refreshToken: resolveRefreshToken(providerId, data),
    zcodeJwt: trimOrNull(data.token) || trimOrNull(data.zcodeJwtToken) || null,
    raw: data,
  };
}

async function fetchUserInfo(providerId, accessToken) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error('未知 OAuth provider: ' + providerId);
  try {
    const res = await fetch(p.userinfoUrl, {
      headers: {
        // 必须带 Bearer。实测 z.ai 不带前缀直接 401「Missing Authorization header」，
        // 拿不到用户名，账号就只能落成 user_<jwt尾号> 这种认不出来的名字。
        // bigmodel 两种写法都收，所以统一加上不会破坏它。
        authorization: /^Bearer\s/i.test(accessToken) ? accessToken : 'Bearer ' + accessToken,
        'content-type': 'application/json',
        accept: 'application/json',
      },
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { return null; }
    const d = (json && (json.data || json)) || {};
    // z.ai 顶层直接给 name / sub / email；bigmodel 包在 data 里且叫 customerName / customerNumber
    const name = trimOrNull(d.customerName) || trimOrNull(d.username)
      || trimOrNull(d.displayName) || trimOrNull(d.name) || trimOrNull(d.customerNumber);
    return {
      id: trimOrNull(d.customerNumber) || trimOrNull(d.id) || trimOrNull(d.sub) || 'unknown',
      username: name || 'user',
      displayName: name || 'user',
      email: trimOrNull(d.email) || null,
      avatarUrl: trimOrNull(d.avatar) || trimOrNull(d.picture) || null,
      raw: d,
    };
  } catch {
    return null;
  }
}

// Z.ai 侧需要用 oauth access_token 再换一次业务 token
async function triggerBusinessLogin(accessToken) {
  const p = PROVIDERS.zai;
  if (!p.businessLoginUrl) return 'skipped';
  try {
    const res = await fetch(p.businessLoginUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: accessToken }),
    });
    const json = await res.json().catch(() => null);
    if (!json) return 'failed';
    if (json.code === 0 || json.code === 200) return 'ready';
    return 'failed';
  } catch {
    return 'failed';
  }
}

// ---------------------------------------------------------------- crypto

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const NONCE_SIZE = 12;
const CREDENTIAL_SECRET_ENV = 'ZCODE_CREDENTIAL_SECRET';

function defaultCredentialSecret(env = process.env) {
  if (env[CREDENTIAL_SECRET_ENV]) return env[CREDENTIAL_SECRET_ENV];
  let username = 'unknown';
  try { username = os.userInfo().username; } catch (_) {}
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
}

function deriveKey(secret = defaultCredentialSecret()) {
  return crypto.createHash('sha256').update(secret).digest();
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function decrypt(value, secret = defaultCredentialSecret()) {
  if (!isEncrypted(value)) return value;
  const parts = value.slice(PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('enc:v1 格式不正确');
  const [noncePart, tagPart, cipherPart] = parts;
  const decipher = crypto.createDecipheriv(ALGO, deriveKey(secret), Buffer.from(noncePart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(cipherPart, 'base64url')), decipher.final()]).toString('utf8');
}

function encrypt(plainText, secret = defaultCredentialSecret()) {
  const nonce = crypto.randomBytes(NONCE_SIZE);
  const cipher = crypto.createCipheriv(ALGO, deriveKey(secret), nonce);
  const cipherText = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  return [PREFIX, nonce.toString('base64url'), '.', cipher.getAuthTag().toString('base64url'), '.', cipherText.toString('base64url')].join('');
}

module.exports = {
  APP_VERSION,
  DESKTOP_REDIRECT,
  PROVIDERS,
  desktopRedirectUri,
  resolveRedirectUri,
  buildAuthorizeUrl,
  parseCallbackUrl,
  parseManualInput,
  exchangeCode,
  fetchUserInfo,
  triggerBusinessLogin,
  encrypt,
  decrypt,
  isEncrypted,
  defaultCredentialSecret,
};

'use strict';
/**
 * 账号导入 —— 把"一份账号凭据"变成面板里一个可用账号
 * =====================================================================
 * 为什么单独一个模块：这段逻辑要能**脱离 electron 单独测试**
 * （校验、拒绝、落盘都能跑），main.js 只负责把它接到 IPC 上。
 *
 * 预期输入（宽松兼容几种形态，都是"买家从小店拿到的那份"）：
 *   { "name": "xxx", "jwt": "eyJ…", "device_mid": "uuid" }
 *   或 { "account": { … } }、或字段名用 deviceMid / mid / token / jwtToken
 *   也可以是 JSON 文本（从剪贴板或 .json 文件来的）
 *
 * 落盘结果 = 面板能直接认的账号目录（口径照搬 main.js）：
 *   <账号>/data/.zcode/v2/config.json        ← 面板 readAccountJwt 读这个
 *   <账号>/data/.zcode/v2/credentials.json   ← 面板 valid 判据 (hasCred && hasCfg)
 *   <账号>/data/.zcode/v2/telemetry-state.json
 *   <账号>/meta.json
 *   <账号>/config.json                       ← 与现成账号布局一致，保留兼容
 *
 * 安全：**只认白名单字段**，逐一严格校验（名字不许有路径分隔、jwt 必须三段、
 * device_mid 必须是 UUID），并且**默认拒绝覆盖已有账号**。
 */

const fs = require('fs');
const path = require('path');

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CRED_RE = /^(eyJ|sk-|enc:v1:)/;

/** 从任意形态里抽出 {name, jwt, device_mid, note}；失败返回 {error} */
function normalize(raw) {
  let o = raw;
  if (typeof o === 'string') {
    const t = o.trim().replace(/^\uFEFF/, '');
    if (!t) return { error: 'empty', msg: '内容是空的' };
    try { o = JSON.parse(t); } catch (e) { return { error: 'not-json', msg: '不是合法 JSON：' + e.message }; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'not-object', msg: '需要是一个对象' };
  // 允许外面包一层
  for (const k of ['account', 'data', 'payload']) {
    if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) && (o[k].jwt || o[k].jwtToken || o[k].device_mid || o[k].deviceMid)) { o = o[k]; break; }
  }

  const pick = (...keys) => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const name = pick('name', 'id', 'accountName');
  const jwt = pick('jwt', 'jwtToken', 'zcodejwttoken', 'token', 'apiKey');
  const mid = pick('device_mid', 'deviceMid', 'mid', 'deviceId');
  const note = pick('note', 'desc', 'description');

  if (!NAME_RE.test(name)) return { error: 'bad-name', msg: '账号名不合法（只允许字母数字下划线短横，1–32 位）：' + JSON.stringify(name) };
  if (!JWT_RE.test(jwt)) return { error: 'bad-jwt', msg: 'jwt 不合法（应是 eyJ 开头的三段点分串）' };
  if (!UUID_RE.test(mid)) return { error: 'bad-mid', msg: 'device_mid 不合法（应是 UUID）' };
  return { name, jwt, device_mid: mid, note };
}

/**
 * 用一份现成账号的 config 当模板生成新 config：
 *   · 只保留 `builtin:` 开头的 provider（第三方 provider 夹带别人的凭据，剔除）
 *   · 把 JWT 写进 builtin 的 options.apiKey
 *   · 清空一切凭据形态的残留值
 */
function buildConfig(template, jwt) {
  const out = (template && typeof template === 'object') ? JSON.parse(JSON.stringify(template)) : { provider: {} };
  out.provider = out.provider && typeof out.provider === 'object' ? out.provider : {};
  let kept = 0;
  for (const [k, v] of Object.entries(out.provider)) {
    if (!k.startsWith('builtin:')) { delete out.provider[k]; continue; }
    if (v && v.options && typeof v.options.apiKey === 'string') v.options.apiKey = jwt;
    if (v && v.nodeKey === true) v.nodeKey = jwt;
    // 兜底：清掉其它凭据形态
    (function scrub(x) {
      if (!x || typeof x !== 'object') return;
      for (const [kk, vv] of Object.entries(x)) {
        if (typeof vv === 'string' && CRED_RE.test(vv) && vv !== jwt) x[kk] = '';
        else if (vv && typeof vv === 'object') scrub(vv);
      }
    })(v);
    kept++;
  }
  if (!kept) {
    out.provider['builtin:bigmodel-start-plan'] = {
      name: 'BigModel - Coding Plan', kind: 'bigmodel',
      options: { apiKey: jwt, baseURL: 'https://zcode.z.ai' }, enabled: true, source: 'import',
    };
  }
  return out;
}

/**
 * 执行导入。
 * @param {object} opts
 * @param {string|object} opts.payload  凭据（对象或 JSON 文本）
 * @param {string} opts.accountsDir     面板账号目录
 * @param {(s:string)=>string} opts.encrypt  凭据加密（面板 oauth.encrypt）
 * @param {object} [opts.template]      模板 config（现成账号的 config.json 内容）
 * @param {boolean} [opts.replace]      允许覆盖同名账号（默认否）
 */
function importAccount(opts = {}) {
  const { payload, accountsDir, encrypt, template, replace } = opts;
  if (!accountsDir) return { ok: false, error: 'no-dir', msg: '账号目录未配置' };
  const n = normalize(payload);
  if (n.error) return { ok: false, error: n.error, msg: n.msg };
  if (typeof encrypt !== 'function') return { ok: false, error: 'no-encrypt', msg: '缺少凭据加密函数' };

  const dir = path.join(accountsDir, n.name);
  // 目录穿越防护（名字已被白名单限死，这里是第二道）
  if (path.dirname(dir) !== path.resolve(accountsDir)) return { ok: false, error: 'escape', msg: '非法路径' };
  if (fs.existsSync(dir)) {
    const hasCfg = fs.existsSync(path.join(dir, 'data', '.zcode', 'v2', 'config.json')) || fs.existsSync(path.join(dir, 'config.json'));
    if (!replace) return { ok: false, error: 'exists', msg: '账号「' + n.name + '」已存在，换一个名字或先删掉它' };
    if (hasCfg) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return { ok: false, error: 'rm-failed', msg: '覆盖前清理失败：' + e.message }; } }
  }

  const v2 = path.join(dir, 'data', '.zcode', 'v2');
  try { fs.mkdirSync(v2, { recursive: true }); } catch (e) { return { ok: false, error: 'mkdir', msg: '建目录失败：' + e.message }; }

  const cfg = buildConfig(template, n.jwt);
  const w = (p, obj, isText) => fs.writeFileSync(p, isText ? obj : JSON.stringify(obj, null, 2), 'utf8');
  try {
    w(path.join(v2, 'config.json'), cfg);
    w(path.join(dir, 'config.json'), cfg);
    w(path.join(v2, 'credentials.json'), {
      'zcodejwttoken': encrypt(n.jwt),
      'oauth:active_provider': encrypt('bigmodel'),
    });
    w(path.join(v2, 'telemetry-state.json'), { deviceMid: n.device_mid, lastDailyActiveDate: new Date().toISOString().slice(0, 10) });
    w(path.join(dir, 'meta.json'), {
      registered_at: new Date().toISOString(), registered_at_source: 'import',
      captured_at: new Date().toISOString(), last_used_at: null,
      switch_count: 0, switches_today: 0, last_switch_date: null,
      via: 'import', phone: null, email: null,
      device_mid: n.device_mid, note: n.note || '',
    });
  } catch (e) {
    return { ok: false, error: 'write', msg: '写文件失败：' + e.message };
  }
  return { ok: true, id: n.name, dir, providers: Object.keys(cfg.provider || {}) };
}

module.exports = { importAccount, normalize, buildConfig, NAME_RE, UUID_RE, JWT_RE };

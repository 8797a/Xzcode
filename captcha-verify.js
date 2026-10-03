'use strict';

/**
 * 阿里云无痕验证（invisible captcha）参数求解。
 *
 * 「一键领取额外额度」等需要 X-Aliyun-Captcha-Verify-Param 的上游调用都要先过
 * 这道验证。解法：隐藏 BrowserWindow 加载 zcode.z.ai 同源的轻页面（favicon.ico），
 * 在页内跑 AliyunCaptcha SDK 的 startTracelessVerification 拿 verifyParam。
 *
 * 实测要点（2026-09-27/28，全链路 claim 已打通）：
 *   - backgroundThrottling 必须关：隐藏窗口的定时器会被冻结，SDK 直接卡死不回调
 *   - sandbox + contextIsolation 开着没问题，SDK 是纯前端脚本
 *   - 加载目标用 favicon.ico：同源、极轻，避开 SPA 几 MB 的静态资源
 *   - captcha 配置（prefix/region/sceneId）从 client/configs 拉活的，拉不到用兜底；
 *     region 实测已从 sgp 变成 cn，所以不能写死
 *   - verifyParam 有效期约 2 分钟，缓存必须短；被上游拒绝就作废重解
 */

const DEFAULT_CAPTCHA = { prefix: 'no8xfe', region: 'cn', sceneId: '11xygtvd' };
const SOLVE_TIMEOUT_MS = 25000;
const PARAM_TTL_MS = 90 * 1000;     // verifyParam 实测约 2 分钟有效，留余量
const CONFIG_TTL_MS = 10 * 60 * 1000;
const CONFIGS_URL = 'https://zcode.z.ai/api/v1/client/configs?app_version=3.14.3&platform=win32-x64';
const WARMUP_URL = 'https://zcode.z.ai/favicon.ico';

let BrowserWindowRef = null;
let userAgent = 'ZCode/3.14.3';
let paramCache = { param: null, region: null, at: 0 };
let inflight = null;
let capCfg = { cfg: DEFAULT_CAPTCHA, at: 0 };

function init({ BrowserWindow, userAgent: ua } = {}) {
  if (BrowserWindow) BrowserWindowRef = BrowserWindow;
  if (ua) userAgent = ua;
}

async function fetchConfig() {
  if (capCfg.cfg && Date.now() - capCfg.at < CONFIG_TTL_MS) return capCfg.cfg;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(CONFIGS_URL, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    clearTimeout(timer);
    const body = await res.json();
    const c = body && body.data && body.data.configs && body.data.configs.captcha;
    if (c && (c.prefix || c.scene_id)) {
      capCfg = {
        cfg: {
          prefix: c.prefix || DEFAULT_CAPTCHA.prefix,
          region: c.region || DEFAULT_CAPTCHA.region,
          sceneId: c.scene_id || c.sceneId || DEFAULT_CAPTCHA.sceneId,
        },
        at: Date.now(),
      };
    }
  } catch (_) {
    capCfg = { cfg: DEFAULT_CAPTCHA, at: Date.now() }; // 拉不到就按兜底用，别反复重试
  }
  return capCfg.cfg;
}

function pageScript(cfg) {
  return `(async () => {
  const load = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('sdk-load-fail'));
    document.head.appendChild(s);
  });
  await load('https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js');
  if (typeof initAliyunCaptcha !== 'function') return 'NO-INIT-FN';
  const host = document.createElement('div'); host.id = 'cap'; document.body.appendChild(host);
  const btn = document.createElement('button'); btn.id = 'cap-btn'; document.body.appendChild(btn);
  return await new Promise((resolve) => {
    let fin = false;
    const t = setTimeout(() => { if (!fin) { fin = true; resolve('CAPTCHA-TIMEOUT-IN-PAGE'); } }, 20000);
    try {
      initAliyunCaptcha({
        SceneId: '${cfg.sceneId}', mode: 'popup', region: '${cfg.region}', prefix: '${cfg.prefix}',
        element: '#cap', button: '#cap-btn', captchaLogoImg: '', showErrorTip: false,
        getInstance: (inst) => { try { (inst.startTracelessVerification || inst.show).call(inst); } catch (e) {} },
        success: (param) => { if (!fin) { fin = true; clearTimeout(t); resolve(String(param)); } },
        fail: () => { if (!fin) { fin = true; clearTimeout(t); resolve('CAPTCHA-FAIL'); } },
        onError: () => { if (!fin) { fin = true; clearTimeout(t); resolve('CAPTCHA-ERROR'); } },
      });
    } catch (e) { resolve('INIT-THREW: ' + e.message); }
  });
})().catch(e => 'OUTER-ERR: ' + (e && e.message))`;
}

async function solveInWindow(cfg) {
  if (!BrowserWindowRef) throw new Error('captcha-verify 未初始化（缺 BrowserWindow）');
  const win = new BrowserWindowRef({
    show: false,
    width: 460,
    height: 420,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false, // 隐藏窗口的定时器节流会冻死 SDK
    },
  });
  try {
    await win.loadURL(WARMUP_URL, { userAgent });
    const param = await win.webContents.executeJavaScript(pageScript(cfg), true);
    return String(param || '');
  } finally {
    try { win.destroy(); } catch (_) {}
  }
}

/**
 * 取一个可用的 verifyParam。单飞 + 短缓存；失败返回 { param: null, err }。
 * 返回 { param, region }——region 要跟着塞进 X-Aliyun-Captcha-Verify-Region 头。
 */
async function getVerifyParam() {
  if (paramCache.param && Date.now() - paramCache.at < PARAM_TTL_MS) {
    return { param: paramCache.param, region: paramCache.region };
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const cfg = await fetchConfig();
      const raw = await solveInWindow(cfg);
      if (!raw || raw.length < 40 || /^(CAPTCHA|OUTER|NO-INIT)/.test(raw)) {
        return { param: null, region: cfg.region, err: raw || 'empty' };
      }
      paramCache = { param: raw, region: cfg.region, at: Date.now() };
      return { param: raw, region: cfg.region };
    } catch (e) {
      return { param: null, region: null, err: (e && e.message) || String(e) };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 上游拒绝当前参数（3007/403 带验证码头）时作废缓存，下次重新解 */
function invalidate() {
  paramCache = { param: null, region: null, at: 0 };
}

function peek() {
  return paramCache.param && Date.now() - paramCache.at < PARAM_TTL_MS ? paramCache.param : null;
}

module.exports = { init, getVerifyParam, invalidate, peek };

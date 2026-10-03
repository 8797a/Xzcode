'use strict';

/**
 * 强制更新检查。
 *
 * 拿 GitHub 上最新 Release 的 tag 和本机版本比，更新了就要求使用者先更新，
 * 不给出「继续使用」的口子。
 *
 * 三个设计取舍：
 *
 * ① **网络不通一律放行。** 只有「明确查到有更新的版本」才拦人。API 限流、
 *    代理没开、GitHub 被墙、仓库还没有 Release —— 这些一律当作「没查到」，
 *    不能因为一次请求失败就把使用者锁在自己的软件外面。
 *
 * ② **不自己下载替换 exe。** 便携版运行时是从临时目录解压出来的，替换正在跑的
 *    那份根本落不到使用者的 exe 上；而且自替换型程序很容易被 Defender 拦下。
 *    所以这里只负责「发现 + 拦住 + 把人送到下载页」，下载交给浏览器。
 *
 * ③ **版本解析失败不判更新。** 宁可漏掉一次，也不要因为 tag 写得不规范
 *    就把所有人挡在门外。
 *
 * 本模块不依赖 electron，网络通过 fetchJson 注入，方便单测。
 */

const RELEASES_API = 'https://api.github.com/repos/8797a/Xzcode/releases/latest';
const DEFAULT_TIMEOUT = 8000;

/**
 * 把 "v1.2.3" / "1.2.3" / "1.2.3-beta.1" 拆成可比较的段。
 * 解析不了返回 null（调用方据此判定「不比了」）。
 */
function parseVersion(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(s);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    // 空串表示正式版；正式版要大于同号预发布（1.2.3 > 1.2.3-beta）
    pre: m[4] ? String(m[4]) : '',
  };
}

/**
 * 语义化比较。任一版解析不出来就返回 0（视为一样），
 * 这样「tag 不规范」只会导致漏更新，不会导致误锁。
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

/** latest 是否比 current 新 */
function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}

/**
 * 从 Release 的 assets 里挑出给 Windows 用的那个 exe。
 * 优先带 portable 字样的（单文件绿色版，最省事），否则退而求其次拿第一个 exe。
 */
function pickAsset(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const exes = assets.filter(
    (a) => a && typeof a.name === 'string' && /\.exe$/i.test(a.name) && a.browser_download_url
  );
  if (!exes.length) return null;
  const portable = exes.find((a) => /portable/i.test(a.name));
  const chosen = portable || exes[0];
  return {
    name: chosen.name,
    url: chosen.browser_download_url,
    size: Number(chosen.size) || 0,
  };
}

/** 把 GitHub 的 Release JSON 收敛成我们真正要用的几个字段 */
function parseRelease(json) {
  if (!json || typeof json !== 'object') return null;
  const tag = json.tag_name || json.name;
  if (!tag) return null;
  return {
    version: String(tag),
    name: typeof json.name === 'string' && json.name ? json.name : String(tag),
    notes: typeof json.body === 'string' ? json.body : '',
    pageUrl: typeof json.html_url === 'string' ? json.html_url : '',
    publishedAt: json.published_at || null,
    prerelease: !!json.prerelease,
    asset: pickAsset(json),
  };
}

/**
 * 查一次是否有新版本。
 *
 * @param {object} opts
 * @param {string} opts.currentVersion  本机版本（app.getVersion()）
 * @param {Function} opts.fetchJson     (url, timeout) => Promise<Release JSON>
 * @returns {Promise<{ok:boolean, hasUpdate:boolean, current:string, latest:string|null,
 *                    release:object|null, reason:string, msg?:string}>}
 */
async function checkForUpdate(opts = {}) {
  const current = String(opts.currentVersion || '0.0.0');
  const fetchJson = opts.fetchJson;
  const base = { ok: false, hasUpdate: false, current, latest: null, release: null, reason: '' };

  if (typeof fetchJson !== 'function') {
    return { ...base, reason: 'no-fetcher', msg: '没有可用的网络通道' };
  }

  let json;
  try {
    json = await fetchJson(RELEASES_API, opts.timeout || DEFAULT_TIMEOUT);
  } catch (e) {
    return { ...base, reason: 'check-failed', msg: (e && e.message) || String(e) };
  }

  const release = parseRelease(json);
  if (!release) return { ...base, reason: 'no-release', msg: '仓库还没有可用的 Release' };

  // /releases/latest 本身就会过滤掉 draft 和 prerelease，
  // 这里再判一次是防御性写法：万一以后换成列表接口也不会误推预发布。
  if (release.prerelease && !opts.allowPrerelease) {
    return { ...base, ok: true, latest: release.version, release, reason: 'prerelease-skipped' };
  }

  const hasUpdate = isNewer(release.version, current);
  return {
    ok: true,
    hasUpdate,
    current,
    latest: release.version,
    release,
    reason: hasUpdate ? 'newer' : 'up-to-date',
  };
}

/** 把字节数说成人话，用在下载按钮上 */
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

module.exports = {
  RELEASES_API,
  parseVersion,
  compareVersions,
  isNewer,
  pickAsset,
  parseRelease,
  checkForUpdate,
  fmtSize,
};

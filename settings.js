'use strict';

/**
 * 面板设置。
 *
 * 必须由使用者确认的只有 ZCode 客户端的位置：不同机器上盘符、用户名、安装目录
 * 都不一样，写死任何一个都会让面板在别人的机器上直接不可用。
 * 这里既做多源自动探测，也允许手动指定，并落盘到 %APPDATA%\xzcode\settings.json。
 *
 * 探测优先级（从最可靠到最兜底）：
 *   1. 使用者在设置页里指定的路径
 *   2. ZCODE_EXE 环境变量
 *   3. 注册表 zcode:// 协议注册——装了客户端就一定有它，且带完整路径
 *   4. 注册表卸载项里的 DisplayIcon / UninstallString，反推安装目录
 *   5. 常见安装路径（含一层子目录扫描，应对目录被改名）
 *   6. 正在运行的 ZCode 进程自身的可执行文件路径
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROAMING_DIR = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const APP_DIR = path.join(ROAMING_DIR, 'xzcode');
const LEGACY_APP_DIRS = [
  path.join(ROAMING_DIR, 'zcode-dashboard'),
  path.join(ROAMING_DIR, 'zcode-panel'),
];

// 品牌改名迁移：新目录首次运行时复制最近一版旧数据，旧目录原样保留以便回退。
// 不覆盖已存在的新目录，避免重复启动时把新数据盖回旧版本。
if (!fs.existsSync(APP_DIR)) {
  const source = LEGACY_APP_DIRS.find((dir) => fs.existsSync(dir));
  if (source) {
    try { fs.cpSync(source, APP_DIR, { recursive: true, errorOnExist: false }); } catch (_) {}
  }
}
const FILE = path.join(APP_DIR, 'settings.json');

const DEFAULTS = { zcodeExe: '', accountsDir: '', yydsMailKey: '' };

let cache = null;
let lastDetect = null;

// ---------------------------------------------------------------- 读写

function load() {
  if (cache) return cache;
  let raw = {};
  try {
    // 必须剥掉 UTF-8 BOM：记事本这类编辑器保存时会带上它，
    // 而 JSON.parse 遇到 BOM 会直接抛错——不处理的话用户手改过的配置会被静默忽略。
    const text = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '');
    raw = JSON.parse(text) || {};
  } catch (_) { raw = {}; }
  cache = {
    zcodeExe: typeof raw.zcodeExe === 'string' ? raw.zcodeExe.trim() : DEFAULTS.zcodeExe,
    accountsDir: typeof raw.accountsDir === 'string' ? raw.accountsDir.trim() : DEFAULTS.accountsDir,
    yydsMailKey: typeof raw.yydsMailKey === 'string' ? raw.yydsMailKey.trim() : DEFAULTS.yydsMailKey,
  };
  return cache;
}

function save(patch = {}) {
  const next = { ...load() };
  if (typeof patch.zcodeExe === 'string') next.zcodeExe = patch.zcodeExe.trim();
  if (typeof patch.accountsDir === 'string') next.accountsDir = patch.accountsDir.trim();
  // 空字符串 = 想清空；不传（undefined）= 保持不变（渲染端"留空保持不变"的语义靠它实现）
  if (typeof patch.yydsMailKey === 'string') next.yydsMailKey = patch.yydsMailKey.trim();
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, msg: '设置写入失败：' + (e.message || e) };
  }
  cache = next;
  return { ok: true, settings: next, file: FILE };
}

const settingsFile = () => FILE;

/**
 * 最终生效的 ZCode 可执行文件路径（同步）。
 * 顺序：设置里指定的 > 环境变量 > 上次探测结果 > 常见路径里第一个真实存在的。
 * 全都落空时才返回一个占位猜测，调用方必须用 describeExe() 判可用性。
 */
function currentExe() {
  const s = load();
  if (s.zcodeExe) return { path: s.zcodeExe, source: 'settings' };
  if (process.env.ZCODE_EXE) return { path: process.env.ZCODE_EXE, source: 'env' };
  if (lastDetect && lastDetect.exe) return { path: lastDetect.exe, source: 'detect' };
  const list = commonPaths();
  for (const p of list) {
    if (isUsableExe(p)) return { path: p, source: 'common' };
  }
  return { path: list[0], source: 'guess' };
}

// ---------------------------------------------------------------- 校验

/**
 * 判断路径是否存在，且不受 Electron 的 asar 补丁干扰。
 *
 * Electron 会把任何路径里含 .asar 的条目当成虚拟归档：连归档文件"自身"的
 * 存在性判断都会走 asar 解析，结果为假。所以查之前临时把 asar 支持关掉。
 * process.noAsar 是 Electron 专有属性，纯 Node 下本来就是 undefined，设回去即可。
 */
function existsRaw(p) {
  const prev = process.noAsar;
  try {
    process.noAsar = true;
    return fs.existsSync(p);
  } catch (_) {
    return false;
  } finally {
    process.noAsar = prev;
  }
}

function describeExe(p) {
  const target = String(p || '').trim();
  if (!target) return { ok: false, level: 'bad', msg: '未指定 ZCode 主程序' };
  let st;
  try { st = fs.statSync(target); } catch (_) {
    return { ok: false, level: 'bad', msg: '文件不存在' };
  }
  if (!st.isFile()) return { ok: false, level: 'bad', msg: '这个路径不是文件' };
  if (!/\.exe$/i.test(target)) return { ok: false, level: 'bad', msg: '不是 .exe 文件' };
  if (!/zcode/i.test(path.basename(target))) {
    return { ok: false, level: 'bad', msg: '文件名里没有 ZCode，像是选错了' };
  }
  const dir = path.dirname(target);
  if (existsRaw(path.join(dir, 'resources', 'app.asar'))) {
    return { ok: true, level: 'good', msg: '已识别 ZCode 客户端（同目录有 resources\\app.asar）' };
  }
  if (existsRaw(path.join(dir, 'resources'))) {
    return { ok: true, level: 'warn', msg: '已找到程序，同目录有 resources 但没有 app.asar' };
  }
  return {
    ok: true,
    level: 'warn',
    msg: '程序存在，但同目录没有 resources 目录，可能不是 ZCode 主程序',
  };
}

function isUsableExe(p) {
  return describeExe(p).ok;
}

// ---------------------------------------------------------------- 探测

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

/** 读注册表某键的默认值 */
async function regDefault(key) {
  const out = await run('reg', ['query', key, '/ve']);
  if (!out) return '';
  // 英文系统写作 (Default)，中文写作 (默认)，两边都只认 REG_SZ 之后的内容
  const m = /REG_SZ\s+(.+)$/m.exec(out);
  return m ? m[1].trim() : '';
}

/** 递归搜卸载项里提到 ZCode 的键，把候选路径文本原样带回来 */
async function regUninstallBlob() {
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const parts = await Promise.all(
    roots.map((r) => run('reg', ['query', r, '/s', '/f', 'ZCode', '/d']))
  );
  return parts.join('\n');
}

/** 正在运行的 ZCode 自己的路径——最贴近事实的一个来源 */
async function runningExePath() {
  const out = await run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    "(Get-Process -Name ZCode -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)",
  ], 12000);
  return out.trim();
}

function commonPaths() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    path.join(local, 'Programs', 'ZCode', 'ZCode.exe'),
    path.join(local, 'ZCode', 'ZCode.exe'),
    path.join(pf, 'ZCode', 'ZCode.exe'),
    path.join(pf86, 'ZCode', 'ZCode.exe'),
    path.join(local, 'ZCode', 'app', 'ZCode.exe'),
  ];
}

/** 扫一层子目录，兜住「目录被改名」或「装在自定义位置」的情况 */
function scanSiblings() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const bases = [
    path.join(local, 'Programs'),
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ].filter(Boolean);
  const out = [];
  for (const base of bases) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !/zcode/i.test(e.name)) continue;
      out.push(path.join(base, e.name, 'ZCode.exe'));
    }
  }
  return out;
}

/**
 * 从一段注册表文本里抠出可能的 exe 路径。
 * 能处理三种写法：
 *   "C:\...\ZCode.exe" "%1"          —— 协议注册
 *   C:\...\uninstallerIcon.ico       —— 卸载项图标，据此反推目录
 *   "C:\...\Uninstall ZCode.exe" /s  —— 卸载程序，也是反推目录
 */
function candidatesFrom(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const fields = quoted.length ? quoted : [text];
  const out = [];
  for (const field of fields) {
    const t = field.trim().replace(/,\s*\d+\s*$/, ''); // 去掉 DisplayIcon 的 ",0" 索引
    if (!t) continue;
    const base = path.basename(t);
    if (/\.exe$/i.test(t)) {
      // 卸载程序也在安装目录里，用它反推主程序更稳
      if (/uninstall|卸载/i.test(base)) out.push(path.join(path.dirname(t), 'ZCode.exe'));
      else out.push(t);
      continue;
    }
    if (/\.(ico|png|dll|lnk)$/i.test(t) && /^[A-Za-z]:\\/.test(t)) {
      out.push(path.join(path.dirname(t), 'ZCode.exe'));
      continue;
    }
    // 纯目录
    if (/^[A-Za-z]:\\/.test(t) && !/\.[A-Za-z0-9]{2,5}$/.test(t)) {
      out.push(path.join(t, 'ZCode.exe'));
    }
  }
  return out;
}

/**
 * 多源自动探测。返回第一个真实存在的候选，并把探测过程一并带出，
 * 好让设置页能说明「为什么没找到」，而不是只丢一句失败。
 */
async function detect() {
  const tried = [];
  // 同一条路径被多个来源同时指向，是比单来源强得多的证据，所以合并而不是去重丢弃
  const push = (raw, source) => {
    for (const p of candidatesFrom(raw)) {
      const key = p.toLowerCase();
      const hit = tried.find((t) => t.path.toLowerCase() === key);
      if (hit) {
        if (!hit.sources.includes(source)) hit.sources.push(source);
        continue;
      }
      tried.push({ path: p, source, sources: [source], ok: isUsableExe(p) });
    }
  };

  push(process.env.ZCODE_EXE || '', 'ZCODE_EXE 环境变量');

  const [protoHkcu, protoHklm, uninstBlob, procPath] = await Promise.all([
    regDefault('HKCU\\Software\\Classes\\zcode\\shell\\open\\command'),
    regDefault('HKLM\\Software\\Classes\\zcode\\shell\\open\\command'),
    regUninstallBlob(),
    runningExePath(),
  ]);
  push(protoHkcu, '注册表 zcode:// 协议');
  push(protoHklm, '注册表 zcode:// 协议');
  for (const line of uninstBlob.split(/\r?\n/)) {
    // 行形如 `    DisplayIcon    REG_SZ    C:\...\uninstallerIcon.ico`
    // 必须切出 REG_SZ 之后的部分，否则连类型名一起当路径解析，永远匹配不上
    const m = /(?:REG_SZ|REG_EXPAND_SZ)\s+(.+)$/.exec(line);
    if (m) push(m[1].trim(), '注册表卸载项');
  }
  push(procPath, '正在运行的 ZCode 进程');

  for (const p of commonPaths()) push(p, '常见安装路径');
  for (const p of scanSiblings()) push(p, '安装目录扫描');

  const hit = tried.find((t) => t.ok);
  const result = {
    ok: !!hit,
    exe: hit ? hit.path : '',
    source: hit ? hit.sources.join(' + ') : '',
    tried,
    msg: hit ? '' : '所有自动探测都没找到 ZCode.exe，请手动指定',
  };
  // 留一份完整结果：设置页在自动弹出时要能直接说明"查过哪些地方"
  lastDetect = { ...result };
  return result;
}

function lastDetectResult() {
  return lastDetect ? { ...lastDetect } : null;
}

// ---------------------------------------------------------------- 账号目录

function defaultAccountsDir() {
  if (process.env.XZCODE_ACCOUNTS_DIR) return process.env.XZCODE_ACCOUNTS_DIR;
  if (process.env.ZDASHBOARD_ACCOUNTS_DIR) return process.env.ZDASHBOARD_ACCOUNTS_DIR;
  if (process.env.ZPANEL_ACCOUNTS_DIR) return process.env.ZPANEL_ACCOUNTS_DIR;
  // 打包后 __dirname 落在 resources\app.asar 里面，那是个只读的虚拟归档：
  // 往里 mkdir / 写账号数据会失败，而 accountsDir() 又把 mkdir 的错误吞掉了，
  // 结果是「面板能开、一添加账号就没反应」。所以打包态必须换到用户可写的位置。
  // 开发态（源码目录）保持原样，账号库就放在项目下的 accounts/。
  if (__dirname.includes('app.asar')) return path.join(APP_DIR, 'accounts');
  return path.join(__dirname, 'accounts');
}

/** 最终生效的账号目录（同步，带 mkdir） */
function accountsDir() {
  const custom = load().accountsDir;
  const target = custom || defaultAccountsDir();
  try { fs.mkdirSync(target, { recursive: true }); } catch (_) {}
  return target;
}

module.exports = {
  APP_DIR,
  settingsFile,
  load,
  save,
  currentExe,
  describeExe,
  isUsableExe,
  detect,
  lastDetectResult,
  accountsDir,
  defaultAccountsDir,
};

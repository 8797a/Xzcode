'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xzcode', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  currentUser: () => ipcRenderer.invoke('accounts:current'),
  plans: () => ipcRenderer.invoke('accounts:plans'),
  capture: (id, replace) => ipcRenderer.invoke('accounts:capture', id, replace),
  switchTo: (id, opts) => ipcRenderer.invoke('accounts:switch', id, opts),
  remove: (id) => ipcRenderer.invoke('accounts:delete', id),
  cleanupExpired: (opts) => ipcRenderer.invoke('accounts:cleanup-expired', opts),
  rollback: () => ipcRenderer.invoke('accounts:rollback'),
  oauthSessionStatus: () => ipcRenderer.invoke('oauth:session-status'),
  oauthResetSession: (provider) => ipcRenderer.invoke('oauth:reset-session', provider),
  calibrate: () => ipcRenderer.invoke('accounts:calibrate'),
  oauthStart: (provider, mode, options) => ipcRenderer.invoke('oauth:start', provider, mode, options),
  oauthProbeRegion: (provider) => ipcRenderer.invoke('oauth:probe-region', provider),
  // ZCode 自己的代理（写 setting.json；环境变量 ZCODE_HTTP_PROXY 它不读）
  proxyGet: () => ipcRenderer.invoke('proxy:get'),
  proxySet: (url) => ipcRenderer.invoke('proxy:set', url),
  oauthLink: (provider, mode) => ipcRenderer.invoke('oauth:link', provider, mode),
  oauthSubmit: (input) => ipcRenderer.invoke('oauth:submit', input),
  // 自动化进度事件流
  onPanelEvent: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('panel:event', h);
    return () => ipcRenderer.removeListener('panel:event', h);
  },
  // 主进程向使用者索要输入（手机号 / 短信验证码 / 邮箱 / 激活链接）
  onPanelAsk: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('panel:ask', h);
    return () => ipcRenderer.removeListener('panel:ask', h);
  },
  onPanelAskCancel: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('panel:ask-cancel', h);
    return () => ipcRenderer.removeListener('panel:ask-cancel', h);
  },
  panelAnswer: (id, value) => ipcRenderer.invoke('panel:answer', { id, value }),
  panelAskAbort: (id) => ipcRenderer.invoke('panel:ask-abort', id),
  // 设置：ZCode 客户端位置与账号数据目录
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsDetect: () => ipcRenderer.invoke('settings:detect'),
  settingsVerify: (p) => ipcRenderer.invoke('settings:verify', p),
  settingsSave: (patch) => ipcRenderer.invoke('settings:save', patch),
  settingsPickExe: () => ipcRenderer.invoke('settings:pick-exe'),
  settingsPickDir: () => ipcRenderer.invoke('settings:pick-dir'),
  settingsOpenFolder: (target) => ipcRenderer.invoke('settings:open-folder', target),
  // 启动自检发现客户端不可用时会推一次，界面据此自动打开设置页
  onNeedSetup: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('panel:need-setup', h);
    return () => ipcRenderer.removeListener('panel:need-setup', h);
  },
  fetchBalance: (force) => ipcRenderer.invoke('balance:fetch', force),
  planQuota: (force) => ipcRenderer.invoke('plans:quota', force),
  planRemote: (id) => ipcRenderer.invoke('plan:remote', id),
  planState: () => ipcRenderer.invoke('plan:state'),
  openApp: () => ipcRenderer.invoke('app:open'),
  // 外链一律交给系统默认浏览器打开（主进程侧带地址白名单校验）
  openUrl: (url) => ipcRenderer.invoke('app:open-url', url),
  // 【有鱼小店】在面板内的**小窗口浏览器**里打开（不是系统浏览器）
  openShop: (url) => ipcRenderer.invoke('shop:open', url),
  // 【导入账号】把从小店拿到的凭据导进本面板（B 方案：小店给凭据，面板来导入）
  importAccount: (payload, opts) => ipcRenderer.invoke('accounts:import', payload, opts),
  // 【导出账号】查看/导出账号信息；format='json' 完整备份（含凭据），'csv' 表格
  exportAccounts: (format) => ipcRenderer.invoke('accounts:export', format),
  // 【一键领取额外额度】给账号库里所有账号尝试领取 billing/claim 的可领额度
  claimAll: () => ipcRenderer.invoke('claim:all'),
  // 【Z.AI OAuth 免密登录】zcode2api 同款授权通道（邮箱账号浏览器授权，不需要手机号）
  zaiOauthStart: () => ipcRenderer.invoke('oauth:zai-login:start'),
  zaiOauthPoll: () => ipcRenderer.invoke('oauth:zai-login:poll'),
  zaiOauthCancel: () => ipcRenderer.invoke('oauth:zai-login:cancel'),
  zaiOauthReopen: () => ipcRenderer.invoke('oauth:zai-login:reopen'),
  zaiOauthApply: (name) => ipcRenderer.invoke('oauth:zai-login:apply', name),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  // 强制更新：检查 GitHub Releases，有新版就要求先更新
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateOpenDownload: () => ipcRenderer.invoke('update:open-download'),
  updateOpenPage: () => ipcRenderer.invoke('update:open-page'),
  updateQuit: () => ipcRenderer.invoke('update:quit'),
});

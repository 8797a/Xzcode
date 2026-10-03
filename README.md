# XZCode

ZCode 桌面客户端的本地多账号管理面板。Electron 编写，蓝白配色。

**每个账号有自己独立的 ZCode 数据目录**，切换账号就是启动对应的那一份，互不覆盖。新添加的账号不会自动登录、不会自动切换——它们只是进入列表，什么时候切由你决定。

## 它是怎么隔离的

ZCode 支持 `ZCODE_DATA_BASE_DIR`：设上它，客户端会在该目录下再建 `.zcode/v2/`，把凭据、配置、日志、遥测全写在那里。面板给每个账号分配一个：

```
accounts/<账号名>/
  data/.zcode/v2/     ← ZCode 的完整数据：credentials / config / logs / certs / telemetry
  userdata/           ← Chromium userData（ZCODE_DESKTOP_USER_DATA_DIR）
  session/            ← cookies / localStorage（ZCODE_DESKTOP_SESSION_DATA_DIR）
  home/               ← HOME（ZCODE_DESKTOP_HOME_DIR）
  meta.json           ← 注册时间、设备码、切换次数
```

启动客户端时同时设置这四组环境变量，再加上每账号独立的 `--device-id`，所以账号之间在服务端看也是各自独立的设备。**使用者的主 `~/.zcode` 不会被这个面板读写**（实测：跑完一轮，主目录的 `credentials.json`、`config.json`、日志时间戳全部不变）。

**一处例外：`setting.json` 不受重定向影响。** 实测把 `httpProxy` 只写进账号的数据目录，客户端启动后日志里仍是 `mode=direct`；写主 `~/.zcode/v2/setting.json` 才会变成 `fixed_servers`。所以面板的代理设置照旧写全局那份——它是应用级偏好（主题、最近项目、代理），跨账号共用本来就是合理的。

## 它能做什么

- **账号数据完全隔离**：每个账号一套凭据、配置、浏览器数据，切换不覆盖任何文件
- **套餐与额度**：读该账号自己日志里的 `billing/balance` 记录，另有联网查询兜底
- **代理同步**：把 Windows 系统代理写进 ZCode 配置（ZCode 默认给主会话下发 `direct`，会绕过系统代理，只在系统层面开代理它不生效）
- **添加账号**：BigModel 网页登录（手机号 + 短信验证码）
  - Z.ai 邮箱注册**已恢复**（2026-09-24 实测，需开代理）：临时邮箱自动建、表单自动填、**人机验证滑块自动过**（见下文「滑块自动求解」）、激活邮件自动收，全程无人工
- **自动化流程日志**：填表、滑块、提交、授权每一步都在面板里逐步显示
- **强制更新**：启动时查 GitHub Releases，有新版就要求先更新再用（详见下方）

## 强制更新

面板每次启动会查一次 GitHub 上的最新 Release，和本机版本比。**查到更新的版本就盖一层遮罩要求先更新，不提供「继续使用」。**

它只拦这一种情况。下面这些都放行：

| 情况 | 行为 |
| --- | --- |
| 网络不通 / GitHub 被墙 / 代理没开 | 放行 |
| GitHub API 限流（未认证每小时 60 次） | 放行 |
| 仓库还没有发布过 Release | 放行 |
| tag 写得不规范（不是 `x.y.z`） | 放行 |
| 最新版比本机旧（例如本机是开发版） | 放行 |
| 查到确实有更新的版本 | **拦住** |

宁可漏掉一次更新，也不能因为一次请求失败就把人锁在软件外面。

**不自己下载替换 exe**，遮罩上的「去下载新版本」是让浏览器去下载。原因有两个：便携版运行时是从临时目录解压出来的，替换正在跑的那份根本落不到使用者的 exe 上；而且自替换型程序很容易被 Defender 拦掉。下载交给浏览器还能顺带用上你的下载器和代理。

更新只是换一个 exe，**账号数据在 `%APPDATA%\xzcode`，不会丢**。首次运行会优先从 `%APPDATA%\zcode-dashboard`（或更旧的 `zcode-panel`）自动复制迁移，旧目录保留用于回退。

排障出口：设 `XZCODE_SKIP_UPDATE=1` 启动可跳过检查（开发用，正式发布不要设；旧品牌变量仍兼容）。

### 发版流程（强制更新依赖它）

更新检查比的是 `package.json` 的 `version` 和 Release 的 `tag_name`。所以每次发版必须：

1. 改 `package.json` 的 `version`，例如 `1.0.0` → `1.1.0`
2. `npm run dist` 重新打包
3. 建 Release，**tag 写成 `v1.1.0`**（带不带 `v` 都认，`v` 前缀和 `x.y.z` 之外的形式会被忽略）
4. 把 `dist/XZCode-1.1.0-portable.exe` 传上去

版本号必须是**严格递增**的 `x.y.z`。忘了改 version 就会出现「发了新版但没人被提示更新」；把 tag 写成 `latest`、`2026.09` 这类形式则一律不判更新（宁可漏，不误锁）。

## 系统要求

| 项 | 要求 |
| --- | --- |
| 系统 | **Windows 10 1809 及以上 / Windows 11**（Electron 33 的最低支持线；x64） |
| ZCode 客户端 | 必须已安装。面板是它的多账号外挂，不装客户端只能打开界面，切号与查额度都用不了 |
| 运行打包版 | 无需 Node.js |
| 从源码跑 | Node.js 18+ |

## 分工：哪些手动、哪些自动

两条线同一个原则：**涉及你个人凭据的步骤由你手动做，机械操作交给面板。**

BigModel 网页登录：

| 步骤 | 谁做 |
| --- | --- |
| 打开登录页 | 面板 |
| 填写手机号 | 你 |
| 点「获取验证码」 | 你 |
| 过人机验证（腾讯拼图） | 你 |
| 填写收到的短信验证码 | 你 |
| 点「登录 / 注册」 | 面板（手机号和验证码都填好、且验证码是新的才点） |
| 授权页勾协议 + 点「继续」 | 面板 |

Z.ai 邮箱注册（2026-09-24 实测恢复，需开代理；配了 YYDS Mail API Key 即全自动）：

| 步骤 | 谁做 |
| --- | --- |
| 打开注册页并切到注册表单 | 面板 |
| 创建临时邮箱 | 面板（YYDS Mail，设置里填 API Key） |
| 填写名称 / 电子邮箱 / 密码 | 面板（随机生成，密码在流程日志里告知） |
| 过人机验证（阿里云滑块） | **面板自动**（slider-solver，见下节；失败自动退回人工） |
| 点「创建账号」 | 面板（确认验证已通过才点） |
| 收激活邮件、提取链接 | 面板（YYDS Mail 自动收信；没配 Key 则人工粘贴） |
| 打开激活链接、设置密码、完成注册 | 面板 |
| 授权页勾协议 + 点「继续」 | 面板 |

未配 YYDS Mail API Key 时，邮箱与激活链接两步退回人工，其余仍自动。

通道恢复后（2026-09-24，开代理可见注册表单），原先的 deprecated 闸门已拆除，`ZaiMailDriver` 重新上岗，并配套两样自动化：YYDS Mail 临时邮箱自动收信、`slider-solver` 自动过滑块（见下节）。

面板不接码、不内置邮箱抓取（YYDS Mail 是使用你自己 API Key 的收信服务），也不保存你的手机号和密码。

关于判据，有一个地方是踩过坑才定下来的：

BigModel 的「登录 / 注册」按钮**一进页面就是可点的**，所以不能拿"按钮可点"当提交信号，否则会在你还没填完时空提交。必须两个输入框都有有效值才点。

Z.ai 这条线的提交判据：必须**确认人机验证已通过**（验证入口消失 + 出现「验证通过」文案）才点「创建账号」——每次失败的提交都是一次风控计数，宁可多等也不空点。自动滑块求解失败时退回人工，判据不变。

## 滑块自动求解（slider-solver.js）

注册流程里的阿里云「点击开始验证」滑块由面板自动完成，实测 3 轮 / 19 秒内通过（每张挑战图不同、缺口位置不同，全程现算，无任何写死的距离）。实现原理，按数据流走一遍：

1. **打开验证**：点 `#aliyunCaptcha-captcha-text`，等 `#aliyunCaptcha-window-float` 弹出、两层图片都加载完（`#aliyunCaptcha-img` 背景 300×300 + `#aliyunCaptcha-puzzle` 拼图覆盖层）。两层图有时是 data:URL、有时是阿里云 CDN URL；CDN URL 直接画 canvas 会被跨域污染（`toDataURL` 抛 Tainted），所以抓图带 fallback：先试直画，被污染就 `fetch` 原图转 blob → dataURL 再画。

2. **求缺口位置（一维模板匹配）**：拼图覆盖层是一张透明 PNG，**不透明区域的内容就是缺口处的原图像素**。把它在背景图上逐列平移（步长 2 采样），算每列 RGB 差的绝对值和（SSD），得分最低的偏移 `dx` 就是缺口位置——拼图片内容只有对齐缺口时才能和背景严丝合缝。附可信度判定：best 得分低于中位数的 75% 才算有把握，否则当轮放弃换图。**每张新挑战图都重新匹配**，所以图怎么变都无所谓。

3. **拖拽（CDP 可信输入）**：`webContents.sendInputEvent` 的拖拽实测不可靠（手柄只移动一部分甚至不动），必须走 CDP `Input.dispatchMouseEvent`（`webContents.debugger.sendCommand`），手柄 1:1 跟手。轨迹按人类习惯：缓动 + 随机抖动，35~55 步、每步 18~34ms。debugger 每次 attach 前先 detach 一次（上一轮挂死的 attach 会残留，报 "Debugger is already attached"）。

4. **距离自适应闭环**：拖拽距离 D 和拼图片实际位移 P 实测**不严格 1:1**（165→109、141→81），原因在滑块轨道与图片坐标的映射。不猜公式——每轮实测 P/D 比例，下一轮按比例修正，2~4 轮收敛。失败时服务端会自动下发新挑战图（certifyId 变化、新图下载），正好是下一轮的输入。

5. **判定与退出**：成功 = 弹窗收起（`window-float` 加回 `aliyunCaptcha-hidden`）/ 入口文字变「验证通过」；失败 = 换图重来，最多 5 轮，超时看门狗 75 秒/轮（页面忙时 executeJavaScript 可能永不返回，所有页内调用都带超时包裹）。

**两个致命坑（都是实测踩出来的，代码注释里也有）：**

- **阿里云请求必须直连**：滑块松手后 SDK 会向 `*.captcha-open.aliyuncs.com` 发 verify 请求，走系统代理会被直接掐死（`ERR_CONNECTION_CLOSED`），表现为「拖完毫无反应」。求解开始前对授权窗口的 session 设置代理分流：系统代理照走，`*.aliyuncs.com` / `*.alicdn.com` 直连。注意 Electron 的 `mode:'system'` **不认** `proxyBypassRules`（实测），必须用 `fixed_servers` 显式代理规则 + bypass 列表（`slider-solver.js` 的 `applyAliyunBypass`）。
- **窗口必须真渲染**：`show:false` 或移到屏幕外的窗口，合成器状态不稳定——CDP 输入丢事件、`capturePage` 报 "display surface not available"。滑块求解对可见性没有硬要求，但授权窗口本来就是可见的，正常用即可。

## 关于代理

授权窗口按域名分流，这一点很关键：

| 目标 | 怎么走 | 原因 |
| --- | --- | --- |
| `bigmodel.cn` | 直连，绕过代理 | 国内站点，套境外节点会被直接掐断（`ERR_CONNECTION_CLOSED`） |
| `chat.z.ai` / `zcode.z.ai` | 系统代理 | 境外站点，必须走代理 |
| `*.aliyuncs.com` / `*.alicdn.com` | 直连（`applyAliyunBypass`） | 阿里云自家节点走代理会被掐死，滑块 verify 永远无响应 |

代理地址从系统代理现读，不写死。所以开着加速器时三条规则都通，不需要手动在全局 / 规则模式之间来回切。

ZCode 客户端本身给主会话下发 `mode=direct`（主动绕过系统代理），所以它不需要这个分流；面板的授权窗口跟随系统代理，才必须按域名区分。窗口加载失败时面板会给出明确提示，不会留一个白窗口让你猜。

## 运行

### 方式一：直接下 exe（普通使用者用这个）

到 [Releases](https://github.com/8797a/Xzcode/releases) 下载 `XZCode-1.0.0-portable.exe`，双击即可，**不需要装 Node.js**。

首次打开 Windows 可能弹「Windows 已保护你的电脑」（SmartScreen）——因为这个 exe 没有代码签名。点 **「更多信息」→「仍要运行」** 就能打开。

**前提：先装好 ZCode 桌面客户端。** 面板只是它的多账号外挂，账号登录、切换客户端、查额度都要靠客户端本体；没装客户端时面板会自己弹出设置页让你指定 `ZCode.exe`。

打包版的账号库落在 `%APPDATA%\xzcode\accounts\`（不是 exe 所在目录，因为便携版每次启动会解压到临时目录）。

### 方式二：从源码跑

需要 Node.js 18+ 和已安装的 ZCode 桌面客户端。

```bash
npm install
npm start
```

Windows 上也可以直接双击 `xzcode.cmd`。

### 自己打包

```bash
npm install
npm run dist
```

产物在 `dist/`：

| 文件 | 说明 |
| --- | --- |
| `XZCode-1.0.0-portable.exe` | 单文件绿色版，双击即用，方便发给别人 |
| `win-unpacked/XZCode.exe` | 解压好的目录版，启动更快（免去便携版每次解压到临时目录） |

打包用的是**白名单**，只收 `main.js` / `preload.js` / `settings.js` / `oauth.js` / `balance.js` / `plan.js` / `remote-plan.js` / `login-driver.js` / `update.js` / `session-index.js` / `import-account.js` / `icon.ico` / `renderer/`。

改完 `main.js` 的 `require` 记得回来同步这个列表 —— 白名单漏一个模块，打出来的 exe 一启动就是 `Cannot find module`。

**`accounts/` 永远不进包** —— 那里面是真实登录凭据，而且它下面的 `cli/`、`workspace/` 还是指向 `~/.zcode` 的目录联接，一旦误收会把你的对话记录、插件一起打进 exe 里发出去。

### 首次运行与设置

面板会自动找 ZCode 客户端。找不到时**会自动弹出设置页**并说明原因，不会静默失败。

自动检测按可靠程度依次尝试这些来源：

1. 注册表里 `zcode://` 协议的注册项（装了客户端就一定有它，且带完整路径）
2. 注册表卸载项里的 `DisplayIcon` / `UninstallString`，反推安装目录
3. 正在运行的 ZCode 进程自身的路径
4. `%LOCALAPPDATA%\Programs\ZCode` 等常见安装位置，以及一层子目录扫描

这几个来源互相独立，所以换盘符、换用户名、改安装目录、绿色版解压到别处，通常都能自动命中。都不命中时，在设置页点「浏览…」手动指定 `ZCode.exe` 即可。

设置页里还能改账号数据目录。设置存在：

```
%APPDATA%\xzcode\settings.json
```

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `ZCODE_EXE` | 指定 ZCode 客户端路径。优先级低于设置页里的值 |
| `XZCODE_ACCOUNTS_DIR` | 指定账号数据目录。不设时：源码运行 = XZCode 目录下的 `accounts/`；打包运行 = `%APPDATA%\xzcode\accounts`。旧品牌变量仍兼容 |
| `XZCODE_SKIP_UPDATE` | 设成 `1` 则跳过强制更新检查。仅用于开发与排障；旧品牌变量仍兼容 |

### 优先级

ZCode 客户端路径：**设置页指定 > `ZCODE_EXE` 环境变量 > 自动检测 > 常见路径**。
账号数据目录：**设置页指定 > `XZCODE_ACCOUNTS_DIR` > 旧品牌环境变量（兼容）> XZCode 目录下的 `accounts/`**。

## 目录结构

```
main.js           主进程：账号读写、切换、OAuth、IPC
preload.js        渲染进程桥
settings.js       客户端位置自动探测与设置读写
login-driver.js   登录窗口自动化驱动（BigModel 手机号 + Z.ai 邮箱注册，后者含自动过滑块）
slider-solver.js  阿里云滑块自动求解（模板匹配 + CDP 拖拽 + 代理分流，不依赖 electron 可读）
oauth.js          OAuth 授权流程与凭据加解密
zai-oauth.js      Z.ai OAuth 端点配置（不依赖 electron，可单测）
yyds-mail.js      YYDS Mail 收信客户端（临时邮箱 + 自动收激活邮件，不依赖 electron，可单测）
balance.js        客户端日志里的额度读取
plan.js           套餐额度解析（读该账号自己的日志）
remote-plan.js    联网套餐查询（含节流与 3012 熔断）
session-index.js  会话索引同步（数据根隔离后，tasks-index.sqlite 需要在切换边界搬运）
import-account.js 导入账号：把一份凭据变成面板里的一个可用账号（不依赖 electron，可单测）
update.js         强制更新：版本比较与 GitHub Releases 检查（不依赖 electron，可单测）
renderer/         界面（index.html / app.js / style.css）
accounts/         账号数据目录（运行后生成，含登录凭据，不建议提交到版本库）
```

## 注意

- 切换账号会写 ZCode 的登录态目录，操作期间请先关闭 ZCode 客户端
- Z.ai 邮箱注册需要开代理（境外节点）；面板会自动按域名分流，不用手动切换代理模式
- 滑块自动求解失败时自动退回人工，不会卡死流程；连续多轮失败通常是代理不稳（阿里云 verify 请求被掐），先检查加速器
- 账号数据目录里含登录凭据，`accounts/` 请自行妥善保管

## 许可

MIT，见 [LICENSE](LICENSE)。

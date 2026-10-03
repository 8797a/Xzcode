@echo off
rem 切到 UTF-8 代码页，让下面的中文提示不乱码。失败也不该影响启动，故吞掉报错。
chcp 65001 >nul 2>&1
setlocal

rem ============================================================
rem  XZCode —— 快捷启动
rem
rem  双击本文件，或在任意终端敲：xzcode
rem  透传参数给 Electron，例如：xzcode --remote-debugging-port=9333
rem
rem  重复启动不会开出第二个面板：主进程持有单实例锁，
rem  第二次启动会把已有窗口拉到前台。
rem ============================================================

set "PANEL_DIR=%~dp0"
rem %~dp0 末尾带反斜杠，去掉以免拼出双反斜杠
if "%PANEL_DIR:~-1%"=="\" set "PANEL_DIR=%PANEL_DIR:~0,-1%"
set "ELECTRON=%PANEL_DIR%\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo.
  echo   未找到 Electron 运行时
  echo   请先在本目录执行：npm install
  echo   目录：%PANEL_DIR%
  echo.
  pause
  exit /b 1
)

rem start 让 cmd 立刻退出，面板进程独立存活
start "" "%ELECTRON%" "%PANEL_DIR%" %*
exit /b 0

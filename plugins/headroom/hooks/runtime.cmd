#!/bin/sh
: <<'ZCODEPRO_BATCH'
@echo off
setlocal EnableExtensions
set "TARGET=%~1"
if "%TARGET%"=="" exit /b 127
set "REST="
:argloop
shift
if "%~1"=="" goto argdone
set "REST=%REST% "%~1""
goto argloop
:argdone
set "NODE_BIN="
where node >nul 2>nul && set "NODE_BIN=node"
if not defined NODE_BIN for %%D in ("%LOCALAPPDATA%\Programs\nodejs" "%ProgramFiles%\nodejs" "%ProgramFiles(x86)%\nodejs" "%USERPROFILE%\scoop\apps\nodejs\current" "%USERPROFILE%\miniforge3" "%USERPROFILE%\miniconda3" "%ProgramFiles%\miniforge3" "%ProgramFiles%\miniconda3") do (
  if not defined NODE_BIN if exist "%%~D\node.exe" set "NODE_BIN=%%~D\node.exe"
)
rem nvm-windows: version dirs live under NVM_HOME
if not defined NODE_BIN if defined NVM_HOME for /d %%V in ("%NVM_HOME%\v*") do (
  if not defined NODE_BIN if exist "%%V\node.exe" set "NODE_BIN=%%V\node.exe"
)
if defined NODE_BIN (
  "%NODE_BIN%" "%TARGET%" %REST%
  exit /b %ERRORLEVEL%
)
set "ZBIN="
for %%D in ("%LOCALAPPDATA%\Programs\ZCode" "%ProgramFiles%\ZCode" "C:\Program Files\ZCode" "C:\ProgramFiles\ZCode") do (
  if not defined ZBIN if exist "%%~D\ZCode.exe" set "ZBIN=%%~D\ZCode.exe"
)
if not defined ZBIN for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\zcode.exe" /ve 2^>nul ^| findstr REG_SZ') do set "ZBIN=%%B"
if not defined ZBIN for /f "tokens=2,*" %%A in ('reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\zcode.exe" /ve 2^>nul ^| findstr REG_SZ') do set "ZBIN=%%B"
if defined ZBIN (
  set "ELECTRON_RUN_AS_NODE=1"
  "%ZBIN%" "%TARGET%" %REST%
  exit /b %ERRORLEVEL%
)
exit /b 127
ZCODEPRO_BATCH
# 跨平台运行时启动器（一个文件，两种解释器）：
#   POSIX   —— 内核按本 shebang 用 /bin/sh 执行本文件；也可由 /bin/sh 显式调用
#   Windows —— ZCode 对 .cmd 以 cmd.exe 运行本文件（首行 shebang 会报一行无害错误；
#              故 batch 描行只用 ASCII、CRLF 行尾，且本注释段只放在 sh 尾段——
#              sh 头部若留非 ASCII 行，cmd 会在 @echo off 生效前逐行执行出乱码噪声）
# 用法：runtime.cmd <目标脚本> [额外参数…]
# 运行时查找顺序：PATH 里的 node → 常见安装位置（nvm/volta/conda/scoop/官网安装器）→
# ZCode 自带运行时（ELECTRON_RUN_AS_NODE=1，桌面版无需系统 node 即可运行 .mjs）。
# 全部找不到时退出 127（钩子侧等效静默放行，MCP 侧标记服务不可用）。
# —— POSIX sh 分支 ——
TARGET="$1"
[ -n "$TARGET" ] || exit 127
shift
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
else
  for nvm_node in "${HOME:-}"/.nvm/versions/node/*/bin/node; do
    if [ -x "$nvm_node" ]; then NODE_BIN="$nvm_node"; break; fi
  done
  if [ -z "$NODE_BIN" ]; then
    for c in /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node              "${HOME:-}/.local/bin/node" "${HOME:-}/miniforge3/bin/node"              "${HOME:-}/miniconda3/bin/node" "${HOME:-}/.volta/bin/node"; do
      if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
    done
  fi
fi
if [ -n "$NODE_BIN" ]; then
  exec "$NODE_BIN" "$TARGET" "$@"
fi
for z in /opt/ZCode/zcode /usr/lib/zcode/zcode /usr/share/zcode/zcode          "${HOME:-}/.local/share/ZCode/zcode"          "/Applications/ZCode.app/Contents/MacOS/ZCode"; do
  if [ -x "$z" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$z" "$TARGET" "$@"
  fi
done
exit 127

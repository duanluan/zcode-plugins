@echo off
rem Windows-side runtime launcher (POSIX side uses runtime.cmd - two native files,
rem one per platform). Usage: runtime-win.cmd <script> [args...]
rem Find order: node on PATH -> common install dirs (nvm-windows via NVM_HOME)
rem -> ZCode bundled runtime (ELECTRON_RUN_AS_NODE=1). Exit 127 when none found.
setlocal EnableExtensions
if "%~1"=="" exit /b 127
set "NODE_BIN="
where node >nul 2>nul && set "NODE_BIN=node"
if not defined NODE_BIN for %%D in ("%LOCALAPPDATA%\Programs\nodejs" "%ProgramFiles%\nodejs" "C:\Program Files\nodejs") do (
  if not defined NODE_BIN if exist "%%~D\node.exe" set "NODE_BIN=%%~D\node.exe"
)
rem nvm-windows: version dirs live under NVM_HOME
if not defined NODE_BIN if defined NVM_HOME for /d %%V in ("%NVM_HOME%\v*") do (
  if not defined NODE_BIN if exist "%%V\node.exe" set "NODE_BIN=%%V\node.exe"
)
if defined NODE_BIN (
  "%NODE_BIN%" %*
  exit /b %ERRORLEVEL%
)
set "ZBIN="
for %%D in ("%LOCALAPPDATA%\Programs\ZCode" "%ProgramFiles%\ZCode" "C:\Program Files\ZCode") do (
  if not defined ZBIN if exist "%%~D\ZCode.exe" set "ZBIN=%%~D\ZCode.exe"
)
if not defined ZBIN for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZCode" /v InstallLocation 2^>nul') do if not defined ZBIN set "ZBIN=%%B\ZCode.exe"
if not defined ZBIN for /f "tokens=2,*" %%A in ('reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZCode" /v InstallLocation 2^>nul') do if not defined ZBIN set "ZBIN=%%B\ZCode.exe"
if defined ZBIN (
  set "ELECTRON_RUN_AS_NODE=1"
  "%ZBIN%" %*
  exit /b %ERRORLEVEL%
)
exit /b 127

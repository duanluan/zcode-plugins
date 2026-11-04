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
rem nvm-windows: version dirs live under NVM_HOME. Take the highest version -
rem listing order is lexicographic (v8 sorts after v20), not version order.
if not defined NODE_BIN if defined NVM_HOME call :pickNvm
if defined NODE_BIN goto :runNode
set "ZBIN="
for %%D in ("%LOCALAPPDATA%\Programs\ZCode" "%ProgramFiles%\ZCode" "C:\Program Files\ZCode") do (
  if not defined ZBIN if exist "%%~D\ZCode.exe" set "ZBIN=%%~D\ZCode.exe"
)
if not defined ZBIN for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZCode" /v InstallLocation 2^>nul') do if not defined ZBIN set "ZBIN=%%B\ZCode.exe"
if not defined ZBIN for /f "tokens=2,*" %%A in ('reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZCode" /v InstallLocation 2^>nul') do if not defined ZBIN set "ZBIN=%%B\ZCode.exe"
if not defined ZBIN exit /b 127
set "ELECTRON_RUN_AS_NODE=1"
"%ZBIN%" %*
exit /b %ERRORLEVEL%

:runNode
rem Run and exit outside any parenthesized block: %ERRORLEVEL% is expanded when
rem the whole block is parsed, so exit /b %ERRORLEVEL% inside one returns the
rem pre-block value and the script's real exit code is lost.
"%NODE_BIN%" %*
exit /b %ERRORLEVEL%

rem Highest-version node.exe under NVM_HOME. shortcut: the version key assumes
rem minor/patch below 100, revisit if node ever ships a 3-digit segment.
:pickNvm
setlocal EnableDelayedExpansion
set "BEST=-1"
for /d %%V in ("%NVM_HOME%\v*") do if exist "%%~V\node.exe" (
  set "VER=%%~nxV"
  set "VER=!VER:~1!"
  set "MAJ=0" & set "MIN=0" & set "PAT=0"
  for /f "tokens=1-3 delims=." %%A in ("!VER!") do (
    if not "%%A"=="" set "MAJ=%%A"
    if not "%%B"=="" set "MIN=%%B"
    if not "%%C"=="" set "PAT=%%C"
  )
  set "KEY=0"
  set /a "KEY=MAJ*10000+MIN*100+PAT" >nul 2>nul
  if !KEY! GTR !BEST! (
    set /a "BEST=KEY" >nul
    set "NODE_BIN=%%~V\node.exe"
  )
)
endlocal & set "NODE_BIN=%NODE_BIN%"
exit /b

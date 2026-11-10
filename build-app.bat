@echo off
title Building the Tandemi app
cd /d "%~dp0desktop"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Building the app needs Node.js once: https://nodejs.org
  echo   The finished app has its own and doesn't need it.
  echo.
  pause
  exit /b
)
echo.
echo   Getting Electron and the installer tools (about 200 MB, only the first time)...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail
echo.
echo   Building the installer...
call npm run dist
if errorlevel 1 goto fail
echo.
echo   Done: desktop\dist\Tandemi Setup.exe
start "" "%~dp0desktop\dist"
pause
exit /b
:fail
echo.
echo   Something went wrong. Read the lines above, or send them to Claude.
pause

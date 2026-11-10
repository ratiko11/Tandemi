@echo off
title Tandemi
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Download the LTS version from https://nodejs.org , install it, then double-click start.bat again.
  echo.
  pause
  exit /b
)
node engine\server.js
pause

@echo off
title Tandemi website
cd /d "%~dp0website"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Download the LTS version from https://nodejs.org , install it, then double-click open-website.bat again.
  echo.
  pause
  exit /b
)
node serve.js
pause

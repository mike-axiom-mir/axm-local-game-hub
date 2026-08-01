@echo off
setlocal
title AXM Local Game Hub
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the free LTS version, then run this file again.
  pause
  exit /b 1
)
cd /d "%~dp0"
node server.cjs --open
if errorlevel 1 pause


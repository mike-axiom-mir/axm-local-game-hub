@echo off
setlocal
title AXM LAN Game Night
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the free LTS version, then run this file again.
  pause
  exit /b 1
)
cd /d "%~dp0"
echo LAN mode lets phones on the same Wi-Fi reach this computer.
echo Windows Firewall may ask you to allow Node.js on private networks.
echo Do not allow it on public networks.
node server.cjs --open --lan
if errorlevel 1 pause


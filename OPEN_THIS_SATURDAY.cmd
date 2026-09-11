@echo off
setlocal
title AXM SATURDAY PLAYTEST
cd /d "%~dp0"
if exist "SATURDAY_HUMAN_TEST.txt" start "AXM Saturday Test Guide" notepad "%~dp0SATURDAY_HUMAN_TEST.txt"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is required to run this local playtest build.
  echo Install the free Node.js LTS version, then double-click this file again.
  echo.
  pause
  exit /b 1
)
echo AXM current playtest build - derived, non-CANON, local only.
echo Opening the one-click game hub...
node server.cjs --open
if errorlevel 1 pause

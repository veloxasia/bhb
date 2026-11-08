@echo off
setlocal
cd /d "%~dp0"

echo [setup] Installing required libraries...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [error] Dependency installation failed.
  exit /b 1
)

node scripts/validate.js
if errorlevel 1 (
  echo [error] Source validation failed.
  exit /b 1
)

echo [setup] Complete.
exit /b 0

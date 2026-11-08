@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\mineflayer\package.json" (
  echo [setup] Installing required libraries...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo [error] Dependency installation failed. & exit /b 1 )
)
node src/gui/server.js
exit /b %errorlevel%

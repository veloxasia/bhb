#!/usr/bin/env bash
set -e

echo "=========================================================="
echo " Minecraft Human Builder — 12-vCPU / 96GB VPS Auto-Setup"
echo "=========================================================="

# 1. Install Node.js 22 if node is missing or older than v20
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d 'v')" -lt 20 ]; then
  echo "[setup] Installing Node.js 22.x..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y
    sudo apt-get install -y curl git ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
fi

echo "[setup] Node version: $(node -v) | NPM version: $(npm -v)"

# 2. Install project dependencies
echo "[setup] Installing npm dependencies..."
npm install --no-audit --no-fund

# 3. Create folders
mkdir -p data learned schematics

# 4. Launch GUI + Fleet manager with high-RAM V8 settings
export NODE_OPTIONS="--max-old-space-size=8192"
export MHB_GUI_HOST="0.0.0.0"
export MHB_STATE_DIR="$(pwd)/data"
export PORT="${PORT:-8765}"

echo "[setup] Starting Web GUI on http://0.0.0.0:${PORT}/ ..."
exec node start-render.js

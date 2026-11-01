#!/usr/bin/env bash
# Production Server Pull & Update Script
set -euo pipefail

echo "======================================================"
echo " 🔄 Updating Marketing Manager Dashboard from GitHub"
echo "======================================================"

# 1. Pull latest code from main
echo "[1/4] Pulling latest changes from Git..."
git pull origin main

# 2. Install dependencies
echo "[2/4] Installing dependencies..."
npm install --prefer-offline || npm install

# 3. Build production bundle
echo "[3/4] Building production bundle..."
npm run build

# 4. Restart server
echo "[4/4] Restarting server process..."
if command -v pm2 &> /dev/null; then
  pm2 reload marketing-dashboard || pm2 start server.js --name "marketing-dashboard"
  echo "  ✓ PM2 process reloaded."
fi

# Touch cPanel passenger restart trigger
mkdir -p tmp
touch tmp/restart.txt
echo "  ✓ Passenger restart file updated."

echo ""
echo "======================================================"
echo " ✅ Production update completed successfully!"
echo "======================================================"

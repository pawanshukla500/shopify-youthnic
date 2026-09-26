#!/usr/bin/env bash
# ==============================================================================
# Youthnic OMS - Production VPS Zero-Downtime Deployment Script
# ==============================================================================
set -e

echo ">>> [1/5] Fetching latest changes from Git..."
git pull origin main || echo "Git pull skipped (local deployment)"

echo ">>> [2/5] Installing server dependencies..."
npm ci --omit=dev || npm install --omit=dev

echo ">>> [3/5] Syncing database schema and Prisma Client..."
npx prisma generate
npx prisma db push --skip-generate

echo ">>> [4/5] Building backend & frontend..."
npm run build
cd frontend && npm install && npm run build && cd ..

echo ">>> [5/5] Reloading PM2 cluster with zero downtime..."
mkdir -p logs
pm2 reload ecosystem.config.js --env production || pm2 start ecosystem.config.js --env production

echo "=============================================================================="
echo "✓ Youthnic OMS deployed successfully on VPS!"
echo "Server URL: http://localhost:3000"
echo "Check logs: pm2 logs youthnic-oms"
echo "=============================================================================="

#!/usr/bin/env bash
set -euo pipefail

echo ">>> [1/8] Preparing directory structure in /opt/shopify/Shopify..."
mkdir -p /opt/shopify/Shopify/logs
find /opt/shopify/Shopify -mindepth 1 -maxdepth 1 ! -name 'logs' -exec rm -rf {} +
cd /opt/shopify
tar -xzf shopify-source.tar.gz -C Shopify
cd Shopify

echo ">>> [2/8] Installing production configuration..."
mv /opt/shopify/hostinger.env .env
chmod 600 .env
ln -sf docker-compose.production.yml docker-compose.yml

echo ">>> [3/8] Building Docker image for Shopify..."
docker compose -p shopify -f docker-compose.production.yml --env-file .env build

echo ">>> [4/8] Applying Prisma schema to production database..."
docker compose -p shopify -f docker-compose.production.yml --env-file .env run -T --rm --no-deps shopify npx prisma db push --skip-generate ${DATA_LOSS_FLAG:-} < /dev/null

echo ">>> [5/8] Starting Docker container Shopify under project shopify..."
docker compose -p shopify -f docker-compose.production.yml --env-file .env up -d --force-recreate --remove-orphans

echo ">>> [6/8] Linking to /docker/shopify for Hostinger hPanel Docker Manager..."
mkdir -p /docker
ln -sfn /opt/shopify/Shopify /docker/shopify

echo ">>> [7/8] Verifying Shopify container is running..."
sleep 10
docker ps --filter "name=Shopify"

echo ">>> [8/8] Checking internal health endpoint..."
healthy=0
for i in {1..20}; do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "✓ Internal health check passed at http://127.0.0.1:3000/api/health"
    healthy=1
    break
  fi
  echo "Waiting for Shopify container to report healthy ($i/20)..."
  sleep 4
done

if [ "$healthy" -ne 1 ]; then
  echo "❌ Container failed internal health check."
  docker logs Shopify --tail=200
  exit 1
fi

echo ">>> Verifying Traefik reverse proxy routing..."
for domain in "shopify.youthnic.shop" "shopify.srv1845788.hstgr.cloud"; do
  echo "Testing routing for https://$domain/api/health..."
  curl -k -fsS "https://$domain/api/health" || echo "Note: DNS for $domain may take a moment to propagate or resolve."
done

echo "Cleaning up dangling Docker build images..."
docker image prune -f

echo "=========================================================================="
echo "🎉 Shopify OMS is LIVE on Hostinger VPS!"
echo "Container: Shopify"
echo "Hostinger hPanel: /docker/shopify"
echo "URLs: https://shopify.youthnic.shop | https://shopify.srv1845788.hstgr.cloud"
echo "=========================================================================="

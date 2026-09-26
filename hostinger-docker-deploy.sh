#!/usr/bin/env bash
# ==============================================================================
# Youthnic OMS - Hostinger VPS Docker Deployment & Management Script
# ==============================================================================
set -e

echo "=============================================================================="
echo "  Youthnic OMS - Hostinger VPS Docker Container Deployment Engine             "
echo "=============================================================================="

# 1. Verify Docker and Docker Compose
echo ">>> [1/6] Checking Docker engine on Hostinger VPS..."
if ! command -v docker &> /dev/null; then
    echo "Docker not detected. Installing Docker Engine..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
    systemctl enable docker
    systemctl start docker
fi

if ! docker compose version &> /dev/null; then
    echo "Installing Docker Compose plugin..."
    apt-get update && apt-get install -y docker-compose-plugin
fi

echo "✓ Docker: $(docker --version)"
echo "✓ Docker Compose: $(docker compose version)"

# 2. Check environment configuration
echo ">>> [2/6] Verifying environment configuration (.env)..."
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        echo "Creating .env from .env.example..."
        cp .env.example .env
        echo "⚠️ Please edit .env with your production credentials (DATABASE_URL, DELHIVERY_API_TOKEN, RESEND_API_KEY, MODEL_API_KEY)!"
        exit 1
    else
        echo "❌ .env file missing! Please upload your production .env before deploying."
        exit 1
    fi
fi

# 3. Create persistent logs directory
echo ">>> [3/6] Ensuring host volume directories exist..."
mkdir -p logs

# 4. Stop existing container if running
echo ">>> [4/6] Shutting down existing container gracefully..."
docker compose down || true

# 5. Build and launch container in detached mode
echo ">>> [5/6] Building production Docker image and starting container..."
docker compose up -d --build

# 6. Verify Container Health
echo ">>> [6/6] Verifying container health on port 3000..."
sleep 5

for i in {1..10}; do
    if curl -s http://localhost:3000/api/health | grep -q '"status":"ok"'; then
        echo "=============================================================================="
        echo "✓ SUCCESS: Youthnic OMS container is running and healthy on Hostinger VPS!"
        echo "  Endpoint: http://localhost:3000/api/health"
        echo "  Container: $(docker ps --filter name=youthnic-oms --format '{{.Names}} ({{.Status}})')"
        echo "=============================================================================="
        break
    fi
    echo "Waiting for container health check ($i/10)..."
    sleep 3
done

echo ""
echo "=============================================================================="
echo "Hostinger VPS Reverse Proxy & SSL Setup (Nginx):"
echo "------------------------------------------------------------------------------"
echo "To expose this container on your domain (e.g. oms.youthnic.com) with SSL:"
echo ""
echo "1. In /etc/nginx/sites-available/youthnic-oms:"
echo "   server {"
echo "       server_name oms.youthnic.com;"
echo "       location / {"
echo "           proxy_pass http://127.0.0.1:3000;"
echo "           proxy_http_version 1.1;"
echo "           proxy_set_header Upgrade \$http_upgrade;"
echo "           proxy_set_header Connection 'upgrade';"
echo "           proxy_set_header Host \$host;"
echo "           proxy_cache_bypass \$http_upgrade;"
echo "       }"
echo "   }"
echo ""
echo "2. Enable and get SSL:"
echo "   ln -s /etc/nginx/sites-available/youthnic-oms /etc/nginx/sites-enabled/"
echo "   nginx -t && systemctl reload nginx"
echo "   certbot --nginx -d oms.youthnic.com"
echo "=============================================================================="

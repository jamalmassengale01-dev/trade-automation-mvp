#!/bin/bash
# ============================================
# Start Cloudflare Tunnel (Bash)
# ============================================

set -e

TUNNEL_NAME="${1:-trade-automation}"
USE_DOCKER=false
SETUP_MODE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --docker)
            USE_DOCKER=true
            shift
            ;;
        --setup)
            SETUP_MODE=true
            shift
            ;;
        *)
            shift
            ;;
    esac
done

echo "🚀 Trade Automation - Cloudflare Tunnel"
echo "======================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Check if cloudflared is installed
check_cloudflared() {
    if command -v cloudflared &> /dev/null; then
        VERSION=$(cloudflared --version)
        echo -e "${GREEN}✅ cloudflared installed: $VERSION${NC}"
        return 0
    else
        echo -e "${RED}❌ cloudflared not found${NC}"
        return 1
    fi
}

# Setup mode
if [ "$SETUP_MODE" = true ]; then
    echo -e "${YELLOW}📦 Setting up Cloudflare Tunnel...${NC}"
    echo ""
    
    if ! check_cloudflared; then
        echo -e "${YELLOW}Installing cloudflared...${NC}"
        
        # Detect OS and install
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            brew install cloudflare/cloudflare/cloudflared
        elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
            # Linux
            curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
            sudo dpkg -i cloudflared.deb
            rm cloudflared.deb
        else
            echo -e "${RED}❌ Unsupported OS. Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/${NC}"
            exit 1
        fi
    fi
    
    echo ""
    echo -e "${CYAN}Next steps:${NC}"
    echo "1. cloudflared tunnel login"
    echo "2. cloudflared tunnel create $TUNNEL_NAME"
    echo "3. cloudflared tunnel route dns $TUNNEL_NAME trading.YOURDOMAIN.com"
    echo "4. Save the tunnel ID for later"
    exit 0
fi

# Check for tunnel token
if [ -z "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
    echo -e "${YELLOW}⚠️  CLOUDFLARE_TUNNEL_TOKEN not set${NC}"
    echo ""
    echo -e "${CYAN}Options:${NC}"
    echo "1. Set environment variable: export CLOUDFLARE_TUNNEL_TOKEN='your-token'"
    echo "2. Run existing tunnel: cloudflared tunnel run $TUNNEL_NAME"
    echo "3. Use Docker: ./start-tunnel.sh --docker"
    exit 1
fi

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Start tunnel
if [ "$USE_DOCKER" = true ]; then
    echo -e "${CYAN}🐳 Starting tunnel with Docker...${NC}"
    docker-compose -f "$SCRIPT_DIR/docker-compose.tunnel.yml" up -d
    
    echo ""
    echo -e "${GREEN}✅ Tunnel started!${NC}"
    echo "📊 Check status: docker logs trade-automation-tunnel"
    echo ""
    echo -e "${CYAN}URLs:${NC}"
    echo "  Dashboard: https://trading.yourdomain.com (update with your domain)"
    echo "  API:       https://trading-api.yourdomain.com"
else
    echo -e "${CYAN}🌐 Starting cloudflared tunnel...${NC}"
    echo -e "${YELLOW}Press Ctrl+C to stop${NC}"
    echo ""
    
    cloudflared tunnel run "$TUNNEL_NAME"
fi

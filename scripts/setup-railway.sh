#!/bin/bash
# ============================================
# Railway Deployment Setup Script
# Run this after pushing to GitHub
# ============================================

set -e

echo "🚀 Trade Automation MVP - Railway Setup"
echo "========================================"
echo ""

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 20+"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo "❌ npm not found. Please install npm"
    exit 1
fi

if ! command -v git &> /dev/null; then
    echo "❌ git not found. Please install git"
    exit 1
fi

echo "✅ Prerequisites met"
echo ""

# Generate webhook secret
echo "🔐 Generating secure webhook secret..."
WEBHOOK_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "Generated: $WEBHOOK_SECRET"
echo ""

# Instructions
echo "📋 Next Steps:"
echo "=============="
echo ""
echo "1. Create Supabase project:"
echo "   → https://supabase.com"
echo "   → New Project → Copy DATABASE_URL"
echo ""
echo "2. Create Upstash Redis:"
echo "   → https://upstash.com"
echo "   → Create Database → Copy REDIS_URL"
echo ""
echo "3. Deploy to Railway:"
echo "   → https://railway.app"
echo "   → New Project → Deploy from GitHub"
echo "   → Add these environment variables:"
echo ""
echo "   DATABASE_URL=postgresql://..."
echo "   REDIS_URL=redis://..."
echo "   WEBHOOK_SECRET=$WEBHOOK_SECRET"
echo "   NODE_ENV=production"
echo ""
echo "4. Deploy Frontend to Vercel:"
echo "   → https://vercel.com"
echo "   → Import GitHub repo"
echo "   → Root Directory: apps/web"
echo "   → Add: NEXT_PUBLIC_API_URL=https://YOUR-RAILWAY-URL.up.railway.app"
echo ""
echo "5. Run database migrations:"
echo "   → Go to Supabase SQL Editor"
echo "   → Copy contents of: apps/api/src/db/schema.sql"
echo "   → Run the SQL"
echo ""
echo "📖 Full guide: DEPLOYMENT.md"
echo ""
echo "✅ Setup complete!"

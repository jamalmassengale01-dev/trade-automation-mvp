#!/usr/bin/env pwsh
# ============================================
# Start Cloudflare Tunnel (PowerShell)
# ============================================

param(
    [string]$TunnelName = "trade-automation",
    [switch]$UseDocker,
    [switch]$Setup
)

$ErrorActionPreference = "Stop"

Write-Host "🚀 Trade Automation - Cloudflare Tunnel" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Check if cloudflared is installed
function Test-Cloudflared {
    try {
        $version = cloudflared --version 2>$null
        Write-Host "✅ cloudflared installed: $version" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "❌ cloudflared not found" -ForegroundColor Red
        return $false
    }
}

# Setup mode
if ($Setup) {
    Write-Host "📦 Setting up Cloudflare Tunnel..." -ForegroundColor Yellow
    Write-Host ""
    
    if (-not (Test-Cloudflared)) {
        Write-Host "Installing cloudflared..." -ForegroundColor Yellow
        
        # Download and install
        $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
        $output = "$env:LOCALAPPDATA\cloudflared.exe"
        
        try {
            Invoke-WebRequest -Uri $url -OutFile $output
            Write-Host "✅ Downloaded to $output" -ForegroundColor Green
            Write-Host "Add to PATH: $env:LOCALAPPDATA" -ForegroundColor Yellow
        } catch {
            Write-Host "❌ Download failed. Install manually from: https://github.com/cloudflare/cloudflared/releases" -ForegroundColor Red
            exit 1
        }
    }
    
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "1. cloudflared tunnel login"
    Write-Host "2. cloudflared tunnel create $TunnelName"
    Write-Host "3. cloudflared tunnel route dns $TunnelName trading.YOURDOMAIN.com"
    Write-Host "4. Save the tunnel ID for later"
    exit 0
}

# Check for tunnel token in environment
if (-not $env:CLOUDFLARE_TUNNEL_TOKEN) {
    Write-Host "⚠️  CLOUDFLARE_TUNNEL_TOKEN not set" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Options:" -ForegroundColor Cyan
    Write-Host "1. Set environment variable: `$env:CLOUDFLARE_TUNNEL_TOKEN = 'your-token'"
    Write-Host "2. Run existing tunnel: cloudflared tunnel run $TunnelName"
    Write-Host "3. Use Docker: .\start-tunnel.ps1 -UseDocker"
    exit 1
}

# Start tunnel
if ($UseDocker) {
    Write-Host "🐳 Starting tunnel with Docker..." -ForegroundColor Cyan
    docker-compose -f $PSScriptRoot\docker-compose.tunnel.yml up -d
    
    Write-Host ""
    Write-Host "✅ Tunnel started!" -ForegroundColor Green
    Write-Host "📊 Check status: docker logs trade-automation-tunnel"
} else {
    Write-Host "🌐 Starting cloudflared tunnel..." -ForegroundColor Cyan
    Write-Host "Press Ctrl+C to stop" -ForegroundColor Yellow
    Write-Host ""
    
    cloudflared tunnel run $TunnelName
}

#!/usr/bin/env pwsh
# ============================================
# Windows Tunnel Setup Script
# Run as Administrator
# ============================================

$ErrorActionPreference = "Stop"

Write-Host @"
╔════════════════════════════════════════════════════════════╗
║     Trade Automation MVP - Cloudflare Tunnel Setup         ║
║                     for Windows                            ║
╚════════════════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan

$CloudflaredPath = "$env:LOCALAPPDATA\cloudflared.exe"
$CloudflaredDir = "$env:LOCALAPPDATA\cloudflared"

# Step 1: Download cloudflared
function Install-Cloudflared {
    Write-Host "📥 Downloading cloudflared..." -ForegroundColor Yellow
    
    $DownloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    
    try {
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $CloudflaredPath -UseBasicParsing
        Write-Host "✅ Downloaded to $CloudflaredPath" -ForegroundColor Green
    } catch {
        Write-Host "❌ Download failed: $_" -ForegroundColor Red
        exit 1
    }
}

# Step 2: Add to PATH
function Add-ToPath {
    Write-Host "🔧 Adding to PATH..." -ForegroundColor Yellow
    
    $CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    
    if ($CurrentPath -notlike "*$env:LOCALAPPDATA*") {
        [Environment]::SetEnvironmentVariable(
            "Path", 
            "$CurrentPath;$env:LOCALAPPDATA", 
            "User"
        )
        Write-Host "✅ Added to PATH (restart terminal to use)" -ForegroundColor Green
    } else {
        Write-Host "✅ Already in PATH" -ForegroundColor Green
    }
}

# Step 3: Verify installation
function Test-Installation {
    Write-Host "🔍 Verifying installation..." -ForegroundColor Yellow
    
    try {
        $Version = & $CloudflaredPath --version 2>$null
        Write-Host "✅ cloudflared installed: $Version" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "❌ Installation verification failed" -ForegroundColor Red
        return $false
    }
}

# Step 4: Interactive setup
function Start-InteractiveSetup {
    Write-Host ""
    Write-Host "🚀 Starting interactive setup..." -ForegroundColor Cyan
    Write-Host ""
    
    # Check if already logged in
    $CertPath = "$env:USERPROFILE\.cloudflared\cert.pem"
    
    if (-not (Test-Path $CertPath)) {
        Write-Host "🔐 You need to login to Cloudflare..." -ForegroundColor Yellow
        Write-Host "A browser window will open. Please:" -ForegroundColor White
        Write-Host "  1. Login to Cloudflare" -ForegroundColor White
        Write-Host "  2. Select your domain" -ForegroundColor White
        Write-Host "  3. Authorize the tunnel" -ForegroundColor White
        Write-Host ""
        
        & $CloudflaredPath tunnel login
        
        if ($LASTEXITCODE -ne 0) {
            Write-Host "❌ Login failed" -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "✅ Already logged in to Cloudflare" -ForegroundColor Green
    }
    
    # Create tunnel
    Write-Host ""
    Write-Host "🚇 Creating tunnel..." -ForegroundColor Yellow
    
    $TunnelOutput = & $CloudflaredPath tunnel create trade-automation 2>&1
    Write-Host $TunnelOutput
    
    # Extract tunnel ID
    if ($TunnelOutput -match "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}") {
        $TunnelId = $Matches[0]
        Write-Host "✅ Tunnel created with ID: $TunnelId" -ForegroundColor Green
        
        # Get domain
        Write-Host ""
        $Domain = Read-Host "Enter your domain (e.g., yourdomain.com)"
        
        # Create DNS records
        Write-Host ""
        Write-Host "🌐 Creating DNS records..." -ForegroundColor Yellow
        
        & $CloudflaredPath tunnel route dns trade-automation "trading.$Domain"
        & $CloudflaredPath tunnel route dns trade-automation "trading-api.$Domain"
        
        Write-Host "✅ DNS records created:" -ForegroundColor Green
        Write-Host "  - trading.$Domain" -ForegroundColor White
        Write-Host "  - trading-api.$Domain" -ForegroundColor White
        
        # Get token
        Write-Host ""
        Write-Host "🔑 Getting tunnel token..." -ForegroundColor Yellow
        
        $Token = & $CloudflaredPath tunnel token $TunnelId 2>&1
        
        Write-Host ""
        Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
        Write-Host "SAVE THIS TOKEN! You'll need it to start the tunnel:" -ForegroundColor Yellow
        Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
        Write-Host $Token -ForegroundColor Green
        Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
        
        # Save to file
        $TokenFile = "$PWD\tunnel\TUNNEL_TOKEN.txt"
        $Token | Out-File -FilePath $TokenFile -Encoding UTF8
        Write-Host ""
        Write-Host "💾 Token also saved to: $TokenFile" -ForegroundColor Green
        
        # Update env file
        $EnvFile = "$PWD\tunnel\.env.tunnel"
        $EnvExample = "$PWD\tunnel\.env.tunnel.example"
        
        if (-not (Test-Path $EnvFile)) {
            Copy-Item $EnvExample $EnvFile
            (Get-Content $EnvFile) -replace "your-tunnel-token-here", $Token | Set-Content $EnvFile
            (Get-Content $EnvFile) -replace "https://trading-api.yourdomain.com", "https://trading-api.$Domain" | Set-Content $EnvFile
            Write-Host "✅ Updated $EnvFile with your token" -ForegroundColor Green
        }
    } else {
        Write-Host "⚠️  Could not extract tunnel ID. You may need to run setup manually." -ForegroundColor Yellow
    }
}

# Main execution
Write-Host ""
Write-Host "Checking for existing installation..." -ForegroundColor Cyan

if (Test-Path $CloudflaredPath) {
    Write-Host "✅ cloudflared already exists" -ForegroundColor Green
    $Version = & $CloudflaredPath --version 2>$null
    Write-Host "   Version: $Version" -ForegroundColor Gray
    
    $Reinstall = Read-Host "Reinstall? (y/N)"
    if ($Reinstall -eq 'y') {
        Install-Cloudflared
    }
} else {
    Install-Cloudflared
}

Add-ToPath

if (Test-Installation) {
    Write-Host ""
    $Setup = Read-Host "Run interactive tunnel setup? (Y/n)"
    
    if ($Setup -ne 'n') {
        Start-InteractiveSetup
        
        Write-Host ""
        Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
        Write-Host "✅ Setup Complete!" -ForegroundColor Green
        Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
        Write-Host ""
        Write-Host "To start the tunnel:" -ForegroundColor Cyan
        Write-Host "  docker-compose -f tunnel/docker-compose.tunnel.yml up" -ForegroundColor White
        Write-Host ""
        Write-Host "Or use the helper script:" -ForegroundColor Cyan
        Write-Host "  .\tunnel\start-tunnel.ps1 -UseDocker" -ForegroundColor White
        Write-Host ""
        Write-Host "Your public URLs:" -ForegroundColor Cyan
        Write-Host "  Dashboard: https://trading.yourdomain.com" -ForegroundColor White
        Write-Host "  API:       https://trading-api.yourdomain.com" -ForegroundColor White
        Write-Host ""
        Write-Host "TradingView Webhook URL:" -ForegroundColor Cyan
        Write-Host "  https://trading-api.yourdomain.com/webhook/tradingview" -ForegroundColor White
    } else {
        Write-Host ""
        Write-Host "Manual setup commands:" -ForegroundColor Cyan
        Write-Host "  cloudflared tunnel login" -ForegroundColor White
        Write-Host "  cloudflared tunnel create trade-automation" -ForegroundColor White
        Write-Host "  cloudflared tunnel route dns trade-automation trading.yourdomain.com" -ForegroundColor White
    }
} else {
    Write-Host "❌ Installation failed. Please try manual installation:" -ForegroundColor Red
    Write-Host "https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/" -ForegroundColor White
}

Write-Host ""
Write-Host "For help, see: TUNNEL-QUICKSTART.md" -ForegroundColor Gray

#!/usr/bin/env node
/**
 * Test Webhook Endpoint
 * 
 * Usage:
 *   node scripts/test-webhook.js <url>
 * 
 * Examples:
 *   # Test local
 *   node scripts/test-webhook.js http://localhost:3001/webhook/tradingview
 *   
 *   # Test with ngrok
 *   node scripts/test-webhook.js https://abc123.ngrok.io/webhook/tradingview
 *   
 *   # Test with Cloudflare tunnel
 *   node scripts/test-webhook.js https://trading-api.yourdomain.com/webhook/tradingview
 */

const http = require('http');
const https = require('https');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev-secret-change-me';

// Parse URL
const url = process.argv[2] || 'http://localhost:3001/webhook/tradingview';

if (!url) {
  console.error('❌ Please provide a webhook URL');
  console.log('Usage: node test-webhook.js <url>');
  process.exit(1);
}

console.log('🧪 Testing webhook endpoint...\n');
console.log(`URL: ${url}`);
console.log(`Secret: ${WEBHOOK_SECRET.substring(0, 10)}...\n`);

// Build test payload
const payload = {
  id: `test-${Date.now()}`,
  timestamp: Date.now(),
  strategy: 'TestStrategy',
  symbol: 'ES',
  action: 'buy',
  contracts: 1,
  price: 4500.00,
  stopLoss: 4490.00,
  takeProfit: 4520.00,
  message: 'Test alert from CLI'
};

const jsonPayload = JSON.stringify(payload);

// Parse URL
const parsedUrl = new URL(url);
const client = parsedUrl.protocol === 'https:' ? https : http;

const options = {
  hostname: parsedUrl.hostname,
  port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
  path: parsedUrl.pathname + parsedUrl.search,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(jsonPayload),
    'X-Webhook-Secret': WEBHOOK_SECRET
  }
};

console.log('📤 Sending test payload:');
console.log(JSON.stringify(payload, null, 2));
console.log('\n⏳ Waiting for response...\n');

const req = client.request(options, (res) => {
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    console.log(`✅ Status: ${res.statusCode} ${res.statusMessage}`);
    console.log(`📨 Response:`);
    
    try {
      const json = JSON.parse(data);
      console.log(JSON.stringify(json, null, 2));
    } catch {
      console.log(data || '(empty)');
    }
    
    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log('\n✅ Webhook test successful!');
      process.exit(0);
    } else {
      console.log('\n❌ Webhook test failed!');
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.error(`❌ Error: ${err.message}`);
  
  if (err.code === 'ECONNREFUSED') {
    console.log('\n💡 Tips:');
    console.log('   - Is the API running?');
    console.log('   - Check the URL is correct');
    console.log('   - If using Docker, ensure ports are mapped');
  }
  
  process.exit(1);
});

req.write(jsonPayload);
req.end();

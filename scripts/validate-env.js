#!/usr/bin/env node
/**
 * Validate Environment Variables
 * Run before deployment to check all required vars are set
 */

const required = [
  'DATABASE_URL',
  'REDIS_URL',
  'WEBHOOK_SECRET'
];

const optional = [
  'NODE_ENV',
  'PORT',
  'LOG_LEVEL',
  'ENABLE_MOCK_BROKER',
  'ENABLE_SIMULATED_BROKER',
  'GLOBAL_KILL_SWITCH'
];

console.log('🔍 Validating environment variables...\n');

let errors = 0;
let warnings = 0;

// Check required
for (const key of required) {
  const value = process.env[key];
  if (!value) {
    console.log(`❌ ${key}: MISSING (required)`);
    errors++;
  } else {
    // Mask sensitive values
    const display = key.includes('SECRET') || key.includes('URL') 
      ? value.substring(0, 10) + '...'
      : value;
    console.log(`✅ ${key}: ${display}`);
  }
}

// Check optional
for (const key of optional) {
  const value = process.env[key];
  if (!value) {
    console.log(`⚠️  ${key}: not set (optional)`);
    warnings++;
  } else {
    console.log(`✅ ${key}: ${value}`);
  }
}

console.log('\n' + '='.repeat(40));

if (errors === 0 && warnings === 0) {
  console.log('✅ All environment variables valid!');
  process.exit(0);
} else if (errors === 0) {
  console.log(`⚠️  ${warnings} optional variables not set`);
  console.log('Deployment may work but with defaults.');
  process.exit(0);
} else {
  console.log(`❌ ${errors} required variables missing!`);
  console.log('Fix before deploying.');
  process.exit(1);
}

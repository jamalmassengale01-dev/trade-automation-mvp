import { pool } from './index';
import logger from '../utils/logger';

const seedLogger = logger.child({ context: 'seed' });

async function seed() {
  seedLogger.info('Starting database seeding...');
  
  try {
    // Create demo user
    const userResult = await pool.query(`
      INSERT INTO users (id, email, name, is_active)
      VALUES (
        '00000000-0000-0000-0000-000000000001',
        'admin@example.com',
        'Demo User',
        true
      )
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `);
    const userId = userResult.rows[0].id;
    seedLogger.info('Created/updated demo user', { userId });
    
    // Create broker accounts
    const accounts = [
      {
        id: '00000000-0000-0000-0000-000000000101',
        name: 'Mock Account 1',
        brokerType: 'mock',
        settings: {
          multiplier: 1,
          longOnly: false,
          shortOnly: false,
          allowedSymbols: [],
          maxContracts: 10,
          maxPositions: 5
        }
      },
      {
        id: '00000000-0000-0000-0000-000000000102',
        name: 'Simulated Account 1',
        brokerType: 'simulated',
        settings: {
          multiplier: 2,
          longOnly: true,
          shortOnly: false,
          allowedSymbols: ['ES', 'NQ', 'CL'],
          maxContracts: 5,
          maxPositions: 3
        }
      },
      {
        id: '00000000-0000-0000-0000-000000000103',
        name: 'Mock Account 2 (Small)',
        brokerType: 'mock',
        settings: {
          fixedSize: 1,
          multiplier: 1,
          longOnly: false,
          shortOnly: false,
          allowedSymbols: [],
          maxContracts: 1,
          maxPositions: 1
        }
      }
    ];
    
    for (const account of accounts) {
      await pool.query(`
        INSERT INTO broker_accounts (id, user_id, name, broker_type, settings, is_active)
        VALUES ($1, $2, $3, $4, $5, true)
        ON CONFLICT (id) DO UPDATE SET 
          name = EXCLUDED.name,
          settings = EXCLUDED.settings
      `, [account.id, userId, account.name, account.brokerType, JSON.stringify(account.settings)]);
      seedLogger.info('Created/updated broker account', { name: account.name });
    }
    
    // Create strategy
    const strategyResult = await pool.query(`
      INSERT INTO strategies (id, user_id, name, description, webhook_secret, is_active)
      VALUES (
        '00000000-0000-0000-0000-000000000201',
        $1,
        'Demo Strategy',
        'Test strategy for development',
        'demo-webhook-secret-123',
        true
      )
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [userId]);
    const strategyId = strategyResult.rows[0].id;
    seedLogger.info('Created/updated strategy', { strategyId });
    
    // Create risk rules
    const riskRules = [
      { ruleType: 'max_contracts', config: { maxContracts: 20 } },
      { ruleType: 'max_positions', config: { maxPositions: 10 } },
      { ruleType: 'cooldown', config: { seconds: 30 } },
      { ruleType: 'daily_loss_limit', config: { maxLoss: 1000 } },
      { ruleType: 'kill_switch', config: {} }
    ];
    
    for (const rule of riskRules) {
      await pool.query(`
        INSERT INTO risk_rules (strategy_id, rule_type, config, is_active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT DO NOTHING
      `, [strategyId, rule.ruleType, JSON.stringify(rule.config)]);
    }
    seedLogger.info('Created risk rules', { count: riskRules.length });
    
    // Create copier mappings
    const mappings = [
      { accountId: '00000000-0000-0000-0000-000000000101', multiplier: 1 },
      { accountId: '00000000-0000-0000-0000-000000000102', multiplier: 2 },
      { accountId: '00000000-0000-0000-0000-000000000103', multiplier: 1 }
    ];
    
    for (const mapping of mappings) {
      await pool.query(`
        INSERT INTO copier_mappings (strategy_id, account_id, is_active, multiplier)
        VALUES ($1, $2, true, $3)
        ON CONFLICT (strategy_id, account_id) DO UPDATE SET 
          is_active = EXCLUDED.is_active,
          multiplier = EXCLUDED.multiplier
      `, [strategyId, mapping.accountId, mapping.multiplier]);
    }
    seedLogger.info('Created copier mappings', { count: mappings.length });
    
    // Create system settings
    await pool.query(`
      INSERT INTO system_settings (key, value, description)
      VALUES 
        ('global_kill_switch', 'false', 'Emergency stop for all trading'),
        ('webhook_enabled', 'true', 'Accept incoming webhooks'),
        ('max_alerts_per_minute', '60', 'Rate limit for alerts per strategy')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);
    seedLogger.info('Created system settings');
    
    seedLogger.info('Database seeding completed successfully');
    
  } catch (error) {
    seedLogger.error('Seeding failed', { 
      error: error instanceof Error ? error.message : String(error) 
    });
    process.exit(1);
  }
  
  await pool.end();
}

seed();

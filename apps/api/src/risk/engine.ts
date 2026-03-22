import { RiskRule, TradeSignal, BrokerAccount, RiskEvent } from '../types';
import { query } from '../db';
import logger from '../utils/logger';
import config from '../config';

const riskLogger = logger.child({ context: 'RiskEngine' });

/**
 * Risk Check Result
 */
export interface RiskCheckResult {
  passed: boolean;
  ruleType?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Risk Engine
 * 
 * Evaluates trades against configured risk rules.
 * All rules must pass for the trade to be accepted.
 * 
 * Rules are evaluated in order of severity:
 * 1. Kill switches (global and account)
 * 2. Account state checks
 * 3. Position/size limits
 * 4. Time-based rules
 * 5. Cooldowns
 */
export class RiskEngine {
  /**
   * Check if a trade signal passes all risk rules
   */
  async checkTrade(
    signal: TradeSignal,
    strategyId: string,
    account?: BrokerAccount
  ): Promise<RiskCheckResult> {
    riskLogger.debug('Starting risk check', {
      strategyId,
      symbol: signal.symbol,
      action: signal.action,
    });
    
    // 1. Check global kill switch
    if (config.features.globalKillSwitch) {
      await this.logRiskEvent('kill_switch', strategyId, account?.id, {
        message: 'Global kill switch is active',
      });
      return {
        passed: false,
        ruleType: 'kill_switch',
        message: 'Trading is globally disabled',
      };
    }
    
    // 2. Check account kill switch if account provided
    if (account) {
      const accountKillSwitch = await this.checkAccountKillSwitch(account.id);
      if (accountKillSwitch) {
        return {
          passed: false,
          ruleType: 'kill_switch',
          message: 'Account kill switch is active',
        };
      }
      
      // 3. Check if account is disabled
      if (account.isDisabled) {
        return {
          passed: false,
          ruleType: 'account_disabled',
          message: 'Account is disabled',
        };
      }
    }
    
    // 4. Load and evaluate all active risk rules
    const rules = await this.loadRiskRules(strategyId);
    
    for (const rule of rules) {
      if (!rule.is_active) continue;
      
      const result = await this.evaluateRule(rule, signal, account);
      if (!result.passed) {
        await this.logRiskEvent(rule.rule_type, strategyId, account?.id, {
          message: result.message,
          details: result.details,
        });
        return result;
      }
    }
    
    riskLogger.debug('Risk check passed', {
      strategyId,
      symbol: signal.symbol,
    });
    
    return { passed: true };
  }
  
  /**
   * Load active risk rules for a strategy
   */
  private async loadRiskRules(strategyId: string): Promise<RiskRule[]> {
    const result = await query<RiskRule>(`
      SELECT * FROM risk_rules 
      WHERE strategy_id = $1 AND is_active = true
      ORDER BY 
        CASE rule_type
          WHEN 'kill_switch' THEN 1
          WHEN 'account_disabled' THEN 2
          WHEN 'symbol_whitelist' THEN 3
          WHEN 'session_time' THEN 4
          WHEN 'daily_loss_limit' THEN 5
          WHEN 'max_contracts' THEN 6
          WHEN 'max_positions' THEN 7
          WHEN 'conflicting_position' THEN 8
          WHEN 'cooldown' THEN 9
          ELSE 10
        END
    `, [strategyId]);
    
    return result.rows;
  }
  
  /**
   * Evaluate a single risk rule
   */
  private async evaluateRule(
    rule: RiskRule,
    signal: TradeSignal,
    account?: BrokerAccount
  ): Promise<RiskCheckResult> {
    switch (rule.rule_type) {
      case 'max_contracts':
        return this.checkMaxContracts(rule, signal);
        
      case 'max_positions':
        return this.checkMaxPositions(rule, signal, account);
        
      case 'cooldown':
        return this.checkCooldown(rule, signal, account);
        
      case 'session_time':
        return this.checkSessionTime(rule);
        
      case 'daily_loss_limit':
        return this.checkDailyLossLimit(rule, account);
        
      case 'symbol_whitelist':
        return this.checkSymbolWhitelist(rule, signal);
        
      case 'conflicting_position':
        return this.checkConflictingPosition(rule, signal, account);
        
      default:
        riskLogger.warn('Unknown risk rule type', { ruleType: rule.rule_type });
        return { passed: true };
    }
  }
  
  /**
   * Check max contracts per trade
   */
  private checkMaxContracts(rule: RiskRule, signal: TradeSignal): RiskCheckResult {
    const maxContracts = (rule.config as { maxContracts: number }).maxContracts;
    
    if (signal.contracts > maxContracts) {
      return {
        passed: false,
        ruleType: 'max_contracts',
        message: `Trade size ${signal.contracts} exceeds max contracts ${maxContracts}`,
        details: { requested: signal.contracts, max: maxContracts },
      };
    }
    
    return { passed: true };
  }
  
  /**
   * Check max open positions
   */
  private async checkMaxPositions(
    rule: RiskRule,
    signal: TradeSignal,
    account?: BrokerAccount
  ): Promise<RiskCheckResult> {
    if (!account) return { passed: true };
    
    const maxPositions = (rule.config as { maxPositions: number }).maxPositions;
    
    // Count current open positions for account
    const result = await query(
      'SELECT COUNT(DISTINCT symbol) as count FROM orders_submitted WHERE account_id = $1 AND status IN ($2, $3)',
      [account.id, 'filled', 'partially_filled']
    );
    
    const currentPositions = parseInt(result.rows[0].count, 10);
    
    if (currentPositions >= maxPositions && signal.action !== 'close') {
      return {
        passed: false,
        ruleType: 'max_positions',
        message: `Max positions ${maxPositions} reached`,
        details: { current: currentPositions, max: maxPositions },
      };
    }
    
    return { passed: true };
  }
  
  /**
   * Check cooldown period
   */
  private async checkCooldown(
    rule: RiskRule,
    signal: TradeSignal,
    account?: BrokerAccount
  ): Promise<RiskCheckResult> {
    const cooldownSeconds = (rule.config as { seconds: number }).seconds;
    const cutoff = new Date(Date.now() - cooldownSeconds * 1000);
    
    const result = await query(
      `SELECT COUNT(*) as count FROM trade_requests 
       WHERE symbol = $1 AND created_at > $2 
       ${account ? 'AND account_id = $3' : ''}`,
      account 
        ? [signal.symbol, cutoff, account.id]
        : [signal.symbol, cutoff]
    );
    
    const recentTrades = parseInt(result.rows[0].count, 10);
    
    if (recentTrades > 0) {
      return {
        passed: false,
        ruleType: 'cooldown',
        message: `Cooldown period active (${cooldownSeconds}s)`,
        details: { cooldownSeconds },
      };
    }
    
    return { passed: true };
  }
  
  /**
   * Check trading session time
   */
  private checkSessionTime(rule: RiskRule): RiskCheckResult {
    const config = rule.config as { 
      startHour: number; 
      startMinute: number;
      endHour: number;
      endMinute: number;
      timezone: string;
    };
    
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const currentTime = hour * 60 + minute;
    const startTime = config.startHour * 60 + config.startMinute;
    const endTime = config.endHour * 60 + config.endMinute;
    
    if (currentTime < startTime || currentTime > endTime) {
      return {
        passed: false,
        ruleType: 'session_time',
        message: 'Outside trading hours',
        details: { 
          current: `${hour}:${minute}`,
          allowed: `${config.startHour}:${config.startMinute} - ${config.endHour}:${config.endMinute}`,
        },
      };
    }
    
    return { passed: true };
  }
  
  /**
   * Check daily loss limit
   */
  private async checkDailyLossLimit(
    rule: RiskRule,
    account?: BrokerAccount
  ): Promise<RiskCheckResult> {
    if (!account) return { passed: true };
    
    const maxLoss = (rule.config as { maxLoss: number }).maxLoss;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Calculate realized P&L for today
    const result = await query(
      `SELECT COALESCE(SUM(
        CASE WHEN side = 'sell' THEN quantity * price ELSE -quantity * price END
      ), 0) as pnl 
      FROM executions 
      WHERE account_id = $1 AND executed_at > $2`,
      [account.id, today]
    );
    
    const dailyPnl = parseFloat(result.rows[0].pnl);
    
    if (dailyPnl < -maxLoss) {
      return {
        passed: false,
        ruleType: 'daily_loss_limit',
        message: `Daily loss limit ${maxLoss} exceeded`,
        details: { dailyPnl, limit: maxLoss },
      };
    }
    
    return { passed: true };
  }
  
  /**
   * Check symbol whitelist
   */
  private checkSymbolWhitelist(rule: RiskRule, signal: TradeSignal): RiskCheckResult {
    const allowedSymbols = (rule.config as { symbols: string[] }).symbols;
    
    if (allowedSymbols.length > 0 && !allowedSymbols.includes(signal.symbol)) {
      return {
        passed: false,
        ruleType: 'symbol_whitelist',
        message: `Symbol ${signal.symbol} not in whitelist`,
        details: { symbol: signal.symbol, allowed: allowedSymbols },
      };
    }
    
    return { passed: true };
  }
  
  /**
   * Check for conflicting positions
   */
  private async checkConflictingPosition(
    rule: RiskRule,
    signal: TradeSignal,
    account?: BrokerAccount
  ): Promise<RiskCheckResult> {
    if (!account || signal.action === 'close') return { passed: true };
    
    // Check for opposite position
    const oppositeSide = signal.action === 'buy' ? 'short' : 'long';
    
    const result = await query(
      `SELECT COUNT(*) as count FROM orders_submitted 
       WHERE account_id = $1 AND symbol = $2 AND status = 'filled'
       AND side = $3`,
      [account.id, signal.symbol, oppositeSide === 'long' ? 'buy' : 'sell']
    );
    
    const hasOppositePosition = parseInt(result.rows[0].count, 10) > 0;
    
    if (hasOppositePosition) {
      return {
        passed: false,
        ruleType: 'conflicting_position',
        message: `Conflicting ${oppositeSide} position exists`,
        details: { symbol: signal.symbol },
      };
    }
    
    return { passed: true };
  }
  
  /**
   * Check if account kill switch is active
   */
  private async checkAccountKillSwitch(accountId: string): Promise<boolean> {
    const result = await query(
      'SELECT value FROM system_settings WHERE key = $1',
      [`kill_switch_${accountId}`]
    );
    
    if (result.rowCount === 0) return false;
    
    return result.rows[0].value === 'true';
  }
  
  /**
   * Log a risk event
   */
  private async logRiskEvent(
    ruleType: string,
    strategyId: string,
    accountId: string | undefined,
    data: { message: string; details?: Record<string, unknown> }
  ): Promise<void> {
    await query(
      `INSERT INTO risk_events (type, rule_type, strategy_id, account_id, message, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      ['rejection', ruleType, strategyId, accountId || null, data.message, JSON.stringify(data.details || {})]
    );
    
    riskLogger.warn('Risk event logged', {
      ruleType,
      strategyId,
      accountId,
      message: data.message,
    });
  }
}

// Export singleton instance
export const riskEngine = new RiskEngine();

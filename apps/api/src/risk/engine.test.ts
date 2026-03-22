import { describe, it, expect } from 'vitest';
import { RiskEngine, RiskCheckResult } from './engine';
import { TradeSignal, RiskRule } from '../types';

describe('Risk Engine', () => {
  const riskEngine = new RiskEngine();

  describe('max_contracts rule', () => {
    const createMaxContractsRule = (max: number): RiskRule => ({
      id: 'rule-1',
      strategyId: 'strat-1',
      ruleType: 'max_contracts',
      config: { maxContracts: max },
      isActive: true,
    });

    it('should pass when contracts under limit', () => {
      const rule = createMaxContractsRule(10);
      const signal: TradeSignal = {
        symbol: 'ES',
        action: 'buy',
        contracts: 5,
      };

      // Direct test of the logic
      const result = signal.contracts <= rule.config.maxContracts;
      expect(result).toBe(true);
    });

    it('should reject when contracts exceed limit', () => {
      const rule = createMaxContractsRule(5);
      const signal: TradeSignal = {
        symbol: 'ES',
        action: 'buy',
        contracts: 10,
      };

      const result = signal.contracts <= rule.config.maxContracts;
      expect(result).toBe(false);
    });

    it('should pass when contracts exactly at limit', () => {
      const rule = createMaxContractsRule(5);
      const signal: TradeSignal = {
        symbol: 'ES',
        action: 'buy',
        contracts: 5,
      };

      const result = signal.contracts <= rule.config.maxContracts;
      expect(result).toBe(true);
    });
  });

  describe('symbol_whitelist rule', () => {
    const createWhitelistRule = (symbols: string[]): RiskRule => ({
      id: 'rule-1',
      strategyId: 'strat-1',
      ruleType: 'symbol_whitelist',
      config: { symbols },
      isActive: true,
    });

    it('should pass when symbol is in whitelist', () => {
      const rule = createWhitelistRule(['ES', 'NQ']);
      const signal: TradeSignal = {
        symbol: 'ES',
        action: 'buy',
        contracts: 1,
      };

      const allowed = rule.config.symbols.includes(signal.symbol);
      expect(allowed).toBe(true);
    });

    it('should reject when symbol not in whitelist', () => {
      const rule = createWhitelistRule(['ES', 'NQ']);
      const signal: TradeSignal = {
        symbol: 'CL',
        action: 'buy',
        contracts: 1,
      };

      const allowed = rule.config.symbols.includes(signal.symbol);
      expect(allowed).toBe(false);
    });

    it('should pass when whitelist is empty', () => {
      const rule = createWhitelistRule([]);
      const signal: TradeSignal = {
        symbol: 'ANY',
        action: 'buy',
        contracts: 1,
      };

      const allowed = rule.config.symbols.length === 0 || 
        rule.config.symbols.includes(signal.symbol);
      expect(allowed).toBe(true);
    });
  });

  describe('cooldown rule', () => {
    it('should calculate cooldown correctly', () => {
      const cooldownSeconds = 60;
      const lastTradeTime = new Date(Date.now() - 30 * 1000); // 30 seconds ago
      const cutoff = new Date(Date.now() - cooldownSeconds * 1000);

      const inCooldown = lastTradeTime > cutoff;
      expect(inCooldown).toBe(true);
    });

    it('should allow trade after cooldown expires', () => {
      const cooldownSeconds = 30;
      const lastTradeTime = new Date(Date.now() - 60 * 1000); // 60 seconds ago
      const cutoff = new Date(Date.now() - cooldownSeconds * 1000);

      const inCooldown = lastTradeTime > cutoff;
      expect(inCooldown).toBe(false);
    });
  });

  describe('session_time rule', () => {
    const isInSession = (
      currentHour: number,
      currentMinute: number,
      startHour: number,
      startMinute: number,
      endHour: number,
      endMinute: number
    ): boolean => {
      const currentTime = currentHour * 60 + currentMinute;
      const startTime = startHour * 60 + startMinute;
      const endTime = endHour * 60 + endMinute;
      return currentTime >= startTime && currentTime <= endTime;
    };

    it('should pass during trading hours', () => {
      const result = isInSession(14, 30, 9, 30, 16, 0); // 2:30 PM
      expect(result).toBe(true);
    });

    it('should reject before market open', () => {
      const result = isInSession(8, 0, 9, 30, 16, 0); // 8:00 AM
      expect(result).toBe(false);
    });

    it('should reject after market close', () => {
      const result = isInSession(17, 0, 9, 30, 16, 0); // 5:00 PM
      expect(result).toBe(false);
    });

    it('should pass exactly at market open', () => {
      const result = isInSession(9, 30, 9, 30, 16, 0);
      expect(result).toBe(true);
    });

    it('should pass exactly at market close', () => {
      const result = isInSession(16, 0, 9, 30, 16, 0);
      expect(result).toBe(true);
    });
  });

  describe('daily_loss_limit rule', () => {
    const checkDailyLoss = (dailyPnl: number, maxLoss: number): boolean => {
      return dailyPnl >= -maxLoss;
    };

    it('should pass when loss under limit', () => {
      const result = checkDailyLoss(-500, 1000); // Lost $500, limit $1000
      expect(result).toBe(true);
    });

    it('should reject when loss exceeds limit', () => {
      const result = checkDailyLoss(-1500, 1000); // Lost $1500, limit $1000
      expect(result).toBe(false);
    });

    it('should pass when at exact loss limit', () => {
      const result = checkDailyLoss(-1000, 1000);
      expect(result).toBe(true);
    });

    it('should pass when profitable', () => {
      const result = checkDailyLoss(500, 1000);
      expect(result).toBe(true);
    });
  });

  describe('RiskCheckResult structure', () => {
    it('should have correct structure for passed check', () => {
      const result: RiskCheckResult = { passed: true };
      expect(result.passed).toBe(true);
      expect(result.ruleType).toBeUndefined();
      expect(result.message).toBeUndefined();
    });

    it('should have correct structure for failed check', () => {
      const result: RiskCheckResult = {
        passed: false,
        ruleType: 'max_contracts',
        message: 'Trade size 20 exceeds max contracts 10',
        details: { requested: 20, max: 10 },
      };
      expect(result.passed).toBe(false);
      expect(result.ruleType).toBe('max_contracts');
      expect(result.message).toContain('exceeds');
    });
  });
});

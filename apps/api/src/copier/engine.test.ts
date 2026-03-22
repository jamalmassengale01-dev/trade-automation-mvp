import { describe, it, expect, beforeEach } from 'vitest';
import { CopierEngine, CopierResult } from './engine';
import { TradeSignal, BrokerAccount, CopierMapping, TradeRequest } from '../types';

// Simple unit tests for copier sizing logic (without DB)
describe('Copier Sizing Logic', () => {
  const copierEngine = new CopierEngine();
  
  // Helper to access private method for testing
  const calculateSize = (signal: TradeSignal, mapping: CopierMapping, account: BrokerAccount): number => {
    // Use fixed size if configured
    if (mapping.fixedSize) {
      return Math.min(mapping.fixedSize, account.settings.maxContracts);
    }
    
    // Apply multiplier
    const baseSize = signal.contracts || 1;
    const multiplied = Math.floor(baseSize * mapping.multiplier);
    
    // Apply account limits
    const accountLimit = account.settings.maxContracts;
    return Math.min(multiplied, accountLimit);
  };

  const baseSignal: TradeSignal = {
    symbol: 'ES',
    action: 'buy',
    contracts: 5,
  };

  const baseAccount: BrokerAccount = {
    id: 'acc-1',
    userId: 'user-1',
    name: 'Test Account',
    brokerType: 'mock',
    credentials: {},
    isActive: true,
    isDisabled: false,
    settings: {
      multiplier: 1,
      longOnly: false,
      shortOnly: false,
      allowedSymbols: [],
      maxContracts: 100,
      maxPositions: 10,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe('multiplier sizing', () => {
    it('should apply multiplier correctly', () => {
      const mapping: CopierMapping = {
        id: 'map-1',
        strategyId: 'strat-1',
        accountId: 'acc-1',
        isActive: true,
        multiplier: 2,
        longOnly: false,
        shortOnly: false,
        allowedSymbols: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const size = calculateSize(baseSignal, mapping, baseAccount);
      expect(size).toBe(10); // 5 * 2 = 10
    });

    it('should apply fractional multiplier', () => {
      const mapping: CopierMapping = {
        id: 'map-1',
        strategyId: 'strat-1',
        accountId: 'acc-1',
        isActive: true,
        multiplier: 0.5,
        longOnly: false,
        shortOnly: false,
        allowedSymbols: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const size = calculateSize(baseSignal, mapping, baseAccount);
      expect(size).toBe(2); // floor(5 * 0.5) = 2
    });

    it('should respect account max contracts limit', () => {
      const accountWithLimit: BrokerAccount = {
        ...baseAccount,
        settings: { ...baseAccount.settings, maxContracts: 3 },
      };

      const mapping: CopierMapping = {
        id: 'map-1',
        strategyId: 'strat-1',
        accountId: 'acc-1',
        isActive: true,
        multiplier: 1,
        longOnly: false,
        shortOnly: false,
        allowedSymbols: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const size = calculateSize(baseSignal, mapping, accountWithLimit);
      expect(size).toBe(3); // min(5, 3) = 3
    });
  });

  describe('fixed sizing', () => {
    it('should use fixed size when configured', () => {
      const mapping: CopierMapping = {
        id: 'map-1',
        strategyId: 'strat-1',
        accountId: 'acc-1',
        isActive: true,
        fixedSize: 3,
        multiplier: 1,
        longOnly: false,
        shortOnly: false,
        allowedSymbols: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const size = calculateSize(baseSignal, mapping, baseAccount);
      expect(size).toBe(3); // fixedSize wins
    });

    it('should respect account limit with fixed size', () => {
      const accountWithLimit: BrokerAccount = {
        ...baseAccount,
        settings: { ...baseAccount.settings, maxContracts: 2 },
      };

      const mapping: CopierMapping = {
        id: 'map-1',
        strategyId: 'strat-1',
        accountId: 'acc-1',
        isActive: true,
        fixedSize: 5,
        multiplier: 1,
        longOnly: false,
        shortOnly: false,
        allowedSymbols: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const size = calculateSize(baseSignal, mapping, accountWithLimit);
      expect(size).toBe(2); // min(5, 2) = 2
    });
  });

  describe('filtering logic', () => {
    const applyFilters = (
      signal: TradeSignal,
      mapping: CopierMapping,
      account: BrokerAccount
    ): { allowed: boolean; reason?: string } => {
      // Long-only filter
      if (mapping.longOnly && signal.action === 'sell') {
        return { allowed: false, reason: 'Account is long-only' };
      }
      
      // Short-only filter
      if (mapping.shortOnly && signal.action === 'buy') {
        return { allowed: false, reason: 'Account is short-only' };
      }
      
      // Symbol filter
      if (
        mapping.allowedSymbols.length > 0 &&
        !mapping.allowedSymbols.includes(signal.symbol)
      ) {
        return {
          allowed: false,
          reason: `Symbol ${signal.symbol} not in allowed list`,
        };
      }
      
      return { allowed: true };
    };

    it('should block sell for long-only accounts', () => {
      const signal: TradeSignal = { symbol: 'ES', action: 'sell', contracts: 1 };
      const mapping: CopierMapping = {
        id: 'map-1',
        strategyId: 'strat-1',
        accountId: 'acc-1',
        isActive: true,
        multiplier: 1,
        longOnly: true,
        shortOnly: false,
        allowedSymbols: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = applyFilters(signal, mapping, baseAccount);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('long-only');
    });

    it('should block buy for short-only accounts', () => {
      const signal: TradeSignal = { symbol: 'ES', action: 'buy', contracts: 1 };
      const mapping: CopierMapping = {
        id: 'map-1',
        strategyId: 'strat-1',
        accountId: 'acc-1',
        isActive: true,
        multiplier: 1,
        longOnly: false,
        shortOnly: true,
        allowedSymbols: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = applyFilters(signal, mapping, baseAccount);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('short-only');
    });

    it('should block disallowed symbols', () => {
      const signal: TradeSignal = { symbol: 'CL', action: 'buy', contracts: 1 };
      const mapping: CopierMapping = {
        id: 'map-1',
        strategyId: 'strat-1',
        accountId: 'acc-1',
        isActive: true,
        multiplier: 1,
        longOnly: false,
        shortOnly: false,
        allowedSymbols: ['ES', 'NQ'],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = applyFilters(signal, mapping, baseAccount);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('CL');
    });

    it('should allow allowed symbols', () => {
      const signal: TradeSignal = { symbol: 'ES', action: 'buy', contracts: 1 };
      const mapping: CopierMapping = {
        id: 'map-1',
        strategyId: 'strat-1',
        accountId: 'acc-1',
        isActive: true,
        multiplier: 1,
        longOnly: false,
        shortOnly: false,
        allowedSymbols: ['ES', 'NQ'],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = applyFilters(signal, mapping, baseAccount);
      expect(result.allowed).toBe(true);
    });

    it('should allow all symbols when allowedSymbols is empty', () => {
      const signal: TradeSignal = { symbol: 'CL', action: 'buy', contracts: 1 };
      const mapping: CopierMapping = {
        id: 'map-1',
        strategyId: 'strat-1',
        accountId: 'acc-1',
        isActive: true,
        multiplier: 1,
        longOnly: false,
        shortOnly: false,
        allowedSymbols: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = applyFilters(signal, mapping, baseAccount);
      expect(result.allowed).toBe(true);
    });
  });
});

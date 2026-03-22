import { describe, it, expect } from 'vitest';
import { validateAlert, tradingViewAlertSchema } from './schema';

describe('Webhook Schema Validation', () => {
  const validAlert = {
    id: 'alert-123',
    timestamp: Date.now(),
    strategy: 'MyStrategy',
    symbol: 'ES',
    action: 'buy',
    contracts: 2,
    price: 4500.50,
    stopLoss: 4490,
    takeProfit: 4520,
    message: 'Test alert',
    metadata: { indicator: 'RSI' },
  };

  describe('validateAlert', () => {
    it('should validate a correct alert', () => {
      const result = validateAlert(validAlert);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(validAlert);
    });

    it('should reject missing required fields', () => {
      const invalid = { ...validAlert, id: undefined };
      const result = validateAlert(invalid);
      expect(result.success).toBe(false);
      expect(result.error).toContain('id');
    });

    it('should reject invalid action', () => {
      const invalid = { ...validAlert, action: 'invalid' };
      const result = validateAlert(invalid);
      expect(result.success).toBe(false);
      expect(result.error).toContain('action');
    });

    it('should reject negative contracts', () => {
      const invalid = { ...validAlert, contracts: -1 };
      const result = validateAlert(invalid);
      expect(result.success).toBe(false);
      expect(result.error).toContain('contracts');
    });

    it('should reject zero contracts', () => {
      const invalid = { ...validAlert, contracts: 0 };
      const result = validateAlert(invalid);
      expect(result.success).toBe(false);
      expect(result.error).toContain('contracts');
    });

    it('should accept minimal valid alert', () => {
      const minimal = {
        id: 'test-1',
        timestamp: Date.now(),
        strategy: 'Test',
        symbol: 'AAPL',
        action: 'buy',
      };
      const result = validateAlert(minimal);
      expect(result.success).toBe(true);
    });

    it('should accept all valid actions', () => {
      const actions = ['buy', 'sell', 'close', 'reverse'];
      for (const action of actions) {
        const alert = { ...validAlert, action };
        const result = validateAlert(alert);
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid timestamp', () => {
      const invalid = { ...validAlert, timestamp: 'not-a-number' };
      const result = validateAlert(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject too long message', () => {
      const invalid = { ...validAlert, message: 'x'.repeat(2000) };
      const result = validateAlert(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('tradingViewAlertSchema', () => {
    it('should parse valid data', () => {
      const result = tradingViewAlertSchema.safeParse(validAlert);
      expect(result.success).toBe(true);
    });

    it('should strip unknown fields', () => {
      const withExtra = { ...validAlert, unknownField: 'value' };
      const result = tradingViewAlertSchema.safeParse(withExtra);
      expect(result.success).toBe(true); // Zod strips unknown fields by default
      expect(result.data).not.toHaveProperty('unknownField');
    });
  });
});

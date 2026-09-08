import { describe, it, expect } from 'vitest';
import { MockBrokerAdapter } from './mockBroker';

describe('MockBroker balance is driven by settings', () => {
  it('honours settings.mockBalance so a mock account can match its preset', async () => {
    const a = new MockBrokerAdapter();
    await a.connect();
    const info = await a.getAccountInfo({ id: 'acc-1', settings: { mockBalance: 50000 } } as never);
    expect(info.cashBalance).toBe(50000);
    expect(info.equity).toBe(50000);
    expect(info.realizedPnL).toBe(0);
  });

  it('falls back to 100000 when unset', async () => {
    const a = new MockBrokerAdapter();
    await a.connect();
    const info = await a.getAccountInfo({ id: 'acc-2', settings: {} } as never);
    expect(info.cashBalance).toBe(100000);
  });

  it('returns account_id, not accountId — the shape AccountInfo declares', async () => {
    const a = new MockBrokerAdapter();
    await a.connect();
    const info = await a.getAccountInfo({ id: 'acc-3', settings: {} } as never);
    expect(info.account_id).toBe('acc-3');
  });
});

import { IBrokerAdapter } from './interface';
import { MockBrokerAdapter } from './mockBroker';
import { SimulatedBrokerAdapter } from './simulatedBroker';
import { TradovateBrokerAdapter } from './tradovateBroker';
import { BrokerType } from '../types';
import config from '../config';
import logger from '../utils/logger';

const factoryLogger = logger.child({ context: 'BrokerFactory' });

// Registry of broker adapters
const adapterRegistry: Map<string, IBrokerAdapter> = new Map();

/**
 * Which adapters have been connected.
 *
 * Tracked here because BaseBrokerAdapter.isConnected is protected, so callers
 * cannot ask. Without this, the failure is silent and confusing: adapters are
 * created lazily on first use, so connectAllAdapters() at boot iterates an
 * EMPTY registry and connects nothing. Every adapter created afterwards then
 * throws "Broker adapter X is not connected" on its first real call.
 */
const connectedAdapters = new Set<string>();

/**
 * Get or create a broker adapter instance
 */
export function getBrokerAdapter(brokerType: BrokerType): IBrokerAdapter {
  // Return cached instance if exists
  if (adapterRegistry.has(brokerType)) {
    return adapterRegistry.get(brokerType)!;
  }
  
  // Create new instance
  let adapter: IBrokerAdapter;
  
  switch (brokerType) {
    case 'mock':
      if (!config.features.enableMockBroker) {
        throw new Error('Mock broker is disabled');
      }
      adapter = new MockBrokerAdapter();
      break;
      
    case 'simulated':
      if (!config.features.enableSimulatedBroker) {
        throw new Error('Simulated broker is disabled');
      }
      adapter = new SimulatedBrokerAdapter();
      break;
      
    case 'tradovate':
      adapter = new TradovateBrokerAdapter();
      break;
      
    case 'tradier':
      // TODO: Implement Tradier adapter
      throw new Error('Tradier broker not yet implemented');
      
    default:
      throw new Error(`Unknown broker type: ${brokerType}`);
  }
  
  // Cache and return
  adapterRegistry.set(brokerType, adapter);
  factoryLogger.info('Created broker adapter', { brokerType });
  
  return adapter;
}

/**
 * Get an adapter, connecting it on first use.
 *
 * Prefer this over getBrokerAdapter() anywhere a broker call follows. Every
 * connect() implementation is idempotent and cheap, but the guard keeps the
 * common path to a Set lookup.
 */
export async function getConnectedBrokerAdapter(brokerType: BrokerType): Promise<IBrokerAdapter> {
  const adapter = getBrokerAdapter(brokerType);
  if (connectedAdapters.has(brokerType)) return adapter;

  await adapter.connect();
  connectedAdapters.add(brokerType);
  factoryLogger.info('Connected adapter on first use', { brokerType });
  return adapter;
}

/**
 * Connect all registered adapters
 */
export async function connectAllAdapters(): Promise<void> {
  factoryLogger.info('Connecting all broker adapters');
  
  for (const [type, adapter] of adapterRegistry) {
    try {
      await adapter.connect();
      connectedAdapters.add(type);
      factoryLogger.info('Connected adapter', { type });
    } catch (error) {
      factoryLogger.error('Failed to connect adapter', { 
        type, 
        error: error instanceof Error ? error.message : String(error) 
      });
      throw error;
    }
  }
}

/**
 * Disconnect all registered adapters
 */
export async function disconnectAllAdapters(): Promise<void> {
  factoryLogger.info('Disconnecting all broker adapters');
  
  for (const [type, adapter] of adapterRegistry) {
    try {
      await adapter.disconnect();
      connectedAdapters.delete(type);
      factoryLogger.info('Disconnected adapter', { type });
    } catch (error) {
      factoryLogger.error('Failed to disconnect adapter', { 
        type, 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }
  
  adapterRegistry.clear();
  connectedAdapters.clear();
}

/**
 * Health check all adapters
 */
export async function healthCheckAllAdapters(): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  
  for (const [type, adapter] of adapterRegistry) {
    try {
      results[type] = await adapter.healthCheck();
    } catch {
      results[type] = false;
    }
  }
  
  return results;
}

/**
 * Reset all adapters (mainly for testing)
 */
export function resetAllAdapters(): void {
  adapterRegistry.clear();
  connectedAdapters.clear();
}

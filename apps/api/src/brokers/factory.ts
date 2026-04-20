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
 * Connect all registered adapters
 */
export async function connectAllAdapters(): Promise<void> {
  factoryLogger.info('Connecting all broker adapters');
  
  for (const [type, adapter] of adapterRegistry) {
    try {
      await adapter.connect();
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
      factoryLogger.info('Disconnected adapter', { type });
    } catch (error) {
      factoryLogger.error('Failed to disconnect adapter', { 
        type, 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }
  
  adapterRegistry.clear();
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
}

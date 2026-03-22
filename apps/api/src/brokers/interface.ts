import {
  BrokerAccount,
  AccountInfo,
  Position,
  Order,
  PlaceOrderRequest,
} from '../types';

/**
 * Broker Adapter Interface
 * 
 * All broker implementations must conform to this interface.
 * This allows seamless swapping between mock, simulated, and real brokers.
 */
export interface IBrokerAdapter {
  /** Unique identifier for this adapter instance */
  readonly name: string;
  
  /** Broker type identifier */
  readonly brokerType: string;
  
  /** Connect to the broker */
  connect(): Promise<void>;
  
  /** Disconnect from the broker */
  disconnect(): Promise<void>;
  
  /** Check if connection is healthy */
  healthCheck(): Promise<boolean>;
  
  /** Get account information */
  getAccountInfo(account: BrokerAccount): Promise<AccountInfo>;
  
  /** Get current positions */
  getPositions(account: BrokerAccount): Promise<Position[]>;
  
  /** Place a new order */
  placeOrder(
    account: BrokerAccount,
    request: PlaceOrderRequest
  ): Promise<Order>;
  
  /** Cancel an existing order */
  cancelOrder(account: BrokerAccount, orderId: string): Promise<boolean>;
  
  /** Flatten all positions (close everything) */
  flattenAll(account: BrokerAccount): Promise<void>;
}

/**
 * Base class for broker adapters with common functionality
 */
export abstract class BaseBrokerAdapter implements IBrokerAdapter {
  abstract readonly name: string;
  abstract readonly brokerType: string;
  
  protected isConnected = false;
  protected logger: Console;
  
  constructor(logger?: Console) {
    this.logger = logger || console;
  }
  
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract healthCheck(): Promise<boolean>;
  abstract getAccountInfo(account: BrokerAccount): Promise<AccountInfo>;
  abstract getPositions(account: BrokerAccount): Promise<Position[]>;
  abstract placeOrder(account: BrokerAccount, request: PlaceOrderRequest): Promise<Order>;
  abstract cancelOrder(account: BrokerAccount, orderId: string): Promise<boolean>;
  abstract flattenAll(account: BrokerAccount): Promise<void>;
  
  protected ensureConnected(): void {
    if (!this.isConnected) {
      throw new Error(`Broker adapter ${this.name} is not connected`);
    }
  }
}

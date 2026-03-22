import { z } from 'zod';

/**
 * TradingView Alert Schema
 * 
 * Validates incoming webhook payloads from TradingView.
 * All fields are validated strictly to ensure data integrity.
 */
export const tradingViewAlertSchema = z.object({
  // Required fields
  id: z.string().min(1).max(255).describe('Unique alert ID from TradingView'),
  timestamp: z.number().int().positive().describe('Unix timestamp in milliseconds'),
  strategy: z.string().min(1).max(255).describe('Strategy name/identifier'),
  symbol: z.string().min(1).max(50).describe('Trading symbol (e.g., ES, NQ, AAPL)'),
  action: z.enum(['buy', 'sell', 'close', 'reverse']).describe('Trade action'),
  
  // Optional fields
  contracts: z.number().int().positive().optional()
    .describe('Number of contracts/shares'),
  price: z.number().positive().optional()
    .describe('Price level (for limit/stop orders)'),
  stopLoss: z.number().positive().optional()
    .describe('Stop loss price'),
  takeProfit: z.number().positive().optional()
    .describe('Take profit price'),
  message: z.string().max(1000).optional()
    .describe('Optional message from strategy'),
  metadata: z.record(z.unknown()).optional()
    .describe('Additional strategy-specific data'),
});

export type TradingViewAlertInput = z.infer<typeof tradingViewAlertSchema>;

/**
 * Validate alert payload
 */
export function validateAlert(payload: unknown): { 
  success: boolean; 
  data?: TradingViewAlertInput; 
  error?: string 
} {
  const result = tradingViewAlertSchema.safeParse(payload);
  
  if (result.success) {
    return { success: true, data: result.data };
  }
  
  // Format Zod error into readable message
  const errors = result.error.errors.map(e => 
    `${e.path.join('.')}: ${e.message}`
  ).join('; ');
  
  return { success: false, error: errors };
}

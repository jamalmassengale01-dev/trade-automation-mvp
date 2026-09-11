/**
 * GET/PUT/DELETE /api/broker-keys/:broker
 *
 * The operator's own broker API key, entered once and reused by every account
 * they connect.
 *
 * The secret is write-only over this API. GET reports that one is stored and
 * never what it is — a settings page that renders a secret back into an input
 * puts it in the DOM, in screenshots, and in any screen share, for no gain: the
 * only thing anyone needs to do with a secret they already have is replace it.
 */

import { Router, Request, Response } from 'express';
import logger from '../utils/logger';
import {
  getApiKeySummary,
  saveApiKey,
  deleteApiKey,
} from '../services/brokerApiKeys';

const router = Router();
const log = logger.child({ context: 'BrokerKeysRoute' });

const SUPPORTED = ['tradovate'];

function brokerOf(req: Request): string | null {
  const broker = (req.params.broker ?? 'tradovate').toLowerCase();
  return SUPPORTED.includes(broker) ? broker : null;
}

router.get('/:broker', async (req: Request, res: Response) => {
  const broker = brokerOf(req);
  if (!broker) {
    res.status(400).json({ success: false, error: 'Unsupported broker' });
    return;
  }
  try {
    const summary = await getApiKeySummary(req.user!.id, broker);
    res.json({ success: true, data: summary });
  } catch (error) {
    log.error('Failed to read broker API key', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to read API key' });
  }
});

router.put('/:broker', async (req: Request, res: Response) => {
  const broker = brokerOf(req);
  if (!broker) {
    res.status(400).json({ success: false, error: 'Unsupported broker' });
    return;
  }
  const { cid, sec, appId, appVersion } = req.body ?? {};
  if (typeof cid !== 'string' || typeof sec !== 'string') {
    res.status(400).json({ success: false, error: 'cid and sec are required' });
    return;
  }
  try {
    const summary = await saveApiKey(req.user!.id, { cid, sec, appId, appVersion }, broker);
    // Never log cid or sec. This records that a key changed, not which one.
    log.info('Broker API key saved', { userId: req.user!.id, broker });
    res.json({ success: true, data: summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save API key';
    res.status(400).json({ success: false, error: message });
  }
});

router.delete('/:broker', async (req: Request, res: Response) => {
  const broker = brokerOf(req);
  if (!broker) {
    res.status(400).json({ success: false, error: 'Unsupported broker' });
    return;
  }
  try {
    const removed = await deleteApiKey(req.user!.id, broker);
    // Accounts already connected keep the credentials copied into their own
    // row, so removing the key stops NEW connections rather than breaking
    // live ones. Said plainly because the opposite would be a reasonable guess.
    res.json({
      success: true,
      data: { removed },
      message: 'Existing accounts keep their saved credentials. New accounts will need a key.',
    });
  } catch (error) {
    log.error('Failed to delete broker API key', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to delete API key' });
  }
});

export default router;

/**
 * Billing routes.
 *
 * The webhook is NOT mounted here — it needs the raw request body for signature
 * verification and therefore has to sit before the global JSON parser. It lives
 * in indexHardened.ts next to that decision, where the ordering is visible.
 */

import { Router, Request, Response } from 'express';
import {
  createCheckoutSession, createPortalSession, resyncSubscription,
  stripeConfigured, sellableTiers,
} from '../services/stripe';
import { entitlementForUser } from '../services/entitlements';
import { TIERS, TierId } from '../strategy/subscription';
import logger from '../utils/logger';

const router = Router();
const routeLogger = logger.child({ context: 'BillingRoute' });

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

/** GET /api/billing/tiers — plans, and which can actually be bought. */
router.get('/tiers', (_req: Request, res: Response) => {
  const sellable = sellableTiers();
  res.json({
    success: true,
    data: {
      configured: stripeConfigured(),
      tiers: Object.values(TIERS).map((t) => ({ ...t, purchasable: sellable.includes(t.id) })),
    },
  });
});

/** GET /api/billing/me — this user's entitlement, for the dashboard. */
router.get('/me', async (req: Request, res: Response) => {
  try {
    const e = await entitlementForUser(req.user!.id);
    res.json({ success: true, data: e });
  } catch (error) {
    routeLogger.error('Failed to read entitlement', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to read subscription' });
  }
});

/** POST /api/billing/checkout — start a subscription. Body: { tier }. */
router.post('/checkout', async (req: Request, res: Response) => {
  try {
    if (!stripeConfigured()) {
      res.status(503).json({ success: false, error: 'Billing is not configured on this server' });
      return;
    }

    // The tier NAME comes from the client; the PRICE never does. An amount
    // chosen by the caller is a bill chosen by the caller.
    const tier = String(req.body?.tier ?? '') as TierId;
    if (!(tier in TIERS)) {
      res.status(400).json({ success: false, error: `tier must be one of: ${Object.keys(TIERS).join(', ')}` });
      return;
    }
    if (!sellableTiers().includes(tier)) {
      res.status(400).json({ success: false, error: `No price is configured for the ${tier} plan` });
      return;
    }

    const url = await createCheckoutSession({
      userId: req.user!.id,
      tier,
      successUrl: `${APP_URL}/billing?checkout=success`,
      cancelUrl: `${APP_URL}/billing?checkout=cancelled`,
    });

    routeLogger.info('Checkout session created', { userId: req.user!.id, tier });
    res.json({ success: true, data: { url } });
  } catch (error) {
    routeLogger.error('Failed to create checkout session', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to start checkout' });
  }
});

/** POST /api/billing/portal — manage card, invoices, cancellation, in Stripe. */
router.post('/portal', async (req: Request, res: Response) => {
  try {
    if (!stripeConfigured()) {
      res.status(503).json({ success: false, error: 'Billing is not configured on this server' });
      return;
    }
    const url = await createPortalSession(req.user!.id, `${APP_URL}/billing`);
    res.json({ success: true, data: { url } });
  } catch (error) {
    routeLogger.error('Failed to create portal session', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to open the billing portal' });
  }
});

/**
 * POST /api/billing/resync — re-read this user's subscription from Stripe.
 *
 * Webhooks get missed: an endpoint down for an hour, a rotated secret. Without
 * a way back, a missed event is permanent divergence between what someone pays
 * for and what they get.
 */
router.post('/resync', async (req: Request, res: Response) => {
  try {
    const ok = await resyncSubscription(req.user!.id);
    const entitlement = await entitlementForUser(req.user!.id);
    res.json({ success: true, data: { resynced: ok, entitlement } });
  } catch (error) {
    routeLogger.error('Failed to resync subscription', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to resync' });
  }
});

export default router;

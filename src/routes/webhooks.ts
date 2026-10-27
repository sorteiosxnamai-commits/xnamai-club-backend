import { Request, Response, Router } from 'express';
import Stripe from 'stripe';
import { env } from '../config/env';
import { requireStripe } from '../config/stripe';
import { AppDataSource } from '../config/data-source';
import { Plan } from '../entities/Plan';
import { User } from '../entities/User';
import { applyStripeInvoice } from '../routes/subscriptions';
import { applySetupPaymentMethod, enforceSingleActiveStripeSubscription, fulfillPaidPixCheckout, PIX_MONTH_PURPOSE, upsertLocalSubscription } from '../services/stripe-billing';

export const webhooksRouter = Router();

export async function stripeWebhookHandler(req: Request, res: Response) {
  let stripe;
  try {
    stripe = requireStripe();
  } catch {
    return res.status(503).json({ message: 'Stripe indisponível.' });
  }
  const signature = req.headers['stripe-signature'];
  const secrets = [env.stripe.webhookSecret, env.stripe.testWebhookSecret].filter(Boolean);
  if (!secrets.length || typeof signature !== 'string') {
    return res.status(400).json({ message: 'Webhook Stripe sem assinatura.' });
  }

  let event: Stripe.Event;
  try {
    let verified: Stripe.Event | undefined;
    for (const secret of secrets) {
      try {
        verified = stripe.webhooks.constructEvent(req.body, signature, secret);
        break;
      } catch { /* Try the other configured endpoint secret. */ }
    }
    if (!verified) throw new Error('Nenhum segredo configurado validou a assinatura.');
    event = verified;
  } catch (error) {
    console.error('Stripe webhook inválido:', error);
    return res.status(400).json({ message: 'Assinatura do webhook inválida.' });
  }

  // A test endpoint can target production, but must never change real memberships.
  const liveMode = /^(sk|rk)_live_/.test(env.stripe.secretKey);
  if (event.livemode !== liveMode) return res.json({ received: true, ignored: 'mode_mismatch' });

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === 'setup') {
        await applySetupPaymentMethod(session);
      }
      if (session.mode === 'payment' && session.id) {
        await fulfillPaidPixCheckout(session.id);
      }
      if (session.mode === 'subscription' && session.subscription && session.metadata?.userId && session.metadata?.planId) {
        const user = await AppDataSource.getRepository(User).findOne({ where: { id: session.metadata.userId } });
        const plan = await AppDataSource.getRepository(Plan).findOne({ where: { id: session.metadata.planId } });
        if (user && plan) {
          const created = await stripe.subscriptions.retrieve(String(session.subscription), {
            expand: ['default_payment_method', 'latest_invoice'],
          });
          const stripeSubscription = await enforceSingleActiveStripeSubscription(created);
          await upsertLocalSubscription({ user, plan, stripeSubscription });
        }
      }
    }

    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const stripeSubscription = event.data.object as Stripe.Subscription;
      const userId = stripeSubscription.metadata?.userId;
      const planId = stripeSubscription.metadata?.planId;
      if (userId && planId) {
        const user = await AppDataSource.getRepository(User).findOne({ where: { id: userId } });
        const plan = await AppDataSource.getRepository(Plan).findOne({ where: { id: planId } });
        if (user && plan) {
          await upsertLocalSubscription({ user, plan, stripeSubscription });
        }
      }
    }

    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object as Stripe.PaymentIntent;
      if (intent.metadata?.purpose === PIX_MONTH_PURPOSE) {
        const found = await stripe.checkout.sessions.list({ payment_intent: intent.id, limit: 1 });
        const sessionId = found.data[0]?.id;
        if (sessionId) await fulfillPaidPixCheckout(sessionId);
      }
    }

    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      await applyStripeInvoice(event.data.object as Stripe.Invoice);
    }
  } catch (error) {
    console.error('Stripe webhook processing failed:', error);
    return res.status(500).json({ message: 'Falha ao processar webhook.' });
  }

  res.json({ received: true });
}

webhooksRouter.post('/payment-provider', (_req, res) => {
  res.status(410).json({ message: 'Use /api/webhooks/stripe.' });
});

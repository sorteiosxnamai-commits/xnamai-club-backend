import { Request, Response, Router } from 'express';
import Stripe from 'stripe';
import { env } from '../config/env';
import { requireStripe } from '../config/stripe';
import { AppDataSource } from '../config/data-source';
import { Plan } from '../entities/Plan';
import { User } from '../entities/User';
import { applyStripeInvoice } from '../routes/subscriptions';
import { upsertLocalSubscription } from '../services/stripe-billing';

export const webhooksRouter = Router();

export async function stripeWebhookHandler(req: Request, res: Response) {
  const stripe = requireStripe();
  const signature = req.headers['stripe-signature'];
  if (!env.stripe.webhookSecret || typeof signature !== 'string') {
    return res.status(400).json({ message: 'Webhook Stripe sem assinatura.' });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, env.stripe.webhookSecret);
  } catch (error) {
    console.error('Stripe webhook inválido:', error);
    return res.status(400).json({ message: 'Assinatura do webhook inválida.' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === 'subscription' && session.subscription && session.metadata?.userId && session.metadata?.planId) {
        const user = await AppDataSource.getRepository(User).findOne({ where: { id: session.metadata.userId } });
        const plan = await AppDataSource.getRepository(Plan).findOne({ where: { id: session.metadata.planId } });
        if (user && plan) {
          const stripeSubscription = await stripe.subscriptions.retrieve(String(session.subscription), {
            expand: ['default_payment_method'],
          });
          await upsertLocalSubscription({ user, plan, stripeSubscription });
        }
      }
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
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

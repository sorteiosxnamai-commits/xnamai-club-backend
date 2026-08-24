import Stripe from 'stripe';
import { env } from './env';

export const stripe = env.stripe.secretKey
  ? new Stripe(env.stripe.secretKey)
  : null;

export function requireStripe() {
  if (!stripe) {
    throw new Error('STRIPE_SECRET_KEY não configurada.');
  }
  return stripe;
}

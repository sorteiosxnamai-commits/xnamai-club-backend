import Stripe from 'stripe';
import { stripe } from '../config/stripe';

const SINCE = Math.floor(Date.UTC(2026, 8, 1) / 1000);
const CACHE_MS = 5 * 60 * 1000;

let cache: { at: number; ids: Set<string> } | null = null;

function customerId(value: string | { id?: string } | null | undefined) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id ?? null;
}

function remember(
  latest: Map<string, { created: number; boleto: boolean }>,
  id: string | null,
  created: number,
  boleto: boolean,
) {
  if (!id) return;
  const previous = latest.get(id);
  if (!previous || created >= previous.created) latest.set(id, { created, boleto });
}

async function scanCharges(client: Stripe, latest: Map<string, { created: number; boleto: boolean }>) {
  let startingAfter: string | undefined;
  for (let page = 0; page < 8; page += 1) {
    const charges = await client.charges.list({
      limit: 100,
      created: { gte: SINCE },
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const charge of charges.data) {
      if (!charge.paid || charge.status !== 'succeeded') continue;
      remember(latest, customerId(charge.customer), charge.created, charge.payment_method_details?.type === 'boleto');
    }
    if (!charges.has_more || charges.data.length === 0) break;
    startingAfter = charges.data[charges.data.length - 1]?.id;
  }
}

async function scanPaymentIntents(client: Stripe, latest: Map<string, { created: number; boleto: boolean }>) {
  let startingAfter: string | undefined;
  for (let page = 0; page < 8; page += 1) {
    const intents = await client.paymentIntents.list({
      limit: 100,
      created: { gte: SINCE },
      expand: ['data.payment_method'],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const intent of intents.data) {
      if (intent.status !== 'succeeded') continue;
      const method = intent.payment_method;
      const boleto = (method && typeof method !== 'string' && method.type === 'boleto')
        || (intent.payment_method_types.length === 1 && intent.payment_method_types[0] === 'boleto');
      remember(latest, customerId(intent.customer), intent.created, boleto);
    }
    if (!intents.has_more || intents.data.length === 0) break;
    startingAfter = intents.data[intents.data.length - 1]?.id;
  }
}

export async function boletoCustomerIds() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.ids;
  const client = stripe;
  if (!client) return new Set<string>();

  const latest = new Map<string, { created: number; boleto: boolean }>();
  await scanCharges(client, latest);
  await scanPaymentIntents(client, latest);

  const ids = new Set<string>();
  for (const [id, info] of latest) {
    if (info.boleto) ids.add(id);
  }
  cache = { at: Date.now(), ids };
  return ids;
}

import { env } from '../config/env';

const STRIPE_API = 'https://api.stripe.com/v1';

const SUBSCRIPTION_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const;

type StripeList<T> = { data: T[] };
type StripeWebhookEndpoint = {
  id: string;
  url: string;
  status: string;
  secret?: string;
};
type StripeErrorBody = { error?: { message?: string; code?: string } };

function webhookUrl() {
  return `${env.publicApiUrl}/api/webhooks/stripe`;
}

async function stripeForm(method: string, path: string, body?: URLSearchParams) {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.stripe.restrictedKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const json = (await response.json()) as StripeErrorBody & StripeList<StripeWebhookEndpoint> & StripeWebhookEndpoint;
  if (!response.ok) {
    const message = json.error?.message || `Stripe ${response.status}`;
    throw new Error(message);
  }
  return json;
}

export async function ensureStripeWebhookEndpoint() {
  if (!env.stripe.restrictedKey) {
    console.warn('Stripe: STRIPE_RESTRICTED_KEY ausente — webhook não será registrado via API.');
    return;
  }
  if (!env.publicApiUrl) {
    console.warn('Stripe: defina PUBLIC_API_URL (HTTPS público) para criar o webhook. localhost não é aceito.');
    return;
  }
  if (env.publicApiUrl.startsWith('http://localhost') || env.publicApiUrl.startsWith('http://127.')) {
    console.warn('Stripe: PUBLIC_API_URL local não recebe eventos. Use um túnel HTTPS ou o Stripe CLI.');
    return;
  }

  const url = webhookUrl();

  try {
    const listed = await stripeForm('GET', '/webhook_endpoints?limit=100');
    const existing = listed.data?.find((endpoint) => endpoint.url === url);
    if (existing) {
      console.log(`Stripe webhook já registrado: ${existing.id} (${existing.status})`);
      return;
    }
  } catch (error) {
    console.warn(
      'Stripe: não foi possível listar webhooks. Na chave restrita, ative também Leitura em Webhook Endpoints.',
      error instanceof Error ? error.message : error,
    );
  }

  const body = new URLSearchParams();
  body.set('url', url);
  body.set('description', 'xnamai-club-backend');
  for (const event of SUBSCRIPTION_EVENTS) {
    body.append('enabled_events[]', event);
  }

  const created = await stripeForm('POST', '/webhook_endpoints', body);
  console.log(`Stripe webhook criado: ${created.id}`);
  if (created.secret) {
    console.log(`Cole este valor em STRIPE_WEBHOOK_SECRET (aparece só na criação): ${created.secret}`);
  }
}

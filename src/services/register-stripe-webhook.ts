import { env } from '../config/env';

const STRIPE_API = 'https://api.stripe.com/v1';

const SUBSCRIPTION_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'payment_intent.succeeded',
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
  enabled_events?: string[];
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
  if (env.stripe.secretKey && /^(sk|rk)_live_/.test(env.stripe.secretKey) !== /^rk_live_/.test(env.stripe.restrictedKey)) {
    throw new Error('STRIPE_RESTRICTED_KEY e STRIPE_SECRET_KEY devem usar o mesmo modo.');
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
      const update = new URLSearchParams();
      const events = existing.enabled_events?.includes('*') ? ['*'] : [...new Set([...(existing.enabled_events ?? []), ...SUBSCRIPTION_EVENTS])];
      for (const event of events) update.append('enabled_events[]', event);
      if (existing.status === 'disabled' && env.stripe.webhookSecret) update.set('disabled', 'false');
      await stripeForm('POST', `/webhook_endpoints/${existing.id}`, update);
      if (!env.stripe.webhookSecret) console.warn('Stripe: STRIPE_WEBHOOK_SECRET ausente. As entregas serão rejeitadas até configurar o segredo deste endpoint.');
      console.log(`Stripe webhook já registrado: ${existing.id} (${existing.status})`);
      return;
    }
  } catch (error) {
    console.warn(
      'Stripe: não foi possível listar webhooks. Na chave restrita, ative também Leitura em Webhook Endpoints.',
      error instanceof Error ? error.message : error,
    );
    return;
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
    env.stripe.webhookSecret = created.secret;
    console.warn('Stripe: novo segredo de webhook disponível apenas neste processo. Configure STRIPE_WEBHOOK_SECRET no provedor antes de reiniciar.');
  }
}

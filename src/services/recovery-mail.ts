import { env } from '../config/env';

type BrevoConfig = Pick<typeof env, 'brevoApiKey' | 'brevoSenderEmail'>;

export class MailDeliveryUncertainError extends Error {
  constructor() {
    super('Brevo delivery confirmation unavailable');
  }
}

export function recoveryMailConfigured(): boolean {
  if (!env.brevoApiKey || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.brevoSenderEmail)) return false;
  try {
    const url = new URL(env.frontendUrl);
    return !url.username && !url.password && (process.env.NODE_ENV !== 'production' || url.protocol === 'https:');
  } catch {
    return false;
  }
}

export async function sendRecoveryEmail(
  to: string,
  link: string,
  fetcher: typeof fetch = fetch,
  config: BrevoConfig = env,
): Promise<string | null> {
  const safeLink = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let response: Response;
  try {
    response = await fetcher('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': config.brevoApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { email: config.brevoSenderEmail, name: 'xNaMai Club' },
        to: [{ email: to }],
        subject: 'xNaMai Club — Redefinição de senha',
        textContent: `Recebemos um pedido para redefinir sua senha. Abra este link em até 30 minutos: ${link}\nSe você não solicitou, ignore este e-mail.`,
        htmlContent: `<p>Recebemos um pedido para redefinir sua senha. Este link vale por 30 minutos.</p><p><a href="${safeLink}">Redefinir minha senha</a></p><p>Se você não solicitou, ignore este e-mail.</p>`,
      }),
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    throw new MailDeliveryUncertainError();
  }
  if (!response.ok) throw new Error(`Brevo API request failed (${response.status})`);
  const result = await response.json().catch(() => ({})) as { messageId?: unknown };
  return typeof result.messageId === 'string' ? result.messageId : null;
}

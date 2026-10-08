import { randomBytes } from 'node:crypto';
import { env } from '../config/env';

type GmailConfig = Pick<typeof env, 'gmailSender' | 'googleClientId' | 'googleClientSecret' | 'googleRefreshToken'>;

export class GmailDeliveryUncertainError extends Error {
  constructor() {
    super('Gmail delivery confirmation unavailable');
  }
}

export function recoveryMailConfigured(): boolean {
  if (env.gmailSender.toLowerCase() !== 'sorteiosxnamai@gmail.com') return false;
  if (!env.googleClientId || !env.googleClientSecret || !env.googleRefreshToken) return false;
  try {
    const url = new URL(env.frontendUrl);
    return !url.username && !url.password && (process.env.NODE_ENV !== 'production' || url.protocol === 'https:');
  } catch {
    return false;
  }
}

function mimeMessage(to: string, link: string, sender: string): string {
  if (/[\r\n]/.test(to) || /[\r\n]/.test(sender)) throw new Error('Invalid mail address');
  const boundary = `xnamai_${randomBytes(12).toString('hex')}`;
  const safeLink = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const subject = `=?UTF-8?B?${Buffer.from('xNaMai Club — Redefinição de senha').toString('base64')}?=`;
  return [
    `From: xNaMai Club <${sender}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    `Recebemos um pedido para redefinir sua senha. Abra este link em até 30 minutos: ${link}`,
    'Se você não solicitou, ignore este e-mail.',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    `<p>Recebemos um pedido para redefinir sua senha. Este link vale por 30 minutos.</p><p><a href="${safeLink}">Redefinir minha senha</a></p><p>Se você não solicitou, ignore este e-mail.</p>`,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export async function sendRecoveryEmail(
  to: string,
  link: string,
  fetcher: typeof fetch = fetch,
  config: GmailConfig = env,
): Promise<void> {
  let tokenResponse: Response;
  try {
    tokenResponse = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: config.googleRefreshToken,
      grant_type: 'refresh_token',
    }).toString(),
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    throw new Error('Gmail OAuth token request failed');
  }
  if (!tokenResponse.ok) throw new Error('Gmail OAuth token request failed');
  const credentials = await tokenResponse.json() as { access_token?: string };
  if (!credentials.access_token) throw new Error('Gmail OAuth token missing');

  const raw = Buffer.from(mimeMessage(to, link, config.gmailSender), 'utf8').toString('base64url');
  let response: Response;
  try {
    response = await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    throw new GmailDeliveryUncertainError();
  }
  if (!response.ok) throw new Error('Gmail API request failed');
}

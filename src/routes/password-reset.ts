import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Request, Router } from 'express';
import { z } from 'zod';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';
import { User, UserRole } from '../entities/User';
import { RecoveryRateLimit } from '../entities/RecoveryRateLimit';
import { audit } from '../services/audit';
import { GmailDeliveryUncertainError, recoveryMailConfigured, sendRecoveryEmail } from '../services/recovery-mail';

export const FORGOT_MESSAGE = 'Se o e-mail estiver cadastrado, você receberá um link para redefinir sua senha.';
const INVALID_TOKEN_MESSAGE = 'Link inválido ou expirado. Solicite outro link de recuperação.';
const WINDOW_MS = 60 * 60 * 1000;
const MIN_RESPONSE_MS = 8_500;
type MailSender = (to: string, link: string) => Promise<void>;

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function limit(kind: string, identifier: string, maximum: number): Promise<boolean> {
  const bucket = Math.floor(Date.now() / WINDOW_MS);
  const key = `${kind}:${bucket}:${sha256(identifier)}`;
  const repo = AppDataSource.getRepository(RecoveryRateLimit);
  await repo.createQueryBuilder().insert().values({ key, attempts: 0, expiresAt: (bucket + 2) * WINDOW_MS }).orIgnore().execute();
  await repo.createQueryBuilder().update().set({ attempts: () => 'attempts + 1' }).where('key = :key', { key }).execute();
  const entry = await repo.findOneByOrFail({ key });
  return entry.attempts <= maximum;
}

async function rateAllowed(req: Request, kind: string, identifier: string, ipMax: number, idMax: number) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const [byIp, byIdentifier] = await Promise.all([
    limit(`${kind}:ip`, ip, ipMax),
    limit(`${kind}:id`, identifier, idMax),
  ]);
  return byIp && byIdentifier;
}

async function uniformDelay(started: number) {
  const remaining = MIN_RESPONSE_MS - (Date.now() - started);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

function recoveryLink(token: string) {
  const url = new URL('/redefinir-senha', env.frontendUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

export function createPasswordResetRouter(sendMail: MailSender = sendRecoveryEmail) {
  const router = Router();

  router.post('/forgot-password', async (req, res) => {
    const started = Date.now();
    const parsed = z.object({ email: z.string().trim().email().max(320) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Informe um e-mail válido.' });
    const email = parsed.data.email.toLowerCase();
    if (!await rateAllowed(req, 'forgot', email, 20, 3)) {
      await uniformDelay(started);
      return res.status(429).json({ message: 'Muitas tentativas. Aguarde antes de solicitar outro link.' });
    }
    if (sendMail === sendRecoveryEmail && !recoveryMailConfigured()) {
      console.error('Recuperação de senha indisponível: configuração de e-mail ou FRONTEND_URL inválida.');
      await uniformDelay(started);
      return res.status(503).json({ message: 'Recuperação temporariamente indisponível. Tente novamente mais tarde.' });
    }

    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOne({ where: { email, role: UserRole.CUSTOMER } });
    if (user) {
      const token = randomBytes(32).toString('hex');
      const tokenHash = sha256(token);
      await repo.createQueryBuilder().update(User).set({
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      }).where('id = :id AND role = :role', { id: user.id, role: UserRole.CUSTOMER }).execute();
      let accepted = false;
      let uncertain = false;
      try {
        await sendMail(user.email, recoveryLink(token));
        accepted = true;
      } catch (error) {
        uncertain = error instanceof GmailDeliveryUncertainError;
        console.error(uncertain
          ? 'Recuperação de senha: confirmação do Gmail indisponível.'
          : 'Recuperação de senha: provedor de e-mail falhou.');
      }
      if (accepted) {
        try {
          await audit({ actorUserId: user.id, action: 'CUSTOMER_PASSWORD_RESET_EMAIL_ACCEPTED', entity: 'User', entityId: user.id });
        } catch {
          console.error('Recuperação de senha: falha ao registrar aceite de e-mail.');
        }
      } else if (uncertain) {
        try {
          await audit({ actorUserId: user.id, action: 'CUSTOMER_PASSWORD_RESET_EMAIL_UNCONFIRMED', entity: 'User', entityId: user.id });
        } catch {
          console.error('Recuperação de senha: falha ao registrar envio não confirmado.');
        }
      } else {
        try {
          await repo.createQueryBuilder().update(User).set({ passwordResetTokenHash: null, passwordResetExpiresAt: null })
            .where('id = :id AND password_reset_token_hash = :hash', { id: user.id, hash: tokenHash }).execute();
          await audit({ actorUserId: user.id, action: 'CUSTOMER_PASSWORD_RESET_EMAIL_FAILED', entity: 'User', entityId: user.id });
        } catch {
          console.error('Recuperação de senha: falha ao registrar erro de e-mail.');
        }
      }
    }
    await uniformDelay(started);
    return res.status(202).json({ message: FORGOT_MESSAGE });
  });

  router.post('/reset-password', async (req, res) => {
    const parsed = z.object({
      token: z.string().regex(/^[a-f0-9]{64}$/i),
      password: z.string().min(8, 'A senha deve ter pelo menos 8 caracteres.'),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Link inválido ou senha com menos de 8 caracteres.' });
    const tokenHash = sha256(parsed.data.token.toLowerCase());
    if (!await rateAllowed(req, 'reset', tokenHash, 30, 5)) {
      return res.status(429).json({ message: 'Muitas tentativas. Aguarde antes de tentar novamente.' });
    }
    const repo = AppDataSource.getRepository(User);
    const owner = await repo.createQueryBuilder('user').select('user.id')
      .where('user.password_reset_token_hash = :hash', { hash: tokenHash }).getOne();
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const result = await repo.createQueryBuilder().update(User).set({
      passwordHash,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      authVersion: () => 'auth_version + 1',
    }).where('password_reset_token_hash = :hash AND password_reset_expires_at > :now AND role = :role', {
      hash: tokenHash,
      now: new Date(),
      role: UserRole.CUSTOMER,
    }).execute();
    if (result.affected !== 1) return res.status(400).json({ message: INVALID_TOKEN_MESSAGE });
    try {
      await audit({ actorUserId: owner?.id, action: 'CUSTOMER_PASSWORD_RESET_SELF_SERVICE', entity: 'User', entityId: owner?.id });
    } catch {
      console.error('Recuperação de senha: falha ao registrar redefinição.');
    }
    return res.json({ message: 'Senha redefinida com sucesso. Entre com a nova senha.' });
  });

  return router;
}

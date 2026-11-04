import { Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AppDataSource } from '../config/data-source';
import { User, UserRole } from '../entities/User';
import { requireAuth, requireRole, signAccessToken } from '../middleware/auth';
import { audit } from '../services/audit';
import { createPasswordResetRouter } from './password-reset';
import { isValidCnpj, normalizeCnpj } from '../services/cnpj';

export const authRouter = Router();

const BRAZIL_STATES = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS',
  'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;

function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    companyName: user.companyName,
    document: user.document,
    city: user.city,
    state: user.state,
    phone: user.phone,
    role: user.role,
  };
}

function firstValidationMessage(error: z.ZodError, fallback: string) {
  const issues = error.flatten();
  const fieldMessages = Object.values(issues.fieldErrors).flat().filter((item): item is string => Boolean(item));
  return fieldMessages[0] || issues.formErrors[0] || fallback;
}

function documentAlreadyRegistered(res: Response) {
  return res.status(409).json({
    message: 'CNPJ já cadastrado. Entre com a conta existente.',
    issues: {
      fieldErrors: { document: ['CNPJ já cadastrado.'] },
      formErrors: [],
    },
  });
}

function isRegistrationDocumentConflict(error: unknown) {
  const details = error as { code?: string; constraint?: string; message?: string };
  const text = `${details.constraint || ''} ${details.message || ''}`;
  return (details.code === '23505' || details.code === 'SQLITE_CONSTRAINT')
    && /registration_document_key/i.test(text);
}

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Informe seu nome completo.'),
  email: z.string().email('Informe um e-mail válido.'),
  password: z.string().min(8, 'A senha deve ter pelo menos 8 caracteres.'),
  companyName: z.string().trim().min(2, 'Informe o nome da empresa.').max(200),
  city: z.string().trim().min(2, 'Informe a cidade.'),
  state: z.string().trim().toUpperCase().refine((value) => BRAZIL_STATES.includes(value as (typeof BRAZIL_STATES)[number]), 'Informe um estado válido.'),
  document: z.string().trim().refine(isValidCnpj, 'Informe um CNPJ válido. O Club é exclusivo para lojistas.').transform(normalizeCnpj),
  phone: z.string().optional(),
});

authRouter.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: firstValidationMessage(parsed.error, 'Dados inválidos. Confira os campos e tente novamente.'),
      issues: parsed.error.flatten(),
    });
  }

  const repo = AppDataSource.getRepository(User);
  const email = parsed.data.email.toLowerCase();
  if (await repo.findOne({ where: { email } })) return res.status(409).json({ message: 'E-mail já cadastrado.' });

  const document = normalizeCnpj(parsed.data.document);
  if (await findDocumentOwner(document)) return documentAlreadyRegistered(res);

  const { password, ...profile } = parsed.data;
  let user: User;
  try {
    user = await repo.save(repo.create({
      ...profile,
      email,
      document,
      registrationDocumentKey: document,
      passwordHash: await bcrypt.hash(password, 12),
      role: UserRole.CUSTOMER,
    }));
  } catch (error) {
    if (isRegistrationDocumentConflict(error)) return documentAlreadyRegistered(res);
    throw error;
  }

  const token = signAccessToken({ sub: user.id, email: user.email, role: user.role, authVersion: user.authVersion || 0 });
  res.status(201).json({ token, user: publicUser(user) });
});

// Normalize formatting for legacy rows without rewriting historical documents.
async function findDocumentOwner(document: string) {
  return AppDataSource.getRepository(User).createQueryBuilder('user')
    .where("UPPER(REPLACE(REPLACE(REPLACE(REPLACE(user.document, '.', ''), '/', ''), '-', ''), ' ', '')) = :document", { document }).getOne();
}

authRouter.patch('/business', requireAuth, requireRole(UserRole.CUSTOMER), async (req, res, next) => {
  const parsed = z.object({
    companyName: z.string().trim().min(2, 'Informe o nome da empresa.').max(200),
    document: z.string().trim().refine(isValidCnpj, 'Informe um CNPJ válido.').transform(normalizeCnpj),
  }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: firstValidationMessage(parsed.error, 'Cadastro empresarial inválido.'), issues: parsed.error.flatten() });
  try {
    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOneByOrFail({ id: req.auth!.sub });
    if (isValidCnpj(user.document || '') && normalizeCnpj(user.document!) !== parsed.data.document) {
      return res.status(409).json({ message: 'Para alterar um CNPJ já cadastrado, fale com o atendimento.' });
    }
    const owner = await findDocumentOwner(parsed.data.document);
    if (owner && owner.id !== user.id) return documentAlreadyRegistered(res);
    await AppDataSource.transaction(async manager => {
      const previousDocument = user.document;
      user.companyName = parsed.data.companyName;
      user.document = parsed.data.document;
      user.registrationDocumentKey = parsed.data.document;
      const update = manager.createQueryBuilder().update(User).set({ companyName: user.companyName, document: user.document, registrationDocumentKey: user.registrationDocumentKey })
        .where('id = :id', { id: user.id });
      if (previousDocument == null) update.andWhere('document IS NULL');
      else update.andWhere('document = :previousDocument', { previousDocument });
      if ((await update.execute()).affected !== 1) throw new Error('BUSINESS_CONFLICT');
      const { AuditLog } = await import('../entities/AuditLog');
      await manager.getRepository(AuditLog).save({ actorUserId: user.id, action: 'BUSINESS_REGISTRATION_UPDATED', entity: 'User', entityId: user.id });
    });
    return res.json({ user: publicUser(user) });
  } catch (error) {
    if (isRegistrationDocumentConflict(error)) return documentAlreadyRegistered(res);
    if ((error as Error).message === 'BUSINESS_CONFLICT') return res.status(409).json({ message: 'O cadastro foi alterado. Recarregue a página e tente novamente.' });
    next(error);
  }
});

authRouter.post('/login', async (req, res) => {
  const parsed = z.object({
    email: z.string().email('Informe um e-mail válido.'),
    password: z.string().min(1, 'Informe a senha.'),
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: firstValidationMessage(parsed.error, 'E-mail ou senha inválidos.'),
      issues: parsed.error.flatten(),
    });
  }

  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { email: parsed.data.email.toLowerCase() } });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ message: 'E-mail ou senha inválidos.' });
  }

  const token = signAccessToken({ sub: user.id, email: user.email, role: user.role, authVersion: user.authVersion || 0 });
  res.json({ token, user: publicUser(user) });
});

authRouter.post('/users/:id/reset-password', requireAuth, requireRole(UserRole.ADMIN, UserRole.SUPPORT), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const parsed = z.object({
    password: z.string().min(12, 'A nova senha deve ter pelo menos 12 caracteres.'),
  }).safeParse(req.body);
  if (!id.success) return res.status(404).json({ message: 'Cliente não encontrado.' });
  if (!parsed.success) {
    return res.status(400).json({
      message: firstValidationMessage(parsed.error, 'Nova senha inválida.'),
      issues: parsed.error.flatten(),
    });
  }

  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { id: id.data, role: UserRole.CUSTOMER } });
  if (!user) return res.status(404).json({ message: 'Cliente não encontrado.' });

  user.passwordHash = await bcrypt.hash(parsed.data.password, 12);
  await repo.save(user);
  await audit({
    actorUserId: req.auth!.sub,
    action: 'CUSTOMER_PASSWORD_RESET',
    entity: 'User',
    entityId: user.id,
  });
  return res.json({ message: 'Senha redefinida com sucesso.' });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await AppDataSource.getRepository(User).findOne({ where: { id: req.auth!.sub } });
  if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });
  res.json(publicUser(user));
});

authRouter.use(createPasswordResetRouter());

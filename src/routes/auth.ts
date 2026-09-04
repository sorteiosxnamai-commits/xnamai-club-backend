import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AppDataSource } from '../config/data-source';
import { User, UserRole } from '../entities/User';
import { requireAuth, signAccessToken } from '../middleware/auth';

export const authRouter = Router();

const BRAZIL_STATES = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS',
  'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;

function onlyDigits(value: string) {
  return value.replace(/\D/g, '');
}

function isValidCpf(digits: string) {
  if (digits.length !== 11 || /^(\d)\1+$/.test(digits)) return false;
  const check = (length: number) => {
    const sum = digits.slice(0, length).split('').reduce((total, digit, index) => total + Number(digit) * (length + 1 - index), 0);
    const rest = (sum * 10) % 11;
    return (rest === 10 ? 0 : rest) === Number(digits[length]);
  };
  return check(9) && check(10);
}

function isValidCnpj(digits: string) {
  if (digits.length !== 14 || /^(\d)\1+$/.test(digits)) return false;
  const check = (weights: number[]) => {
    const sum = weights.reduce((total, weight, index) => total + Number(digits[index]) * weight, 0);
    const rest = sum % 11;
    return (rest < 2 ? 0 : 11 - rest) === Number(digits[weights.length]);
  };
  return check([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) && check([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
}

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

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Informe seu nome completo.'),
  email: z.string().email('Informe um e-mail válido.'),
  password: z.string().min(8, 'A senha deve ter pelo menos 8 caracteres.'),
  companyName: z.string().trim().optional(),
  city: z.string().trim().min(2, 'Informe a cidade.'),
  state: z.string().trim().toUpperCase().refine((value) => BRAZIL_STATES.includes(value as (typeof BRAZIL_STATES)[number]), 'Informe um estado válido.'),
  document: z.string().trim().min(11, 'Informe o CPF ou CNPJ.').refine((value) => {
    const digits = onlyDigits(value);
    return isValidCpf(digits) || isValidCnpj(digits);
  }, 'Informe um CPF ou CNPJ válido.'),
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

  const { password, ...profile } = parsed.data;
  const user = await repo.save(repo.create({
    ...profile,
    email,
    document: onlyDigits(profile.document),
    passwordHash: await bcrypt.hash(password, 12),
    role: UserRole.CUSTOMER,
  }));

  const token = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  res.status(201).json({ token, user: publicUser(user) });
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

  const token = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  res.json({ token, user: publicUser(user) });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await AppDataSource.getRepository(User).findOne({ where: { id: req.auth!.sub } });
  if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });
  res.json(publicUser(user));
});

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AppDataSource } from '../config/data-source';
import { User, UserRole } from '../entities/User';
import { requireAuth, signAccessToken } from '../middleware/auth';

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  companyName: z.string().optional(),
  document: z.string().optional(),
  phone: z.string().optional(),
});

authRouter.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Dados inválidos.', issues: parsed.error.flatten() });

  const repo = AppDataSource.getRepository(User);
  const email = parsed.data.email.toLowerCase();
  if (await repo.findOne({ where: { email } })) return res.status(409).json({ message: 'E-mail já cadastrado.' });

  const user = await repo.save(repo.create({
    ...parsed.data,
    email,
    passwordHash: await bcrypt.hash(parsed.data.password, 12),
    role: UserRole.CUSTOMER,
  }));

  const token = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name, companyName: user.companyName, role: user.role } });
});

authRouter.post('/login', async (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Dados inválidos.' });

  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { email: parsed.data.email.toLowerCase() } });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ message: 'E-mail ou senha inválidos.' });
  }

  const token = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, companyName: user.companyName, role: user.role } });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await AppDataSource.getRepository(User).findOne({ where: { id: req.auth!.sub } });
  if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });
  res.json({ id: user.id, email: user.email, name: user.name, companyName: user.companyName, document: user.document, phone: user.phone, role: user.role });
});

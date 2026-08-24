import bcrypt from 'bcryptjs';
import { AppDataSource } from '../config/data-source';
import { Plan } from '../entities/Plan';
import { User, UserRole } from '../entities/User';

export async function seedInitialData() {
  const planRepo = AppDataSource.getRepository(Plan);
  if (await planRepo.count() === 0) {
    await planRepo.save([
      planRepo.create({ code: 'START', name: 'Plano Start', monthlyPriceCents: 19990, purchaseLimitCents: 1_000_000, description: 'Para compras de até R$ 10 mil por mês', sortOrder: 1 }),
      planRepo.create({ code: 'GROWTH', name: 'Plano Growth', monthlyPriceCents: 29990, purchaseLimitCents: 2_500_000, description: 'Para compras de até R$ 25 mil por mês', sortOrder: 2 }),
      planRepo.create({ code: 'PRO', name: 'Plano Pro', monthlyPriceCents: 49900, purchaseLimitCents: 5_000_000, description: 'Para compras de até R$ 50 mil por mês', sortOrder: 3 }),
      planRepo.create({ code: 'MAX', name: 'Plano Max', monthlyPriceCents: 99900, purchaseLimitCents: 10_000_000, description: 'Para compras de até R$ 100 mil por mês', sortOrder: 4 }),
      planRepo.create({ code: 'ENTERPRISE', name: 'Enterprise', monthlyPriceCents: null, purchaseLimitCents: null, description: 'Para compras acima de R$ 100 mil por mês', sortOrder: 5 }),
    ]);
  }

  const userRepo = AppDataSource.getRepository(User);
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@xnamai.local').toLowerCase();
  if (!(await userRepo.findOne({ where: { email: adminEmail } }))) {
    await userRepo.save(userRepo.create({
      email: adminEmail,
      name: 'Admin XNaMai',
      companyName: 'XNaMai',
      passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Admin123!', 12),
      role: UserRole.ADMIN,
    }));
  }
}

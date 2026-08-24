import bcrypt from 'bcryptjs';
import { AppDataSource } from '../config/data-source';
import { stripe } from '../config/stripe';
import { Plan } from '../entities/Plan';
import { User, UserRole } from '../entities/User';

async function ensureStripePrices() {
  if (!stripe) {
    console.warn('Stripe: STRIPE_SECRET_KEY ausente — Price IDs não serão criados.');
    return;
  }

  const planRepo = AppDataSource.getRepository(Plan);
  const plans = await planRepo.find();
  for (const plan of plans) {
    if (plan.monthlyPriceCents == null) continue;

    if (plan.stripePriceId) {
      try {
        const existing = await stripe.prices.retrieve(plan.stripePriceId);
        if (existing.unit_amount === plan.monthlyPriceCents && existing.currency === 'brl' && !existing.deleted) {
          continue;
        }
      } catch {
        plan.stripePriceId = null;
      }
    }

    const product = await stripe.products.create({
      name: plan.name,
      metadata: { planCode: plan.code },
    });
    const price = await stripe.prices.create({
      product: product.id,
      currency: 'brl',
      unit_amount: plan.monthlyPriceCents,
      recurring: { interval: 'month' },
      metadata: { planCode: plan.code },
    });
    plan.stripePriceId = price.id;
    await planRepo.save(plan);
    console.log(`Stripe Price criado para ${plan.code}: ${price.id}`);
  }
}

export async function seedInitialData() {
  const planRepo = AppDataSource.getRepository(Plan);
  if (await planRepo.count() === 0) {
    await planRepo.save([
      planRepo.create({ code: 'START', name: 'Plano Start', monthlyPriceCents: 100, purchaseLimitCents: 1_000_000, description: 'Para compras de até R$ 10 mil por mês', sortOrder: 1 }),
      planRepo.create({ code: 'GROWTH', name: 'Plano Growth', monthlyPriceCents: 29990, purchaseLimitCents: 2_500_000, description: 'Para compras de até R$ 25 mil por mês', sortOrder: 2 }),
      planRepo.create({ code: 'PRO', name: 'Plano Pro', monthlyPriceCents: 49900, purchaseLimitCents: 5_000_000, description: 'Para compras de até R$ 50 mil por mês', sortOrder: 3 }),
      planRepo.create({ code: 'MAX', name: 'Plano Max', monthlyPriceCents: 99900, purchaseLimitCents: 10_000_000, description: 'Para compras de até R$ 100 mil por mês', sortOrder: 4 }),
      planRepo.create({ code: 'ENTERPRISE', name: 'Enterprise', monthlyPriceCents: null, purchaseLimitCents: null, description: 'Para compras acima de R$ 100 mil por mês', sortOrder: 5 }),
    ]);
  } else {
    const startPlan = await planRepo.findOne({ where: { code: 'START' } });
    if (startPlan && startPlan.monthlyPriceCents !== 100) {
      startPlan.monthlyPriceCents = 100;
      startPlan.stripePriceId = null;
      await planRepo.save(startPlan);
    }
  }

  await ensureStripePrices();

  const userRepo = AppDataSource.getRepository(User);
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@xnamai.local').toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  let admin = await userRepo.findOne({ where: { email: adminEmail } });
  if (!admin) {
    admin = await userRepo.findOne({ where: { role: UserRole.ADMIN } });
  }
  if (!admin) {
    await userRepo.save(userRepo.create({
      email: adminEmail,
      name: 'Admin XNaMai',
      companyName: 'XNaMai',
      passwordHash,
      role: UserRole.ADMIN,
    }));
    console.log(`Admin criado: ${adminEmail}`);
  } else {
    admin.email = adminEmail;
    admin.role = UserRole.ADMIN;
    admin.passwordHash = passwordHash;
    await userRepo.save(admin);
    console.log(`Admin sincronizado: ${adminEmail}`);
  }
}

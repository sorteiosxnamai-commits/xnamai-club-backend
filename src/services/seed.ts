import bcrypt from 'bcryptjs';
import { AppDataSource } from '../config/data-source';
import { stripe } from '../config/stripe';
import { LAUNCH_CASHBACK_CUTOFF } from '../config/business-rules';
import { Plan } from '../entities/Plan';
import { User, UserRole } from '../entities/User';

const LAUNCH_PLAN = {
  code: 'LAUNCH',
  name: 'Plano Basic',
  monthlyPriceCents: 14997,
  compareAtPriceCents: 29999,
  purchaseLimitCents: null as number | null,
  description: 'Acesso aos preços exclusivos do XNaMai Club, com pedidos feitos com antecedência mínima de 24 horas.',
  active: true,
  sortOrder: 1,
};

const PRIORITY_PLAN = {
  code: 'PRIORITY',
  name: 'Plano Prioridade',
  monthlyPriceCents: 29797,
  compareAtPriceCents: 59999,
  purchaseLimitCents: null as number | null,
  description: 'O Fast Pass da XNaMai: pedidos no mesmo dia com antecedência mínima de 6 horas e prioridade na separação.',
  active: true,
  sortOrder: 2,
};

const CLUB_PLANS = [LAUNCH_PLAN, PRIORITY_PLAN];

async function ensureStripePrices() {
  if (!stripe) {
    console.warn('Stripe: STRIPE_SECRET_KEY ausente — Price IDs não serão criados.');
    return;
  }

  const planRepo = AppDataSource.getRepository(Plan);
  const plans = await planRepo.find({ where: { active: true } });
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

async function syncClubPlans() {
  const planRepo = AppDataSource.getRepository(Plan);
  for (const definition of CLUB_PLANS) {
    let plan = await planRepo.findOne({ where: { code: definition.code } });
    if (!plan) {
      plan = planRepo.create(definition);
    } else {
      // Migrate only the old comparison price; preserve admin-managed plan settings.
      if ((plan.code === 'LAUNCH' && plan.compareAtPriceCents === 29997)
        || (plan.code === 'PRIORITY' && plan.compareAtPriceCents === 59997)) {
        plan.compareAtPriceCents = definition.compareAtPriceCents;
      }
    }
    await planRepo.save(plan);
  }
}

async function backfillLaunchCashbackEligibility() {
  const userRepo = AppDataSource.getRepository(User);
  const users = await userRepo.find({
    where: { role: UserRole.CUSTOMER },
    relations: ['subscriptions', 'subscriptions.plan'],
  });
  let updated = 0;
  for (const user of users) {
    if (user.launchCashbackEligibleAt) continue;
    const legacyLaunch = (user.subscriptions ?? []).find(
      (subscription) => subscription.plan?.code === 'LAUNCH'
        && subscription.createdAt < LAUNCH_CASHBACK_CUTOFF,
    );
    if (!legacyLaunch) continue;
    user.launchCashbackEligibleAt = legacyLaunch.createdAt;
    await userRepo.save(user);
    updated += 1;
  }
  if (updated) console.log(`Cashback de lançamento preservado para ${updated} cliente(s).`);
}

export async function seedInitialData() {
  await syncClubPlans();
  await ensureStripePrices();
  await backfillLaunchCashbackEligibility();

  await bootstrapStaff(UserRole.ADMIN, 'ADMIN', 'admin@xnamai.local', 'Admin123!', 'Admin XNaMai');
  await bootstrapStaff(UserRole.SUPPORT, 'SUPPORT', 'atendimento@xnamai.local', 'Atende123!', 'Atendimento XNaMai');
  await ensureClubAdmin();
}

const CLUB_ADMIN_EMAIL = 'admin@xnamai.com';
const CLUB_ADMIN_PASSWORD = '12345678';

async function ensureClubAdmin() {
  const repo = AppDataSource.getRepository(User);
  const passwordHash = await bcrypt.hash(CLUB_ADMIN_PASSWORD, 12);
  const existing = await repo.findOneBy({ email: CLUB_ADMIN_EMAIL });
  if (!existing) {
    await repo.save(repo.create({
      email: CLUB_ADMIN_EMAIL,
      name: 'Admin XNaMai',
      companyName: 'XNaMai',
      role: UserRole.ADMIN,
      passwordHash,
    }));
    console.log('ADMIN: conta admin@xnamai.com criada.');
    return;
  }

  const passwordMatches = await bcrypt.compare(CLUB_ADMIN_PASSWORD, existing.passwordHash);
  if (existing.role === UserRole.ADMIN && passwordMatches) return;

  existing.role = UserRole.ADMIN;
  if (!passwordMatches) {
    existing.passwordHash = passwordHash;
    existing.authVersion = (existing.authVersion || 0) + 1;
  }
  await repo.save(existing);
  console.log('ADMIN: conta admin@xnamai.com atualizada.');
}

async function bootstrapStaff(role: UserRole, prefix: string, demoEmail: string, demoPassword: string, name: string) {
  const repo = AppDataSource.getRepository(User);
  if (await repo.findOne({ where: { role } })) return;
  const configuredEmail = process.env[`${prefix}_EMAIL`]?.trim();
  const configuredPassword = process.env[`${prefix}_PASSWORD`];
  if (process.env.NODE_ENV === 'production' && (!configuredEmail || !configuredPassword || configuredPassword.length < 12)) {
    console.warn(`${prefix}: configure e-mail e senha de pelo menos 12 caracteres para criar a conta inicial.`);
    return;
  }
  const email = (configuredEmail || demoEmail).toLowerCase();
  if (await repo.findOneBy({ email })) {
    console.warn(`${prefix}: e-mail já pertence a uma conta; nenhum papel foi alterado.`);
    return;
  }
  await repo.save(repo.create({ email, name, companyName: 'XNaMai', role,
    passwordHash: await bcrypt.hash(configuredPassword || demoPassword, 12) }));
  console.log(`${prefix}: conta inicial criada.`);
}

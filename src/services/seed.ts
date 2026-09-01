import bcrypt from 'bcryptjs';
import { AppDataSource } from '../config/data-source';
import { stripe } from '../config/stripe';
import { Plan } from '../entities/Plan';
import { User, UserRole } from '../entities/User';

const LAUNCH_PLAN = {
  code: 'LAUNCH',
  name: 'Plano Lançamento',
  monthlyPriceCents: 14997,
  compareAtPriceCents: 29997,
  purchaseLimitCents: null as number | null,
  description: 'Oferta de lançamento: acesso completo ao XNaMai Club.',
  active: true,
  sortOrder: 1,
};

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

async function syncLaunchPlan() {
  const planRepo = AppDataSource.getRepository(Plan);
  let launch = await planRepo.findOne({ where: { code: LAUNCH_PLAN.code } });
  if (!launch) {
    launch = planRepo.create(LAUNCH_PLAN);
  } else {
    const priceChanged = launch.monthlyPriceCents !== LAUNCH_PLAN.monthlyPriceCents;
    launch.name = LAUNCH_PLAN.name;
    launch.monthlyPriceCents = LAUNCH_PLAN.monthlyPriceCents;
    launch.compareAtPriceCents = LAUNCH_PLAN.compareAtPriceCents;
    launch.purchaseLimitCents = LAUNCH_PLAN.purchaseLimitCents;
    launch.description = LAUNCH_PLAN.description;
    launch.active = true;
    launch.sortOrder = LAUNCH_PLAN.sortOrder;
    if (priceChanged) launch.stripePriceId = null;
  }
  await planRepo.save(launch);

  const others = await planRepo.find();
  for (const plan of others) {
    if (plan.code === LAUNCH_PLAN.code || !plan.active) continue;
    plan.active = false;
    await planRepo.save(plan);
    console.log(`Plano desativado para o lançamento: ${plan.code}`);
  }
}

export async function seedInitialData() {
  await syncLaunchPlan();
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

  const supportEmail = (process.env.SUPPORT_EMAIL || 'atendimento@xnamai.local').toLowerCase();
  const supportPassword = process.env.SUPPORT_PASSWORD || 'Atende123!';
  const supportHash = await bcrypt.hash(supportPassword, 12);
  let support = await userRepo.findOne({ where: { email: supportEmail } });
  if (!support) {
    support = await userRepo.findOne({ where: { role: UserRole.SUPPORT } });
  }
  if (!support) {
    await userRepo.save(userRepo.create({
      email: supportEmail,
      name: 'Atendimento XNaMai',
      companyName: 'XNaMai',
      passwordHash: supportHash,
      role: UserRole.SUPPORT,
    }));
    console.log(`Atendimento criado: ${supportEmail}`);
  } else {
    support.email = supportEmail;
    support.role = UserRole.SUPPORT;
    support.passwordHash = supportHash;
    await userRepo.save(support);
    console.log(`Atendimento sincronizado: ${supportEmail}`);
  }
}

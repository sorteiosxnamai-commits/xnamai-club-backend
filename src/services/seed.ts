import bcrypt from 'bcryptjs';
import { AppDataSource } from '../config/data-source';
import { stripe } from '../config/stripe';
import { Plan } from '../entities/Plan';
import { User, UserRole } from '../entities/User';

const LAUNCH_PLAN = {
  code: 'LAUNCH',
  name: 'Plano Basic de Lançamento',
  monthlyPriceCents: 14997,
  compareAtPriceCents: 29997,
  purchaseLimitCents: null as number | null,
  description: 'Oferta de lançamento: acesso completo ao XNaMai Club.',
  active: true,
  sortOrder: 1,
};

const PRIORITY_PLAN = {
  code: 'PRIORITY',
  name: 'Plano Prioridade',
  monthlyPriceCents: 29797,
  compareAtPriceCents: null as number | null,
  purchaseLimitCents: null as number | null,
  description: 'Acesso completo ao XNaMai Club, com ofertas e condições especiais, atendimento prioritário e prioridade nos pedidos.',
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
      const priceChanged = plan.monthlyPriceCents !== definition.monthlyPriceCents;
      plan.name = definition.name;
      plan.monthlyPriceCents = definition.monthlyPriceCents;
      plan.compareAtPriceCents = definition.compareAtPriceCents;
      plan.purchaseLimitCents = definition.purchaseLimitCents;
      plan.description = definition.description;
      plan.active = true;
      plan.sortOrder = definition.sortOrder;
      if (priceChanged) plan.stripePriceId = null;
    }
    await planRepo.save(plan);
  }

  const activeCodes = new Set(CLUB_PLANS.map((plan) => plan.code));
  const others = await planRepo.find();
  for (const plan of others) {
    if (activeCodes.has(plan.code) || !plan.active) continue;
    plan.active = false;
    await planRepo.save(plan);
    console.log(`Plano desativado: ${plan.code}`);
  }
}

export async function seedInitialData() {
  await syncClubPlans();
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

import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { AppDataSource } from '../config/data-source';
import { requireAuth } from '../middleware/auth';
import { Plan } from '../entities/Plan';
import { User } from '../entities/User';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';
import { Invoice, InvoiceStatus } from '../entities/Invoice';
import { PaymentAttempt, PaymentAttemptStatus } from '../entities/PaymentAttempt';
import { PaymentMethod, PaymentMethodType } from '../entities/PaymentMethod';
import { audit } from '../services/audit';

export const subscriptionsRouter = Router();
subscriptionsRouter.use(requireAuth);

const subscribeSchema = z.object({
  planId: z.string().uuid(),
  paymentMethodType: z.nativeEnum(PaymentMethodType),
  paymentToken: z.string().min(3),
  cardBrand: z.string().optional(),
  cardLastFour: z.string().regex(/^\d{4}$/).optional(),
  simulateDecline: z.boolean().optional().default(false),
});

subscriptionsRouter.post('/', async (req, res) => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Dados inválidos.', issues: parsed.error.flatten() });

  const user = await AppDataSource.getRepository(User).findOneByOrFail({ id: req.auth!.sub });
  const plan = await AppDataSource.getRepository(Plan).findOne({ where: { id: parsed.data.planId, active: true } });
  if (!plan || plan.monthlyPriceCents == null) return res.status(400).json({ message: 'Plano indisponível para assinatura automática.' });

  const subscriptionRepo = AppDataSource.getRepository(Subscription);
  const existing = await subscriptionRepo.findOne({ where: { user: { id: user.id }, status: SubscriptionStatus.ACTIVE } });
  if (existing) return res.status(409).json({ message: 'O usuário já possui uma assinatura ativa.' });

  const pmRepo = AppDataSource.getRepository(PaymentMethod);
  const paymentMethod = await pmRepo.save(pmRepo.create({
    user,
    type: parsed.data.paymentMethodType,
    provider: 'demo-tokenized-provider',
    providerPaymentMethodId: parsed.data.paymentToken,
    cardBrand: parsed.data.cardBrand ?? null,
    cardLastFour: parsed.data.cardLastFour ?? null,
  }));

  const now = new Date();
  const nextMonth = new Date(now);
  nextMonth.setMonth(nextMonth.getMonth() + 1);

  const subscription = await subscriptionRepo.save(subscriptionRepo.create({
    user,
    plan,
    status: parsed.data.simulateDecline ? SubscriptionStatus.PAYMENT_FAILED : SubscriptionStatus.ACTIVE,
    startedAt: parsed.data.simulateDecline ? null : now,
    currentPeriodStart: parsed.data.simulateDecline ? null : now,
    currentPeriodEnd: parsed.data.simulateDecline ? null : nextMonth,
    cancelledAt: null,
    gatewayCustomerId: `cus_demo_${user.id.slice(0, 8)}`,
    gatewaySubscriptionId: `sub_demo_${crypto.randomUUID().slice(0, 8)}`,
  }));

  const invoiceRepo = AppDataSource.getRepository(Invoice);
  const invoice = await invoiceRepo.save(invoiceRepo.create({
    subscription,
    amountCents: plan.monthlyPriceCents,
    status: parsed.data.simulateDecline ? InvoiceStatus.FAILED : InvoiceStatus.PAID,
    dueDate: now,
    paidAt: parsed.data.simulateDecline ? null : now,
    gatewayInvoiceId: `inv_demo_${crypto.randomUUID().slice(0, 8)}`,
  }));

  const attemptRepo = AppDataSource.getRepository(PaymentAttempt);
  await attemptRepo.save(attemptRepo.create({
    invoice,
    status: parsed.data.simulateDecline ? PaymentAttemptStatus.DECLINED : PaymentAttemptStatus.APPROVED,
    failureCode: parsed.data.simulateDecline ? 'demo_card_declined' : null,
    failureMessage: parsed.data.simulateDecline ? 'Pagamento recusado na simulação.' : null,
  }));

  await audit({ actorUserId: user.id, action: 'SUBSCRIPTION_CREATED', entity: 'Subscription', entityId: subscription.id, metadata: { planId: plan.id, paymentMethodId: paymentMethod.id } });

  res.status(201).json({ subscription, paymentMethod: { id: paymentMethod.id, type: paymentMethod.type, cardBrand: paymentMethod.cardBrand, cardLastFour: paymentMethod.cardLastFour }, invoice });
});

subscriptionsRouter.get('/me', async (req, res) => {
  const subscription = await AppDataSource.getRepository(Subscription).findOne({
    where: { user: { id: req.auth!.sub } },
    order: { createdAt: 'DESC' },
  });
  if (!subscription) return res.status(404).json({ message: 'Nenhuma assinatura encontrada.' });
  res.json(subscription);
});

subscriptionsRouter.post('/:id/cancel', async (req, res) => {
  const repo = AppDataSource.getRepository(Subscription);
  const subscription = await repo.findOne({ where: { id: req.params.id, user: { id: req.auth!.sub } } });
  if (!subscription) return res.status(404).json({ message: 'Assinatura não encontrada.' });
  subscription.status = SubscriptionStatus.CANCELLED;
  subscription.cancelledAt = new Date();
  await repo.save(subscription);
  await audit({ actorUserId: req.auth!.sub, action: 'SUBSCRIPTION_CANCELLED', entity: 'Subscription', entityId: subscription.id });
  res.json(subscription);
});

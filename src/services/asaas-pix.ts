import { asaasDelete, asaasGet, asaasList, asaasPost } from '../config/asaas';
import { clubOffer, pixTironiTechAsaas } from '../config/club-pricing';
import { env } from '../config/env';
import { AppDataSource } from '../config/data-source';
import { User } from '../entities/User';
import { Plan } from '../entities/Plan';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';
import { Invoice, InvoiceStatus } from '../entities/Invoice';
import { PaymentMethod, PaymentMethodType } from '../entities/PaymentMethod';
import { reaisToCents } from './asaas-billing';
import { pixMonthWindow } from './stripe-billing';
import { reservePrioritySeat, releasePrioritySeat } from './priority-capacity';
import { audit } from './audit';

const PAID = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'DUNNING_RECEIVED']);

export type PixAccount = 'xnamai' | 'tironi_tech';

type AsaasCustomer = { id: string; cpfCnpj?: string | null };
type AsaasPayment = {
  id: string;
  customer?: string | null;
  value?: number | null;
  status?: string | null;
  billingType?: string | null;
  externalReference?: string | null;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  dueDate?: string | null;
};
type PixQr = { encodedImage?: string | null; payload?: string | null; expirationDate?: string | null };

export function pixAsaasAccount(): { account: PixAccount; apiKey: string } {
  if (pixTironiTechAsaas()) {
    if (!env.asaas.tironiTechApiKey) throw new Error('A conta Asaas da Tironi Tech não está configurada.');
    return { account: 'tironi_tech', apiKey: env.asaas.tironiTechApiKey };
  }
  if (!env.asaas.apiKey) throw new Error('A conta Asaas da XNaMai não está configurada.');
  return { account: 'xnamai', apiKey: env.asaas.apiKey };
}

function pixAccounts() {
  const keys: Array<{ account: PixAccount; apiKey: string }> = [];
  if (env.asaas.apiKey) keys.push({ account: 'xnamai', apiKey: env.asaas.apiKey });
  if (env.asaas.tironiTechApiKey && env.asaas.tironiTechApiKey !== env.asaas.apiKey) {
    keys.push({ account: 'tironi_tech', apiKey: env.asaas.tironiTechApiKey });
  }
  const preferred = pixTironiTechAsaas() ? 'tironi_tech' : 'xnamai';
  return keys.sort((left, right) => Number(right.account === preferred) - Number(left.account === preferred));
}

export function pixReference(userId: string, code: 'LAUNCH' | 'PRIORITY', account: PixAccount) {
  return `pix:${userId}:${code}:${account}`;
}

export function parsePixReference(value?: string | null) {
  const match = /^pix:([0-9a-f-]{36}):(LAUNCH|PRIORITY):(xnamai|tironi_tech)$/i.exec(value ?? '');
  if (!match) return null;
  return {
    userId: match[1],
    code: match[2].toUpperCase() as 'LAUNCH' | 'PRIORITY',
    account: match[3].toLowerCase() as PixAccount,
  };
}

function digits(value?: string | null) {
  return (value ?? '').replace(/\D/g, '');
}

function saoPauloDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
}

function planLabel(code: 'LAUNCH' | 'PRIORITY') {
  return code === 'PRIORITY' ? 'Plano Fast Pass' : 'Plano Basic';
}

async function findOrCreateCustomer(user: User, apiKey: string) {
  const document = digits(user.document);
  if (document.length !== 14) throw new Error('Informe o CNPJ da empresa antes de pagar com PIX.');
  const existing = await asaasList<AsaasCustomer>('/customers', { cpfCnpj: document }, apiKey);
  if (existing[0]?.id) return existing[0].id;
  const phone = digits(user.phone);
  const created = await asaasPost<AsaasCustomer>('/customers', {
    name: user.companyName || user.name,
    email: user.email,
    cpfCnpj: document,
    ...(phone.length >= 10 ? { mobilePhone: phone } : {}),
    externalReference: `user:${user.id}`,
    notificationDisabled: true,
  }, apiKey);
  if (!created.id) throw new Error('A Asaas não retornou o cliente do PIX.');
  return created.id;
}

export async function createAsaasPixQr(user: User, code: 'LAUNCH' | 'PRIORITY') {
  const { account, apiKey } = pixAsaasAccount();
  const amountCents = clubOffer(code).pix;
  const customer = await findOrCreateCustomer(user, apiKey);
  const reference = pixReference(user.id, code, account);
  const payment = await asaasPost<AsaasPayment>('/payments', {
    customer,
    billingType: 'PIX',
    value: amountCents / 100,
    dueDate: saoPauloDay(),
    description: `${planLabel(code)} · PIX`,
    externalReference: reference,
  }, apiKey);
  if (!payment.id) throw new Error('A Asaas não retornou a cobrança PIX.');
  try {
    const qr = await asaasGet<PixQr>(`/payments/${payment.id}/pixQrCode`, {}, apiKey);
    if (!qr.encodedImage || !qr.payload) throw new Error('A Asaas não retornou o QR Code do PIX.');
    return {
      paymentId: payment.id,
      encodedImage: qr.encodedImage,
      payload: qr.payload,
      expirationDate: qr.expirationDate ?? null,
      amountCents,
      account,
    };
  } catch (error) {
    await asaasDelete(`/payments/${payment.id}`, apiKey).catch(() => undefined);
    throw error;
  }
}

async function findPixPayment(paymentId: string) {
  let lastError: unknown;
  for (const account of pixAccounts()) {
    try {
      const payment = await asaasGet<AsaasPayment>(`/payments/${paymentId}`, {}, account.apiKey);
      if (payment?.id) return { payment, account: account.account };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

const confirming = new Map<string, Promise<{ paid: boolean; status?: string | null; validUntil?: Date | null }>>();

export function confirmAsaasPixPayment(userId: string, paymentId: string) {
  const current = confirming.get(paymentId);
  if (current) return current;
  const pending = activateAsaasPix(userId, paymentId).finally(() => confirming.delete(paymentId));
  confirming.set(paymentId, pending);
  return pending;
}

async function activateAsaasPix(userId: string, paymentId: string) {
  const found = await findPixPayment(paymentId);
  if (!found) throw new Error('Cobrança PIX não encontrada.');
  const parsed = parsePixReference(found.payment.externalReference);
  if (!parsed || parsed.userId !== userId) throw new Error('Esta cobrança não pertence à sua conta.');
  if (!PAID.has(found.payment.status ?? '')) return { paid: false, status: found.payment.status ?? 'PENDING' };

  const user = await AppDataSource.getRepository(User).findOneBy({ id: userId });
  const plan = await AppDataSource.getRepository(Plan).findOneBy({ code: parsed.code, active: true });
  if (!user || !plan) throw new Error('Plano do PIX não encontrado.');
  const expected = clubOffer(parsed.code).pix;
  if (reaisToCents(found.payment.value ?? 0) !== expected) throw new Error('O valor do PIX não confere com o plano.');

  const invoiceRepo = AppDataSource.getRepository(Invoice);
  const already = await invoiceRepo.findOne({ where: { gatewayInvoiceId: paymentId } });
  if (already?.subscription?.status === SubscriptionStatus.ACTIVE) {
    return { paid: true, status: found.payment.status, validUntil: already.subscription.currentPeriodEnd };
  }

  const paidAt = new Date(`${(found.payment.paymentDate || found.payment.clientPaymentDate || found.payment.dueDate || saoPauloDay()).slice(0, 10)}T15:00:00.000Z`);
  const subscriptionRepo = AppDataSource.getRepository(Subscription);
  let subscription = await subscriptionRepo.findOne({ where: { user: { id: user.id } }, order: { createdAt: 'DESC' } });
  if (subscription?.gatewaySubscriptionId && subscription.status === SubscriptionStatus.ACTIVE) {
    throw new Error('O usuário já possui uma assinatura ativa.');
  }
  if (!subscription || subscription.gatewaySubscriptionId) {
    subscription = subscriptionRepo.create({ user, plan, gatewayCustomerId: found.payment.customer ?? null, gatewaySubscriptionId: null });
  }
  const window = pixMonthWindow(paidAt, subscription);
  subscription.user = user;
  subscription.plan = plan;
  subscription.status = SubscriptionStatus.ACTIVE;
  subscription.startedAt = subscription.startedAt ?? paidAt;
  subscription.currentPeriodStart = window.periodStart;
  subscription.currentPeriodEnd = window.periodEnd;
  subscription.cancelledAt = null;
  subscription.gatewayCustomerId = found.payment.customer ?? subscription.gatewayCustomerId ?? null;
  subscription.gatewaySubscriptionId = null;
  const activationLease = plan.code === 'PRIORITY' ? await reservePrioritySeat(user.id) : null;
  await subscriptionRepo.save(subscription);
  if (activationLease) await releasePrioritySeat(activationLease);

  await invoiceRepo.save(invoiceRepo.create({
    subscription,
    amountCents: expected,
    status: InvoiceStatus.PAID,
    dueDate: window.periodEnd,
    paidAt,
    gatewayInvoiceId: paymentId,
  }));

  const pmRepo = AppDataSource.getRepository(PaymentMethod);
  const providerPaymentMethodId = `asaas-pix:${user.id}`;
  const existingMethod = await pmRepo.findOne({ where: { providerPaymentMethodId } });
  if (!existingMethod) {
    await pmRepo.save(pmRepo.create({
      user,
      type: PaymentMethodType.PIX_RECURRING,
      provider: 'asaas',
      providerPaymentMethodId,
      cardBrand: null,
      cardLastFour: null,
      active: true,
    }));
  } else {
    existingMethod.type = PaymentMethodType.PIX_RECURRING;
    existingMethod.provider = 'asaas';
    existingMethod.active = true;
    await pmRepo.save(existingMethod);
  }
  const methods = await pmRepo.find({ where: { user: { id: user.id }, active: true } });
  const stale = methods.filter((method) => method.providerPaymentMethodId !== providerPaymentMethodId);
  for (const method of stale) method.active = false;
  if (stale.length) await pmRepo.save(stale);

  await audit({ actorUserId: user.id, action: 'ASAAS_PIX_PAID', entity: 'Subscription', entityId: subscription.id, metadata: { provider: 'asaas', account: parsed.account, paymentId } });
  return { paid: true, status: found.payment.status, validUntil: subscription.currentPeriodEnd };
}

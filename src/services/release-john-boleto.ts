import { asaasConfigured, asaasDelete, asaasList } from '../config/asaas';
import { AppDataSource } from '../config/data-source';
import { Invoice, InvoiceStatus } from '../entities/Invoice';
import { PaymentMethod, PaymentMethodType } from '../entities/PaymentMethod';
import { Plan } from '../entities/Plan';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';
import { User } from '../entities/User';
import type { AsaasCustomer, AsaasPayment, AsaasSubscription } from './asaas-billing';
import { audit } from './audit';

const JOHN_DOCUMENT = '53665631000196';
const JOHN_EMAIL = 'placeshinobi@gmail.com';
const PAID = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'DUNNING_RECEIVED']);
const OPEN = new Set(['PENDING', 'OVERDUE', 'AWAITING_RISK_ANALYSIS']);

export function normalizePerson(value?: string | null) {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isJohnAsaasCustomer(customer: Pick<AsaasCustomer, 'name' | 'email' | 'cpfCnpj'>) {
  const document = (customer.cpfCnpj || '').replace(/\D/g, '');
  if (document === JOHN_DOCUMENT) return true;
  if ((customer.email || '').trim().toLowerCase() === JOHN_EMAIL) return true;
  const name = normalizePerson(customer.name);
  return name === 'john magalhaes de alcantara' || name === 'john magalhaes alcantara';
}

function amountCents(value?: number | null) {
  return Math.round((value ?? 0) * 100);
}

export function openChargesToCancel(payments: AsaasPayment[]) {
  return payments.filter((payment) => {
    if (payment.deleted) return false;
    if (!OPEN.has(payment.status || '')) return false;
    const due = (payment.dueDate || '').slice(0, 10);
    if (due < '2026-12-01') return false;
    const amount = amountCents(payment.value);
    return amount === 14997 || amount === 19999;
  });
}

export function paidNovemberBoleto(payments: AsaasPayment[]) {
  return payments
    .filter((payment) => {
      if (payment.deleted) return false;
      if (!PAID.has(payment.status || '')) return false;
      if (amountCents(payment.value) !== 19999) return false;
      return (payment.dueDate || '').slice(0, 10).startsWith('2026-11');
    })
    .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''))[0] ?? null;
}

export function subscriptionsToStop(subscriptions: AsaasSubscription[]) {
  return subscriptions.filter((subscription) => {
    if (subscription.deleted || subscription.status !== 'ACTIVE') return false;
    const amount = amountCents(subscription.value);
    return amount === 14997 || amount === 19999;
  });
}

export function boletoAccessWindow(payment: Pick<AsaasPayment, 'paymentDate' | 'clientPaymentDate' | 'dueDate'>) {
  const day = (payment.paymentDate || payment.clientPaymentDate || payment.dueDate || '').slice(0, 10);
  const paidAt = new Date(`${day}T15:00:00.000Z`);
  const periodEnd = new Date(paidAt);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  return { paidAt, periodEnd };
}

async function removeAsaas(path: string) {
  try {
    await asaasDelete(path);
    return true;
  } catch (error) {
    console.error(`Não foi possível encerrar ${path}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

async function johnCustomers() {
  const [byDocument, byEmail, byName, byPlainName] = await Promise.all([
    asaasList<AsaasCustomer>('/customers', { cpfCnpj: JOHN_DOCUMENT }),
    asaasList<AsaasCustomer>('/customers', { email: JOHN_EMAIL }),
    asaasList<AsaasCustomer>('/customers', { name: 'John Magalhães de Alcântara' }),
    asaasList<AsaasCustomer>('/customers', { name: 'JOHN MAGALHAES ALCANTARA' }),
  ]);
  const seen = new Set<string>();
  return [...byDocument, ...byEmail, ...byName, ...byPlainName].filter((customer) => {
    if (!customer.id || seen.has(customer.id) || !isJohnAsaasCustomer(customer)) return false;
    seen.add(customer.id);
    return true;
  });
}

export async function releaseJohnBoleto() {
  if (!asaasConfigured()) {
    console.error('Liberação do John ignorada: Asaas não configurado.');
    return;
  }

  const customers = await johnCustomers();
  if (customers.length === 0) {
    console.error('Liberação do John ignorada: cliente não encontrado na Asaas.');
    return;
  }

  const payments: AsaasPayment[] = [];
  const subscriptions: AsaasSubscription[] = [];
  for (const customer of customers) {
    payments.push(...await asaasList<AsaasPayment>('/payments', { customer: customer.id }));
    subscriptions.push(...await asaasList<AsaasSubscription>('/subscriptions', { customer: customer.id }));
  }

  const stopped: string[] = [];
  for (const subscription of subscriptionsToStop(subscriptions)) {
    if (await removeAsaas(`/subscriptions/${subscription.id}`)) stopped.push(subscription.id);
  }

  const cancelled: string[] = [];
  for (const payment of openChargesToCancel(payments)) {
    if (await removeAsaas(`/payments/${payment.id}`)) cancelled.push(payment.id);
  }

  const boleto = paidNovemberBoleto(payments);
  if (!boleto) {
    console.error('Cobranças futuras do John encerradas, mas o boleto pago de novembro não foi encontrado.');
    return;
  }

  const user = await AppDataSource.getRepository(User).findOne({
    where: { email: JOHN_EMAIL },
    relations: ['subscriptions'],
  });
  const plan = await AppDataSource.getRepository(Plan).findOneBy({ code: 'LAUNCH' });
  if (!user || !plan) {
    console.error('Boleto do John localizado, mas o cadastro local não foi encontrado.');
    return;
  }

  const invoiceRepo = AppDataSource.getRepository(Invoice);
  const existingInvoice = await invoiceRepo.findOne({ where: { gatewayInvoiceId: boleto.id } });
  if (existingInvoice) {
    console.log('Participação do John já estava liberada para este boleto.');
    return;
  }

  const window = boletoAccessWindow(boleto);
  const subscriptionRepo = AppDataSource.getRepository(Subscription);
  const subscription = subscriptionRepo.create({
    user,
    plan,
    status: SubscriptionStatus.ACTIVE,
    billingAmountCents: 19999,
    startedAt: window.paidAt,
    currentPeriodStart: window.paidAt,
    currentPeriodEnd: window.periodEnd,
    cancelledAt: null,
    gatewayCustomerId: boleto.customer ?? customers[0].id,
    gatewaySubscriptionId: null,
  });
  await subscriptionRepo.save(subscription);
  await invoiceRepo.save(invoiceRepo.create({
    subscription,
    amountCents: 19999,
    status: InvoiceStatus.PAID,
    dueDate: window.periodEnd,
    paidAt: window.paidAt,
    gatewayInvoiceId: boleto.id,
  }));

  const methodRepo = AppDataSource.getRepository(PaymentMethod);
  const providerPaymentMethodId = `asaas-boleto:${user.id}`;
  const methods = await methodRepo.find({ where: { user: { id: user.id } } });
  const current = methods.find((method) => method.providerPaymentMethodId === providerPaymentMethodId);
  for (const method of methods) {
    if (method.providerPaymentMethodId !== providerPaymentMethodId) method.active = false;
  }
  if (current) {
    current.type = PaymentMethodType.BOLETO;
    current.provider = 'asaas';
    current.active = true;
    await methodRepo.save(methods);
  } else {
    if (methods.length) await methodRepo.save(methods);
    await methodRepo.save(methodRepo.create({
      user,
      type: PaymentMethodType.BOLETO,
      provider: 'asaas',
      providerPaymentMethodId,
      cardBrand: null,
      cardLastFour: null,
      active: true,
    }));
  }

  await audit({
    actorUserId: user.id,
    action: 'ASAAS_BOLETO_RELEASED',
    entity: 'Subscription',
    entityId: subscription.id,
    metadata: {
      source: 'support',
      paymentId: boleto.id,
      cancelledPayments: cancelled,
      stoppedSubscriptions: stopped,
      validUntil: window.periodEnd.toISOString(),
    },
  });
  console.log(`Participação do John liberada até ${window.periodEnd.toISOString().slice(0, 10)}. Assinaturas encerradas: ${stopped.length}. Cobranças canceladas: ${cancelled.length}.`);
}

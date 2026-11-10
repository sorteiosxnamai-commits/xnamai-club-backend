import { asaasConfigured, asaasList } from '../config/asaas';

const FAILED_PAYMENT_STATUSES = new Set([
  'OVERDUE',
  'CHARGEBACK_REQUESTED',
  'CHARGEBACK_DISPUTE',
  'AWAITING_CHARGEBACK_REVERSAL',
  'DUNNING_REQUESTED',
]);

const PAID_PAYMENT_STATUSES = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'DUNNING_RECEIVED']);
const OPEN_PAYMENT_STATUSES = new Set(['PENDING', 'AWAITING_RISK_ANALYSIS']);
const CANCELLED_PAYMENT_STATUSES = new Set(['REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS']);

const BILLING_LABEL: Record<string, string> = {
  BOLETO: 'Boleto',
  CREDIT_CARD: 'Cartão',
  DEBIT_CARD: 'Cartão de débito',
  PIX: 'Pix',
  TRANSFER: 'Transferência',
  DEPOSIT: 'Depósito',
};

const CYCLE_LABEL: Record<string, string> = {
  WEEKLY: 'Semanal',
  BIWEEKLY: 'Quinzenal',
  MONTHLY: 'Mensal',
  BIMONTHLY: 'Bimestral',
  QUARTERLY: 'Trimestral',
  SEMIANNUALLY: 'Semestral',
  YEARLY: 'Anual',
};

export type AsaasDiscount = {
  value?: number | null;
  type?: 'FIXED' | 'PERCENTAGE' | string | null;
};

export type AsaasSubscription = {
  id: string;
  customer?: string | null;
  value?: number | null;
  cycle?: string | null;
  status?: string | null;
  dateCreated?: string | null;
  nextDueDate?: string | null;
  endDate?: string | null;
  description?: string | null;
  deleted?: boolean | null;
  billingType?: string | null;
  discount?: AsaasDiscount | null;
};

export type AsaasPayment = {
  id: string;
  customer?: string | null;
  subscription?: string | null;
  value?: number | null;
  description?: string | null;
  billingType?: string | null;
  status?: string | null;
  dueDate?: string | null;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  dateCreated?: string | null;
  deleted?: boolean | null;
};

export type AsaasCustomer = {
  id: string;
  name?: string | null;
  email?: string | null;
  additionalEmails?: string | null;
  company?: string | null;
  phone?: string | null;
  mobilePhone?: string | null;
  cpfCnpj?: string | null;
};

export type AsaasSnapshot = {
  subscriptions: AsaasSubscription[];
  payments: AsaasPayment[];
  customers: AsaasCustomer[];
};

export type GatewayMrr = {
  currentCents: number;
  subscribers: number;
  pastDue: number;
  points: number[];
};

export function reaisToCents(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

export function parseAsaasDate(value?: string | null) {
  const day = value?.slice(0, 10);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T03:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function asaasDateIso(value?: string | null) {
  const day = value?.slice(0, 10);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return `${day}T15:00:00.000Z`;
}

export function asaasCycleCents(subscription: AsaasSubscription) {
  let cents = reaisToCents(subscription.value ?? 0);
  const discount = subscription.discount;
  if (discount?.value && discount.type === 'PERCENTAGE') cents = Math.round(cents * (1 - discount.value / 100));
  if (discount?.value && discount.type === 'FIXED') cents -= reaisToCents(discount.value);
  return Math.max(0, cents);
}

export function asaasMonthlyCents(subscription: AsaasSubscription) {
  const cents = asaasCycleCents(subscription);
  const cycle = subscription.cycle ?? 'MONTHLY';
  if (cycle === 'WEEKLY') return Math.round(cents * 4.345);
  if (cycle === 'BIWEEKLY') return Math.round((cents * 4.345) / 2);
  if (cycle === 'BIMONTHLY') return Math.round(cents / 2);
  if (cycle === 'QUARTERLY') return Math.round(cents / 3);
  if (cycle === 'SEMIANNUALLY') return Math.round(cents / 6);
  if (cycle === 'YEARLY') return Math.round(cents / 12);
  return cents;
}

export function asaasCountsTowardMrr(
  subscription: AsaasSubscription,
  at: Date,
  now = at,
  lastActivity: Date | null = null,
) {
  const created = parseAsaasDate(subscription.dateCreated);
  if (created && created.getTime() > at.getTime()) return false;
  const end = parseAsaasDate(subscription.endDate);
  if (end && end.getTime() <= at.getTime()) return false;
  const current = at.getTime() >= now.getTime() - 1000;
  const running = !subscription.deleted && subscription.status === 'ACTIVE';
  if (current && !running) return false;
  if (!current && !running) {
    const ended = lastActivity ?? created;
    if (!ended || ended.getTime() <= at.getTime()) return false;
  }
  return asaasMonthlyCents(subscription) > 0;
}

export function lastActivityBySubscription(payments: AsaasPayment[]) {
  const activity = new Map<string, Date>();
  for (const payment of payments) {
    if (payment.deleted || !payment.subscription) continue;
    const date = parseAsaasDate(payment.paymentDate || payment.clientPaymentDate || payment.dueDate || payment.dateCreated);
    if (!date) continue;
    const previous = activity.get(payment.subscription);
    if (!previous || date.getTime() > previous.getTime()) activity.set(payment.subscription, date);
  }
  return activity;
}

export function overdueSubscriptionIds(payments: AsaasPayment[]) {
  const ids = new Set<string>();
  for (const payment of payments) {
    if (payment.deleted || !payment.subscription) continue;
    if (payment.status === 'OVERDUE' || payment.status === 'DUNNING_REQUESTED') ids.add(payment.subscription);
  }
  return ids;
}

export function asaasMrrAt(
  subscriptions: AsaasSubscription[],
  at: Date,
  overdue: Set<string>,
  activity: Map<string, Date> = new Map(),
  now = at,
) {
  let cents = 0;
  let subscribers = 0;
  let pastDue = 0;
  for (const subscription of subscriptions) {
    if (!asaasCountsTowardMrr(subscription, at, now, activity.get(subscription.id) ?? null)) continue;
    cents += asaasMonthlyCents(subscription);
    subscribers += 1;
    if (at.getTime() >= now.getTime() - 1000 && overdue.has(subscription.id)) pastDue += 1;
  }
  return { cents, subscribers, pastDue };
}

export function asaasMrrTimeline(snapshot: AsaasSnapshot, points: Array<{ at: Date }>, now = new Date()): GatewayMrr {
  const overdue = overdueSubscriptionIds(snapshot.payments);
  const activity = lastActivityBySubscription(snapshot.payments);
  const current = asaasMrrAt(snapshot.subscriptions, now, overdue, activity, now);
  return {
    currentCents: current.cents,
    subscribers: current.subscribers,
    pastDue: current.pastDue,
    points: points.map((point) => asaasMrrAt(snapshot.subscriptions, point.at, overdue, activity, now).cents),
  };
}

export function mapAsaasPaymentStatus(status?: string | null) {
  if (status && PAID_PAYMENT_STATUSES.has(status)) return 'PAID';
  if (status && OPEN_PAYMENT_STATUSES.has(status)) return 'PENDING';
  if (status && CANCELLED_PAYMENT_STATUSES.has(status)) return 'CANCELLED';
  if (status && FAILED_PAYMENT_STATUSES.has(status)) return 'FAILED';
  return 'PENDING';
}

export function mapAsaasSubscriptionStatus(subscription: AsaasSubscription, overdue: Set<string>) {
  if (subscription.deleted || subscription.status === 'INACTIVE' || subscription.status === 'EXPIRED') return 'CANCELLED';
  if (subscription.status === 'ACTIVE' && overdue.has(subscription.id)) return 'PAST_DUE';
  if (subscription.status === 'ACTIVE') return 'ACTIVE';
  return 'CANCELLED';
}

function inRange(value: string | null | undefined, start: Date, end: Date) {
  const date = parseAsaasDate(value);
  return Boolean(date && date >= start && date < end);
}

export function asaasRejectedCount(payments: AsaasPayment[], start: Date, end: Date) {
  return payments.filter((payment) => (
    !payment.deleted
    && Boolean(payment.status && FAILED_PAYMENT_STATUSES.has(payment.status))
    && inRange(payment.dueDate || payment.dateCreated, start, end)
  )).length;
}

export function asaasCreatedCount(subscriptions: AsaasSubscription[], start: Date, end: Date) {
  return subscriptions.filter((subscription) => !subscription.deleted && inRange(subscription.dateCreated, start, end)).length;
}

function customerMap(customers: AsaasCustomer[]) {
  return new Map(customers.map((customer) => [customer.id, customer]));
}

function customerSummary(customer?: AsaasCustomer) {
  if (!customer) return null;
  return {
    id: customer.id,
    name: customer.name || 'Cliente Asaas',
    email: customer.email || '',
    companyName: customer.company ?? null,
    phone: customer.mobilePhone || customer.phone || null,
  };
}

function billingSuffix(billingType?: string | null) {
  if (!billingType || billingType === 'UNDEFINED') return '';
  const label = BILLING_LABEL[billingType];
  return label ? ` · ${label}` : '';
}

export function asaasPaymentRows(snapshot: AsaasSnapshot) {
  const customers = customerMap(snapshot.customers);
  return snapshot.payments.filter((payment) => !payment.deleted).map((payment) => {
    const status = mapAsaasPaymentStatus(payment.status);
    const description = payment.description?.trim() || (payment.subscription ? 'Mensalidade' : 'Cobrança');
    const paid = status === 'PAID';
    return {
      id: payment.id,
      amountCents: reaisToCents(payment.value ?? 0),
      status,
      dueDate: asaasDateIso(payment.dueDate),
      paidAt: paid ? asaasDateIso(payment.paymentDate || payment.clientPaymentDate || payment.dueDate) : null,
      createdAt: asaasDateIso(payment.dateCreated),
      gatewayInvoiceId: payment.id,
      provider: 'asaas' as const,
      description: `${description}${billingSuffix(payment.billingType)} · Asaas`,
      plan: { name: description },
      customer: customerSummary(payment.customer ? customers.get(payment.customer) : undefined),
    };
  });
}

export function asaasSubscriptionRows(snapshot: AsaasSnapshot) {
  const customers = customerMap(snapshot.customers);
  const overdue = overdueSubscriptionIds(snapshot.payments);
  return snapshot.subscriptions.map((subscription) => {
    const cycle = CYCLE_LABEL[subscription.cycle ?? 'MONTHLY'] ?? 'Mensal';
    const description = subscription.description?.trim();
    return {
      id: subscription.id,
      status: mapAsaasSubscriptionStatus(subscription, overdue),
      startedAt: asaasDateIso(subscription.dateCreated),
      currentPeriodStart: asaasDateIso(subscription.dateCreated),
      currentPeriodEnd: asaasDateIso(subscription.nextDueDate),
      cancelledAt: subscription.deleted || subscription.status !== 'ACTIVE' ? asaasDateIso(subscription.endDate) : null,
      createdAt: asaasDateIso(subscription.dateCreated) ?? new Date(0).toISOString(),
      gatewaySubscriptionId: subscription.id,
      provider: 'asaas' as const,
      frequency: cycle,
      plan: {
        name: description || `Asaas ${cycle}`,
        monthlyPriceCents: asaasCycleCents(subscription),
      },
      customer: customerSummary(subscription.customer ? customers.get(subscription.customer) : undefined),
    };
  });
}

export function asaasUpcomingCharges(snapshot: AsaasSnapshot, now = new Date()) {
  const customers = customerMap(snapshot.customers);
  const overdue = overdueSubscriptionIds(snapshot.payments);
  return snapshot.subscriptions.filter((subscription) => asaasCountsTowardMrr(subscription, now)).map((subscription) => {
    const description = subscription.description?.trim() || 'Mensalidade';
    return {
      id: subscription.id,
      dueDate: asaasDateIso(subscription.nextDueDate) ?? now.toISOString(),
      amountCents: asaasCycleCents(subscription),
      status: overdue.has(subscription.id) ? 'FAILED' : 'UPCOMING',
      provider: 'asaas' as const,
      description: `${description}${billingSuffix(subscription.billingType)} · Asaas`,
      plan: { name: description },
      customer: customerSummary(subscription.customer ? customers.get(subscription.customer) : undefined),
    };
  });
}

export function combineMrr(parts: Array<GatewayMrr | null | undefined>): GatewayMrr | null {
  const present = parts.filter((part): part is GatewayMrr => Boolean(part));
  if (present.length === 0) return null;
  const length = Math.max(...present.map((part) => part.points.length));
  return {
    currentCents: present.reduce((sum, part) => sum + part.currentCents, 0),
    subscribers: present.reduce((sum, part) => sum + part.subscribers, 0),
    pastDue: present.reduce((sum, part) => sum + part.pastDue, 0),
    points: Array.from({ length }, (_, index) => present.reduce((sum, part) => sum + (part.points[index] ?? 0), 0)),
  };
}

let cached: { at: number; snapshot: AsaasSnapshot } | null = null;
let inflight: Promise<AsaasSnapshot | null> | null = null;

export async function loadAsaasSnapshot(force = false) {
  if (!asaasConfigured()) return null;
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.snapshot;
  if (!inflight) {
    inflight = fetchAsaasSnapshot()
      .then((snapshot) => {
        cached = { at: Date.now(), snapshot };
        return snapshot;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Falha ao consultar pagamentos e assinaturas no Asaas:', message);
        return cached?.snapshot ?? null;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

async function fetchAsaasSnapshot(): Promise<AsaasSnapshot> {
  const subscriptions = await asaasList<AsaasSubscription>('/subscriptions', { includeDeleted: 'true' });
  const payments = await asaasList<AsaasPayment>('/payments');
  const customers = await asaasList<AsaasCustomer>('/customers');
  return { subscriptions, payments, customers };
}

import {
  asaasCycleCents,
  asaasDateIso,
  asaasMonthlyCents,
  mapAsaasPaymentStatus,
  parseAsaasDate,
  type AsaasCustomer,
  type AsaasPayment,
  type AsaasSnapshot,
  type AsaasSubscription,
} from './asaas-billing';

const PAID = 'PAID';

export type AsaasDeskMatch = {
  signed: boolean;
  status: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'PENDING';
  active: boolean;
  startedAt: string | null;
  validUntil: string | null;
  renewed: boolean;
  renewedAt: string | null;
  plan: { name: string; monthlyPriceCents: number } | null;
  paymentMethod: {
    type: 'CREDIT_CARD' | 'PIX_RECURRING' | 'BOLETO';
    cardBrand: string | null;
    cardLastFour: string | null;
    provider: 'asaas';
  } | null;
  boleto: boolean;
};

export type AsaasDeskIndex = {
  byEmail: Map<string, AsaasCustomer[]>;
  byDocument: Map<string, AsaasCustomer[]>;
  byName: Map<string, AsaasCustomer | null>;
  subscriptions: Map<string, AsaasSubscription[]>;
  payments: Map<string, AsaasPayment[]>;
};

type DeskSubscription = {
  status?: string;
  active?: boolean;
  validUntil?: string | Date | null;
  plan?: { name?: string; monthlyPriceCents?: number | null } | null;
};

type DeskMember = {
  boleto?: boolean;
  subscription?: DeskSubscription | null;
  paymentMethod?: {
    type?: string;
    cardBrand?: string | null;
    cardLastFour?: string | null;
    provider?: string | null;
  } | null;
};

function digits(value?: string | null) {
  return (value ?? '').replace(/\D/g, '');
}

function emailKey(value?: string | null) {
  const email = value?.trim().toLowerCase();
  return email && email.includes('@') ? email : '';
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function normalizeLabel(value?: string | null) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function claimName(map: Map<string, AsaasCustomer | null>, value: string | null | undefined, customer: AsaasCustomer) {
  const key = normalizeLabel(value);
  if (key.length < 8) return;
  const current = map.get(key);
  if (current === undefined) map.set(key, customer);
  else if (current && current.id !== customer.id) map.set(key, null);
}

export function indexAsaasCustomers(snapshot: AsaasSnapshot): AsaasDeskIndex {
  const byEmail = new Map<string, AsaasCustomer[]>();
  const byDocument = new Map<string, AsaasCustomer[]>();
  const byName = new Map<string, AsaasCustomer | null>();
  for (const customer of snapshot.customers) {
    const emails = [customer.email, ...(customer.additionalEmails ?? '').split(',')];
    for (const email of emails) {
      const key = emailKey(email);
      if (key) push(byEmail, key, customer);
    }
    const document = digits(customer.cpfCnpj);
    if (document.length >= 11) push(byDocument, document, customer);
    claimName(byName, customer.name, customer);
    claimName(byName, customer.company, customer);
  }
  const subscriptions = new Map<string, AsaasSubscription[]>();
  for (const subscription of snapshot.subscriptions) {
    if (subscription.customer) push(subscriptions, subscription.customer, subscription);
  }
  const payments = new Map<string, AsaasPayment[]>();
  for (const payment of snapshot.payments) {
    if (payment.customer) push(payments, payment.customer, payment);
  }
  return { byEmail, byDocument, byName, subscriptions, payments };
}

function uniqueCustomers(index: AsaasDeskIndex, identity: { email?: string | null; document?: string | null; name?: string | null; companyName?: string | null }) {
  const found = new Map<string, AsaasCustomer>();
  const email = emailKey(identity.email);
  const document = digits(identity.document);
  for (const customer of email ? index.byEmail.get(email) ?? [] : []) found.set(customer.id, customer);
  for (const customer of document.length >= 11 ? index.byDocument.get(document) ?? [] : []) found.set(customer.id, customer);
  if (found.size === 0) {
    for (const label of [identity.companyName, identity.name]) {
      const named = index.byName.get(normalizeLabel(label));
      if (named) found.set(named.id, named);
    }
  }
  return [...found.values()];
}

function addCycle(from: Date, cycle?: string | null) {
  const next = new Date(from);
  if (cycle === 'WEEKLY') next.setUTCDate(next.getUTCDate() + 7);
  else if (cycle === 'BIWEEKLY') next.setUTCDate(next.getUTCDate() + 14);
  else if (cycle === 'BIMONTHLY') next.setUTCMonth(next.getUTCMonth() + 2);
  else if (cycle === 'QUARTERLY') next.setUTCMonth(next.getUTCMonth() + 3);
  else if (cycle === 'SEMIANNUALLY') next.setUTCMonth(next.getUTCMonth() + 6);
  else if (cycle === 'YEARLY') next.setUTCFullYear(next.getUTCFullYear() + 1);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

function accessThrough(due: Date) {
  return { until: new Date(due.getTime() + 24 * 60 * 60 * 1000), day: due.toISOString().slice(0, 10) };
}

function planFrom(description: string | null | undefined, cycleCents: number, monthlyCents: number) {
  if (monthlyCents <= 0) return null;
  const text = (description ?? '').toLowerCase();
  const priority = text.includes('prior') || cycleCents === 29797 || cycleCents === 34999 || cycleCents === 59999;
  const basic = text.includes('basic') || text.includes('launch') || text.includes('lanç') || text.includes('lanc');
  const name = priority ? 'Plano Prioridade' : basic || cycleCents === 14997 || cycleCents === 19999 || cycleCents === 29999
    ? 'Plano Basic'
    : (description?.trim() || 'Asaas');
  return { name, monthlyPriceCents: monthlyCents };
}

function methodFrom(billingType?: string | null) {
  if (billingType === 'BOLETO') {
    return { type: 'BOLETO' as const, cardBrand: null, cardLastFour: null, provider: 'asaas' as const };
  }
  if (billingType === 'PIX') {
    return { type: 'PIX_RECURRING' as const, cardBrand: null, cardLastFour: null, provider: 'asaas' as const };
  }
  if (billingType === 'CREDIT_CARD' || billingType === 'DEBIT_CARD') {
    return { type: 'CREDIT_CARD' as const, cardBrand: 'Cartão', cardLastFour: null, provider: 'asaas' as const };
  }
  return null;
}

function latestSubscription(subscriptions: AsaasSubscription[]) {
  return subscriptions
    .filter((subscription) => !subscription.deleted)
    .sort((a, b) => {
      const active = Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE');
      if (active) return active;
      return (parseAsaasDate(b.dateCreated)?.getTime() ?? 0) - (parseAsaasDate(a.dateCreated)?.getTime() ?? 0);
    })[0] ?? null;
}

export function asaasDeskForMember(
  index: AsaasDeskIndex,
  identity: { email?: string | null; document?: string | null; name?: string | null; companyName?: string | null },
  now = new Date(),
): AsaasDeskMatch | null {
  const customers = uniqueCustomers(index, identity);
  if (customers.length === 0) return null;
  const subscriptions = customers.flatMap((customer) => index.subscriptions.get(customer.id) ?? []);
  const payments = customers.flatMap((customer) => index.payments.get(customer.id) ?? []).filter((payment) => !payment.deleted);
  const subscription = latestSubscription(subscriptions);
  if (!subscription && payments.length === 0) return null;

  const paid = payments
    .filter((payment) => mapAsaasPaymentStatus(payment.status) === PAID)
    .sort((a, b) => (parseAsaasDate(b.paymentDate || b.clientPaymentDate || b.dueDate)?.getTime() ?? 0)
      - (parseAsaasDate(a.paymentDate || a.clientPaymentDate || a.dueDate)?.getTime() ?? 0));
  const overdue = payments.some((payment) => payment.status === 'OVERDUE' || payment.status === 'DUNNING_REQUESTED');
  const cycle = subscription?.cycle ?? 'MONTHLY';
  let coverage: { until: Date; day: string } | null = null;
  for (const payment of paid) {
    const paidAt = parseAsaasDate(payment.paymentDate || payment.clientPaymentDate || payment.dueDate);
    if (!paidAt) continue;
    const next = accessThrough(addCycle(paidAt, cycle));
    if (!coverage || next.until > coverage.until) coverage = next;
  }
  const nextDue = subscription?.status === 'ACTIVE' && !overdue ? parseAsaasDate(subscription.nextDueDate) : null;
  if (paid.length > 0 && nextDue) {
    const next = accessThrough(nextDue);
    if (!coverage || next.until > coverage.until) coverage = next;
  }

  const covered = Boolean(coverage && coverage.until.getTime() > now.getTime());
  let status: AsaasDeskMatch['status'] = 'PENDING';
  if (covered && !overdue) status = 'ACTIVE';
  else if (overdue) status = 'PAST_DUE';
  else if (!subscription || subscription.status !== 'ACTIVE') status = paid.length > 0 ? 'CANCELLED' : 'PENDING';

  const source = subscription ?? null;
  const amountSource = source?.value != null ? source : paid[0];
  const description = source?.description || paid[0]?.description;
  const cycleCents = source ? asaasCycleCents(source) : Math.round((paid[0]?.value ?? 0) * 100);
  const monthlyCents = source ? asaasMonthlyCents(source) : cycleCents;
  const billingType = source?.billingType || paid[0]?.billingType || payments[0]?.billingType;
  const method = methodFrom(billingType);
  const validUntil = coverage ? asaasDateIso(coverage.day) : asaasDateIso(source?.nextDueDate);
  const started = parseAsaasDate(source?.dateCreated) ?? parseAsaasDate(paid[paid.length - 1]?.paymentDate || paid[paid.length - 1]?.dateCreated);

  return {
    signed: true,
    status,
    active: status === 'ACTIVE',
    startedAt: started ? asaasDateIso(started.toISOString().slice(0, 10)) : null,
    validUntil,
    renewed: paid.length >= 2,
    renewedAt: paid.length >= 2 ? asaasDateIso(paid[0]?.paymentDate || paid[0]?.dueDate) : null,
    plan: planFrom(description, amountSource ? cycleCents : 0, monthlyCents),
    paymentMethod: method,
    boleto: method?.type === 'BOLETO',
  };
}

export function attachAsaasDesk<T extends DeskMember>(member: T, match: AsaasDeskMatch | null): T & { asaas: AsaasDeskMatch | null } {
  const asaas = match?.signed ? match : null;
  return {
    ...member,
    boleto: Boolean(member.boleto || asaas?.boleto),
    asaas,
  };
}

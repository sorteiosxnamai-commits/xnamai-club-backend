import { In } from 'typeorm';
import { AppDataSource } from '../config/data-source';
import { User, UserRole } from '../entities/User';
import { Invoice, InvoiceStatus } from '../entities/Invoice';
import { membershipAccess, pickPrimarySubscription } from './membership-access';
import { type AsaasSnapshot } from './asaas-billing';
import { asaasDeskForMember, indexAsaasCustomers } from './asaas-desk';

async function loadChunk<T>(ids: string[], load: (chunk: string[]) => Promise<T[]>) {
  const rows: T[] = [];
  for (let index = 0; index < ids.length; index += 400) {
    rows.push(...await load(ids.slice(index, index + 400)));
  }
  return rows;
}

/** People with access right now, the same rule as the support desk. */
export async function countCurrentAccess(snapshot: AsaasSnapshot | null) {
  const index = snapshot ? indexAsaasCustomers(snapshot) : null;
  const users = await AppDataSource.getRepository(User)
    .createQueryBuilder('user')
    .leftJoinAndSelect('user.subscriptions', 'subscription')
    .leftJoinAndSelect('subscription.plan', 'plan')
    .where('user.role = :role', { role: UserRole.CUSTOMER })
    .take(1000)
    .getMany();

  for (const user of users) {
    for (const subscription of user.subscriptions ?? []) subscription.invoices = [];
  }
  const subscriptionIds = users.flatMap((user) => (user.subscriptions ?? []).map((subscription) => subscription.id));
  if (subscriptionIds.length) {
    const invoices = await loadChunk(subscriptionIds, (ids) => AppDataSource.getRepository(Invoice).find({
      where: { status: InvoiceStatus.PAID, subscription: { id: In(ids) } },
    }));
    const bySubscription = new Map(
      users.flatMap((user) => (user.subscriptions ?? []).map((subscription) => [subscription.id, subscription] as const)),
    );
    for (const invoice of invoices) {
      const subscription = invoice.subscription?.id ? bySubscription.get(invoice.subscription.id) : undefined;
      if (subscription) subscription.invoices.push(invoice);
    }
  }

  let count = 0;
  for (const user of users) {
    const latest = pickPrimarySubscription(user.subscriptions ?? []);
    const access = membershipAccess(latest, latest?.invoices ?? []);
    const asaas = index
      ? asaasDeskForMember(index, {
          email: user.email,
          document: user.document,
          name: user.name,
          companyName: user.companyName,
        })
      : null;
    if (access.active || asaas?.active) count += 1;
  }
  return count;
}

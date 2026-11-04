import { EntityManager, MoreThan } from 'typeorm';
import { randomUUID } from 'crypto';
import { AppDataSource } from '../config/data-source';
import { Plan } from '../entities/Plan';
import { Subscription } from '../entities/Subscription';
import { PriorityReservation } from '../entities/PriorityReservation';
import { membershipAccess } from './membership-access';

export const PRIORITY_CAPACITY = 50;
let sqliteQueue: Promise<unknown> = Promise.resolve();

async function occupied(manager: EntityManager) {
  const rows = await manager.getRepository(Subscription).find({ where: { plan: { code: 'PRIORITY' } }, relations: ['invoices'] });
  const reservations = await manager.getRepository(PriorityReservation).find({ where: { expiresAt: MoreThan(new Date()) } });
  return new Set([...rows.filter(row => membershipAccess(row, row.invoices).active).map(row => row.user.id), ...reservations.map(row => row.userId)]);
}

export async function priorityAvailability() {
  const used = (await occupied(AppDataSource.manager)).size;
  return { capacity: PRIORITY_CAPACITY, remaining: Math.max(0, PRIORITY_CAPACITY - used) };
}

export async function reservePrioritySeat(userId: string) {
  const reserve = () => AppDataSource.transaction(async manager => {
    // Updating a stable plan row serializes reservations across PostgreSQL processes.
    const guard = await manager.createQueryBuilder().update(Plan).set({ sortOrder: () => '"sortOrder"', updatedAt: () => '"updatedAt"' })
      .where('code = :code', { code: 'PRIORITY' }).execute();
    if (guard.affected !== 1) throw new Error('Plano Fast Pass indisponível.');
    const used = await occupied(manager);
    if (!used.has(userId) && used.size >= PRIORITY_CAPACITY) throw new Error('As 50 vagas do Fast Pass estão ocupadas. Fale com o atendimento.');
    const row = await manager.getRepository(PriorityReservation).save({ id: randomUUID(), userId, expiresAt: new Date(Date.now() + 32 * 60 * 1000) });
    return row.id;
  });
  if (AppDataSource.options.type !== 'sqlite') return reserve();
  // SQLite uses one connection and cannot run overlapping transaction scopes.
  const result = sqliteQueue.then(reserve, reserve);
  sqliteQueue = result.catch(() => {});
  return result;
}

export async function releasePrioritySeat(reservationId: string) {
  await AppDataSource.getRepository(PriorityReservation).delete({ id: reservationId });
}

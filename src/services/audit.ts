import { AppDataSource } from '../config/data-source';
import { AuditLog } from '../entities/AuditLog';

export async function audit(params: {
  actorUserId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: unknown;
}) {
  const repo = AppDataSource.getRepository(AuditLog);
  await repo.save(repo.create({
    actorUserId: params.actorUserId ?? null,
    action: params.action,
    entity: params.entity,
    entityId: params.entityId ?? null,
    metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
  }));
}

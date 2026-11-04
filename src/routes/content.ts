import { Router, RequestHandler } from 'express';
import { z } from 'zod';
import { AppDataSource } from '../config/data-source';
import { SiteContent } from '../entities/SiteContent';
import { AuditLog } from '../entities/AuditLog';
import { User, UserRole } from '../entities/User';
import { requireAuth, requireRole } from '../middleware/auth';

const screens = z.enum(['home', 'plans', 'rules', 'simulator', 'checkout']);
const schema = z.object({
  revision: z.number().int().nonnegative(),
  values: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/), z.string().trim().min(1).max(5000))
    .refine(values => Object.keys(values).length <= 200),
}).strict();
const handle = (fn: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
const view = (row: SiteContent) => ({ screen: row.screen, values: JSON.parse(row.valuesJson), revision: row.revision, updatedAt: row.updatedAt, updatedBy: row.updatedBy });

export const contentRouter = Router();
export const contentAdminRouter = Router();
contentRouter.get('/', handle(async (_req, res) => {
  const rows = await AppDataSource.getRepository(SiteContent).find();
  res.json(Object.fromEntries(rows.map(row => [row.screen, { values: JSON.parse(row.valuesJson) }])));
}));
contentAdminRouter.use(requireAuth, requireRole(UserRole.ADMIN), handle(async (req, res, next) => {
  const user = await AppDataSource.getRepository(User).findOneBy({ id: req.auth!.sub });
  if (!user || user.role !== UserRole.ADMIN || user.authVersion !== (req.auth!.authVersion || 0)) {
    res.status(403).json({ message: 'Acesso de administrador necessário.' }); return;
  }
  next();
}));
contentAdminRouter.get('/', handle(async (_req, res) => {
  res.json((await AppDataSource.getRepository(SiteContent).find()).map(view));
}));
contentAdminRouter.get('/:screen/history', handle(async (req, res) => {
  if (!screens.safeParse(req.params.screen).success) { res.status(400).json({ message: 'Tela inválida.' }); return; }
  const history = await AppDataSource.getRepository(AuditLog).find({ where: { entity: 'SiteContent', entityId: req.params.screen }, order: { createdAt: 'DESC' }, take: 20 });
  res.json(history.map(row => ({ id: row.id, actorUserId: row.actorUserId, createdAt: row.createdAt, ...JSON.parse(row.metadataJson || '{}') })));
}));
contentAdminRouter.put('/:screen', handle(async (req, res) => {
  const screen = screens.safeParse(req.params.screen);
  const parsed = schema.safeParse(req.body);
  if (!screen.success || !parsed.success) { res.status(400).json({ message: 'Conteúdo inválido. Preencha os textos e tente novamente.' }); return; }
  try {
    const saved = await AppDataSource.transaction(async manager => {
      const repo = manager.getRepository(SiteContent);
      let row = await repo.findOneBy({ screen: screen.data });
      const { revision, values } = parsed.data;
      if ((row?.revision || 0) !== revision) throw new Error('CONTENT_CONFLICT');
      if (row) {
        const result = await repo.update({ screen: screen.data, revision }, { valuesJson: JSON.stringify(values), revision: revision + 1, updatedBy: req.auth!.sub });
        if (result.affected !== 1) throw new Error('CONTENT_CONFLICT');
      } else {
        await repo.insert({ screen: screen.data, valuesJson: JSON.stringify(values), revision: 1, updatedBy: req.auth!.sub });
      }
      await manager.getRepository(AuditLog).save({ actorUserId: req.auth!.sub, action: 'CONTENT_PUBLISHED', entity: 'SiteContent', entityId: screen.data, metadataJson: JSON.stringify({ revision: revision + 1, values }) });
      return (await repo.findOneByOrFail({ screen: screen.data }));
    });
    res.json(view(saved));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if ((error as Error).message === 'CONTENT_CONFLICT' || code === '23505' || code === 'SQLITE_CONSTRAINT') {
      res.status(409).json({ message: 'Esta tela foi alterada por outro administrador. Recarregue antes de publicar.' }); return;
    }
    throw error;
  }
}));

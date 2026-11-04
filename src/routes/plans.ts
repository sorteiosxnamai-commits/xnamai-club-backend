import { Router } from 'express';
import { AppDataSource } from '../config/data-source';
import { Plan } from '../entities/Plan';
import { priorityAvailability } from '../services/priority-capacity';
import { clubOffers } from '../config/club-pricing';

export const plansRouter = Router();

plansRouter.get('/', async (_req, res, next) => {
  try {
  const plans = await AppDataSource.getRepository(Plan).find({ where: { active: true }, order: { sortOrder: 'ASC' } });
  const capacity = await priorityAvailability();
  res.json(plans.map(plan => ({ ...plan,
    pixPriceCents: plan.code === 'LAUNCH' || plan.code === 'PRIORITY' ? clubOffers[plan.code].pix : null,
    ...(plan.code === 'PRIORITY' ? { availability: capacity } : {}),
  })));
  } catch (error) { next(error); }
});

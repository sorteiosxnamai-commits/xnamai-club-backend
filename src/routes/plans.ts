import { Router } from 'express';
import { AppDataSource } from '../config/data-source';
import { Plan } from '../entities/Plan';

export const plansRouter = Router();

plansRouter.get('/', async (_req, res) => {
  const plans = await AppDataSource.getRepository(Plan).find({ where: { active: true }, order: { sortOrder: 'ASC' } });
  res.json(plans);
});

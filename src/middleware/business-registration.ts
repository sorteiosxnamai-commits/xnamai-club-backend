import { NextFunction, Request, Response } from 'express';
import { AppDataSource } from '../config/data-source';
import { User } from '../entities/User';
import { isValidCnpj } from '../services/cnpj';

export async function requireBusinessRegistration(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await AppDataSource.getRepository(User).findOneBy({ id: req.auth!.sub });
    if (!user || !isValidCnpj(user.document || '') || (user.companyName?.trim().length || 0) < 2) {
      res.status(403).json({ code: 'BUSINESS_REGISTRATION_REQUIRED', message: 'Os planos são exclusivos para lojistas com CNPJ. Regularize o CNPJ e o nome da empresa no seu cadastro antes de contratar.' });
      return;
    }
    next();
  } catch (error) { next(error); }
}

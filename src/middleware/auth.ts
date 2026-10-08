import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '../entities/User';
import { env } from '../config/env';
import { AppDataSource } from '../config/data-source';
import { User } from '../entities/User';

export type JwtPayload = {
  sub: string;
  email: string;
  role: UserRole;
  authVersion?: number;
};

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token ausente.' });
  }

  try {
    const token = header.slice('Bearer '.length);
    req.auth = jwt.verify(token, env.jwtSecret) as JwtPayload;
    if (req.auth.role === UserRole.CUSTOMER) {
      const user = await AppDataSource.getRepository(User).findOne({ where: { id: req.auth.sub } });
      if (!user || user.role !== UserRole.CUSTOMER || (user.authVersion || 0) !== (req.auth.authVersion || 0)) {
        return res.status(401).json({ message: 'Token inválido ou expirado.' });
      }
    }
    next();
  } catch {
    return res.status(401).json({ message: 'Token inválido ou expirado.' });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ message: 'Acesso negado.' });
    }
    next();
  };
}

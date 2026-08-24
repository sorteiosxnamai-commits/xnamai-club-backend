import 'reflect-metadata';
import path from 'path';
import fs from 'fs';
import { DataSource } from 'typeorm';
import { User } from '../entities/User';
import { Plan } from '../entities/Plan';
import { Subscription } from '../entities/Subscription';
import { PaymentMethod } from '../entities/PaymentMethod';
import { Invoice } from '../entities/Invoice';
import { PaymentAttempt } from '../entities/PaymentAttempt';
import { AuditLog } from '../entities/AuditLog';

const entities = [User, Plan, Subscription, PaymentMethod, Invoice, PaymentAttempt, AuditLog];
const dbType = (process.env.DB_TYPE || 'sqlite').toLowerCase();
const synchronize = (process.env.TYPEORM_SYNCHRONIZE || 'true') === 'true';

function shouldUseSsl(host: string) {
  if (process.env.DB_SSL === 'true') return true;
  if (process.env.DB_SSL === 'false') return false;
  return host.includes('supabase.co') || host.includes('pooler.supabase.com');
}

function createDataSource(): DataSource {
  if (dbType === 'postgres') {
    return new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'xnamai_club',
      ssl: shouldUseSsl(process.env.DB_HOST || 'localhost')
        ? { rejectUnauthorized: false }
        : false,
      synchronize,
      logging: false,
      entities,
    });
  }

  const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || './data/xnamai.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return new DataSource({
    type: 'sqlite',
    database: dbPath,
    synchronize,
    logging: false,
    entities,
  });
}

export const AppDataSource = createDataSource();

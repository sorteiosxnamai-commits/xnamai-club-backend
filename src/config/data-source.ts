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

type PostgresConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
};

function supabaseProjectRef(host: string) {
  const match = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  return match?.[1] ?? null;
}

function parsePostgresUrl(url: string): PostgresConfig {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, '') || 'postgres',
  };
}

function resolvePostgresConfig(): PostgresConfig {
  const connectionUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING;
  let config: PostgresConfig = connectionUrl
    ? parsePostgresUrl(connectionUrl)
    : {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 5432),
        username: process.env.DB_USER || process.env.POSTGRES_USER || 'postgres',
        password: process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD || 'postgres',
        database: process.env.DB_NAME || process.env.POSTGRES_DATABASE || 'postgres',
      };

  const projectRef = supabaseProjectRef(config.host);
  if (projectRef) {
    config = {
      ...config,
      host: process.env.DB_POOLER_HOST || 'aws-0-us-east-1.pooler.supabase.com',
      port: 5432,
      username: config.username.includes('.') ? config.username : `${config.username}.${projectRef}`,
    };
    console.log(`Postgres: host direto do Supabase não funciona em IPv4; usando session pooler ${config.host}:5432`);
  }

  if (config.port === 6543) {
    config = { ...config, port: 5432 };
    console.log('Postgres: porta 6543 (PgBouncer) trocada para 5432 (session).');
  }

  return config;
}

function createDataSource(): DataSource {
  if (dbType === 'postgres') {
    const postgres = resolvePostgresConfig();
    const ssl = postgres.host !== 'localhost' && process.env.DB_SSL !== 'false'
      ? { rejectUnauthorized: false }
      : false;

    return new DataSource({
      type: 'postgres',
      ...postgres,
      ssl,
      extra: {
        ssl,
        connectionTimeoutMillis: 10_000,
        keepAlive: true,
      },
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

export async function initializeDatabase(retries = 3) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      if (!AppDataSource.isInitialized) {
        await AppDataSource.initialize();
      }
      return;
    } catch (error) {
      lastError = error;
      console.error(`Postgres tentativa ${attempt}/${retries} falhou:`, error);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
  throw lastError;
}

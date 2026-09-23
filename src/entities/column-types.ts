import { ColumnType } from 'typeorm';

// TypeORM accepts `timestamp` on PostgreSQL and `datetime` on SQLite.
// Keep one logical date-time field across the supported database modes.
export const dateTimeColumnType: ColumnType =
  (process.env.DB_TYPE || 'sqlite').toLowerCase() === 'postgres' ? 'timestamp' : 'datetime';

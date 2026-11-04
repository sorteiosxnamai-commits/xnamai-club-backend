import 'dotenv/config';

process.env.TYPEORM_SYNCHRONIZE = 'false';
async function migrate() {
  const { AppDataSource } = await import('../config/data-source');
  try {
    await AppDataSource.initialize();
    const completed = await AppDataSource.runMigrations({ transaction: 'all' });
    console.log(`Migrações aplicadas: ${completed.length}.`);
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
}
migrate().catch(() => { console.error('Falha na migração. Confira conectividade e esquema do banco.'); process.exitCode = 1; });

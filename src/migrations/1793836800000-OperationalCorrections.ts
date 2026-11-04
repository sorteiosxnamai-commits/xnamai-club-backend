import { MigrationInterface, QueryRunner, Table, TableColumn } from 'typeorm';

export class OperationalCorrections1793836800000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    const dateType = runner.connection.options.type === 'postgres' ? 'timestamp' : 'datetime';
    if (!await runner.hasTable('site_content')) {
      await runner.createTable(new Table({ name: 'site_content', columns: [
        { name: 'screen', type: 'varchar', isPrimary: true },
        { name: 'valuesJson', type: 'text', default: "'{}'" },
        { name: 'revision', type: 'integer', default: 0 },
        { name: 'updatedBy', type: 'varchar', isNullable: true },
        { name: 'updatedAt', type: dateType, default: 'CURRENT_TIMESTAMP' },
      ] }));
    }
    if (!await runner.hasTable('priority_reservations')) {
      await runner.createTable(new Table({ name: 'priority_reservations', columns: [
        { name: 'id', type: 'varchar', isPrimary: true },
        { name: 'userId', type: 'varchar' },
        { name: 'expiresAt', type: dateType },
      ] }));
    }
    if (await runner.hasTable('subscriptions') && !await runner.hasColumn('subscriptions', 'billingAmountCents')) {
      await runner.addColumn('subscriptions', new TableColumn({ name: 'billingAmountCents', type: 'integer', isNullable: true }));
    }
  }

  async down(runner: QueryRunner) {
    await runner.dropTable('priority_reservations', true);
    // Preserve editorial history and billing amounts on rollback; they are additive and compatible.
  }
}

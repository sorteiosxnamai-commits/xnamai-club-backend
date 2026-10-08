import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('recovery_rate_limits')
export class RecoveryRateLimit {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  key!: string;

  @Column({ type: 'integer' })
  attempts!: number;

  @Column({ name: 'expires_at', type: 'bigint' })
  expiresAt!: number;
}

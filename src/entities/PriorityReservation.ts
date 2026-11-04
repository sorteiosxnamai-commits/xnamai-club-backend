import { Column, Entity, PrimaryColumn } from 'typeorm';
import { dateTimeColumnType } from './column-types';

@Entity('priority_reservations')
export class PriorityReservation {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ type: 'varchar' })
  userId!: string;

  @Column({ type: dateTimeColumnType })
  expiresAt!: Date;
}

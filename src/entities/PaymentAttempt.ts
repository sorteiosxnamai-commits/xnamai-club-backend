import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Invoice } from './Invoice';

export enum PaymentAttemptStatus {
  APPROVED = 'APPROVED',
  DECLINED = 'DECLINED',
}

@Entity('payment_attempts')
export class PaymentAttempt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Invoice, (invoice) => invoice.attempts, { eager: true })
  @JoinColumn({ name: 'invoice_id' })
  invoice!: Invoice;

  @Column({ type: 'varchar' })
  status!: PaymentAttemptStatus;

  @Column({ nullable: true })
  failureCode!: string | null;

  @Column({ nullable: true })
  failureMessage!: string | null;

  @CreateDateColumn()
  attemptedAt!: Date;
}

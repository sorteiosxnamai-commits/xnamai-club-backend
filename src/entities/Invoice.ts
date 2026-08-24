import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Subscription } from './Subscription';
import { PaymentAttempt } from './PaymentAttempt';

export enum InvoiceStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

@Entity('invoices')
export class Invoice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Subscription, (subscription) => subscription.invoices, { eager: true })
  @JoinColumn({ name: 'subscription_id' })
  subscription!: Subscription;

  @Column({ type: 'integer' })
  amountCents!: number;

  @Column({ type: 'varchar', default: InvoiceStatus.PENDING })
  status!: InvoiceStatus;

  @Column()
  dueDate!: Date;

  @Column({ nullable: true })
  paidAt!: Date | null;

  @Column({ nullable: true })
  gatewayInvoiceId!: string | null;

  @OneToMany(() => PaymentAttempt, (attempt) => attempt.invoice)
  attempts!: PaymentAttempt[];

  @CreateDateColumn()
  createdAt!: Date;
}

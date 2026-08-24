import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from './User';

export enum PaymentMethodType {
  CREDIT_CARD = 'CREDIT_CARD',
  PIX_RECURRING = 'PIX_RECURRING',
}

@Entity('payment_methods')
export class PaymentMethod {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, (user) => user.paymentMethods, { eager: true })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'varchar' })
  type!: PaymentMethodType;

  @Column({ type: 'varchar', default: 'demo' })
  provider!: string;

  @Column({ type: 'varchar' })
  providerPaymentMethodId!: string;

  @Column({ type: 'varchar', nullable: true })
  cardBrand!: string | null;

  @Column({ type: 'varchar', nullable: true })
  cardLastFour!: string | null;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}

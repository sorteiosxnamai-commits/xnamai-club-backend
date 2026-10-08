import { Column, CreateDateColumn, Entity, Index, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Subscription } from './Subscription';
import { PaymentMethod } from './PaymentMethod';
import { dateTimeColumnType } from './column-types';

export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  ADMIN = 'ADMIN',
  SUPPORT = 'SUPPORT',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  email!: string;

  @Column({ type: 'varchar' })
  passwordHash!: string;

  @Index('idx_users_password_reset_token_hash')
  @Column({ name: 'password_reset_token_hash', type: 'varchar', length: 64, nullable: true, select: false })
  passwordResetTokenHash!: string | null;

  @Column({ name: 'password_reset_expires_at', type: dateTimeColumnType, nullable: true, select: false })
  passwordResetExpiresAt!: Date | null;

  @Column({ name: 'auth_version', type: 'integer', default: 0 })
  authVersion!: number;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  companyName?: string;

  @Column({ type: 'varchar', nullable: true })
  document?: string;

  // Mantém cadastros antigos duplicados intactos, mas garante unicidade para novas contas.
  @Column({ name: 'registration_document_key', type: 'varchar', nullable: true, unique: true, select: false })
  registrationDocumentKey?: string | null;

  @Column({ type: 'varchar', nullable: true })
  city?: string;

  @Column({ type: 'varchar', nullable: true })
  state?: string;

  @Column({ type: 'varchar', nullable: true })
  phone?: string;

  @Column({ type: 'varchar', default: UserRole.CUSTOMER })
  role!: UserRole;

  @Column({ type: 'varchar', nullable: true })
  stripeCustomerId?: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  launchCashbackUsedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  launchCashbackEligibleAt!: Date | null;

  @Column({ type: 'varchar', nullable: true })
  launchCashbackUsedById!: string | null;

  @OneToMany(() => Subscription, (subscription) => subscription.user)
  subscriptions!: Subscription[];

  @OneToMany(() => PaymentMethod, (paymentMethod) => paymentMethod.user)
  paymentMethods!: PaymentMethod[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

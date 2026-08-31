import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Subscription } from './Subscription';

@Entity('plans')
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  code!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'integer', nullable: true })
  monthlyPriceCents!: number | null;

  @Column({ type: 'integer', nullable: true })
  compareAtPriceCents!: number | null;

  @Column({ type: 'integer', nullable: true })
  purchaseLimitCents!: number | null;

  @Column({ type: 'text', default: '' })
  description!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: 'integer', default: 0 })
  sortOrder!: number;

  @Column({ type: 'varchar', nullable: true })
  stripePriceId!: string | null;

  @OneToMany(() => Subscription, (subscription) => subscription.plan)
  subscriptions!: Subscription[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

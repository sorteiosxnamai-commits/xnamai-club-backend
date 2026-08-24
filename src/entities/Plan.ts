import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Subscription } from './Subscription';

@Entity('plans')
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  code!: string;

  @Column()
  name!: string;

  @Column({ type: 'integer', nullable: true })
  monthlyPriceCents!: number | null;

  @Column({ type: 'integer', nullable: true })
  purchaseLimitCents!: number | null;

  @Column({ type: 'text', default: '' })
  description!: string;

  @Column({ default: true })
  active!: boolean;

  @Column({ type: 'integer', default: 0 })
  sortOrder!: number;

  @OneToMany(() => Subscription, (subscription) => subscription.plan)
  subscriptions!: Subscription[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

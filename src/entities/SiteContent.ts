import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('site_content')
export class SiteContent {
  @PrimaryColumn({ type: 'varchar' })
  screen!: string;

  @Column({ type: 'text', default: '{}' })
  valuesJson!: string;

  @Column({ type: 'integer', default: 0 })
  revision!: number;

  @Column({ type: 'varchar', nullable: true })
  updatedBy!: string | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}

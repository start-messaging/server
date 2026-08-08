import { Column, Entity, Index, JoinTable, ManyToMany } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { User } from '../../users/entities/user.entity.js';

/**
 * An admin-applied label on a customer account.
 *
 * Never exposed on any customer-facing route: these are internal notes about
 * accounts ("chasing payment", "abusive traffic"), and a customer reading
 * their own file would be worse than useless.
 */
@Index('IDX_tags_name', ['name'])
@Entity('tags')
export class Tag extends BaseEntity {
  @Column({ type: 'varchar', length: 40 })
  name: string;

  /** A palette key, not a CSS value — the panel maps it to its own classes. */
  @Column({ type: 'varchar', length: 20, default: 'slate' })
  colour: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  description: string | null;

  @ManyToMany(() => User, (user) => user.tags)
  @JoinTable({
    name: 'user_tags',
    joinColumn: { name: 'tagId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'userId', referencedColumnName: 'id' },
  })
  users: User[];
}

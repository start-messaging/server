import { Column, Entity, ManyToMany } from 'typeorm';
import { Tag } from '../../tags/entities/tag.entity.js';
import { BaseEntity } from '../../common/entities/base.entity.js';
import { UserRole } from '../enums/user-role.enum.js';
import { KycStatus } from '../enums/kyc-status.enum.js';

@Entity('users')
export class User extends BaseEntity {
  @Column({ unique: true })
  email: string;

  @Column({ type: 'varchar', nullable: true })
  passwordHash: string | null;

  @Column()
  firstName: string;

  @Column()
  lastName: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.CUSTOMER })
  role: UserRole;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'varchar', nullable: true })
  mobileNumber: string | null;

  @Column({ type: 'varchar', nullable: true })
  companyName: string | null;

  @Column({ type: 'varchar', nullable: true })
  websiteUrl: string | null;

  @Column({ type: 'varchar', unique: true, nullable: true })
  googleId: string | null;

  @Column({ default: false })
  hasCompletedOnboarding: boolean;

  @Column({ type: 'varchar', length: 2, nullable: true })
  country: string | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  refreshTokenHash: string | null;

  @Column({ type: 'enum', enum: KycStatus, default: KycStatus.NOT_SUBMITTED })
  kycStatus: KycStatus;

  @Column({ type: 'varchar', nullable: true })
  businessName: string | null;

  @Column({ type: 'varchar', nullable: true })
  gstin: string | null;

  @Column({ type: 'varchar', nullable: true })
  pan: string | null;

  @Column({ type: 'text', nullable: true })
  businessAddress: string | null;

  @Column({ type: 'varchar', nullable: true })
  kycDocumentPath: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  kycSubmittedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  kycReviewedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  kycReviewedBy: string | null;

  @Column({ type: 'text', nullable: true })
  kycRejectionReason: string | null;

  @Column({ default: false })
  mobileVerified: boolean;

  @Column({ type: 'varchar', nullable: true, select: false })
  mobileOtpHash: string | null;

  @Column({ type: 'timestamptz', nullable: true, select: false })
  mobileOtpExpiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  lastLoginIp: string | null;

  /** Internal: outbound sales/support call tracking (admin-only, not selected by default) */
  @Column({ type: 'timestamptz', nullable: true, select: false })
  adminLastCalledAt: Date | null;

  @Column({ type: 'text', nullable: true, select: false })
  adminCallNotes: string | null;

  /**
   * Admin-only labels. Deliberately not in any customer projection — these
   * are internal notes about the account, not the customer's own data.
   */
  @ManyToMany(() => Tag, (tag) => tag.users)
  tags: Tag[];
}

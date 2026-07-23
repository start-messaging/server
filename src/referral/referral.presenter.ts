import { ReferralPartner } from './entities/referral-partner.entity.js';
import { Referral } from './entities/referral.entity.js';
import { CommissionLedger } from './entities/commission-ledger.entity.js';
import { PayoutRequest } from './entities/payout-request.entity.js';

/** Mask an email like `jo***@example.com` for the partner's referral list. */
export function maskEmail(email?: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

/** Safe public shape of a partner — never exposes passwordHash/refreshToken. */
export function presentPartner(p: ReferralPartner) {
  return {
    id: p.id,
    email: p.email,
    fullName: p.fullName,
    mobileNumber: p.mobileNumber,
    status: p.status,
    referralCode: p.referralCode,
    commissionPercent: p.commissionBps / 100,
    earningsBalanceMicros: Number(p.earningsBalance),
    totalEarnedMicros: Number(p.totalEarned),
    paidUsersCount: p.paidUsersCount,
    payoutDetails: p.payoutDetails,
    createdAt: p.createdAt,
  };
}

export function presentReferral(r: Referral) {
  return {
    id: r.id,
    referredUserEmail: maskEmail(r.referredUser?.email),
    status: r.status,
    firstPaidAt: r.firstPaidAt,
    createdAt: r.createdAt,
  };
}

export function presentCommission(c: CommissionLedger) {
  return {
    id: c.id,
    type: c.type,
    amountMicros: Number(c.amount),
    balanceAfterMicros: Number(c.balanceAfter),
    referredUserId: c.referredUserId,
    paymentId: c.paymentId,
    payoutId: c.payoutId,
    description: c.description,
    createdAt: c.createdAt,
  };
}

export function presentPayout(p: PayoutRequest) {
  return {
    id: p.id,
    amountMicros: Number(p.amount),
    currency: p.currency,
    status: p.status,
    windowMonth: p.windowMonth,
    payoutRef: p.payoutRef,
    rejectionReason: p.rejectionReason,
    processedAt: p.processedAt,
    createdAt: p.createdAt,
  };
}

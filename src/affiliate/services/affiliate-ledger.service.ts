import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  CommissionStatus,
  PartnerCommission,
} from '../entities/partner-commission.entity.js';
import {
  PartnerPayout,
  PayoutStatus,
} from '../entities/partner-payout.entity.js';
import { Referral, ReferralStatus } from '../entities/referral.entity.js';
import { paginateQueryBuilder } from '../../common/utils/pagination.util.js';

/** Read-side for the commission ledger and payout history. */
@Injectable()
export class AffiliateLedgerService {
  constructor(
    @InjectRepository(PartnerCommission)
    private readonly commissionRepo: Repository<PartnerCommission>,
    @InjectRepository(PartnerPayout)
    private readonly payoutRepo: Repository<PartnerPayout>,
  ) {}

  async listCommissions(
    partnerId: string,
    page: number,
    limit: number,
    status?: CommissionStatus,
    withCount = true,
  ): Promise<[PartnerCommission[], number]> {
    const qb = this.commissionRepo
      .createQueryBuilder('commission')
      .where('commission.partnerId = :partnerId', { partnerId });

    if (status) {
      qb.andWhere('commission.status = :status', { status });
    }

    qb.orderBy('commission.earnedAt', 'DESC').addOrderBy(
      'commission.id',
      'DESC',
    );

    return paginateQueryBuilder(qb, { page, limit, withCount });
  }

  async listPayouts(
    page: number,
    limit: number,
    filters: { partnerId?: string; status?: PayoutStatus } = {},
    withCount = true,
  ): Promise<[PartnerPayout[], number]> {
    const qb = this.payoutRepo.createQueryBuilder('payout');

    if (filters.partnerId) {
      qb.andWhere('payout.partnerId = :partnerId', {
        partnerId: filters.partnerId,
      });
    }
    if (filters.status) {
      qb.andWhere('payout.status = :status', { status: filters.status });
    }

    qb.orderBy('payout.createdAt', 'DESC').addOrderBy('payout.id', 'DESC');

    return paginateQueryBuilder(qb, { page, limit, withCount });
  }

  /** Admin queue view, joined to the partner so the list is self-explanatory. */
  async listPayoutsForAdmin(
    page: number,
    limit: number,
    status?: PayoutStatus,
    withCount = true,
  ) {
    const qb = this.payoutRepo
      .createQueryBuilder('payout')
      .leftJoinAndSelect('payout.partner', 'partner');

    if (status) {
      qb.andWhere('payout.status = :status', { status });
    }

    qb.orderBy('payout.createdAt', 'DESC').addOrderBy('payout.id', 'DESC');

    return paginateQueryBuilder(qb, { page, limit, withCount });
  }

  /**
   * Drops the admin-only columns from a payout before a partner sees it.
   *
   * `adminNotes` is written about the partner during review, and
   * `processedByAdminId` identifies a staff member — neither belongs in a
   * partner response. `failureReason` is kept deliberately: when a transfer
   * bounces, that is the one thing the partner actually needs told.
   */
  sanitizePayoutForPartner(payout: PartnerPayout) {
    const safe: Partial<PartnerPayout> = { ...payout };
    delete safe.adminNotes;
    delete safe.processedByAdminId;
    return safe;
  }

  async findPayout(id: string, partnerId?: string): Promise<PartnerPayout> {
    const payout = await this.payoutRepo.findOne({
      where: partnerId ? { id, partnerId } : { id },
    });
    if (!payout) throw new NotFoundException('Payout not found');
    return payout;
  }

  /**
   * Records the outcome of a payout an admin has actioned.
   *
   * Settling also moves the partner's cached paid/unpaid split, but only on
   * the transition into PAID — re-saving an already-paid payout must not
   * double-count.
   *
   * The whole thing is one transaction, and the payout row is locked for its
   * duration, for two reasons:
   *
   *  - **The transition guard has to hold.** Read-check-write without a lock
   *    lets two admins actioning the same payout both read PENDING, both pass
   *    `assertTransitionAllowed`, and both write — so a payout can be marked
   *    PAID and FAILED by racing requests, releasing commissions that a
   *    settled payout claims to have sent.
   *  - **Failure and refund must commit together.** Moving to FAILED returns
   *    the commissions to the unpaid pool. Committing the status separately
   *    from the release leaves a window where a crash strands the money:
   *    the payout reads FAILED while its commissions stay `paid`, and
   *    `reconcilePartnerTotals` cannot repair it because it recomputes *from*
   *    the ledger, which still says paid.
   */
  async updatePayoutStatus(
    id: string,
    patch: {
      status: PayoutStatus;
      paymentReference?: string;
      failureReason?: string;
      adminNotes?: string;
      adminId?: string;
    },
  ): Promise<PartnerPayout> {
    return this.payoutRepo.manager.transaction(async (manager) => {
      const [locked] = await manager.query<PartnerPayout[]>(
        `SELECT * FROM "partner_payouts" WHERE "id" = $1 FOR UPDATE`,
        [id],
      );
      if (!locked) throw new NotFoundException('Payout not found');

      this.assertTransitionAllowed(locked.status, patch.status);

      // A payout with no destination recorded cannot have been sent anywhere,
      // so it must not be recordable as PAID — and PAID is terminal, so the
      // mistake would need raw SQL to undo. The payout run no longer creates
      // such rows, but ones raised before that guard existed are still in the
      // table. FAILED is the correct outcome: it returns the balance and the
      // next cycle retries once the partner supplies their details.
      if (patch.status === PayoutStatus.PAID && !locked.payoutMethod) {
        throw new BadRequestException(
          'This payout has no destination recorded, so it cannot be marked paid. ' +
            'Mark it failed instead — the balance returns to the partner and the ' +
            'next cycle will retry once they add their payout details.',
        );
      }

      const update: Partial<PartnerPayout> = {
        status: patch.status,
        processedByAdminId: patch.adminId ?? locked.processedByAdminId,
      };

      if (patch.paymentReference !== undefined) {
        update.paymentReference = patch.paymentReference;
      }
      if (patch.failureReason !== undefined) {
        update.failureReason = patch.failureReason;
      }
      if (patch.adminNotes !== undefined) {
        update.adminNotes = patch.adminNotes;
      }
      if (patch.status === PayoutStatus.PAID && !locked.paidAt) {
        update.paidAt = new Date();
      }

      await manager.getRepository(PartnerPayout).update({ id }, update);

      // Same transaction as the status write. Idempotent, so re-PATCHing
      // FAILED -> FAILED (which the `from === to` early return permits) is a
      // safe way to finish a release that an older deploy left half-done.
      if (patch.status === PayoutStatus.FAILED) {
        await this.releaseWithin(manager, id, locked.partnerId);
      }

      return manager
        .getRepository(PartnerPayout)
        .findOneOrFail({ where: { id } });
    });
  }

  /**
   * Guards the payout state machine.
   *
   * PAID and FAILED are terminal, and that matters for correctness rather than
   * tidiness. Marking a payout FAILED releases its commissions back to the
   * unpaid pool; if it could then be moved to PAID, the payout row would claim
   * the money was sent while the commissions sat `accrued` — and the next
   * monthly run would pay the same earnings a second time. A failed transfer is
   * simply retried by the next cycle, which raises a fresh payout.
   */
  private assertTransitionAllowed(from: PayoutStatus, to: PayoutStatus): void {
    if (from === to) return;

    const allowed: Record<PayoutStatus, PayoutStatus[]> = {
      [PayoutStatus.PENDING]: [
        PayoutStatus.PROCESSING,
        PayoutStatus.PAID,
        PayoutStatus.FAILED,
        PayoutStatus.ON_HOLD,
      ],
      [PayoutStatus.PROCESSING]: [
        PayoutStatus.PAID,
        PayoutStatus.FAILED,
        PayoutStatus.ON_HOLD,
      ],
      [PayoutStatus.ON_HOLD]: [
        PayoutStatus.PENDING,
        PayoutStatus.PROCESSING,
        PayoutStatus.PAID,
        PayoutStatus.FAILED,
      ],
      [PayoutStatus.PAID]: [],
      [PayoutStatus.FAILED]: [],
    };

    if (!allowed[from].includes(to)) {
      throw new BadRequestException(
        `Cannot move a payout from ${from} to ${to}.` +
          (from === PayoutStatus.FAILED
            ? ' Its earnings were already returned to the unpaid balance and will be picked up by the next payout cycle.'
            : from === PayoutStatus.PAID
              ? ' A settled payout is final.'
              : ''),
      );
    }
  }

  /**
   * Claws back a single commission — refund, chargeback or fraud.
   *
   * Only `accrued` rows can be reversed. Once a commission is `paid` the money
   * has left, and silently flipping the row would make the ledger disagree with
   * a payout that really was sent; recovering that is a deliberate act against
   * the partner's future balance, not a status edit.
   *
   * Reversed rows are excluded from every total reconciliation computes, so the
   * cached columns are moved by the same amount here to keep the two in step
   * between reconcile runs.
   */
  async reverseCommission(id: string, reason: string): Promise<number> {
    return this.commissionRepo.manager.transaction(async (manager) => {
      const commission = await manager
        .getRepository(PartnerCommission)
        .findOne({ where: { id } });
      if (!commission) throw new NotFoundException('Commission not found');

      // Partner row first, matching the order `settlePartner` takes, so a
      // reversal racing a payout run cannot deadlock with it.
      await manager.query(
        `SELECT 1 FROM "partners" WHERE "id" = $1 FOR UPDATE`,
        [commission.partnerId],
      );

      // Re-read under the lock: a payout run may have swept this row into a
      // payout between the read above and the lock being granted.
      const [current] = await manager.query<{ status: CommissionStatus }[]>(
        `SELECT "status" FROM "partner_commissions" WHERE "id" = $1`,
        [id],
      );

      if (current?.status === CommissionStatus.REVERSED) return 0;
      if (current?.status === CommissionStatus.PAID) {
        throw new BadRequestException(
          'This commission has already been paid out and cannot be reversed. ' +
            'Recover it by adjusting the partner’s future balance instead.',
        );
      }

      return this.reverseWithin(
        manager,
        `"id" = $1`,
        [id],
        commission.partnerId,
        reason,
      );
    });
  }

  /**
   * Reverses every still-accrued commission matching `predicate` and moves the
   * partner's cached totals by the sum actually reversed.
   *
   * The caller must already hold the partner row lock. `predicate` is a fixed
   * string written at a call site, never anything caller-supplied — the values
   * it references are bound parameters.
   */
  private async reverseWithin(
    manager: EntityManager,
    predicate: string,
    params: unknown[],
    partnerId: string,
    reason: string,
  ): Promise<number> {
    const [reversed] = await manager.query<{ count: string; total: string }[]>(
      `WITH reversed AS (
         UPDATE "partner_commissions"
            SET "status" = 'reversed',
                "reversedReason" = $${params.length + 1},
                "updatedAt" = now()
          WHERE ${predicate}
            AND "status" = 'accrued'
            AND "deletedAt" IS NULL
        RETURNING "amount"
       )
       SELECT COUNT(*)::int AS count, COALESCE(SUM("amount"), 0) AS total
         FROM reversed`,
      [...params, reason],
    );

    const count = Number(reversed?.count ?? 0);
    if (count === 0) return 0;

    await manager.query(
      `UPDATE "partners"
          SET "unpaidEarnings"   = "unpaidEarnings"   - $2,
              "lifetimeEarnings" = "lifetimeEarnings" - $2,
              "updatedAt"        = now()
        WHERE "id" = $1`,
      [partnerId, reversed.total],
    );

    return count;
  }

  /**
   * Excludes a referral from the programme and claws back what it earned.
   *
   * This is the fraud and self-referral remedy. The accrual query already skips
   * blocked referrals, so blocking stops future earnings; reversing the unpaid
   * ones in the same transaction is what stops the existing balance from being
   * paid out at the end of the month. Commissions already paid are left alone
   * and reported back, because that money is gone and the caller needs to know.
   */
  async blockReferral(
    id: string,
    reason: string,
  ): Promise<{ reversed: number; alreadyPaid: number }> {
    return this.commissionRepo.manager.transaction(async (manager) => {
      const referral = await manager
        .getRepository(Referral)
        .findOne({ where: { id } });
      if (!referral) throw new NotFoundException('Referral not found');

      await manager.query(
        `SELECT 1 FROM "partners" WHERE "id" = $1 FOR UPDATE`,
        [referral.partnerId],
      );

      const [{ paid }] = await manager.query<{ paid: string }[]>(
        `SELECT COUNT(*)::int AS paid FROM "partner_commissions"
          WHERE "referralId" = $1 AND "status" = 'paid' AND "deletedAt" IS NULL`,
        [id],
      );

      const reversed = await this.reverseWithin(
        manager,
        `"referralId" = $1`,
        [id],
        referral.partnerId,
        reason,
      );

      await manager.getRepository(Referral).update(
        { id },
        {
          status: ReferralStatus.BLOCKED,
          blockedReason: reason,
        },
      );

      return { reversed, alreadyPaid: Number(paid) };
    });
  }

  /**
   * Returns commissions to the unpaid pool when a payout fails.
   *
   * Without this, a failed bank transfer would leave the money marked `paid`
   * and the partner would silently never receive it — the balance would simply
   * vanish from their next cycle.
   */
  async releaseFailedPayout(id: string): Promise<number> {
    const payout = await this.findPayout(id);
    return this.commissionRepo.manager.transaction((manager) =>
      this.releaseWithin(manager, id, payout.partnerId),
    );
  }

  /**
   * The release itself, on a caller-supplied transaction.
   *
   * Idempotent by predicate: it only touches rows that are still `paid` under
   * this payout, so running it twice releases nothing the second time and
   * leaves the cached totals alone.
   *
   * The partner's cached balance is moved by the sum of the rows actually
   * released, not by `payout.amount`. Those are equal in the normal case, but
   * only the ledger sum stays correct if a row was already released or soft
   * deleted — using the payout total there would push the cache out of step
   * with the ledger, which is exactly the drift these columns must not have.
   */
  private async releaseWithin(
    manager: EntityManager,
    payoutId: string,
    partnerId: string,
  ): Promise<number> {
    // Ordered after the payout lock and before the partner write, matching the
    // lock order `settlePartner` takes (partner row first, payouts read
    // unlocked) so the two cannot deadlock.
    const [released] = await manager.query<{ count: string; total: string }[]>(
      // Ends in a SELECT: a bare `UPDATE … RETURNING` comes back from TypeORM
      // as `[rows, affectedCount]`, so `.length` would report 2 whether one
      // row was released or a thousand.
      `WITH released AS (
         UPDATE "partner_commissions"
            SET "status" = 'accrued', "payoutId" = NULL, "updatedAt" = now()
          WHERE "payoutId" = $1 AND "status" = 'paid' AND "deletedAt" IS NULL
        RETURNING "amount"
       )
       SELECT COUNT(*)::int AS count, COALESCE(SUM("amount"), 0) AS total
         FROM released`,
      [payoutId],
    );

    const count = Number(released?.count ?? 0);
    if (count === 0) return 0;

    await manager.query(
      `UPDATE "partners"
          SET "unpaidEarnings" = "unpaidEarnings" + $2,
              "paidEarnings"   = "paidEarnings"   - $2,
              "updatedAt"      = now()
        WHERE "id" = $1`,
      [partnerId, released.total],
    );

    return count;
  }

  /** Programme-wide totals for the admin dashboard. */
  async getAdminOverview() {
    const [row] = await this.commissionRepo.manager.query<
      {
        total_accrued: string;
        total_paid: string;
        pending_payout_amount: string;
        pending_payout_count: string;
      }[]
    >(`
      SELECT
        (SELECT COALESCE(SUM("amount"), 0) FROM "partner_commissions"
          WHERE "status" = 'accrued' AND "deletedAt" IS NULL) AS total_accrued,
        (SELECT COALESCE(SUM("amount"), 0) FROM "partner_commissions"
          WHERE "status" = 'paid' AND "deletedAt" IS NULL) AS total_paid,
        (SELECT COALESCE(SUM("amount"), 0) FROM "partner_payouts"
          WHERE "status" IN ('pending', 'processing') AND "deletedAt" IS NULL)
          AS pending_payout_amount,
        (SELECT COUNT(*) FROM "partner_payouts"
          WHERE "status" IN ('pending', 'processing') AND "deletedAt" IS NULL)
          AS pending_payout_count
    `);

    return {
      totalAccrued: Number(row?.total_accrued ?? 0),
      totalPaid: Number(row?.total_paid ?? 0),
      pendingPayoutAmount: Number(row?.pending_payout_amount ?? 0),
      pendingPayoutCount: Number(row?.pending_payout_count ?? 0),
    };
  }
}

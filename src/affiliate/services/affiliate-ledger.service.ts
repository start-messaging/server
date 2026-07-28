import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CommissionStatus,
  PartnerCommission,
} from '../entities/partner-commission.entity.js';
import {
  PartnerPayout,
  PayoutStatus,
} from '../entities/partner-payout.entity.js';
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
    const payout = await this.findPayout(id);
    this.assertTransitionAllowed(payout.status, patch.status);

    const update: Partial<PartnerPayout> = {
      status: patch.status,
      processedByAdminId: patch.adminId ?? payout.processedByAdminId,
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
    if (patch.status === PayoutStatus.PAID && !payout.paidAt) {
      update.paidAt = new Date();
    }

    await this.payoutRepo.update({ id }, update);
    return this.findPayout(id);
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
   * Returns commissions to the unpaid pool when a payout fails.
   *
   * Without this, a failed bank transfer would leave the money marked `paid`
   * and the partner would silently never receive it — the balance would simply
   * vanish from their next cycle.
   */
  async releaseFailedPayout(id: string): Promise<number> {
    const payout = await this.findPayout(id);

    const released = await this.commissionRepo.manager.transaction(
      async (manager) => {
        // Ends in a SELECT: a bare `UPDATE … RETURNING` comes back from
        // TypeORM as `[rows, affectedCount]`, so `.length` would report 2
        // whether one row was released or a thousand.
        const [released] = await manager.query<{ count: string }[]>(
          `WITH released AS (
             UPDATE "partner_commissions"
                SET "status" = 'accrued', "payoutId" = NULL, "updatedAt" = now()
              WHERE "payoutId" = $1 AND "status" = 'paid'
            RETURNING "id"
           )
           SELECT COUNT(*)::int AS count FROM released`,
          [id],
        );

        const count = Number(released?.count ?? 0);

        if (count > 0) {
          await manager.query(
            `UPDATE "partners"
                SET "unpaidEarnings" = "unpaidEarnings" + $2,
                    "paidEarnings"   = "paidEarnings"   - $2,
                    "updatedAt"      = now()
              WHERE "id" = $1`,
            [payout.partnerId, payout.amount],
          );
        }

        return count;
      },
    );

    return released;
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

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EmailSuppression } from '../entities/email-suppression.entity.js';
import { EmailSuppressionReason } from '../enums/email-suppression-reason.enum.js';

/**
 * The do-not-contact list.
 *
 * Every path that could put an address into an outgoing message goes through
 * here. Being wrong in this one place is the failure with actual legal weight —
 * and the one that gets a sending domain blocklisted — so it is deliberately
 * the least clever code in the module.
 */
@Injectable()
export class EmailSuppressionService {
  private readonly logger = new Logger(EmailSuppressionService.name);

  constructor(
    @InjectRepository(EmailSuppression)
    private readonly repo: Repository<EmailSuppression>,
  ) {}

  /** Addresses are compared case-insensitively; the column stores lower-case. */
  static normalise(email: string): string {
    return email.trim().toLowerCase();
  }

  async isSuppressed(email: string): Promise<boolean> {
    const count = await this.repo.count({
      where: { email: EmailSuppressionService.normalise(email) },
    });
    return count > 0;
  }

  /**
   * Returns which of `emails` are suppressed, as a lower-cased set.
   *
   * Batched rather than per-address: building a ten-thousand recipient audience
   * with one query each would issue ten thousand round trips, and the check has
   * to happen for every send.
   */
  async findSuppressed(emails: string[]): Promise<Set<string>> {
    const normalised = [
      ...new Set(emails.map(EmailSuppressionService.normalise)),
    ];
    if (normalised.length === 0) return new Set();

    const found = new Set<string>();

    // Postgres has a hard ceiling on bind parameters, so a large audience is
    // chunked rather than sent as one enormous IN list.
    const CHUNK = 1_000;
    for (let i = 0; i < normalised.length; i += CHUNK) {
      const rows = await this.repo.find({
        where: { email: In(normalised.slice(i, i + CHUNK)) },
        select: { email: true },
      });
      rows.forEach((r) => found.add(r.email));
    }

    return found;
  }

  /**
   * Adds an address to the list.
   *
   * Idempotent: an unsubscribe link that a mail client prefetches, or that the
   * recipient clicks twice, must not raise. The first reason recorded is kept —
   * "they complained" is more useful history than a later "bounced".
   */
  async suppress(
    email: string,
    reason: EmailSuppressionReason,
    meta: {
      campaignId?: string | null;
      note?: string | null;
      createdBy?: string | null;
    } = {},
  ): Promise<EmailSuppression> {
    const normalised = EmailSuppressionService.normalise(email);

    const existing = await this.repo.findOne({
      where: { email: normalised },
    });
    if (existing) return existing;

    const row = this.repo.create({
      email: normalised,
      reason,
      campaignId: meta.campaignId ?? null,
      note: meta.note ?? null,
      createdBy: meta.createdBy ?? null,
    });

    try {
      return await this.repo.save(row);
    } catch (err) {
      // Two unsubscribe clicks landing at once both pass the check above and
      // race to insert. The unique index is what actually guarantees one row;
      // losing the race is a success, not an error.
      const existingAfterRace = await this.repo.findOne({
        where: { email: normalised },
      });
      if (existingAfterRace) return existingAfterRace;
      throw err;
    }
  }

  async list(params: {
    page: number;
    limit: number;
    search?: string;
    reason?: EmailSuppressionReason;
  }): Promise<[EmailSuppression[], number]> {
    const qb = this.repo.createQueryBuilder('s');

    if (params.search) {
      qb.andWhere('s.email ILIKE :search', {
        search: `%${params.search.trim()}%`,
      });
    }
    if (params.reason) {
      qb.andWhere('s.reason = :reason', { reason: params.reason });
    }

    return qb
      .orderBy('s.createdAt', 'DESC')
      .skip((params.page - 1) * params.limit)
      .take(params.limit)
      .getManyAndCount();
  }

  /**
   * Lifts a suppression.
   *
   * A soft delete, so the record that someone once opted out survives — if they
   * later dispute being mailed, "removed by admin X on date Y" is the answer,
   * and a hard delete would leave nothing to answer with.
   */
  async remove(id: string, removedBy?: string | null): Promise<void> {
    await this.repo.softDelete(id);
    this.logger.log(`Suppression ${id} lifted by ${removedBy ?? 'system'}`);
  }
}

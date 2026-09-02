import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { ErrorCodes } from '../common/constants/error-codes.constant.js';
import {
  applySort,
  paginateQueryBuilder,
  paginatedResponse,
  resolveSort,
  SortWhitelist,
} from '../common/utils/pagination.util.js';
import { Lead } from './entities/lead.entity.js';
import { LeadIngestRun } from './entities/lead-ingest-run.entity.js';
import { LeadOutreachEvent } from './entities/lead-outreach-event.entity.js';
import { OutreachSuppression } from './entities/outreach-suppression.entity.js';
import { SuppressionReason } from './enums/lead.enum.js';
import { LeadFilterQueryDto } from './dto/lead-filter-query.dto.js';
import { UpdateLeadDto } from './dto/update-lead.dto.js';
import { CreateSuppressionDto } from './dto/create-suppression.dto.js';
import { SuppressionFilterQueryDto } from './dto/suppression-filter-query.dto.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';

const LEAD_SORT_WHITELIST: SortWhitelist = {
  createdAt: 'l.createdAt',
  registeredOn: 'l.registeredOn',
  score: 'l.score',
  qualificationScore: 'l.qualificationScore',
  domain: 'l.domain',
  // Mostly-NULL column; applySort's NULLS LAST on desc keeps the unrated
  // majority behind the rated leads instead of in front of them.
  teamRating: 'l.teamRating',
};

/** SQL for "this lead has at least one extracted contact". */
const HAS_CONTACT_SQL =
  '(jsonb_array_length(l."contactEmails") > 0' +
  ' OR jsonb_array_length(l."contactPhones") > 0' +
  ' OR jsonb_array_length(l."contactWhatsapp") > 0)';

/** Query-string spellings that mean true (mirrors pagination-query.dto.ts). */
function queryFlagIsTrue(value: string): boolean {
  return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase());
}

@Injectable()
export class LeadsService {
  constructor(
    @InjectRepository(Lead)
    private readonly leads: Repository<Lead>,
    @InjectRepository(LeadIngestRun)
    private readonly runs: Repository<LeadIngestRun>,
    @InjectRepository(LeadOutreachEvent)
    private readonly events: Repository<LeadOutreachEvent>,
    @InjectRepository(OutreachSuppression)
    private readonly suppressions: Repository<OutreachSuppression>,
  ) {}

  async list(query: LeadFilterQueryDto) {
    const qb = this.leads.createQueryBuilder('l');

    if (query.search) {
      qb.andWhere('(l.domain ILIKE :search OR l.siteTitle ILIKE :search)', {
        search: `%${query.search}%`,
      });
    }
    if (query.status) {
      qb.andWhere('l.status = :status', { status: query.status });
    }
    if (query.enrichmentStatus) {
      qb.andWhere('l.enrichmentStatus = :enrichmentStatus', {
        enrichmentStatus: query.enrichmentStatus,
      });
    }
    if (query.liveness) {
      qb.andWhere('l.liveness = :liveness', { liveness: query.liveness });
    }
    if (query.hasContact !== undefined) {
      qb.andWhere(
        queryFlagIsTrue(query.hasContact)
          ? HAS_CONTACT_SQL
          : `NOT ${HAS_CONTACT_SQL}`,
      );
    }
    if (query.india !== undefined) {
      // IS NOT TRUE, not = false: the unknowns (null) belong with the
      // non-Indian side when filtering for India and vice versa would hide
      // them from both views.
      qb.andWhere(
        queryFlagIsTrue(query.india)
          ? 'l."isIndian" IS TRUE'
          : 'l."isIndian" IS NOT TRUE',
      );
    }
    applySort(
      qb,
      resolveSort(query.sortBy, LEAD_SORT_WHITELIST, 'createdAt', query.sortOrder),
    );

    const [items, total] = await paginateQueryBuilder(qb, {
      page: query.page,
      limit: query.limit,
      withCount: query.shouldCount,
    });
    return paginatedResponse(items, total, query.page, query.limit);
  }

  async getStats() {
    const [totalsRow] = (await this.leads.query(
      `SELECT COUNT(*)::int AS "all",
              COUNT(*) FILTER (
                WHERE jsonb_array_length("contactEmails") > 0
                   OR jsonb_array_length("contactPhones") > 0
                   OR jsonb_array_length("contactWhatsapp") > 0
              )::int AS "withContact",
              COUNT(*) FILTER (WHERE "isIndian" IS TRUE)::int AS india
         FROM leads
        WHERE "deletedAt" IS NULL`,
    )) as Array<{ all: number; withContact: number; india: number }>;

    const statusRows: Array<{ status: string; count: number }> =
      await this.leads.query(
        `SELECT status, COUNT(*)::int AS count
           FROM leads WHERE "deletedAt" IS NULL GROUP BY status`,
      );
    const enrichmentRows: Array<{ status: string; count: number }> =
      await this.leads.query(
        `SELECT "enrichmentStatus" AS status, COUNT(*)::int AS count
           FROM leads WHERE "deletedAt" IS NULL GROUP BY "enrichmentStatus"`,
      );
    const livenessRows: Array<{ status: string; count: number }> =
      await this.leads.query(
        `SELECT "liveness" AS status, COUNT(*)::int AS count
           FROM leads WHERE "deletedAt" IS NULL GROUP BY "liveness"`,
      );

    const recentRuns = await this.runs.find({
      order: { fileDate: 'DESC' },
      take: 7,
    });

    return {
      totals: {
        all: totalsRow?.all ?? 0,
        withContact: totalsRow?.withContact ?? 0,
        india: totalsRow?.india ?? 0,
      },
      byStatus: Object.fromEntries(
        statusRows.map((r) => [r.status, r.count]),
      ) as Record<string, number>,
      byEnrichment: Object.fromEntries(
        enrichmentRows.map((r) => [r.status, r.count]),
      ) as Record<string, number>,
      byLiveness: Object.fromEntries(
        livenessRows.map((r) => [r.status, r.count]),
      ) as Record<string, number>,
      recentRuns,
    };
  }

  /**
   * The drain's order book, for the pipeline view: how much work is
   * eligible RIGHT NOW per pool ("how many will it do") and how much was
   * crawled in the last day ("how many done"). Mirrors the drain's claim
   * predicates exactly — if these counts and the drain ever disagree, one
   * of them is lying about eligibility.
   */
  async getEnrichmentOutlook(recrawlHours: number, parkedRecheckDays: number) {
    const [row] = (await this.leads.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE "enrichmentStatus" = 'pending'
             AND "liveness" = 'live' AND "status" <> 'disqualified'
         )::int AS "pendingLive",
         COUNT(*) FILTER (
           WHERE "enrichmentStatus" IN ('enriched', 'no_contact')
             AND "liveness" = 'live' AND "status" <> 'disqualified'
             AND "enrichedAt" < now() - make_interval(hours => $1)
         )::int AS "staleRecrawl",
         COUNT(*) FILTER (
           WHERE "enrichmentStatus" = 'parked'
             AND "status" <> 'disqualified'
             AND "enrichedAt" < now() - make_interval(days => $2)
         )::int AS "parkedRecheckDue",
         COUNT(*) FILTER (
           WHERE "enrichedAt" > now() - interval '24 hours'
         )::int AS "crawledLast24h"
       FROM leads WHERE "deletedAt" IS NULL`,
      [recrawlHours, parkedRecheckDays],
    )) as Array<{
      pendingLive: number;
      staleRecrawl: number;
      parkedRecheckDue: number;
      crawledLast24h: number;
    }>;
    return {
      todo: {
        pendingLive: row?.pendingLive ?? 0,
        staleRecrawl: row?.staleRecrawl ?? 0,
        parkedRecheckDue: row?.parkedRecheckDue ?? 0,
      },
      done: { crawledLast24h: row?.crawledLast24h ?? 0 },
    };
  }

  /**
   * id → domain for a set of leads, ONE IN query — the pipeline view labels
   * queue jobs with the domain an operator recognizes, not a uuid.
   * withDeleted so a job referencing a soft-deleted lead still gets a label.
   */
  async domainsForLeadIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.leads.find({
      where: { id: In(ids) },
      select: ['id', 'domain'],
      withDeleted: true,
    });
    return new Map(rows.map((r) => [r.id, r.domain]));
  }

  async listIngestRuns(query: PaginationQueryDto) {
    const qb = this.runs.createQueryBuilder('r').orderBy('r.fileDate', 'DESC');
    const [items, total] = await paginateQueryBuilder(qb, {
      page: query.page,
      limit: query.limit,
      withCount: query.shouldCount,
    });
    return paginatedResponse(items, total, query.page, query.limit);
  }

  async getOne(id: string): Promise<Lead & { events: LeadOutreachEvent[] }> {
    const lead = await this.leads.findOne({ where: { id } });
    if (!lead) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Lead not found',
      });
    }
    const events = await this.events.find({
      where: { leadId: id },
      order: { occurredAt: 'DESC' },
    });
    return { ...lead, events };
  }

  async update(id: string, dto: UpdateLeadDto): Promise<Lead> {
    const lead = await this.leads.findOne({ where: { id } });
    if (!lead) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Lead not found',
      });
    }
    if (dto.status !== undefined) lead.status = dto.status;
    if (dto.notes !== undefined) lead.notes = dto.notes;
    if (dto.outreachEmail !== undefined) {
      lead.outreachEmail = dto.outreachEmail.toLowerCase();
    }
    // Present-with-null clears the rating; absent leaves it alone.
    if (dto.teamRating !== undefined) lead.teamRating = dto.teamRating;
    return this.leads.save(lead);
  }

  async listSuppressions(query: SuppressionFilterQueryDto) {
    const qb = this.suppressions
      .createQueryBuilder('s')
      .orderBy('s.createdAt', 'DESC');
    if (query.search) {
      qb.andWhere('s.email ILIKE :search', { search: `%${query.search}%` });
    }
    const [items, total] = await paginateQueryBuilder(qb, {
      page: query.page,
      limit: query.limit,
      withCount: query.shouldCount,
    });
    return paginatedResponse(items, total, query.page, query.limit);
  }

  async createSuppression(dto: CreateSuppressionDto): Promise<OutreachSuppression> {
    try {
      return await this.suppressions.save(
        this.suppressions.create({
          email: dto.email.toLowerCase(),
          reason: dto.reason ?? SuppressionReason.MANUAL,
          notes: dto.notes ?? null,
        }),
      );
    } catch (error) {
      // The constraint is the check — a SELECT-then-INSERT would race. Only
      // this table's unique violation becomes a 409; anything else stays a 500.
      if (isDuplicateSuppression(error)) {
        throw new ConflictException({
          code: ErrorCodes.CONFLICT,
          message: 'Email is already suppressed',
        });
      }
      throw error;
    }
  }

  async removeSuppression(id: string): Promise<{ removed: true }> {
    // Hard delete on purpose: a suppression an admin removes must actually
    // stop suppressing, and a soft-deleted row would still read as "never
    // mail this address" to anyone querying the table by hand.
    const result = await this.suppressions.delete(id);
    if (!result.affected) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Suppression not found',
      });
    }
    return { removed: true };
  }
}

/** True only for a unique violation on this table's email constraint. */
function isDuplicateSuppression(error: unknown): boolean {
  const candidate = error as {
    code?: string;
    constraint?: string;
    driverError?: { code?: string; constraint?: string };
  } | null;
  const code = candidate?.driverError?.code ?? candidate?.code;
  const constraint =
    candidate?.driverError?.constraint ?? candidate?.constraint;
  return code === '23505' && constraint === 'UQ_outreach_suppressions_email';
}

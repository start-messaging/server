import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { Tag } from './entities/tag.entity.js';

/**
 * A fact about an account that is calculated, never stored.
 *
 * `kind` separates these from manual tags in the UI, because the two behave
 * differently: a derived tag cannot be removed, only outgrown.
 */
export interface DerivedTag {
  kind: 'derived';
  key: string;
  label: string;
  colour: string;
}

/**
 * The numbers behind the derived tags, returned alongside them so a screen can
 * show "3 top-ups" and the actual figures without a second round trip.
 *
 * The 30-day window is deliberate: lifetime delivery rate hides a customer
 * whose sending broke last week, which is precisely the failure this platform
 * had and could not see.
 */
export interface UserMetrics {
  messages30d: number;
  delivered30d: number;
  failed30d: number;
  /** Null when nothing was sent in the window — not zero, which reads as broken. */
  deliveryRate30d: number | null;
  lifetimeMessages: number;
  lifetimeSpend: number;
  topupCount: number;
  topupTotal: number;
  balance: number;
  lastMessageAt: string | null;
  /** Messages still awaiting a receipt. Should sit near zero. */
  stuckCount: number;
}

export interface UserTagSummary {
  userId: string;
  manual: Tag[];
  derived: DerivedTag[];
  metrics: UserMetrics;
}

/** Top-up buckets. Zero is called out because it is the interesting one. */
function topupTag(count: number): DerivedTag {
  if (count === 0)
    return {
      kind: 'derived',
      key: 'topup:0',
      label: 'Never topped up',
      colour: 'red',
    };
  if (count === 1)
    return {
      kind: 'derived',
      key: 'topup:1',
      label: '1 top-up',
      colour: 'amber',
    };
  if (count === 2)
    return {
      kind: 'derived',
      key: 'topup:2',
      label: '2 top-ups',
      colour: 'amber',
    };
  if (count < 10)
    return {
      kind: 'derived',
      key: 'topup:3-9',
      label: `${count} top-ups`,
      colour: 'blue',
    };
  return {
    kind: 'derived',
    key: 'topup:10+',
    label: `${count} top-ups`,
    colour: 'green',
  };
}

/** Tenure buckets, from the account's own createdAt. */
function tenureTag(createdAt: Date, now: Date): DerivedTag {
  const days = Math.floor(
    (now.getTime() - new Date(createdAt).getTime()) / 86_400_000,
  );
  if (days < 7)
    return {
      kind: 'derived',
      key: 'age:new',
      label: 'New this week',
      colour: 'violet',
    };
  if (days < 30)
    return {
      kind: 'derived',
      key: 'age:30d',
      label: `${days}d old`,
      colour: 'violet',
    };
  if (days < 180)
    return {
      kind: 'derived',
      key: 'age:6m',
      label: `${Math.floor(days / 30)}mo old`,
      colour: 'blue',
    };
  if (days < 365)
    return {
      kind: 'derived',
      key: 'age:1y',
      label: '6-12mo old',
      colour: 'green',
    };
  return {
    kind: 'derived',
    key: 'age:1y+',
    label: '1y+ client',
    colour: 'green',
  };
}

/**
 * Health signals — the ones worth acting on rather than admiring.
 *
 * Each is deliberately absent when it does not apply, so a row carries only
 * what is true of it and a screenful of accounts can be scanned for problems.
 */
function healthTags(m: UserMetrics): DerivedTag[] {
  const tags: DerivedTag[] = [];

  // Below 70% is well outside normal: the platform as a whole runs above 90%,
  // so a customer under this has a template or a recipient-list problem.
  if (m.deliveryRate30d !== null && m.deliveryRate30d < 70) {
    tags.push({
      kind: 'derived',
      key: 'health:low-delivery',
      label: `${m.deliveryRate30d}% delivered`,
      colour: 'red',
    });
  }

  // Nothing sent in the window, but they have sent before — a churn signal,
  // distinct from an account that never started.
  if (m.messages30d === 0 && m.lifetimeMessages > 0) {
    tags.push({
      kind: 'derived',
      key: 'health:dormant',
      label: 'Dormant 30d',
      colour: 'amber',
    });
  }

  // Enough balance matters more than a round number: below roughly 200 OTPs
  // they will run out inside a busy day.
  if (m.balance < 50) {
    tags.push({
      kind: 'derived',
      key: 'health:low-balance',
      label: 'Low balance',
      colour: 'red',
    });
  }

  if (m.stuckCount > 0) {
    tags.push({
      kind: 'derived',
      key: 'health:unsettled',
      label: `${m.stuckCount} unsettled`,
      colour: 'amber',
    });
  }

  if (m.messages30d >= 1000) {
    tags.push({
      kind: 'derived',
      key: 'volume:high',
      label: 'High volume',
      colour: 'green',
    });
  }

  return tags;
}

/** A user with no rows anywhere still needs a well-formed metrics object. */
const EMPTY_METRICS = (): UserMetrics => ({
  messages30d: 0,
  delivered30d: 0,
  failed30d: 0,
  deliveryRate30d: null,
  lifetimeMessages: 0,
  lifetimeSpend: 0,
  topupCount: 0,
  topupTotal: 0,
  balance: 0,
  lastMessageAt: null,
  stuckCount: 0,
});

@Injectable()
export class TagsService {
  constructor(
    @InjectRepository(Tag) private readonly tagRepository: Repository<Tag>,
    private readonly dataSource: DataSource,
  ) {}

  async findAll(): Promise<Tag[]> {
    return this.tagRepository.find({
      where: { deletedAt: IsNull() },
      order: { name: 'ASC' },
    });
  }

  async create(data: {
    name: string;
    colour?: string;
    description?: string;
  }): Promise<Tag> {
    const name = data.name.trim();
    const clash = await this.tagRepository
      .createQueryBuilder('t')
      .where('LOWER(t.name) = LOWER(:name)', { name })
      .andWhere('t.deletedAt IS NULL')
      .getOne();
    if (clash) {
      throw new BadRequestException(
        `A tag named "${clash.name}" already exists`,
      );
    }

    return this.tagRepository.save(
      this.tagRepository.create({
        name,
        colour: data.colour ?? 'slate',
        description: data.description ?? null,
      }),
    );
  }

  /** Soft-delete, so history that referenced the tag stays readable. */
  async remove(id: string): Promise<void> {
    const result = await this.tagRepository.softDelete(id);
    if (!result.affected) throw new NotFoundException('Tag not found');
  }

  /**
   * Replaces a user's manual tags wholesale.
   *
   * Set semantics rather than add/remove calls: the panel edits the whole
   * chip row at once, and a diff computed on the client would race a second
   * admin editing the same account.
   */
  async setUserTags(
    userId: string,
    tagIds: string[],
    actingAdminId: string,
  ): Promise<Tag[]> {
    const unique = [...new Set(tagIds)];

    if (unique.length > 0) {
      const found = await this.tagRepository
        .createQueryBuilder('t')
        .where('t.id IN (:...ids)', { ids: unique })
        .andWhere('t.deletedAt IS NULL')
        .getMany();
      if (found.length !== unique.length) {
        throw new BadRequestException('One or more tags do not exist');
      }
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.query('DELETE FROM user_tags WHERE "userId" = $1', [
        userId,
      ]);
      if (unique.length > 0) {
        const values = unique
          .map((_, i) => `($1, $${i + 2}, $${unique.length + 2})`)
          .join(', ');
        await manager.query(
          `INSERT INTO user_tags ("userId", "tagId", "createdBy") VALUES ${values}`,
          [userId, ...unique, actingAdminId],
        );
      }
    });

    return this.getManualTags(userId);
  }

  async getManualTags(userId: string): Promise<Tag[]> {
    return this.tagRepository
      .createQueryBuilder('t')
      .innerJoin('user_tags', 'ut', 'ut."tagId" = t.id')
      .where('ut."userId" = :userId', { userId })
      .andWhere('t.deletedAt IS NULL')
      .orderBy('t.name', 'ASC')
      .getMany();
  }

  /**
   * Manual tags, derived tags and the metrics behind them, for a set of users.
   *
   * Batched deliberately: the callers are list screens, and asking per row
   * turned the customers table into N+1 queries the moment it had tags on it.
   * Three queries total regardless of how many users are passed.
   */
  async getSummaries(userIds: string[]): Promise<Map<string, UserTagSummary>> {
    const out = new Map<string, UserTagSummary>();
    if (userIds.length === 0) return out;

    const [manualRows, factRows] = await Promise.all([
      this.dataSource.query(
        `SELECT ut."userId", t.id, t.name, t.colour, t.description
           FROM user_tags ut
           JOIN tags t ON t.id = ut."tagId"
          WHERE ut."userId" = ANY($1) AND t."deletedAt" IS NULL
          ORDER BY t.name ASC`,
        [userIds],
      ),
      // One pass per user rather than a join across messages and payments:
      // joining them multiplies rows and silently inflates both counts.
      this.dataSource.query(
        `SELECT u.id AS "userId",
                u."createdAt",
                COALESCE(w.balance, 0) AS balance,
                COALESCE(p.topups, 0)  AS "topupCount",
                COALESCE(p.paid, 0)    AS "topupTotal",
                COALESCE(m.total, 0)   AS "lifetimeMessages",
                COALESCE(m.spend, 0)   AS "lifetimeSpend",
                COALESCE(m.recent, 0)  AS "messages30d",
                COALESCE(m.delivered, 0) AS "delivered30d",
                COALESCE(m.failed, 0)  AS "failed30d",
                COALESCE(m.stuck, 0)   AS "stuckCount",
                m."lastMessageAt"
           FROM users u
           LEFT JOIN wallets w ON w."userId" = u.id
           LEFT JOIN (
             SELECT "userId",
                    COUNT(*) FILTER (WHERE status = 'completed') AS topups,
                    COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) AS paid
               FROM payments GROUP BY "userId"
           ) p ON p."userId" = u.id
           LEFT JOIN (
             SELECT "userId",
                    COUNT(*) AS total,
                    COALESCE(SUM("costAmount"), 0) AS spend,
                    MAX("createdAt") AS "lastMessageAt",
                    COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '30 days') AS recent,
                    COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '30 days'
                                       AND status = 'delivered') AS delivered,
                    COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '30 days'
                                       AND status = 'failed') AS failed,
                    COUNT(*) FILTER (WHERE status = 'sent') AS stuck
               FROM messages GROUP BY "userId"
           ) m ON m."userId" = u.id
          WHERE u.id = ANY($1)`,
        [userIds],
      ),
    ]);

    const now = new Date();
    for (const id of userIds) {
      out.set(id, {
        userId: id,
        manual: [],
        derived: [],
        metrics: EMPTY_METRICS(),
      });
    }

    for (const r of manualRows as {
      userId: string;
      id: string;
      name: string;
      colour: string;
      description: string | null;
    }[]) {
      out.get(r.userId)?.manual.push({
        id: r.id,
        name: r.name,
        colour: r.colour,
        description: r.description,
      } as Tag);
    }

    for (const f of factRows as Record<string, string | Date | null>[]) {
      const entry = out.get(f.userId as string);
      if (!entry) continue;

      const messages30d = Number(f.messages30d);
      const delivered30d = Number(f.delivered30d);
      const metrics: UserMetrics = {
        messages30d,
        delivered30d,
        failed30d: Number(f.failed30d),
        // Null, not zero, when nothing was sent — a silent account is not a
        // failing one, and colouring it red would bury the real failures.
        deliveryRate30d:
          messages30d > 0
            ? Math.round((delivered30d / messages30d) * 100)
            : null,
        lifetimeMessages: Number(f.lifetimeMessages),
        lifetimeSpend: Number(f.lifetimeSpend),
        topupCount: Number(f.topupCount),
        topupTotal: Number(f.topupTotal),
        balance: Number(f.balance),
        lastMessageAt: f.lastMessageAt
          ? new Date(f.lastMessageAt as Date).toISOString()
          : null,
        stuckCount: Number(f.stuckCount),
      };

      entry.metrics = metrics;
      entry.derived = [
        topupTag(metrics.topupCount),
        tenureTag(f.createdAt as Date, now),
        ...healthTags(metrics),
      ];
    }

    return out;
  }
}

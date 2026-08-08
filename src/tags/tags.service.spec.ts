import { DataSource } from 'typeorm';
import { TagsService } from './tags.service.js';
import { Tag } from './entities/tag.entity.js';
import { User } from '../users/entities/user.entity.js';

/**
 * Run against a restore of production, because the metrics query is the whole
 * feature and the interesting failures are shape failures — a join that
 * multiplies rows, a COUNT that becomes a string, a user with no wallet.
 * A seeded three-row fixture would not surface any of them.
 */
const DB_NAME = process.env.TEST_DB_NAME ?? 'sm_fixtest';
if (!/test/i.test(DB_NAME)) {
  throw new Error(`Refusing to run against non-test database '${DB_NAME}'`);
}

/** createdBy is a uuid column, so the acting admin must look like one. */
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

describe('TagsService', () => {
  let ds: DataSource;
  let tags: TagsService;
  let userId: string;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.TEST_DB_HOST ?? '127.0.0.1',
      port: Number(process.env.TEST_DB_PORT ?? 5432),
      username: process.env.TEST_DB_USER ?? 'postgres',
      database: DB_NAME,
      entities: [Tag, User],
      synchronize: false,
      logging: false,
    });
    await ds.initialize();
    tags = new TagsService(ds.getRepository(Tag), ds);

    const [u] = await ds.query(
      `insert into users (email, "firstName", "lastName", role, "isActive")
       values ($1, 'Tag', 'Test', 'customer', true) returning id`,
      [`tags-${Date.now()}@test.invalid`],
    );
    userId = u.id;
  }, 30_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query('delete from user_tags where "userId" = $1', [userId]);
    await ds.query(`delete from tags where name like 'ZZ-test-%'`);
    await ds.query('delete from users where id = $1', [userId]);
    await ds.destroy();
  });

  const makeTag = (suffix: string) =>
    tags.create({ name: `ZZ-test-${suffix}-${Date.now()}`, colour: 'blue' });

  it('refuses a duplicate name regardless of case', async () => {
    const tag = await tags.create({ name: `ZZ-test-dup-${Date.now()}` });
    await expect(tags.create({ name: tag.name.toUpperCase() })).rejects.toThrow(
      /already exists/,
    );
  });

  it('replaces the whole tag set rather than appending', async () => {
    const a = await makeTag('a');
    const b = await makeTag('b');
    const c = await makeTag('c');

    await tags.setUserTags(userId, [a.id, b.id], ADMIN_ID);
    await tags.setUserTags(userId, [c.id], ADMIN_ID);

    const names = (await tags.getManualTags(userId)).map((t) => t.name);
    expect(names).toEqual([c.name]);
  });

  it('tolerates duplicate ids in one call', async () => {
    const a = await makeTag('dupset');
    await tags.setUserTags(userId, [a.id, a.id, a.id], ADMIN_ID);
    expect(await tags.getManualTags(userId)).toHaveLength(1);
  });

  it('clears every tag when given an empty set', async () => {
    const a = await makeTag('clear');
    await tags.setUserTags(userId, [a.id], ADMIN_ID);
    await tags.setUserTags(userId, [], ADMIN_ID);
    expect(await tags.getManualTags(userId)).toHaveLength(0);
  });

  it('rejects a tag id that does not exist, changing nothing', async () => {
    const a = await makeTag('keep');
    await tags.setUserTags(userId, [a.id], ADMIN_ID);

    await expect(
      tags.setUserTags(
        userId,
        [a.id, '00000000-0000-4000-8000-000000000000'],
        ADMIN_ID,
      ),
    ).rejects.toThrow(/do not exist/);

    // Validation runs before the delete, so the existing set survives.
    expect(await tags.getManualTags(userId)).toHaveLength(1);
  });

  it('returns well-formed metrics for a user with no activity at all', async () => {
    const summary = (await tags.getSummaries([userId])).get(userId)!;

    expect(summary.metrics.messages30d).toBe(0);
    // Null, not zero: a silent account is not a failing one.
    expect(summary.metrics.deliveryRate30d).toBeNull();
    expect(summary.metrics.balance).toBe(0);
    expect(summary.derived.map((d) => d.key)).toContain('topup:0');
    // No messages ever, so "dormant" must not fire — that is for churn.
    expect(summary.derived.map((d) => d.key)).not.toContain('health:dormant');
  });

  it('computes real metrics against restored production data', async () => {
    const [busiest] = await ds.query(
      `select "userId", count(*) as n from messages
        group by "userId" order by n desc limit 1`,
    );
    const summary = (await tags.getSummaries([busiest.userId])).get(
      busiest.userId,
    )!;

    // The lifetime count must match a plain COUNT: if the payments join
    // multiplied rows, this is where it shows.
    expect(summary.metrics.lifetimeMessages).toBe(Number(busiest.n));

    if (summary.metrics.messages30d > 0) {
      expect(summary.metrics.deliveryRate30d).toBeGreaterThanOrEqual(0);
      expect(summary.metrics.deliveryRate30d).toBeLessThanOrEqual(100);
    }
    expect(Number.isFinite(summary.metrics.topupCount)).toBe(true);
    expect(summary.derived.length).toBeGreaterThanOrEqual(2);
  });

  it('batches many users without losing any', async () => {
    const rows = await ds.query(
      `select id from users order by "createdAt" desc limit 25`,
    );
    const ids = rows.map((r: { id: string }) => r.id);
    const summaries = await tags.getSummaries(ids);

    expect(summaries.size).toBe(ids.length);
    for (const id of ids) {
      expect(summaries.get(id)!.metrics).toBeDefined();
    }
  });
});

import { DataSource } from 'typeorm';
import { MessagesService } from './messages.service.js';
import { Message, MessageStatus } from './entities/message.entity.js';
import { WalletService } from '../wallet/wallet.service.js';
import { Wallet } from '../wallet/entities/wallet.entity.js';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity.js';
import { User } from '../users/entities/user.entity.js';
import { OtpTemplate } from '../channels/entities/otp-template.entity.js';
import { Channel } from '../channels/entities/channel.entity.js';

/**
 * Exercises the reconciliation path against a real Postgres, because the part
 * that was broken in production is the interaction between status transition
 * and wallet debit — both inside one transaction — and an in-memory double
 * would prove nothing about either.
 *
 * Point it at a scratch database. It refuses to run anywhere whose name does
 * not look like a test database, since the developer machines here hold a
 * restore of production.
 */
const DB_NAME = process.env.TEST_DB_NAME ?? 'sm_fixtest';
const DB_HOST = process.env.TEST_DB_HOST ?? '127.0.0.1';
const DB_USER = process.env.TEST_DB_USER ?? 'postgres';

if (!/test/i.test(DB_NAME)) {
  throw new Error(
    `Refusing to run tests against non-test database '${DB_NAME}'`,
  );
}

const OTP_COST = 0.25;

/** Verbatim production responses, same fixtures as the parser unit tests. */
const DELIVERED_DLR = {
  status: 'delivered' as const,
  description: 'DELIVERED',
  deliveredAt: new Date('2026-08-07T10:15:55.000Z'),
  senderId: 'STMSG',
  smsCount: 1,
  rawResponse: { statusDesc: 'DELIVERED', errorId: '0' },
};

const BARRED_DLR = {
  status: 'failed' as const,
  description: 'FAILED(BARRED)',
  failureReason: 'Message delivery failed due to message service barring',
  senderId: 'STMSG',
  rawResponse: { statusDesc: 'FAILED(BARRED)', errorId: '154' },
};

const UNKNOWN_DLR = { status: 'unknown' as const };

describe('delivery reconciliation (integration)', () => {
  let ds: DataSource;
  let messages: MessagesService;
  let wallets: WalletService;
  let dlr: any;
  let userId: string;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: DB_HOST,
      port: Number(process.env.TEST_DB_PORT ?? 5432),
      username: DB_USER,
      password: process.env.TEST_DB_PASSWORD ?? undefined,
      database: DB_NAME,
      entities: [
        Message,
        Wallet,
        WalletTransaction,
        User,
        OtpTemplate,
        Channel,
      ],
      synchronize: false,
      logging: false,
    });
    await ds.initialize();

    wallets = new WalletService(
      ds.getRepository(Wallet),
      ds.getRepository(WalletTransaction),
      ds.getRepository(User),
      ds,
      { sendLowBalanceAlert: jest.fn(), sendEmail: jest.fn() } as any,
    );

    const providerFactory = {
      getDeliveryStatus: jest.fn(() => Promise.resolve(dlr)),
    } as any;

    messages = new MessagesService(
      ds.getRepository(Message),
      providerFactory,
      wallets,
      ds,
    );
  }, 30_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query('delete from messages where "phoneNumber" = $1', [
        '+910000000000',
      ]);
      await ds.query(
        'delete from wallet_transactions where "walletId" in (select id from wallets where "userId" = $1)',
        [userId],
      );
      await ds.query('delete from wallets where "userId" = $1', [userId]);
      await ds.query('delete from users where id = $1', [userId]);
      await ds.destroy();
    }
  });

  beforeEach(async () => {
    const [user] = await ds.query(
      `insert into users (email, "firstName", "lastName", role, "isActive")
       values ($1, 'Recon', 'Test', 'customer', true) returning id`,
      [`reconcile-${Date.now()}-${Math.random()}@test.invalid`],
    );
    userId = user.id;
    // `version` backs optimistic locking on the wallet and has no default, so
    // the seed has to supply it the way the entity would.
    await ds.query(
      'insert into wallets ("userId", balance, version) values ($1, $2, 1)',
      [userId, 10],
    );
  });

  /** A message frozen exactly as production leaves them: sent, cost 0. */
  async function seedStuckMessage(): Promise<Message> {
    return messages.create({
      userId,
      phoneNumber: '+910000000000',
      content: 'OTP sent',
      provider: '2factor',
      providerMsgId: `test-${Date.now()}-${Math.random()}`,
      status: MessageStatus.SENT,
      costAmount: 0,
      metadata: { intendedCost: OTP_COST },
    });
  }

  const balance = async (): Promise<number> => {
    const [row] = await ds.query(
      'select balance from wallets where "userId" = $1',
      [userId],
    );
    return Number(row.balance);
  };

  it('settles a delivered message and debits the wallet once', async () => {
    dlr = DELIVERED_DLR;
    const message = await seedStuckMessage();

    const updated = await messages.syncProviderStatus(message.id);

    expect(updated.status).toBe(MessageStatus.DELIVERED);
    expect(Number(updated.costAmount)).toBe(OTP_COST);
    expect(await balance()).toBeCloseTo(10 - OTP_COST, 4);
  });

  it('does not double-charge when the sweep sees the same message again', async () => {
    dlr = DELIVERED_DLR;
    const message = await seedStuckMessage();

    await messages.syncProviderStatus(message.id);
    await messages.syncProviderStatus(message.id);

    // The debit is guarded on the *transition* into DELIVERED, so a second
    // sweep — or a webhook arriving late — must not bill again.
    expect(await balance()).toBeCloseTo(10 - OTP_COST, 4);
  });

  it('settles a barred message as failed and charges nothing', async () => {
    dlr = BARRED_DLR;
    const message = await seedStuckMessage();

    const updated = await messages.syncProviderStatus(message.id);

    expect(updated.status).toBe(MessageStatus.FAILED);
    expect(Number(updated.costAmount)).toBe(0);
    expect(updated.failureReason).toContain('barring');
    expect(await balance()).toBe(10);
  });

  it('leaves a message alone when the provider has no answer', async () => {
    dlr = UNKNOWN_DLR;
    const message = await seedStuckMessage();

    const updated = await messages.syncProviderStatus(message.id);

    expect(updated.status).toBe(MessageStatus.SENT);
    expect(await balance()).toBe(10);
  });

  it('preserves intendedCost through the update', async () => {
    dlr = DELIVERED_DLR;
    const message = await seedStuckMessage();

    await messages.syncProviderStatus(message.id);
    const [row] = await ds.query(
      'select metadata from messages where id = $1',
      [message.id],
    );

    // The report used to be written over the whole metadata object, which
    // discarded intendedCost — and intendedCost is what the debit reads.
    expect(row.metadata.intendedCost).toBe(OTP_COST);
    expect(row.metadata.report_payload).toBeDefined();
  });

  const sweepWindow = () =>
    messages.findStaleSent(
      new Date(Date.now() - 48 * 3_600_000),
      new Date(Date.now() - 10 * 60_000),
      100_000,
    );

  it('finds stale sent messages and skips ones inside the grace window', async () => {
    dlr = UNKNOWN_DLR;
    const fresh = await seedStuckMessage();
    const old = await seedStuckMessage();
    await ds.query(
      `update messages set "createdAt" = now() - interval '2 hours' where id = $1`,
      [old.id],
    );

    const stale = await sweepWindow();
    const ids = stale.map((m) => m.id);

    expect(ids).toContain(old.id);
    expect(ids).not.toContain(fresh.id);
    // Oldest first, so a backlog drains in the order it accumulated.
    expect(stale.map((m) => +m.createdAt)).toEqual(
      [...stale.map((m) => +m.createdAt)].sort((a, b) => a - b),
    );
  });

  it('returns the joined template to admins, and hides internals from customers', async () => {
    dlr = UNKNOWN_DLR;
    // Deliberately a soft-deleted template: they are retired that way here,
    // and the admin history must still name the template a message was sent
    // with after it is retired.
    const [tpl] = await ds.query(
      `select id, name from otp_templates where "deletedAt" is not null limit 1`,
    );
    const message = await messages.create({
      userId,
      phoneNumber: '+910000000000',
      content: 'OTP sent',
      provider: '2factor',
      providerMsgId: `tpl-${Date.now()}`,
      status: MessageStatus.FAILED,
      costAmount: 0,
      otpTemplateId: tpl.id,
      renderedContent: 'Your ACME OTP is ****. Do not share.',
      failureReason: 'The message could not be delivered to this number.',
      providerFailureReason: 'REJECTD',
      metadata: { intendedCost: OTP_COST },
    });

    const [dbRow] = await ds.query(
      'select "otpTemplateId" from messages where id = $1',
      [message.id],
    );
    expect(dbRow.otpTemplateId).toBe(tpl.id);

    const [rows] = await messages.findByUserAdmin(userId, 1, 50);
    const admin = rows.find((m) => m.id === message.id)!;

    // Admin sees the template by name — a bare UUID would be unreadable in
    // the panel — plus the provider's own wording.
    expect(admin.otpTemplate?.name).toBe(tpl.name);
    expect(admin.providerFailureReason).toBe('REJECTD');
    expect(admin.renderedContent).toContain('ACME');

    // The same row through the customer projection carries none of the
    // values. Asserted on the values rather than key absence: `findById`
    // returns a TypeORM entity instance and the class declares every column,
    // so unselected ones exist as own properties holding `undefined`.
    // JSON.stringify omits those, so nothing reaches the wire.
    const customer = (await messages.findById(message.id, userId))!;
    for (const field of [
      'providerFailureReason',
      'renderedContent',
      'provider',
      'providerMsgId',
      'metadata',
    ] as const) {
      expect(customer[field]).toBeUndefined();
    }
    expect(JSON.parse(JSON.stringify(customer))).not.toHaveProperty(
      'providerFailureReason',
    );
    expect(customer.failureReason).not.toMatch(/REJECTD/);
  });

  it('finds a number across all customers, without leaking user secrets', async () => {
    dlr = UNKNOWN_DLR;
    const message = await messages.create({
      userId,
      phoneNumber: '+910000000000',
      content: 'OTP sent',
      provider: '2factor',
      providerMsgId: `search-${Date.now()}`,
      status: MessageStatus.FAILED,
      costAmount: 0,
      providerFailureReason: 'Access Denied - Balance is too low',
      metadata: { intendedCost: OTP_COST },
    });

    // Searched the way an operator would paste it, with spaces and no country
    // code — the lookup normalises to digits.
    const [rows] = await messages.searchAllAdmin(1, 50, {
      phoneNumber: '00000 00000',
    });
    const found = rows.find((m) => m.id === message.id)!;

    expect(found).toBeDefined();
    expect(found.user?.email).toContain('@test.invalid');
    expect(found.providerFailureReason).toBe(
      'Access Denied - Balance is too low',
    );

    // The join must never carry credentials into an HTTP response.
    const serialised = JSON.parse(JSON.stringify(found));
    expect(serialised.user).not.toHaveProperty('passwordHash');
    expect(serialised.user).not.toHaveProperty('refreshTokenHash');
  });

  it('credits a wallet for a manual admin top-up and records it in the ledger', async () => {
    const tx = await wallets.credit(
      userId,
      500,
      'Goodwill credit - failed sends on 2026-08-07',
      'admin_topup',
      'admin-uuid | ticket #412',
    );

    expect(Number(tx.balanceAfter)).toBeCloseTo(510, 4);
    expect(await balance()).toBeCloseTo(510, 4);

    const [row] = await ds.query(
      `select t.type, t.amount, t.description, t."referenceType", t."referenceId"
         from wallet_transactions t
         join wallets w on w.id = t."walletId"
        where w."userId" = $1 and t."referenceType" = 'admin_topup'`,
      [userId],
    );

    // A manual credit is the one path that creates balance with no payment
    // behind it, so it has to be attributable and legible in the ledger.
    expect(row.type).toBe('credit');
    expect(Number(row.amount)).toBe(500);
    expect(row.description).toContain('Goodwill');
    expect(row.referenceId).toContain('ticket #412');
  });

  it('excludes messages older than the provider keeps reports for', async () => {
    dlr = UNKNOWN_DLR;
    const ancient = await seedStuckMessage();
    await ds.query(
      `update messages set "createdAt" = now() - interval '30 days' where id = $1`,
      [ancient.id],
    );

    const ids = (await sweepWindow()).map((m) => m.id);

    // Without this bound the sweep runs oldest-first into rows the provider
    // can never answer, re-asking about the same ones every cycle and never
    // reaching the recent messages it could still settle. The restored dump
    // carries hundreds of exactly these.
    expect(ids).not.toContain(ancient.id);
  });

  it('leaves nothing from the restored production backlog in the sweep window', async () => {
    // Sanity check on the bound above, against real data rather than fixtures.
    const stale = await sweepWindow();
    const cutoff = Date.now() - 48 * 3_600_000;

    expect(stale.every((m) => +m.createdAt >= cutoff)).toBe(true);
  });
});

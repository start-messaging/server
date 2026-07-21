import { INestApplication } from '@nestjs/common';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createTestApp } from '../helpers/create-test-app';
import { registerUser } from '../helpers/auth';
import { WalletService } from '../../src/wallet/wallet.service';
import { Wallet } from '../../src/wallet/entities/wallet.entity';
import { WalletTransaction } from '../../src/wallet/entities/wallet-transaction.entity';

describe('Wallet — micros ledger and concurrency', () => {
  let app: INestApplication;
  let wallets: WalletService;
  let walletRepo: Repository<Wallet>;
  let txRepo: Repository<WalletTransaction>;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    wallets = app.get(WalletService);
    walletRepo = app.get(getRepositoryToken(Wallet));
    txRepo = app.get(getRepositoryToken(WalletTransaction));
  });

  afterAll(async () => {
    await app.close();
  });

  it('credits and debits in integer micros with a running balance', async () => {
    const user = await registerUser(app, 'wal'); // starts with ₹10 = 10_000_000
    await wallets.credit(user.id, 5_000_000, 'topup');
    await wallets.debit(user.id, 2_000_000, 'usage');

    const wallet = await walletRepo.findOne({ where: { userId: user.id } });
    expect(Number(wallet?.balance)).toBe(13_000_000); // 10 + 5 - 2 (₹)
  });

  it('rejects a debit that exceeds the balance', async () => {
    const user = await registerUser(app, 'wal');
    await expect(
      wallets.debit(user.id, 999_000_000, 'too much'),
    ).rejects.toThrow();
  });

  it('serialises concurrent debits and never oversells', async () => {
    const user = await registerUser(app, 'wal');
    // Reset to a known balance: credit up to exactly 1_000_000 available.
    const wallet0 = await walletRepo.findOne({ where: { userId: user.id } });
    await wallets.debit(user.id, Number(wallet0?.balance), 'zero it');
    await wallets.credit(user.id, 1_000_000, 'seed');

    // 12 concurrent debits of 100_000 → only 10 can succeed.
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        wallets.debit(user.id, 100_000, 'concurrent'),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    expect(ok).toBe(10);
    expect(failed).toBe(2);

    const wallet = await walletRepo.findOne({ where: { userId: user.id } });
    expect(Number(wallet?.balance)).toBe(0);
    expect(Number(wallet?.balance)).toBeGreaterThanOrEqual(0);

    const txCount = await txRepo.count({ where: { walletId: wallet!.id } });
    // 1 zero-out debit + 1 seed credit + 10 successful debits (plus the welcome credit).
    expect(txCount).toBeGreaterThanOrEqual(12);
  });
});

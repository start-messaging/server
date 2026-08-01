import { DataSource } from 'typeorm';
import { config } from 'dotenv';

config();

export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST,
  port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  database: process.env.DATABASE_NAME,
  username: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  entities: ['dist/**/*.entity.js'],
  migrations: ['dist/database/migrations/*.js'],
  /**
   * One transaction per migration, not one for the whole run (TypeORM's
   * default).
   *
   * `CREATE INDEX` and `ADD CONSTRAINT ... FOREIGN KEY` take locks that block
   * writes to the table they touch. Under the default, those locks are held
   * from the first statement of the first pending migration until the last one
   * commits — so deploying two migrations together stalls writes to `messages`
   * and `users` for the sum of both, not for the few hundred milliseconds each
   * one actually needs. Per-migration transactions release each lock as soon as
   * that migration is done.
   *
   * The trade-off is that a failure part-way leaves earlier migrations applied.
   * That is the better failure for this codebase: the migrations here are
   * written to be re-runnable, and a stuck lock on a live table is worse than a
   * partially-advanced schema.
   */
  migrationsTransactionMode: 'each',
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
});

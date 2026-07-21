/**
 * Freeze `new Date()` / `Date.now()` to a fixed instant without touching timer
 * functions (so pg/redis internals keep working). Returns a restore function.
 */
/**
 * ISO timestamp for a given day-of-month in the CURRENT real month (noon UTC).
 * Call before freezing so window tests stay valid regardless of run date.
 */
export function isoForDayOfMonth(day: number): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, 12, 0, 0),
  ).toISOString();
}

export function freezeDate(iso: string): () => void {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();

  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(fixed);
      } else {
        // @ts-expect-error forward constructor args
        super(...args);
      }
    }
    static now(): number {
      return fixed;
    }
  }

  global.Date = FakeDate as DateConstructor;
  return () => {
    global.Date = RealDate;
  };
}

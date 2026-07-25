import {
  computeConvenienceFee,
  microsToPaise,
  paiseToMicros,
} from '../../src/payments/fee.util';

describe('Payments — convenience fee (customer fee bearer)', () => {
  it('adds a 2% fee + 18% GST on top of the base for the customer', () => {
    // ₹1000 base = 1_000_000_000 micros.
    const fee = computeConvenienceFee(1_000_000_000, {
      feePercent: 2,
      gstPercent: 18,
      bearer: 'customer',
    });
    expect(fee.baseMicros).toBe(1_000_000_000);
    expect(fee.convenienceFeeMicros).toBe(20_000_000); // 2% of ₹1000 = ₹20
    expect(fee.gstMicros).toBe(3_600_000); // 18% of ₹20 = ₹3.60
    expect(fee.totalMicros).toBe(1_023_600_000); // ₹1023.60 charged
  });

  it('charges only the base when the platform bears the fee', () => {
    const fee = computeConvenienceFee(1_000_000_000, {
      feePercent: 2,
      gstPercent: 18,
      bearer: 'platform',
    });
    expect(fee.convenienceFeeMicros).toBe(0);
    expect(fee.gstMicros).toBe(0);
    expect(fee.totalMicros).toBe(1_000_000_000);
  });

  it('converts micros ↔ paise correctly (1 paisa = 10,000 micros)', () => {
    expect(microsToPaise(1_023_600_000)).toBe(102_360); // ₹1023.60 → paise
    expect(paiseToMicros(102_360)).toBe(1_023_600_000);
  });
});

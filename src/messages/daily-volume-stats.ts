/**
 * Describing how many SMS are handled in a day: the mean, the median and the
 * mode of the daily counts.
 *
 * The mode needs a note. Daily volumes are in the hundreds or thousands and
 * almost never repeat exactly — a month of days can have thirty different
 * counts, so "the most frequent value" is thirty-way tie and tells nobody
 * anything. What a person means by "the usual day" is the most common
 * *volume band*, so the mode is taken over fixed-width bands (1,000–1,199, say)
 * sized to the spread of the data. An exact mode is reported too, but only when
 * a count really does repeat.
 */

export interface DailyCount {
  date: string;
  total: number;
}

export interface DailyVolumeStats {
  /** Days the figures are computed over. Today is never one: it is unfinished. */
  completeDays: number;
  /** Sum over those days. */
  total: number;
  mean: number;
  median: number;
  /** The most common volume band, with how many days fell in it. */
  mode: { from: number; to: number; days: number; width: number };
  /** A count that occurs on more than one day, if any does. */
  exactMode: { value: number; days: number } | null;
  min: DailyCount;
  max: DailyCount;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A band width that is a round number and gives roughly ten bands across the
 * data: 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000… Whole numbers only,
 * since the counts being banded are.
 */
export function bandWidth(spread: number): number {
  const target = Math.max(1, spread / 10);
  let magnitude = 10 ** Math.floor(Math.log10(target));
  for (;;) {
    for (const step of [1, 2, 2.5, 5]) {
      const width = step * magnitude;
      if (Number.isInteger(width) && width >= target) return width;
    }
    magnitude *= 10;
  }
}

function medianOf(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** `null` when there are no days to describe. */
export function describeDailyVolume(days: DailyCount[]): DailyVolumeStats | null {
  if (days.length === 0) return null;

  const totals = days.map((d) => d.total);
  const sorted = [...totals].sort((a, b) => a - b);
  const sum = totals.reduce((a, b) => a + b, 0);
  const median = medianOf(sorted);

  // Bands, counted by the day's band index.
  const width = bandWidth(sorted[sorted.length - 1] - sorted[0]);
  const perBand = new Map<number, number>();
  for (const t of totals) {
    const index = Math.floor(t / width);
    perBand.set(index, (perBand.get(index) ?? 0) + 1);
  }
  // Fullest band; on a tie, the one nearest the median, then the higher one.
  const [modeIndex, modeDays] = [...perBand.entries()].sort(
    (a, b) =>
      b[1] - a[1] ||
      Math.abs(a[0] * width + width / 2 - median) -
        Math.abs(b[0] * width + width / 2 - median) ||
      b[0] - a[0],
  )[0];

  const perValue = new Map<number, number>();
  for (const t of totals) perValue.set(t, (perValue.get(t) ?? 0) + 1);
  // An exact mode only when one value clearly repeats the most. Several values
  // tied for most-repeated is a multimodal month, and naming one of them would
  // be choosing arbitrarily — the band mode above is the honest answer then.
  const mostRepeats = Math.max(...perValue.values());
  const winners = [...perValue.entries()].filter(([, n]) => n === mostRepeats);
  const repeated = mostRepeats > 1 && winners.length === 1 ? winners[0] : undefined;

  // Only the date and the count are kept: callers pass richer day objects, and
  // what comes back is part of an API response, not a window onto its input.
  let min = days[0];
  let max = days[0];
  for (const d of days) {
    if (d.total < min.total) min = d;
    if (d.total > max.total) max = d;
  }

  return {
    completeDays: days.length,
    total: sum,
    mean: round2(sum / days.length),
    median,
    mode: {
      from: modeIndex * width,
      to: modeIndex * width + width - 1,
      days: modeDays,
      width,
    },
    exactMode: repeated ? { value: repeated[0], days: repeated[1] } : null,
    min: { date: min.date, total: min.total },
    max: { date: max.date, total: max.total },
  };
}

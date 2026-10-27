/**
 * Defaults for the payment reconciliation sweep.
 *
 * Constants and not environment settings: these are tuning, not deployment
 * differences, and a value that can be changed without a deploy is a value
 * that can be changed to something wrong without review.
 */

/**
 * How far back an unpaid order is still worth asking the gateway about.
 *
 * Three days: long enough to catch a payment that settled late (some UPI and
 * netbanking payments are confirmed hours after the customer pays) and one
 * missed over a weekend, short enough that the sweep's cost stays bounded by
 * recent volume rather than by every order ever abandoned. Anything older is
 * reachable by an admin running the sweep by hand with a longer window.
 */
export const RECONCILE_LOOKBACK_HOURS = 72;

/**
 * An order younger than this is left alone.
 *
 * The browser callback arrives within seconds of a successful payment. Asking
 * the gateway about an order that is still mid-checkout is a wasted call, and
 * the row lock already makes the race harmless, so this is about cost, not
 * correctness.
 */
export const RECONCILE_MIN_AGE_MINUTES = 3;

/**
 * The most orders asked about in one sweep, newest first.
 *
 * Newest first because the likeliest uncredited payment is the one made a few
 * minutes ago, by a customer who is looking at an unchanged balance now.
 * One gateway API call per order, made one at a time, so this bounds a run's
 * duration and the pressure put on the gateway's rate limit.
 */
export const RECONCILE_MAX_PER_RUN = 100;

/** Cron pattern for the scheduled sweep: every five minutes, all day. */
export const RECONCILE_CRON = '*/5 * * * *';

/**
 * How long an authorised-but-uncaptured payment is given before it is reported.
 *
 * The gateway's automatic capture can take up to twelve minutes after the bank
 * authorises, so a payment seen in that state a few minutes after checkout is
 * normal, not a misconfiguration. Reporting it would raise a false alarm on
 * most payments. Thirty minutes is comfortably past that window: an order still
 * only authorised by then means capture is not happening.
 */
export const RECONCILE_AUTHORIZED_GRACE_MINUTES = 30;

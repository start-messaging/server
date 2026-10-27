/**
 * What counts as money received from a customer, as a SQL predicate over a
 * `wallet_transactions` row aliased `t`.
 *
 * One definition, used by everything that asks "how much have customers paid
 * us" — the dashboard's collections and chart, and each customer's top-up
 * count — so they cannot disagree about it. Before it was shared, the dashboard
 * and the per-customer figures each read the `payments` table (app checkouts
 * only), and a payment received outside the app and credited by hand appeared
 * in neither: a customer who had paid showed as "Never topped up".
 *
 * Counted, from the ledger:
 *  - `payment`: a Razorpay checkout settled by the app;
 *  - `admin_payment`: a payment received outside the app and credited by hand
 *    with the reason "payment";
 *  - older manual credits (`admin_topup`) whose description says "Payment
 *    received". The reason was not recorded before, and that sentence is what
 *    the top-up screen's own preset wrote, so it is the evidence there is.
 *    Rewriting ledger rows to tag them was weighed and rejected: the ledger is
 *    the record of money, and a predicate costs nothing.
 *
 * Not counted: welcome credits, goodwill and promotional credits (nobody paid
 * for them), debits and refunds. Amounts are what the wallet was credited, not
 * what the card was charged — the gateway's fee is not revenue.
 */
export const COLLECTION_CREDIT_PREDICATE = `(
  t."type" = 'credit' AND (
    t."referenceType" IN ('payment', 'admin_payment')
    OR (t."referenceType" = 'admin_topup'
        AND t."description" LIKE 'Payment received%')
  )
)`;

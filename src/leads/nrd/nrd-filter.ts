/**
 * Pure domain-classification logic for the NRD ingest.
 *
 * Kept free of Nest and I/O so the rules that decide what enters the leads
 * table can be unit-tested against a text file of real NRD lines without a
 * database or a network.
 */

export interface ClassifyOptions {
  /**
   * TLDs that are India by construction (LEADS_TLD_ALLOWLIST — the env name
   * predates the semantic, kept for continuity; e.g. in, co.in). Ingested
   * unconditionally with isIndian = true.
   */
  indianTlds: Set<string>;
  /**
   * Global TLDs where the country is unknowable from the name alone
   * (LEADS_KEYWORD_TLDS; com, net, org, …). .co/.io/.ai are technically
   * ccTLDs but are marketed globally, so they belong here, not in the
   * blocklist. ALWAYS kept once the lexical junk filter passes: the NRD feed
   * files expire in ~10 days, so a domain skipped today is lost forever —
   * we cannot detect which generic-TLD registrations are Indian from the
   * name, so we ingest them all and let the crawler decide the country
   * later. Keywords/India-tokens no longer gate entry; they only add to the
   * score (crawl priority) and, for India tokens, establish isIndian.
   */
  genericTlds: Set<string>;
  /**
   * Foreign ccTLDs dropped outright (LEADS_BLOCKED_TLDS). A German or
   * Pakistani country domain is near-certainly not an Indian prospect;
   * dropping them saves rows and crawl budget.
   */
  blockedTlds: Set<string>;
  keywords: string[];
  /**
   * India-betraying tokens (LEADS_INDIA_TOKENS): city names, "india",
   * "bharat", … A hit in the second-level label admits a generic-TLD domain
   * and marks it Indian from the name alone.
   */
  indiaTokens: string[];
}

export interface ClassifyResult {
  keep: boolean;
  /** Normalized domain, present whenever the line parsed as one. */
  domain?: string;
  /** Effective TLD — compound (co.in) when configured, else the last label. */
  tld?: string;
  /** Configured keywords + India tokens appearing in the second-level label. */
  score: number;
  /**
   * true when India is established from the name alone (Indian TLD or an
   * India token in the label); null means "unknown, let enrichment decide".
   * Never false: absence of evidence in a domain name is not evidence.
   */
  isIndian: true | null;
}

/**
 * Splits a comma-separated env value into a normalized set.
 * Trims, lowercases, strips leading dots ('.in' and 'in' mean the same TLD),
 * and drops empties so a trailing comma cannot admit the empty string.
 */
export function parseCsvList(csv: string): Set<string> {
  const out = new Set<string>();
  for (const raw of csv.split(',')) {
    const value = raw.trim().toLowerCase().replace(/^\.+/, '');
    if (value) out.add(value);
  }
  return out;
}

/** Shape of a plausible registrable domain. Anything else is line noise. */
const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

/**
 * Does `token` stand alone in `sld`, delimited on both sides?
 *
 * A domain label has no spaces, so the extractor's `\b` trick cannot be reused
 * — the delimiters available are the ends of the label, a hyphen, or a digit.
 *
 * Requiring BOTH sides is deliberate and it is the strict half of a deliberate
 * trade. One side is not enough: "designstudio" and "goalsetter" both open with
 * a token ("desi", "goa") exactly the way "mumbaitraders" opens with "mumbai",
 * so a start-of-label rule cannot tell a city from an English word. Demanding
 * both sides drops the false ones — and drops "mumbaitraders" and "indiamart"
 * with them.
 *
 * That loss is affordable in a way the false positives were not. A domain that
 * fails here still enters the pipeline, still scores on the loose substring
 * match so it keeps its place near the front of the crawl queue, and
 * enrichment then reads the site itself — where a real Indian business is
 * giving itself away with a ₹ price, an IN phone number or a Razorpay SDK.
 * Nothing recovers from a wrong `true`.
 */
function containsTokenAtBoundary(sld: string, token: string): boolean {
  const isEdge = (c: string) => c === '' || c === '-' || /\d/.test(c);

  for (let from = 0; from <= sld.length - token.length; from += 1) {
    const at = sld.indexOf(token, from);
    if (at === -1) return false;

    const before = at === 0 ? '' : sld[at - 1];
    const afterIndex = at + token.length;
    const after = afterIndex >= sld.length ? '' : sld[afterIndex];

    if (isEdge(before) && isEdge(after)) return true;
    from = at;
  }
  return false;
}

/**
 * Decides whether one NRD line becomes a lead.
 *
 * The lexical filter exists because the daily file is mostly DGA and spam
 * registrations: random consonant strings, digit soup, hyphen chains. Those
 * fail at least one of the checks below, while a real business name — even a
 * transliterated Hindi one — passes all of them.
 *
 * TLD precedence, applied after the lexical filter:
 *   blockedTlds → drop; indianTlds → keep, isIndian true; genericTlds → keep
 *   unconditionally (see ClassifyOptions.genericTlds — a skipped domain is
 *   lost forever once the feed file expires); any TLD in no list → drop. The
 *   default-deny at the end is what keeps the spam TLDs (.xyz, .top, .icu, …)
 *   out even under ingest-all: those zones are abuse-dominated — bulk DGA and
 *   phishing registrations, near-zero real Indian SMBs — so they are worth
 *   neither the rows nor the crawl budget. The blocklist additionally
 *   documents intent and guards against someone later adding a foreign ccTLD
 *   to genericTlds.
 */
export function classifyDomain(
  raw: string,
  opts: ClassifyOptions,
): ClassifyResult {
  const domain = raw.trim().toLowerCase().replace(/\.$/, '');

  // Punycode (xn--) has near-zero prospect value here: an IDN registration is
  // almost never a reachable Indian business with an email address.
  if (!DOMAIN_PATTERN.test(domain) || domain.includes('xn--')) {
    return { keep: false, score: 0, isIndian: null };
  }

  const labels = domain.split('.');

  // Effective TLD: the last two labels when that compound is configured in
  // any set (so co.in works), otherwise the last label alone.
  const lastTwo = labels.slice(-2).join('.');
  const compound =
    labels.length >= 2 &&
    (opts.indianTlds.has(lastTwo) ||
      opts.genericTlds.has(lastTwo) ||
      opts.blockedTlds.has(lastTwo));
  const tld = compound ? lastTwo : labels[labels.length - 1];
  const sld = compound ? labels[labels.length - 3] : labels[labels.length - 2];

  // 'co.in' itself, or a bare TLD line — nothing left to be a business name.
  if (!sld) {
    return { keep: false, domain, tld, score: 0, isIndian: null };
  }

  const hyphens = (sld.match(/-/g) ?? []).length;
  const digits = (sld.match(/\d/g) ?? []).length;
  const lexicalPass =
    sld.length >= 3 &&
    sld.length <= 30 &&
    hyphens <= 2 &&
    digits <= 2 &&
    /[aeiou]/.test(sld);

  const keywordHits = opts.keywords.filter((k) => k && sld.includes(k)).length;
  const tokenHits = opts.indiaTokens.filter((t) => t && sld.includes(t)).length;
  // India-token matches count toward the score too, so an India-named domain
  // sorts above an equally-keyworded generic one in the enrichment queue.
  // Deliberately the loose substring count: score only decides queue order,
  // where being wrong costs a place in a line. The country verdict below uses
  // the strict test instead, because being wrong there is permanent.
  const score = keywordHits + tokenHits;

  // The verdict is held to a higher bar than the score.
  //
  // `sld.includes(token)` was establishing the country outright, and the token
  // list contains ordinary English fragments: `desi` sits inside "design",
  // "designer" and "desire"; `goa` inside "goal" and "goat"; `pune` inside
  // "neptune". On the development database that had permanently marked ~1,956
  // non-.in domains India-confirmed — about 58% of every name-derived verdict —
  // led by the word "design".
  //
  // The asymmetry is what settles the rule. A false negative is cheap and
  // self-correcting: the domain enters as `null` and enrichment can still
  // establish India from the page itself (a ₹ price, an IN phone number, a
  // Razorpay SDK). A false positive is neither — nothing downstream ever
  // downgrades isIndian, so the domain is cold-emailed as an Indian business
  // forever. So the verdict requires the token to sit at a name boundary
  // rather than anywhere inside a word. "mumbaitraders" and "shop-delhi-online"
  // still qualify; "designstudio" no longer does.
  const strictTokenHits = opts.indiaTokens.filter(
    (t) => t && containsTokenAtBoundary(sld, t),
  ).length;

  if (!lexicalPass || opts.blockedTlds.has(tld)) {
    return { keep: false, domain, tld, score, isIndian: null };
  }

  if (opts.indianTlds.has(tld)) {
    return { keep: true, domain, tld, score, isIndian: true };
  }

  if (opts.genericTlds.has(tld)) {
    // Ingest-all: every lexically-plausible generic-TLD domain enters. The
    // feed files expire in ~10 days, so gating on keywords here meant a real
    // business named nothing like our keyword list was lost forever — kept,
    // it merely waits its turn in the crawl queue. A generic TLD tells us
    // nothing about the country; only an India token in the name itself
    // establishes it here, everything else stays null for enrichment.
    return {
      keep: true,
      domain,
      tld,
      score,
      isIndian: strictTokenHits >= 1 ? true : null,
    };
  }

  return { keep: false, domain, tld, score, isIndian: null };
}

/**
 * Priority order for the ingest's insert cap: India-confirmed first, then by
 * name score, then stable (Array.prototype.sort is stable, so equal-priority
 * domains keep file order). Exported pure so the cap's behaviour — which end
 * of the day's file a cut discards — is unit-testable.
 */
export function compareIngestPriority(
  a: { score: number; isIndian: true | null },
  b: { score: number; isIndian: true | null },
): number {
  const indiaA = a.isIndian === true ? 1 : 0;
  const indiaB = b.isIndian === true ? 1 : 0;
  if (indiaA !== indiaB) return indiaB - indiaA;
  return b.score - a.score;
}

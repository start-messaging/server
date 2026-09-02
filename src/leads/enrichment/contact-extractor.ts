/**
 * Pure HTML → contacts/qualification extraction for the enrichment crawler.
 *
 * Regex over strings rather than a DOM parser on purpose: the input is
 * whatever a day-old domain serves — half-broken templates, parked pages,
 * WAF interstitials — and a strict parser dies exactly where the data is.
 * Nothing here touches the network, so the whole ruleset is unit-testable.
 */

// The /max metadata bundle deliberately: the default ('min') bundle validates
// numbers by length pattern only, so garbage like '12345678' parses as a
// "valid" +9112345678. /max carries the full per-range tables, and dropping
// false positives is the entire reason this validator exists.
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

export interface ExtractedContacts {
  emails: string[];
  phones: string[];
  whatsapp: string[];
  title: string | null;
  description: string | null;
  /**
   * Same-site paths worth a follow-up fetch, contact pages before about
   * pages — the enrichment service follows at most two, and a contact page
   * is likelier to carry an address than an about page.
   */
  followPaths: string[];
  signals: string[];
  qualificationScore: number;
  /**
   * Every India signal the page matched, strong and weak — persisted so the
   * team can see WHY a lead was marked Indian, not just that it was.
   */
  indiaSignals: string[];
  isIndianHint: boolean;
}

/**
 * qualificationScore = COUNT of distinct verified signals (0–5).
 *
 * This replaced a weighted sum (auth 3, payments 2, …): the weights implied a
 * precision the evidence didn't have — nothing ever established that a login
 * form is worth exactly 1.5 payment integrations. Each signal is now a
 * structurally-verified fact (see detectVerifiedSignals), and the score is
 * just how many distinct facts were verified: an honest integer the team can
 * read as "N things on this site are real".
 *
 * Exported so the enrichment services can re-score after merging one page's
 * signals with another's.
 */
export function scoreSignals(signals: string[]): number {
  return new Set(signals).size;
}

// ---------------------------------------------------------------------------
// Structural qualification signals
//
// Each signal is a checkable fact found in ATTRIBUTES / URLS / ELEMENTS,
// never free text. The word "razorpay" in a blog post is NOT an integration;
// a <script src="https://checkout.razorpay.com/…"> is. This replaced a
// substring scan over the whole lowercased page, which is exactly how parked
// registrar templates and comparison articles were scoring as qualified.
//
// The fuzzy word-based 'transactional' signal ("booking", "delivery", …) was
// REMOVED outright: there is no structural fact behind those words.
// ---------------------------------------------------------------------------

/** src=/data-src= attribute values — where SDK scripts and iframes point. */
const SRC_ATTR_PATTERN = /\b(?:src|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** <form action="…"> values only — the auth check reads the form's target. */
const FORM_ACTION_PATTERN =
  /<form\b[^>]*\baction\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * India-only payment processors' actual integration endpoints (checkout
 * scripts, payment buttons, JS SDKs). Attribute values only — matching these
 * in prose would recreate the word-scan this replaced.
 */
const PAYMENT_SDK_URL_PATTERN =
  /(?:checkout\.razorpay\.com|razorpay\.com\/payment-button|js\.paytm\.com|securegw[a-z0-9-]*\.paytm\.in|jssdk\.payu\.in|payu\.in\/js|sdk\.cashfree\.com|checkout\.phonepe\.com)/;

/**
 * A password input is the one element every real auth flow must render.
 * NOTE (tier 2): SPAs often build this input only in the rendered DOM, not
 * the served HTML — the browser tier feeds page.content() through this same
 * extractor, so it picks up exactly these DOM-only facts for free.
 */
const PASSWORD_INPUT_PATTERN = /<input\b[^>]*\btype\s*=\s*["']?password["']?/i;

/** An action path a login/registration form posts to. */
const AUTH_ACTION_PATTERN = /\/(?:login|signin|register)\b/;

/** class="… woocommerce …" — the theme's own body/widget classes. */
const WOOCOMMERCE_CLASS_PATTERN = /\bclass\s*=\s*["'][^"']*\bwoocommerce/i;

/** An href whose path is the cart itself, not a word containing 'cart'. */
const CART_HREF_PATTERN = /\/cart(?:[/?#]|$)/;

/**
 * The structural signal scan. `hrefs` are the (lowercased, entity-decoded)
 * anchor targets extractContacts already walks for contacts.
 */
function detectVerifiedSignals(html: string, hrefs: string[]): string[] {
  const srcUrls: string[] = [];
  for (const match of html.matchAll(SRC_ATTR_PATTERN)) {
    const url = (match[1] ?? match[2] ?? '').trim().toLowerCase();
    if (url) srcUrls.push(url);
  }
  const formActions: string[] = [];
  for (const match of html.matchAll(FORM_ACTION_PATTERN)) {
    const action = (match[1] ?? match[2] ?? '').trim().toLowerCase();
    if (action) formActions.push(action);
  }
  const urls = [...srcUrls, ...hrefs];

  const signals: string[] = [];

  // 'payments': a script/iframe/link URL on a processor's integration host.
  if (urls.some((u) => PAYMENT_SDK_URL_PATTERN.test(u))) {
    signals.push('payments');
  }

  // 'auth': a rendered password input, or a form posting to /login-ish. The
  // word "login" in nav text proves nothing and no longer counts.
  if (
    PASSWORD_INPUT_PATTERN.test(html) ||
    formActions.some((a) => AUTH_ACTION_PATTERN.test(a))
  ) {
    signals.push('auth');
  }

  // 'ecommerce': Shopify asset URLs, WooCommerce classes/plugin paths, or a
  // link to the cart / an add-to-cart action.
  if (
    urls.some(
      (u) =>
        u.includes('cdn.shopify.com') ||
        u.includes('.myshopify.com') ||
        u.includes('wp-content/plugins/woocommerce'),
    ) ||
    WOOCOMMERCE_CLASS_PATTERN.test(html) ||
    hrefs.some((h) => CART_HREF_PATTERN.test(h) || h.includes('add-to-cart'))
  ) {
    signals.push('ecommerce');
  }

  // 'whatsapp': a wa.me / api.whatsapp.com link — already structural before
  // this rewrite, unchanged. A site pushing WhatsApp is a future WABA
  // prospect even when the number itself fails validation.
  if (
    hrefs.some((h) => h.includes('wa.me/') || h.includes('api.whatsapp.com'))
  ) {
    signals.push('whatsapp');
  }

  // 'mobile_app': a store listing link — already structural, unchanged.
  if (
    hrefs.some(
      (h) =>
        h.includes('play.google.com/store/apps') ||
        h.includes('apps.apple.com'),
    )
  ) {
    signals.push('mobile_app');
  }

  return signals;
}

const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
/** The whole-string variant, for candidates assembled from parts. */
const EMAIL_EXACT_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const HREF_PATTERN = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * The plain-text sweep's exclusions: asset filenames that happen to contain
 * an @ (image@2x.png), template placeholders, and the builder/monitoring junk
 * (sentry, wixpress, w3.org) that appears verbatim in generated pages.
 */
function isJunkEmail(email: string): boolean {
  if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?)$/i.test(email)) return true;
  return (
    email.includes('example.com') ||
    email.includes('yourdomain') ||
    email.startsWith('email@') ||
    email.includes('sentry') ||
    email.includes('wixpress') ||
    email.includes('w3.org')
  );
}

/** Decodes the five entities that actually appear in titles/descriptions. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Real phone validation over every candidate, default country IN.
 *
 * Returns the E.164 form or null. This replaced a "keep + and digits, require
 * at least 8" normalizer, which happily stored order ids and prices as phone
 * numbers — libphonenumber's range tables are the false-positive killer: an
 * invalid candidate is dropped, not stored in a softer shape.
 */
function validatePhone(raw: string): string | null {
  const parsed = parsePhoneNumberFromString(raw, 'IN');
  if (!parsed || !parsed.isValid()) return null;
  return parsed.format('E.164');
}

/** Dedupes preserving order and caps the list — a footer with 40 mailtos
 * should not turn into a 40-element jsonb column. */
function dedupeCapped(values: string[], cap = 10): string[] {
  return [...new Set(values)].slice(0, cap);
}

// ---------------------------------------------------------------------------
// JSON-LD contact cards
//
// Site builders (Wix, Shopify, most SEO plugins) emit a machine-readable
// contact card in <script type="application/ld+json"> — parsing it beats any
// amount of regex, because the builder already did the labelling for us.
// ---------------------------------------------------------------------------

const JSON_LD_PATTERN =
  /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * @type values that mean "this node describes the business itself" — plus
 * anything ending in 'Business', which covers schema.org's whole
 * LocalBusiness subtree (HealthAndBeautyBusiness, SportsActivityLocation's
 * siblings, …) without enumerating it.
 */
const JSON_LD_BUSINESS_TYPES = new Set([
  'Organization',
  'LocalBusiness',
  'Store',
  'Restaurant',
  'MedicalBusiness',
  'ProfessionalService',
]);

interface JsonLdContactCard {
  telephones: string[];
  emails: string[];
  addressCountries: string[];
  addressLocalities: string[];
  postalCodes: string[];
}

/** Coerces a JSON-LD property that may be a string, number or array of them. */
function asStrings(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items
    .filter((v): v is string | number => {
      return typeof v === 'string' || typeof v === 'number';
    })
    .map(String);
}

function walkJsonLd(
  node: unknown,
  card: JsonLdContactCard,
  depth: number,
): void {
  // Depth cap: the input is a stranger's page; a pathological self-nested
  // blob must cost a bounded amount of stack, not all of it.
  if (depth > 8 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, card, depth + 1);
    return;
  }

  const obj = node as Record<string, unknown>;
  const rawType = obj['@type'];
  const types = Array.isArray(rawType) ? rawType : rawType ? [rawType] : [];
  const isBusiness = types.some(
    (t) =>
      typeof t === 'string' &&
      (JSON_LD_BUSINESS_TYPES.has(t) || t.endsWith('Business')),
  );

  if (isBusiness) {
    card.telephones.push(...asStrings(obj.telephone));
    card.emails.push(...asStrings(obj.email));
    const addresses = Array.isArray(obj.address) ? obj.address : [obj.address];
    for (const address of addresses) {
      if (address === null || typeof address !== 'object') continue;
      const a = address as Record<string, unknown>;
      card.addressCountries.push(...asStrings(a.addressCountry));
      card.addressLocalities.push(...asStrings(a.addressLocality));
      card.postalCodes.push(...asStrings(a.postalCode));
    }
  }

  // Recurse into every value, so @graph arrays and nested nodes are all seen.
  for (const value of Object.values(obj)) walkJsonLd(value, card, depth + 1);
}

function collectJsonLdContacts(html: string): JsonLdContactCard {
  const card: JsonLdContactCard = {
    telephones: [],
    emails: [],
    addressCountries: [],
    addressLocalities: [],
    postalCodes: [],
  };
  for (const match of html.matchAll(JSON_LD_PATTERN)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      // Builders emit broken JSON-LD too (trailing commas, template
      // leftovers). Each block parses or dies alone; one bad block must not
      // cost us a good one next to it.
      continue;
    }
    walkJsonLd(parsed, card, 0);
  }
  return card;
}

// ---------------------------------------------------------------------------
// Obfuscated emails
//
// People obfuscate precisely to beat scrapers, so the address behind
// 'info [at] shop [dot] in' is usually a real, monitored inbox — worth more
// than most mailto: links.
// ---------------------------------------------------------------------------

/**
 * Bracket/paren style: the AT is written [at] or (at); the dots may be
 * written [dot]/(dot) or left as real dots ('info [at] shop.co.in').
 */
const BRACKET_OBFUSCATED_EMAIL_PATTERN =
  /([a-z0-9._%+-]+)\s*(?:\[\s*at\s*\]|\(\s*at\s*\))\s*((?:[a-z0-9-]+\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\.)\s*)+[a-z]{2,})/gi;

/**
 * Bare-word style: 'sales AT bigmart DOT com'. Word-boundary and
 * case-insensitive; both separators must be present as words, so ordinary
 * prose containing a lone ' at ' cannot fabricate an address.
 */
const WORDY_OBFUSCATED_EMAIL_PATTERN =
  /\b([a-z0-9._%+-]+)\s+at\s+((?:[a-z0-9-]+\s+dot\s+)+[a-z]{2,})\b/gi;

/** '[dot]'/'(dot)'/' dot ' → '.', then every space goes. */
function deobfuscateDomain(raw: string): string {
  return raw
    .replace(/\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\))\s*/gi, '.')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s+/g, '');
}

/** Devanagari block (U+0900–U+097F): Hindi/Marathi text on the page. */
const DEVANAGARI_PATTERN = /[ऀ-ॿ]/;

/** Names of the weak India signals; anything else in indiaSignals is strong. */
const WEAK_INDIA_SIGNALS = new Set(['india_text', 'city', 'inr', 'pincode']);

/**
 * The hint rule — any strong signal, or at least 2 distinct weak ones.
 * Exported (like scoreSignals) so the enrichment service can re-derive the
 * hint over the union of a landing page's and a contact page's signals: two
 * weak signals split across two pages are still two independent observations
 * of the same site.
 */
export function indiaHintFromSignals(indiaSignals: string[]): boolean {
  let strong = 0;
  let weak = 0;
  for (const s of new Set(indiaSignals)) {
    if (WEAK_INDIA_SIGNALS.has(s)) weak += 1;
    else strong += 1;
  }
  return strong > 0 || weak >= 2;
}

/**
 * Indian PIN codes start 1–8 (9 is unassigned). Alone this pattern is just
 * "any 6-digit number" — a price, an order id — hence it is only ever a WEAK
 * signal that needs a second, independent one before it means anything.
 *
 * The `(?<!#)` is not decoration. A six-digit CSS hex colour is exactly six
 * digits preceded by a word boundary, so `#123456` satisfied this pattern and
 * every site with a numeric hex colour in its stylesheet carried a `pincode`
 * India signal. On the development database that was 242 of 1,383 crawled
 * leads, 215 of them with no strong signal at all — and a second weak signal
 * (an `inr` string, a city name in a script blob) is enough to flip a lead to
 * isIndian, which nothing in the pipeline can undo.
 */
const PINCODE_PATTERN = /(?<!#)\b[1-8][0-9]{5}\b/;

/**
 * Strips `<style>` bodies and inline `style="…"` values.
 *
 * Used only where a signal is about what a *reader* would see. CSS is full of
 * six-digit runs and of English words that collide with the city list, and
 * none of it is the site telling us where it is. Scripts are deliberately left
 * alone: the structural `payments` signal keys off `<script src>` attributes,
 * and JSON-LD contact cards live inside a script tag.
 */
function withoutStyles(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/\bstyle\s*=\s*"[^"]*"/gi, ' ')
    .replace(/\bstyle\s*=\s*'[^']*'/gi, ' ');
}

/**
 * India-detection over the extracted page.
 *
 * STRONG signals — any single one establishes the hint:
 *   phone_91     a phone/whatsapp number libphonenumber attributes to IN
 *   gstin        a GSTIN mention (India-only tax id)
 *   rupee        ₹ in text, or its &#8377; / &#x20B9; entities
 *   devanagari   Devanagari script anywhere on the page
 *   payments_in  the structural 'payments' signal (a razorpay/payu/paytm/
 *                cashfree/phonepe SDK URL in an attribute) — those processors
 *                are all India-only, so a verified integration with one is a
 *                strong country signal too. Structural now, like the fit
 *                signal it keys off: the WORD razorpay in prose no longer
 *                marks a site Indian
 *   email_in     an extracted email address ending .in
 *   address_in   a JSON-LD PostalAddress whose addressCountry is IN/India —
 *                the site's own structured data saying where it is
 *
 * WEAK signals — at least 2 DISTINCT ones are needed:
 *   india_text   the word india/indian in text
 *   city         an entry from the configured indiaTokens list in text or in
 *                a JSON-LD addressLocality
 *   inr          the currency code INR
 *   pincode      a 6-digit PIN-shaped number (see PINCODE_PATTERN)
 */
function detectIndiaSignals(
  html: string,
  lower: string,
  extracted: {
    emails: string[];
    phones: string[];
    whatsapp: string[];
    signals: string[];
  },
  jsonLd: JsonLdContactCard,
  indiaTokens: string[],
): { indiaSignals: string[]; isIndianHint: boolean } {
  const strong: string[] = [];
  const weak: string[] = [];

  // The lists hold validated E.164 numbers, so the parser's country
  // attribution is authoritative — this replaced a startsWith('91') check
  // that a Zimbabwean-looking digit blob could satisfy by accident.
  if (
    [...extracted.phones, ...extracted.whatsapp].some(
      (p) => parsePhoneNumberFromString(p)?.country === 'IN',
    )
  ) {
    strong.push('phone_91');
  }
  if (lower.includes('gstin')) strong.push('gstin');
  if (
    lower.includes('₹') ||
    lower.includes('&#8377;') ||
    lower.includes('&#x20b9;')
  ) {
    strong.push('rupee');
  }
  if (DEVANAGARI_PATTERN.test(html)) strong.push('devanagari');
  if (extracted.signals.includes('payments')) strong.push('payments_in');
  if (extracted.emails.some((e) => e.endsWith('.in'))) strong.push('email_in');
  if (jsonLd.addressCountries.some((c) => /^(in|india)$/i.test(c.trim()))) {
    strong.push('address_in');
  }

  if (/\bindia(n)?\b/.test(lower)) weak.push('india_text');
  // 'india'/'indian' from the token list already count as india_text; the
  // remaining tokens (cities and India-names) are matched on word boundaries
  // so 'goa' cannot hide inside 'goat'. A JSON-LD addressLocality naming one
  // of the same cities counts identically — it is the same observation made
  // in structured form.
  const cityTokens = indiaTokens.filter(
    (t) => t && t !== 'india' && t !== 'indian',
  );
  if (
    cityTokens.some((t) => new RegExp(`\\b${t}\\b`).test(lower)) ||
    jsonLd.addressLocalities.some((l) =>
      cityTokens.some((t) => new RegExp(`\\b${t}\\b`, 'i').test(l)),
    )
  ) {
    weak.push('city');
  }
  if (/\binr\b/.test(lower)) weak.push('inr');
  if (
    PINCODE_PATTERN.test(withoutStyles(lower)) ||
    jsonLd.postalCodes.some((p) => PINCODE_PATTERN.test(p))
  ) {
    weak.push('pincode');
  }

  const indiaSignals = [...strong, ...weak];
  return {
    indiaSignals,
    isIndianHint: indiaHintFromSignals(indiaSignals),
  };
}

/**
 * `indiaTokens` is the configured LEADS_INDIA_TOKENS list, passed in by the
 * enrichment service — this function stays pure, no config reads inside.
 */
export function extractContacts(
  html: string,
  indiaTokens: string[] = [],
): ExtractedContacts {
  const lower = html.toLowerCase();

  // <title>
  let title: string | null = null;
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch) {
    const decoded = collapseWhitespace(decodeEntities(titleMatch[1]));
    title = decoded ? decoded.slice(0, 500) : null;
  }

  // <meta name="description" content="…"> — both attribute orders, because
  // generators disagree about which comes first.
  let description: string | null = null;
  const descMatch =
    /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(
      html,
    ) ??
    /<meta\b[^>]*\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*\bname\s*=\s*["']description["']/i.exec(
      html,
    );
  if (descMatch) {
    const decoded = collapseWhitespace(
      decodeEntities(descMatch[1] ?? descMatch[2] ?? ''),
    );
    description = decoded || null;
  }

  const emails: string[] = [];
  const phones: string[] = [];
  const whatsapp: string[] = [];
  const contactPaths: string[] = [];
  const aboutPaths: string[] = [];
  /** Every anchor target, lowercased — the structural signal scan's input. */
  const allHrefs: string[] = [];

  for (const match of html.matchAll(HREF_PATTERN)) {
    const href = decodeEntities((match[1] ?? match[2] ?? '').trim());
    if (!href) continue;
    const hrefLower = href.toLowerCase();
    allHrefs.push(hrefLower);

    if (hrefLower.startsWith('mailto:')) {
      const address = href.slice(7).split('?')[0].trim().toLowerCase();
      if (EMAIL_EXACT_PATTERN.test(address) && !isJunkEmail(address)) {
        emails.push(address);
      }
      continue;
    }

    if (hrefLower.startsWith('tel:')) {
      // decodeURIComponent throws URIError on a lone or malformed '%', which
      // a stranger's hand-written markup supplies often enough to matter
      // (`tel:+91 98765 43210 %`, `tel:50%off`). extractContacts is called
      // unguarded from LeadEnrichmentService.enrich, whose outer catch marks
      // the lead FAILED — so one malformed tel: link on a landing page
      // permanently disqualified a site that was otherwise fine, contacts and
      // all. The raw href is still worth trying: validatePhone strips
      // punctuation anyway, so an undecoded '%20' costs nothing.
      let candidate = href.slice(4);
      try {
        candidate = decodeURIComponent(candidate);
      } catch {
        // Malformed escape — fall through with the raw value.
      }
      const phone = validatePhone(candidate);
      if (phone) phones.push(phone);
      continue;
    }

    const waMatch =
      /wa\.me\/(\+?\d[\d]*)/i.exec(href) ??
      (hrefLower.includes('api.whatsapp.com/send')
        ? /[?&]phone=(\+?\d+)/i.exec(href)
        : null);
    if (waMatch) {
      const number = validatePhone(waMatch[1]);
      if (number) whatsapp.push(number);
      continue;
    }

    // Follow-page discovery. Relative hrefs only: extractContacts never
    // learns which domain the html came from, so a relative path is the only
    // link that is provably same-site — an absolute URL containing 'contact'
    // is as likely to be the builder's or a social network's page. About
    // pages count too, second in line: on builder templates the footer
    // address often lives there when no contact page exists.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//')) {
      const path = href.split('#')[0];
      if (path.toLowerCase().includes('contact')) {
        contactPaths.push(path);
      } else if (path.toLowerCase().includes('about')) {
        aboutPaths.push(path);
      }
    }
  }

  // Plain-text sweep for addresses written outside anchors.
  for (const match of html.matchAll(EMAIL_PATTERN)) {
    const address = match[0].toLowerCase();
    if (!isJunkEmail(address)) emails.push(address);
  }

  // De-obfuscation sweep: reconstructed addresses face the same validation
  // and junk filters as every other candidate.
  for (const pattern of [
    BRACKET_OBFUSCATED_EMAIL_PATTERN,
    WORDY_OBFUSCATED_EMAIL_PATTERN,
  ]) {
    for (const match of html.matchAll(pattern)) {
      const address =
        `${match[1]}@${deobfuscateDomain(match[2])}`.toLowerCase();
      if (EMAIL_EXACT_PATTERN.test(address) && !isJunkEmail(address)) {
        emails.push(address);
      }
    }
  }

  // JSON-LD contact card: the builder's own labelled telephone/email fields,
  // through the same validators as the scraped candidates.
  const jsonLd = collectJsonLdContacts(html);
  for (const telephone of jsonLd.telephones) {
    const phone = validatePhone(telephone);
    if (phone) phones.push(phone);
  }
  for (const email of jsonLd.emails) {
    const address = email.trim().toLowerCase();
    if (EMAIL_EXACT_PATTERN.test(address) && !isJunkEmail(address)) {
      emails.push(address);
    }
  }

  // Structural, attribute-level detection — the words on the page play no
  // part in qualification anymore (see detectVerifiedSignals).
  const signals = detectVerifiedSignals(html, allHrefs);

  const cappedEmails = dedupeCapped(emails);
  const cappedPhones = dedupeCapped(phones);
  const cappedWhatsapp = dedupeCapped(whatsapp);

  const { indiaSignals, isIndianHint } = detectIndiaSignals(
    html,
    lower,
    {
      emails: cappedEmails,
      phones: cappedPhones,
      whatsapp: cappedWhatsapp,
      signals,
    },
    jsonLd,
    indiaTokens,
  );

  return {
    emails: cappedEmails,
    phones: cappedPhones,
    whatsapp: cappedWhatsapp,
    title,
    description,
    followPaths: dedupeCapped([...contactPaths, ...aboutPaths], 3),
    signals,
    qualificationScore: scoreSignals(signals),
    indiaSignals,
    isIndianHint,
  };
}

/**
 * Union of two extractions of the same site (landing + contact page, or a
 * fetched page + a browser-rendered one), re-scored over the merged signals.
 * Lives here rather than in a service because it is pure and both the fetch
 * tier and the browser tier persist through it.
 */
export function mergeExtractions(
  main: ExtractedContacts,
  extra: ExtractedContacts,
): ExtractedContacts {
  const signals = [...new Set([...main.signals, ...extra.signals])];
  const indiaSignals = [
    ...new Set([...main.indiaSignals, ...extra.indiaSignals]),
  ];
  return {
    emails: [...new Set([...main.emails, ...extra.emails])].slice(0, 10),
    phones: [...new Set([...main.phones, ...extra.phones])].slice(0, 10),
    whatsapp: [...new Set([...main.whatsapp, ...extra.whatsapp])].slice(0, 10),
    title: main.title ?? extra.title,
    description: main.description ?? extra.description,
    followPaths: main.followPaths,
    signals,
    qualificationScore: scoreSignals(signals),
    indiaSignals,
    // Re-derived over the union — two weak signals split across the landing
    // and contact pages are still two observations of the same site.
    isIndianHint: indiaHintFromSignals(indiaSignals),
  };
}

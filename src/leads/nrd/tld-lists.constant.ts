/**
 * The curated lists the NRD ingest classifier and the enrichment extractor
 * run on.
 *
 * These were `LEADS_TLD_ALLOWLIST`, `LEADS_KEYWORD_TLDS`, `LEADS_BLOCKED_TLDS`,
 * `LEADS_KEYWORDS` and `LEADS_INDIA_TOKENS`. They are here instead because they
 * are curated data, not deployment configuration: no environment ever wanted a
 * different answer to "is .de an Indian prospect", and an env var made that
 * knowledge invisible to review. It also existed twice — `nrd-filter.spec.ts`
 * carried its own hardcoded copy of all five lists, described as "the shipped
 * defaults", which nothing kept in step with the real ones. The spec imports
 * these now, so a list can no longer be tested against a value it does not use.
 *
 * Kept as CSV strings rather than arrays so every reader still goes through
 * `parseCsvList`, which lowercases, strips leading dots and de-duplicates. That
 * normalisation is what the classifier's `.has()` lookups assume, and it is one
 * function rather than five hand-written arrays that have to stay tidy.
 */

/**
 * TLDs that are India by construction, ingested unconditionally with
 * `isIndian = true`. ~2k domains/day is a workable queue for a small team,
 * where all-TLDs would be 400k/day of mostly junk.
 *
 * Adding a generic TLD here marks every domain under it as Indian — that is
 * what this list means. Generic TLDs belong in GENERIC_TLDS_CSV below.
 */
export const INDIAN_TLDS_CSV = 'in,co.in';

/**
 * Global TLDs where the country is unknowable from the name — they enter only
 * on a keyword or India-token hit, with `isIndian` left for enrichment unless
 * the name itself says India. `.co`/`.io`/`.ai` are technically ccTLDs but
 * marketed globally, so they live here.
 */
export const GENERIC_TLDS_CSV =
  'com,net,org,io,co,ai,app,dev,shop,store,online,site,tech';

/**
 * Foreign ccTLDs dropped outright: a German or Pakistani country domain is
 * near-certainly not an Indian prospect, and dropping them saves rows and crawl
 * budget. The classifier default-denies unknown TLDs anyway — this list
 * documents intent and guards against someone later adding a foreign ccTLD to
 * GENERIC_TLDS_CSV.
 */
export const BLOCKED_TLDS_CSV =
  'uk,de,fr,it,nl,es,pt,pl,ru,ua,cz,gr,ro,hu,at,ch,be,se,no,dk,fi,ie,' +
  'cn,jp,kr,vn,th,my,ph,sg,tw,hk,br,mx,ar,cl,pe,tr,ae,sa,qa,kw,om,' +
  'bh,eg,ng,ke,za,au,nz,ca,us,il,pk,bd,lk,np,mm';

/** Commercial-intent tokens in a domain name — what admits a generic TLD. */
export const INGEST_KEYWORDS_CSV =
  'otp,verify,login,shop,store,pay,app,clinic,school,college,hotel,travel,' +
  'logistics,bazaar,mart,kirana,salon,gym,restaurant,cafe,boutique';

/**
 * India-betraying tokens — "india", "bharat", major city names. Shared by two
 * stages: the ingest filter admits and marks generic-TLD domains whose name
 * contains one, and the enrichment extractor uses the same list for its
 * city-in-text weak signal.
 */
export const INDIA_TOKENS_CSV =
  'india,indian,bharat,desi,hindustan,mumbai,delhi,bangalore,bengaluru,' +
  'chennai,kolkata,hyderabad,pune,jaipur,ahmedabad,surat,lucknow,' +
  'kanpur,nagpur,indore,bhopal,patna,gurgaon,gurugram,noida,kochi,' +
  'goa,chandigarh';

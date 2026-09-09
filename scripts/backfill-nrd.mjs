/**
 * ONE-OFF BACKFILL — delete after running.
 *
 * Fetches the last N days (default 10) of WhoisDS NRD files and ingests them
 * with the CURRENT ingest-all filter, straight into whatever database this
 * shell's env points at. Exists because every day that ran before ingest-all
 * was extracted with the old keyword gate — mostly .in — and the daily feed
 * files expire in ~10 days, so this is the last chance to pull the generic-TLD
 * domains those days skipped.
 *
 * Safe to re-run: leads insert with ON CONFLICT (domain) DO NOTHING (existing
 * rows are never touched), and each day's lead_ingest_runs row is upserted
 * with this run's honest counts.
 *
 * HOW TO RUN (from server/, AFTER the current code has been deployed and its
 * migrations applied — the insert matches the tld-less schema):
 *
 *   npm run build
 *   set -a && source .env && set +a && node scripts/backfill-nrd.mjs
 *
 * `.env` points at production — that is the point. To rehearse first, source
 * .env.e2e instead. Optional: DAYS=7 node scripts/backfill-nrd.mjs
 *
 * Caveat (honest): WhoisDS's older free files are truncated to ~70k domains,
 * so backfilled days are samples; only the daily run sees a full file.
 */
import pg from 'pg';
import AdmZip from 'adm-zip';
import configurationModule from '../dist/config/configuration.js';
import {
  classifyDomain,
  compareIngestPriority,
  parseCsvList,
} from '../dist/leads/nrd/nrd-filter.js';

const DAYS = Number(process.env.DAYS ?? 10);
const INSERT_CHUNK = 1000;

// dist is CommonJS; the compiled `export default` lives under `.default`.
const cfg = (configurationModule.default ?? configurationModule)();
const ingest = cfg.leads.ingest;
const opts = {
  indianTlds: parseCsvList(ingest.tldAllowlist),
  genericTlds: parseCsvList(ingest.keywordTlds),
  blockedTlds: parseCsvList(ingest.blockedTlds),
  keywords: [...parseCsvList(ingest.keywords)],
  indiaTokens: [...parseCsvList(cfg.leads.indiaTokens)],
};

/** Same IST-yesterday rule as the daily sweep (nrd-ingest.service.ts). */
function yesterdayInKolkata() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString(
    'en-CA',
    { timeZone: 'Asia/Kolkata' },
  );
}

function daysBefore(date, offset) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function buildUrl(fileDate) {
  return ingest.urlTemplate
    .replace('{dateBase64Zip}', Buffer.from(`${fileDate}.zip`).toString('base64'))
    .replace('{date}', fileDate);
}

/** Zip-or-plain-text, same seam as the service. */
function extractText(body) {
  if (body.length >= 2 && body.subarray(0, 2).toString('latin1') === 'PK') {
    const zip = new AdmZip(body);
    const entry =
      zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.txt')) ??
      zip.getEntries()[0];
    return entry ? entry.getData().toString('utf8') : '';
  }
  return body.toString('utf8');
}

const client = new pg.Client({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT ?? 5432),
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  // Same SSL rule as data-source.ts.
  ssl: (
    process.env.DATABASE_SSL !== undefined
      ? process.env.DATABASE_SSL === 'true'
      : process.env.NODE_ENV === 'production'
  )
    ? { rejectUnauthorized: false }
    : false,
});
await client.connect();

// Preflight: refuse plainly when this database has no leads schema, instead
// of stack-tracing on the first insert — sourcing the wrong env file is the
// likely way to get here. `.env` points at sm_db, the development database,
// which does carry the leads schema; there is no separate demo database any
// more, so override DATABASE_NAME only to aim somewhere else deliberately.
const preflight = await client.query(
  `SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'leads'`,
);
if (preflight.rowCount === 0) {
  console.error(
    `ERROR: database "${process.env.DATABASE_NAME}" at ` +
      `${process.env.DATABASE_HOST} has no leads table — wrong ` +
      `DATABASE_NAME, or migrations not applied there.`,
  );
  await client.end();
  process.exit(1);
}

console.log(
  `Backfilling ${DAYS} days into ${process.env.DATABASE_NAME} at ` +
    `${process.env.DATABASE_HOST} (ingest-all filter, force semantics)…`,
);

const newest = yesterdayInKolkata();
let grandInserted = 0;

for (let i = 0; i < DAYS; i++) {
  const fileDate = daysBefore(newest, i);
  const url = buildUrl(fileDate);
  process.stdout.write(`${fileDate}  `);

  let body;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      console.log(`SKIP (HTTP ${response.status} — file gone or not published)`);
      await client.query(
        `INSERT INTO lead_ingest_runs ("fileDate", status, error, "finishedAt")
         VALUES ($1, 'failed', $2, now())
         ON CONFLICT ("fileDate") DO NOTHING`,
        [fileDate, `backfill: HTTP ${response.status}`],
      );
      continue;
    }
    body = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    console.log(`SKIP (${err.message})`);
    continue;
  }

  const lines = extractText(body)
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  let kept = [];
  for (const line of lines) {
    const r = classifyDomain(line, opts);
    if (r.keep && r.domain) {
      kept.push({ domain: r.domain, score: r.score, isIndian: r.isIndian });
    }
  }
  const matched = kept.length;
  if (kept.length > ingest.maxInserts) {
    kept = [...kept].sort(compareIngestPriority).slice(0, ingest.maxInserts);
  }

  let inserted = 0;
  for (let j = 0; j < kept.length; j += INSERT_CHUNK) {
    const chunk = kept.slice(j, j + INSERT_CHUNK);
    const params = [];
    const values = chunk
      .map((row, k) => {
        params.push(row.domain, fileDate, row.score, row.isIndian);
        const b = k * 4;
        return `($${b + 1}, 'nrd', $${b + 2}, $${b + 3}, $${b + 4})`;
      })
      .join(', ');
    const res = await client.query(
      `INSERT INTO leads (domain, source, "registeredOn", score, "isIndian")
       VALUES ${values}
       ON CONFLICT (domain) DO NOTHING
       RETURNING id`,
      params,
    );
    inserted += res.rowCount;
  }
  grandInserted += inserted;

  // Force semantics on the run row: this backfill IS a deliberate redo of
  // completed days, and the history should say what actually happened.
  await client.query(
    `INSERT INTO lead_ingest_runs
       ("fileDate", status, "totalDomains", "matchedDomains", "insertedDomains", error, "finishedAt")
     VALUES ($1, 'completed', $2, $3, $4, NULL, now())
     ON CONFLICT ("fileDate") DO UPDATE
        SET status = 'completed', "totalDomains" = EXCLUDED."totalDomains",
            "matchedDomains" = EXCLUDED."matchedDomains",
            "insertedDomains" = EXCLUDED."insertedDomains",
            error = NULL, "finishedAt" = now(), "updatedAt" = now()`,
    [fileDate, lines.length, matched, inserted],
  );
  console.log(`${lines.length} lines → ${matched} matched → ${inserted} new`);
}

console.log(`Done. ${grandInserted} new leads inserted.`);
await client.end();

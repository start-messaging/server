import { Check, Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity.js';
import {
  LeadEnrichmentStatus,
  LeadLiveness,
  LeadSource,
  LeadStatus,
} from '../enums/lead.enum.js';

/**
 * One prospective customer, keyed by domain.
 *
 * The domain is the identity: the ingest inserts with ON CONFLICT DO NOTHING
 * against the unique constraint, so re-running a day's file — which the hourly
 * retry window does on purpose — can never duplicate a prospect.
 */
@Entity('leads')
@Unique('UQ_leads_domain', ['domain'])
@Unique('UQ_leads_outreachToken', ['outreachToken'])
@Index('IDX_leads_createdAt', ['createdAt'])
@Check('CHK_leads_teamRating', '"teamRating" BETWEEN 1 AND 5')
export class Lead extends BaseEntity {
  @Column({ type: 'varchar', length: 255 })
  domain: string;

  // No tld column: it was always derivable from `domain`, and the one thing
  // it usefully encoded — India by construction — is first-class in
  // `isIndian`. The classifier still resolves the effective TLD internally
  // to decide keep/drop; it just isn't persisted (dropped in DropLeadTld).

  @Column({ type: 'enum', enum: LeadSource, default: LeadSource.NRD })
  source: LeadSource;

  /** The date of the NRD file this domain appeared in. */
  @Column({ type: 'date', nullable: true })
  registeredOn: string | null;

  /** Keyword score assigned at ingest, from the domain name alone. */
  @Column({ type: 'int', default: 0 })
  score: number;

  /**
   * "Does this business need OTP/WhatsApp messaging?" — the COUNT of distinct
   * structurally-verified signals (0–5). An honest integer: each point is a
   * checkable fact (a payment SDK URL, a password input, …), never a word
   * the page happened to contain.
   */
  @Column({ type: 'int', default: 0 })
  qualificationScore: number;

  /**
   * The team's own 1–5 read of the lead, set by hand in the panel; NULL means
   * unrated (and a PATCH with null clears it). Exists because machine scores
   * "are not accurate" — this column is the solid judgement layered on top of
   * the verified signals. Range-enforced by CHK_leads_teamRating in the
   * database, not just the DTO.
   */
  @Column({ type: 'int', nullable: true })
  teamRating: number | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  qualificationSignals: string[];

  /**
   * True at ingest for Indian TLDs and India-named domains (by construction);
   * enrichment upgrades null → true when the crawl finds India signals.
   * Null means "not established". Never downgraded.
   */
  @Column({ type: 'boolean', nullable: true })
  isIndian: boolean | null;

  /**
   * Every India signal the crawl matched ('phone_91', 'rupee', 'city', …) —
   * the transparency trail for isIndian: the team must be able to see WHY a
   * lead was marked Indian, not just that it was.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  indiaSignals: string[];

  @Index('IDX_leads_status')
  @Column({ type: 'enum', enum: LeadStatus, default: LeadStatus.NEW })
  status: LeadStatus;

  /**
   * Tier-0 of the pipeline: does a website answer for this domain at all?
   * Written ONLY by the liveness prober — the crawler claims `live` leads
   * and never touches this column, so "reachable?" and "what did the crawl
   * find?" stay independent facts. `inactive` carries a re-probe clock
   * (livenessCheckedAt + the prober's age backoff), never finality: not
   * live today does not mean not live in two days.
   */
  @Index('IDX_leads_liveness')
  @Column({ type: 'enum', enum: LeadLiveness, default: LeadLiveness.UNKNOWN })
  liveness: LeadLiveness;

  /** When the prober last looked — the re-probe backoff's clock. */
  @Column({ type: 'timestamptz', nullable: true })
  livenessCheckedAt: Date | null;

  /**
   * WHY the tag says what it says ('ok', 'no_dns', 'http_500',
   * 'fetch_error: …', 'parking_ns') — the team reads the reason, not just
   * the verdict, same transparency contract as indiaSignals.
   */
  @Column({ type: 'varchar', length: 200, nullable: true })
  livenessDetail: string | null;

  @Index('IDX_leads_enrichmentStatus')
  @Column({
    type: 'enum',
    enum: LeadEnrichmentStatus,
    default: LeadEnrichmentStatus.PENDING,
  })
  enrichmentStatus: LeadEnrichmentStatus;

  @Column({ type: 'int', default: 0 })
  enrichmentAttempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  enrichedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  enrichmentError: string | null;

  /**
   * When the headless-browser tier last ran for this lead. Written BEFORE the
   * render (claim-first), so a crash mid-render can never make the
   * no_contact → browser escalation loop on the same lead.
   */
  @Column({ type: 'timestamptz', nullable: true })
  browserAttemptedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  siteTitle: string | null;

  @Column({ type: 'text', nullable: true })
  siteDescription: string | null;

  @Column({ type: 'boolean', nullable: true })
  hasMx: boolean | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  contactEmails: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  contactPhones: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  contactWhatsapp: string[];

  /** The address outreach was queued to. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  outreachEmail: string | null;

  /**
   * The tracking token embedded in pixel/click/unsubscribe URLs. Separate from
   * `id` so a leaked or abused token can be rotated without renaming the lead.
   */
  @Column({ type: 'uuid', nullable: true })
  outreachToken: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  outreachProviderRef: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  queuedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  contactedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  openedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  clickedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  repliedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;
}

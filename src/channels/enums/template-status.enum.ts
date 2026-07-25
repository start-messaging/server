export enum TemplateStatus {
  /** User is still editing; not yet submitted for review. */
  DRAFT = 'draft',
  /** Submitted by the user; awaiting admin review. */
  PENDING_REVIEW = 'pending_review',
  /** Reviewed and approved by admin; usable for sending. */
  APPROVED = 'approved',
  /** Reviewed and rejected by admin; see rejectionReason. */
  REJECTED = 'rejected',
}

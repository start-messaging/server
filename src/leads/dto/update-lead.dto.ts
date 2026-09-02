import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { LeadStatus } from '../enums/lead.enum.js';

/**
 * The only statuses an admin may set by hand. The pipeline owns the rest:
 * queued/contacted are claimed by the send path, unsubscribed/bounced by the
 * tracking endpoints — a manual write to those would forge delivery history.
 */
export const MANUAL_LEAD_STATUSES = [
  LeadStatus.NEW,
  LeadStatus.REPLIED,
  LeadStatus.CONVERTED,
  LeadStatus.DISQUALIFIED,
] as const;

export class UpdateLeadDto {
  @ApiPropertyOptional({ enum: MANUAL_LEAD_STATUSES })
  @IsOptional()
  @IsIn([...MANUAL_LEAD_STATUSES])
  status?: LeadStatus;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  outreachEmail?: string;

  /**
   * The team's own 1–5 read of the lead; null clears it back to unrated.
   * @IsOptional() makes class-validator skip the @IsIn for null AND
   * undefined, which is exactly the contract we want: null arrives in the
   * dto (present-with-null) and the service persists the clear, while any
   * other non-integer/out-of-range value still fails @IsIn. The database
   * enforces the same range via CHK_leads_teamRating.
   */
  @ApiPropertyOptional({ enum: [1, 2, 3, 4, 5], nullable: true })
  @IsOptional()
  @IsIn([1, 2, 3, 4, 5])
  teamRating?: number | null;
}

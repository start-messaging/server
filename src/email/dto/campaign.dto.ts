import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsISO8601,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { EmailCampaignStatus } from '../enums/email-campaign-status.enum.js';
import { EmailRecipientStatus } from '../enums/email-recipient-status.enum.js';
import { AudienceDto } from './audience.dto.js';

export class CreateCampaignDto {
  @ApiProperty({ description: 'Internal label; never shown to a recipient' })
  @IsString()
  @Length(1, 160)
  name: string;

  @ApiProperty()
  @IsString()
  @Length(1, 300)
  subject: string;

  @ApiProperty({ description: 'Composer HTML. Merge fields as {{firstName}}.' })
  @IsString()
  @Length(1, 500_000)
  bodyHtml: string;

  @ApiPropertyOptional({ description: 'Inbox preview text' })
  @IsOptional()
  @IsString()
  @Length(0, 300)
  preheader?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  replyTo?: string;

  @ApiPropertyOptional({ type: AudienceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AudienceDto)
  audience?: AudienceDto;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  trackOpens?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  trackClicks?: boolean;

  @ApiPropertyOptional({ description: 'ISO 8601; omit to send on demand' })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;
}

/**
 * Every field optional — the composer autosaves a draft as it is typed, so a
 * partial body arriving on its own is the normal case rather than an error.
 */
export class UpdateCampaignDto extends PartialType(CreateCampaignDto) {}

export const CAMPAIGN_SORT_FIELDS = [
  'created_at',
  'updated_at',
  'name',
  'status',
  'sent',
  'opened',
] as const;

export type CampaignSortField = (typeof CAMPAIGN_SORT_FIELDS)[number];

/**
 * `sortBy` is omitted from the base and redeclared, rather than overridden.
 *
 * The base types it as a free string; narrowing it in a subclass without
 * omitting it first is a TypeScript error, and `declare` would strip the
 * decorators that make the whitelist actually enforced — leaving the sort
 * column open to whatever the client sends. Same approach as
 * `UserFilterQueryDto`.
 */
export class CampaignQueryDto extends OmitType(PaginationQueryDto, [
  'sortBy',
] as const) {
  @ApiPropertyOptional({ enum: EmailCampaignStatus })
  @IsOptional()
  @IsEnum(EmailCampaignStatus)
  status?: EmailCampaignStatus;

  @ApiPropertyOptional({ description: 'Matches campaign name and subject' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: CAMPAIGN_SORT_FIELDS })
  @IsOptional()
  @IsIn([...CAMPAIGN_SORT_FIELDS])
  sortBy?: CampaignSortField;
}

export class RecipientQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: EmailRecipientStatus })
  @IsOptional()
  @IsEnum(EmailRecipientStatus)
  status?: EmailRecipientStatus;

  @ApiPropertyOptional({ description: 'Matches address and name' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Only recipients who opened at least once',
  })
  @IsOptional()
  @IsBoolean()
  openedOnly?: boolean;
}

export class SendTestDto {
  @ApiProperty({ description: 'Where to send the test copy' })
  @IsEmail()
  to: string;
}

/**
 * Asks for the size and a sample of an audience without saving anything.
 *
 * Its own endpoint because the composer calls it on every filter change, and a
 * count is far cheaper than persisting a draft each time.
 */
export class PreviewAudienceDto {
  @ApiProperty({ type: AudienceDto })
  @ValidateNested()
  @Type(() => AudienceDto)
  audience: AudienceDto;
}

/** Renders the campaign as one recipient would see it. */
export class PreviewRenderDto {
  @ApiProperty()
  @IsString()
  @Length(1, 300)
  subject: string;

  @ApiProperty()
  @IsString()
  @Length(0, 500_000)
  bodyHtml: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 300)
  preheader?: string;

  @ApiPropertyOptional({
    description: 'Render for this recipient; falls back to sample data',
  })
  @IsOptional()
  @IsEmail()
  previewFor?: string;
}

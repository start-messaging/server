import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { MessageStatus } from '../entities/message.entity.js';

/** Sort keys accepted by the message list endpoints. */
export const MESSAGE_SORT_FIELDS = [
  'created_at',
  'sent_at',
  'delivered_at',
  'status',
  'cost',
] as const;

export type MessageSortField = (typeof MESSAGE_SORT_FIELDS)[number];

export class MessageQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Filter messages from this date (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Filter messages until this date (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  // Previously an unvalidated string, so an unknown value reached Postgres and
  // came back as an enum cast error (a 500) rather than a 400.
  @ApiPropertyOptional({ enum: MessageStatus })
  @IsOptional()
  @IsEnum(MessageStatus)
  status?: MessageStatus;

  @ApiPropertyOptional({ format: 'uuid', description: 'Filter by API key ID' })
  @IsOptional()
  @IsUUID()
  apiKeyId?: string;

  @ApiPropertyOptional({ enum: MESSAGE_SORT_FIELDS, default: 'created_at' })
  @IsOptional()
  @IsIn([...MESSAGE_SORT_FIELDS])
  declare sortBy?: MessageSortField;

  /**
   * Keyset pagination token. When present `page` is ignored and the response
   * carries `nextCursor` instead of page totals. Preferred for walking a large
   * history: cost per page stays flat regardless of depth, and concurrent
   * inserts cannot shift rows across page boundaries.
   */
  @ApiPropertyOptional({
    description:
      'Opaque cursor from a previous response. Overrides `page` when set.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}

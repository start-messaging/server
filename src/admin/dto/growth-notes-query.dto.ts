import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional } from 'class-validator';
import {
  BOOLEAN_QUERY_VALUES,
  PaginationQueryDto,
} from '../../common/dto/pagination-query.dto.js';

/** Sort keys the call-notes list may order by. */
export const GROWTH_NOTES_SORT_FIELDS = [
  'called_at',
  'signed_up_at',
  'name',
  'email',
] as const;

export type GrowthNotesSortField = (typeof GROWTH_NOTES_SORT_FIELDS)[number];

/** Query-string spellings that mean false, mirroring PaginationQueryDto. */
const FALSE_VALUES = ['false', '0', 'no', 'n'];

export class GrowthNotesQueryDto extends PaginationQueryDto {
  /**
   * Narrow to accounts that do (or do not) have a note written against them.
   *
   * Deliberately a string rather than a boolean, for the same reason
   * `withCount` is: the global ValidationPipe runs with
   * `enableImplicitConversion: true`, and `Boolean('false')` is `true`, so a
   * boolean-typed field here would read `?hasNote=false` as *enabled* and show
   * exactly the accounts the caller asked to exclude. Read the parsed value
   * through `noteFilter`, never off this field.
   */
  @ApiPropertyOptional({
    enum: BOOLEAN_QUERY_VALUES,
    description:
      'true: only accounts with a note. false: only the called-but-unwritten-up ones. Omit for both.',
  })
  @IsOptional()
  @IsIn(BOOLEAN_QUERY_VALUES)
  hasNote?: string;

  @ApiPropertyOptional({
    description:
      'Only accounts whose last logged call is at or after this instant (ISO 8601 or YYYY-MM-DD).',
  })
  @IsOptional()
  @IsDateString({}, { message: 'calledSince must be a real ISO 8601 date' })
  calledSince?: string;

  @ApiPropertyOptional({
    enum: GROWTH_NOTES_SORT_FIELDS,
    default: 'called_at',
  })
  @IsOptional()
  @IsIn([...GROWTH_NOTES_SORT_FIELDS])
  declare sortBy?: GrowthNotesSortField;

  /** Tri-state: true, false, or undefined for "do not filter on the note". */
  get noteFilter(): boolean | undefined {
    if (this.hasNote === undefined) return undefined;
    return !FALSE_VALUES.includes(this.hasNote.trim().toLowerCase());
  }
}

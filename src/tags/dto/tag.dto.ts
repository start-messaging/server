import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Palette keys the admin panel knows how to render. */
export const TAG_COLOURS = [
  'slate',
  'red',
  'amber',
  'green',
  'blue',
  'violet',
] as const;

export class CreateTagDto {
  @ApiProperty({ example: 'High volume' })
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  name: string;

  @ApiPropertyOptional({ enum: TAG_COLOURS, default: 'slate' })
  @IsOptional()
  @IsIn([...TAG_COLOURS])
  colour?: string;

  @ApiPropertyOptional({ example: 'Sends more than 10k/month' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}

export class SetUserTagsDto {
  @ApiProperty({
    type: [String],
    description: 'The complete tag set for this user, not a delta',
  })
  @IsArray()
  // A cap, so a malformed client cannot attach thousands of rows in one call.
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  tagIds: string[];
}

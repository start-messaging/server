import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class QueueOutreachDto {
  @ApiProperty({ description: 'The address to send to' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ maxLength: 200, description: 'Overrides the subject' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  /**
   * Replaces the inner body only — the tracking pixel and the compliance
   * footer (unsubscribe link, postal address) are always appended.
   */
  @ApiPropertyOptional({ maxLength: 20000 })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  bodyHtml?: string;
}

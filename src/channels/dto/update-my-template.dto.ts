import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class UpdateMyTemplateDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'Must contain {{otp}}' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/\{\{otp\}\}/, { message: 'body must contain {{otp}} placeholder' })
  body?: string;

  @ApiPropertyOptional({ maxLength: 10 })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;
}

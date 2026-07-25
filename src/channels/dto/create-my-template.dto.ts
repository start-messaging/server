import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateMyTemplateDto {
  @ApiProperty({ maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ maxLength: 500, description: 'Must contain {{otp}}' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Matches(/\{\{otp\}\}/, { message: 'body must contain {{otp}} placeholder' })
  body: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  channelId: string;

  @ApiPropertyOptional({ default: 'en' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;
}

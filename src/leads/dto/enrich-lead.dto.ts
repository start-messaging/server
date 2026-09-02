import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/** Body of POST /admin/leads/:id/enrich. Empty body = the fetch tier. */
export class EnrichLeadDto {
  @ApiPropertyOptional({
    description:
      'true = render the site in headless Chromium instead of fetching it — ' +
      'for JS-shell sites the cheap tier reported no_contact on',
  })
  @IsOptional()
  @IsBoolean()
  browser?: boolean;
}

import { IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateOrderDto {
  @ApiProperty({ example: 1000, description: 'Amount in major currency unit' })
  @IsNumber()
  @Min(1000)
  amount: number;
}

import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyPaymentDto {
  @ApiProperty({ description: 'Razorpay order ID returned from checkout' })
  @IsString()
  razorpayOrderId: string;

  @ApiProperty({ description: 'Razorpay payment ID from checkout callback' })
  @IsString()
  razorpayPaymentId: string;

  @ApiProperty({ description: 'Razorpay signature from checkout callback' })
  @IsString()
  razorpaySignature: string;
}

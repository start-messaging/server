import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Req,
} from '@nestjs/common';
// Type-only: a type used in a decorated signature must be imported this way
// under isolatedModules + emitDecoratorMetadata, or tsc refuses it (TS1272).
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PaymentsService } from './payments.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { VerifyPaymentDto } from './dto/verify-payment.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { SkipOnboarding } from '../common/decorators/skip-onboarding.decorator.js';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get('fee-quote')
  @ApiOperation({
    summary:
      'What a top-up of this amount will cost, including any convenience fee.',
  })
  quote(@Query('amount') amount: string) {
    // Exists so the checkout can show the surcharge before the customer
    // commits, without reimplementing the gross-up on the client where it
    // would drift from the server's version.
    return this.paymentsService.quote(Number(amount));
  }

  @Post('create-order')
  @SkipOnboarding()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a payment order for wallet top-up' })
  createOrder(@CurrentUser('id') userId: string, @Body() dto: CreateOrderDto) {
    return this.paymentsService.createOrder(userId, dto);
  }

  @Post('verify')
  @SkipOnboarding()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify payment and credit wallet' })
  verifyPayment(
    @CurrentUser('id') userId: string,
    @Body() dto: VerifyPaymentDto,
  ) {
    return this.paymentsService.verifyPayment(userId, dto);
  }

  @Post('webhook/razorpay')
  @Public()
  @SkipThrottle()
  @ApiOperation({ summary: 'Razorpay webhook endpoint' })
  razorpayWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: any,
    @Headers('x-razorpay-signature') signature: string,
  ) {
    // Both are passed on purpose: the signature is checked against `req.rawBody`
    // (an HMAC is over bytes), while the parsed `body` is what the event fields
    // are read from afterwards.
    return this.paymentsService.handleWebhook(
      'razorpay',
      body,
      signature,
      req.rawBody,
    );
  }
}

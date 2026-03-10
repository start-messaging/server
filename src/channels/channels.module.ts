import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from './entities/channel.entity.js';
import { OtpTemplate } from './entities/otp-template.entity.js';
import { ChannelsService } from './channels.service.js';
import { ChannelsController } from './channels.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Channel, OtpTemplate])],
  controllers: [ChannelsController],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}

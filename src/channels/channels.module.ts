import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from './entities/channel.entity.js';
import { OtpTemplate } from './entities/otp-template.entity.js';
import { ChannelsService } from './channels.service.js';
import { ChannelsController } from './channels.controller.js';
import { TemplatesController } from './templates.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Channel, OtpTemplate])],
  controllers: [ChannelsController, TemplatesController],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}

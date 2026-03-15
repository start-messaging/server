import { Global, Module } from '@nestjs/common';
import { R2UploadService } from './services/r2-upload.service.js';
import { EmailService } from './services/email.service.js';

@Global()
@Module({
  providers: [R2UploadService, EmailService],
  exports: [R2UploadService, EmailService],
})
export class CommonModule {}

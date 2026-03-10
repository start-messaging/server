import { Global, Module } from '@nestjs/common';
import { R2UploadService } from './services/r2-upload.service.js';

@Global()
@Module({
  providers: [R2UploadService],
  exports: [R2UploadService],
})
export class CommonModule {}

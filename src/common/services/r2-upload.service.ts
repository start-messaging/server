import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';

@Injectable()
export class R2UploadService {
  private readonly client: S3Client;
  private readonly bucketName: string;
  private readonly publicUrl: string;

  constructor(private readonly configService: ConfigService) {
    const accountId = this.configService.get<string>('r2.accountId') ?? '';
    this.bucketName = this.configService.get<string>('r2.bucketName') ?? '';
    this.publicUrl = this.configService.get<string>('r2.publicUrl') ?? '';

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.configService.get<string>('r2.accessKeyId') ?? '',
        secretAccessKey:
          this.configService.get<string>('r2.secretAccessKey') ?? '',
      },
    });
  }

  async upload(
    key: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );

    return `${this.publicUrl}/${key}`;
  }

  async getObject(key: string) {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );
    return {
      body: response.Body,
      contentType: response.ContentType,
      contentLength: response.ContentLength,
    };
  }

  extractKeyFromUrl(url: string): string | null {
    if (!this.publicUrl) return null;
    const prefix = this.publicUrl.endsWith('/')
      ? this.publicUrl
      : `${this.publicUrl}/`;
    if (url.startsWith(prefix)) {
      return url.slice(prefix.length);
    }
    return null;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { ApiKey } from './entities/api-key.entity.js';
import { CreateApiKeyDto } from './dto/create-api-key.dto.js';
import { UpdateApiKeyIpsDto } from './dto/update-api-key-ips.dto.js';
import { API_KEY_PREFIX } from '../common/constants/app.constants.js';
import {
  generateUsageGuide,
  generateSendOtpExamples,
} from './usage-guide.helper.js';

@Injectable()
export class ApiKeysService {
  constructor(
    @InjectRepository(ApiKey)
    private readonly apiKeyRepository: Repository<ApiKey>,
  ) {}

  private normalizeAllowedIps(
    ips: string[] | null | undefined,
  ): string[] | null {
    if (!ips || ips.length === 0) return null;
    return ips;
  }

  async create(userId: string, dto: CreateApiKeyDto) {
    const rawKey = `${API_KEY_PREFIX}${randomBytes(20).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 12);

    const apiKey = this.apiKeyRepository.create({
      userId,
      keyPrefix,
      keyHash,
      label: dto.label ?? '',
      allowedIps: this.normalizeAllowedIps(dto.allowedIps),
    });

    await this.apiKeyRepository.save(apiKey);

    return {
      id: apiKey.id,
      key: rawKey,
      keyPrefix,
      label: apiKey.label,
      allowedIps: apiKey.allowedIps,
      createdAt: apiKey.createdAt,
      codeExamples: {
        sendOtp: generateSendOtpExamples(rawKey),
      },
    };
  }

  async countByUser(userId: string): Promise<number> {
    return this.apiKeyRepository.count({ where: { userId } });
  }

  async findAllByUser(userId: string): Promise<ApiKey[]> {
    return this.apiKeyRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async validateKey(rawKey: string): Promise<ApiKey | null> {
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const apiKey = await this.apiKeyRepository.findOne({
      where: { keyHash, isActive: true },
      relations: ['user'],
    });

    if (apiKey) {
      apiKey.lastUsedAt = new Date();
      await this.apiKeyRepository.save(apiKey);
    }

    return apiKey;
  }

  async updateIps(
    id: string,
    userId: string,
    dto: UpdateApiKeyIpsDto,
  ): Promise<ApiKey> {
    const apiKey = await this.apiKeyRepository.findOne({
      where: { id, userId },
    });
    if (!apiKey) {
      throw new NotFoundException('API key not found');
    }
    apiKey.allowedIps = this.normalizeAllowedIps(dto.allowedIps);
    return this.apiKeyRepository.save(apiKey);
  }

  getUsageGuide() {
    return generateUsageGuide('YOUR_API_KEY');
  }

  async delete(id: string, userId: string): Promise<void> {
    const apiKey = await this.apiKeyRepository.findOne({
      where: { id, userId },
    });
    if (!apiKey) {
      throw new NotFoundException('API key not found');
    }
    await this.apiKeyRepository.softRemove(apiKey);
  }
}

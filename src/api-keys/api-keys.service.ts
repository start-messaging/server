import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import { paginateQueryBuilder } from '../common/utils/pagination.util.js';
import { MAX_PAGE_SIZE } from '../common/constants/pagination.constants.js';

/**
 * How stale `lastUsedAt` is allowed to get before it is written again.
 * It drives a "last used" column in the UI, where minute resolution is
 * indistinguishable from exact.
 */
const LAST_USED_RESOLUTION_MS = 60_000;

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

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
      // A user with a runaway key-creation script should not be able to make
      // this endpoint return an unbounded result set.
      take: MAX_PAGE_SIZE,
    });
  }

  /** Paginated variant for the admin customer-detail view. */
  async findByUserPaginated(
    userId: string,
    page: number,
    limit: number,
    withCount = true,
  ): Promise<[ApiKey[], number]> {
    const qb = this.apiKeyRepository
      .createQueryBuilder('apiKey')
      .where('apiKey.userId = :userId', { userId })
      .orderBy('apiKey.createdAt', 'DESC')
      .addOrderBy('apiKey.id', 'DESC');

    return paginateQueryBuilder(qb, { page, limit, withCount });
  }

  async validateKey(rawKey: string): Promise<ApiKey | null> {
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const apiKey = await this.apiKeyRepository.findOne({
      where: { keyHash, isActive: true },
      relations: ['user'],
    });

    if (apiKey) {
      this.touchLastUsed(apiKey);
    }

    return apiKey;
  }

  /**
   * Records that a key was used, at most once per LAST_USED_RESOLUTION_MS.
   *
   * This runs on every authenticated API request, so it is the hottest write
   * in the system. Two things were costing far more than the feature is worth:
   *
   *  - `repository.save(entity)` rewrites every column and bumps `updatedAt`,
   *    turning a timestamp touch into a full-row UPDATE plus a new row version
   *    for vacuum to clean up. A targeted `update()` writes one column.
   *  - Writing on *every* request means a customer sending 1,000 OTPs/minute
   *    generates 1,000 UPDATEs against the same row, all of which serialise on
   *    that row's lock and bloat the table. `lastUsedAt` only needs to be
   *    roughly right, so collapsing them to one write per minute costs nothing
   *    real and removes the contention.
   *
   * The write is deliberately not awaited: request auth should not block on
   * bookkeeping, and losing one touch on a crash is harmless.
   */
  private touchLastUsed(apiKey: ApiKey): void {
    const now = Date.now();
    const last = apiKey.lastUsedAt ? apiKey.lastUsedAt.getTime() : 0;

    if (now - last < LAST_USED_RESOLUTION_MS) return;

    const timestamp = new Date(now);
    // Keep the in-memory entity consistent so a second request served from the
    // same tick does not re-enter this branch.
    apiKey.lastUsedAt = timestamp;

    void this.apiKeyRepository
      .update({ id: apiKey.id }, { lastUsedAt: timestamp })
      .catch((err: Error) => {
        this.logger.warn(
          `Failed to record lastUsedAt for API key ${apiKey.id}: ${err.message}`,
        );
      });
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

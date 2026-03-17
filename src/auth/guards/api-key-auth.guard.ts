import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeysService } from '../../api-keys/api-keys.service.js';
import { normalizeIp } from '../../common/utils/ip.util.js';

@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'] as string | undefined;

    if (!apiKey) {
      return false;
    }

    const keyEntity = await this.apiKeysService.validateKey(apiKey);
    if (!keyEntity) {
      throw new UnauthorizedException('Invalid API key');
    }

    if (!keyEntity.user.isActive) {
      throw new UnauthorizedException('Account is suspended');
    }

    if (keyEntity.allowedIps && keyEntity.allowedIps.length > 0) {
      const clientIp = this.extractClientIp(request);
      if (!this.isIpAllowed(clientIp, keyEntity.allowedIps)) {
        throw new ForbiddenException(
          'Request from this IP address is not allowed',
        );
      }
    }

    request.user = {
      id: keyEntity.userId,
      email: keyEntity.user.email,
      role: keyEntity.user.role,
    };
    request.apiKeyId = keyEntity.id;

    return true;
  }

  private extractClientIp(request: any): string {
    const raw: string = request.ip ?? '127.0.0.1';
    return normalizeIp(raw);
  }

  private isIpAllowed(clientIp: string, allowedIps: string[]): boolean {
    return allowedIps.some((allowed) => normalizeIp(allowed) === clientIp);
  }
}

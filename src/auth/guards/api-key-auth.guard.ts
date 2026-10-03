import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeysService } from '../../api-keys/api-keys.service.js';
import { normalizeIp } from '../../common/utils/ip.util.js';

@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyAuthGuard.name);

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
        // The ForbiddenException below never reaches the caller. CombinedAuthGuard
        // re-throws only UnauthorizedException, so an allow-list refusal arrives as
        // a bare 401 "Authentication required" — deliberately indistinguishable
        // from a typo'd key, so that whoever holds a leaked key cannot use the
        // allow list as an oracle for whether that key is still live.
        //
        // The cost of that silence is that nobody could tell the two apart,
        // ourselves included: the refusal was recorded nowhere, so a customer
        // whose egress IP had changed reported "the key stopped working" and the
        // logs had nothing to say. Support then walked the key-rotation path,
        // which cannot fix an address mismatch. This line is the only place the
        // real reason is written down; the response stays generic on purpose.
        this.logger.warn(
          `API key ${keyEntity.id} (user ${keyEntity.userId}) refused: ` +
            `request from ${clientIp} is not in its allow list ` +
            `[${keyEntity.allowedIps.join(', ')}]`,
        );
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

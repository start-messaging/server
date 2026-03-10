import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { ApiKeyAuthGuard } from './api-key-auth.guard.js';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator.js';

@Injectable()
export class CombinedAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwtAuthGuard: JwtAuthGuard,
    private apiKeyAuthGuard: ApiKeyAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Try JWT first
    try {
      const jwtResult = await this.jwtAuthGuard.canActivate(context);
      if (jwtResult) return true;
    } catch {
      // JWT failed, try API key
    }

    // Try API key
    try {
      const apiKeyResult = await this.apiKeyAuthGuard.canActivate(context);
      if (apiKeyResult) return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
    }

    throw new UnauthorizedException('Authentication required');
  }
}

import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { requestContext } from '../context/request-context.js';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    req['requestId'] = requestId;

    requestContext.run({ requestId }, () => {
      next();
    });
  }
}

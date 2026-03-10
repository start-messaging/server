import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requestContext } from '../context/request-context.js';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const requestId = `req_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    req['requestId'] = requestId;

    requestContext.run({ requestId }, () => {
      next();
    });
  }
}

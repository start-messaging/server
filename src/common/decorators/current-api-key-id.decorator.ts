import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentApiKeyId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.apiKeyId;
  },
);

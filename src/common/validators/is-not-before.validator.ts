import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Rejects a date range whose end is earlier than its start.
 *
 * This lives as a class-validator decorator rather than as a check inside the
 * service because validation here is DTO-only: a range assembled in a service
 * has already been through the pipe, so a service-side throw is a 400 the
 * OpenAPI document does not know about and the panel cannot anticipate.
 *
 * It deliberately passes anything it cannot parse. `?from=banana&to=2026-01-01`
 * has a real problem, and it is not the ordering — `@IsDateString` on `from`
 * owns that message. Returning false here too would put "to must not be before
 * from" first in the error array, which is what the client renders, and send
 * whoever typed the bad date looking at the wrong field.
 */
export function IsNotBefore(
  property: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isNotBefore',
      target: object.constructor,
      propertyName,
      constraints: [property],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const [startProperty] = args.constraints as [string];
          const start = (args.object as Record<string, unknown>)[startProperty];

          // Either side absent is an open-ended range, which is allowed.
          if (typeof value !== 'string' || typeof start !== 'string') {
            return true;
          }

          const end = Date.parse(value);
          const begin = Date.parse(start);
          if (Number.isNaN(end) || Number.isNaN(begin)) return true;

          return end >= begin;
        },
        defaultMessage(args: ValidationArguments): string {
          const [startProperty] = args.constraints as [string];
          return `${args.property} must not be earlier than ${startProperty}`;
        },
      },
    });
  };
}

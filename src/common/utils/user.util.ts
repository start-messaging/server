import type { User } from '../../users/entities/user.entity.js';

export function excludePassword(user: User) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, ...result } = user;
  return result;
}
